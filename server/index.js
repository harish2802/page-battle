// HTTP + WebSocket server for Page Battle.
//
//   node server/index.js
//
// Serves the static frontend from /public, a small JSON API under /api, and a
// WebSocket endpoint at /ws for realtime play.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { config as defaultConfig } from './config.js';
import { openDb } from './db.js';
import { Hub, HubError } from './hub.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(data);
}

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HubError('too_large', 'Request too large', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const txt = Buffer.concat(chunks).toString('utf8');
        resolveBody(txt ? JSON.parse(txt) : {});
      } catch {
        reject(new HubError('bad_json', 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Tiny fixed-window rate limiter keyed by IP. */
function makeLimiter(perMin) {
  const hits = new Map();
  const timer = setInterval(() => hits.clear(), 60_000);
  timer.unref?.();
  return (key) => {
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    return n <= perMin;
  };
}

export function createApp(overrides = {}) {
  const config = { ...defaultConfig, ...overrides };
  const store = openDb(config.dbPath);
  const hub = new Hub({ config, store });
  const allow = makeLimiter(config.rateLimitPerMin);

  const clientIp = (req) => (config.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';

  async function api(req, res, url) {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, rooms: hub.rooms.size });
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed', message: 'Use POST' });
    if (!allow(clientIp(req))) return json(res, 429, { error: 'rate_limited', message: 'Too many requests. Slow down.' });
    const body = await readBody(req);
    let out;
    switch (url.pathname) {
      case '/api/rooms': out = await hub.createRoom(body); break;
      case '/api/rooms/join': out = await hub.joinRoom(body); break;
      case '/api/rooms/rejoin': out = await hub.rejoinRoom(body); break;
      case '/api/bots': out = await hub.createBotMatch(body); break;
      default: return json(res, 404, { error: 'not_found', message: 'Unknown endpoint' });
    }
    return json(res, 200, out);
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY_HEADERS);
      return res.end();
    }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { rel = '/'; }
    let file = normalize(join(PUBLIC_DIR, rel));
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
      res.writeHead(403, SECURITY_HEADERS);
      return res.end();
    }
    try {
      let st = await stat(file);
      if (st.isDirectory()) { file = join(file, 'index.html'); st = await stat(file); }
    } catch {
      // Unknown path without an extension -> SPA entry; with an extension -> 404.
      if (extname(rel)) {
        res.writeHead(404, SECURITY_HEADERS);
        return res.end('Not found');
      }
      file = join(PUBLIC_DIR, 'index.html');
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return await serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HubError) return json(res, e.status || 400, { error: e.code, message: e.message });
      console.error('[http]', e);
      return json(res, 500, { error: 'server_error', message: 'Something went wrong' });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Auth must be the first message (keeps tokens out of URLs and access logs).
    const authTimer = setTimeout(() => ws.close(4002, 'auth timeout'), 5000);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return hub.send(ws, { type: 'error', code: 'bad_json', message: 'Invalid message' }); }
      if (!msg || typeof msg !== 'object') return;
      try {
        if (!ws.playerId) {
          if (msg.type !== 'auth') throw new HubError('unauthenticated', 'Authenticate first');
          clearTimeout(authTimer);
          hub.attach(ws, msg.token);
          return;
        }
        // Per-socket flood guard (default 30 messages/second). Tell the client instead of dropping silently.
        const now = Date.now();
        ws.win = ws.win && now - ws.win.t < 1000 ? ws.win : { t: now, n: 0 };
        if (++ws.win.n > config.wsMessagesPerSec) throw new HubError('rate_limited', 'Too many messages. Slow down.');
        hub.handleMessage(ws, msg);
      } catch (e) {
        if (e instanceof HubError) {
          hub.send(ws, { type: 'error', code: e.code, message: e.message, action: msg.type });
          if (!ws.playerId) ws.close(4003, e.code);
        } else {
          console.error('[ws]', e);
          hub.send(ws, { type: 'error', code: 'server_error', message: 'Something went wrong', action: msg.type });
        }
      }
    });
    ws.on('close', () => { clearTimeout(authTimer); hub.detach(ws); });
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 15_000);
  heartbeat.unref?.();

  hub.start();

  return {
    server, hub, store, config,
    listen: (port = config.port, host = config.host) => new Promise((ok) => server.listen(port, host, () => ok(server.address()))),
    close: () => new Promise((ok) => {
      clearInterval(heartbeat);
      hub.stop();
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => server.close(() => { try { store.db.close(); } catch { /* ignore */ } ok(); }));
    }),
  };
}

// Run directly: node server/index.js
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen().then((addr) => {
    console.log(`Page Battle listening on http://${addr.address}:${addr.port}  (db: ${app.config.dbPath})`);
  });
  const shutdown = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
