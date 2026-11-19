// Hub: rooms, sessions, realtime fan-out, bot scheduling, reconnect timers.
//
// Node runs this on a single thread and every engine call + DB write inside a
// message handler is synchronous, so each game action is atomic with respect to
// every other action. Duplicate clicks / racing requests simply fail engine
// validation (not_your_turn / invalid_phase) without changing any state.

import { randomBytes, randomUUID, scrypt, createHash, timingSafeEqual, randomInt } from 'node:crypto';
import { promisify } from 'node:util';
import {
  createMatch, roll, attack, forfeitPlayer, validTargets, matchSummary, pushEvent,
  currentPlayerId, PLAYER_COLORS, GameError, PHASE,
} from './engine.js';
import { chooseBotAttack, pickBotRoster } from './bots.js';

const scryptAsync = promisify(scrypt);

export class HubError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const key = await scryptAsync(password, salt, 32);
  return { salt, hash: key.toString('hex') };
}

async function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const key = await scryptAsync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return s;
}

// Control characters and angle brackets never belong in a display name.
// Length is capped only to keep the UI layout safe.
function cleanName(raw, field = 'Name', max = 24) {
  if (typeof raw !== 'string') throw new HubError('invalid_name', `${field} is required`);
  const s = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().replace(/\s+/g, ' ');
  if (!s) throw new HubError('invalid_name', `${field} is required`);
  if (s.length > max) throw new HubError('invalid_name', `${field} must be at most ${max} characters`);
  return s;
}

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

export class Hub {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.rooms = new Map(); // roomId -> room
    this.sockets = new Map(); // playerId -> Set<ws>
    this.cleanupTimer = null;
  }

  // ------------------------------------------------------------------ lifecycle

  start() {
    this.restore();
    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
    this.cleanupTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.cleanupTimer);
    for (const room of this.rooms.values()) this.clearTimers(room);
  }

  /** Rebuild in-memory rooms from the database after a restart. */
  restore() {
    const now = this.now();
    for (const { row, players, match } of this.store.loadRooms()) {
      const room = {
        id: row.id, code: row.code, name: row.name, mode: row.mode,
        passSalt: row.pass_salt, passHash: row.pass_hash, hostId: row.host_player_id,
        maxPlayers: row.max_players, status: row.status, createdAt: row.created_at,
        expiresAt: row.expires_at, members: [], match: null, matchId: null, matchStartedAt: 0,
        persistedSeq: 0, turnReadyAt: 0, timers: { bot: null, disc: new Map() },
      };
      room.members = players.map((p) => ({
        id: p.id, name: p.name, color: p.color, colorName: colorName(p.color), type: p.type, style: p.style,
        tokenHash: p.token_hash, connected: p.type === 'bot', disconnectedAt: null, ready: false,
      }));
      if (match) {
        room.match = JSON.parse(match.state_json);
        room.matchId = match.id;
        room.matchStartedAt = match.started_at;
        room.persistedSeq = room.match.nextSeq - 1;
        room.turnReadyAt = now + 2000;
      }
      this.rooms.set(room.id, room);
      if (room.status === 'finished') continue;
      // After a restart nobody is connected: everyone gets a fresh reconnect window.
      for (const m of room.members) if (m.type === 'human') this.markDisconnected(room, m, true);
    }
  }

  cleanup() {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (room.expiresAt <= now) this.closeRoom(room, 'expired');
    }
  }

  clearTimers(room) {
    clearTimeout(room.timers.bot);
    room.timers.bot = null;
    for (const t of room.timers.disc.values()) clearTimeout(t);
    room.timers.disc.clear();
  }

  closeRoom(room, reason = 'closed') {
    this.clearTimers(room);
    this.rooms.delete(room.id);
    this.store.deleteRoom(room.id);
    for (const m of room.members) {
      for (const ws of this.sockets.get(m.id) || []) {
        this.send(ws, { type: 'room_closed', reason });
        ws.roomId = null;
      }
      this.sockets.delete(m.id);
    }
  }

  touch(room) {
    const ttl = room.status === 'finished' ? this.config.finishedRoomTtlMs : this.config.roomTtlMs;
    room.expiresAt = this.now() + ttl;
  }

  save(room) {
    if (this.stopped) return;
    this.touch(room);
    this.store.saveRoom(room);
  }

  // ------------------------------------------------------------------ HTTP-level operations

  newMember({ name, type = 'human', style = null, room }) {
    const used = new Set(room.members.map((m) => m.color));
    const c = PLAYER_COLORS.find((x) => !used.has(x.hex)) || PLAYER_COLORS[room.members.length % PLAYER_COLORS.length];
    const token = type === 'human' ? randomBytes(32).toString('hex') : null;
    const member = {
      id: randomUUID(), name, color: c.hex, colorName: c.name, type, style,
      tokenHash: token ? sha256(token) : null, connected: type === 'bot', disconnectedAt: null, ready: false,
    };
    return { member, token };
  }

  async createRoom({ name, password, maxPlayers, playerName }) {
    if (typeof name !== 'string' || !name.trim()) throw new HubError('invalid_room_name', 'Room name is required');
    if (name.length > 200) throw new HubError('invalid_room_name', 'Room name is too long');
    if (typeof password !== 'string' || !password.trim()) throw new HubError('invalid_password', 'Room password is required');
    if (password.length > 1000) throw new HubError('invalid_password', 'Password is too long');
    const max = Number(maxPlayers);
    if (!Number.isInteger(max) || max < 2 || max > this.config.maxPlayersLimit) {
      throw new HubError('invalid_capacity', `Maximum players must be between 2 and ${this.config.maxPlayersLimit}`);
    }
    const pname = cleanName(playerName, 'Player name');
    const { salt, hash } = await hashPassword(password);

    let code;
    do code = makeCode(); while ([...this.rooms.values()].some((r) => r.code === code));
    const now = this.now();
    const room = {
      id: randomUUID(), code, name: name.trim(), mode: 'friends', passSalt: salt, passHash: hash, hostId: null,
      maxPlayers: max, status: 'lobby', createdAt: now, expiresAt: now + this.config.roomTtlMs,
      members: [], match: null, matchId: null, matchStartedAt: 0, persistedSeq: 0, turnReadyAt: 0,
      timers: { bot: null, disc: new Map() },
    };
    const { member, token } = this.newMember({ name: pname, room });
    member.ready = true;
    room.members.push(member);
    room.hostId = member.id;
    this.rooms.set(room.id, room);
    this.save(room);
    return { token, playerId: member.id, roomId: room.id };
  }

  /** Find rooms whose code or name matches and whose password verifies. */
  async findRoom(query, password) {
    if (typeof query !== 'string' || !query.trim() || typeof password !== 'string' || !password) {
      throw new HubError('bad_credentials', 'Room and password are required');
    }
    const q = query.trim();
    const candidates = [...this.rooms.values()].filter(
      (r) => r.mode === 'friends' && r.status !== 'closed' && (r.code === q.toUpperCase() || sameName(r.name, q)),
    );
    // Prefer lobbies, then newest.
    candidates.sort((a, b) => (a.status === 'lobby' ? 0 : 1) - (b.status === 'lobby' ? 0 : 1) || b.createdAt - a.createdAt);
    for (const room of candidates) {
      if (await verifyPassword(password, room.passSalt, room.passHash)) return room;
    }
    // Same message whether the room exists or not: do not leak which rooms exist.
    throw new HubError('bad_credentials', 'Room not found or wrong password', 403);
  }

  async joinRoom({ room: query, password, playerName }) {
    const pname = cleanName(playerName, 'Player name');
    const room = await this.findRoom(query, password);
    // Re-check after the async hash: state may have changed meanwhile.
    if (room.status !== 'lobby' || this.rooms.get(room.id) !== room) {
      throw new HubError('match_started', 'This match has already started. No new players can join.', 409);
    }
    if (room.members.length >= room.maxPlayers) throw new HubError('room_full', 'This room is full', 409);
    if (room.members.some((m) => sameName(m.name, pname))) {
      throw new HubError('name_taken', 'That name is already taken in this room', 409);
    }
    const { member, token } = this.newMember({ name: pname, room });
    room.members.push(member);
    this.save(room);
    this.broadcast(room);
    return { token, playerId: member.id, roomId: room.id };
  }

  /** Re-claim an existing seat with room name/code + password + player name. */
  async rejoinRoom({ room: query, password, playerName }) {
    const pname = cleanName(playerName, 'Player name');
    const room = await this.findRoom(query, password);
    if (this.rooms.get(room.id) !== room) throw new HubError('bad_credentials', 'Room not found or wrong password', 403);
    const member = room.members.find((m) => m.type === 'human' && sameName(m.name, pname));
    if (!member) {
      throw new HubError('not_in_room', 'No player with that name is in this room', 404);
    }
    if (room.match && room.match.players.find((p) => p.id === member.id)?.eliminated) {
      throw new HubError('eliminated', 'You were eliminated from this match', 409);
    }
    const token = randomBytes(32).toString('hex');
    member.tokenHash = sha256(token);
    // Kick any stale connection that still holds this seat.
    for (const ws of this.sockets.get(member.id) || []) {
      this.send(ws, { type: 'session_replaced' });
      try { ws.close(4001, 'session replaced'); } catch { /* ignore */ }
    }
    this.save(room);
    return { token, playerId: member.id, roomId: room.id };
  }

  async createBotMatch({ playerName }) {
    const pname = cleanName(playerName, 'Player name');
    const now = this.now();
    const room = {
      id: randomUUID(), code: makeCode(), name: 'Bot Match', mode: 'bots', passSalt: null, passHash: null, hostId: null,
      maxPlayers: 4, status: 'lobby', createdAt: now, expiresAt: now + this.config.roomTtlMs,
      members: [], match: null, matchId: null, matchStartedAt: 0, persistedSeq: 0, turnReadyAt: 0,
      timers: { bot: null, disc: new Map() },
    };
    const { member, token } = this.newMember({ name: pname, room });
    member.ready = true;
    room.members.push(member);
    room.hostId = member.id;
    this.fillBots(room);
    this.rooms.set(room.id, room);
    this.startMatch(room);
    return { token, playerId: member.id, roomId: room.id };
  }

  fillBots(room) {
    room.members = room.members.filter((m) => m.type === 'human');
    const humanNames = room.members.map((m) => m.name);
    for (const b of pickBotRoster(randomInt, 3, humanNames)) {
      const { member } = this.newMember({ name: b.name, type: 'bot', style: b.style, room });
      member.ready = true;
      room.members.push(member);
    }
  }

  // ------------------------------------------------------------------ sockets

  /** Authenticate a socket from its session token. */
  attach(ws, token) {
    if (typeof token !== 'string' || token.length < 16) throw new HubError('bad_token', 'Invalid session');
    const h = sha256(token);
    for (const room of this.rooms.values()) {
      const member = room.members.find((m) => m.type === 'human' && m.tokenHash === h);
      if (!member) continue;
      ws.playerId = member.id;
      ws.roomId = room.id;
      if (!this.sockets.has(member.id)) this.sockets.set(member.id, new Set());
      this.sockets.get(member.id).add(ws);
      if (!member.connected) this.markReconnected(room, member);
      else this.sendState(ws, room);
      return;
    }
    throw new HubError('bad_token', 'Session expired');
  }

  detach(ws) {
    if (this.stopped || !ws.playerId) return;
    const set = this.sockets.get(ws.playerId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.sockets.delete(ws.playerId);
    }
    const room = this.rooms.get(ws.roomId);
    if (!room || (this.sockets.get(ws.playerId)?.size || 0) > 0) return;
    const member = room.members.find((m) => m.id === ws.playerId);
    if (member && member.connected) this.markDisconnected(room, member);
  }

  markDisconnected(room, member, silent = false) {
    member.connected = false;
    member.disconnectedAt = this.now();
    clearTimeout(room.timers.disc.get(member.id));
    const inMatch = room.match && room.status === 'playing';
    if (inMatch && !silent) pushEvent(room.match, 'player_disconnected', { playerId: member.id });
    const timer = setTimeout(() => this.expireMember(room.id, member.id), this.config.reconnectMs);
    timer.unref?.();
    room.timers.disc.set(member.id, timer);
    this.save(room);
    this.broadcast(room);
    this.scheduleBots(room); // bot matches pause while the human is away
  }

  markReconnected(room, member) {
    const wasAway = member.disconnectedAt != null;
    member.connected = true;
    member.disconnectedAt = null;
    clearTimeout(room.timers.disc.get(member.id));
    room.timers.disc.delete(member.id);
    if (wasAway && room.match && room.status === 'playing') pushEvent(room.match, 'player_reconnected', { playerId: member.id });
    this.save(room);
    this.broadcast(room);
    this.scheduleBots(room);
  }

  /** The two-minute reconnect window ran out. */
  expireMember(roomId, memberId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const member = room.members.find((m) => m.id === memberId);
    if (!member || member.connected) return;
    room.timers.disc.delete(memberId);
    this.removeOrForfeit(room, member, 'timeout');
  }

  removeOrForfeit(room, member, reason) {
    if (room.status === 'lobby') {
      this.removeFromLobby(room, member);
      return;
    }
    if (room.status === 'playing') {
      const res = forfeitPlayer(room.match, member.id, reason);
      if (res.changed) this.afterAction(room, { forfeited: true, matchFinished: res.matchFinished });
    }
  }

  removeFromLobby(room, member) {
    room.members = room.members.filter((m) => m.id !== member.id);
    clearTimeout(room.timers.disc.get(member.id));
    room.timers.disc.delete(member.id);
    this.store.removePlayer(member.id);
    for (const ws of this.sockets.get(member.id) || []) {
      this.send(ws, { type: 'left_room' });
      ws.roomId = null;
      ws.playerId = null;
    }
    this.sockets.delete(member.id);
    const humans = room.members.filter((m) => m.type === 'human');
    if (humans.length === 0) {
      this.closeRoom(room, 'empty');
      return;
    }
    if (room.hostId === member.id) {
      room.hostId = humans[0].id;
      humans[0].ready = true;
    }
    this.save(room);
    this.broadcast(room);
  }

  // ------------------------------------------------------------------ messages

  handleMessage(ws, msg) {
    const room = this.rooms.get(ws.roomId);
    if (!room || !ws.playerId) throw new HubError('no_session', 'Not in a room');
    const me = room.members.find((m) => m.id === ws.playerId);
    if (!me) throw new HubError('no_session', 'Not in a room');

    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong', serverTime: this.now() });
        return;
      case 'sync':
        this.sendState(ws, room);
        return;
      case 'ready': {
        if (room.status !== 'lobby') return;
        if (me.id !== room.hostId) me.ready = !!msg.ready;
        this.broadcast(room);
        return;
      }
      case 'start': {
        if (room.mode !== 'friends') throw new HubError('invalid', 'Bot matches start automatically');
        if (me.id !== room.hostId) throw new HubError('not_host', 'Only the host can start the match');
        if (room.status !== 'lobby') throw new HubError('invalid_state', 'The match has already started');
        if (room.members.length < 2) throw new HubError('not_enough_players', 'At least two players are needed');
        this.startMatch(room);
        return;
      }
      case 'roll': {
        this.performRoll(room, me.id);
        return;
      }
      case 'attack': {
        this.performAttack(room, me.id, msg.targetId, msg.digit);
        return;
      }
      case 'rematch': {
        this.rematch(room, me);
        return;
      }
      case 'leave': {
        this.leave(room, me);
        return;
      }
      default:
        throw new HubError('unknown_message', 'Unknown message');
    }
  }

  leave(room, member) {
    if (room.status === 'lobby') {
      this.removeFromLobby(room, member);
      return;
    }
    if (room.status === 'playing') {
      // Explicit leave: forfeit immediately (no reconnect window).
      for (const ws of this.sockets.get(member.id) || []) {
        this.send(ws, { type: 'left_room' });
        ws.roomId = null;
      }
      this.sockets.delete(member.id);
      member.tokenHash = null;
      member.connected = false;
      this.removeOrForfeit(room, member, 'left');
      // A bot match with no human left has nothing to show: drop it.
      if (room.mode === 'bots') this.closeRoom(room, 'left');
      return;
    }
    // finished: just detach this member
    for (const ws of this.sockets.get(member.id) || []) {
      this.send(ws, { type: 'left_room' });
      ws.roomId = null;
    }
    this.sockets.delete(member.id);
    member.tokenHash = null;
    member.connected = false;
    if (![...room.members].some((m) => m.type === 'human' && m.connected)) this.closeRoom(room, 'empty');
    else this.broadcast(room);
  }

  rematch(room, me) {
    if (room.status !== 'finished') throw new HubError('invalid_state', 'The match is not over yet');
    if (me.id !== room.hostId) throw new HubError('not_host', 'Only the host can start a new match');
    this.store.clearMatches(room.id);
    room.match = null;
    room.matchId = null;
    room.persistedSeq = 0;
    room.turnReadyAt = 0;
    this.clearTimers(room);
    // Drop humans who left / are no longer reachable.
    room.members = room.members.filter((m) => m.type === 'bot' || m.tokenHash);
    for (const m of room.members) if (m.type === 'human') m.ready = m.id === room.hostId;
    if (room.mode === 'bots') {
      for (const m of room.members) if (m.type === 'bot') this.store.removePlayer(m.id);
      this.fillBots(room);
      room.status = 'lobby';
      this.startMatch(room);
      return;
    }
    room.status = 'lobby';
    this.save(room);
    this.broadcast(room);
  }

  startMatch(room) {
    const players = room.members.map((m) => ({
      id: m.id, name: m.name, type: m.type, style: m.style, color: m.color, colorName: m.colorName,
    }));
    room.match = createMatch(players);
    room.matchId = randomUUID();
    room.matchStartedAt = this.now();
    room.persistedSeq = 0;
    room.status = 'playing';
    room.turnReadyAt = this.now() + this.config.pregameMs;
    this.save(room);
    this.broadcast(room);
    this.scheduleBots(room);
  }

  // ------------------------------------------------------------------ gameplay (humans and bots share these)

  performRoll(room, playerId) {
    if (room.status !== 'playing') throw new HubError('invalid_state', 'The match is not running');
    if (this.now() < room.turnReadyAt) throw new HubError('too_early', 'Wait for the animations to finish');
    const result = this.guard(() => roll(room.match, playerId));
    const delay = this.config.rollAnimMs;
    room.turnReadyAt = this.now() + delay;
    this.afterAction(room, { roll: result });
  }

  performAttack(room, playerId, targetId, digit) {
    if (room.status !== 'playing') throw new HubError('invalid_state', 'The match is not running');
    const res = this.guard(() => attack(room.match, playerId, targetId, digit));
    let delay = this.config.attackAnimMs;
    if (res.playerEliminated) delay += this.config.eliminationAnimMs;
    room.turnReadyAt = this.now() + delay;
    this.afterAction(room, { attack: res });
  }

  guard(fn) {
    try {
      return fn();
    } catch (e) {
      if (e instanceof GameError) throw new HubError(e.code, e.message);
      throw e;
    }
  }

  afterAction(room, info = {}) {
    const m = room.match;
    if (m.status === 'finished') {
      room.status = 'finished';
      clearTimeout(room.timers.bot);
      room.timers.bot = null;
      for (const t of room.timers.disc.values()) clearTimeout(t);
      room.timers.disc.clear();
    } else if (info.forfeited) {
      room.turnReadyAt = Math.max(room.turnReadyAt, this.now() + this.config.eliminationAnimMs);
    }
    this.save(room);
    this.broadcast(room);
    this.scheduleBots(room);
  }

  // ------------------------------------------------------------------ bots

  humanAway(room) {
    return room.members.some((m) => m.type === 'human' && !m.connected && room.match
      && !room.match.players.find((p) => p.id === m.id)?.eliminated);
  }

  scheduleBots(room) {
    clearTimeout(room.timers.bot);
    room.timers.bot = null;
    if (this.stopped) return;
    if (room.status !== 'playing' || !room.match || room.match.status !== 'playing') return;
    if (room.mode === 'bots' && this.humanAway(room)) return; // paused until the human returns
    const cur = currentPlayerId(room.match);
    const member = room.members.find((m) => m.id === cur);
    if (!member || member.type !== 'bot') return;

    let delay;
    let action;
    if (room.match.phase === PHASE.AWAIT_ROLL) {
      delay = Math.max(0, room.turnReadyAt - this.now()) + this.config.botThinkMs;
      action = () => this.performRoll(room, cur);
    } else {
      delay = this.config.botAimMs;
      action = () => {
        const choice = chooseBotAttack(room.match, cur);
        if (!choice) throw new HubError('no_targets', 'Bot has no target');
        this.performAttack(room, cur, choice.targetId, choice.targetDigit);
      };
    }
    room.timers.bot = setTimeout(() => {
      room.timers.bot = null;
      try {
        action();
      } catch (e) {
        // Never let a bot error kill the process; retry shortly.
        console.error('[bot]', e.code || '', e.message);
        room.timers.bot = setTimeout(() => this.scheduleBots(room), 1000);
      }
    }, delay);
    room.timers.bot.unref?.();
  }

  // ------------------------------------------------------------------ snapshots

  snapshot(room, playerId) {
    const now = this.now();
    const m = room.match;
    const snap = {
      type: 'state',
      serverTime: now,
      you: playerId,
      room: {
        id: room.id,
        code: room.mode === 'friends' ? room.code : null,
        name: room.name,
        mode: room.mode,
        status: room.status,
        hostId: room.hostId,
        maxPlayers: room.maxPlayers,
        reconnectMs: this.config.reconnectMs,
        members: room.members.map((x) => ({
          id: x.id, name: x.name, color: x.color, colorName: x.colorName, type: x.type,
          connected: x.connected, ready: x.type === 'bot' || x.id === room.hostId || !!x.ready,
          disconnectDeadline: x.disconnectedAt ? x.disconnectedAt + this.config.reconnectMs : null,
        })),
      },
      match: null,
      turnReadyAt: room.turnReadyAt,
    };
    if (m) {
      snap.match = {
        id: room.matchId,
        status: m.status,
        phase: m.phase,
        round: m.round,
        order: m.order,
        currentPlayerId: currentPlayerId(m),
        pending: m.pending,
        lastRoll: m.lastRoll,
        winnerId: m.winnerId,
        startsAt: room.matchStartedAt + this.config.pregameMs,
        players: m.players,
        events: m.events.slice(-120),
        summary: m.status === 'finished' ? matchSummary(m) : null,
        targets: m.pending && m.pending.playerId === playerId ? validTargets(m, playerId) : null,
      };
    }
    return snap;
  }

  send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  sendState(ws, room) {
    this.send(ws, this.snapshot(room, ws.playerId));
  }

  broadcast(room) {
    for (const m of room.members) {
      const set = this.sockets.get(m.id);
      if (!set) continue;
      for (const ws of set) this.sendState(ws, room);
    }
  }
}

function colorName(hex) {
  return PLAYER_COLORS.find((c) => c.hex === hex)?.name || 'Ink';
}
