// Synthesised sound effects (Web Audio) - no audio files needed.
// Five distinct sounds: page flip, bullet fired, slot eliminated, player eliminated, game over.
// Each player can mute locally; the choice is remembered. Audio starts after the first user gesture.

const KEY = 'pb.sound';
let ctx = null;
let enabled = (() => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } })();
const listeners = new Set();

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    try { ctx = new C(); } catch { return null; }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Browsers block audio until the user interacts: unlock on first gesture.
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(ev, () => ac(), { once: true, passive: true });
}

export const sound = {
  get enabled() { return enabled; },
  set(on) {
    enabled = !!on;
    try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch { /* ignore */ }
    listeners.forEach((f) => f(enabled));
    if (enabled) ac();
  },
  toggle() { this.set(!enabled); return enabled; },
  onChange(f) { listeners.add(f); return () => listeners.delete(f); },
};

function tone({ type = 'sine', from, to, dur, gain = 0.2, delay = 0, curve = 'exp' }) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, t0);
  if (to && to !== from) {
    if (curve === 'exp') o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
    else o.frequency.linearRampToValueAtTime(to, t0 + dur);
  }
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

function noise({ dur, gain = 0.2, delay = 0, freq = 3000, q = 0.8, type = 'bandpass', sweepTo }) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(c.destination);
  src.start(t0);
}

function play(fn) {
  if (!enabled) return;
  try { fn(); } catch { /* sound must never break gameplay */ }
}

export const sfx = {
  /** Page flipping: a few quick paper swishes. */
  flip() {
    play(() => {
      for (let i = 0; i < 4; i++) noise({ dur: 0.2, gain: 0.16, delay: i * 0.22, freq: 1800 + i * 500, sweepTo: 5200, q: 0.7 });
      tone({ type: 'triangle', from: 220, to: 330, dur: 0.12, gain: 0.04, delay: 0.9 });
    });
  },
  /** Bullet fired: laser-ish "pew". */
  shoot() {
    play(() => {
      tone({ type: 'square', from: 1500, to: 180, dur: 0.28, gain: 0.12 });
      noise({ dur: 0.12, gain: 0.12, freq: 4000, sweepTo: 800, q: 0.5 });
    });
  },
  /** Slot eliminated: cartoon "boing + splat". */
  slotOut() {
    play(() => {
      tone({ type: 'sine', from: 180, to: 620, dur: 0.22, gain: 0.22 });
      tone({ type: 'sine', from: 620, to: 140, dur: 0.3, gain: 0.2, delay: 0.2 });
      noise({ dur: 0.16, gain: 0.14, delay: 0.1, freq: 900, type: 'lowpass', q: 1 });
    });
  },
  /** Whole player eliminated: sad slide-whistle descent + thud. */
  playerOut() {
    play(() => {
      tone({ type: 'sawtooth', from: 700, to: 90, dur: 0.9, gain: 0.12 });
      tone({ type: 'sawtooth', from: 620, to: 80, dur: 0.9, gain: 0.08, delay: 0.05 });
      noise({ dur: 0.25, gain: 0.25, delay: 0.85, freq: 220, type: 'lowpass', q: 1 });
    });
  },
  /** Game over: silly victory fanfare. */
  gameOver() {
    play(() => {
      const notes = [523, 659, 784, 1047, 784, 1047, 1319];
      notes.forEach((f, i) => tone({ type: 'square', from: f, dur: 0.18, gain: 0.1, delay: i * 0.14 }));
      tone({ type: 'triangle', from: 262, dur: 0.9, gain: 0.14, delay: 0.98 });
      tone({ type: 'triangle', from: 330, dur: 0.9, gain: 0.1, delay: 0.98 });
      tone({ type: 'triangle', from: 392, dur: 0.9, gain: 0.1, delay: 0.98 });
    });
  },
};
