/* The chromatic tuner.
 *
 * A port of the desktop suite's TunerOverlay: a glass instrument card over the
 * dimmed rig, a huge note, and a strobe lane whose bars drift flat or sharp,
 * slow as you approach pitch and freeze in a green-flooded gate when you land.
 * Same smoothing constants, same ±5-cent lock window, same amber-to-green
 * state colour, so the two tuners behave identically under the hands.
 *
 * DRAWN IN CSS, NOT ON A CANVAS. The lane is the only genuinely animated part,
 * and it is a repeating-linear-gradient translated on the compositor — no
 * per-frame painting, no canvas to keep in sync with the page's fonts. The
 * per-frame cost of the whole overlay is a handful of custom-property writes.
 *
 * WHAT MUTING IS AND IS NOT.
 *
 * Opening the tuner silences the rig, the way a tuner pedal does: nobody wants
 * a room to hear them find the note, and a captured high-gain amp on a flat
 * string is genuinely unpleasant. That is a courtesy, not a fix — it does not
 * make the round trip shorter, because the chain is still running and still
 * costs its one render quantum whether or not the last gain node is at zero.
 *
 * What it DOES buy is real, though: the detector runs on the main thread, and
 * with the rig audible people tune with the amp roaring, which is the state
 * where a page that stutters is most likely to be blamed on the audio. Muting
 * also means the tuner hears the guitar and not a speaker, which on a laptop
 * with an open mic is the difference between locking and chasing its own tail.
 */

import { engine } from '../audio/engine';
import { detectPitch, noteFor, NO_PITCH } from '../dsp/pitch';

const el = (tag: string, cls = '', text = '') => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

/** Detections per second. The desktop runs 15 (every second tick of a 30 Hz
 *  timer) and that is already faster than a hand can turn a machine head. */
const DETECT_HZ = 15;
/** How many silent detections before the readout goes back to standby. The
 *  desktop's 12, which at 15 Hz is about eight tenths of a second — long
 *  enough to ride out the gap between two plucks. */
const SILENT_FRAMES = 12;
/** Inside this many cents, the note is in tune and the lane freezes. */
const LOCK_CENTS = 5;

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Tuner {
  readonly root: HTMLElement;

  private card!: HTMLElement;
  private idle!: HTMLElement;
  private read!: HTMLElement;
  private letter!: HTMLElement;
  private octave!: HTMLElement;
  private lock!: HTMLElement;
  private hz!: HTMLElement;
  private cents!: HTMLElement;
  private flat!: HTMLElement;
  private sharp!: HTMLElement;

  private open = false;
  private raf = 0;
  private window = new Float32Array(0);
  private lastDetect = 0;

  // detector state
  private freq = NO_PITCH;
  private centsOff = 0;
  private silent = 0;
  // animation state, all eased — these are the desktop's names and constants
  private dispCents = 0;
  private phase = 0;
  private green = 0;
  private idlePulse = 0;

  /** Told when the tuner opens or closes, so the header key can stay lit. */
  onToggle: ((open: boolean) => void) | null = null;

  constructor() {
    this.root = el('div', 'tuner');
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="tuner__card" role="dialog" aria-modal="true" aria-label="Chromatic tuner">
        <button class="tuner__x" type="button" aria-label="Close the tuner"></button>
        <p class="tuner__cap">CHROMATIC TUNER</p>
        <span class="tuner__tab" aria-hidden="true"></span>

        <div class="tuner__note">
          <span class="tuner__idle">PLAY A STRING</span>
          <span class="tuner__read"><b class="tuner__letter"></b><s class="tuner__oct"></s></span>
          <span class="tuner__lock">IN TUNE</span>
        </div>

        <div class="tuner__lane" aria-hidden="true">
          <i class="tuner__bars"></i>
          <span class="tuner__flood"></span>
          <span class="tuner__gate tuner__gate--l"></span>
          <span class="tuner__gate tuner__gate--r"></span>
          <span class="tuner__loz"></span>
        </div>
        <div class="tuner__ruler" aria-hidden="true">
          <span class="tuner__sign tuner__sign--flat">&#9837;</span>
          <span class="tuner__ticks">${
            [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50]
              .map((c) => `<i class="${c === 0 || Math.abs(c) === 50 ? 'is-major' : ''}"></i>`)
              .join('')
          }</span>
          <span class="tuner__sign tuner__sign--sharp">&#9839;</span>
        </div>

        <div class="tuner__leds">
          <div class="tuner__led"><b class="led-text tuner__hz">---</b><span>HZ</span></div>
          <div class="tuner__led"><b class="led-text tuner__cents">--</b><span>CENTS</span></div>
        </div>

        <!-- Said out loud, because silence the player did not ask for reads as
             a broken rig. -->
        <p class="tuner__mute">OUTPUT MUTED WHILE TUNING</p>
        <p class="tuner__hint">CLICK ANYWHERE OR PRESS ESC TO CLOSE</p>
      </div>`;

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
    this.card = q('.tuner__card');
    this.idle = q('.tuner__idle');
    this.read = q('.tuner__read');
    this.letter = q('.tuner__letter');
    this.octave = q('.tuner__oct');
    this.lock = q('.tuner__lock');
    this.hz = q('.tuner__hz');
    this.cents = q('.tuner__cents');
    this.flat = q('.tuner__sign--flat');
    this.sharp = q('.tuner__sign--sharp');

    // Closes from anywhere — the scrim, the ✕, ESC. The desktop does the same,
    // and a full-screen mode you have to hunt for the exit of is a trap.
    this.root.addEventListener('click', () => this.hide());
    q('.tuner__x').addEventListener('click', (e) => { e.stopPropagation(); this.hide(); });
    // ...but not from a stray click inside the card itself.
    this.card.addEventListener('click', (e) => e.stopPropagation());
  }

  get isOpen(): boolean { return this.open; }

  toggle(): void { this.open ? this.hide() : this.show(); }

  show(): void {
    if (this.open || engine.state !== 'running') return;
    this.open = true;
    this.root.hidden = false;
    // Reset, so re-opening never flashes the last note from a minute ago.
    this.freq = NO_PITCH;
    this.silent = SILENT_FRAMES;
    this.dispCents = 0;
    this.green = 0;
    this.lastDetect = 0;
    if (this.window.length !== engine.tunerWindowSize) {
      this.window = new Float32Array(engine.tunerWindowSize);
    }
    engine.setMuted(true);
    this.card.querySelector<HTMLElement>('.tuner__x')?.focus();
    this.raf = requestAnimationFrame(this.tick);
    this.onToggle?.(true);
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.root.hidden = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    engine.setMuted(false);
    this.onToggle?.(false);
  }

  /** Keys, routed from the app's one keydown listener. True when handled. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    if (e.key === 'Escape') { e.preventDefault(); this.hide(); return true; }
    // Space is the demo transport everywhere else in the rig. In here it is
    // nothing — the rig is muted and starting the loop back up would be a
    // surprise the player cannot hear.
    if (e.code === 'Space') { e.preventDefault(); return true; }
    // The card claims aria-modal, so Tab has to stay inside it or that claim
    // is a lie: the reading order would walk straight out into a rig the
    // screen reader has just been told is hidden. There is exactly one control
    // in here, so the trap is one line.
    if (e.key === 'Tab') {
      e.preventDefault();
      this.card.querySelector<HTMLElement>('.tuner__x')?.focus();
      return true;
    }
    return false;
  }

  private tick = (now: number) => {
    if (!this.open) return;
    this.raf = requestAnimationFrame(this.tick);

    if (now - this.lastDetect >= 1000 / DETECT_HZ) {
      this.lastDetect = now;
      this.detect();
    }
    this.animate();
  };

  private detect() {
    if (!engine.readTunerWindow(this.window)) return;
    const sr = engine.sampleRate() ?? 48000;
    const hz = detectPitch(this.window, sr);

    if (hz > 0) {
      // Same one-pole on the reading as the desktop: enough to stop the last
      // digit flickering, not enough to lag a turn of the machine head.
      this.freq = this.freq > 0 ? this.freq * 0.6 + hz * 0.4 : hz;
      this.centsOff = noteFor(this.freq).cents;
      this.silent = 0;
    } else if (++this.silent > SILENT_FRAMES) {
      this.freq = NO_PITCH;
    }
  }

  private animate() {
    const live = this.freq > 0;

    this.dispCents += 0.30 * ((live ? clamp(this.centsOff, -50, 50) : 0) - this.dispCents);
    // The strobe: drift speed and direction ARE the error. Dead on pitch it
    // stops, which is the whole reason a strobe beats a needle — you stop
    // reading a number and start watching for stillness.
    //
    // Note what reduced-motion does and does not switch off here. The drift
    // while a note is sounding is the READOUT, not an animation, and stilling
    // it would leave a tuner that cannot tell you anything. The idle drift is
    // ambience and nothing else, so that is the part that stops.
    if (live) this.phase += this.dispCents * 0.055;
    else if (!reduced()) this.phase += 0.22;
    if (this.phase > 1e6 || this.phase < -1e6) this.phase = 0;
    this.green += 0.16 * ((live && Math.abs(this.dispCents) < LOCK_CENTS ? 1 : 0) - this.green);
    this.idlePulse = (this.idlePulse + 0.055) % (Math.PI * 2);

    const s = this.root.style;
    s.setProperty('--green', this.green.toFixed(3));
    s.setProperty('--live', live ? '1' : '0');
    // Wrapped into one bar period so the translate never grows unbounded and
    // starts losing sub-pixel precision after a few minutes on screen.
    s.setProperty('--phase', `${mod(this.phase, 26).toFixed(2)}px`);
    // A 0..1 fraction rather than a percentage: the stylesheet insets it by
    // half a lozenge at each end, which it can only do with a bare number.
    s.setProperty('--loz', ((clamp(this.dispCents, -50, 50) + 50) / 100).toFixed(4));
    s.setProperty('--idle-a', (0.55 + 0.2 * Math.sin(this.idlePulse)).toFixed(3));

    this.root.classList.toggle('is-live', live);
    this.root.classList.toggle('is-lock', this.green > 0.35);
    this.flat.classList.toggle('is-on', live && this.dispCents < -LOCK_CENTS);
    this.sharp.classList.toggle('is-on', live && this.dispCents > LOCK_CENTS);

    if (live) {
      const n = noteFor(this.freq);
      this.letter.textContent = n.name;
      this.octave.textContent = String(n.octave);
      this.hz.textContent = this.freq.toFixed(1);
      // DSEG7 has no '+' glyph, so the sharp side reads unsigned — the lit ♯
      // beside the lane already says which way. Same call as the desktop.
      this.cents.textContent =
        (this.centsOff < 0 ? '-' : '') + Math.abs(this.centsOff).toFixed(1);
      this.read.setAttribute('aria-label',
        `${n.name}${n.octave}, ${Math.round(this.centsOff)} cents`);
    } else {
      this.hz.textContent = '---';
      this.cents.textContent = '--';
    }
    this.idle.hidden = live;
    this.read.hidden = !live;
    this.lock.hidden = this.green <= 0.35;
  }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Always-positive modulo — JS's % keeps the sign of the dividend, and a
 *  negative translate here would tear a bar off the left edge of the lane. */
const mod = (v: number, m: number) => ((v % m) + m) % m;
