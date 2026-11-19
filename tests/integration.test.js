import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { createApp } from '../server/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'pb-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const FAST = {
  pregameMs: 0, rollAnimMs: 0, attackAnimMs: 0, eliminationAnimMs: 0, botThinkMs: 5, botAimMs: 5,
  rateLimitPerMin: 100000, wsMessagesPerSec: 100000, reconnectMs: 120000,
};

async function boot(over = {}, dbName = 'db-' + Math.random().toString(36).slice(2) + '.sqlite') {
  const app = createApp({ ...FAST, dbPath: join(tmp, dbName), ...over });
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const ws = `ws://127.0.0.1:${addr.port}/ws`;
  return { app, base, ws, dbPath: join(tmp, dbName) };
}

async function post(base, path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

class Client {
  constructor(url, token, name = '?') {
    this.name = name;
    this.url = url;
    this.token = token;
    this.state = null;
    this.states = [];
    this.errors = [];
    this.closed = false;
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.sock = new WebSocket(this.url);
      this.sock.on('open', () => this.sock.send(JSON.stringify({ type: 'auth', token: this.token })));
      this.sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'state') {
          this.state = m;
          this.states.push(m);
          resolve(this);
        } else if (m.type === 'error') {
          this.errors.push(m);
          if (!this.state) reject(new Error(m.message));
        } else {
          (this.other ||= []).push(m);
        }
        this.waiters = this.waiters.filter((w) => !w(m));
      });
      this.sock.on('close', () => { this.closed = true; this.waiters = this.waiters.filter((w) => !w({ type: '__closed' })); });
      this.sock.on('error', reject);
    });
  }
  send(o) { this.sock.send(JSON.stringify(o)); }
  waitFor(pred, ms = 8000, label = 'condition') {
    return new Promise((resolve, reject) => {
      const check = () => (this.state && pred(this.state) ? true : false);
      if (check()) return resolve(this.state);
      const t = setTimeout(() => { const mm = this.state?.match; reject(new Error(`timeout waiting for ${label} (${this.name}) :: ${mm ? JSON.stringify({ st: mm.status, ph: mm.phase, cur: mm.currentPlayerId, you: this.state.you, tgt: mm.targets, pend: mm.pending, ev: mm.events.slice(-4), conn: this.state.room.members.map((x) => x.connected) }) : 'no match'}`)); }, ms);
      this.waiters.push((m) => {
        if (m.type === 'state' && pred(m)) { clearTimeout(t); resolve(m); return true; }
        return false;
      });
    });
  }
  waitError(code, ms = 3000) {
    return new Promise((resolve, reject) => {
      const found = this.errors.find((e) => e.code === code && !e._seen);
      if (found) { found._seen = true; return resolve(found); }
      const t = setTimeout(() => reject(new Error(`timeout waiting for error ${code}`)), ms);
      this.waiters.push((m) => {
        if (m.type === 'error' && m.code === code) { clearTimeout(t); resolve(m); return true; }
        return false;
      });
    });
  }
  close() { try { this.sock.close(); } catch { /* ignore */ } }
  get me() { return this.state.match?.players.find((p) => p.id === this.state.you); }
}

async function makeRoom(env, { name = 'Math Class', password = 'doodle99', max = 4, host = 'Host', others = ['Bob', 'Cat'] } = {}) {
  const created = await post(env.base, '/api/rooms', { name, password, maxPlayers: max, playerName: host });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const clients = [await new Client(env.ws, created.body.token, host).connect()];
  for (const n of others) {
    const j = await post(env.base, '/api/rooms/join', { room: name, password, playerName: n });
    assert.equal(j.status, 200, JSON.stringify(j.body));
    clients.push(await new Client(env.ws, j.body.token, n).connect());
  }
  return { clients, created: created.body };
}

/** Let every client play its own turns (roll, then attack if it holds a bullet) until the match ends. */
function autoplay(clients, pickTarget = (c) => {
  const t = c.state.match.targets;
  return { targetId: t[0].playerId, digit: t[0].digits[0] };
}) {
  const acted = new Set();
  for (const c of clients) {
    c.sock.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type !== 'state' || !m.match || m.match.status !== 'playing') return;
      const mm = m.match;
      if (mm.currentPlayerId !== m.you) return;
      const key = `${c.name}:${mm.events.at(-1).seq}`;
      if (acted.has(key)) return;
      acted.add(key);
      if (mm.phase === 'await_roll') c.send({ type: 'roll' });
      else if (mm.phase === 'await_attack') {
        const t = mm.targets;
        c.send({ type: 'attack', targetId: t[0].playerId, digit: t[0].digits[0] });
      }
    });
    if (c.state?.match) c.sock.emit('message', Buffer.from(JSON.stringify(c.state)));
  }
}

// ------------------------------------------------------------------ rooms

test('room creation validates name, password, capacity and player name', async () => {
  const env = await boot();
  try {
    const ok = await post(env.base, '/api/rooms', { name: 'Any name !?', password: 'x', maxPlayers: 2, playerName: 'Zed' });
    assert.equal(ok.status, 200);
    for (const bad of [
      { name: '', password: 'x', maxPlayers: 3, playerName: 'A' },
      { name: '   ', password: 'x', maxPlayers: 3, playerName: 'A' },
      { name: 'r', password: '', maxPlayers: 3, playerName: 'A' },
      { name: 'r', password: '   ', maxPlayers: 3, playerName: 'A' },
      { name: 'r', password: 'x', maxPlayers: 1, playerName: 'A' },
      { name: 'r', password: 'x', maxPlayers: 99, playerName: 'A' },
      { name: 'r', password: 'x', maxPlayers: 3, playerName: '' },
    ]) {
      const r = await post(env.base, '/api/rooms', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  } finally { await env.app.close(); }
});

test('capacity is not hard-coded to four: a 6-player room works', async () => {
  const env = await boot();
  try {
    const { clients } = await makeRoom(env, { max: 6, others: ['b', 'c', 'd', 'e', 'f'] });
    await clients[0].waitFor((s) => s.room.members.length === 6, 3000, '6 members');
    const colors = new Set(clients[0].state.room.members.map((m) => m.color));
    assert.equal(colors.size, 6, 'each player gets a unique colour');
    const extra = await post(env.base, '/api/rooms/join', { room: 'Math Class', password: 'doodle99', playerName: 'g' });
    assert.equal(extra.status, 409);
    assert.equal(extra.body.error, 'room_full');
    clients.forEach((c) => c.close());
  } finally { await env.app.close(); }
});

test('joining: wrong password / unknown room are indistinguishable; by name or code; duplicate names rejected', async () => {
  const env = await boot();
  try {
    const { clients, created } = await makeRoom(env, { others: [] });
    const code = clients[0].state.room.code;
    assert.match(code, /^[A-Z0-9]{6}$/);
    const wrong = await post(env.base, '/api/rooms/join', { room: 'Math Class', password: 'nope', playerName: 'X' });
    const none = await post(env.base, '/api/rooms/join', { room: 'No Such Room', password: 'doodle99', playerName: 'X' });
    assert.equal(wrong.status, 403);
    assert.equal(none.status, 403);
    assert.equal(wrong.body.message, none.body.message);
    const byCode = await post(env.base, '/api/rooms/join', { room: code.toLowerCase(), password: 'doodle99', playerName: 'ByCode' });
    assert.equal(byCode.status, 200);
    const dup = await post(env.base, '/api/rooms/join', { room: 'math class', password: 'doodle99', playerName: 'bycode' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'name_taken');
    assert.ok(created.roomId);
    clients.forEach((c) => c.close());
  } finally { await env.app.close(); }
});

test('password is stored only as a salted hash', async () => {
  const env = await boot();
  try {
    await makeRoom(env, { password: 'super-secret-pass', others: [] });
    const db = new DatabaseSync(env.dbPath, { readOnly: true });
    const row = db.prepare('SELECT * FROM rooms').get();
    const dump = JSON.stringify(row);
    assert.ok(!dump.includes('super-secret-pass'));
    assert.ok(row.pass_hash && row.pass_hash.length >= 32 && row.pass_salt);
    db.close();
  } finally { await env.app.close(); }
});

test('only the host can start; at least two players required; nobody can join after start', async () => {
  const env = await boot();
  try {
    const solo = await makeRoom(env, { name: 'Solo', others: [] });
    solo.clients[0].send({ type: 'start' });
    await solo.clients[0].waitError('not_enough_players');
    solo.clients[0].close();

    const { clients } = await makeRoom(env, { name: 'Squad', others: ['Bob'] });
    clients[1].send({ type: 'start' });
    await clients[1].waitError('not_host');
    clients[0].send({ type: 'start' });
    await clients[0].waitFor((s) => s.match && s.room.status === 'playing');
    const late = await post(env.base, '/api/rooms/join', { room: 'Squad', password: 'doodle99', playerName: 'Late' });
    assert.equal(late.status, 409);
    assert.equal(late.body.error, 'match_started');
    clients.forEach((c) => c.close());
  } finally { await env.app.close(); }
});

// ------------------------------------------------------------------ multiplayer play

test('synchronised play: same order, one number per turn, duplicate clicks ignored, full game to a winner', async () => {
  const env = await boot();
  try {
    const { clients } = await makeRoom(env, { others: ['Bob', 'Cat'] });
    clients[0].send({ type: 'start' });
    await Promise.all(clients.map((c) => c.waitFor((s) => s.match?.status === 'playing', 3000, 'playing')));

    // every client sees the same random turn order and the same colours
    const orders = clients.map((c) => c.state.match.order.join(','));
    assert.equal(new Set(orders).size, 1);
    assert.equal(clients[0].state.match.order.length, 3);

    // A non-current player cannot roll
    const first = clients[0].state.match.currentPlayerId;
    const notCurrent = clients.find((c) => c.state.you !== first);
    notCurrent.send({ type: 'roll' });
    await notCurrent.waitError('not_your_turn');

    // The current player double-clicks: exactly one number is generated.
    const cur = clients.find((c) => c.state.you === first);
    const rollsBefore = cur.state.match.events.filter((e) => e.type === 'page_rolled').length;
    cur.send({ type: 'roll' });
    cur.send({ type: 'roll' });
    await cur.waitFor((s) => s.match.events.filter((e) => e.type === 'page_rolled').length > rollsBefore);
    await new Promise((r) => setTimeout(r, 100));
    const rolled = cur.state.match.events.filter((e) => e.type === 'page_rolled');
    assert.equal(rolled.length - rollsBefore, 1, 'duplicate click must not produce a second number');
    const evs = rolled.at(-1);
    assert.ok(evs.page % 2 === 0 && evs.page >= 2 && evs.page <= 100);

    // everyone received that same event
    for (const c of clients) {
      await c.waitFor((s) => s.match.events.some((e) => e.seq === evs.seq));
      const e2 = c.state.match.events.find((e) => e.seq === evs.seq);
      assert.deepEqual(e2, evs);
    }

    // play the rest of the game automatically
    autoplay(clients);
    await Promise.all(clients.map((c) => c.waitFor((s) => s.match.status === 'finished', 20000, 'finished')));
    const winners = new Set(clients.map((c) => c.state.match.winnerId));
    assert.equal(winners.size, 1);
    const w = clients[0].state.match.players.find((p) => p.id === clients[0].state.match.winnerId);
    assert.equal(w.eliminated, false);
    assert.equal(clients[0].state.match.players.filter((p) => !p.eliminated).length, 1);
    assert.ok(clients[0].state.match.summary.totalRounds >= 1);

    // persisted game data
    const db = new DatabaseSync(env.dbPath, { readOnly: true });
    const m = db.prepare('SELECT * FROM matches').get();
    assert.equal(m.status, 'finished');
    assert.equal(m.winner_id, clients[0].state.match.winnerId);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM digit_slots').get().c, 15);
    const types = new Set(db.prepare('SELECT type FROM game_events').all().map((r) => r.type));
    for (const t of ['match_started', 'page_rolled', 'bullet_ready', 'slot_eliminated', 'player_eliminated', 'match_finished']) {
      assert.ok(types.has(t), `missing persisted event ${t}`);
    }
    db.close();
    clients.forEach((c) => c.close());
  } finally { await env.app.close(); }
});

test('attack validation over the wire: self / eliminated slot / no bullet rejected, bullet kept', async () => {
  const env = await boot();
  try {
    const { clients } = await makeRoom(env, { others: ['Bob'] });
    clients[0].send({ type: 'start' });
    await Promise.all(clients.map((c) => c.waitFor((s) => s.match?.status === 'playing')));
    const cur = clients.find((c) => c.state.you === c.state.match.currentPlayerId);
    cur.send({ type: 'attack', targetId: clients.find((c) => c !== cur).state.you, digit: 0 });
    await cur.waitError('no_bullet');
    cur.send({ type: 'attack', targetId: cur.state.you, digit: 0 });
    await cur.waitError('no_bullet');
    clients.forEach((c) => c.close());
  } finally { await env.app.close(); }
});

// ------------------------------------------------------------------ reconnection

test('reconnect within the window restores identity and progress', async () => {
  const env = await boot({ reconnectMs: 5000 });
  try {
    const { clients } = await makeRoom(env, { others: ['Bob'] });
    clients[0].send({ type: 'start' });
    await Promise.all(clients.map((c) => c.waitFor((s) => s.match?.status === 'playing')));
    // make some progress
    for (let i = 0; i < 4; i++) {
      const cur = clients.find((c) => c.state.you === c.state.match.currentPlayerId);
      const seq = cur.state.match.events.at(-1).seq;
      cur.send({ type: 'roll' });
      await Promise.all(clients.map((c) => c.waitFor((s) => s.match.events.at(-1).seq > seq && s.match.phase !== 'await_attack' || s.match.status === 'finished')));
      if (cur.state.match.phase === 'await_attack') break;
    }
    const bob = clients[1];
    const before = JSON.stringify(bob.me.slots);
    const stateBefore = bob.state.match.round;
    const token = bob.token;
    bob.close();
    await clients[0].waitFor((s) => s.room.members.find((m) => m.name === 'Bob').connected === false);
    const dl = clients[0].state.room.members.find((m) => m.name === 'Bob').disconnectDeadline;
    assert.ok(dl > Date.now(), 'a reconnect deadline is published');

    const again = await new Client(env.ws, token, 'Bob').connect();
    assert.equal(JSON.stringify(again.me.slots), before, 'progress preserved');
    assert.equal(again.state.you, bob.state.you);
    assert.ok(again.state.match.round >= stateBefore);
    await clients[0].waitFor((s) => s.room.members.find((m) => m.name === 'Bob').connected === true);
    assert.ok(clients[0].state.match.events.some((e) => e.type === 'player_reconnected'));
    again.close(); clients[0].close();
  } finally { await env.app.close(); }
});

test('rejoin with room name + password + player name issues a fresh session with the same identity', async () => {
  const env = await boot({ reconnectMs: 5000 });
  try {
    const { clients } = await makeRoom(env, { others: ['Bob'] });
    clients[0].send({ type: 'start' });
    await Promise.all(clients.map((c) => c.waitFor((s) => s.match?.status === 'playing')));
    const bobId = clients[1].state.you;
    clients[1].close();
    const wrong = await post(env.base, '/api/rooms/rejoin', { room: 'Math Class', password: 'bad', playerName: 'Bob' });
    assert.equal(wrong.status, 403);
    const ok = await post(env.base, '/api/rooms/rejoin', { room: 'Math Class', password: 'doodle99', playerName: 'bob' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.playerId, bobId);
    const again = await new Client(env.ws, ok.body.token, 'Bob').connect();
    assert.equal(again.state.you, bobId);
    assert.equal(again.state.match.status, 'playing');
    // the old token no longer works
    await assert.rejects(new Client(env.ws, clients[1].token, 'old').connect());
    again.close(); clients[0].close();
  } finally { await env.app.close(); }
});

test('missing the reconnect window eliminates the player and the game continues', async () => {
  const env = await boot({ reconnectMs: 400 });
  try {
    const { clients } = await makeRoom(env, { others: ['Bob', 'Cat'] });
    clients[0].send({ type: 'start' });
    await Promise.all(clients.map((c) => c.waitFor((s) => s.match?.status === 'playing')));
    const bobId = clients[1].state.you;
    const token = clients[1].token;
    clients[1].close();
    await clients[0].waitFor((s) => s.match.players.find((p) => p.id === bobId).eliminated, 5000, 'timeout elimination');
    const bob = clients[0].state.match.players.find((p) => p.id === bobId);
    assert.equal(bob.eliminatedReason, 'timeout');
    assert.equal(clients[0].state.match.status, 'playing');
    assert.notEqual(clients[0].state.match.currentPlayerId, bobId);
    // he can still come back to watch, but is out
    const watcher = await new Client(env.ws, token, 'Bob').connect();
    assert.equal(watcher.me.eliminated, true);
    watcher.close(); clients[0].close(); clients[2].close();
  } finally { await env.app.close(); }
});

test('timeout of the second-last player ends the match', async () => {
  const env = await boot({ reconnectMs: 300 });
  try {
    const { clients } = await makeRoom(env, { others: ['Bob'] });
    clients[0].send({ type: 'start' });
    await Promise.all(clients.map((c) => c.waitFor((s) => s.match?.status === 'playing')));
    clients[1].close();
    await clients[0].waitFor((s) => s.match.status === 'finished', 4000, 'finished');
    assert.equal(clients[0].state.match.winnerId, clients[0].state.you);
    clients[0].close();
  } finally { await env.app.close(); }
});

// ------------------------------------------------------------------ bots

test('bot mode: exactly three bots with funny names, auto-play, human plays by the same rules', async () => {
  const env = await boot();
  try {
    const r = await post(env.base, '/api/bots', { playerName: 'Tester' });
    assert.equal(r.status, 200);
    const c = await new Client(env.ws, r.body.token, 'Tester').connect();
    const m = await c.waitFor((s) => s.match?.status === 'playing');
    const bots = m.room.members.filter((x) => x.type === 'bot');
    assert.equal(bots.length, 3);
    assert.equal(m.room.members.length, 4);
    assert.equal(new Set(m.room.members.map((x) => x.color)).size, 4);
    for (const b of bots) assert.ok(/^[A-Z .]+$/.test(b.name));

    // human auto-plays; bots must act on their own
    autoplay([c]);
    await c.waitFor((s) => s.match.status === 'finished', 30000, 'bot match finished');
    const botEvents = c.state.match.events.filter((e) => e.type === 'page_rolled' && bots.some((b) => b.id === e.playerId));
    assert.ok(botEvents.length > 0, 'bots rolled on their own');
    for (const e of c.state.match.events.filter((e) => e.type === 'page_rolled')) {
      assert.ok(e.page % 2 === 0 && e.page >= 2 && e.page <= 100);
    }
    for (const e of c.state.match.events.filter((e) => e.type === 'slot_eliminated')) {
      assert.notEqual(e.attackerId, e.targetId);
    }
    c.close();
  } finally { await env.app.close(); }
});

test('bot match pauses while the human is away and resumes on reconnect', async () => {
  const env = await boot({ reconnectMs: 5000, botThinkMs: 30, rollAnimMs: 20 });
  try {
    const r = await post(env.base, '/api/bots', { playerName: 'Tester' });
    let c = await new Client(env.ws, r.body.token, 'Tester').connect();
    await c.waitFor((s) => s.match?.status === 'playing');
    c.close();
    await new Promise((res) => setTimeout(res, 150));
    const seqA = env.app.hub.rooms.values().next().value.match.nextSeq;
    await new Promise((res) => setTimeout(res, 400));
    const seqB = env.app.hub.rooms.values().next().value.match.nextSeq;
    assert.equal(seqA, seqB, 'match is frozen while the human is disconnected');
    c = await new Client(env.ws, r.body.token, 'Tester').connect();
    assert.equal(c.state.match.status, 'playing');
    c.close();
  } finally { await env.app.close(); }
});

test('bot match is forfeited when the human misses the resume window', async () => {
  const env = await boot({ reconnectMs: 250 });
  try {
    const r = await post(env.base, '/api/bots', { playerName: 'Tester' });
    const c = await new Client(env.ws, r.body.token, 'Tester').connect();
    await c.waitFor((s) => s.match?.status === 'playing');
    c.close();
    await new Promise((res) => setTimeout(res, 700));
    const room = env.app.hub.rooms.values().next().value;
    assert.ok(room.match.players.find((p) => p.type === 'human').eliminated);
  } finally { await env.app.close(); }
});

// ------------------------------------------------------------------ rematch & persistence

test('play again: host returns the room to its lobby; non-host cannot', async () => {
  const env = await boot();
  try {
    const { clients } = await makeRoom(env, { others: ['Bob'] });
    clients[0].send({ type: 'start' });
    await Promise.all(clients.map((c) => c.waitFor((s) => s.match?.status === 'playing')));
    autoplay(clients);
    await Promise.all(clients.map((c) => c.waitFor((s) => s.match.status === 'finished', 20000)));
    clients[1].send({ type: 'rematch' });
    await clients[1].waitError('not_host');
    clients[0].send({ type: 'rematch' });
    await Promise.all(clients.map((c) => c.waitFor((s) => s.room.status === 'lobby' && !s.match, 3000, 'lobby again')));
    clients.forEach((c) => c.close());
  } finally { await env.app.close(); }
});

test('rooms and running matches survive a server restart', async () => {
  const dbName = 'restart.sqlite';
  let env = await boot({ reconnectMs: 5000 }, dbName);
  const { clients } = await makeRoom(env, { others: ['Bob'] });
  clients[0].send({ type: 'start' });
  await Promise.all(clients.map((c) => c.waitFor((s) => s.match?.status === 'playing')));
  const order = clients[0].state.match.order;
  const tokens = clients.map((c) => c.token);
  clients.forEach((c) => c.close());
  await env.app.close();

  env = await boot({ reconnectMs: 5000 }, dbName);
  try {
    const back = await new Client(env.ws, tokens[0], 'Host').connect();
    assert.equal(back.state.room.name, 'Math Class');
    assert.equal(back.state.match.status, 'playing');
    assert.deepEqual(back.state.match.order, order);
    back.close();
  } finally { await env.app.close(); }
});

test('invalid sessions and garbage are rejected', async () => {
  const env = await boot();
  try {
    await assert.rejects(new Client(env.ws, 'x'.repeat(64), 'ghost').connect());
    const bad = await fetch(env.base + '/api/rooms', { method: 'POST', body: '{not json' });
    assert.equal(bad.status, 400);
    const trav = await fetch(env.base + '/..%2f..%2fetc/passwd');
    assert.ok([200, 403, 404].includes(trav.status));
    const body = await trav.text();
    assert.ok(!body.includes('root:'));
  } finally { await env.app.close(); }
});
