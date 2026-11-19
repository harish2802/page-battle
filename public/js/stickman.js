// Hand-drawn style stickman SVGs.
//
// slotStickman(): one digit slot's stickman at development stage 0-4
//   0 EMPTY   faint dashed ghost
//   1 HEAD    a circular head (+ player-colour scarf)
//   2 BODY    head + body and limbs
//   3 GUN     + a cartoon gun in hand (unloaded; this is also the state after firing)
//   4 BULLET  gun loaded: a bullet sits in the muzzle and pulses
// All dynamic text is numeric/colour only; colours are validated.

const INK = '#05050a';
const PAPER = '#fcf9f0';

export function safeColor(c) {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#2563eb';
}

export function slotStickman(stage, color, { dead = false } = {}) {
  const col = safeColor(color);
  const ghost = stage === 0;
  const op = ghost ? ' opacity=".28" stroke-dasharray="3 3"' : '';
  let s = `<svg viewBox="0 0 60 80" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`;
  // head
  s += `<circle cx="30" cy="15" r="10" fill="${PAPER}"${op}/>`;
  if (stage >= 1) {
    s += `<circle cx="26.5" cy="13.5" r="1.3" fill="${INK}" stroke="none"/><circle cx="33.5" cy="13.5" r="1.3" fill="${INK}" stroke="none"/>`;
    s += `<path d="M26 19 Q30 22 34 19" stroke-width="2"/>`;
    s += `<path d="M21 26 Q30 31 39 26" stroke="${col}" stroke-width="3.5"/>`; // scarf in player colour
  } else {
    s += `<path d="M30 25v0" ${op}/>`;
  }
  // body & limbs
  const body = stage >= 2
    ? `<path d="M30 26V50M30 33L17 43M30 33L43 40M30 50L19 72M30 50L41 72"/>`
    : `<path d="M30 26V50M30 33L17 43M30 33L43 40M30 50L19 72M30 50L41 72" opacity=".22" stroke-dasharray="3 4"/>`;
  s += stage >= 1 ? body : body;
  if (stage >= 3) {
    // gun in right hand
    s += `<g transform="translate(40 34)"><rect x="0" y="0" width="17" height="7" rx="1.5" fill="#f1eee5" stroke-width="2.4"/><rect x="2" y="7" width="5" height="7" rx="1" fill="${INK}" stroke="none"/><rect x="13" y="-1.5" width="4.5" height="10" rx="1" fill="${col}" stroke-width="2"/></g>`;
  }
  if (stage >= 4) {
    s += `<g><circle class="bullet-pulse" cx="58" cy="37.5" r="3.2" fill="#a03e40" stroke="${INK}" stroke-width="1.6"/></g>`;
    s += `<path d="M53 28l-2-4M58 27l1-5M62 30l4-3" stroke="#a03e40" stroke-width="1.8"/>`;
  }
  s += '</svg>';
  return s;
}

/** Red scribble cross drawn over an eliminated slot. */
export function crossScribble() {
  return `<svg viewBox="0 0 60 80" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#dc2626" stroke-width="4" stroke-linecap="round" aria-hidden="true"><path d="M6 8L54 72M54 8L7 73"/><path d="M8 40L52 36" stroke-width="2.5" opacity=".7"/></svg>`;
}

const FACES = [
  (c) => `<rect x="-14" y="-4" width="12" height="9" rx="2" fill="${c}" stroke-width="2.4"/><rect x="2" y="-4" width="12" height="9" rx="2" fill="${c}" stroke-width="2.4"/><path d="M-2 0h4" stroke-width="2.4"/><path d="M-9 11Q0 18 9 11" stroke-width="3"/>`, // shades
  (c) => `<circle cx="-8" cy="-1" r="6" stroke-width="2.4"/><circle cx="8" cy="-1" r="6" stroke-width="2.4"/><path d="M-2 -1h4" stroke-width="2.4"/><circle cx="-8" cy="-1" r="1.6" fill="${INK}" stroke="none"/><circle cx="8" cy="-1" r="1.6" fill="${INK}" stroke="none"/><path d="M-8 12Q0 16 8 12" stroke-width="3"/>`, // glasses
  (c) => `<circle cx="-7" cy="-2" r="2.2" fill="${INK}" stroke="none"/><circle cx="7" cy="-2" r="2.2" fill="${INK}" stroke="none"/><path d="M-9 8Q0 18 9 8" stroke-width="3"/><circle cx="-13" cy="6" r="2.5" fill="${c}" stroke="none" opacity=".5"/><circle cx="13" cy="6" r="2.5" fill="${c}" stroke="none" opacity=".5"/>`, // happy
  (c) => `<path d="M-12 -6L-3 -1M12 -6L3 -1" stroke-width="3"/><circle cx="-7" cy="2" r="2" fill="${INK}" stroke="none"/><circle cx="7" cy="2" r="2" fill="${INK}" stroke="none"/><path d="M-8 12L0 9L8 12" stroke-width="3"/>`, // grumpy
  (c) => `<rect x="-12" y="-5" width="9" height="9" stroke-width="2.4"/><rect x="3" y="-5" width="9" height="9" stroke-width="2.4"/><path d="M-8 11h16" stroke-width="3"/>`, // robot eyes
  (c) => `<path d="M-11 -4L-4 3M-4 -4L-11 3M4 -4L11 3M11 -4L4 3" stroke-width="2.6"/><path d="M-8 11Q0 6 8 11" stroke-width="3"/>`, // dizzy
];

/** Big expressive stickman used on lobby / pregame / winner. mode: 'idle' | 'dance' | 'out'. */
export function bigStickman(color, faceIndex = 0, { mode = 'idle', crown = false } = {}) {
  const col = safeColor(color);
  const face = FACES[Math.abs(faceIndex) % FACES.length](col);
  const out = mode === 'out';
  const dance = mode === 'dance';
  const eyes = out ? FACES[5](col) : face;
  return `<svg viewBox="0 0 140 170" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="${INK}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <ellipse cx="70" cy="160" rx="36" ry="5" fill="#e5e2da" stroke-width="2"/>
  <g class="${dance ? 'dance' : ''}">
    ${crown ? `<polygon points="52,22 56,8 63,18 70,4 77,18 84,8 88,22" fill="#ffcf4a" stroke-width="3"/>` : ''}
    <circle cx="70" cy="42" r="23" fill="${PAPER}"/>
    <g transform="translate(70 42)">${eyes}</g>
    <path d="M52 62Q70 72 88 62" stroke="${col}" stroke-width="6"/>
    <path d="M70 66V112"/>
    <g class="${dance ? 'd-arm-l' : ''}"><path d="M70 78L44 ${dance ? 56 : 98}"/></g>
    <g class="${dance ? 'd-arm-r' : ''}"><path d="M70 78L96 ${dance ? 56 : 98}"/></g>
    <g class="${dance ? 'd-leg-l' : ''}"><path d="M70 112L50 152"/></g>
    <g class="${dance ? 'd-leg-r' : ''}"><path d="M70 112L90 152"/></g>
  </g>
  ${out ? `<path d="M30 20L110 140M110 20L30 140" stroke="#dc2626" stroke-width="6" opacity=".85"/>` : ''}
</svg>`;
}

export function faceIndexFor(i) {
  return i;
}

/** Tiny coloured pen dot. */
export function dot(color, size = 14) {
  return `<span class="inline-block rounded-full border-2" style="width:${size}px;height:${size}px;background:${safeColor(color)};border-color:${INK}"></span>`;
}
