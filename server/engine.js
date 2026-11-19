// Page Battle game engine.
//
// Pure, deterministic-given-an-RNG rules. No I/O, no timers, no networking.
// Every mutation goes through the functions exported here, so bot matches and
// online matches share exactly the same authoritative rules.

import { randomInt } from 'node:crypto';

export const DIGITS = [0, 2, 4, 6, 8];

// Slot development stages.
export const STAGE = Object.freeze({ EMPTY: 0, HEAD: 1, BODY: 2, GUN: 3, BULLET: 4 });
export const STAGE_NAMES = ['EMPTY', 'HEAD', 'BODY', 'GUN', 'BULLET'];

export const PHASE = Object.freeze({
  AWAIT_ROLL: 'await_roll',
  AWAIT_ATTACK: 'await_attack',
  FINISHED: 'finished',
});

export const PLAYER_COLORS = [
  { name: 'Cobalt', hex: '#2563EB' },
  { name: 'Crimson', hex: '#DC2626' },
  { name: 'Forest', hex: '#16A34A' },
  { name: 'Amber', hex: '#D97706' },
  { name: 'Violet', hex: '#7C3AED' },
  { name: 'Teal', hex: '#0D9488' },
  { name: 'Magenta', hex: '#C026D3' },
  { name: 'Brown', hex: '#92400E' },
  { name: 'Slate', hex: '#475569' },
  { name: 'Lime', hex: '#65A30D' },
  { name: 'Rose', hex: '#E11D48' },
  { name: 'Sky', hex: '#0284C7' },
];

export const MAX_PLAYERS_HARD_LIMIT = PLAYER_COLORS.length;

export class GameError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** Unbiased random even page number in [2, 100]: 50 equally likely outcomes. */
export function randomPage(rng = randomInt) {
  return rng(1, 51) * 2; // randomInt(1,51) is uniform over 1..50
}

export function digitOf(page) {
  return page % 10;
}

export function shuffle(arr, rng = randomInt) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newSlots() {
  const slots = {};
  for (const d of DIGITS) slots[d] = { stage: STAGE.EMPTY, eliminated: false };
  return slots;
}

/**
 * Create a match.
 * @param {{id:string,name:string,type:'human'|'bot',style?:string}[]} players
 */
export function createMatch(players, { rng = randomInt } = {}) {
  if (players.length < 2) throw new GameError('not_enough_players', 'At least two players are required');
  if (players.length > MAX_PLAYERS_HARD_LIMIT) throw new GameError('too_many_players');
  const order = shuffle(players.map((p) => p.id), rng);
  const state = {
    status: 'playing',
    phase: PHASE.AWAIT_ROLL,
    round: 1,
    turnIndex: 0,
    order,
    players: players.map((p, i) => ({
      id: p.id,
      name: p.name,
      type: p.type || 'human',
      style: p.style || null,
      color: p.color || PLAYER_COLORS[i % PLAYER_COLORS.length].hex,
      colorName: p.colorName || PLAYER_COLORS[i % PLAYER_COLORS.length].name,
      eliminated: false,
      eliminatedReason: null,
      eliminatedAtRound: null,
      kills: 0, // slots destroyed by this player
      knockouts: 0, // players knocked out by this player
      slots: newSlots(),
    })),
    pending: null, // { playerId, digit, page } while AWAIT_ATTACK
    lastRoll: null,
    winnerId: null,
    nextSeq: 1,
    events: [],
  };
  pushEvent(state, 'match_started', { order });
  return state;
}

export function pushEvent(state, type, data = {}) {
  const ev = { seq: state.nextSeq++, type, round: state.round, ...data };
  state.events.push(ev);
  return ev;
}

export function getPlayer(state, id) {
  return state.players.find((p) => p.id === id) || null;
}

export function activeSlots(player) {
  return DIGITS.filter((d) => !player.slots[d].eliminated);
}

export function isPlayerOut(player) {
  return activeSlots(player).length === 0;
}

export function currentPlayerId(state) {
  if (state.status === 'finished') return null;
  return state.order[state.turnIndex];
}

export function alivePlayers(state) {
  return state.players.filter((p) => !p.eliminated);
}

/** Opponents and slots that may legally be attacked by `attackerId`. */
export function validTargets(state, attackerId) {
  return state.players
    .filter((p) => p.id !== attackerId && !p.eliminated)
    .map((p) => ({ playerId: p.id, digits: activeSlots(p) }))
    .filter((t) => t.digits.length > 0);
}

function checkWinner(state) {
  const alive = alivePlayers(state);
  if (alive.length <= 1) {
    state.status = 'finished';
    state.phase = PHASE.FINISHED;
    state.pending = null;
    state.winnerId = alive[0] ? alive[0].id : null;
    pushEvent(state, 'match_finished', { winnerId: state.winnerId });
    return true;
  }
  return false;
}

function advanceTurn(state) {
  if (state.status === 'finished') return;
  const n = state.order.length;
  for (let step = 1; step <= n; step++) {
    const idx = (state.turnIndex + step) % n;
    const p = getPlayer(state, state.order[idx]);
    if (!p.eliminated) {
      if (idx <= state.turnIndex) {
        // wrapped around: a full round has been completed
        state.round += 1;
      }
      state.turnIndex = idx;
      state.phase = PHASE.AWAIT_ROLL;
      state.pending = null;
      pushEvent(state, 'turn_started', { playerId: p.id });
      return;
    }
  }
}

/**
 * Current player generates their page number. Exactly one number per turn.
 * Returns { page, digit, outcome } where outcome is one of:
 *  'dead_slot' | 'head' | 'body' | 'gun' | 'bullet'
 */
export function roll(state, playerId, rng = randomInt) {
  if (state.status === 'finished') throw new GameError('game_over', 'The match is over');
  if (currentPlayerId(state) !== playerId) throw new GameError('not_your_turn', 'It is not your turn');
  if (state.phase !== PHASE.AWAIT_ROLL) throw new GameError('invalid_phase', 'You must resolve your attack first');

  const player = getPlayer(state, playerId);
  const page = randomPage(rng);
  const digit = digitOf(page);
  const slot = player.slots[digit];
  state.lastRoll = { playerId, page, digit };

  if (slot.eliminated) {
    pushEvent(state, 'page_rolled', { playerId, page, digit, outcome: 'dead_slot', stage: slot.stage });
    advanceTurn(state);
    return { page, digit, outcome: 'dead_slot' };
  }

  slot.stage += 1; // EMPTY->HEAD->BODY->GUN->BULLET (GUN is also the "unloaded" state)
  const outcome = STAGE_NAMES[slot.stage].toLowerCase();
  pushEvent(state, 'page_rolled', { playerId, page, digit, outcome, stage: slot.stage });

  if (slot.stage === STAGE.BULLET) {
    // A bullet must be used immediately, this same turn.
    state.phase = PHASE.AWAIT_ATTACK;
    state.pending = { playerId, digit, page };
    pushEvent(state, 'bullet_ready', { playerId, digit });
    return { page, digit, outcome };
  }

  advanceTurn(state);
  return { page, digit, outcome };
}

/** Validate an attack without changing state. Throws GameError when illegal. */
export function validateAttack(state, attackerId, targetId, targetDigit) {
  if (state.status === 'finished') throw new GameError('game_over', 'The match is over');
  if (currentPlayerId(state) !== attackerId) throw new GameError('not_your_turn', 'It is not your turn');
  if (state.phase !== PHASE.AWAIT_ATTACK || !state.pending || state.pending.playerId !== attackerId) {
    throw new GameError('no_bullet', 'You have no bullet to fire');
  }
  if (targetId === attackerId) throw new GameError('self_attack', 'You cannot attack yourself');
  const target = getPlayer(state, targetId);
  if (!target) throw new GameError('invalid_target', 'Unknown target player');
  if (target.eliminated) throw new GameError('target_eliminated', 'That player is already out');
  if (!Number.isInteger(targetDigit) || !DIGITS.includes(targetDigit)) {
    throw new GameError('invalid_slot', 'Invalid digit slot');
  }
  if (target.slots[targetDigit].eliminated) throw new GameError('slot_eliminated', 'That slot is already eliminated');
}

/**
 * Fire the pending bullet. Eliminates exactly one slot. The attacker's weapon
 * remains (Head/Body/Gun); only the bullet is consumed.
 * Invalid attacks throw and change nothing (the bullet is NOT consumed).
 */
export function attack(state, attackerId, targetId, targetDigit) {
  validateAttack(state, attackerId, targetId, targetDigit);
  const attacker = getPlayer(state, attackerId);
  const target = getPlayer(state, targetId);
  const fromDigit = state.pending.digit;

  target.slots[targetDigit].eliminated = true;
  attacker.slots[fromDigit].stage = STAGE.GUN; // bullet consumed, weapon intact
  attacker.kills += 1;
  state.pending = null;

  const result = { attackerId, targetId, targetDigit, fromDigit, playerEliminated: false, matchFinished: false };
  pushEvent(state, 'slot_eliminated', { attackerId, targetId, targetDigit, fromDigit });

  if (isPlayerOut(target)) {
    target.eliminated = true;
    target.eliminatedReason = 'slots';
    target.eliminatedAtRound = state.round;
    attacker.knockouts += 1;
    result.playerEliminated = true;
    pushEvent(state, 'player_eliminated', { playerId: targetId, byId: attackerId, reason: 'slots' });
  }

  if (checkWinner(state)) {
    result.matchFinished = true;
  } else {
    advanceTurn(state);
  }
  return result;
}

/**
 * Remove a player from the match (e.g. reconnect timeout). Their slots are all
 * lost, any pending bullet is cancelled, and the turn moves on if needed.
 */
export function forfeitPlayer(state, playerId, reason = 'disconnected') {
  if (state.status === 'finished') return { changed: false };
  const p = getPlayer(state, playerId);
  if (!p || p.eliminated) return { changed: false };

  const wasCurrent = currentPlayerId(state) === playerId;
  for (const d of DIGITS) p.slots[d].eliminated = true;
  p.eliminated = true;
  p.eliminatedReason = reason;
  p.eliminatedAtRound = state.round;
  if (state.pending && state.pending.playerId === playerId) state.pending = null;
  pushEvent(state, 'player_eliminated', { playerId, byId: null, reason });

  if (checkWinner(state)) return { changed: true, matchFinished: true };
  if (wasCurrent) advanceTurn(state);
  return { changed: true, matchFinished: false };
}

/** Final stats shown on the winner screen. */
export function matchSummary(state) {
  const winner = state.winnerId ? getPlayer(state, state.winnerId) : null;
  return {
    winnerId: state.winnerId,
    winnerName: winner ? winner.name : null,
    totalEliminations: winner ? winner.knockouts : 0,
    remainingSlots: winner ? activeSlots(winner).length : 0,
    totalRounds: state.round,
    standings: standings(state),
  };
}

/** Winner first, then by elimination order (later elimination ranks higher). */
export function standings(state) {
  const alive = state.players.filter((p) => !p.eliminated);
  const out = state.players
    .filter((p) => p.eliminated)
    .map((p) => ({ p, seq: eliminationSeq(state, p.id) }))
    .sort((a, b) => b.seq - a.seq)
    .map((x) => x.p);
  return [...alive, ...out].map((p, i) => ({ rank: i + 1, playerId: p.id, name: p.name, color: p.color, kills: p.kills }));
}

function eliminationSeq(state, playerId) {
  const ev = state.events.find((e) => e.type === 'player_eliminated' && e.playerId === playerId);
  return ev ? ev.seq : 0;
}
