'use strict';
/**
 * Deterministic whip-physics regression test.
 *   node scripts/physics-test.js            run all scenarios, exit 1 on failure
 *   node scripts/physics-test.js '{"wristFreq":17}'   try config overrides
 *
 * Each scenario replays a synthetic mouse path (sampled at 125 Hz and interpolated,
 * like the real app) and counts whip cracks. "Calm" motions must never crack;
 * deliberate ones must crack (almost) every time.
 */
const { DEFAULTS, Hand, Whip } = require('../physics.js');

const jsonArg = process.argv.slice(2).find((a) => a.startsWith('{'));
const overrides = jsonArg ? JSON.parse(jsonArg) : {};
const verbose = process.argv.includes('-v');
const cfg = { ...DEFAULTS, ...overrides };

// seeded RNG so "jitter" is reproducible
let seed = 1234567;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2);
const flick = (dist, half, period) => (t) => {
  const k = t % period;
  if (k < half) return [900 + (k / half) * dist, 300 - (k / half) * dist * 0.25];
  if (k < 2 * half) return [900 + dist - ((k - half) / half) * dist, 300 - dist * 0.25 + ((k - half) / half) * dist * 0.25];
  return [900, 300];
};

const scenarios = [
  // name, path(t) -> [x,y], seconds, [min, max] cracks
  ['idle', () => [900, 300], 4, [0, 0]],
  ['slow drift', (t) => [900 + Math.sin(t * 1.2) * 300, 300 + Math.cos(t * 0.9) * 120], 6, [0, 0]],
  ['hand jitter', () => [900 + (rnd() - 0.5) * 8, 300 + (rnd() - 0.5) * 8], 4, [0, 0]],
  ['pointing', (t) => { const c = Math.floor(t / 0.9), k = Math.min(1, (t % 0.9) / 0.45), a = c % 2 ? 1 : -1; return [900 + a * (200 - 400 * ease(k)), 300 + a * (60 - 120 * ease(k))]; }, 7.2, [0, 0]],
  ['scroll wiggle', (t) => [900 + Math.sin(t * 9) * 40, 300 + Math.cos(t * 7) * 25], 4, [0, 0]],
  ['lazy circles', (t) => [900 + Math.cos(t * 5) * 130, 320 + Math.sin(t * 5) * 130], 5, [0, 0]],
  ['soft flick', flick(160, 0.08, 0.8), 6.4, [0, 2]],
  ['flick', flick(240, 0.07, 0.8), 6.4, [7, 9]],
  ['hard flick', flick(320, 0.06, 0.8), 6.4, [7, 9]],
  ['brisk swipe', (t) => { const c = Math.floor(t / 0.7), k = Math.min(1, (t % 0.7) / 0.3), a = c % 2 ? 1 : -1; return [900 + a * (350 - 700 * ease(k)), 300]; }, 7, [7, 11]],
  ['overhead crack', (t) => { const k = t % 1.0; if (k < 0.18) return [900 - (k / 0.18) * 120, 300 - (k / 0.18) * 260]; if (k < 0.27) { const q = (k - 0.18) / 0.09; return [780 + q * 320, 40 + q * 300]; } if (k < 0.5) return [1100, 340]; const q = ease((k - 0.5) / 0.5); return [1100 - q * 200, 340 - q * 40]; }, 6, [5, 7]],
];

function run(path, seconds) {
  const hand = new Hand(...path(0));
  let cracks = 0; let maxTip = 0; const times = [];
  const whip = new Whip(cfg, hand, { restAngle: 0.35, onCrack: (i, w) => { cracks++; times.push(+w.time.toFixed(2)); } });
  const dt = cfg.substep;
  const SAMPLE = 0.008;
  let sA = path(0), sB = path(0), tA = -SAMPLE, tB = 0;
  // settle for 1.5 s at the start position
  for (let i = 0; i < 1.5 / dt; i++) { hand.moveTo(sA[0], sA[1], dt); whip.step(dt); }
  cracks = 0; times.length = 0; whip.time = 0;
  for (let t = 0; t < seconds; t += dt) {
    while (t >= tB) { sA = sB; tA = tB; tB += SAMPLE; sB = path(tB); }
    const k = (t - tA) / (tB - tA);
    hand.moveTo(sA[0] + (sB[0] - sA[0]) * k, sA[1] + (sB[1] - sA[1]) * k, dt);
    whip.step(dt);
    if (whip.tipSpeed > maxTip) maxTip = whip.tipSpeed;
    for (let i = 0; i < whip.n; i++) if (!Number.isFinite(whip.x[i])) throw new Error('NaN in simulation');
  }
  return { cracks, maxTip: Math.round(maxTip), times };
}

let failed = 0;
for (const [name, path, seconds, [lo, hi]] of scenarios) {
  seed = 1234567;
  const r = run(path, seconds);
  const ok = r.cracks >= lo && r.cracks <= hi;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(15)} cracks=${String(r.cracks).padStart(2)} (want ${lo}-${hi})  maxTip=${String(r.maxTip).padStart(6)} px/s${verbose ? `  ${JSON.stringify(r.times)}` : ''}`);
}
console.log(failed ? `\n${failed} scenario(s) failed` : '\nall scenarios passed');
process.exit(failed ? 1 : 0);
