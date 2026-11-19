// Bot decision-making.
//
// Bots have NO special powers: they only choose a target (opponent + slot) when
// the engine says they hold a bullet. Dice rolls and every rule go through the
// same engine functions humans use, so bots cannot cheat.

import { randomInt } from 'node:crypto';
import { DIGITS, activeSlots, getPlayer, validTargets } from './engine.js';

export const BOT_ROSTER = [
  { name: 'PROFESSOR GUN', style: 'sniper' },
  { name: 'NOOB MASTER', style: 'chaotic' },
  { name: 'DOODLE BOT', style: 'bully' },
  { name: 'SHADOW', style: 'sniper' },
  { name: 'SIR SCRIBBLE', style: 'chaotic' },
  { name: 'PENCIL PETE', style: 'bully' },
];

export function pickBotRoster(rng = randomInt, count = 3, avoidNames = []) {
  const avoid = new Set(avoidNames.map((n) => n.trim().toUpperCase()));
  const pool = BOT_ROSTER.filter((b) => !avoid.has(b.name));
  const a = [...pool];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, count);
}

/**
 * Choose { targetId, targetDigit } for a bot holding a bullet.
 * Strategies (all pick only legal targets):
 *  - sniper:  finish the player closest to being knocked out
 *  - bully:   hit whoever has the most advanced weapons (stop threats)
 *  - chaotic: uniformly random legal target
 */
export function chooseBotAttack(state, botId, rng = randomInt) {
  const bot = getPlayer(state, botId);
  const targets = validTargets(state, botId);
  if (!bot || targets.length === 0) return null;
  const style = bot.style || 'chaotic';

  const threat = (p) => activeSlots(p).reduce((s, d) => s + p.slots[d].stage, 0);
  let chosen;
  if (style === 'sniper') {
    const min = Math.min(...targets.map((t) => t.digits.length));
    const pool = targets.filter((t) => t.digits.length === min);
    chosen = pool[rng(0, pool.length)];
  } else if (style === 'bully') {
    const scored = targets.map((t) => ({ t, s: threat(getPlayer(state, t.playerId)) }));
    const max = Math.max(...scored.map((x) => x.s));
    const pool = scored.filter((x) => x.s === max).map((x) => x.t);
    chosen = pool[rng(0, pool.length)];
  } else {
    chosen = targets[rng(0, targets.length)];
  }

  const victim = getPlayer(state, chosen.playerId);
  let digit;
  if (style === 'chaotic') {
    digit = chosen.digits[rng(0, chosen.digits.length)];
  } else {
    // prefer the most developed slot (destroy the best weapon)
    const best = Math.max(...chosen.digits.map((d) => victim.slots[d].stage));
    const pool = chosen.digits.filter((d) => victim.slots[d].stage === best);
    digit = pool[rng(0, pool.length)];
  }
  if (!DIGITS.includes(digit)) return null;
  return { targetId: chosen.playerId, targetDigit: digit };
}
