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

// Op-amp diode-feedback drive: gain-dependent knee, tilt tone, ADAA clip.
class DrivePedal {
  constructor(sr) {
    this.sr = sr;
    this.on = false;
    this.gain = new Smooth(0.35, 20, sr);
    this.tone = new Smooth(0.5, 20, sr);
    this.level = new Smooth(0.5, 20, sr);
    this.clipL = new AdaaTanh(); this.clipR = new AdaaTanh();
    this.hpL = new OnePoleHP(); this.hpR = new OnePoleHP();
    this.lpL = new OnePoleLP(); this.lpR = new OnePoleLP();
    this.hpL.setFc(35, sr); this.hpR.setFc(35, sr);
    this.toneZ = -1;
  }
  set(id, v) {
    if (id === 'on') this.on = v > 0.5;
    else if (id === 'gain') this.gain.set(v);
    else if (id === 'tone') this.tone.set(v);
    else if (id === 'level') this.level.set(v);
    else if (id === 'air') {
      if (!this.airL) { this.airL = new Biquad(); this.airR = new Biquad(); }
      this.airL.highshelf(7500, (v - 0.5) * 12, this.sr);
      this.airR.highshelf(7500, (v - 0.5) * 12, this.sr);
      this.airOn = Math.abs(v - 0.5) > 0.01;
    }
  }
  process(L, R, n) {
    if (!this.on) return;
    for (let i = 0; i < n; i++) {
      const d = this.gain.next();
      const t = this.tone.next();
      if (Math.abs(t - this.toneZ) > 1e-3) {
        const fc = 750 * Math.pow(2, t * 4.2); // 750 Hz .. 13.8 kHz
        this.lpL.setFc(fc, this.sr); this.lpR.setFc(fc, this.sr);
        this.toneZ = t;
      }
      const pre = 1 + d * d * 55;              // up to ~35 dB, square-law feel
      const comp = 1 / Math.pow(pre, 0.62);    // knee moves, level stays put
      const lv = dbToGain(-6) * (0.25 + this.level.next() * 1.5);
      let l = this.lpL.tick(this.clipL.tick(this.hpL.tick(L[i]) * pre)) * comp * lv;
      let r = this.lpR.tick(this.clipR.tick(this.hpR.tick(R[i]) * pre)) * comp * lv;
      if (this.airOn) { l = this.airL.tick(l); r = this.airR.tick(r); }
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

// One delay engine — Digital / Studio / Analog / Tape voicings, in-loop
// saturation + compounding HF loss, diffusion smear, wow & flutter, ducking.
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
    this.fbL = 0; this.fbR = 0;
    // In-loop tone: compounding darkness + grit saturation + diffusion smear.
    this.loopLpL = new OnePoleLP(); this.loopLpR = new OnePoleLP();
    this.loopHpL = new OnePoleHP(); this.loopHpR = new OnePoleHP();
    this.loopHpL.setFc(90, sr); this.loopHpR.setFc(90, sr);
    this.satL = new AdaaTanh(); this.satR = new AdaaTanh();
    this.hicutL = new OnePoleLP(); this.hicutR = new OnePoleLP();
    this.hicutL.setFc(9000, sr); this.hicutR.setFc(9000, sr);
    this.difL = [new Allpass(0.0079 * sr, 0.52), new Allpass(0.0123 * sr, 0.48)];
    this.difR = [new Allpass(0.0091 * sr, 0.52), new Allpass(0.0137 * sr, 0.48)];
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
    this.flutterZ = 0; this.wowZ = 0;
    this.duckEnv = 0;
    this.hiss = 0;
    this.applyMode();
  }
  applyMode() {
    const sr = this.sr;
    const fcBase = [16000, 11500, 3400, 5200][this.mode];
    const g = this.grit.get();
    const fc = fcBase * Math.pow(0.45, g);
    this.loopLpL.setFc(fc, sr); this.loopLpR.setFc(fc, sr);
    this.diffAmt = [0.0, 0.55, 0.25, 0.45][this.mode];
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
    const isTape = this.mode === 3, isAnalog = this.mode === 2, isDigital = this.mode === 0;
    const duckA = Math.exp(-1 / (0.004 * sr)), duckR = Math.exp(-1 / (0.35 * sr));
    for (let i = 0; i < n; i++) {
      const g = this.grit.next();
      if (Math.abs(g - this.lastGrit) > 0.01) this.applyMode();
      const t = this.timeMs.next();
      const fb = this.fb.next();
      const mix = this.mix.next();
      const modD = this.modDepth.next();
      // LFO + tape wow/flutter (random component).
      this.lfoPhase += this.modRate / sr;
      if (this.lfoPhase >= 1) this.lfoPhase -= 1;
      let modMs = Math.sin(TWO_PI * this.lfoPhase) * modD * (isTape ? 2.6 : 1.8);
      if (isTape) {
        this.flutterZ += 0.002 * ((Math.random() - 0.5) - this.flutterZ);
        this.wowZ += 0.00012 * ((Math.random() - 0.5) * 2 - this.wowZ);
        modMs += this.flutterZ * 14 * (0.3 + modD) + this.wowZ * 260 * (0.3 + modD);
      } else if (isAnalog) {
        this.flutterZ += 0.0006 * ((Math.random() - 0.5) - this.flutterZ);
        modMs += this.flutterZ * 6;
      }
      const off = this.offsetMs * 0.5;
      const dSampL = clamp((t + modMs - off) * 0.001 * sr, 8, this.dL.buf.length - 8);
      const dSampR = clamp((t + modMs + off) * 0.001 * sr, 8, this.dR.buf.length - 8);
      let echoL = this.dL.read(dSampL);
      let echoR = this.dR.read(dSampR);
      // Ducking (dry side-chain).
      const dx = Math.max(Math.abs(dryRefL[i]), Math.abs(dryRefR[i]));
      this.duckEnv = dx > this.duckEnv ? dx + duckA * (this.duckEnv - dx) : dx + duckR * (this.duckEnv - dx);
      const duckAmt = this.duck.next();
      const duckG = 1 - duckAmt * clamp(this.duckEnv * 2.6, 0, 1) * 0.85;
      // Feedback into the loop: saturate → darken → (tape body) → diffuse.
      const drive = 1 + g * 5 + (isTape ? 0.8 : 0) + (isAnalog ? 0.5 : 0);
      const norm = 1 / Math.pow(drive, 0.55);
      let fbInL = this.satL.tick((this.pingpong ? echoR : echoL) * fb * drive) * norm;
      let fbInR = this.satR.tick((this.pingpong ? echoL : echoR) * fb * drive) * norm;
      fbInL = this.hicutL.tick(this.loopLpL.tick(this.loopHpL.tick(fbInL)));
      fbInR = this.hicutR.tick(this.loopLpR.tick(this.loopHpR.tick(fbInR)));
      if (isTape) { fbInL = this.bumpL.tick(fbInL); fbInR = this.bumpR.tick(fbInR); }
      const dAmt = this.diffAmt * (0.5 + g * 0.5);
      if (!isDigital && dAmt > 0.01) {
        fbInL = fbInL + dAmt * (this.difL[1].tick(this.difL[0].tick(fbInL)) - fbInL);
        fbInR = fbInR + dAmt * (this.difR[1].tick(this.difR[0].tick(fbInR)) - fbInR);
      }
      if (isTape && g > 0.05) { // hiss rides the repeats only
        const h = (Math.random() - 0.5) * 0.00035 * g;
        fbInL += h; fbInR -= h;
      }
      this.dL.write(L[i] + fbInL);
      this.dR.write(R[i] + fbInR);
      let wl = this.wetLpL.tick(this.wetHpL.tick(echoL));
      let wr = this.wetLpR.tick(this.wetHpR.tick(echoR));
      L[i] += wl * mix * duckG;
      R[i] += wr * mix * duckG;
    }
  }
  reset() {
    this.dL.reset(); this.dR.reset();
    this.difL.forEach(a => a.reset()); this.difR.forEach(a => a.reset());
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
    } else {
      this.tmpL.set(this.dryL.subarray(0, n)); this.tmpR.set(this.dryR.subarray(0, n));
      this.A.process(L, R, n, this.dryL, this.dryR);
      this.B.process(this.tmpL, this.tmpR, n, this.dryL, this.dryR);
      for (let i = 0; i < n; i++) { // add B's wet on top (dry already in L/R)
        L[i] += this.tmpL[i] - this.dryL[i];
        R[i] += this.tmpR[i] - this.dryR[i];
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

// 4-grain Hann-windowed granular shifter — smooth enough to regenerate.
class GrainShifter {
  constructor(sr, ratio) {
    this.sr = sr;
    this.ratio = ratio;
    this.buf = new FracDelay(0.3 * sr);
    this.grain = Math.round(0.118 * sr);
    this.ph = 0;
  }
  tick(x) {
    this.buf.write(x);
    this.ph += (this.ratio - 1);
    if (this.ph >= this.grain) this.ph -= this.grain;
    let out = 0;
    for (let k = 0; k < 4; k++) {
      const p = (this.ph + k * this.grain * 0.25) % this.grain;
      const w = Math.sin(Math.PI * p / this.grain);
      out += this.buf.read(Math.max(2, this.grain - p)) * w * w;
    }
    return out * 0.5; // four sin² windows sum to 2
  }
  reset() { this.buf.reset(); }
}

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

    // Shimmer.
    this.shiftOct = new GrainShifter(sr, 2);
    this.shift5th = new GrainShifter(sr, 3);
    this.shimLp = new OnePoleLP(); this.shimLp.setFc(6800, sr);
    this.shimHp = new OnePoleHP(); this.shimHp.setFc(430, sr);

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
    else if (id === 'shimmer_mode') this.shimmerMode = v | 0;
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

      // Shimmer regenerates the tail an octave (and a twelfth) up.
      if (shim > 0.005) {
        const tail = 0.35 * (this.lineOut[1] + this.lineOut[4]) + 0.3 * this.lineOut[6];
        let s = this.shiftOct.tick(tail);
        if (this.shimmerMode === 1) s = 0.72 * s + 0.55 * this.shift5th.tick(tail);
        d += this.shimHp.tick(this.shimLp.tick(s)) * shim * 0.58;
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

// Bar-count looper on the FINAL rig output: count-in → record N bars →
// seamless loop playback, live signal always passing. The metronome rides
// the count-in and record passes (and can run free for practice) but is
// added AFTER the capture tap, so clicks are never printed into the loop.
class Looper {
  constructor(sr, port) {
    this.sr = sr;
    this.port = port;
    this.state = 'idle';
    this.bars = 4;
    this.countBars = 2;
    this.beatsPerBar = 4;
    this.bpm = 120;
    this.clickOn = true;       // click during count-in + record
    this.freeMetro = false;    // standalone practice metronome
    this.metro = new Metronome(sr);
    this.bufL = null; this.bufR = null;
    this.len = 0; this.recPos = 0; this.playPos = 0;
    this.spb = Math.round(sr * 60 / this.bpm);
    this.beatSample = 0; this.beatIndex = 0;
    this.loopGain = new Smooth(1, 15, sr);
  }
  setOpt(id, v) {
    if (id === 'bars') this.bars = v | 0;
    else if (id === 'countin') this.countBars = v | 0;
  }
  setMetro(id, v) {
    if (id === 'on') {
      this.freeMetro = v > 0.5;
      if (this.freeMetro && this.state === 'idle') { this.beatSample = 0; this.beatIndex = -1; }
    }
    else if (id === 'gain') this.metro.gain = v;
    else if (id === 'bpm') { this.bpm = v; if (this.state === 'idle') this.spb = Math.round(this.sr * 60 / v); }
  }
  cmd(m) {
    if (m.cmd === 'arm') {
      this.bpm = m.bpm || this.bpm;
      if (m.bars) this.bars = m.bars;
      if (m.countBars !== undefined) this.countBars = m.countBars;
      this.spb = Math.round(this.sr * 60 / this.bpm);
      this.len = this.bars * this.beatsPerBar * this.spb;
      this.bufL = new Float32Array(this.len);
      this.bufR = new Float32Array(this.len);
      this.recPos = 0; this.beatSample = 0; this.beatIndex = -1;
      this.state = this.countBars > 0 ? 'count' : 'rec';
      this.post();
    } else if (m.cmd === 'stop') {
      this.state = 'idle';
      this.post();
    } else if (m.cmd === 'play') {
      if (this.bufL && this.len) { this.state = 'play'; this.playPos = 0; this.loopGain.jump(1); this.post(); }
    } else if (m.cmd === 'clear') {
      this.state = 'idle'; this.bufL = this.bufR = null; this.len = 0;
      this.post();
    }
  }
  post(extra) {
    this.port.postMessage({
      type: 'looper', state: this.state,
      beat: this.beatIndex, beatsPerBar: this.beatsPerBar,
      countBeats: this.countBars * this.beatsPerBar,
      bars: this.bars, bpm: this.bpm, ...extra,
    });
  }
  finalize() {
    // Peak pyramid for the UI waveform: 1200 min/max bins of the mono sum.
    const bins = 1200;
    const peaks = new Float32Array(bins * 2);
    const per = this.len / bins;
    for (let b = 0; b < bins; b++) {
      let lo = 0, hi = 0;
      const s = Math.floor(b * per), e = Math.min(this.len, Math.ceil((b + 1) * per));
      for (let i = s; i < e; i++) {
        const v = (this.bufL[i] + this.bufR[i]) * 0.5;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      peaks[b * 2] = lo; peaks[b * 2 + 1] = hi;
    }
    this.state = 'play';
    this.playPos = 0;
    this.loopGain.jump(1);
    this.port.postMessage({ type: 'wave', peaks, bins, bars: this.bars, bpm: this.bpm }, [peaks.buffer]);
    this.post();
  }
  // Runs on the final output block. Captures first, then adds loop + click.
  process(L, R, n) {
    const counting = this.state === 'count', recording = this.state === 'rec';
    const playing = this.state === 'play';
    const clockOn = counting || recording;
    const freeTick = this.freeMetro && !clockOn;
    for (let i = 0; i < n; i++) {
      if (clockOn || freeTick) {
        if (this.beatSample === 0) {
          this.beatIndex++;
          const inBar = this.beatIndex % this.beatsPerBar;
          if (clockOn || this.freeMetro) {
            if (clockOn ? this.clickOn : true) this.metro.trigger(inBar === 0);
          }
          if (clockOn) {
            if (counting && this.beatIndex >= this.countBars * this.beatsPerBar) {
              this.state = 'rec';
              this.recPos = 0;
            }
            this.post();
          }
        }
        if (++this.beatSample >= this.spb) this.beatSample = 0;
      }
      if (this.state === 'rec') {
        this.bufL[this.recPos] = L[i];
        this.bufR[this.recPos] = R[i];
        if (++this.recPos >= this.len) { this.finalize(); }
      }
      if (playing && this.bufL) {
        const g = this.loopGain.next();
        L[i] += this.bufL[this.playPos] * g;
        R[i] += this.bufR[this.playPos] * g;
        if (++this.playPos >= this.len) this.playPos = 0;
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
    this.peakIn = 0; this.peakOut = 0;
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
        case 'out': this.outGain.set(dbToGain(v)); return;
        case 'amp':
          if (rest === 'master') this.master.set(dbToGain((v - 0.7) * 30));
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
        // Soft safety ceiling — musical instead of digital wrap.
        let l = L[i] * g, r = R[i] * g;
        if (l > 1.2 || l < -1.2) l = Math.tanh(l * 0.8) * 1.25;
        if (r > 1.2 || r < -1.2) r = Math.tanh(r * 0.8) * 1.25;
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
          type: 'meters', out: this.peakOut, gr: this.fet.grDb,
          loopState: lp.state,
          loopPos: lp.len ? (lp.state === 'rec' ? lp.recPos : lp.playPos) / lp.len : 0,
        });
        this.peakOut = 0;
        this.fet.grDb *= 0.6;
      }
    }
    return true;
  }
}

registerProcessor('remi-chain', RemiChainProcessor);
