/* Generates the bundled demo DI loop.
 *
 * SUPERSEDED — the shipped demo DI is now a real recorded performance,
 * public/assets/di/DI Remi 90bpm.wav (8 bars of 4/4 at 90 BPM). This is kept
 * because it still generates a licence-free stand-in from nothing, which is
 * useful for a second house DI or for anyone forking the repo without one.
 *
 * WHY IT EXISTED: a visitor with no guitar and no interface still has to hear
 * the rig respond to real playing, or the whole product is a picture of an amp.
 * That needs a dry instrument signal we own outright — no sample licence, no
 * third-party clip, and reproducible from source rather than a binary someone
 * has to trust.
 *
 * So it is synthesised: Karplus-Strong plucked strings, which is a genuine
 * physical model of a struck string and reads as a clean electric DI once it
 * goes through a capture. Arpeggiated Dmaj — Bm7 — Gmaj9 — Asus4, the ambient
 * palette the bundled Camden and Portland amps are voiced for.
 *
 * It is a PLACEHOLDER in one sense only: a real player recorded through a real
 * pickup will always beat it, and the house DI library should replace it. The
 * plumbing it feeds is identical either way.
 *
 *   node scripts/make-di.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';

const SR = 48000;
const BPM = 92;
const BEATS_PER_BAR = 4;
const BARS = 4;
const SEC_PER_BEAT = 60 / BPM;
const LOOP_SEC = BARS * BEATS_PER_BAR * SEC_PER_BEAT;      // 10.43 s
const LOOP_N = Math.round(LOOP_SEC * SR);
const TAIL_N = Math.round(2.2 * SR);   // rings past the end, folded back below

/** Equal temperament, A4 = 440. 'D3' → 146.83 Hz */
const NOTES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function hz(name) {
  const m = /^([A-G])(#?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  const semi = NOTES[m[1]] + (m[2] ? 1 : 0);
  const midi = (Number(m[3]) + 1) * 12 + semi;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/* Guitar voicings, low string first. These are the shapes a player actually
 * grabs, not root-position stacks — the wide low interval is most of why a
 * guitar chord sounds like a guitar. */
const CHORDS = [
  ['D3', 'A3', 'D4', 'F#4', 'A4'],          // D
  ['B2', 'F#3', 'B3', 'D4', 'A4'],          // Bm7
  ['G2', 'D3', 'G3', 'B3', 'A4'],           // Gmaj9
  ['A2', 'E3', 'A3', 'D4', 'E4'],           // Asus4 → A
];

/* A rolling eighth-note pattern over the voicing, by string index. Repeats of
 * a string are re-plucked rather than held, which is what gives the pattern
 * its pulse. */
const PATTERN = [0, 2, 3, 4, 3, 2, 1, 2];

const out = new Float32Array(LOOP_N + TAIL_N);

/** Karplus-Strong with a damped, interpolated delay line.
 *
 *  The excitation is lowpassed noise rather than white noise: a pick does not
 *  inject energy evenly across the spectrum, and white noise makes the attack
 *  read as a synth click instead of a string. */
function pluck(startSample, freq, gain, damping) {
  const N = SR / freq;
  const M = Math.floor(N);
  const frac = N - M;                     // fractional delay → in-tune strings
  const buf = new Float32Array(M + 2);

  let last = 0;
  for (let i = 0; i < buf.length; i++) {
    const white = Math.random() * 2 - 1;
    last = last * 0.55 + white * 0.45;    // one-pole LP on the excitation
    buf[i] = last;
  }
  // Pick position: the same string plucked near the bridge is thinner. A comb
  // at ~1/5 of the length is a normal-sounding picking spot.
  const pick = Math.max(1, Math.round(M / 5));
  for (let i = buf.length - 1; i >= pick; i--) buf[i] -= buf[i - pick] * 0.7;

  const dur = Math.min(out.length - startSample, Math.round(SR * 3.0));
  if (dur <= 0) return;

  let idx = 0;
  let prev = 0;
  for (let n = 0; n < dur; n++) {
    const i0 = idx % (M + 1);
    const i1 = (idx + 1) % (M + 1);
    const v = buf[i0] * (1 - frac) + buf[i1] * frac;
    // Feedback lowpass — the string loses highs faster than fundamentals,
    // which is the whole character of a decaying pluck.
    const filtered = (v + prev) * 0.5 * damping;
    prev = v;
    buf[i0] = filtered;
    out[startSample + n] += filtered * gain;
    idx++;
  }
}

const eighth = SEC_PER_BEAT / 2;
for (let bar = 0; bar < BARS; bar++) {
  const chord = CHORDS[bar % CHORDS.length];
  for (let step = 0; step < 8; step++) {
    const stringIdx = PATTERN[step % PATTERN.length];
    const name = chord[Math.min(stringIdx, chord.length - 1)];
    const t = (bar * BEATS_PER_BAR * SEC_PER_BEAT) + step * eighth;
    // Humanise: real picking is neither perfectly on the grid nor even.
    const jitter = (Math.random() - 0.5) * 0.008;
    const accent = step % 4 === 0 ? 1.0 : step % 2 === 0 ? 0.82 : 0.66;
    const vel = accent * (0.9 + Math.random() * 0.2);
    const at = Math.max(0, Math.round((t + jitter) * SR));
    // Lower strings ring longer than the top ones.
    const damping = 0.9975 - stringIdx * 0.0006;
    pluck(at, hz(name), 0.5 * vel, damping);
  }
}

/* Fold the ring-out back over the top so the loop joins itself. Without this
 * the last chord is guillotined at the loop point, which is audible and
 * exactly the artefact that makes a demo loop feel cheap. */
const loop = new Float32Array(LOOP_N);
loop.set(out.subarray(0, LOOP_N));
for (let i = 0; i < TAIL_N; i++) loop[i] += out[LOOP_N + i];

/* A DI is an instrument-level signal, not a mastered one. Peaking near 0 dBFS
 * would slam the front of every capture and make each one sound like it is
 * being overdriven, so this lands around -12 dBFS. */
let peak = 0;
for (const s of loop) peak = Math.max(peak, Math.abs(s));
const target = Math.pow(10, -12 / 20);
const g = peak > 0 ? target / peak : 1;
for (let i = 0; i < loop.length; i++) loop[i] *= g;

// 5 ms edge fades — a DC step at the seam clicks on every pass.
const fade = Math.round(SR * 0.005);
for (let i = 0; i < fade; i++) {
  const k = i / fade;
  loop[i] *= k;
  loop[loop.length - 1 - i] *= k;
}

function wav16(samples, sampleRate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

mkdirSync('public/assets/di', { recursive: true });
const wav = wav16(loop, SR);
writeFileSync('public/assets/di/ambient_dmaj_92.wav', wav);
console.log(`ambient_dmaj_92.wav — ${LOOP_SEC.toFixed(2)}s, ${BPM} BPM, `
  + `${(wav.length / 1024).toFixed(0)} kB, peak ${(20 * Math.log10(target)).toFixed(1)} dBFS`);
