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

function setStatus(s) {
  if (net.status === s) return;
  net.status = s;
  net.emit('conn', s);
}

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
        net.offset = m.serverTime - Date.now();
        net.snap = m;
        setStatus('open');
        net.emit('state', m);
        break;
      case 'error':
        if (m.code === 'bad_token') { endSession('expired'); } else net.emit('error', m);
        break;
      case 'room_closed': endSession('closed:' + m.reason); break;
      case 'left_room': endSession('left'); break;
      case 'session_replaced': endSession('replaced'); break;
      default: break;
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    clearInterval(pingTimer);
    if (!wanted) { setStatus('idle'); return; }
    setStatus('down');
    attempts += 1;
    retryTimer = setTimeout(connect, Math.min(5000, 400 * attempts));
  };
  sock.onerror = () => {};
  clearInterval(pingTimer);
  pingTimer = setInterval(() => { if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'ping' })); }, 20000);
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
  connect();
}
