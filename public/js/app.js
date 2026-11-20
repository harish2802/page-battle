// Page Battle client: routing, screens, animations. The server decides everything;
// this file only renders snapshots and sends intents.

import { esc, $, $$, sleep, fmtClock, ordinal, toast, DIGITS, STAGE_NAMES } from './util.js';
import { net, api, send, session, startSession, connect, endSession } from './net.js';
import { sfx, sound } from './sound.js';
import { slotStickman, crossScribble, bigStickman, safeColor, dot } from './stickman.js';

const app = $('#app');
const T = {}; // cached templates
let view = null; // current view name
let tick = null; // per-view 1s timer
let cleanup = null; // per-view cleanup

// ------------------------------------------------------------------ helpers

async function template(name) {
  if (!T[name]) {
    const r = await fetch(`/templates/${name}.html`);
    T[name] = await r.text();
  }
  return T[name];
}

const snap = () => net.snap;
const me = (s = snap()) => s?.match?.players.find((p) => p.id === s.you) || null;
const memberOf = (s, id) => s.room.members.find((m) => m.id === id);
const nameOf = (s, id) => (memberOf(s, id)?.name || '?').toUpperCase();
const inSession = () => !!session.get();

function setView(name, html, opts = {}) {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  clearInterval(tick); tick = null;
  view = name;
  app.innerHTML = html;
  const main = app.firstElementChild;
  if (main && !opts.noAnim) main.classList.add('screen-in');
  updateChrome();
  window.scrollTo(0, 0);
}

function errBox(sel, msg) {
  const el = $(sel);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

function updateChrome() {
  const s = snap();
  const active = { home: 'home', modes: 'modes', setup: 'setup', lobby: 'lobby', pregame: 'arena', arena: 'arena', winner: 'winner', connecting: null }[view];
  $$('#mainNav [data-nav]').forEach((a) => {
    const on = a.dataset.nav === active;
    a.className = 'px-3 py-1.5 font-label-lg text-label-lg whitespace-nowrap transition-colors ' + (on
      ? 'bg-primary text-on-primary rounded-lg shadow-[2px_2px_0px_#a03e40]'
      : 'text-on-surface-variant hover:text-on-surface');
    if (on) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current');
  });
  const who = $('#whoami');
  const meP = s && s.room.members.find((m) => m.id === s.you);
  if (inSession() && meP) {
    who.classList.remove('hidden'); who.classList.add('flex');
    $('#whoName').textContent = meP.name;
    $('#whoDot').style.background = safeColor(meP.color);
  } else { who.classList.add('hidden'); who.classList.remove('flex'); }
  const rb = $('#roundBadge');
  if (view === 'arena' && s?.match) {
    rb.classList.remove('hidden'); rb.classList.add('2xl:flex');
    $('#roundBadgeText').textContent = `ROUND #${String(s.match.round).padStart(2, '0')}`;
  } else { rb.classList.add('hidden'); rb.classList.remove('2xl:flex'); }
  $('#siteFooter').classList.toggle('hidden', view === 'arena');
}

function syncSoundBtn() {
  const on = sound.enabled;
  $('#sfxBtn').setAttribute('aria-pressed', String(on));
  $('#sfxLabel').textContent = on ? 'SFX: ON' : 'SFX: OFF';
  $('#sfxIcon').textContent = on ? 'volume_up' : 'volume_off';
  $('#sfxBars').style.opacity = on ? '1' : '0.2';
}

// ------------------------------------------------------------------ modals

function modal(html, { onClose, closable = true } = {}) {
  const host = $('#modalHost');
  host.innerHTML = `<div class="modal-wash" role="dialog" aria-modal="true"><div class="modal-sheet p-6 sm:p-8 relative">${closable ? '<button type="button" data-close class="absolute top-3 right-3 w-9 h-9 border-2 border-primary rounded bg-surface-container shadow-[2px_2px_0px_#1e1e24] font-bold" aria-label="Close">✕</button>' : ''}${html}</div></div>`;
  const close = () => { host.innerHTML = ''; document.removeEventListener('keydown', esc_); onClose && onClose(); };
  const esc_ = (e) => { if (e.key === 'Escape' && closable) close(); };
  document.addEventListener('keydown', esc_);
  $('[data-close]', host)?.addEventListener('click', close);
  host.firstElementChild.addEventListener('mousedown', (e) => { if (e.target === host.firstElementChild && closable) close(); });
  return { el: host, close };
}
const closeModal = () => { $('#modalHost').innerHTML = ''; };

function showRules() {
  modal(`<h2 class="font-headline-xl text-headline-xl text-primary uppercase mb-1">How to play</h2>
  <p class="font-body-md text-on-surface-variant mb-4">Last player standing wins. No teams, no alliances.</p>
  <ol class="space-y-3 font-body-md text-on-surface list-decimal pl-5">
   <li>Everyone has five digit slots: <b>0 · 2 · 4 · 6 · 8</b>.</li>
   <li>On your turn press <b>MAKE YOUR MOVE</b>. You get a random even page from 2 to 100. Only its <b>last digit</b> counts (page 100 → slot 0).</li>
   <li>That slot grows: <b>Head → Body → Gun → Bullet</b>. Every slot grows on its own.</li>
   <li>The moment you get a <b>Bullet</b> you must fire it at once at any opponent's live slot.</li>
   <li>After firing, your stickman keeps head, body and gun. The next time that same digit comes up, the gun reloads instantly (and you must fire again).</li>
   <li>A destroyed slot is gone forever: that digit does nothing for its owner any more.</li>
   <li>Lose all five slots and you're out. If you lose connection, you have two minutes to come back.</li>
  </ol>`);
}

function confirmLeave(then) {
  const m = modal(`<h2 class="font-headline-lg text-headline-lg text-primary uppercase mb-2">Leave this match?</h2>
   <p class="font-body-md text-on-surface-variant mb-5">${snap()?.room.status === 'playing' ? 'You will be eliminated and cannot come back.' : 'You will leave the room.'}</p>
   <div class="flex gap-3 justify-end"><button type="button" data-stay class="px-4 py-2 border-2 border-primary rounded bg-surface-container shadow-[3px_3px_0px_#1e1e24] font-label-lg uppercase">Stay</button>
   <button type="button" data-leave class="px-4 py-2 border-2 border-error rounded bg-error text-on-error shadow-[3px_3px_0px_#1e1e24] font-label-lg uppercase">Leave</button></div>`);
  $('[data-stay]', m.el).onclick = m.close;
  $('[data-leave]', m.el).onclick = () => { m.close(); leaveNow(); then && then(); };
}

function leaveNow() {
  send('leave');
  setTimeout(() => { if (inSession()) endSession('left'); }, 400);
}

// ------------------------------------------------------------------ routing

const HASH_VIEWS = ['home', 'modes', 'setup'];

function desiredGameView() {
  const s = snap();
  if (!s) return null;
  if (s.room.status === 'lobby') return 'lobby';
  if (!s.match) return 'lobby';
  if (s.match.status === 'finished') return winnerReady ? 'winner' : 'arena';
  return net.serverNow() < s.match.startsAt ? 'pregame' : 'arena';
}

async function route() {
  if (inSession()) {
    const want = desiredGameView();
    if (!want) return showConnecting();
    const h = (location.hash.replace('#/', '') || 'home');
    if (HASH_VIEWS.includes(h) && view && view !== want && view !== 'connecting' && gameViews.includes(view)) {
      // user clicked a non-game nav entry while in a match
      location.hash = '#/' + view;
      return confirmLeave();
    }
    return mountGame(want);
  }
  const h = location.hash.replace('#/', '') || 'home';
  if (!HASH_VIEWS.includes(h)) {
    if (['lobby', 'arena', 'winner'].includes(h)) { toast('Join or create a match first.'); }
    location.hash = '#/home';
    return mountPlain('home');
  }
  return mountPlain(h);
}

const gameViews = ['lobby', 'pregame', 'arena', 'winner'];

async function mountPlain(name) {
  if (view === name) return;
  const html = await template(name);
  if (inSession()) return;
  setView(name, html);
  if (name === 'home') bindHome();
  if (name === 'modes') bindModes();
  if (name === 'setup') bindSetup();
}

function showConnecting() {
  if (view === 'connecting') return;
  setView('connecting', `<main class="pt-28 min-h-screen flex items-center justify-center px-6"><div class="pb-card p-8 text-center max-w-md relative"><div class="pb-tape"></div>
    <div class="mx-auto w-28 mb-2">${bigStickman('#2563eb', 3)}</div>
    <h2 class="font-headline-lg text-headline-lg uppercase text-primary blink">Finding your seat…</h2>
    <p class="font-body-md text-on-surface-variant mt-2">Reconnecting to your match.</p>
    <button type="button" id="giveUp" class="mt-5 underline decoration-dashed underline-offset-4 font-label-lg text-primary">Cancel</button></div></main>`);
  $('#giveUp').onclick = () => endSession('cancel');
}

function mountGame(want) {
  if (view === want) return;
  if (want === 'lobby') return mountLobby();
  if (want === 'pregame') return mountPregame();
  if (want === 'arena') return mountArena();
  if (want === 'winner') return mountWinner();
}

// ------------------------------------------------------------------ home / modes / setup

function bindHome() {
  // LET'S PLAY is a hash link; nothing else to bind.
}

function bindModes() {
  const input = $('#botPlayerName');
  try { input.value = localStorage.getItem('pb.name') || ''; } catch { /* ignore */ }
  const go = async () => {
    const name = input.value.trim();
    errBox('#botError', '');
    if (!name) { errBox('#botError', 'Enter your name first'); input.focus(); return; }
    const btn = $('#playBotsBtn');
    btn.disabled = true;
    try {
      try { localStorage.setItem('pb.name', name); } catch { /* ignore */ }
      const r = await api('/api/bots', { playerName: name });
      startSession({ token: r.token, playerId: r.playerId });
      location.hash = '#/lobby';
    } catch (e) { errBox('#botError', e.message); btn.disabled = false; }
  };
  $('#playBotsBtn').addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $$('[data-nav="setup"]').forEach((b) => b.addEventListener('click', () => { setupFocus = b.dataset.focus || null; location.hash = '#/setup'; }));
}

let setupFocus = null;
function bindSetup() {
  let cap = 4;
  const capEl = $('#capValue');
  const setCap = (n) => { cap = Math.max(2, Math.min(12, n)); capEl.textContent = cap; };
  $('#capMinus').onclick = () => setCap(cap - 1);
  $('#capPlus').onclick = () => setCap(cap + 1);
  let saved = ''; try { saved = localStorage.getItem('pb.name') || ''; } catch { /* ignore */ }
  $('#createPlayerName').value = saved;
  $('#playerNameInput').value = saved;
  $('#togglePasswordBtn')?.addEventListener('click', () => {
    const p = $('#createRoomPassword');
    const show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    $('#toggleEyeIcon').textContent = show ? 'visibility_off' : 'visibility';
  });

  const remember = (n) => { try { localStorage.setItem('pb.name', n); } catch { /* ignore */ } };
  const enter = (r, roomName) => { startSession({ token: r.token, playerId: r.playerId, roomName }); location.hash = '#/lobby'; };

  $('#createRoomForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox('#createError', '');
    const name = $('#createRoomName').value;
    const password = $('#createRoomPassword').value;
    const playerName = $('#createPlayerName').value.trim();
    if (!name.trim()) return errBox('#createError', 'Room name is required');
    if (!password.trim()) return errBox('#createError', 'A room password is required');
    if (!playerName) return errBox('#createError', 'Enter your name');
    const btn = e.submitter || $('#createRoomForm button[type=submit]');
    if (btn) btn.disabled = true;
    try { remember(playerName); enter(await api('/api/rooms', { name, password, maxPlayers: cap, playerName }), name); }
    catch (err) { errBox('#createError', err.message); if (btn) btn.disabled = false; }
  });

  const joinOrRejoin = async (path, e) => {
    errBox('#joinError', '');
    const room = $('#joinRoomInput').value;
    const password = $('#joinRoomPassword').value;
    const playerName = $('#playerNameInput').value.trim();
    if (!room.trim() || !password || !playerName) return errBox('#joinError', 'Room, password and your name are all required');
    const btns = $$('#joinRoomForm button'); btns.forEach((b) => { b.disabled = true; });
    try { remember(playerName); enter(await api(path, { room, password, playerName }), room); }
    catch (err) { errBox('#joinError', err.message); btns.forEach((b) => { b.disabled = false; }); }
  };
  $('#joinRoomForm').addEventListener('submit', (e) => { e.preventDefault(); joinOrRejoin('/api/rooms/join', e); });
  $('#rejoinBtn').addEventListener('click', () => joinOrRejoin('/api/rooms/rejoin'));

  if (setupFocus) {
    const panel = $(`[data-panel="${setupFocus}"]`);
    panel?.scrollIntoView({ block: 'center' });
    $(setupFocus === 'create' ? '#createRoomName' : '#joinRoomInput')?.focus({ preventScroll: true });
    setupFocus = null;
  }
}

// ------------------------------------------------------------------ lobby

function mountLobby() {
  setView('lobby', `<main class="pt-28 pb-16 min-h-screen px-4 sm:px-8 max-w-6xl mx-auto">
   <div class="grid lg:grid-cols-3 gap-8 items-start">
    <section class="lg:col-span-2 pb-card p-6 sm:p-8 relative"><div class="pb-tape"></div>
     <div class="flex flex-wrap items-end justify-between gap-3 border-b-2 border-dashed border-outline pb-4 mb-5">
      <div><span class="font-stamp-badge text-label-md text-secondary uppercase tracking-widest">Waiting lobby</span>
      <h1 id="lbName" class="font-headline-xl text-headline-xl text-primary uppercase leading-none mt-1 break-words"></h1></div>
      <div id="lbCount" class="stamp stamp-turn"></div></div>
     <div id="lbSeats" class="grid grid-cols-2 sm:grid-cols-3 gap-5"></div>
     <p id="lbMsg" class="mt-6 font-body-md text-on-surface-variant"></p>
     <div class="mt-6 flex flex-wrap gap-3" id="lbActions"></div>
    </section>
    <aside class="pb-card-sm p-6 tilt-r relative">
     <h2 class="font-headline-md text-headline-md uppercase text-primary mb-3">Invite your friends</h2>
     <div id="lbInvite" class="space-y-3 font-body-md"></div>
     <hr class="my-4 border-dashed border-outline">
     <h3 class="font-label-lg text-label-lg uppercase text-secondary mb-1">Reminder</h3>
     <p class="font-body-sm text-on-surface-variant">Even pages 2–100 · last digit picks the slot · Head → Body → Gun → Bullet. <button type="button" id="lbRules" class="underline decoration-dashed underline-offset-4 text-primary">Full rules</button></p>
    </aside></div></main>`);
  $('#lbRules').onclick = showRules;
  renderLobby();
}

function renderLobby() {
  const s = snap();
  if (!s || view !== 'lobby') return;
  const r = s.room;
  const amHost = r.hostId === s.you;
  $('#lbName').textContent = r.mode === 'bots' ? 'Bot Match' : r.name;
  $('#lbCount').textContent = `${r.members.length} / ${r.maxPlayers} players`;
  let seats = '';
  r.members.forEach((m, i) => {
    seats += `<div class="text-center">
      <div class="w-24 mx-auto ${m.connected ? '' : 'opacity-40'}">${bigStickman(m.color, i)}</div>
      <div class="mt-1 inline-flex items-center gap-1.5 max-w-full">${dot(m.color, 12)}<span class="font-headline-md text-[17px] uppercase text-primary truncate">${esc(m.name)}</span></div>
      <div class="mt-1 flex flex-wrap justify-center gap-1">
       ${m.id === r.hostId ? '<span class="stamp stamp-turn text-[11px]">Host</span>' : ''}
       ${m.id === s.you ? '<span class="stamp text-[11px] text-secondary">You</span>' : ''}
       ${m.type === 'human' && m.id !== r.hostId ? `<span class="font-label-md text-[12px] uppercase ${m.ready ? 'text-[#16a34a]' : 'text-outline'}">${m.ready ? '✔ Ready' : 'Not ready'}</span>` : ''}
       ${!m.connected && m.type === 'human' ? '<span class="font-label-md text-[12px] uppercase text-error">offline</span>' : ''}
      </div></div>`;
  });
  for (let i = r.members.length; i < r.maxPlayers; i++) {
    seats += `<div class="text-center"><div class="lobby-seat-empty w-24 h-28 mx-auto rounded-lg flex items-center justify-center text-outline font-headline-lg">?</div><div class="mt-1 font-label-md text-outline uppercase blink">Waiting…</div></div>`;
  }
  $('#lbSeats').innerHTML = seats;

  const enough = r.members.length >= 2;
  $('#lbMsg').textContent = amHost
    ? (enough ? 'Everyone in? Start the match. No one can join after it starts.' : 'You need at least two players to start.')
    : 'Waiting for the host to start the match…';
  const btn = 'px-5 py-3 border-2 border-primary rounded-lg font-headline-md text-[17px] uppercase shadow-[3px_3px_0px_#1e1e24] transition-all active:translate-x-0.5 active:translate-y-0.5 active:shadow-none disabled:opacity-50 disabled:shadow-none';
  const me_ = memberOf(s, s.you);
  $('#lbActions').innerHTML =
    (amHost ? `<button type="button" id="lbStart" class="${btn} bg-primary text-on-primary" ${enough ? '' : 'disabled'}>⚡ Start match</button>`
      : `<button type="button" id="lbReady" class="${btn} ${me_.ready ? 'bg-surface-container text-primary' : 'bg-primary-container text-on-primary'}">${me_.ready ? 'Not ready' : 'I’m ready'}</button>`) +
    `<button type="button" id="lbLeave" class="${btn} bg-surface-container text-primary">Leave room</button>`;
  $('#lbStart')?.addEventListener('click', (e) => { e.currentTarget.disabled = true; send('start'); });
  $('#lbReady')?.addEventListener('click', () => send('ready', { ready: !me_.ready }));
  $('#lbLeave').addEventListener('click', () => confirmLeave());

  const code = r.code;
  $('#lbInvite').innerHTML = code
    ? `<div><span class="font-label-md uppercase text-on-surface-variant">Room name</span><div class="font-headline-md break-all text-primary">${esc(r.name)}</div></div>
       <div><span class="font-label-md uppercase text-on-surface-variant">Room code</span><div class="flex items-center gap-2"><span class="font-headline-lg tracking-[.25em] text-primary">${esc(code)}</span><button type="button" id="copyCode" class="px-2 py-1 border-2 border-primary rounded bg-surface-container text-xs font-bold uppercase shadow-[2px_2px_0px_#1e1e24]">Copy</button></div></div>
       <p class="font-body-sm text-on-surface-variant">Friends join with the room name <i>or</i> code, plus the password you chose. Share the password privately — it is not shown here.</p>`
    : '<p class="font-body-sm text-on-surface-variant">Bots are already seated. The match starts automatically.</p>';
  $('#copyCode')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(code); toast('Room code copied'); } catch { toast('Copy failed — select it manually', 'err'); } });
}

// ------------------------------------------------------------------ pre-game

function mountPregame() {
  const s = snap();
  const order = s.match.order;
  setView('pregame', `<main class="pt-28 pb-16 min-h-screen px-4 sm:px-8 max-w-5xl mx-auto text-center">
    <div class="pb-card p-6 sm:p-10 relative"><div class="pb-tape"></div>
    <span class="font-stamp-badge text-label-md text-secondary uppercase tracking-widest">Match initialisation</span>
    <h1 class="font-headline-xl text-headline-xl uppercase text-primary mt-1">Sharpen your pencils!</h1>
    <p class="font-body-md text-on-surface-variant mt-2">Turn order was drawn at random. First up: <b id="pgFirst" class="text-primary"></b></p>
    <ol id="pgOrder" class="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-6 list-none p-0"></ol>
    <div class="mt-8"><span class="stamp stamp-turn text-2xl" id="pgCount">…</span></div></div></main>`);
  $('#pgFirst').textContent = nameOf(s, order[0]);
  $('#pgOrder').innerHTML = order.map((id, i) => {
    const m = memberOf(s, id);
    return `<li class="relative"><span class="absolute -top-2 left-1/2 -translate-x-1/2 stamp text-xs bg-surface">${ordinal(i + 1)}</span>
      <div class="w-24 mx-auto pt-3">${bigStickman(m.color, s.room.members.findIndex((x) => x.id === id))}</div>
      <div class="font-headline-md text-[16px] uppercase text-primary truncate">${esc(m.name)}</div></li>`;
  }).join('');
  const update = () => {
    const left = snap()?.match ? snap().match.startsAt - net.serverNow() : 0;
    $('#pgCount').textContent = left > 0 ? `Starting in ${Math.ceil(left / 1000)}` : 'GO!';
    if (left <= 0) { clearInterval(tick); route(); }
  };
  update();
  tick = setInterval(update, 250);
}

// ------------------------------------------------------------------ arena

let lastSeq = 0;
let animQueue = Promise.resolve();
const holdDead = new Set(); // "pid:digit" tiles kept alive until the bullet lands
const holdOut = new Set(); // player ids kept alive until their OUT stamp
let winnerReady = false;
let rollLock = false;
let attackSel = null;
let attackSubmitting = false;
let bookState = { page: null, digit: null, by: null };
let seenMatchId = null;

function describe(s, ev) {
  const n = (id) => nameOf(s, id);
  switch (ev.type) {
    case 'match_started': return { t: 'Match started. Good luck!', k: 'sys' };
    case 'page_rolled': {
      const o = ev.outcome === 'dead_slot' ? 'slot already destroyed — no progress' : ev.outcome === 'bullet' ? 'BULLET!' : ev.outcome === 'gun' ? 'GUN' : ev.outcome.toUpperCase();
      return { t: `${n(ev.playerId)} flipped page ${ev.page} → slot ${ev.digit}: ${o}`, k: 'roll' };
    }
    case 'bullet_ready': return { t: `${n(ev.playerId)} has a bullet and must fire!`, k: 'sys' };
    case 'slot_eliminated': return { t: `${n(ev.attackerId)} eliminated ${n(ev.targetId)}'s slot ${ev.targetDigit}!`, k: 'kill' };
    case 'player_eliminated': return { t: ev.reason === 'slots' ? `${n(ev.playerId)} has been eliminated!` : `${n(ev.playerId)} is out (${ev.reason === 'timeout' ? 'disconnected' : 'left the game'}).`, k: 'out' };
    case 'player_disconnected': return { t: `${n(ev.playerId)} lost connection.`, k: 'sys' };
    case 'player_reconnected': return { t: `${n(ev.playerId)} is back!`, k: 'sys' };
    case 'match_finished': return { t: ev.winnerId ? `${n(ev.winnerId)} wins Page Battle!` : 'Match over.', k: 'out' };
    default: return null;
  }
}

function mountArena() {
  const s = snap();
  setView('arena', `<main class="pt-28 pb-10 px-3 sm:px-6 max-w-[1400px] mx-auto min-h-screen">
   <div class="grid xl:grid-cols-[1fr_360px] gap-6 items-start">
    <section id="players" class="grid gap-5 sm:grid-cols-2 2xl:grid-cols-2 content-start" aria-label="Players"></section>
    <aside class="space-y-5 order-first xl:order-none xl:sticky xl:top-24">
     <div class="pb-card p-4 relative"><div class="pb-tape"></div>
      <div class="flex items-center justify-between gap-2 mb-2"><div id="turnWho" class="font-headline-md text-[18px] uppercase text-primary truncate"></div><span id="turnStamp" class="stamp stamp-turn text-xs whitespace-nowrap"></span></div>
      <div class="book-stage" id="book"><div class="book-num" id="bookNum" aria-live="polite">—</div></div>
      <p id="bookInfo" class="mt-2 min-h-[2.4em] text-center font-label-lg text-label-lg uppercase text-on-surface-variant"></p>
      <button type="button" id="moveBtn" class="move-btn w-full mt-2 py-4 rounded-xl font-headline-lg text-headline-lg uppercase tracking-wide flex items-center justify-center gap-2" disabled><span class="material-symbols-outlined">bolt</span><span id="moveLabel">Wait…</span></button>
     </div>
     <div class="pb-card-sm p-4"><div class="flex items-center justify-between mb-2"><h2 class="font-headline-md text-[17px] uppercase text-primary">Battle history</h2><button type="button" id="arRules" class="text-xs underline decoration-dashed underline-offset-4">Rules</button></div>
      <div id="log" class="max-h-[300px] overflow-y-auto pr-1" aria-live="polite"></div></div>
     <button type="button" id="arLeave" class="w-full py-2 border-2 border-primary rounded bg-surface-container shadow-[2px_2px_0px_#1e1e24] font-label-lg uppercase">Leave match</button>
    </aside></div></main>`);
  $('#arRules').onclick = showRules;
  $('#arLeave').onclick = () => confirmLeave();
  $('#moveBtn').onclick = () => {
    const s2 = snap();
    if (rollLock || !canRoll(s2)) return;
    rollLock = true;
    $('#moveBtn').disabled = true;
    if (!send('roll')) rollLock = false;
  };
  lastSeq = s.match.events.at(-1)?.seq || 0;
  if (s.match.id !== seenMatchId) { seenMatchId = s.match.id; holdDead.clear(); holdOut.clear(); winnerReady = s.match.status === 'finished' && false; }
  bookState = { page: null, digit: null, by: null };
  const lr = s.match.lastRoll;
  if (lr) { bookState = { page: lr.page, digit: lr.digit, by: lr.playerId }; $('#bookNum').textContent = lr.page; $('#bookInfo').innerHTML = `${esc(nameOf(s, lr.playerId))} → slot ${lr.digit}`; }
  renderArena();
  tick = setInterval(() => { updateMoveButton(); updateCountdowns(); }, 500);
  cleanup = () => { closeAttack(); };
  if (s.match.status === 'finished') finishToWinner(0);
}

const canRoll = (s) => !!s?.match && s.match.status === 'playing' && s.match.phase === 'await_roll'
  && s.match.currentPlayerId === s.you && net.serverNow() >= s.turnReadyAt;

function renderArena() {
  const s = snap();
  if (!s || view !== 'arena') return;
  const m = s.match;
  // players
  const order = m.order;
  const cards = order.map((id) => m.players.find((p) => p.id === id)).map((p) => playerCard(s, p)).join('');
  const host = $('#players');
  if (host) host.innerHTML = cards;
  // turn header
  const cur = m.currentPlayerId;
  $('#turnWho').textContent = m.status === 'finished' ? 'Match over' : (cur === s.you ? 'Your turn!' : `${nameOf(s, cur)}'s turn`);
  $('#turnStamp').textContent = m.status === 'finished' ? '' : (m.phase === 'await_attack' ? 'Aiming…' : 'Round ' + m.round);
  updateMoveButton();
  renderLog(s);
  if (m.targets && m.phase === 'await_attack' && m.currentPlayerId === s.you && animPending === 0) openAttack(s); else if (!(m.targets && m.phase === 'await_attack')) closeAttack();
  updateChrome();
  updateCountdowns();
}

function playerCard(s, p) {
  const mem = memberOf(s, p.id) || {};
  const out = p.eliminated && !holdOut.has(p.id);
  const isTurn = s.match.currentPlayerId === p.id && s.match.status === 'playing' && !out;
  const alive = DIGITS.filter((d) => !p.slots[d].eliminated || holdDead.has(`${p.id}:${d}`)).length;
  const tiles = DIGITS.map((d) => {
    const sl = p.slots[d];
    const dead = sl.eliminated && !holdDead.has(`${p.id}:${d}`);
    const cls = ['slot-tile', dead ? 'dead' : '', !dead && sl.stage === 4 ? 'is-bullet' : ''].join(' ');
    return `<div class="${cls}" data-tile="${esc(p.id)}:${d}" title="Slot ${d}: ${dead ? 'DESTROYED' : STAGE_NAMES[sl.stage]}">
      <div class="digit">${d}</div>${slotStickman(dead ? Math.min(sl.stage, 2) : sl.stage, p.color, { dead })}
      <div class="stage">${dead ? 'DEAD' : STAGE_NAMES[sl.stage]}</div>${dead ? `<div class="cross">${crossScribble()}</div>` : ''}</div>`;
  }).join('');
  const status = out ? 'ELIMINATED' : !mem.connected && mem.type === 'human' ? 'RECONNECTING' : isTurn ? 'YOUR TURN'.replace('YOUR', p.id === s.you ? 'YOUR' : 'THEIR') : 'IN THE GAME';
  return `<article class="player-card pb-card p-3 sm:p-4 ${isTurn ? 'is-turn' : ''} ${out ? 'is-out' : ''}" style="--pc:${safeColor(p.color)}" data-player="${esc(p.id)}">
    <div class="ring"></div>
    <header class="flex items-center justify-between gap-2 mb-3">
      <div class="flex items-center gap-2 min-w-0">${dot(p.color, 18)}<h3 class="pname font-headline-md text-[18px] uppercase text-primary truncate">${esc(p.name)}</h3>
        ${p.id === s.you ? '<span class="stamp text-[10px] text-secondary">You</span>' : ''}${p.type === 'bot' ? '<span class="stamp text-[10px] text-outline">Bot</span>' : ''}</div>
      <div class="text-right shrink-0"><div class="font-stamp-badge text-[11px] uppercase ${out ? 'text-error' : isTurn ? 'text-[#2563eb]' : 'text-on-surface-variant'}" data-status>${status}</div>
        <div class="font-label-md text-[12px] uppercase text-on-surface-variant">${alive}/5 slots</div></div></header>
    <div class="grid grid-cols-5 gap-1.5 sm:gap-2">${tiles}</div>
    <div data-disc class="mt-2 text-center font-label-lg text-[12px] uppercase text-error"></div>
    ${out ? '<div class="out-overlay"><span class="stamp stamp-out">OUT!</span></div>' : ''}
  </article>`;
}

function updateCountdowns() {
  const s = snap();
  if (!s || (view !== 'arena')) return;
  $$('.player-card').forEach((card) => {
    const m = memberOf(s, card.dataset.player);
    const el = $('[data-disc]', card);
    if (!m || !el) return;
    el.textContent = !m.connected && m.type === 'human' && m.disconnectDeadline
      ? `Lost connection — ${fmtClock(m.disconnectDeadline - net.serverNow())} to return` : '';
  });
}

function updateMoveButton() {
  const s = snap();
  const btn = $('#moveBtn');
  if (!btn || !s?.match) return;
  const m = s.match;
  const mine = m.currentPlayerId === s.you && m.status === 'playing';
  const ready = canRoll(s) && !rollLock;
  btn.disabled = !ready;
  btn.classList.toggle('go', ready);
  btn.setAttribute('aria-disabled', String(!ready));
  let label;
  if (m.status === 'finished') label = 'Match over';
  else if (mine && m.phase === 'await_attack') label = 'Choose your target!';
  else if (mine && ready) label = 'MAKE YOUR MOVE';
  else if (mine) label = 'Get ready…';
  else label = `${nameOf(s, m.currentPlayerId)} is moving…`;
  $('#moveLabel').textContent = label;
}

function renderLog(s) {
  const el = $('#log');
  if (!el) return;
  const lines = s.match.events.map((ev) => ({ ev, d: describe(s, ev) })).filter((x) => x.d).reverse();
  el.innerHTML = lines.map(({ ev, d }) => `<div class="log-line ${d.k === 'kill' || d.k === 'out' ? 'font-bold' : ''} ${d.k === 'out' ? 'text-error' : ''}" data-seq="${ev.seq}">${esc(d.t)}</div>`).join('');
}

// ----- attack selection

let animPending = 0; // animations queued or running; the attack picker waits for 0

function openAttack(s) {
  if (attackSubmitting || $('#atk')) return;
  const targets = s.match.targets || [];
  if (!targets.length) return;
  attackSel = { targetId: targets[0].playerId, digit: null };
  const host = $('#modalHost');
  host.innerHTML = `<div class="modal-wash" id="atk" role="dialog" aria-modal="true" aria-label="Attack selection"><div class="modal-sheet p-5 sm:p-7">
    <div class="flex items-start justify-between gap-3 mb-1"><div><span class="stamp stamp-out text-sm">Bullet ready!</span>
    <h2 class="font-headline-xl text-headline-xl text-primary uppercase mt-2 leading-none">Pick your target</h2></div>
    <div class="w-16 shrink-0">${bigStickman(me(s).color, 0)}</div></div>
    <p class="font-body-md text-on-surface-variant mb-4">You must fire now. Choose an opponent, then one of their live slots.</p>
    <div id="atkOpps" class="grid sm:grid-cols-2 gap-3"></div>
    <p id="atkErr" class="hidden mt-3 font-label-lg text-error uppercase" role="alert"></p>
    <button type="button" id="atkFire" class="move-btn w-full mt-5 py-4 rounded-xl font-headline-lg text-headline-lg uppercase" disabled>🔫 Fire!</button></div></div>`;
  renderAttack(s);
  $('#atkFire').onclick = fire;
}

function renderAttack(s) {
  const box = $('#atkOpps');
  if (!box) return;
  const targets = s.match.targets || [];
  box.innerHTML = targets.map((t) => {
    const p = s.match.players.find((x) => x.id === t.playerId);
    const sel = attackSel?.targetId === t.playerId;
    // Stage colour badges: empty=grey, head=blue, body=green, gun=orange, bullet=red
    const stageBadgeColor = ['#78767b','#2563eb','#16a34a','#d97706','#dc2626'];
    return `<div class="pb-card-sm p-3 ${sel ? 'ring-4 ring-secondary' : ''}" data-opp="${esc(t.playerId)}">
      <button type="button" data-pick-opp="${esc(t.playerId)}" class="w-full flex items-center gap-2 mb-2 text-left">${dot(p.color, 16)}<span class="font-headline-md text-[17px] uppercase truncate">${esc(p.name)}</span><span class="ml-auto font-label-md text-[12px] text-on-surface-variant">${t.digits.length}/5 slots</span></button>
      <div class="grid grid-cols-5 gap-1.5">${DIGITS.map((d) => {
        const live = t.digits.includes(d);
        const on = sel && attackSel.digit === d;
        const stage = p.slots[d].stage;
        const stageName = STAGE_NAMES[stage];
        const badgeColor = stageBadgeColor[stage] || '#78767b';
        return `<button type="button" class="target-slot ${on ? 'sel' : ''} py-1 font-headline-md text-[18px] flex flex-col items-center gap-0" data-pick-slot="${esc(t.playerId)}:${d}" ${live ? '' : 'disabled'} aria-label="${esc(p.name)} slot ${d}: ${live ? stageName : 'destroyed'}" title="Slot ${d}: ${live ? stageName : 'DESTROYED'}">
          <span class="leading-tight">${d}</span>
          <span class="slot-stage-badge" style="background:${live ? badgeColor : '#c0bab2'};opacity:${live ? '1' : '0.5'}">${live ? stageName : 'DEAD'}</span>
        </button>`;
      }).join('')}</div></div>`;
  }).join('');
  $$('[data-pick-opp]', box).forEach((b) => b.addEventListener('click', () => { attackSel = { targetId: b.dataset.pickOpp, digit: null }; renderAttack(snap()); }));
  $$('[data-pick-slot]', box).forEach((b) => b.addEventListener('click', () => {
    const [id, d] = b.dataset.pickSlot.split(':');
    attackSel = { targetId: id, digit: Number(d) };
    renderAttack(snap());
  }));
  const fireBtn = $('#atkFire');
  if (fireBtn) {
    fireBtn.disabled = attackSel?.digit == null || attackSubmitting;
    const tp = attackSel?.digit != null ? s.match.players.find((x) => x.id === attackSel.targetId) : null;
    fireBtn.textContent = tp ? `🔫 Fire at ${tp.name}'s slot ${attackSel.digit}!` : '🔫 Fire!';
  }
}

function fire() {
  if (attackSubmitting || attackSel?.digit == null) return;
  attackSubmitting = true;
  $('#atkFire').disabled = true;
  if (!send('attack', { targetId: attackSel.targetId, digit: attackSel.digit })) { attackSubmitting = false; $('#atkFire').disabled = false; }
}

function closeAttack() {
  if ($('#atk')) $('#modalHost').innerHTML = '';
  attackSel = null;
}

// ----- animations

const wait = sleep;

function announce(text, kind = '') {
  const a = document.createElement('div');
  a.className = 'announce ' + kind;
  a.textContent = text;
  document.body.appendChild(a);
  setTimeout(() => a.remove(), 2700);
}

function tileEl(pid, digit) { return document.querySelector(`[data-tile="${CSS.escape(pid)}:${digit}"]`); }

async function animRoll(s, ev) {
  const book = $('#book');
  if (!book) return;
  const num = $('#bookNum');
  const info = $('#bookInfo');
  if (!num) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  num.style.visibility = 'hidden';
  info.textContent = `${nameOf(s, ev.playerId)} is flipping pages…`;
  const pages = document.createElement('div');
  pages.className = 'flip-pages';
  pages.innerHTML = '<div class="flip-page"></div><div class="flip-page"></div><div class="flip-page"></div><div class="flip-page"></div>';
  book.appendChild(pages);
  sfx.flip();
  await wait(reduce ? 200 : 1250);
  pages.remove();
  num.textContent = ev.page;
  num.style.visibility = 'visible';
  num.classList.remove('reveal'); void num.offsetWidth; num.classList.add('reveal');
  const outcome = { dead_slot: 'slot already destroyed — no progress', head: 'HEAD drawn', body: 'BODY drawn', gun: 'GUN drawn', bullet: 'BULLET LOADED!' }[ev.outcome];
  info.innerHTML = `${esc(nameOf(s, ev.playerId))} → slot <b>${ev.digit}</b>: ${esc(outcome)}`;
  const tile = tileEl(ev.playerId, ev.digit);
  if (tile) { tile.classList.remove('hl'); void tile.offsetWidth; tile.classList.add('hl'); }
  await wait(900);
}

async function animAttack(s, ev) {
  const from = tileEl(ev.attackerId, ev.fromDigit);
  const to = tileEl(ev.targetId, ev.targetDigit);
  const card = document.querySelector(`[data-player="${CSS.escape(ev.attackerId)}"]`);
  if (card) { card.classList.add('aiming'); }
  announce(`${nameOf(s, ev.attackerId)} IS AIMING…`);
  await wait(550);
  sfx.shoot();
  if (from && to) {
    const a = from.getBoundingClientRect(); const b = to.getBoundingClientRect();
    const bullet = document.createElement('div');
    bullet.className = 'bullet-fly';
    document.body.appendChild(bullet);
    const x0 = a.left + a.width / 2 - 8; const y0 = a.top + a.height / 2 - 8;
    const x1 = b.left + b.width / 2 - 8; const y1 = b.top + b.height / 2 - 8;
    const ang = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
    const anim = bullet.animate([{ transform: `translate(${x0}px,${y0}px) rotate(${ang}deg)` }, { transform: `translate(${x1}px,${y1}px) rotate(${ang}deg)` }], { duration: 650, easing: 'cubic-bezier(.3,.6,.4,1)', fill: 'forwards' });
    try { await anim.finished; } catch { /* cancelled */ }
    bullet.remove();
    const imp = document.createElement('div');
    imp.className = 'impact'; imp.textContent = 'POW!';
    imp.style.left = (x1 - 8) + 'px'; imp.style.top = (y1 - 10) + 'px';
    document.body.appendChild(imp); setTimeout(() => imp.remove(), 750);
  } else await wait(500);
  card?.classList.remove('aiming');
  holdDead.delete(`${ev.targetId}:${ev.targetDigit}`);
  sfx.slotOut();
  renderArena();
  const t2 = tileEl(ev.targetId, ev.targetDigit);
  t2?.classList.add('popped');
  document.querySelector(`[data-player="${CSS.escape(ev.targetId)}"]`)?.classList.add('shake');
  announce(`💥 ${nameOf(s, ev.attackerId)} ELIMINATED ${nameOf(s, ev.targetId)}'S SLOT ${ev.targetDigit}!`, 'kill');
  await wait(1400);
  document.querySelector(`[data-player="${CSS.escape(ev.targetId)}"]`)?.classList.remove('shake');
}

async function animPlayerOut(s, ev) {
  const card = document.querySelector(`[data-player="${CSS.escape(ev.playerId)}"]`);
  card?.classList.add('fall');
  sfx.playerOut();
  announce(ev.reason === 'slots' ? `☠️ ${nameOf(s, ev.playerId)} HAS BEEN ELIMINATED FROM THE GAME!` : `☠️ ${nameOf(s, ev.playerId)} LEFT THE GAME!`, 'out');
  await wait(1000);
  holdOut.delete(ev.playerId);
  renderArena();
  await wait(900);
}

function finishToWinner(delay) {
  animQueue = animQueue.then(async () => {
    await wait(delay);
    winnerReady = true;
    if (snap()?.match?.status === 'finished') { sfx.gameOver(); route(); }
  });
}

function processEvents(s) {
  const fresh = s.match.events.filter((e) => e.seq > lastSeq);
  if (!fresh.length) return;
  lastSeq = fresh.at(-1).seq;
  // hold visual state back until each animation reaches it
  for (const ev of fresh) {
    if (ev.type === 'slot_eliminated') holdDead.add(`${ev.targetId}:${ev.targetDigit}`);
    if (ev.type === 'player_eliminated' && ev.reason === 'slots') holdOut.add(ev.playerId);
  }
  let sawFinish = false;
  for (const ev of fresh) {
    animPending += 1;
    animQueue = animQueue.then(async () => {
      if (view !== 'arena') { animPending = Math.max(0, animPending - 1); return; }
      try {
        if (ev.type === 'page_rolled') await animRoll(s, ev);
        else if (ev.type === 'slot_eliminated') await animAttack(s, ev);
        else if (ev.type === 'player_eliminated') {
          if (ev.reason === 'slots') await animPlayerOut(s, ev);
          else { announce(`☠️ ${nameOf(s, ev.playerId)} LEFT THE GAME!`, 'out'); sfx.playerOut(); }
        }
      } catch (e) { console.error(e); }
      animPending = Math.max(0, animPending - 1);
      renderArena();
    });
    if (ev.type === 'match_finished') sawFinish = true;
  }
  if (sawFinish) finishToWinner(900);
}

// ------------------------------------------------------------------ winner

function mountWinner() {
  const s = snap();
  const m = s.match; const sum = m.summary;
  const win = m.players.find((p) => p.id === m.winnerId);
  const idx = s.room.members.findIndex((x) => x.id === m.winnerId);
  const stand = sum.standings.slice(0, 3);
  const heights = ['h-32', 'h-24', 'h-16'];
  const podiumOrder = [stand[1], stand[0], stand[2]].filter(Boolean);
  const confetti = Array.from({ length: 26 }, (_, i) => `<span class="confetti" style="left:${(i * 37) % 100}%;background:${['#dc2626', '#2563eb', '#ffcf4a', '#16a34a', '#c026d3'][i % 5]};animation-delay:${(i % 9) * 0.35}s;animation-duration:${2.6 + (i % 5) * 0.4}s"></span>`).join('');
  setView('winner', `<main class="pt-28 pb-16 min-h-screen px-4 sm:px-8 max-w-4xl mx-auto">
   <section class="pb-card p-6 sm:p-10 text-center relative overflow-hidden"><div class="pb-tape"></div>${confetti}
    <span class="stamp stamp-out text-base">Game over</span>
    <h1 class="font-headline-xl text-headline-xl uppercase text-primary mt-3 leading-tight">${win ? 'Ultimate winner of Page Battle!' : 'Nobody survived!'}</h1>
    ${win ? `<div class="w-44 sm:w-56 mx-auto mt-2">${bigStickman(win.color, idx, { mode: 'dance', crown: true })}</div>
    <div class="inline-flex items-center gap-2 mt-1">${dot(win.color, 20)}<span class="font-headline-xl text-headline-lg uppercase text-primary break-all">${esc(win.name)}</span></div>` : ''}
    <div class="mt-6 flex items-end justify-center gap-2 sm:gap-3" aria-label="Podium">${podiumOrder.map((p) => {
      const place = p.rank; const h = heights[place - 1];
      return `<div class="w-24 sm:w-32 text-center"><div class="font-headline-md text-[14px] uppercase truncate">${esc(p.name)}</div><div class="${h} mt-1 border-2 border-primary bg-surface-container shadow-[3px_3px_0px_#1e1e24] flex items-start justify-center pt-2"><span class="font-headline-xl text-headline-lg text-primary">${place}</span></div></div>`;
    }).join('')}</div>
    <dl class="mt-8 grid grid-cols-3 gap-3 text-center">
      <div class="pb-card-sm p-3"><dt class="font-label-md text-[12px] uppercase text-on-surface-variant">Eliminations</dt><dd class="font-headline-xl text-headline-lg text-primary">${sum.totalEliminations}</dd></div>
      <div class="pb-card-sm p-3"><dt class="font-label-md text-[12px] uppercase text-on-surface-variant">Slots left</dt><dd class="font-headline-xl text-headline-lg text-primary">${sum.remainingSlots}/5</dd></div>
      <div class="pb-card-sm p-3"><dt class="font-label-md text-[12px] uppercase text-on-surface-variant">Rounds</dt><dd class="font-headline-xl text-headline-lg text-primary">${sum.totalRounds}</dd></div></dl>
    <div class="mt-8 flex flex-wrap justify-center gap-3" id="wnActions"></div>
    <p id="wnMsg" class="mt-3 font-body-sm text-on-surface-variant"></p>
   </section></main>`);
  const btn = 'px-6 py-3 border-2 border-primary rounded-lg font-headline-md text-[18px] uppercase shadow-[3px_3px_0px_#1e1e24] active:translate-x-0.5 active:translate-y-0.5 active:shadow-none';
  const amHost = s.room.hostId === s.you;
  const canAgain = s.room.mode === 'bots' || amHost;
  $('#wnActions').innerHTML = (canAgain ? `<button type="button" id="wnAgain" class="${btn} bg-primary text-on-primary">Play again</button>` : '') + `<button type="button" id="wnHome" class="${btn} bg-surface-container text-primary">Return to home</button>`;
  if (!canAgain) $('#wnMsg').textContent = 'Waiting for the host to start a new match…';
  $('#wnAgain')?.addEventListener('click', (e) => { e.currentTarget.disabled = true; winnerReady = false; send('rematch'); });
  $('#wnHome').addEventListener('click', () => { send('leave'); setTimeout(() => { if (inSession()) endSession('left'); }, 300); });
}

// ------------------------------------------------------------------ wiring

net.on('state', (s) => {
  if (!inSession()) return;
  if (s.match && s.match.id !== seenMatchId && view !== 'arena') { winnerReady = false; }
  const want = desiredGameView();
  if (s.match && view === 'arena') {
    processEvents(s);
    if (want && want !== 'arena' && want !== 'winner') { mountGame(want); return; }
    renderArena();
    if (attackSubmitting && !(s.match.phase === 'await_attack' && s.match.currentPlayerId === s.you)) attackSubmitting = false;
    if (rollLock) rollLock = false;
    if ($('#atk')) renderAttack(s);
    return;
  }
  if (view === 'lobby' && want === 'lobby') { renderLobby(); return; }
  if (view === 'winner' && want === 'winner') return;
  if (want === 'pregame' && view === 'pregame') return;
  if (want !== view) { route(); }
  if (view === 'lobby') renderLobby();
});

net.on('error', (e) => {
  rollLock = false;
  if (attackSubmitting) { attackSubmitting = false; const f = $('#atkFire'); if (f) f.disabled = attackSel?.digit == null; }
  if (e.code === 'too_early') { toast('Hold on — animations are still playing.'); return; }
  if (e.code === 'not_your_turn' || e.code === 'invalid_phase') return;
  toast(e.message || 'Something went wrong', 'err');
  if (view === 'arena') renderArena();
  if (view === 'lobby') { const b = $('#lbStart'); if (b) b.disabled = false; }
});

net.on('ended', (reason) => {
  closeModal();
  holdDead.clear(); holdOut.clear(); winnerReady = false; seenMatchId = null; animQueue = Promise.resolve(); animPending = 0; attackSubmitting = false; rollLock = false;
  const msg = { expired: 'Your session expired — please rejoin.', replaced: 'You joined from another tab or device.', 'closed:expired': 'The room expired.', 'closed:empty': 'The room was closed.', 'closed:left': 'The match ended.' }[reason];
  if (msg) toast(msg, reason === 'expired' ? 'err' : '');
  view = null;
  location.hash = '#/home';
  route();
});

let _reconnAttempt = 0;
net.on('conn', (st) => {
  const banner = $('#connBanner');
  if (!banner) return;
  if (st === 'down' && inSession()) {
    _reconnAttempt += 1;
    banner.textContent = `Connection lost — reconnecting… (attempt ${_reconnAttempt})`;
    banner.classList.remove('hidden');
    // Unlock any stuck locks so the player isn't frozen when they reconnect.
    rollLock = false;
    attackSubmitting = false;
  } else if (st === 'open') {
    _reconnAttempt = 0;
    banner.classList.add('hidden');
  } else if (st === 'idle') {
    _reconnAttempt = 0;
    banner.classList.add('hidden');
  }
});

window.addEventListener('hashchange', () => route());
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-nav]');
  if (a && a.tagName === 'A') {
    const k = a.dataset.nav;
    if (inSession() && !['lobby', 'arena', 'winner'].includes(k)) { e.preventDefault(); confirmLeave(); return; }
    if (!inSession() && ['lobby', 'arena', 'winner'].includes(k)) { e.preventDefault(); toast('Join or create a match first.'); return; }
    if (inSession()) { e.preventDefault(); toast('Navigation follows the match automatically.'); }
  }
});
$('#sfxBtn').addEventListener('click', () => { sound.toggle(); syncSoundBtn(); });
$('#footSound').addEventListener('click', () => { sound.toggle(); syncSoundBtn(); toast(sound.enabled ? 'Sound on' : 'Sound off'); });
$('#rulesBtn').addEventListener('click', showRules);
$('#footRules').addEventListener('click', showRules);
syncSoundBtn();

// Resume an existing session (refresh / reconnect), else show the requested page.
if (inSession()) { showConnecting(); connect(); } else route();
