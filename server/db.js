// SQLite persistence (Node's built-in node:sqlite - no native build step).
//
// Normalised tables model rooms / players / digit slots / matches / events.
// matches.state_json additionally holds the full engine snapshot so a running
// match can be restored exactly after a server restart.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DIGITS } from './engine.js';

// Ordered migrations. Never edit an applied migration; append a new one.
const MIGRATIONS = [
  `
  CREATE TABLE rooms (
    id            TEXT PRIMARY KEY,
    code          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    mode          TEXT NOT NULL CHECK (mode IN ('friends','bots')),
    pass_salt     TEXT,
    pass_hash     TEXT,
    host_player_id TEXT,
    max_players   INTEGER NOT NULL,
    player_count  INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL CHECK (status IN ('lobby','playing','finished','closed')),
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL
  );
  CREATE INDEX idx_rooms_status ON rooms(status);
  CREATE INDEX idx_rooms_name ON rooms(name COLLATE NOCASE);

  CREATE TABLE players (
    id            TEXT PRIMARY KEY,
    room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    color         TEXT NOT NULL,
    type          TEXT NOT NULL CHECK (type IN ('human','bot')),
    style         TEXT,
    token_hash    TEXT,
    connected     INTEGER NOT NULL DEFAULT 0,
    disconnected_at INTEGER,
    eliminated    INTEGER NOT NULL DEFAULT 0,
    eliminated_reason TEXT,
    turn_position INTEGER,
    join_order    INTEGER NOT NULL
  );
  CREATE INDEX idx_players_room ON players(room_id);
  CREATE INDEX idx_players_token ON players(token_hash);

  CREATE TABLE matches (
    id            TEXT PRIMARY KEY,
    room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    game_mode     TEXT NOT NULL,
    status        TEXT NOT NULL,
    current_round INTEGER NOT NULL DEFAULT 1,
    current_player_id TEXT,
    turn_order    TEXT NOT NULL,
    winner_id     TEXT,
    turn_ready_at INTEGER NOT NULL DEFAULT 0,
    state_json    TEXT NOT NULL,
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER
  );
  CREATE INDEX idx_matches_room ON matches(room_id);

  CREATE TABLE digit_slots (
    match_id      TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    player_id     TEXT NOT NULL,
    digit         INTEGER NOT NULL CHECK (digit IN (0,2,4,6,8)),
    stage         INTEGER NOT NULL CHECK (stage BETWEEN 0 AND 4),
    has_bullet    INTEGER NOT NULL DEFAULT 0,
    eliminated    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (match_id, player_id, digit)
  );

  CREATE TABLE game_events (
    match_id      TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    type          TEXT NOT NULL,
    round         INTEGER NOT NULL,
    data          TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (match_id, seq)
  );
  `,
];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return new Store(db);
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  let current = row && row.v ? row.v : 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export class Store {
  constructor(db) {
    this.db = db;
    this.q = {
      upsertRoom: db.prepare(`
        INSERT INTO rooms (id, code, name, mode, pass_salt, pass_hash, host_player_id, max_players, player_count, status, created_at, expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET host_player_id=excluded.host_player_id, player_count=excluded.player_count,
          status=excluded.status, expires_at=excluded.expires_at`),
      upsertPlayer: db.prepare(`
        INSERT INTO players (id, room_id, name, color, type, style, token_hash, connected, disconnected_at, eliminated, eliminated_reason, turn_position, join_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color, token_hash=excluded.token_hash,
          connected=excluded.connected, disconnected_at=excluded.disconnected_at, eliminated=excluded.eliminated,
          eliminated_reason=excluded.eliminated_reason, turn_position=excluded.turn_position`),
      deletePlayer: db.prepare('DELETE FROM players WHERE id = ?'),
      upsertMatch: db.prepare(`
        INSERT INTO matches (id, room_id, game_mode, status, current_round, current_player_id, turn_order, winner_id, turn_ready_at, state_json, started_at, finished_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, current_round=excluded.current_round,
          current_player_id=excluded.current_player_id, winner_id=excluded.winner_id, turn_ready_at=excluded.turn_ready_at,
          state_json=excluded.state_json, finished_at=excluded.finished_at`),
      upsertSlot: db.prepare(`
        INSERT INTO digit_slots (match_id, player_id, digit, stage, has_bullet, eliminated) VALUES (?,?,?,?,?,?)
        ON CONFLICT(match_id, player_id, digit) DO UPDATE SET stage=excluded.stage, has_bullet=excluded.has_bullet, eliminated=excluded.eliminated`),
      insertEvent: db.prepare('INSERT OR IGNORE INTO game_events (match_id, seq, type, round, data, created_at) VALUES (?,?,?,?,?,?)'),
      deleteRoom: db.prepare('DELETE FROM rooms WHERE id = ?'),
      activeRooms: db.prepare("SELECT * FROM rooms WHERE status IN ('lobby','playing','finished')"),
      roomPlayers: db.prepare('SELECT * FROM players WHERE room_id = ? ORDER BY join_order'),
      roomMatch: db.prepare('SELECT * FROM matches WHERE room_id = ? ORDER BY started_at DESC LIMIT 1'),
      events: db.prepare('SELECT seq, type, round, data FROM game_events WHERE match_id = ? ORDER BY seq'),
      removeMatchesForRoom: db.prepare('DELETE FROM matches WHERE room_id = ?'),
    };
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Persist a room, its members and (if present) the current match, atomically. */
  saveRoom(room) {
    const now = Date.now();
    this.transaction(() => {
      this.q.upsertRoom.run(
        room.id, room.code, room.name, room.mode, room.passSalt, room.passHash,
        room.hostId, room.maxPlayers, room.members.length, room.status, room.createdAt, room.expiresAt,
      );
      const order = room.match ? room.match.order : [];
      room.members.forEach((m, i) => {
        const mp = room.match ? room.match.players.find((p) => p.id === m.id) : null;
        this.q.upsertPlayer.run(
          m.id, room.id, m.name, m.color, m.type, m.style || null, m.tokenHash || null,
          m.connected ? 1 : 0, m.disconnectedAt || null, mp && mp.eliminated ? 1 : 0,
          mp ? mp.eliminatedReason : null, order.includes(m.id) ? order.indexOf(m.id) : null, i,
        );
      });
      if (room.match) {
        const s = room.match;
        this.q.upsertMatch.run(
          room.matchId, room.id, room.mode, s.status, s.round, s.status === 'finished' ? null : s.order[s.turnIndex],
          JSON.stringify(s.order), s.winnerId, room.turnReadyAt || 0, JSON.stringify(s), room.matchStartedAt,
          s.status === 'finished' ? now : null,
        );
        for (const p of s.players) {
          for (const d of DIGITS) {
            const sl = p.slots[d];
            this.q.upsertSlot.run(room.matchId, p.id, d, sl.stage, sl.stage === 4 ? 1 : 0, sl.eliminated ? 1 : 0);
          }
        }
        for (const ev of s.events) {
          if (ev.seq > room.persistedSeq) {
            const { seq, type, round, ...rest } = ev;
            this.q.insertEvent.run(room.matchId, seq, type, round, JSON.stringify(rest), now);
          }
        }
        room.persistedSeq = s.nextSeq - 1;
      }
    });
  }

  removePlayer(id) {
    this.q.deletePlayer.run(id);
  }

  deleteRoom(id) {
    this.q.deleteRoom.run(id);
  }

  /** Clear persisted match data for a room (used when a room returns to its lobby for a rematch). */
  clearMatches(roomId) {
    this.q.removeMatchesForRoom.run(roomId);
  }

  loadRooms() {
    return this.q.activeRooms.all().map((r) => ({
      row: r,
      players: this.q.roomPlayers.all(r.id),
      match: this.q.roomMatch.get(r.id) || null,
    }));
  }
}
