/* REMI DSP — Maine · web suite
 * The whole rig runs inside this one AudioWorkletProcessor: gate → comp →
 * drive → NAM capture amp (WASM) → [cab convolver lives in the graph] →
 * sauce → studio strip → chorus → dual-engine delay → Vast Sky reverb.
 * 128-sample quanta, no lookahead, no internal buffering: the chain adds
 * zero latency beyond the render quantum.
 *
 * Everything is Float32 mono-in / stereo-out. Parameters arrive over the
 * MessagePort as {type:'param', id, v} and land in per-module smoothers, so
 * the audio thread never sees a zipper.
 */

'use strict';

const TWO_PI = Math.PI * 2;

/* ---------- small DSP utilities ---------- */

function dbToGain(db) { return Math.pow(10, db / 20); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Denormal guard. Feedback tails decay into denormal territory, where every
// multiply costs orders of magnitude more — the classic source of "the reverb
// crackles after the note stops". Flushing to zero keeps the loop cheap.
const DENORM = 1e-20;
function flush(x) { return (x > -DENORM && x < DENORM) ? 0 : x; }

// Smooth limiter: exactly transparent below `th`, C1-continuous at the knee
// (derivative is 1 there), asymptotic to 1.0 above. No transcendentals, no
// hard corner — blooms compress instead of hitting a brick wall.
function softLimit(x, th) {
  const a = x < 0 ? -x : x;
  if (a <= th) return x;
  const room = 1 - th, over = a - th;
  const lim = th + room * over / (over + room);
  return x < 0 ? -lim : lim;
}

// Cheap deterministic noise (xorshift32) — Math.random() is a call into the
// engine's PRNG and we need several per sample in the tape modes.
let _rngState = 0x9e3779b9;
function noise() {
  _rngState ^= _rngState << 13; _rngState ^= _rngState >>> 17; _rngState ^= _rngState << 5;
  return (_rngState >> 8) * 5.9604645e-8; // ~[-0.5, 0.5)
}

// One-pole parameter smoother (~time constant in ms).
class Smooth {
  constructor(v = 0, ms = 12, sr = 48000) {
    this.z = v; this.target = v;
    this.setTime(ms, sr);
  }
  setTime(ms, sr) { this.a = Math.exp(-1 / (0.001 * ms * sr)); }
  set(v) { this.target = v; }
  jump(v) { this.target = v; this.z = v; }
  next() { return (this.z = this.target + this.a * (this.z - this.target)); }
  get() { return this.z; }
}

// RBJ biquad, transposed direct form II.
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  reset() { this.z1 = 0; this.z2 = 0; }
  tick(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  set(b0, b1, b2, a0, a1, a2) {
    const inv = 1 / a0;
    this.b0 = b0 * inv; this.b1 = b1 * inv; this.b2 = b2 * inv;
    this.a1 = a1 * inv; this.a2 = a2 * inv;
  }
  lowpass(fc, q, sr) {
    const w = TWO_PI * clamp(fc, 10, sr * 0.49) / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }
  highpass(fc, q, sr) {
    const w = TWO_PI * clamp(fc, 10, sr * 0.49) / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }
  peak(fc, q, gainDb, sr) {
    const A = Math.pow(10, gainDb / 40);
    const w = TWO_PI * clamp(fc, 10, sr * 0.49) / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    this.set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }
  lowshelf(fc, gainDb, sr, slope = 0.9) {
    const A = Math.pow(10, gainDb / 40);
    const w = TWO_PI * clamp(fc, 10, sr * 0.49) / sr, c = Math.cos(w), s = Math.sin(w);
    const al = s / 2 * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
    const sq = 2 * Math.sqrt(A) * al;
    this.set(A * ((A + 1) - (A - 1) * c + sq), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sq),
             (A + 1) + (A - 1) * c + sq, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sq);
  }
  highshelf(fc, gainDb, sr, slope = 0.9) {
    const A = Math.pow(10, gainDb / 40);
    const w = TWO_PI * clamp(fc, 10, sr * 0.49) / sr, c = Math.cos(w), s = Math.sin(w);
    const al = s / 2 * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
    const sq = 2 * Math.sqrt(A) * al;
    this.set(A * ((A + 1) + (A - 1) * c + sq), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sq),
             (A + 1) - (A - 1) * c + sq, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sq);
  }
}

// One-pole lowpass (cheap damping / tone corners).
class OnePoleLP {
  constructor() { this.z = 0; this.a = 0; }
  setFc(fc, sr) { this.a = Math.exp(-TWO_PI * clamp(fc, 10, sr * 0.49) / sr); }
  tick(x) { return (this.z = x + this.a * (this.z - x)); }
  reset() { this.z = 0; }
}
class OnePoleHP {
  constructor() { this.lp = new OnePoleLP(); }
  setFc(fc, sr) { this.lp.setFc(fc, sr); }
  tick(x) { return x - this.lp.tick(x); }
  reset() { this.lp.reset(); }
}

// Schroeder allpass on a fixed delay (diffusion building block).
// Canonical form y = v[n-N] - g·v[n] with v[n] = x + g·v[n-N] — this is
// truly unity-magnitude at every frequency, which matters the moment an
// allpass sits inside a feedback loop (the reverb tank).
class Allpass {
  constructor(samples, g = 0.55) {
    this.buf = new Float32Array(Math.max(1, samples | 0));
    this.i = 0; this.g = g;
  }
  tick(x) {
    const d = this.buf[this.i];
    const v = x + this.g * d;
    this.buf[this.i] = v;
    if (++this.i >= this.buf.length) this.i = 0;
    return d - this.g * v;
  }
  reset() { this.buf.fill(0); }
}

// Fractional delay line with cubic (Hermite) interpolation.
class FracDelay {
  constructor(maxSamples) {
    const n = 1 << Math.ceil(Math.log2(maxSamples + 8));
    this.buf = new Float32Array(n);
    this.mask = n - 1;
    this.w = 0;
  }
  write(x) { this.buf[this.w] = x; this.w = (this.w + 1) & this.mask; }
  // Read `d` samples behind the write head (d >= 1).
  read(d) {
    const rp = this.w - d;
    const i = Math.floor(rp);
    const f = rp - i;
    const m = this.mask, b = this.buf;
    const x0 = b[(i - 1) & m], x1 = b[i & m], x2 = b[(i + 1) & m], x3 = b[(i + 2) & m];
    const c0 = x1;
    const c1 = 0.5 * (x2 - x0);
    const c2 = x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3;
    const c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2);
    return ((c3 * f + c2) * f + c1) * f + c0;
  }
  // 6-point, 5th-order Lagrange read. Identical delay to read() — the extra
  // taps reach further BACK into the line, never forward — so this buys
  // interpolator accuracy at zero added latency.
  //
  // Worth it wherever the read head is moving, which for the delay is always:
  // modulation, wow, ping-pong offset and every TIME change sweep the pointer
  // across fractional positions. Cubic Hermite leaks a few percent of the
  // signal into the stopband as it slides, and that leakage lands in-band as
  // a fine grain riding the repeats.
  read6(d) {
    const rp = this.w - d;
    const i = Math.floor(rp);
    const f = rp - i;
    const m = this.mask, b = this.buf;
    const y0 = b[(i - 2) & m], y1 = b[(i - 1) & m], y2 = b[i & m];
    const y3 = b[(i + 1) & m], y4 = b[(i + 2) & m], y5 = b[(i + 3) & m];
    // Lagrange basis on nodes -2..3, evaluated at f. Shared sub-products keep
    // it to ~20 multiplies.
    const p2 = f + 2, p1 = f + 1, m1 = f - 1, m2 = f - 2, m3 = f - 3;
    const a01 = p2 * p1, a23 = f * m1, a45 = m2 * m3;
    const a012 = a01 * f, a0123 = a01 * a23;
    return (p1 * a23 * a45) * y0 * -0.008333333333333333
         + (p2 * a23 * a45) * y1 * 0.041666666666666664
         + (a01 * m1 * a45) * y2 * -0.08333333333333333
         + (a012 * a45) * y3 * 0.08333333333333333
         + (a0123 * m3) * y4 * -0.041666666666666664
         + (a0123 * m2) * y5 * 0.008333333333333333;
  }
  reset() { this.buf.fill(0); }
}

// tanh with first-order ADAA — keeps clipping harmonics from folding back.
class AdaaTanh {
  constructor() { this.x1 = 0; this.F1 = 0; }
  static F(x) { // antiderivative of tanh = ln(cosh)
    const a = Math.abs(x);
    return a > 12 ? a - Math.LN2 : Math.log(Math.cosh(x));
  }
  tick(x) {
    const dx = x - this.x1;
    const F = AdaaTanh.F(x);
    let y;
    if (Math.abs(dx) < 1e-4) y = Math.tanh(0.5 * (x + this.x1));
    else y = (F - this.F1) / dx;
    this.x1 = x; this.F1 = F;
    return y;
  }
  reset() { this.x1 = 0; this.F1 = 0; }
}

/* ---------- modules ---------- */

// Noise gate — peak follower, hysteresis, soft range floor.
class NoiseGate {
  constructor(sr) {
    this.sr = sr;
    this.on = true;
    this.thresh = new Smooth(-56, 30, sr);   // dB
    this.release = 140;                       // ms
    this.range = 80;                          // dB of max attenuation
    this.env = 0;
    this.gain = 1;
    this.envA = Math.exp(-1 / (0.0002 * sr)); // 0.2ms attack follower
    this.gr = 0; // for UI LED
  }
  set(id, v) {
    if (id === 'on') this.on = v > 0.5;
    else if (id === 'thresh') this.thresh.set(v);
    else if (id === 'release') this.release = v;
    else if (id === 'range') this.range = v;
  }
  process(L, R, n) {
    if (!this.on) { this.gr = 0; return; }
    const envR = Math.exp(-1 / (0.001 * Math.max(5, this.release) * this.sr));
    const openA = Math.exp(-1 / (0.0015 * this.sr));
    const floor = dbToGain(-this.range);
    for (let i = 0; i < n; i++) {
      const t = dbToGain(this.thresh.next());
      const x = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      this.env = x > this.env ? x + this.envA * (this.env - x) : x + envR * (this.env - x);
      // 4 dB hysteresis around the threshold
      const target = this.env > t ? 1 : (this.env > t * 0.63 && this.gain > 0.5 ? 1 : floor);
      const a = target > this.gain ? openA : envR;
      this.gain = target + a * (this.gain - target);
      L[i] *= this.gain; R[i] *= this.gain;
    }
    this.gr = this.gain;
  }
}

// CS-2-style stomp compressor: sustain macro sets threshold + makeup.
class StompComp {
  constructor(sr) {
    this.sr = sr;
    this.on = true;
    this.sustain = new Smooth(0.35, 25, sr);
    this.attack = 8;   // ms
    this.level = new Smooth(0, 25, sr); // dB
    this.env = 1e-6;
    this.g = 1;
    this.grDb = 0; // gain reduction for the panel's live strip
  }
  set(id, v) {
    if (id === 'on') this.on = v > 0.5;
    else if (id === 'sustain') this.sustain.set(v);
    else if (id === 'attack') this.attack = v;
    else if (id === 'level') this.level.set(v);
  }
  process(L, R, n) {
    if (!this.on) { this.grDb = 0; return; }
    const aA = Math.exp(-1 / (0.001 * Math.max(0.5, this.attack) * this.sr));
    const aR = Math.exp(-1 / (0.180 * this.sr));
    let grPeak = 0;
    for (let i = 0; i < n; i++) {
      const s = this.sustain.next();
      const threshDb = -18 - s * 26;         // more sustain digs deeper
      const ratio = 2.5 + s * 3.5;
      const makeup = dbToGain(-threshDb * (1 - 1 / ratio) * 0.6 + this.level.next());
      const x = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      this.env = x > this.env ? x + aA * (this.env - x) : x + aR * (this.env - x);
      const envDb = 20 * Math.log10(this.env + 1e-9);
      let grDb = 0;
      if (envDb > threshDb) grDb = (envDb - threshDb) * (1 - 1 / ratio);
      if (grDb > grPeak) grPeak = grDb;
      this.g = dbToGain(-grDb) * makeup; // env is already smooth
      L[i] *= this.g; R[i] *= this.g;
    }
    this.grDb = Math.max(this.grDb * 0.92, grPeak);
  }
}

// Op-amp diode-feedback drive: gain-dependent knee, ADAA clip, and a two-band
// output tone stack. One pedal — a Bluesbreaker-lineage transparent overdrive
// voiced from the drive capture the desktop suite ships: symmetric soft
// clipping, full-range low end, plenty of gain on tap, the amp's own voice
// still audible underneath. TREBLE/BASS mirror the desktop Drive exactly:
// ±8 dB shelves at 2.5 kHz / 150 Hz, identity at noon.
class DrivePedal {
  constructor(sr) {
    this.sr = sr;
    this.on = false;
    this.gain = new Smooth(0.35, 20, sr);
    this.level = new Smooth(0.5, 20, sr);
    this.clipL = new AdaaTanh(); this.clipR = new AdaaTanh();
    this.hpL = new OnePoleHP(); this.hpR = new OnePoleHP();
    this.lpL = new OnePoleLP(); this.lpR = new OnePoleLP();
    this.hpL.setFc(35, sr); this.hpR.setFc(35, sr);
    // Fixed post-clip top: the circuit's own voice, where the old TONE knob's
    // noon position sat. The player's EQ is the tone stack below.
    this.lpL.setFc(4150, sr); this.lpR.setFc(4150, sr);
    this.driveScale = 55;
    this.trebL = new Biquad(); this.trebR = new Biquad();
    this.bassL = new Biquad(); this.bassR = new Biquad();
    this.set('treble', 0.5);
    this.set('bass', 0.5);
  }

  set(id, v) {
    if (id === 'on') this.on = v > 0.5;
    else if (id === 'gain') this.gain.set(v);
    else if (id === 'level') this.level.set(v);
    else if (id === 'treble') {
      const db = (v - 0.5) * 16;
      this.trebL.highshelf(2500, db, this.sr, 0.7);
      this.trebR.highshelf(2500, db, this.sr, 0.7);
      this.trebOn = Math.abs(db) > 0.05;
    } else if (id === 'bass') {
      const db = (v - 0.5) * 16;
      this.bassL.lowshelf(150, db, this.sr, 0.7);
      this.bassR.lowshelf(150, db, this.sr, 0.7);
      this.bassOn = Math.abs(db) > 0.05;
    }
  }
  process(L, R, n) {
    if (!this.on) return;
    for (let i = 0; i < n; i++) {
      const d = this.gain.next();
      const pre = 1 + d * d * this.driveScale;  // square-law feel on the knob
      const comp = 1 / Math.pow(pre, 0.62);     // knee moves, level stays put
      const lv = dbToGain(-6) * (0.25 + this.level.next() * 1.5);
      const dl = this.hpL.tick(L[i]), dr = this.hpR.tick(R[i]);
      let l = this.lpL.tick(this.clipL.tick(dl * pre)) * comp * lv;
      let r = this.lpR.tick(this.clipR.tick(dr * pre)) * comp * lv;
      if (this.trebOn) { l = this.trebL.tick(l); r = this.trebR.tick(r); }
      if (this.bassOn) { l = this.bassL.tick(l); r = this.bassR.tick(r); }
      L[i] = l; R[i] = r;
    }
  }
}

// Post-capture amp tone stack — neutral at defaults, AC30-style CUT.
class ToneStack {
  constructor(sr) {
    this.sr = sr;
    this.bassF = new Biquad(); this.midF = new Biquad(); this.trebF = new Biquad();
    this.cutF = new OnePoleLP();
    this.bassFR = new Biquad(); this.midFR = new Biquad(); this.trebFR = new Biquad();
    this.cutFR = new OnePoleLP();
    this.p = { bass: 0.5, mid: 0.5, treble: 0.55, cut: 0.25 };
    this.dirty = true;
  }
  set(id, v) { this.p[id] = v; this.dirty = true; }
  update() {
    const sr = this.sr, p = this.p;
    const bassDb = (p.bass - 0.5) * 24;
    const midDb = (p.mid - 0.5) * 18;
    const trebDb = (p.treble - 0.55) * 24; // neutral at the 0.55 default
    this.bassF.lowshelf(110, bassDb, sr); this.bassFR.lowshelf(110, bassDb, sr);
    this.midF.peak(680, 0.8, midDb, sr); this.midFR.peak(680, 0.8, midDb, sr);
    this.trebF.highshelf(2200, trebDb, sr); this.trebFR.highshelf(2200, trebDb, sr);
    // CUT: transparent at/below its 0.25 default, then closes to ~2.2 kHz.
    const c = Math.max(0, (p.cut - 0.25) / 0.75);
    const fc = 21000 * Math.pow(2200 / 21000, c);
    this.cutF.setFc(fc, sr); this.cutFR.setFc(fc, sr);
    this.cutBypass = c < 1e-3;
    this.dirty = false;
  }
  process(L, R, n) {
    if (this.dirty) this.update();
    for (let i = 0; i < n; i++) {
      let l = this.trebF.tick(this.midF.tick(this.bassF.tick(L[i])));
      let r = this.trebFR.tick(this.midFR.tick(this.bassFR.tick(R[i])));
      if (!this.cutBypass) { l = this.cutF.tick(l); r = this.cutFR.tick(r); }
      L[i] = l; R[i] = r;
    }
  }
}

// CE-2-style BBD chorus: triangle-clock sweep, companding softness, dark wet.
class BbdChorus {
  constructor(sr) {
    this.sr = sr;
    this.on = false;
    this.rate = new Smooth(0.55, 30, sr);
    this.depth = new Smooth(0.4, 30, sr);
    this.tone = new Smooth(0.5, 30, sr);
    this.mix = new Smooth(0.5, 30, sr);
    this.dl = new FracDelay(0.03 * sr);
    this.dr = new FracDelay(0.03 * sr);
    this.phase = 0;
    this.clockZ = 0;                        // BBD clock inertia
    this.wetLpL = new OnePoleLP(); this.wetLpR = new OnePoleLP();
    this.satL = new AdaaTanh(); this.satR = new AdaaTanh();
    this.toneZ = -1;
  }
  set(id, v) {
    if (id === 'on') this.on = v > 0.5;
    else if (id === 'rate') this.rate.set(v);
    else if (id === 'depth') this.depth.set(v);
    else if (id === 'tone') this.tone.set(v);
    else if (id === 'mix') this.mix.set(v);
  }
  process(L, R, n) {
    if (!this.on) return;
    const sr = this.sr;
    const clockA = Math.exp(-1 / (0.0009 * sr)); // reconstruction smoothing
    for (let i = 0; i < n; i++) {
      const rate = 0.1 + Math.pow(this.rate.next(), 1.6) * 6.0;
      const depth = this.depth.next();
      const t = this.tone.next();
      if (Math.abs(t - this.toneZ) > 1e-3) {
        const fc = 2200 * Math.pow(2, t * 2.2); // 2.2k .. 10.1k
        this.wetLpL.setFc(fc, sr); this.wetLpR.setFc(fc, sr);
        this.toneZ = t;
      }
      this.phase += rate / sr;
      if (this.phase >= 1) this.phase -= 1;
      // Triangle in delay-time domain (the BBD-clock reciprocal sweep).
      const tri = this.phase < 0.5 ? this.phase * 4 - 1 : 3 - this.phase * 4;
      this.clockZ = tri + clockA * (this.clockZ - tri);
      const base = 0.0052 * sr;
      const sweep = depth * 0.0038 * sr;
      const dL = base + this.clockZ * sweep;
      const dR = base - this.clockZ * sweep;   // inverted right sweep = width
      this.dl.write(this.satL.tick(L[i] * 0.9) * 1.11);
      this.dr.write(this.satR.tick(R[i] * 0.9) * 1.11);
      const wl = this.wetLpL.tick(this.dl.read(Math.max(4, dL)));
      const wr = this.wetLpR.tick(this.dr.read(Math.max(4, dR)));
      const m = this.mix.next();
      L[i] = L[i] * (1 - m * 0.5) + wl * m;
      R[i] = R[i] * (1 - m * 0.5) + wr * m;
    }
  }
}

/* ---------- the delay: one block, two engines, repeats with soul ---------- */

// Band-limited drift for the Analog and Tape read heads.
//
// Wow and flutter used to be a one-pole on white noise. A single pole leaves a
// white tail running all the way up the audio band, and ANY high-frequency
// content in a delay-time signal frequency-modulates the read head — which
// sprays sidebands across the entire spectrum. Measured on the old Tape voice,
// the non-harmonic energy in a repeat came out LOUDER than the note itself
// (+3 dB), sitting right beside the fundamental. That was what the ear filed
// as bitcrushing, and no filter downstream could touch it, because it was
// never out of band to begin with.
//
// Two incommensurate oscillators per band instead, band-limited by
// construction, with a very slow random wander on their amplitudes so it still
// breathes. Real capstan flutter is quasi-periodic anyway, so this is closer
// to the machine as well as quieter.
class Drift {
  constructor(sr, f1, f2, seed) {
    this.i1 = f1 / sr; this.i2 = f2 / sr;
    this.p1 = seed; this.p2 = (seed * 0.618 + 0.31) % 1;
    this.w1 = 0.55; this.w2 = 0.45;
    this.v1 = 0.55; this.v2 = 0.45;
    this.wa = Math.exp(-1 / (1.4 * sr)); // ~1.4 s wander, ~0.11 Hz corner
  }
  // Sine-ish from a triangle. Its residual harmonics are all sub-audio, so
  // unlike noise they can never land in the signal band.
  static sn(p) {
    const t = p < 0.5 ? p * 4 - 1 : 3 - p * 4;
    return t * (1.5 - 0.5 * t * t);
  }
  next() {
    this.p1 += this.i1; if (this.p1 >= 1) this.p1 -= 1;
    this.p2 += this.i2; if (this.p2 >= 1) this.p2 -= 1;
    // The wander is noise-driven, so it gets TWO poles, not one. A single
    // 0.11 Hz pole still leaves enough white tail to phase-modulate a 6 kHz
    // partial at about -57 dB — measurable, and on the wrong side of the line
    // for a delay that is supposed to sound clean. The second pole drops that
    // into irrelevance for the cost of two multiplies.
    const t1 = 0.55 + noise(), t2 = 0.45 + noise();
    this.v1 = t1 + this.wa * (this.v1 - t1);
    this.v2 = t2 + this.wa * (this.v2 - t2);
    this.w1 = this.v1 + this.wa * (this.w1 - this.v1);
    this.w2 = this.v2 + this.wa * (this.w2 - this.v2);
    return Drift.sn(this.p1) * this.w1 + Drift.sn(this.p2) * this.w2;
  }
  reset() { this.p1 = 0.13; this.p2 = 0.71; }
}

// Bound a feedback loop by turning it DOWN, not by bending it.
//
// The old loop wrote softLimit(input + feedback) into the line: a memoryless
// waveshaper, no oversampling, no antiderivative smoothing — and applied to
// the DRY signal as much as the recirculating one, so every echo was a clipped
// copy of the source before it was ever an echo. On a hot two-note chord that
// measured -13.8 dB of third-order intermod parked between the notes. A gain
// is linear: it adds nothing to the spectrum at all. Ride it slowly and the
// loop is bounded without a single new harmonic.
class LoopRider {
  constructor(sr, ceil = 0.86, atkMs = 1.2, relMs = 260) {
    this.ceil = ceil;
    this.env = 0; this.g = 1;
    this.aA = Math.exp(-1 / (0.001 * atkMs * sr));
    this.aR = Math.exp(-1 / (0.001 * relMs * sr));
    this.down = 1 - Math.exp(-1 / (0.0035 * sr)); // 3.5 ms to clamp
    this.up = 1 - Math.exp(-1 / (0.15 * sr));     // 150 ms to let go
  }
  gain(peak) {
    this.env = peak > this.env ? peak + this.aA * (this.env - peak)
                               : peak + this.aR * (this.env - peak);
    const want = this.env > this.ceil ? this.ceil / this.env : 1;
    this.g += (want < this.g ? this.down : this.up) * (want - this.g);
    return this.g;
  }
  reset() { this.env = 0; this.g = 1; }
}

// One delay engine — Digital / Studio / Analog / Tape voicings, in-loop
// tone shaping, band-split saturation, allpass diffusion, drift, ducking.
class DelayEngine {
  constructor(sr) {
    this.sr = sr;
    this.on = false;
    this.mode = 1; // Studio
    this.timeMs = new Smooth(357, 90, sr); // analog-style pitch bend on change
    this.fb = new Smooth(0.42, 25, sr);
    this.mix = new Smooth(0.35, 25, sr);
    this.modRate = 0.8;
    this.modDepth = new Smooth(0.15, 40, sr);
    this.grit = new Smooth(0.25, 40, sr);
    this.duck = new Smooth(0, 40, sr);
    this.pingpong = false;
    this.offsetMs = 0;
    const cap = Math.ceil(1.7 * sr);
    this.dL = new FracDelay(cap); this.dR = new FracDelay(cap);
    // In-loop tone. ORDER MATTERS, and it is the opposite of what it was:
    // everything that removes bandwidth now runs BEFORE the saturator. Driving
    // a full-bandwidth signal into tanh throws harmonics past Nyquist, they
    // fold back in as inharmonic mush, and the loop re-drives that mush on the
    // next lap — so the aliasing compounds with every repeat, which is exactly
    // why the tail got harsher the longer it rang. Band-limit first and the
    // harmonics have nowhere to fold from.
    this.loopLpL = new OnePoleLP(); this.loopLpR = new OnePoleLP();
    this.loopHpL = new OnePoleHP(); this.loopHpR = new OnePoleHP();
    this.loopHpL.setFc(75, sr); this.loopHpR.setFc(75, sr);
    this.hicutL = new OnePoleLP(); this.hicutR = new OnePoleLP();
    this.hicutL.setFc(9000, sr); this.hicutR.setFc(9000, sr);
    // GRIT is band-split: only the low band reaches the saturator, the top
    // passes through clean. The split corner walks down as drive comes up, so
    // even at GRIT 10 the third harmonic of the highest saturated content
    // still lands inside the passband. That is what keeps max grit clean.
    this.splitL = new OnePoleLP(); this.splitR = new OnePoleLP();
    this.splitL2 = new OnePoleLP(); this.splitR2 = new OnePoleLP();
    this.satL = new AdaaTanh(); this.satR = new AdaaTanh();
    // Diffusion: TRUE series allpasses. The old code cross-faded an allpass
    // against its own input — which is a comb, not an allpass — and a comb
    // inside a feedback loop raises its own ripple to the power of the repeat
    // index. Six repeats deep, some bands were +15 dB and others notched to
    // nothing. That was the metallic ring. Series allpasses are unity
    // magnitude at every setting: smear without coloration, compounding
    // smoothly instead of resonantly.
    const apMsL = [1.13, 1.87, 2.53], apMsR = [1.31, 2.11, 2.89];
    const toSamp = (ms) => Math.max(1, Math.round(ms * 0.001 * sr));
    this.difL = apMsL.map((ms) => new Allpass(toSamp(ms), 0));
    this.difR = apMsR.map((ms) => new Allpass(toSamp(ms), 0));
    this.apLenL = apMsL.reduce((a, ms) => a + toSamp(ms), 0);
    this.apLenR = apMsR.reduce((a, ms) => a + toSamp(ms), 0);
    this.apCompL = this.apLenL; this.apCompR = this.apLenR;
    // Keeps a runaway loop bounded with a gain instead of a waveshaper.
    this.rider = new LoopRider(sr, 0.86, 1.2, 260);
    // Wet-only EQ trims.
    this.wetHpL = new OnePoleHP(); this.wetHpR = new OnePoleHP();
    this.wetLpL = new OnePoleLP(); this.wetLpR = new OnePoleLP();
    this.wetHpHz = 20; this.wetLpHz = 20000;
    this.wetHpL.setFc(20, sr); this.wetHpR.setFc(20, sr);
    this.wetLpL.setFc(20000, sr); this.wetLpR.setFc(20000, sr);
    // Head-bump body for Tape (low bell on the loop).
    this.bumpL = new Biquad(); this.bumpR = new Biquad();
    this.bumpL.peak(110, 0.9, 2.6, sr); this.bumpR.peak(110, 0.9, 2.6, sr);
    this.lfoPhase = Math.random();
    this.wow = new Drift(sr, 0.61, 1.13, 0.17);
    this.flut = new Drift(sr, 6.31, 9.73, 0.53);
    this.duckEnv = 0;
    this.applyMode();
  }
  applyMode() {
    const sr = this.sr;
    const g = clamp(this.grit.get(), 0, 1);
    const fcBase = [16000, 11500, 3400, 5200][this.mode];
    const fc = fcBase * Math.pow(0.5, g);
    this.loopLpL.setFc(fc, sr); this.loopLpR.setFc(fc, sr);
    // Two poles, not one: a 6 dB/oct split still let upper-mids through to the
    // saturator only 5 dB down, and those are the notes where drive turns
    // crunchy. 12 dB/oct keeps them out of it. The clean band is recovered by
    // subtraction, so the two halves still sum back to the input exactly no
    // matter how steep this gets.
    const split = 2400 * Math.pow(0.58, g);
    this.splitL.setFc(split, sr); this.splitR.setFc(split, sr);
    this.splitL2.setFc(split, sr); this.splitR2.setFc(split, sr);
    const apG = [0, 0.45, 0.3, 0.42][this.mode] * (0.62 + g * 0.38);
    for (const a of this.difL) a.g = apG;
    for (const a of this.difR) a.g = apG;
    // The diffusers add their own delay to every lap, so take it back off the
    // read. A Schroeder allpass has N samples of mean group delay (its phase
    // runs to -Nπ across the band) even though it is far longer than that at
    // DC, and compensating by exactly N measured best across all four voices —
    // within ~1 ms of the requested time, against ~4 ms for any curve that
    // chased the DC figure. The old build compensated nothing: its Studio
    // repeats slid ~19 ms further apart with every lap, so a tempo-synced 3/8
    // walked off the grid down the tail.
    this.apCompL = this.apLenL;
    this.apCompR = this.apLenR;
    this.lastGrit = g;
  }
  set(id, v) {
    if (id === 'on') this.on = v > 0.5;
    else if (id === 'time') this.timeMs.set(clamp(v, 20, 1500));
    else if (id === 'fb') this.fb.set(v);
    else if (id === 'mix') this.mix.set(v);
    else if (id === 'mode') { this.mode = v | 0; this.applyMode(); }
    else if (id === 'mod_rate') this.modRate = v;
    else if (id === 'mod_depth') this.modDepth.set(v);
    else if (id === 'grit') this.grit.set(v);
    else if (id === 'duck') this.duck.set(v);
    else if (id === 'pingpong') this.pingpong = v > 0.5;
    else if (id === 'offset') this.offsetMs = v;
    else if (id === 'hicut') { this.hicutL.setFc(v, this.sr); this.hicutR.setFc(v, this.sr); }
    else if (id === 'wet_hp') { this.wetHpHz = v; this.wetHpL.setFc(v, this.sr); this.wetHpR.setFc(v, this.sr); }
    else if (id === 'wet_lp') { this.wetLpHz = v; this.wetLpL.setFc(v, this.sr); this.wetLpR.setFc(v, this.sr); }
  }
  // Processes in place: out = in + wet*mix. `dryRef` feeds the ducker.
  process(L, R, n, dryRefL, dryRefR) {
    if (!this.on) return;
    const sr = this.sr;
    const isTape = this.mode === 3, isAnalog = this.mode === 2;
    const duckA = Math.exp(-1 / (0.004 * sr)), duckR = Math.exp(-1 / (0.35 * sr));
    // Coefficients that only follow GRIT are re-derived once per block, not
    // per sample: applyMode() runs exp()/pow() over a dozen filters and had
    // been firing mid-loop during a knob sweep.
    const gBlock = this.grit.get();
    if (Math.abs(gBlock - this.lastGrit) > 0.005) this.applyMode();
    // Drive is far gentler than it was (peak 3.9-4.4 against 6.0-6.8) and it
    // only ever sees the low band, so GRIT now reads as thickness rather than
    // fizz. Smoothstep keeps the first third of the knob nearly clean.
    const gc = gBlock * gBlock * (3 - 2 * gBlock);
    const drive = 1 + gc * 2.9 + (isTape ? 0.5 : 0) + (isAnalog ? 0.35 : 0);
    // Unity small-signal compensation, and it has to be exact. AdaaTanh has a
    // slope of 1 at the origin, so the loop's quiet-signal gain is
    // fb x drive x norm — with norm = drive^-0.55 that left drive^0.45 of raw
    // gain inside the feedback path, and GRIT silently became a sustain
    // control: at the default 0.25 the loop ran at fb x 1.44, so FEEDBACK
    // self-oscillated from 0.69 upward on a knob that goes to 1.1. Repeats
    // grew after the player stopped playing and parked against the limiter.
    // norm = 1/drive makes the loop gain exactly fb: GRIT is texture, and
    // only past 1.0 does a repeat bloom — which is the documented intent.
    const norm = 1 / drive;
    // The clean top is trimmed a touch as grit comes up, so the split never
    // sounds like the highs are simply bypassing the effect.
    const hiTrim = 1 - 0.18 * gBlock;
    // Tape hiss is the one bit of noise that stays, because it is the voicing
    // rather than an artifact — but it is the whole reason Tape still measures
    // a residual at max GRIT, so it comes in later on the knob and lands
    // around -70 dBFS instead of -65.
    const hissAmt = (isTape && gBlock > 0.15) ? 0.00015 * (gBlock - 0.15) / 0.85 : 0;
    const maxL = this.dL.buf.length - 8, maxR = this.dR.buf.length - 8;
    for (let i = 0; i < n; i++) {
      this.grit.next();
      const t = this.timeMs.next();
      const fb = this.fb.next();
      const mix = this.mix.next();
      const modD = this.modDepth.next();
      // LFO + tape wow/flutter (random component).
      this.lfoPhase += this.modRate / sr;
      if (this.lfoPhase >= 1) this.lfoPhase -= 1;
      let modMs = Math.sin(TWO_PI * this.lfoPhase) * modD * (isTape ? 2.6 : 1.8);
      if (isTape) modMs += (this.wow.next() * 1.1 + this.flut.next() * 0.16) * (0.3 + modD);
      else if (isAnalog) modMs += this.wow.next() * 0.09;
      const off = this.offsetMs * 0.5;
      const dSampL = clamp((t + modMs - off) * 0.001 * sr - this.apCompL, 8, maxL);
      const dSampR = clamp((t + modMs + off) * 0.001 * sr - this.apCompR, 8, maxR);
      // Diffusion sits between the line and BOTH taps, not inside the feedback
      // path alone. Buried in the loop it never touched the first repeat — so
      // echo one arrived dry and early while the tail was smeared and late,
      // and the repeats were not even evenly spaced (echo n landed at
      // n·time + (n-1)·apDelay). One shared pass puts every generation through
      // exactly the same smear and the same delay.
      let echoL = this.difL[2].tick(this.difL[1].tick(this.difL[0].tick(this.dL.read6(dSampL))));
      let echoR = this.difR[2].tick(this.difR[1].tick(this.difR[0].tick(this.dR.read6(dSampR))));
      // Ducking (dry side-chain).
      const dx = Math.max(Math.abs(dryRefL[i]), Math.abs(dryRefR[i]));
      this.duckEnv = dx > this.duckEnv ? dx + duckA * (this.duckEnv - dx) : dx + duckR * (this.duckEnv - dx);
      const duckAmt = this.duck.next();
      const duckG = 1 - duckAmt * clamp(this.duckEnv * 2.6, 0, 1) * 0.85;
      // One lap of the loop: condition → darken → (tape body) → saturate the
      // low band only → diffuse → ride the peak. Band-limiting ahead of the
      // one nonlinearity is what makes the repeats stay clean; keeping FB
      // ahead of it keeps the small-signal loop gain exactly FEEDBACK, so a
      // repeat still only blooms past 1.0, on the knob, by design.
      let fl = (this.pingpong ? echoR : echoL) * fb;
      let fr = (this.pingpong ? echoL : echoR) * fb;
      fl = this.hicutL.tick(this.loopLpL.tick(this.loopHpL.tick(fl)));
      fr = this.hicutR.tick(this.loopLpR.tick(this.loopHpR.tick(fr)));
      if (isTape) { fl = this.bumpL.tick(fl); fr = this.bumpR.tick(fr); }
      const loL = this.splitL2.tick(this.splitL.tick(fl));
      const loR = this.splitR2.tick(this.splitR.tick(fr));
      // Complementary split: a one-pole and its own residual sum back to the
      // input exactly, so the clean band rejoins with no crossover notch.
      fl = this.satL.tick(loL * drive) * norm + (fl - loL) * hiTrim;
      fr = this.satR.tick(loR * drive) * norm + (fr - loR) * hiTrim;
      if (hissAmt !== 0) { // hiss rides the repeats only
        const h = noise() * hissAmt;
        fl += h; fr -= h;
      }
      // A repeat can bloom but may never detonate — and the source goes into
      // the line CLEAN. Only what recirculates is bounded, and it is bounded
      // by a gain, so nothing new is written into the spectrum.
      const rg = this.rider.gain(Math.max(Math.abs(fl), Math.abs(fr)));
      this.dL.write(flush(L[i] + fl * rg));
      this.dR.write(flush(R[i] + fr * rg));
      let wl = this.wetLpL.tick(this.wetHpL.tick(echoL));
      let wr = this.wetLpR.tick(this.wetHpR.tick(echoR));
      L[i] += wl * mix * duckG;
      R[i] += wr * mix * duckG;
    }
  }
  reset() {
    this.dL.reset(); this.dR.reset();
    this.difL.forEach(a => a.reset()); this.difR.forEach(a => a.reset());
    this.loopLpL.reset(); this.loopLpR.reset();
    this.loopHpL.reset(); this.loopHpR.reset();
    this.hicutL.reset(); this.hicutR.reset();
    this.splitL.reset(); this.splitR.reset();
    this.splitL2.reset(); this.splitR2.reset();
    this.satL.reset(); this.satR.reset();
    this.bumpL.reset(); this.bumpR.reset();
    this.rider.reset();
    this.wow.reset(); this.flut.reset();
    this.duckEnv = 0;
  }
}

// The delay block: engines A + B in Series (B echoes A's repeats) or Parallel.
class DelayBlock {
  constructor(sr) {
    this.on = true;
    this.routing = 0; // 0 = Series, 1 = Parallel
    this.A = new DelayEngine(sr);
    this.B = new DelayEngine(sr);
    this.B.on = false;
    this.tmpL = new Float32Array(128); this.tmpR = new Float32Array(128);
    this.dryL = new Float32Array(128); this.dryR = new Float32Array(128);
    // The echo stack still needs a ceiling — SERIES lets B re-echo A and both
    // loops can run past unity — but it gets the same treatment as the loops
    // themselves: ridden, never clipped. Dry passes through untouched.
    this.rider = new LoopRider(sr, 1.0, 2, 300);
  }
  set(id, v) {
    if (id === 'on') this.on = v > 0.5;
    else if (id === 'routing') this.routing = v | 0;
  }
  process(L, R, n) {
    if (!this.on) return;
    this.dryL.set(L.subarray(0, n)); this.dryR.set(R.subarray(0, n));
    if (this.routing === 0) {
      this.A.process(L, R, n, this.dryL, this.dryR);
      this.B.process(L, R, n, this.dryL, this.dryR);
      for (let i = 0; i < n; i++) {
        const wl = L[i] - this.dryL[i], wr = R[i] - this.dryR[i];
        const g = this.rider.gain(Math.max(Math.abs(wl), Math.abs(wr)));
        L[i] = this.dryL[i] + wl * g;
        R[i] = this.dryR[i] + wr * g;
      }
    } else {
      this.tmpL.set(this.dryL.subarray(0, n)); this.tmpR.set(this.dryR.subarray(0, n));
      this.A.process(L, R, n, this.dryL, this.dryR);
      this.B.process(this.tmpL, this.tmpR, n, this.dryL, this.dryR);
      for (let i = 0; i < n; i++) { // add B's wet on top (dry already in L/R)
        const wl = (L[i] - this.dryL[i]) + (this.tmpL[i] - this.dryL[i]);
        const wr = (R[i] - this.dryR[i]) + (this.tmpR[i] - this.dryR[i]);
        const g = this.rider.gain(Math.max(Math.abs(wl), Math.abs(wr)));
        L[i] = this.dryL[i] + wl * g;
        R[i] = this.dryR[i] + wr * g;
      }
    }
  }
}

/* ---------- VAST SKY II — the reverb ----------------------------------
 * A nested-allpass feedback-delay-network in the lineage of the great
 * hardware units, tuned for one thing: a tail you want to live inside.
 *
 *   in → HP/LP conditioning → pre-delay
 *      → input diffusion (4 golden-spread allpasses; Spring adds a
 *        6-stage dispersion chirp)
 *      → early reflections (sparse stereo tap fan, per-machine pattern)
 *      → THE TANK: 8 modulated delay lines, each loop pass running
 *          read → two-band decay (low band decays on its own clock —
 *          Hall blooms warm, Plate stays tight) → HF damping →
 *          nested allpass (the density multiplier) → Hadamard-8 mix
 *        with ensemble modulation: 8 incommensurate LFOs + slow random
 *        drift on every read head, Hermite-interpolated.
 *      → shimmer: 4-grain Hann pitch shifter (+oct, or +oct & +5th)
 *        band-limited and fed BACK into the tank, so octaves cascade.
 *      → decorrelated stereo taps + early reflections → tone tilt →
 *        wet HP/LP trims → ducking → mix.
 *
 * Machines share the topology; their souls differ by size, diffusion,
 * damping, low-band multiplier, modulation figure and ER pattern:
 *   ROOM   small, ER-forward, quick density, neutral lows
 *   HALL   vast, slow bloom, warm long lows, deep ensemble chorus
 *   PLATE  instant density, bright, fast shallow shimmer of the sheet
 *   SPRING dispersive chirp, band-limited, fast flutter
 */

/* Two-tap crossfaded delay-line pitch shifter.
 *
 * The read head walks its delay down at (ratio-1) samples per sample, so the
 * pitch is exact; when a tap runs out of grain it restarts from the top.
 * Two taps sit exactly half a grain apart carrying complementary sin²
 * windows — sin²(πφ) + sin²(πφ + π/2) = 1 — so the pair is amplitude-
 * preserving and the worst case is the two taps summing incoherently, a
 * 3 dB dip. Four taps at quarter-grain spacing (what this used to be) comb
 * far harder: their phases sweep a full circle and cancel outright, which
 * measured as a 53 dB gain swing across the band. In a regenerating loop
 * that is fatal — the octave voice vanishes on one note and honks on the
 * next, and no single feedback gain can be safe for both.
 */
class GrainShifter {
  constructor(sr, ratio, grainSec) {
    this.buf = new FracDelay(Math.max(0.3, grainSec * 1.6) * sr);
    this.grain = Math.round(grainSec * sr);
    this.rate = ratio - 1;
    this.ph = 0;
  }
  /** Always fed, even when SHIMMER is down, so raising the knob finds a warm
   *  buffer instead of 120 ms of silence to chew through. */
  write(x) { this.buf.write(x); }
  read() {
    const g = this.grain;
    let p0 = this.ph + this.rate;
    if (p0 >= g) p0 -= g;
    this.ph = p0;
    const h = g * 0.5;
    const p1 = p0 < h ? p0 + h : p0 - h;
    // sin²(φ+π/2) is exactly 1 - sin²(φ), so the second window costs nothing
    // and the pair sums to unity by construction rather than by luck.
    const s0 = Math.sin(Math.PI * p0 / g), w0 = s0 * s0;
    return this.buf.read(Math.max(2, g - p0)) * w0
         + this.buf.read(Math.max(2, g - p1)) * (1 - w0);
  }
  reset() { this.buf.reset(); this.ph = 0; }
}

/* Shimmer staging. The shifter pair averages ~0.86 across the band (its 3 dB
 * crossfade floor), so MAKEUP normalises it to unity and FB alone sets the
 * regeneration loop gain: at SHIMMER 100 % about three quarters of the
 * octave comes back for another lap, which is what makes octaves stack
 * instead of appearing once and dying. */
const SHIM_MAKEUP = 1.16;
const SHIM_FB = 0.83;

class VastSkyReverb {
  constructor(sr) {
    this.sr = sr;
    this.on = true;
    this.machine = 1;
    this.decay = new Smooth(3.5, 60, sr);
    this.predelayMs = 20;
    this.mix = new Smooth(0.3, 40, sr);
    this.tone = new Smooth(0, 60, sr);
    this.mod = new Smooth(0.35, 60, sr);
    this.shimmer = new Smooth(0, 60, sr);
    this.shimmerMode = 0;
    this.duckOn = false;

    this.pre = new FracDelay(0.52 * sr);

    // Input conditioning — keep rumble and fizz out of the tank.
    this.inHp = new OnePoleHP(); this.inHp.setFc(38, sr);
    this.inLp = new OnePoleLP(); this.inLp.setFc(15500, sr);

    // Diffusion + dispersion stages (times set in configure()).
    this.diff = [];
    this.chirp = [];

    // The tank.
    this.N = 8;
    this.baseMs = [23.7, 31.1, 41.9, 47.3, 59.9, 67.7, 79.3, 89.9];
    this.lines = this.baseMs.map(() => new FracDelay(0.16 * sr));
    this.loopAp = [];
    this.lens = new Float32Array(8);
    this.gHi = new Float32Array(8);
    this.gLo = new Float32Array(8);
    this.damp = this.baseMs.map(() => new OnePoleLP());
    this.xover = this.baseMs.map(() => new OnePoleLP()); // two-band split
    this.lineOut = new Float32Array(8);
    this.fbVec = new Float32Array(8);
    this.injectSign = [1, -1, 1, -1, -1, 1, -1, 1];

    // Ensemble modulation: 8 incommensurate LFOs + slow random drift.
    this.modPhase = [0.03, 0.16, 0.29, 0.41, 0.54, 0.67, 0.79, 0.92];
    this.modRate = [0.311, 0.427, 0.523, 0.617, 0.719, 0.827, 0.929, 1.031];
    this.drift = new Float32Array(8);

    // Early reflections.
    this.erBuf = new FracDelay(0.16 * sr);
    this.erTaps = [];      // [samples, gain, isLeft]
    this.erAmt = 0;

    // Shimmer. The two voices get deliberately incommensurate grain lengths
    // (8.5 Hz and 12.3 Hz crossfade flutter) so their windows never lock into
    // one audible throb. The send is band-limited BEFORE the shift so the
    // octave lands under Nyquist at 44.1 k and the bottom octave never turns
    // to mud; the return is limited again, and that top-end roll-off is what
    // eventually starves the cascade and keeps it finite.
    this.shiftOct = new GrainShifter(sr, 2, 0.118);
    this.shift5th = new GrainShifter(sr, 3, 0.163);
    this.shimFifth = new Smooth(0, 90, sr); // INTERVAL morph, click-free
    this.shimInHp = new OnePoleHP(); this.shimInHp.setFc(200, sr);
    this.shimInLp = new OnePoleLP(); this.shimInLp.setFc(7200, sr);
    this.shimLp = new OnePoleLP(); this.shimLp.setFc(6800, sr);
    this.shimHp = new OnePoleHP(); this.shimHp.setFc(300, sr);

    // Wet voicing.
    this.tiltLoL = new Biquad(); this.tiltLoR = new Biquad();
    this.tiltHiL = new Biquad(); this.tiltHiR = new Biquad();
    this.wetHpL = new OnePoleHP(); this.wetHpR = new OnePoleHP();
    this.wetLpL = new OnePoleLP(); this.wetLpR = new OnePoleLP();
    this.wetHpL.setFc(20, sr); this.wetHpR.setFc(20, sr);
    this.wetLpL.setFc(20000, sr); this.wetLpR.setFc(20000, sr);

    this.duckEnv = 0;
    this.wetRamp = 0;      // fade-in after a machine reconfigure
    this.blockCtr = 0;
    this.configure();
  }

  /* Per-machine soul. */
  configure() {
    const sr = this.sr;
    const M = this.machine;
    // size · loop-AP gain · low-band decay mult · damp fc · mod depth ·
    // mod rate mult · ER amount · output trim
    const P = [
      { size: 0.55, apG: 0.52, loMul: 1.10, dampFc: 6200, modAmp: 5.0, modMul: 1.0, er: 0.55, out: 1.00 }, // Room
      { size: 1.35, apG: 0.56, loMul: 1.38, dampFc: 5200, modAmp: 14.0, modMul: 0.8, er: 0.30, out: 0.95 }, // Hall
      { size: 0.62, apG: 0.64, loMul: 0.72, dampFc: 9500, modAmp: 7.0, modMul: 1.7, er: 0.00, out: 0.80 }, // Plate
      { size: 0.38, apG: 0.58, loMul: 0.80, dampFc: 3600, modAmp: 2.5, modMul: 4.2, er: 0.00, out: 1.10 }, // Spring
    ][M];
    this.p = P;

    for (let k = 0; k < 8; k++) this.lens[k] = this.baseMs[k] * P.size * 0.001 * sr;

    // Input diffusion, sized with the room.
    const dMs = [4.7, 6.9, 9.8, 13.6];
    const dG = [0.71, 0.71, 0.63, 0.63];
    const dScale = 0.7 + 0.6 * P.size;
    this.diff = dMs.map((ms, i) => new Allpass(ms * dScale * 0.001 * sr, dG[i]));
    // Spring dispersion: a chirp of tight allpasses smears the transient
    // into the characteristic "doioinng".
    this.chirp = M === 3
      ? [1.13, 1.41, 1.71, 1.93, 2.17, 2.41].map((ms) => new Allpass(ms * 0.001 * sr, 0.68))
      : [];

    // Nested in-loop allpasses — the echo-density multiplier.
    const apMs = [7.1, 9.3, 11.7, 13.1, 15.9, 17.3, 19.7, 21.3];
    this.loopAp = apMs.map((ms) => new Allpass(ms * P.size * 0.001 * sr, P.apG));

    // Early reflections: Room walls close and busy, Hall far and sparse.
    const pattern = M === 0
      ? [[5.3, 0.62], [8.1, 0.54], [11.7, 0.48], [14.9, 0.41], [19.3, 0.33], [24.1, 0.27], [28.7, 0.21], [33.1, 0.16]]
      : [[13.1, 0.58], [19.7, 0.47], [29.3, 0.38], [41.9, 0.30], [53.3, 0.24], [67.1, 0.18], [83.3, 0.13], [97.9, 0.09]];
    this.erTaps = pattern.map(([ms, g], i) => [ms * (0.6 + 0.55 * P.size) * 0.001 * sr, g, i % 2 === 0]);
    this.erAmt = P.er;

    this.retone();
    this.reset();
    this.wetRamp = 0; // swell the new space in
  }

  retone() {
    const sr = this.sr;
    const t = this.tone.get();
    const fc = this.p.dampFc * Math.pow(2, t * 1.25);
    for (const d of this.damp) d.setFc(fc, sr);
    for (const x of this.xover) x.setFc(320, sr);
    // Gentle wet tilt rides the same knob: dark pulls highs down and
    // hugs the lows, bright opens the top.
    this.tiltLoL.lowshelf(300, -t * 2.5, sr); this.tiltLoR.lowshelf(300, -t * 2.5, sr);
    this.tiltHiL.highshelf(2800, t * 3.0, sr); this.tiltHiR.highshelf(2800, t * 3.0, sr);
  }

  set(id, v) {
    if (id === 'on') this.on = v > 0.5;
    else if (id === 'machine') { const m = v | 0; if (m !== this.machine) { this.machine = m; this.configure(); } }
    else if (id === 'decay') this.decay.set(v);
    else if (id === 'predelay') this.predelayMs = v;
    else if (id === 'mix') this.mix.set(v);
    else if (id === 'tone') { this.tone.set(v); this.tone.jump(v); this.retone(); }
    else if (id === 'mod') this.mod.set(v);
    else if (id === 'shimmer') this.shimmer.set(v);
    else if (id === 'shimmer_mode') {
      this.shimmerMode = v | 0;
      this.shimFifth.set(this.shimmerMode === 1 ? 1 : 0);
    }
    else if (id === 'duck') this.duckOn = v > 0.5;
    else if (id === 'hp') { this.wetHpL.setFc(v, this.sr); this.wetHpR.setFc(v, this.sr); }
    else if (id === 'lp') { this.wetLpL.setFc(v, this.sr); this.wetLpR.setFc(v, this.sr); }
  }

  /* T60 → per-line, per-band feedback gains. Recomputed once per block. */
  updateGains() {
    const decay = this.decay.get();
    const loMul = this.p.loMul;
    for (let k = 0; k < 8; k++) {
      const T = this.lens[k] / this.sr;
      this.gHi[k] = Math.min(0.9995, Math.pow(10, (-3 * T) / Math.max(0.05, decay)));
      this.gLo[k] = Math.min(0.9997, Math.pow(10, (-3 * T) / Math.max(0.05, decay * loMul)));
    }
  }

  process(L, R, n, dryRefL, dryRefR) {
    if (!this.on) return;
    const sr = this.sr;
    this.updateGains();
    const duckA = Math.exp(-1 / (0.004 * sr)), duckR = Math.exp(-1 / (0.42 * sr));
    const isSpring = this.machine === 3;
    const preSamp = Math.max(2, this.predelayMs * 0.001 * sr);
    const rampUp = 1 - Math.exp(-1 / (0.035 * sr));

    for (let i = 0; i < n; i++) {
      this.decay.next();
      const mix = this.mix.next();
      const modAmt = this.mod.next();
      const shim = this.shimmer.next();
      this.wetRamp += (1 - this.wetRamp) * rampUp;

      let x = this.inLp.tick(this.inHp.tick(0.5 * (L[i] + R[i])));
      if (isSpring) for (const a of this.chirp) x = a.tick(x);

      this.pre.write(x);
      let d = this.pre.read(preSamp);

      // Early reflections read the pre-delayed feed.
      this.erBuf.write(d);
      let erL = 0, erR = 0;
      if (this.erAmt > 0.01) {
        for (const [t, g, left] of this.erTaps) {
          const e = this.erBuf.read(t) * g;
          if (left) erL += e; else erR += e;
        }
        erL *= this.erAmt; erR *= this.erAmt;
      }

      for (const a of this.diff) d = a.tick(d);

      // Shimmer regenerates the tail an octave (and a twelfth) up and posts
      // it back into the tank, so every lap stacks another octave. The send
      // is a unit-norm draw off four lines — 0.5 = 1/sqrt(4) — which keeps
      // the loop gain a property of SHIM_FB alone instead of an accident of
      // how many lines happened to be tapped.
      const tail = (this.lineOut[1] + this.lineOut[3] + this.lineOut[4] + this.lineOut[6]) * 0.5;
      const send = flush(this.shimInLp.tick(this.shimInHp.tick(tail)));
      this.shiftOct.write(send);
      this.shift5th.write(send);
      const fifth = this.shimFifth.next();
      if (shim > 0.005) {
        let s = this.shiftOct.read();
        if (fifth > 0.001) {
          // Power-preserving morph, or INTERVAL would double as a loudness
          // switch and shove the loop gain up with it.
          s = Math.sqrt(1 - 0.5 * fifth) * s + Math.sqrt(0.5 * fifth) * this.shift5th.read();
        }
        s = this.shimHp.tick(this.shimLp.tick(s)) * SHIM_MAKEUP;
        // Each generation climbs an octave and loses more of itself to the
        // roll-off above, so the cascade is self-starving; the soft ceiling
        // is the backstop that keeps a 60-second tank from ever howling.
        d += softLimit(s * shim * SHIM_FB, 0.7);
      }

      // Read all 8 lines — ensemble-modulated, Hermite-interpolated.
      const depth = modAmt * this.p.modAmp;
      for (let k = 0; k < 8; k++) {
        let ph = this.modPhase[k] + (this.modRate[k] * this.p.modMul) / sr;
        if (ph >= 1) ph -= 1;
        this.modPhase[k] = ph;
        this.drift[k] += 0.00002 * ((Math.random() - 0.5) - this.drift[k] * 0.01);
        const wob = Math.sin(TWO_PI * ph) * depth * (k % 2 ? 0.75 : 1)
                  + clamp(this.drift[k] * 900, -4, 4) * (0.3 + modAmt);
        const at = clamp(this.lens[k] + wob, 4, this.lines[k].buf.length - 8);
        let y = this.lines[k].read(at);
        // Two-band decay: the low bed on its own clock.
        const lo = this.xover[k].tick(y);
        y = lo * this.gLo[k] + (y - lo) * this.gHi[k];
        y = this.damp[k].tick(y);
        this.lineOut[k] = this.loopAp[k].tick(y);
      }

      // Hadamard-8 butterfly (energy-preserving rotation of the tank).
      const o = this.lineOut, f = this.fbVec;
      const a0 = o[0] + o[1], a1 = o[0] - o[1], a2 = o[2] + o[3], a3 = o[2] - o[3];
      const a4 = o[4] + o[5], a5 = o[4] - o[5], a6 = o[6] + o[7], a7 = o[6] - o[7];
      const b0 = a0 + a2, b1 = a1 + a3, b2 = a0 - a2, b3 = a1 - a3;
      const b4 = a4 + a6, b5 = a5 + a7, b6 = a4 - a6, b7 = a5 - a7;
      const inv = 0.353553390593; // 1/sqrt(8)
      f[0] = (b0 + b4) * inv; f[1] = (b1 + b5) * inv; f[2] = (b2 + b6) * inv; f[3] = (b3 + b7) * inv;
      f[4] = (b0 - b4) * inv; f[5] = (b1 - b5) * inv; f[6] = (b2 - b6) * inv; f[7] = (b3 - b7) * inv;
      for (let k = 0; k < 8; k++)
        this.lines[k].write(f[k] + d * this.injectSign[k] * 0.32);

      // Decorrelated stereo draw + early reflections.
      let wl = (o[0] - o[2] + o[4] - o[6]) * 0.42 + erL;
      let wr = (o[1] - o[3] + o[5] - o[7]) * 0.42 + erR;
      wl = this.tiltHiL.tick(this.tiltLoL.tick(wl));
      wr = this.tiltHiR.tick(this.tiltLoR.tick(wr));
      wl = this.wetLpL.tick(this.wetHpL.tick(wl));
      wr = this.wetLpR.tick(this.wetHpR.tick(wr));

      let wetG = this.p.out * this.wetRamp;
      if (this.duckOn) {
        const dx = Math.max(Math.abs(dryRefL[i]), Math.abs(dryRefR[i]));
        this.duckEnv = dx > this.duckEnv ? dx + duckA * (this.duckEnv - dx) : dx + duckR * (this.duckEnv - dx);
        wetG *= 1 - clamp(this.duckEnv * 2.4, 0, 1) * 0.7;
      }
      L[i] += wl * mix * wetG;
      R[i] += wr * mix * wetG;
    }
  }

  reset() {
    for (const l of this.lines) l.reset();
    for (const a of this.loopAp) a.reset();
    for (const a of this.diff) a.reset();
    for (const a of this.chirp) a.reset();
    for (const d of this.damp) d.reset();
    for (const x of this.xover) x.reset();
    this.pre.reset();
    this.erBuf.reset();
    this.shiftOct.reset();
    this.shift5th.reset();
    this.shimInHp.reset(); this.shimInLp.reset();
    this.shimHp.reset(); this.shimLp.reset();
    this.lineOut.fill(0);
    this.drift.fill(0);
  }
}

/* ---------- studio strip: REMI 4000 channel EQ + 2026 FET comp ---------- */

class StudioEq {
  constructor(sr) {
    this.sr = sr;
    this.on = true;
    // HPF 18 dB/oct (3-pole butterworth-ish: biquad + one-pole).
    this.hpfBi = [new Biquad(), new Biquad()]; // stereo biquads
    this.hpf1 = [new OnePoleHP(), new OnePoleHP()];
    this.bands = { lf: [new Biquad(), new Biquad()], lmf: [new Biquad(), new Biquad()],
                   hmf: [new Biquad(), new Biquad()], hf: [new Biquad(), new Biquad()] };
    this.p = { hpf: 20, lf_g: 0, lf_f: 110, lmf_g: 0, lmf_f: 700,
               hmf_g: 0, hmf_f: 2400, hf_g: 0, hf_f: 8000, trim: 0 };
    this.trim = new Smooth(1, 20, sr);
    this.dirty = true;
  }
  set(id, v) {
    if (id === 'on') { this.on = v > 0.5; return; }
    if (id === 'trim') { this.trim.set(dbToGain(v)); return; }
    this.p[id] = v; this.dirty = true;
  }
  update() {
    const sr = this.sr, p = this.p;
    for (let c = 0; c < 2; c++) {
      this.hpfBi[c].highpass(p.hpf, 0.85, sr);
      this.hpf1[c].setFc(p.hpf, sr);
      this.bands.lf[c].lowshelf(p.lf_f, p.lf_g, sr);
      this.bands.lmf[c].peak(p.lmf_f, 0.75, p.lmf_g, sr);
      this.bands.hmf[c].peak(p.hmf_f, 0.85, p.hmf_g, sr);
      this.bands.hf[c].highshelf(p.hf_f, p.hf_g, sr);
    }
    this.hpfOn = p.hpf > 22;
    this.dirty = false;
  }
  process(L, R, n) {
    if (!this.on) return;
    if (this.dirty) this.update();
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      if (this.hpfOn) {
        l = this.hpf1[0].tick(this.hpfBi[0].tick(l));
        r = this.hpf1[1].tick(this.hpfBi[1].tick(r));
      }
      l = this.bands.hf[0].tick(this.bands.hmf[0].tick(this.bands.lmf[0].tick(this.bands.lf[0].tick(l))));
      r = this.bands.hf[1].tick(this.bands.hmf[1].tick(this.bands.lmf[1].tick(this.bands.lf[1].tick(r))));
      const t = this.trim.next();
      L[i] = l * t; R[i] = r * t;
    }
  }
}

// Blue-stripe FET compressor/limiter — program-dependent, ratio buttons, GR out.
class FetComp {
  constructor(sr) {
    this.sr = sr;
    this.on = true;
    this.input = new Smooth(0.5, 25, sr);   // 0..1 drives into the threshold
    this.output = new Smooth(0.5, 25, sr);
    this.attackK = new Smooth(0.35, 25, sr);  // 0..1 → 20..800 µs
    this.releaseK = new Smooth(0.4, 25, sr);  // 0..1 → 50..1100 ms
    this.mix = new Smooth(1, 25, sr);
    this.ratio = 4;
    this.env = 0;
    this.grDb = 0;
  }
  set(id, v) {
    if (id === 'on') this.on = v > 0.5;
    else if (id === 'input') this.input.set(v);
    else if (id === 'output') this.output.set(v);
    else if (id === 'attack') this.attackK.set(v);
    else if (id === 'release') this.releaseK.set(v);
    else if (id === 'mix') this.mix.set(v);
    else if (id === 'ratio') this.ratio = v;
  }
  process(L, R, n) {
    if (!this.on) { this.grDb = 0; return; }
    const sr = this.sr;
    for (let i = 0; i < n; i++) {
      const inG = dbToGain(-12 + this.input.next() * 30);   // -12..+18 dB into the FET
      const outG = dbToGain(-18 + this.output.next() * 30);
      const atkS = (0.00002 + Math.pow(this.attackK.next(), 2) * 0.00078);
      const relS = (0.05 + Math.pow(this.releaseK.next(), 1.5) * 1.05);
      const aA = Math.exp(-1 / (atkS * sr));
      const aR = Math.exp(-1 / (relS * sr));
      const mix = this.mix.next();
      const dl = L[i], dr = R[i];
      const x = Math.max(Math.abs(dl), Math.abs(dr)) * inG;
      this.env = x > this.env ? x + aA * (this.env - x) : x + aR * (this.env - x);
      const envDb = 20 * Math.log10(this.env + 1e-9);
      const threshDb = -16;
      let gr = 0;
      if (envDb > threshDb) gr = (envDb - threshDb) * (1 - 1 / this.ratio);
      if (gr > 30) gr = 30;
      this.grDb = Math.max(this.grDb * 0.999, gr);
      const g = dbToGain(-gr) * inG * outG;
      L[i] = dl * (1 - mix) + dl * g * mix;
      R[i] = dr * (1 - mix) + dr * g * mix;
    }
  }
}

/* ---------- SAUCE — the enhancer pedal ---------- */

class SaucePedal {
  constructor(sr) {
    this.sr = sr;
    this.on = false;
    this.k = { body: 0, sub: 0, tight: 0, tame: 0, smooth: 0, punch: 0, pres: 0, air: 0, mix: 1 };
    this.f = {};
    for (const name of ['body', 'sub', 'tame', 'smooth', 'pres', 'air'])
      this.f[name] = [new Biquad(), new Biquad()];
    this.tightHp = [new OnePoleHP(), new OnePoleHP()];
    this.fastEnv = 0; this.slowEnv = 0;
    this.mix = new Smooth(1, 30, sr);
    this.dirty = true;
    this.dryL = new Float32Array(128); this.dryR = new Float32Array(128);
  }
  set(id, v) {
    if (id === 'on') { this.on = v > 0.5; return; }
    if (id === 'mix') { this.k.mix = v; this.mix.set(v); return; }
    this.k[id] = v; this.dirty = true;
  }
  update() {
    const sr = this.sr, k = this.k;
    for (let c = 0; c < 2; c++) {
      this.f.body[c].peak(180, 0.9, k.body * 6, sr);
      this.f.sub[c].lowshelf(65, k.sub * 6, sr);
      this.f.tame[c].peak(3000, 0.8, -k.tame * 8, sr);
      this.f.smooth[c].peak(6500, 0.9, -k.smooth * 8, sr);
      this.f.pres[c].highshelf(3500, k.pres * 5, sr);
      this.f.air[c].highshelf(12000, k.air * 6, sr);
      this.tightHp[c].setFc(20 + k.tight * 110, sr);
    }
    this.dirty = false;
  }
  process(L, R, n) {
    if (!this.on) return;
    if (this.dirty) this.update();
    const sr = this.sr, k = this.k;
    const aF = Math.exp(-1 / (0.0008 * sr)), aS = Math.exp(-1 / (0.05 * sr));
    this.dryL.set(L.subarray(0, n)); this.dryR.set(R.subarray(0, n));
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      l = this.tightHp[0].tick(l); r = this.tightHp[1].tick(r);
      // PUNCH: transient lift from fast-vs-slow envelope difference.
      if (k.punch > 0.01) {
        const x = Math.max(Math.abs(l), Math.abs(r));
        this.fastEnv = x > this.fastEnv ? x + aF * (this.fastEnv - x) : x + aS * (this.fastEnv - x);
        this.slowEnv = x + aS * (this.slowEnv - x);
        const tr = clamp((this.fastEnv - this.slowEnv) * 4, 0, 1);
        const g = 1 + tr * k.punch * 1.2;
        l *= g; r *= g;
      }
      l = this.f.air[0].tick(this.f.pres[0].tick(this.f.smooth[0].tick(this.f.tame[0].tick(this.f.sub[0].tick(this.f.body[0].tick(l))))));
      r = this.f.air[1].tick(this.f.pres[1].tick(this.f.smooth[1].tick(this.f.tame[1].tick(this.f.sub[1].tick(this.f.body[1].tick(r))))));
      const m = this.mix.next();
      L[i] = this.dryL[i] * (1 - m) + l * m;
      R[i] = this.dryR[i] * (1 - m) + r * m;
    }
  }
}

/* ---------- looper + metronome (practice section) ---------- */

// Two-partial "wood click" metronome — a tuned ping (accented downbeat a
// fifth up) with a soft noise transient, exponential decay. Musical, not harsh.
class Metronome {
  constructor(sr) {
    this.sr = sr;
    this.gain = 0.7;
    this.phase = 0; this.phase2 = 0;
    this.env = 0; this.noiseEnv = 0;
    this.freq = 1046.5;
    this.envDecay = Math.exp(-1 / (0.055 * sr));
    this.noiseDecay = Math.exp(-1 / (0.0035 * sr));
    this.lp = new OnePoleLP();
    this.lp.setFc(6500, sr);
  }
  trigger(accent) {
    this.env = 1; this.noiseEnv = 1;
    this.freq = accent ? 1568 : 1046.5; // G6 / C6
    this.phase = 0; this.phase2 = 0;
  }
  tick() {
    if (this.env < 1e-4 && this.noiseEnv < 1e-4) return 0;
    this.phase += TWO_PI * this.freq / this.sr;
    this.phase2 += TWO_PI * this.freq * 2.42 / this.sr;
    const tone = (Math.sin(this.phase) + Math.sin(this.phase2) * 0.35) * this.env;
    const click = (Math.random() - 0.5) * this.noiseEnv * 0.7;
    this.env *= this.envDecay;
    this.noiseEnv *= this.noiseDecay;
    return this.lp.tick(tone * 0.55 + click) * this.gain;
  }
}

// MULTI-TRACK LOOPER on the FINAL rig output. The first pass sets the loop
// length; every pass after that is an OVERDUB that arms instantly and starts
// recording at the next top of the loop, so layers always line up. Tracks
// play stacked and can be deleted individually.
//
// The metronome rides the count-in and the record passes (and can run free
// for practice) but is mixed in AFTER the capture tap, so clicks are never
// printed into a track.
//
// ── ALIGNMENT, and why a take lands late ───────────────────────────────────
//
// This clock is sample-exact and always was: the count-in hands over to `rec`
// on the very sample the downbeat is generated, and the loop length is a whole
// number of samples per beat. And takes still came back late, because none of
// that is where the delay lives.
//
// Follow one note. The metronome click for the downbeat is generated HERE, at
// worklet time T. The player does not hear it at T — they hear it at
// T + outputLatency, once it has been through the device buffer and the
// converter. They play in response, perfectly, at T + outputLatency. That note
// goes down the cable, through their interface's own buffer and back up into
// this worklet, arriving at T + outputLatency + inputLatency. So a flawlessly
// timed note is written `roundTrip` samples past the downbeat it belongs on,
// and every overdub inherits the same shift again.
//
// Nothing in the browser can remove that delay — it is the price of the round
// trip through real hardware. But it is a CONSTANT, so it can be taken back
// out on the way to the speakers: the loop is read `align` samples ahead of
// the grid, which puts the note back on the beat the player meant.
//
// Two consequences shape the code below.
//
// It is applied on PLAYBACK, not on the way in, so the takes on disk stay
// exactly what came off the guitar and the figure can be changed — and heard —
// after the fact. A player nudging it until the loop locks is adjusting every
// layer they have already recorded, live, not re-recording them.
//
// And every take over-records a TAIL past the loop top. Reading ahead means
// the last `align` samples of the cycle come from after the grid ended; with
// no tail they would wrap round to the count-in and swallow the attack of a
// note played right on the final beat.

class Looper {
  constructor(sr, port) {
    this.sr = sr;
    this.port = port;
    this.state = 'idle';       // idle | count | rec | play
    this.armed = false;        // overdub queued for the next loop top
    this.bars = 4;
    this.countBars = 2;
    this.beatsPerBar = 4;
    this.bpm = 120;
    this.clickOn = true;
    this.freeMetro = false;
    this.metro = new Metronome(sr);
    this.tracks = [];          // { id, bufL, bufR, gain, muted }
    this.nextId = 1;
    this.rec = null;           // the track being written
    this.len = 0;              // loop length in samples (set by track 1)
    this.recPos = 0;
    this.playPos = 0;
    this.spb = Math.round(sr * 60 / this.bpm);
    this.beatSample = 0;
    this.beatIndex = 0;
    this.fade = Math.min(192, Math.round(sr * 0.004)); // 4 ms seam fade
    // ~15 ms one-pole toward the LEVEL/PAN targets — fast enough to feel
    // instant on the knob, slow enough that no step is ever audible.
    this.mixSm = 1 - Math.exp(-1 / (0.015 * sr));
    // How far ahead of the grid playback reads, to take the round trip back
    // out. Set from the main thread; 0 until somebody says otherwise.
    this.align = 0;
    // How far past the loop top every take keeps recording, so reading ahead
    // has real audio to read. 250 ms covers any round trip a browser will
    // ever see and costs ~3 % of a four-bar buffer.
    this.tail = Math.round(sr * 0.25);
    this.tailN = this.tail;   // sized to the loop by sizeTail()
  }

  /** Clamp an alignment to what the recorded tail can actually serve. */
  setAlign(samples) {
    const s = Math.round(samples) | 0;
    this.align = clamp(s, -this.tailN, this.tailN);
  }

  /** Fix the tail to this loop length. Never more than half a cycle: a tail
   *  longer than the loop it hangs off could be read past a whole cycle, and
   *  a take would still be taking it when the next one is due to start. */
  sizeTail() {
    this.tailN = this.len > 0 ? Math.min(this.tail, this.len >> 1) : this.tail;
    this.setAlign(this.align);   // re-clamp: the ceiling may have just dropped
  }

  /** The loop seam, as a gain on the CYCLE position rather than something
   *  baked into each buffer. It has to be this way round now: the read offset
   *  moves where a buffer's own edges land, so a fade multiplied in at record
   *  time would slide into the middle of the loop and dip there instead. */
  seamGain(p) {
    const f = Math.min(this.fade, this.len >> 1);
    if (f < 1) return 1;
    if (p < f) return p / f;
    const j = this.len - 1 - p;
    return j < f ? j / f : 1;
  }

  /** Where in a take's buffer the cycle position `p` reads from. */
  readAt(p) {
    let i = p + this.align;
    // Behind the start wraps to the previous cycle, which is real recorded
    // audio. Ahead of the end lands in the tail, which is why it exists.
    if (i < 0) i += this.len;
    return i;
  }

  setOpt(id, v) {
    if (id === 'bars') this.bars = v | 0;
    else if (id === 'countin') this.countBars = v | 0;
  }
  setMetro(id, v) {
    if (id === 'on') {
      this.freeMetro = v > 0.5;
      if (this.freeMetro && this.state === 'idle') { this.beatSample = 0; this.beatIndex = -1; }
    } else if (id === 'gain') this.metro.gain = v;
    else if (id === 'bpm') { this.bpm = v; if (this.state === 'idle' && !this.tracks.length) this.spb = Math.round(this.sr * 60 / v); }
  }

  cmd(m) {
    if (m.cmd === 'arm') {
      this.bpm = m.bpm || this.bpm;
      if (m.bars) this.bars = m.bars;
      if (m.countBars !== undefined) this.countBars = m.countBars;
      if (this.tracks.length) {
        // OVERDUB: the loop is already turning — queue for the next top so
        // the new layer starts exactly on the one.
        this.armed = true;
        this.post();
      } else {
        this.spb = Math.round(this.sr * 60 / this.bpm);
        this.len = this.bars * this.beatsPerBar * this.spb;
        this.sizeTail();
        this.openTrack();
        this.beatSample = 0;
        this.beatIndex = -1;
        this.state = this.countBars > 0 ? 'count' : 'rec';
        this.post();
      }
    } else if (m.cmd === 'align') {
      // Live: every layer already recorded slides with it, which is the whole
      // point — the figure is dialled in by ear against takes that exist.
      this.setAlign(m.samples || 0);
      this.post();
    } else if (m.cmd === 'stop') {
      // cancel whatever is pending / in progress, keep finished tracks
      this.armed = false;
      if (this.rec) this.closeTrack();
      this.state = this.tracks.length ? 'play' : 'idle';
      this.post();
    } else if (m.cmd === 'play') {
      if (this.tracks.length) { this.state = 'play'; this.post(); }
    } else if (m.cmd === 'pause') {
      if (this.state === 'play') { this.state = 'idle'; this.post(); }
    } else if (m.cmd === 'delete') {
      // A take still collecting its tail is in `tracks` AND in `rec`; dropping
      // it from one without the other leaves the record head writing into a
      // buffer nothing will ever play.
      if (this.rec && this.rec.id === m.id) this.rec = null;
      this.tracks = this.tracks.filter((t) => t.id !== m.id);
      if (!this.tracks.length) { this.len = 0; this.playPos = 0; this.state = 'idle'; this.armed = false; }
      this.post();
    } else if (m.cmd === 'mute') {
      const t = this.tracks.find((x) => x.id === m.id);
      if (t) t.muted = !!m.muted;
      this.post();
    } else if (m.cmd === 'mix') {
      // LEVEL / PAN for one layer. Only the targets move here — the gains the
      // playback loop actually reads are smoothed toward them, so a knob turn
      // mid-loop never steps and never clicks.
      const t = this.tracks.find((x) => x.id === m.id);
      if (t) {
        if (m.gain !== undefined) t.gain = clamp(m.gain, 0, 1.5);
        if (m.pan !== undefined) t.pan = clamp(m.pan, -1, 1);
        this.retarget(t);
        this.post();
      }
    } else if (m.cmd === 'export') {
      this.exportMix();
    } else if (m.cmd === 'clear') {
      this.tracks = []; this.rec = null; this.len = 0;
      this.playPos = 0; this.state = 'idle'; this.armed = false;
      this.post();
    }
  }

  /** len + tail: the extra is what a read-ahead alignment lands in. */
  openTrack() {
    const n = this.len + this.tailN;
    this.rec = { id: this.nextId++, bufL: new Float32Array(n),
                 bufR: new Float32Array(n), gain: 1, pan: 0, muted: false,
                 tgtL: 1, tgtR: 1, gL: 1, gR: 1 };
    this.recPos = 0;
  }

  /** Fold LEVEL and PAN into the two side gains the mixer reads.
   *
   *  The law is a balance, not a constant-power pan: the layers are already
   *  stereo (the delay and reverb put them there), and every one of them sums
   *  into the same bus. A constant-power law would push a hard-panned side to
   *  +3 dB, which is exactly the wrong direction when eight passes are
   *  stacking into one soft limiter. Centre is unity on both sides; turning
   *  the knob only ever takes level away from the far side. */
  retarget(t) {
    t.tgtL = t.gain * Math.min(1, 1 - t.pan);
    t.tgtR = t.gain * Math.min(1, 1 + t.pan);
  }

  /** The grid has come round: the take becomes a layer and starts turning.
   *
   *  It is NOT finished — `this.rec` still points at it and it keeps taking
   *  its tail for another `tail` samples. Publishing here rather than when the
   *  buffer is full is what keeps the loop locked to the metronome: the cycle
   *  has to start on the grid, not a quarter of a second after it. Nothing is
   *  read from the tail region until a whole cycle later, so it is always
   *  written long before anything asks for it. */
  publishTake() {
    const t = this.rec;
    if (!t) return;
    this.tracks.push(t);
    this.state = 'play';
    this.post();
  }

  /** The tail is in. Publish the waveform and let go of the take. */
  finishTake() {
    const t = this.rec;
    this.rec = null;
    if (!t) return;
    this.port.postMessage({ type: 'wave', trackId: t.id, ...this.peaksOf(t) }, []);
    this.post();
  }

  /** Abandon a take mid-flight. Whatever it caught is kept — a cancelled pass
   *  is still a pass somebody played — with the rest left silent. */
  closeTrack() {
    const t = this.rec;
    if (!t) return;
    // Only a take cut short of a full cycle needs silencing. One stopped while
    // it was collecting its tail is a COMPLETE take — blanking what it already
    // has would punch a hole in the end of a loop that is otherwise finished.
    if (this.recPos < this.len) {
      for (let i = this.recPos; i < t.bufL.length; i++) { t.bufL[i] = 0; t.bufR[i] = 0; }
    }
    if (!this.tracks.includes(t)) this.tracks.push(t);
    this.rec = null;
    this.port.postMessage({ type: 'wave', trackId: t.id, ...this.peaksOf(t) }, []);
    this.state = 'play';
    this.post();
  }

  /** Bounce the stack to one stereo pair for download.
   *
   *  This is the mix the player hears, not the raw takes: each layer arrives
   *  through its own LEVEL and PAN, muted layers are left out, and the sum
   *  goes through the same soft limiter the live path uses — so the file is
   *  the sound that was in the room rather than a hotter one that never was.
   *  The buffers are transferred, not copied; they are throwaways built here. */
  exportMix() {
    if (!this.tracks.length || !this.len) {
      this.port.postMessage({ type: 'export', empty: true });
      return;
    }
    const n = this.len;
    const L = new Float32Array(n), R = new Float32Array(n);
    let used = 0;
    for (const t of this.tracks) {
      if (t.muted) continue;
      used++;
      // Through the same read offset the speakers get, or the file would be
      // the take that sounded late rather than the loop that sounded right.
      for (let i = 0; i < n; i++) {
        const j = this.readAt(i);
        L[i] += t.bufL[j] * t.tgtL;
        R[i] += t.bufR[j] * t.tgtR;
      }
    }
    for (let i = 0; i < n; i++) {
      const s = this.seamGain(i);
      L[i] = softLimit(L[i], 0.85) * s;
      R[i] = softLimit(R[i], 0.85) * s;
    }
    this.port.postMessage(
      { type: 'export', L, R, sampleRate: this.sr, bpm: this.bpm, bars: this.bars, tracks: used },
      [L.buffer, R.buffer],
    );
  }

  /** Min/max pyramid of the mono sum, for the UI lane.
   *
   *  The RAW take over one cycle, with no alignment applied — the lane slides
   *  the picture by the same offset on its own. Re-binning here on every drag
   *  of the align control would be hundreds of thousands of samples per track
   *  on the audio thread, which is exactly where that work must not happen. */
  peaksOf(t) {
    const bins = 600;
    const peaks = new Float32Array(bins * 2);
    const per = this.len / bins;
    for (let b = 0; b < bins; b++) {
      let lo = 0, hi = 0;
      const s = Math.floor(b * per), e = Math.min(this.len, Math.ceil((b + 1) * per));
      for (let i = s; i < e; i++) {
        const v = (t.bufL[i] + t.bufR[i]) * 0.5;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      peaks[b * 2] = lo; peaks[b * 2 + 1] = hi;
    }
    return { peaks, bins, bars: this.bars, bpm: this.bpm };
  }

  post(extra) {
    this.port.postMessage({
      type: 'looper', state: this.state, armed: this.armed,
      beat: this.beatIndex, beatsPerBar: this.beatsPerBar,
      countBeats: this.countBars * this.beatsPerBar,
      bars: this.bars, bpm: this.bpm,
      // The tempo the loop is actually TURNING at, read off the frozen
      // samples-per-beat rather than off this.bpm — which follows whatever
      // the rig's tempo control says and stops describing the loop the
      // moment a preset moves it.
      loopBpm: this.spb ? 60 * this.sr / this.spb : this.bpm,
      // The alignment the worklet actually settled on, and the cycle it is a
      // fraction of — the lane needs both to slide its waveform to match.
      align: this.align, len: this.len, tail: this.tailN,
      tracks: this.tracks.map((t) => ({ id: t.id, muted: t.muted, gain: t.gain, pan: t.pan })),
      ...extra,
    });
  }

  process(L, R, n) {
    const counting = this.state === 'count';
    const recording = this.state === 'rec';
    const playing = this.state === 'play';
    const clockOn = counting || recording || playing;
    const freeTick = this.freeMetro && !clockOn;

    for (let i = 0; i < n; i++) {
      // ── the clock ──────────────────────────────────────────────
      if (clockOn || freeTick) {
        if (this.beatSample === 0) {
          this.beatIndex++;
          const inBar = this.beatIndex % this.beatsPerBar;
          if ((counting || recording) ? this.clickOn : this.freeMetro) this.metro.trigger(inBar === 0);
          if (counting && this.beatIndex >= this.countBars * this.beatsPerBar) {
            this.state = 'rec';
            this.recPos = 0;
          }
          if (counting || recording) this.post();
        }
        if (++this.beatSample >= this.spb) this.beatSample = 0;
      }

      // ── capture the finished rig sound ─────────────────────────
      // Driven off `this.rec`, not off the state: a take stays open past the
      // loop top to collect its tail, by which point the state is 'play'.
      if (this.rec) {
        this.rec.bufL[this.recPos] = L[i];
        this.rec.bufR[this.recPos] = R[i];
        this.recPos++;
        if (this.recPos === this.len) {
          // Only the FIRST take starts the cycle. On an overdub the loop is
          // already turning and playPos is already 0 — reassigning it here
          // would land before the playback block on the same sample and make
          // the cycle read index 0 twice, dropping its last sample every pass.
          const first = this.tracks.length === 0;
          this.publishTake();
          if (first) this.playPos = 0;
        } else if (this.recPos >= this.len + this.tailN) {
          this.finishTake();
        }
      }

      // ── stacked playback ───────────────────────────────────────
      if ((this.state === 'play' || this.state === 'rec') && this.tracks.length && this.len) {
        // Read ahead of the grid by the alignment, so what the player meant to
        // land on this beat does. One index and one seam gain for the whole
        // stack — every layer shares the cycle.
        const idx = this.readAt(this.playPos);
        const seam = this.seamGain(this.playPos);
        let sl = 0, sr2 = 0;
        for (let k = 0; k < this.tracks.length; k++) {
          const t = this.tracks[k];
          // Muted layers still smooth toward zero rather than dropping out on
          // a sample boundary, so M is a fade, not a click.
          const wantL = t.muted ? 0 : t.tgtL, wantR = t.muted ? 0 : t.tgtR;
          t.gL += (wantL - t.gL) * this.mixSm;
          t.gR += (wantR - t.gR) * this.mixSm;
          if (t.gL < 1e-5 && t.gR < 1e-5) continue;
          sl += t.bufL[idx] * t.gL;
          sr2 += t.bufR[idx] * t.gR;
        }
        // Layers sum; ride the stack so eight passes never wreck the mix.
        L[i] += softLimit(sl, 0.85) * seam;
        R[i] += softLimit(sr2, 0.85) * seam;
        if (++this.playPos >= this.len) {
          this.playPos = 0;
          // top of the loop: a queued overdub starts here, sample-exact
          if (this.armed) {
            this.armed = false;
            // The previous take may still be collecting its tail. It gives up
            // the rest of it rather than pushing the overdub back a whole
            // cycle — "starts on the next top" is the promise the looper makes
            // and it outranks the last few milliseconds of a tail nobody has
            // asked to hear yet.
            if (this.rec) this.finishTake();
            this.openTrack();
            this.state = 'rec';
            this.post();
          }
        }
      }

      const c = this.metro.tick();
      if (c !== 0) { L[i] += c; R[i] += c; }
    }
  }
}

/* ---------- the two chain stages ---------- */

// stage 'pre'  (mono):  input trim → gate → comp → drive → capture-in trim
// stage 'post' (stereo): tone stack → master → sauce → studio EQ → FET comp
//                        → chorus → delay block → reverb → output → meters
class RemiChainProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = sampleRate;
    this.stage = options?.processorOptions?.stage || 'post';
    this.inGain = new Smooth(1, 20, sr);
    this.outGain = new Smooth(1, 20, sr);
    this.meterCount = 0;
    this.peakIn = 0; this.peakOut = 0; this.peakRawOut = 0;
    if (this.stage === 'pre') {
      this.gate = new NoiseGate(sr);
      this.comp = new StompComp(sr);
      this.drive = new DrivePedal(sr);
      this.captureIn = new Smooth(1, 20, sr);
    } else {
      this.tone = new ToneStack(sr);
      this.master = new Smooth(1, 20, sr); // neutral at its 0.7 default
      this.ampTrim = new Smooth(1, 20, sr);
      this.ampOn = true;
      this.sauce = new SaucePedal(sr);
      this.eq = new StudioEq(sr);
      this.fet = new FetComp(sr);
      this.studioOn = true;
      this.chorus = new BbdChorus(sr);
      this.delay = new DelayBlock(sr);
      this.reverb = new VastSkyReverb(sr);
      this.looper = new Looper(sr, this.port);
      this.bufL = new Float32Array(128);
      this.bufR = new Float32Array(128);
    }
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (m.type === 'param') this.setParam(m.id, m.v);
    else if (m.type === 'params') for (const [id, v] of m.list) this.setParam(id, v);
    else if (m.type === 'looper-cmd' && this.stage === 'post') this.looper.cmd(m);
    else if (m.type === 'reset' && this.stage === 'post') {
      this.delay.A.reset(); this.delay.B.reset(); this.reverb.reset();
    }
  }

  setParam(id, v) {
    const dot = id.indexOf('_');
    const head = dot < 0 ? id : id.slice(0, dot);
    const rest = dot < 0 ? '' : id.slice(dot + 1);
    if (this.stage === 'pre') {
      switch (head) {
        case 'in': this.inGain.set(dbToGain(v)); return;
        case 'gate': this.gate.set(rest, v); return;
        case 'comp': this.comp.set(rest, v); return;
        case 'drive': this.drive.set(rest, v); return;
        case 'amp': if (rest === 'gain') this.captureIn.set(dbToGain((v - 0.45) * 24)); return;
      }
    } else {
      switch (head) {
        // +2 dB fixed make-up, MEASURED against the demo track: the web chain
        // runs hotter than the plugin's (-18 anchor + its own staging), so the
        // plugin's +4 was too much here — at +6 the whole bank pre-ceiling
        // peaked 1.0-2.0 (the Airship clipping bug). +2 lands the bank median
        // at ~0.8 peak. The knob still reads 0 dB; the ceiling below stays.
        case 'out': this.outGain.set(dbToGain(v + 2)); return;
        case 'amp':
          // (v-0.7)*20 dB — the PLUGIN's AmpVoicing master curve. This ran
          // *30 here, so the same preset value trimmed 1.5x harder on the
          // web; shared presets must mean the same dB on both platforms.
          if (rest === 'master') this.master.set(dbToGain((v - 0.7) * 20));
          else if (rest === 'output') this.ampTrim.set(dbToGain((v - 0.5) * 24));
          else if (rest === 'on') this.ampOn = v > 0.5;
          else this.tone.set(rest, v);
          return;
        case 'sauce': this.sauce.set(rest, v); return;
        case 'eq': this.eq.set(rest, v); return;
        case 'fet': this.fet.set(rest, v); return;
        case 'studio':
          if (rest === 'on') { this.eq.set('on', v); this.fet.set('on', v); }
          return;
        case 'cho': this.chorus.set(rest, v); return;
        // 'dlyA_time' splits at the FIRST underscore → head 'dlyA', not 'dly'.
        case 'dlyA': this.delay.A.set(rest, v); return;
        case 'dlyB': this.delay.B.set(rest, v); return;
        case 'dly': this.delay.set(rest, v); return;
        case 'rvb': this.reverb.set(rest, v); return;
        case 'loop': this.looper.setOpt(rest, v); return;
        case 'metro': this.looper.setMetro(rest, v); return;
      }
    }
  }

  process(inputs, outputs) {
    const inp = inputs[0];
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const n = out[0].length;

    if (this.stage === 'pre') {
      const o = out[0];
      const x = inp && inp[0] ? inp[0] : null;
      if (x) o.set(x); else o.fill(0);
      let pk = 0;
      for (let i = 0; i < n; i++) {
        o[i] *= this.inGain.next();
        const a = Math.abs(o[i]);
        if (a > pk) pk = a;
      }
      this.peakIn = Math.max(this.peakIn, pk);
      // Mono chain: the modules are written stereo, so feed a scratch copy as
      // the right channel — passing the same array twice would apply every
      // gain twice.
      if (!this.scratch) this.scratch = new Float32Array(n);
      this.scratch.set(o.subarray(0, n));
      this.gate.process(o, this.scratch, n);
      this.comp.process(o, this.scratch, n);
      this.drive.process(o, this.scratch, n);
      for (let i = 0; i < n; i++) o[i] *= this.captureIn.next();
      if (out.length > 1) out[1].set(o);
    } else {
      const L = this.bufL, R = this.bufR;
      const iL = inp && inp[0] ? inp[0] : null;
      const iR = inp && inp.length > 1 ? inp[1] : iL;
      if (iL) { L.set(iL); R.set(iR || iL); } else { L.fill(0); R.fill(0); }
      if (this.ampOn) {
        this.tone.process(L, R, n);
        for (let i = 0; i < n; i++) {
          const m = this.master.next() * this.ampTrim.next();
          L[i] *= m; R[i] *= m;
        }
      }
      this.sauce.process(L, R, n);
      this.eq.process(L, R, n);
      this.fet.process(L, R, n);
      this.chorus.process(L, R, n);
      this.delay.process(L, R, n);
      this.reverb.process(L, R, n, L, R);
      for (let i = 0; i < n; i++) {
        const g = this.outGain.next();
        // Soft safety ceiling, matched to the plugin standalone's: this buffer
        // feeds the DAC, which hard-clips at ±1.0 — the old ±1.2 threshold let
        // 0..+1.6 dB overs through as digital hash. Bit-transparent below the
        // 0.82 knee; above it the top rounds into a ~-0.1 dBFS ceiling.
        let l = L[i] * g, r = R[i] * g;
        const KNEE = 0.82, CEIL = 0.988, RANGE = CEIL - KNEE;
        const al = Math.abs(l), ar = Math.abs(r);
        // Pre-ceiling peak: what the level WOULD be — the meters report it so
        // loudness QA (and a future "too hot" lamp) can see real overs even
        // though the ceiling stops them from ever reaching the DAC.
        const raw = al > ar ? al : ar;
        if (raw > this.peakRawOut) this.peakRawOut = raw;
        if (al > KNEE) l = Math.sign(l) * (KNEE + RANGE * Math.tanh((al - KNEE) / RANGE));
        if (ar > KNEE) r = Math.sign(r) * (KNEE + RANGE * Math.tanh((ar - KNEE) / RANGE));
        L[i] = l; R[i] = r;
      }
      // Looper taps the finished rig sound, then adds loop + click on top.
      this.looper.process(L, R, n);
      let pk = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
        if (a > pk) pk = a;
      }
      out[0].set(L.subarray(0, n));
      if (out.length > 1) out[1].set(R.subarray(0, n));
      this.peakOut = Math.max(this.peakOut, pk);
    }

    // Meter frames every ~16 ms.
    if (++this.meterCount >= 6) {
      this.meterCount = 0;
      if (this.stage === 'pre') {
        this.port.postMessage({
          type: 'meters', in: this.peakIn, gate: this.gate.gr, compGr: this.comp.grDb,
        });
        this.peakIn = 0;
      } else {
        const lp = this.looper;
        this.port.postMessage({
          type: 'meters', out: this.peakOut, outRaw: this.peakRawOut, gr: this.fet.grDb,
          loopState: lp.state,
          loopPos: lp.len ? (lp.state === 'rec' ? lp.recPos : lp.playPos) / lp.len : 0,
        });
        this.peakOut = 0;
        this.peakRawOut = 0;
        this.fet.grDb *= 0.6;
      }
    }
    return true;
  }
}

registerProcessor('remi-chain', RemiChainProcessor);
