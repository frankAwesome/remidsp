/* The gate's motion.
 *
 * The gate is a normal block in flow and the DOCUMENT scroller is what scrolls
 * it (see the note above .gateway in style.css for why it is not a fixed
 * overlay with its own scroller). So everything here reads window.scrollY and
 * observes against the viewport — the default root.
 *
 * The resting state of a reveal is opacity 0, which makes a failure here look
 * like a blank page rather than a broken animation. So the resting state is
 * gated behind a `.js-reveal` class that this module adds on init: if the
 * module never runs or throws before that line, the gate degrades to a plain,
 * fully legible document instead of an empty black screen.
 *
 * Everything here is decoration. Nothing in this file touches the engine, the
 * doors, or the asset preloader — those are main.ts's, and they keep working
 * with this module deleted.
 */

/** The three heads, in the order they appear in the markup, each with the
 *  light it throws. These are the same tints the lineup uses on remidsp.com,
 *  so a visitor arriving from there recognises the same amps. */
const AMPS = [
  { glow: '#8fd8cf', glow2: '#4a8f96' },  // Camden   — british chime
  { glow: '#e8c877', glow2: '#8a6a2a' },  // Portland — british crunch
  { glow: '#e0a878', glow2: '#8a4f2a' },  // Katahdin — modern high-gain
];

const ROTATE_MS = 5200;

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function initGate(): void {
  const gate = document.getElementById('gateway');
  if (!gate) return;

  gate.classList.add('js-reveal');

  reveal(gate);
  chrome(gate);
  amps(gate);
  tilt(gate);
  cue(gate);
}

/* ────────────────────────── reveal on scroll ────────────────────────── */

function reveal(gate: HTMLElement) {
  const targets = gate.querySelectorAll<HTMLElement>('[data-reveal],[data-reveal-line]');
  if (!('IntersectionObserver' in window) || reduced()) {
    for (const t of targets) t.classList.add('is-in');
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      io.unobserve(e.target);           // one-way: nothing re-hides on scroll up
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.01 });
  for (const t of targets) io.observe(t);
}

/* ────────────────────────── sticky bar + progress ────────────────────────── */

function chrome(gate: HTMLElement) {
  const bar = gate.querySelector<HTMLElement>('.gate__bar');
  const fill = document.getElementById('gateProgress');
  let queued = false;

  const paint = () => {
    queued = false;
    const y = window.scrollY;
    bar?.classList.toggle('is-stuck', y > 12);
    if (fill) {
      // The gate's own height, not the document's: once the rig opens, the
      // gate collapses out of flow and this would divide by the app's height.
      const span = gate.offsetHeight - window.innerHeight;
      fill.style.transform = `scaleX(${span > 0 ? Math.min(1, y / span) : 0})`;
    }
  };

  window.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(paint);
  }, { passive: true });
  paint();
}

/* ────────────────────────── the amp stage ────────────────────────── */

function amps(gate: HTMLElement) {
  const rig = document.getElementById('gateRig');
  const hero = document.getElementById('gateHero');
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#gateRigTabs button'));
  const heads = Array.from(
    gate.querySelectorAll<HTMLImageElement>('.gate-rig__amp'));
  const voices = Array.from(
    gate.querySelectorAll<HTMLElement>('.gate-rig__voiceset'));
  if (!rig || !hero || !heads.length) return;

  let at = 0;
  let timer = 0;
  let held = false;   // pointer is on the stage, or the tab strip has focus
  let masked = -1;    // which head --amp-mask currently points at

  /* The sheen is masked by the head's own alpha so the highlight rides the
   * metal instead of sweeping a rectangle of empty space. A mask-image is a
   * SEPARATE resource load, though — setting it on every switch pulled all
   * three renders down a second time, ~1.6 MB, for an effect that only exists
   * under a pointer. So it is set on first hover and not before: nobody on a
   * phone pays for it, and by the time a mouse arrives the head is cached. */
  const applyMask = () => {
    if (masked === at) return;
    masked = at;
    rig.style.setProperty('--amp-mask', `url("${heads[at].currentSrc || heads[at].src}")`);
  };

  const show = (i: number) => {
    at = ((i % heads.length) + heads.length) % heads.length;
    heads.forEach((h, n) => h.classList.toggle('is-active', n === at));
    voices.forEach((v, n) => v.classList.toggle('is-active', n === at));
    tabs.forEach((t, n) => {
      t.classList.toggle('is-active', n === at);
      t.setAttribute('aria-selected', String(n === at));
    });
    const amp = AMPS[at] ?? AMPS[0];
    hero.style.setProperty('--amp-glow', amp.glow);
    hero.style.setProperty('--amp-glow-2', amp.glow2);
    if (held) applyMask();     // already under a pointer: keep the sheen honest
  };

  const stop = () => { if (timer) { clearInterval(timer); timer = 0; } };
  const start = () => {
    stop();
    if (reduced()) return;
    timer = window.setInterval(() => {
      // Don't quietly keep cycling behind a hidden tab or a booted rig — the
      // gate stays in the DOM after boot, it is only made invisible.
      if (held || document.hidden || gate.classList.contains('hidden')) return;
      show(at + 1);
    }, ROTATE_MS);
  };

  tabs.forEach((t, n) => {
    t.addEventListener('click', () => { show(n); start(); });
  });

  // A rotation that moves while somebody is reaching for a name is the single
  // most annoying thing a carousel does, so hovering the stage or tabbing into
  // the strip holds it.
  const hold = () => { held = true; applyMask(); };
  const release = () => { held = false; };
  rig.addEventListener('pointerenter', hold);
  rig.addEventListener('pointerleave', release);
  rig.addEventListener('focusin', hold);
  rig.addEventListener('focusout', release);

  // Pointer-tracked specular sweep across the live head.
  const sheenHost = rig.querySelector<HTMLElement>('.gate-rig__amps');
  if (sheenHost && !reduced()) {
    rig.addEventListener('pointermove', (e) => {
      const r = sheenHost.getBoundingClientRect();
      sheenHost.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
      sheenHost.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
    }, { passive: true });
  }

  show(0);
  start();
}

/* ────────────────────────── card tilt ────────────────────────── */

/* A few degrees, pointer-driven, on the cards and the closing shot. Skipped
 * wholesale on coarse pointers: there is no hover on a phone, so it would only
 * ever fire as a jolt on tap. */
function tilt(gate: HTMLElement) {
  if (reduced() || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  for (const card of gate.querySelectorAll<HTMLElement>('[data-tilt]')) {
    let queued = false;
    let x = 0, y = 0;

    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      x = (e.clientX - r.left) / r.width - .5;
      y = (e.clientY - r.top) / r.height - .5;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        card.style.transform =
          `perspective(1100px) rotateX(${(-y * 4).toFixed(2)}deg) `
          + `rotateY(${(x * 5).toFixed(2)}deg) translateZ(0)`;
      });
    }, { passive: true });

    card.addEventListener('pointerleave', () => { card.style.transform = ''; });
  }
}

/* ────────────────────────── the scroll cue ────────────────────────── */

/* The cue is a real <a href="#…"> so it is focusable and announced as a link,
 * but its default action would put "#gateRigSection" in the address bar — and
 * the address bar is the router's input. parseHash sends anything it does not
 * recognise to the rig, so an unhandled click here would fire a route change
 * as a side effect of scrolling down one screen. */
function cue(gate: HTMLElement) {
  const link = gate.querySelector<HTMLAnchorElement>('.gate-hero__cue');
  const target = document.getElementById('gateRigSection');
  if (!link || !target) return;
  link.addEventListener('click', (e) => {
    e.preventDefault();
    target.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
  });
}
