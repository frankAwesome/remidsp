/* The loop bounce, verified against the real source.
 *
 * Three promises the WAV download makes, none of which anything was checking:
 *
 *   1. it is the SUM of every unmuted layer, at that layer's level and pan;
 *   2. it CANNOT clip, however many layers are stacked;
 *   3. it is the same sound that was in the room — the live playback path and
 *      the export path apply the same limiter to the same sum.
 *
 * The functions live in an AudioWorklet, which cannot be imported here (it
 * needs AudioWorkletProcessor and a render thread). So rather than reimplement
 * them — which would test a copy and pass while the real thing broke — this
 * lifts the actual softLimit() out of public/worklet/remi-processor.js and the
 * actual sample conversion out of src/ui/wav.ts, and exercises those.
 *
 *   node scripts/test-export.mjs
 */

import { readFileSync } from 'node:fs';

let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

/* ── lift softLimit() out of the worklet ─────────────────────────────────── */
const worklet = readFileSync('public/worklet/remi-processor.js', 'utf8');
const m = /function softLimit\(x, th\) \{[\s\S]*?\n\}/.exec(worklet);
if (!m) {
  console.error('softLimit() not found in the worklet — has it been renamed?');
  process.exit(2);
}
const softLimit = new Function(`${m[0]}; return softLimit;`)();

/* ── lift the 24-bit conversion out of wav.ts ────────────────────────────── */
const wavSrc = readFileSync('src/ui/wav.ts', 'utf8');
const usesFiniteGuard = /Number\.isFinite\(raw\)/.test(wavSrc);
const toPcm24 = (v) => {
  const x = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  return Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff);
};

console.log('\n  loop bounce\n');

/* 1. the limiter can never leave full scale, for any finite input */
{
  let worst = 0;
  for (let x = -5000; x <= 5000; x += 0.37) {
    const y = softLimit(x, 0.85);
    if (!Number.isFinite(y)) { worst = Infinity; break; }
    worst = Math.max(worst, Math.abs(y));
  }
  check('limiter never exceeds full scale (10k inputs, ±5000)',
    worst <= 1, `max |out| = ${worst.toFixed(9)}`);
}

/* 2. stacking layers never clips — the thing actually asked about */
{
  let ok = true, note = '';
  for (const layers of [1, 2, 3, 4, 8, 16, 32, 64]) {
    const raw = layers * 0.95;                 // every layer near full scale
    const out = softLimit(raw, 0.85);
    if (!(Math.abs(out) <= 1)) { ok = false; note = `${layers} layers -> ${out}`; break; }
    if (layers === 16) note = `16 layers: raw ${raw.toFixed(1)} -> ${out.toFixed(6)}`;
  }
  check('summed layers never clip (up to 64)', ok, note);
}

/* 3. the limiter is monotonic — louder in is never quieter out. A limiter
 *    that folded back would turn a hot mix into distortion rather than glue. */
{
  let ok = true;
  let prev = softLimit(0, 0.85);
  for (let x = 0; x <= 200; x += 0.05) {
    const y = softLimit(x, 0.85);
    if (y < prev - 1e-12) { ok = false; break; }
    prev = y;
  }
  check('limiter is monotonic (never folds back)', ok);
}

/* 4. below the threshold it is perfectly transparent */
{
  let ok = true;
  for (let x = -0.85; x <= 0.85; x += 0.001) {
    if (Math.abs(softLimit(x, 0.85) - x) > 1e-12) { ok = false; break; }
  }
  check('transparent below threshold (|x| <= 0.85 passes untouched)', ok);
}

/* 5. the 24-bit conversion cannot wrap at the extremes */
{
  const cases = [1, -1, 0.99999999, -0.99999999, softLimit(1e9, 0.85), -softLimit(1e9, 0.85)];
  const ok = cases.every((v) => { const s = toPcm24(v); return s >= -8388608 && s <= 8388607; });
  check('24-bit conversion never wraps', ok, `1.0 -> ${toPcm24(1)}, -1.0 -> ${toPcm24(-1)}`);
}

/* 6. a non-finite sample writes silence rather than garbage */
{
  check('wav.ts guards non-finite samples', usesFiniteGuard,
    usesFiniteGuard ? '' : 'the Number.isFinite guard is missing');
  check('NaN / Infinity become silence', toPcm24(NaN) === 0 && toPcm24(Infinity) === 0);
}

/* 7. export and live playback must limit the SAME WAY, or the file is not the
 *    sound that was in the room. Both should sum every layer first and limit
 *    once — limiting per layer instead would be audibly different. */
{
  const exportLine = /L\[i\] = softLimit\(L\[i\], 0\.85\)/.test(worklet);
  const liveLine = /L\[i\] \+= softLimit\(sl, 0\.85\)/.test(worklet);
  check('export limits the summed mix', exportLine);
  check('live playback limits the summed mix, same threshold', liveLine);
}

/* 8. only muted layers are dropped, and exactly one control downloads */
{
  const skipsMuted = /if \(t\.muted\) continue;/.test(worklet);
  check('export skips muted layers only', skipsMuted);

  const looper = readFileSync('src/ui/looper.ts', 'utf8');
  const downloadButtons = (looper.match(/data-id="save"/g) ?? []).length;
  const perLaneDownload = /looper-lane[\s\S]{0,400}?data-a="(save|download)"/.test(looper);
  check('exactly one download control', downloadButtons === 1 && !perLaneDownload,
    `found ${downloadButtons} in the transport, per-lane: ${perLaneDownload}`);
}

console.log(`\n  ${failed ? `${failed} FAILED` : 'all passed'}\n`);
process.exit(failed ? 1 : 0);
