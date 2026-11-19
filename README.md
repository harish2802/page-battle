# Page Battle

Turn-based multiplayer elimination game played on a notebook. Flip random even pages (2–100),
grow a stickman in each of your five digit slots (0·2·4·6·8) from **Head → Body → Gun → Bullet**,
fire every bullet at once, and be the last player with a live slot.

* **Play with Bots** – you vs. three bots that follow exactly the same rules.
* **Play with Friends** – private rooms (name + mandatory password, host-chosen capacity 2–12).

## Architecture

| Piece | Where | Notes |
|---|---|---|
| Game engine | `server/engine.js` | Pure rules, no I/O. The only place rules live. |
| Bots | `server/bots.js` | Only *choose a target*; rolls/attacks go through the same engine calls as humans. |
| Hub | `server/hub.js` | Rooms, sessions, turn pacing, bot scheduling, 2-minute reconnect timers, realtime fan-out. |
| Persistence | `server/db.js` | SQLite (`node:sqlite`) with ordered migrations: rooms, players, matches, digit_slots, game_events. |
| HTTP/WS | `server/index.js` | Static files, `POST /api/*`, WebSocket `/ws`. |
| Client | `public/` | Stitch UI (Home, Game Modes, Room Setup) + Lobby, Pre-game, Arena, Attack picker, Winner. |

Security model: the server is authoritative (random pages come from `crypto.randomInt`; clients only send
`roll` / `attack` intents). Passwords are salted scrypt hashes. Session tokens are random 256-bit values
stored only as SHA-256 hashes server-side; the socket authenticates with its first message so tokens never
appear in URLs. Wrong room and wrong password give the same error. Game actions run synchronously on a single
thread, so duplicate clicks / racing requests fail engine validation instead of double-applying.

## Requirements

Node.js **22.13+** (uses the built-in `node:sqlite`; no native modules to compile).

## Run locally

```bash
npm install
npm run build:css      # compiles Tailwind from the Stitch design tokens (output is committed too)
npm start              # http://localhost:3000
npm test               # 47 tests: engine rules + real HTTP/WebSocket integration
```

Configuration is via environment variables – see `.env.example`
(`node --env-file=.env server/index.js` loads a `.env` file). Nothing secret is required.

### Database setup

None by hand. On first start the server creates `DATABASE_PATH` (default `data/page-battle.sqlite`) and applies
migrations (`schema_version` table). To change the schema, **append** a new entry to `MIGRATIONS` in
`server/db.js`; never edit an applied one. Running matches and rooms are restored after a restart, and everyone
gets a fresh two-minute reconnect window.

## Deploy

The app is one Node process with a WebSocket endpoint and a SQLite file. It needs a host that supports
long-lived WebSocket connections and a **persistent disk** for the database.

**Docker**
```bash
docker build -t page-battle .
docker run -p 3000:3000 -v pagebattle-data:/data page-battle
```

**Any VPS / PaaS (Render, Fly.io, Railway, …)**: Node 22 runtime, build command `npm ci`, start command
`npm start`, mount a persistent volume and point `DATABASE_PATH` at it, set `TRUST_PROXY=1` when behind a
proxy. Terminate TLS at the proxy (the client uses `wss://` automatically on https pages) and make sure it
forwards WebSocket upgrades and keeps idle connections open >30 s.

**Scaling note:** live game state is held in memory by one process (SQLite is the durable copy), so run a
single instance. Horizontal scaling would need a shared store and sticky routing – out of scope here.

## Gameplay rules implemented

Even page 2–100 uniformly (50 outcomes) → last digit picks the slot; slot grows Head→Body→Gun→Bullet independently;
a bullet must be fired in the same turn at a live slot of a live opponent (no self-attacks); firing consumes the
bullet only (weapon stays; next matching digit reloads it and you must fire again); destroyed slots are permanent
and ignore their digit; all five slots gone = player out; last player standing wins. Random turn order, eliminated
players are skipped. Disconnect = 2-minute window to rejoin (room name/code + password + your name, or just reload
the page), after which the player is eliminated; bot matches pause while you are away and use the same window.

## Known limits

* Sound effects are synthesised with Web Audio (no audio files); they start after the first click/tap, as browsers require.
* Display names are capped at 24 characters (layout safety); room names/passwords have no arbitrary limits beyond 200/1000 characters.
* No accounts: a seat is claimed with the room credentials + your player name.
