import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  randomPage, digitOf, createMatch, roll, attack, forfeitPlayer, validTargets,
  currentPlayerId, getPlayer, activeSlots, STAGE, PHASE, DIGITS, standings, matchSummary,
} from '../server/engine.js';
import { chooseBotAttack, pickBotRoster } from '../server/bots.js';

// ---------- helpers ----------
const P = (id, type = 'human', style) => ({ id, name: id.toUpperCase(), type, style });

/** Deterministic rng returning the queued values in order for roll()'s randomInt(1,51). */
function pageRng(...pages) {
  const q = pages.map((p) => p / 2);
  return (min, max) => {
    assert.equal(min, 1);
    assert.equal(max, 51);
    assert.ok(q.length > 0, 'ran out of scripted pages');
    return q.shift();
  };
}

/** Make a match with a fixed order a,b,c,... regardless of the shuffle. */
function fixedMatch(ids = ['a', 'b', 'c']) {
  const s = createMatch(ids.map((i) => P(i)));
  s.order = [...ids];
  s.turnIndex = 0;
  return s;
}

/** Roll `page` for whoever's turn it is. */
function rollFor(s, page) {
  return roll(s, currentPlayerId(s), pageRng(page));
}

/** Make `id`'s slot `digit` reach BULLET by scripting rolls; others just roll 2/4/... on dead slots avoided. */
function setStage(s, id, digit, stage) {
  getPlayer(s, id).slots[digit].stage = stage;
}

// ---------- number generation ----------
test('randomPage only yields even numbers 2..100 and covers exactly 50 outcomes', () => {
  const seen = new Set();
  for (let i = 0; i < 20000; i++) {
    const n = randomPage();
    assert.ok(Number.isInteger(n));
    assert.ok(n >= 2 && n <= 100, `out of range: ${n}`);
    assert.equal(n % 2, 0, `odd number generated: ${n}`);
    seen.add(n);
  }
  assert.equal(seen.size, 50);
});

test('randomPage is uniform (chi-square over 50 outcomes)', () => {
  const N = 100000;
  const counts = new Map();
  for (let i = 0; i < N; i++) {
    const n = randomPage();
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  const expected = N / 50;
  let chi = 0;
  for (let n = 2; n <= 100; n += 2) chi += ((counts.get(n) || 0) - expected) ** 2 / expected;
  // 49 degrees of freedom: critical value at p=0.001 is ~85.4
  assert.ok(chi < 85.4, `chi-square too large: ${chi}`);
});

test('randomPage maps rng range 1..50 onto 2..100 (edges)', () => {
  assert.equal(randomPage(() => 1), 2);
  assert.equal(randomPage(() => 50), 100);
});

test('digitOf uses only the last digit (100 -> 0)', () => {
  assert.equal(digitOf(20), 0);
  assert.equal(digitOf(42), 2);
  assert.equal(digitOf(64), 4);
  assert.equal(digitOf(86), 6);
  assert.equal(digitOf(98), 8);
  assert.equal(digitOf(100), 0);
});

// ---------- weapon development ----------
test('new players have five empty independent slots 0,2,4,6,8', () => {
  const s = fixedMatch(['a', 'b']);
  for (const p of s.players) {
    assert.deepEqual(Object.keys(p.slots).map(Number), DIGITS);
    for (const d of DIGITS) assert.deepEqual(p.slots[d], { stage: STAGE.EMPTY, eliminated: false });
  }
});

test('slot progresses Empty->Head->Body->Gun->Bullet on repeated same digit', () => {
  const s = fixedMatch(['a', 'b']);
  // a rolls 20, b rolls (dead-end filler 42), a rolls 40 ...
  assert.equal(rollFor(s, 20).outcome, 'head');
  assert.equal(getPlayer(s, 'a').slots[0].stage, STAGE.HEAD);
  rollFor(s, 42); // b
  assert.equal(rollFor(s, 40).outcome, 'body');
  rollFor(s, 42);
  assert.equal(rollFor(s, 30).outcome, 'gun');
  rollFor(s, 42);
  const r = rollFor(s, 50);
  assert.equal(r.outcome, 'bullet');
  assert.equal(getPlayer(s, 'a').slots[0].stage, STAGE.BULLET);
  assert.equal(s.phase, PHASE.AWAIT_ATTACK);
});

test('five slots develop independently', () => {
  const s = fixedMatch(['a', 'b']);
  rollFor(s, 20); rollFor(s, 2);   // a:0 head ; b:2 head
  rollFor(s, 42); rollFor(s, 4);   // a:2 head ; b:4 head
  rollFor(s, 64); rollFor(s, 100); // a:4 head ; b:0 head
  rollFor(s, 20); rollFor(s, 12);  // a:0 body ; b:2 body
  const a = getPlayer(s, 'a');
  assert.equal(a.slots[0].stage, STAGE.BODY);
  assert.equal(a.slots[2].stage, STAGE.HEAD);
  assert.equal(a.slots[4].stage, STAGE.HEAD);
  assert.equal(a.slots[6].stage, STAGE.EMPTY);
  assert.equal(a.slots[8].stage, STAGE.EMPTY);
  const b = getPlayer(s, 'b');
  assert.equal(b.slots[2].stage, STAGE.BODY);
  assert.equal(b.slots[4].stage, STAGE.HEAD);
  assert.equal(b.slots[0].stage, STAGE.HEAD);
});

test('every slot (not only 0) can develop a full weapon', () => {
  for (const digit of DIGITS) {
    const s = fixedMatch(['a', 'b']);
    const page = digit === 0 ? 10 : digit;
    for (let i = 0; i < 3; i++) { rollFor(s, page); rollFor(s, page === 2 ? 4 : 2); }
    // b rolls 2 (or 4) harmlessly; a now holds a gun in `digit`
    assert.equal(getPlayer(s, 'a').slots[digit].stage, STAGE.GUN);
    assert.equal(rollFor(s, page).outcome, 'bullet');
  }
});

test('a roll that hits an eliminated slot makes no progress and ends the turn', () => {
  const s = fixedMatch(['a', 'b']);
  getPlayer(s, 'a').slots[6].eliminated = true;
  const r = rollFor(s, 16);
  assert.equal(r.outcome, 'dead_slot');
  assert.equal(getPlayer(s, 'a').slots[6].stage, STAGE.EMPTY);
  assert.equal(currentPlayerId(s), 'b');
  assert.equal(s.phase, PHASE.AWAIT_ROLL);
});

// ---------- turn rules ----------
test('only the current player may roll; one roll per turn', () => {
  const s = fixedMatch(['a', 'b', 'c']);
  assert.throws(() => roll(s, 'b', pageRng(2)), { code: 'not_your_turn' });
  roll(s, 'a', pageRng(2));
  assert.equal(currentPlayerId(s), 'b');
  // 'a' trying to roll again (duplicate click) is rejected
  assert.throws(() => roll(s, 'a', pageRng(2)), { code: 'not_your_turn' });
  assert.equal(getPlayer(s, 'a').slots[2].stage, STAGE.HEAD); // unchanged, no double progress
});

test('random turn order contains every player exactly once', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const orders = new Set();
  for (let i = 0; i < 200; i++) {
    const s = createMatch(ids.map((x) => P(x)));
    assert.deepEqual([...s.order].sort(), ids);
    orders.add(s.order.join(''));
  }
  assert.ok(orders.size > 1, 'turn order should vary');
});

test('round-robin: round increments after the last player; eliminated players are skipped', () => {
  const s = fixedMatch(['a', 'b', 'c']);
  getPlayer(s, 'b').eliminated = true;
  for (const d of DIGITS) getPlayer(s, 'b').slots[d].eliminated = true;
  assert.equal(s.round, 1);
  rollFor(s, 2); // a -> skips b -> c
  assert.equal(currentPlayerId(s), 'c');
  assert.equal(s.round, 1);
  rollFor(s, 2); // c -> wraps to a
  assert.equal(currentPlayerId(s), 'a');
  assert.equal(s.round, 2);
});

// ---------- bullet / attack / reload ----------
function bulletForA() {
  const s = fixedMatch(['a', 'b', 'c']);
  setStage(s, 'a', 2, STAGE.GUN);
  rollFor(s, 12); // a gets bullet in slot 2
  assert.equal(s.phase, PHASE.AWAIT_ATTACK);
  return s;
}

test('bullet must be used immediately: rolling again is rejected while a bullet is pending', () => {
  const s = bulletForA();
  assert.throws(() => roll(s, 'a', pageRng(2)), { code: 'invalid_phase' });
  assert.equal(currentPlayerId(s), 'a');
});

test('valid attack eliminates exactly one slot, consumes bullet, keeps weapon', () => {
  const s = bulletForA();
  const before = DIGITS.flatMap((d) => [getPlayer(s, 'b').slots[d].eliminated, getPlayer(s, 'c').slots[d].eliminated]);
  const res = attack(s, 'a', 'b', 8);
  assert.equal(res.playerEliminated, false);
  const b = getPlayer(s, 'b');
  assert.equal(b.slots[8].eliminated, true);
  assert.equal(activeSlots(b).length, 4);
  assert.equal(activeSlots(getPlayer(s, 'c')).length, 5);
  // exactly one new eliminated slot in total
  const after = DIGITS.flatMap((d) => [getPlayer(s, 'b').slots[d].eliminated, getPlayer(s, 'c').slots[d].eliminated]);
  assert.equal(after.filter(Boolean).length - before.filter(Boolean).length, 1);
  // attacker's weapon: bullet consumed, gun remains (head/body/gun stay)
  assert.equal(getPlayer(s, 'a').slots[2].stage, STAGE.GUN);
  assert.equal(s.pending, null);
  assert.equal(currentPlayerId(s), 'b');
});

test('bullet reloads immediately on the next matching digit, and must be used at once', () => {
  const s = bulletForA();
  attack(s, 'a', 'b', 8);
  rollFor(s, 2);  // b
  rollFor(s, 4);  // c
  const r = rollFor(s, 32); // a rolls digit 2 again
  assert.equal(r.outcome, 'bullet');
  assert.equal(getPlayer(s, 'a').slots[2].stage, STAGE.BULLET);
  assert.equal(s.phase, PHASE.AWAIT_ATTACK);
  assert.deepEqual(s.pending, { playerId: 'a', digit: 2, page: 32 });
  attack(s, 'a', 'c', 0);
  assert.equal(getPlayer(s, 'a').slots[2].stage, STAGE.GUN);
});

test('self-attack is rejected and does not consume the bullet', () => {
  const s = bulletForA();
  assert.throws(() => attack(s, 'a', 'a', 0), { code: 'self_attack' });
  assert.equal(getPlayer(s, 'a').slots[2].stage, STAGE.BULLET);
  assert.equal(s.phase, PHASE.AWAIT_ATTACK);
});

test('cannot attack an eliminated slot, an eliminated player, an unknown player or invalid digit', () => {
  const s = bulletForA();
  getPlayer(s, 'b').slots[4].eliminated = true;
  assert.throws(() => attack(s, 'a', 'b', 4), { code: 'slot_eliminated' });
  getPlayer(s, 'c').eliminated = true;
  assert.throws(() => attack(s, 'a', 'c', 0), { code: 'target_eliminated' });
  assert.throws(() => attack(s, 'a', 'zzz', 0), { code: 'invalid_target' });
  assert.throws(() => attack(s, 'a', 'b', 3), { code: 'invalid_slot' });
  assert.throws(() => attack(s, 'a', 'b', '0'), { code: 'invalid_slot' });
  assert.equal(getPlayer(s, 'a').slots[2].stage, STAGE.BULLET, 'bullet kept after invalid attacks');
});

test('only the holder of the bullet can attack; no attack without a bullet', () => {
  const s = bulletForA();
  assert.throws(() => attack(s, 'b', 'a', 0), { code: 'not_your_turn' });
  const s2 = fixedMatch(['a', 'b']);
  assert.throws(() => attack(s2, 'a', 'b', 0), { code: 'no_bullet' });
});

test('a duplicate attack (double submit) is rejected', () => {
  const s = bulletForA();
  attack(s, 'a', 'b', 0);
  assert.throws(() => attack(s, 'a', 'b', 2), { code: 'not_your_turn' });
  assert.equal(activeSlots(getPlayer(s, 'b')).length, 4);
});

test('validTargets lists only live opponents and their live slots', () => {
  const s = bulletForA();
  getPlayer(s, 'b').slots[0].eliminated = true;
  const t = validTargets(s, 'a');
  assert.deepEqual(t.map((x) => x.playerId).sort(), ['b', 'c']);
  assert.deepEqual(t.find((x) => x.playerId === 'b').digits, [2, 4, 6, 8]);
});

test('eliminated slot cannot develop even if its digit is rolled (page 20/40/100)', () => {
  const s = fixedMatch(['a', 'b']);
  getPlayer(s, 'b').slots[0].eliminated = true;
  rollFor(s, 20);
  for (const page of [20, 40, 100]) {
    // b rolls 0-digit pages; a rolls a harmless 2
    const out = roll(s, 'b', pageRng(page));
    assert.equal(out.outcome, 'dead_slot');
    assert.equal(getPlayer(s, 'b').slots[0].stage, STAGE.EMPTY);
    rollFor(s, 2);
  }
});

// ---------- player elimination & winning ----------
test('losing 1-4 slots does not eliminate; losing all 5 eliminates immediately', () => {
  const s = fixedMatch(['a', 'b', 'c']);
  const b = getPlayer(s, 'b');
  let res;
  for (const d of [0, 2, 4, 6]) {
    setStage(s, 'a', 2, STAGE.GUN);
    // give a the turn with a bullet
    s.turnIndex = 0; s.phase = PHASE.AWAIT_ROLL;
    roll(s, 'a', pageRng(12));
    res = attack(s, 'a', 'b', d);
    assert.equal(res.playerEliminated, false);
    assert.equal(b.eliminated, false);
  }
  assert.equal(activeSlots(b).length, 1);
  setStage(s, 'a', 2, STAGE.GUN);
  s.turnIndex = 0; s.phase = PHASE.AWAIT_ROLL;
  roll(s, 'a', pageRng(12));
  res = attack(s, 'a', 'b', 8);
  assert.equal(res.playerEliminated, true);
  assert.equal(b.eliminated, true);
  assert.equal(getPlayer(s, 'a').knockouts, 1);
  assert.equal(s.status, 'playing'); // c still alive
});

test('eliminated players never receive another turn', () => {
  const s = fixedMatch(['a', 'b', 'c']);
  getPlayer(s, 'b').eliminated = true;
  for (let i = 0; i < 6; i++) {
    assert.notEqual(currentPlayerId(s), 'b');
    rollFor(s, 2 + 2 * i);
  }
});

test('last surviving player wins; summary reports stats; no more actions allowed', () => {
  const s = fixedMatch(['a', 'b']);
  const b = getPlayer(s, 'b');
  for (const d of [0, 2, 4, 6]) b.slots[d].eliminated = true;
  setStage(s, 'a', 2, STAGE.GUN);
  roll(s, 'a', pageRng(12));
  const res = attack(s, 'a', 'b', 8);
  assert.equal(res.matchFinished, true);
  assert.equal(s.status, 'finished');
  assert.equal(s.winnerId, 'a');
  assert.equal(currentPlayerId(s), null);
  const sum = matchSummary(s);
  assert.equal(sum.winnerName, 'A');
  assert.equal(sum.remainingSlots, 5);
  assert.equal(sum.totalEliminations, 1);
  assert.ok(sum.totalRounds >= 1);
  assert.throws(() => roll(s, 'a', pageRng(2)), { code: 'game_over' });
  assert.deepEqual(standings(s).map((x) => x.playerId), ['a', 'b']);
});

test('forfeit eliminates a player, cancels their pending bullet and moves the turn on', () => {
  const s = bulletForA();
  const r = forfeitPlayer(s, 'a', 'timeout');
  assert.equal(r.changed, true);
  assert.equal(getPlayer(s, 'a').eliminated, true);
  assert.equal(getPlayer(s, 'a').eliminatedReason, 'timeout');
  assert.equal(s.pending, null);
  assert.equal(currentPlayerId(s), 'b');
  assert.equal(s.phase, PHASE.AWAIT_ROLL);
});

test('forfeit of the second-to-last player ends the match with a winner', () => {
  const s = fixedMatch(['a', 'b']);
  forfeitPlayer(s, 'b');
  assert.equal(s.status, 'finished');
  assert.equal(s.winnerId, 'a');
});

test('createMatch requires at least two players', () => {
  assert.throws(() => createMatch([P('a')]), { code: 'not_enough_players' });
});

// ---------- bots ----------
test('bot roster gives distinct funny names', () => {
  const r = pickBotRoster(undefined, 3);
  assert.equal(r.length, 3);
  assert.equal(new Set(r.map((x) => x.name)).size, 3);
});

test('bots only ever choose legal targets (fuzz, all styles)', () => {
  for (const style of ['sniper', 'bully', 'chaotic']) {
    for (let i = 0; i < 300; i++) {
      const s = createMatch([P('h'), P('b1', 'bot', style), P('b2', 'bot', 'chaotic'), P('b3', 'bot', 'bully')]);
      // randomly wreck some slots / players
      for (const p of s.players) {
        for (const d of DIGITS) {
          p.slots[d].stage = Math.floor(Math.random() * 4);
          if (p.id !== 'b1' && Math.random() < 0.4) p.slots[d].eliminated = true;
        }
        if (activeSlots(p).length === 0) p.eliminated = true;
      }
      if (s.players.filter((p) => !p.eliminated && p.id !== 'b1').length === 0) continue;
      const choice = chooseBotAttack(s, 'b1');
      assert.ok(choice);
      assert.notEqual(choice.targetId, 'b1');
      const t = getPlayer(s, choice.targetId);
      assert.equal(t.eliminated, false);
      assert.equal(t.slots[choice.targetDigit].eliminated, false);
    }
  }
});

test('full random simulation: games always terminate with one winner and consistent state', () => {
  for (let g = 0; g < 200; g++) {
    const n = 2 + (g % 5);
    const players = Array.from({ length: n }, (_, i) => P(`p${i}`, 'bot', ['sniper', 'bully', 'chaotic'][i % 3]));
    const s = createMatch(players);
    let guard = 0;
    while (s.status === 'playing') {
      assert.ok(++guard < 20000, 'game did not terminate');
      const id = currentPlayerId(s);
      const r = roll(s, id);
      if (r.outcome === 'bullet') {
        const c = chooseBotAttack(s, id);
        attack(s, id, c.targetId, c.targetDigit);
      }
      // invariant: no player has a bullet outside of an attack phase
      if (s.phase === PHASE.AWAIT_ROLL) {
        for (const p of s.players) for (const d of DIGITS) assert.notEqual(p.slots[d].stage, STAGE.BULLET);
      }
    }
    assert.equal(s.players.filter((p) => !p.eliminated).length, 1);
    assert.equal(s.winnerId, s.players.find((p) => !p.eliminated).id);
    // slot kills equal total eliminated slots
    const dead = s.players.reduce((n2, p) => n2 + DIGITS.filter((d) => p.slots[d].eliminated).length, 0);
    const kills = s.players.reduce((n2, p) => n2 + p.kills, 0);
    assert.equal(dead, kills);
  }
});
