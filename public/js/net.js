// Session storage, HTTP API helpers and the realtime WebSocket connection.
//
// The server is authoritative; this module only transports intents ("roll",
// "attack", "start"...) and delivers the server's snapshots to subscribers.

const KEY = 'pb.session';

export const session = {
  get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } },
  set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* ignore */ } },
  clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
};

export async function api(path, body) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  } catch {
    throw Object.assign(new Error('Cannot reach the server. Check your connection.'), { code: 'network' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || 'Request failed'), { code: data.error, status: res.status });
  return data;
}

const handlers = {};
export const net = {
  snap: null,
  offset: 0, // serverTime - clientTime
  status: 'idle', // idle | connecting | open | down
  on(evt, fn) { (handlers[evt] ||= new Set()).add(fn); return () => handlers[evt].delete(fn); },
  emit(evt, data) { (handlers[evt] || []).forEach((f) => { try { f(data); } catch (e) { console.error(e); } }); },
  serverNow() { return Date.now() + this.offset; },
};

let ws = null;
let attempts = 0;
let retryTimer = null;
let wanted = false;
let pingTimer = null;

// Track consecutive bad_token errors to avoid false-positive session expiry
// (a single bad_token on a fresh socket can be a race; two in a row is real)
let badTokenStreak = 0;

function setStatus(s) {
  if (net.status === s) return;
  net.status = s;
  net.emit('conn', s);
}

// Jitter up to 20% of the base delay to avoid reconnect storms when multiple
// clients all lost connection at the same time (e.g. server restart).
function jitter(ms) { return ms + Math.floor(Math.random() * ms * 0.2); }

// Backoff: 400ms, 800ms, 1.2s, 1.6s … capped at 8s (up from 5s to give the
// server more time to restart without hammering it).
function backoffMs() { return jitter(Math.min(8000, 400 * Math.max(1, attempts))); }

export function connect() {
  const s = session.get();
  if (!s || !s.token) return;
  wanted = true;
  clearTimeout(retryTimer);
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  setStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  ws = sock;

  sock.onopen = () => {
    sock.send(JSON.stringify({ type: 'auth', token: s.token }));
  };

  sock.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case 'state':
        attempts = 0;
        badTokenStreak = 0;
        net.offset = m.serverTime - Date.now();
        net.snap = m;
        setStatus('open');
        net.emit('state', m);
        break;
      case 'pong':
        // Server acknowledged ping — connection is healthy.
        badTokenStreak = 0;
        break;
      case 'error':
        if (m.code === 'bad_token') {
          badTokenStreak += 1;
          if (badTokenStreak >= 2) {
            // Two consecutive bad_token errors = genuine session expiry.
            badTokenStreak = 0;
            endSession('expired');
          } else {
            // First bad_token: could be a race (e.g. socket replaced mid-flight).
            // Close this socket; the retry will re-auth cleanly.
            try { sock.close(4001, 'auth retry'); } catch { /* ignore */ }
          }
        } else {
          net.emit('error', m);
        }
        break;
      case 'room_closed': endSession('closed:' + m.reason); break;
      case 'left_room': endSession('left'); break;
      case 'session_replaced': endSession('replaced'); break;
      default: break;
    }
  };

  sock.onclose = (ev) => {
    if (ws === sock) ws = null;
    clearInterval(pingTimer);
    pingTimer = null;
    if (!wanted) { setStatus('idle'); return; }
    // Code 4001 means we self-closed for an auth retry — reconnect quickly.
    const delay = ev.code === 4001 ? jitter(300) : backoffMs();
    setStatus('down');
    attempts += 1;
    retryTimer = setTimeout(connect, delay);
  };

  sock.onerror = () => {};

  // Client pings every 25s.  The server heartbeat is every 30s (see index.js),
  // so the server always sees at least one pong before it checks isAlive.
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'ping' }));
  }, 25_000);
}

export function send(type, payload = {}) {
  if (!ws || ws.readyState !== 1) { net.emit('error', { code: 'offline', message: 'Not connected. Reconnecting…' }); return false; }
  ws.send(JSON.stringify({ type, ...payload }));
  return true;
}

/** Leave the session locally (does not tell the server; send('leave') first for that). */
export function endSession(reason) {
  wanted = false;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  pingTimer = null;
  badTokenStreak = 0;
  session.clear();
  net.snap = null;
  try { ws && ws.close(); } catch { /* ignore */ }
  ws = null;
  setStatus('idle');
  net.emit('ended', reason);
}

export function startSession({ token, playerId, roomName }) {
  session.set({ token, playerId, roomName: roomName || null });
  attempts = 0;
  badTokenStreak = 0;
  connect();
}

// ── Reconnect triggers ────────────────────────────────────────────────────────
// Reconnect immediately when the tab becomes visible again (browser wakes up
// from background / phone screen-on) or the device comes back online.

function reconnectIfNeeded() {
  if (wanted && (!ws || ws.readyState === 2 || ws.readyState === 3)) {
    clearTimeout(retryTimer);
    attempts = 0; // reset backoff so it tries immediately
    connect();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') reconnectIfNeeded();
});

window.addEventListener('online', () => reconnectIfNeeded());

// ── Page freeze / unload: keep the socket alive when navigating within the SPA.
// Don't close it on pagehide unless the session is already ended.
window.addEventListener('pagehide', () => {
  // Only close pings/timers, not the socket itself — the browser will keep it
  // alive if the page is in the BFCache.
  clearInterval(pingTimer);
  pingTimer = null;
});

window.addEventListener('pageshow', (ev) => {
  if (ev.persisted) {
    // Restored from BFCache: restart the ping loop and sync state.
    reconnectIfNeeded();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'sync' }));
  }
});
