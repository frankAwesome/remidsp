/* YIN (CMNDF) pitch detection for the tuner, ~55 Hz .. 1 kHz.
 *
 * A port of the desktop suite's src/dsp/PitchDetect.h — same band-pass, same
 * energy gate, same 0.13 threshold, same descend-to-the-valley rule, same
 * parabolic refinement. Readings agree with the plugin's because the maths is
 * the plugin's.
 *
 * WHAT IS DIFFERENT, AND WHY.
 *
 * The desktop runs the whole search at the device rate because it is compiled
 * C++ on a UI thread with nothing else to do. Here it is JavaScript on the same
 * thread that paints the rig, and a full-rate search is ~2.7 M inner iterations
 * per detection (at 48 kHz, a 4096 window, lags out to sr/55). Fifteen of those
 * a second is a visibly stuttering page.
 *
 * So this is COARSE-TO-FINE, which is the standard fix and costs about a
 * twelfth as much:
 *
 *   1. Band-pass to the guitar-fundamental range at the device rate. This is
 *      the desktop's filter verbatim, and it is also the anti-alias filter for
 *      step 2 — which is why it has to happen first.
 *   2. Decimate to ~12 kHz by averaging each group of `dec` samples. A box
 *      average of length `dec` has its nulls exactly at the frequencies that
 *      would alias, so it is both the resampler and a second anti-alias stage.
 *   3. Full YIN on the short, slow buffer. This finds WHICH period it is.
 *   4. Re-measure that one period at the DEVICE RATE over a narrow ±dec window,
 *      and parabolically refine there.
 *
 * Step 4 is the part that matters for a tuner. Decimation costs resolution —
 * a lag of 27 samples at 12 kHz means one sample of error is ~3 cents at A4 —
 * and a strobe tuner that cannot resolve better than three cents is not worth
 * shipping. Refining at the device rate puts the final reading back on the
 * desktop's own precision (sub-cent through the guitar's range) while the
 * expensive search stays cheap.
 */

/** No confident pitch in this window. */
export const NO_PITCH = -1;

/* The lowest note the tuner will chase (below a 7-string's low B) and the
 * highest (a little above the 12th fret of the high E). Outside this band a
 * "detection" is a harmonic, a fret buzz, or the room. */
const MIN_HZ = 55;
const MAX_HZ = 1000;

/** Where the coarse search runs. Above ~4x the top note there is nothing left
 *  to gain, and every halving of the rate quarters the search. */
const COARSE_HZ = 12000;

/** In-band RMS floor, ~-77 dBFS. With the noise band-passed out, YIN's own
 *  periodicity test guards against false locks, so this can sit low enough to
 *  catch a note that is already dying. */
const GATE = 2.0e-8;

/* Scratch buffers, allocated once and reused. This runs 15 times a second for
 * as long as the tuner is open; allocating three arrays per call would hand
 * the garbage collector a steady job right next to a live audio graph.
 *
 * Explicitly <ArrayBuffer>: since TS 5.7 the typed arrays are generic over
 * their backing store, and this project is cross-origin isolated — so an
 * unannotated Float32Array widens to ArrayBufferLike, which includes
 * SharedArrayBuffer, which getFloatTimeDomainData will not take. */
let band = new Float32Array(0);     // band-passed, device rate
let coarse = new Float32Array(0);   // decimated
let cmndf = new Float32Array(0);

function fit(buf: Float32Array<ArrayBuffer>, n: number): Float32Array<ArrayBuffer> {
  return buf.length >= n ? buf : new Float32Array(n);
}

/**
 * @param raw  most recent time-domain samples, device rate
 * @param sr   the device rate — the REAL one. An earlier version of the
 *             desktop detector hard-wired 48 kHz and every reading was wrong
 *             at 44.1, 88.2 and 96.
 * @returns    frequency in Hz, or NO_PITCH
 */
export function detectPitch(raw: Float32Array, sr: number): number {
  const n = raw.length;
  if (n < 512 || !(sr > 8000)) return NO_PITCH;

  /* ── 1 · band-pass, and measure the energy that survives it ─────────────
     Two one-pole low-passes (-12 dB/oct) at ~1.1 kHz, minus a one-pole at
     ~65 Hz to make a high-pass. Stripping the hiss and fret noise above and
     the rumble below is what lets a modern tuner lock onto a QUIET note: YIN
     on a clean fundamental tracks far lower in level than YIN on raw audio. */
  band = fit(band, n);
  const lpA = 1 - Math.exp((-2 * Math.PI * 1100) / sr);
  const hpA = 1 - Math.exp((-2 * Math.PI * 65) / sr);
  let lp1 = 0, lp2 = 0, rumble = 0, energy = 0;
  for (let i = 0; i < n; i++) {
    lp1 += lpA * (raw[i] - lp1);
    lp2 += lpA * (lp1 - lp2);
    rumble += hpA * (lp2 - rumble);
    const y = lp2 - rumble;
    band[i] = y;
    energy += y * y;
  }
  if (energy / n < GATE) return NO_PITCH;

  /* ── 2 · decimate to ~12 kHz by box-averaging ─────────────────────────── */
  const dec = Math.max(1, Math.round(sr / COARSE_HZ));
  const sr2 = sr / dec;
  const n2 = Math.floor(n / dec);
  coarse = fit(coarse, n2);
  if (dec === 1) {
    coarse.set(band.subarray(0, n2));
  } else {
    const inv = 1 / dec;
    for (let k = 0, i = 0; k < n2; k++) {
      let s = 0;
      for (let j = 0; j < dec; j++) s += band[i++];
      coarse[k] = s * inv;
    }
  }

  /* ── 3 · coarse YIN ────────────────────────────────────────────────────
     The desktop's constants, expressed at the decimated rate. */
  const minLag = Math.max(2, Math.floor(sr2 / MAX_HZ));
  const maxLag = Math.min(n2 >> 1, Math.floor(sr2 / MIN_HZ));
  if (maxLag <= minLag + 2) return NO_PITCH;
  const win = n2 - maxLag;

  cmndf = fit(cmndf, maxLag + 1);
  let cumulative = 0;
  for (let tau = minLag; tau <= maxLag; tau++) {
    let sum = 0;
    for (let i = 0; i < win; i++) {
      const d = coarse[i] - coarse[i + tau];
      sum += d * d;
    }
    cumulative += sum;
    // Note the (tau - minLag + 1) normaliser rather than plain tau: the search
    // starts at minLag, so that is where the running mean starts too. Kept
    // identical to the desktop — the 0.13 threshold below is calibrated to it.
    cmndf[tau] = (sum * (tau - minLag + 1)) / Math.max(1e-12, cumulative);
  }

  /* YIN's absolute threshold: take the FIRST lag whose CMNDF dips below it and
     then DESCEND to the local minimum. Latching onto the first point on the
     slope instead of the valley reads pure tones ~9 % sharp; harmonic-rich
     guitar merely hides it. */
  let best = -1;
  for (let tau = minLag + 2; tau < maxLag; tau++) {
    if (cmndf[tau] < 0.13) {
      while (tau + 1 <= maxLag && cmndf[tau + 1] < cmndf[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) return NO_PITCH;

  /* ── 4 · re-measure that period at the device rate ─────────────────────
     The coarse valley says which period this is to within a decimated sample;
     `dec` device-rate samples either side is therefore more than enough to
     bracket the true minimum. Plain squared difference is fine over a window
     this narrow — CMNDF's normaliser barely moves across it, and its only job
     was to pick the right valley, which it already did. */
  const centre = best * dec;
  const lo = Math.max(2, centre - dec - 1);
  const hi = Math.min(Math.floor(sr / MIN_HZ), centre + dec + 1);
  const fineWin = n - hi - 1;
  if (fineWin < 64) return sr2 / best;   // window too short to refine; coarse it is

  const diffAt = (tau: number) => {
    let sum = 0;
    for (let i = 0; i < fineWin; i++) {
      const d = band[i] - band[i + tau];
      sum += d * d;
    }
    return sum;
  };

  // Widen by one on each side of the search so the winner always has both
  // neighbours available for the parabola, including at the range ends.
  let bestLag = centre;
  let bestVal = Infinity;
  for (let tau = lo; tau <= hi; tau++) {
    const sum = diffAt(tau);
    if (sum < bestVal) { bestVal = sum; bestLag = tau; }
  }

  let refined = bestLag;
  if (bestLag > 2) {
    const prev = diffAt(bestLag - 1);
    const next = diffAt(bestLag + 1);
    const denom = prev - 2 * bestVal + next;
    if (Math.abs(denom) > 1e-12) refined += (0.5 * (prev - next)) / denom;
  }
  if (refined <= 0) return NO_PITCH;

  const hz = sr / refined;
  return hz >= MIN_HZ && hz <= MAX_HZ ? hz : NO_PITCH;
}

/* ASCII '#', not U+266F, and the reason is the display face. Oswald has no
 * musical sharp — measured, not assumed: '#' advances 40.9 at 80px, '♯'
 * advances 80, the same as a CJK character, which is the fallback box. So a
 * real sharp in the hero note is drawn by whatever the OS offers next, at a
 * weight and width that do not match the Oswald cap beside it.
 *
 * The desktop names its notes the same way for the same reason. The ruler's
 * ♭ and ♯ ARE the real glyphs, because those are set in the mono stack, which
 * has them. Screen readers get the word — see the tuner's aria-label. */
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface Note {
  /** e.g. "F#". Display text — say it out loud with spokenName(). */
  name: string;
  /** Scientific pitch notation octave: A4 = 440 Hz. */
  octave: number;
  /** Signed distance from that note, -50..+50. */
  cents: number;
}

/** Nearest equal-tempered note to a frequency, at A4 = 440 Hz. */
export function noteFor(hz: number): Note {
  const midi = 69 + 12 * Math.log2(hz / 440);
  const nearest = Math.round(midi);
  return {
    name: NAMES[((nearest % 12) + 12) % 12],
    octave: Math.floor(nearest / 12) - 1,
    cents: (midi - nearest) * 100,
  };
}

/** The note said out loud. "G#4" read from the screen comes out as "G hash
 *  four", which is not a note anybody has ever played. */
export function spokenName(n: Note): string {
  return `${n.name.replace('#', ' sharp')} ${n.octave}`;
}
