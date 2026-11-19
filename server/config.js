// Central configuration. All values come from environment variables (see .env.example).

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${name}: ${v}`);
  return n;
}

export const config = {
  port: int('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DATABASE_PATH || 'data/page-battle.sqlite',
  // Reconnection window (spec: two minutes).
  reconnectMs: int('RECONNECT_MS', 120_000),
  roomTtlMs: int('ROOM_TTL_HOURS', 24) * 3600_000,
  finishedRoomTtlMs: int('FINISHED_ROOM_TTL_MINUTES', 30) * 60_000,
  // Pacing so every client can finish its animations before the next action.
  pregameMs: int('PREGAME_MS', 6000),
  rollAnimMs: int('ROLL_ANIM_MS', 2600),
  attackAnimMs: int('ATTACK_ANIM_MS', 3800),
  eliminationAnimMs: int('ELIMINATION_ANIM_MS', 1800),
  botThinkMs: int('BOT_THINK_MS', 1200),
  botAimMs: int('BOT_AIM_MS', 2800),
  maxPlayersLimit: 12,
  rateLimitPerMin: int("RATE_LIMIT_PER_MIN", 40),
  wsMessagesPerSec: int('WS_MESSAGES_PER_SEC', 30),
  // Set TRUST_PROXY=1 when behind a reverse proxy so rate limits use X-Forwarded-For.
  trustProxy: process.env.TRUST_PROXY === "1",
};
