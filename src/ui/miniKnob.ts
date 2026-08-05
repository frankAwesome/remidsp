/* The small drawn knob.
 *
 * The rig's knobs are sprite cut-outs from the photoreal amp renders, which
 * only works where there is a baked twin underneath to cover. The looper
 * lanes have no render behind them and their controls belong to a track that
 * did not exist when the page loaded, so these are drawn instead: a machined
 * cap in CSS, and the value arc in SVG so it stays crisp at any size.
 *
 * Same feel as the sprite knobs — drag vertically, shift for fine, double
 * click to reset, wheel to nudge — plus arrow keys, because a lane control
 * you can tab to is a lane control you can mix without a mouse.
 */

import { showValueChip } from './knob';

const SWEEP = 270;          // total travel, -135°..+135° like the rig's knobs
const R = 15.5;             // arc radius in the 40×40 viewBox

export interface MiniKnobOpts {
  label: string;
  min: number;
  max: number;
  def: number;
  value: number;
  /** Fill the arc outward from 12 o'clock instead of up from the floor. */
  bipolar?: boolean;
  format: (v: number) => string;
  unit?: string;
  onChange: (v: number) => void;
}

export interface MiniKnob {
  el: HTMLElement;
  /** Push a value in from outside without firing onChange. */
  set(v: number): void;
}

/** Point on the arc circle for a normalised position. */
function pt(n: number): [number, number] {
  const rad = ((n - 0.5) * SWEEP * Math.PI) / 180;
  return [20 + R * Math.sin(rad), 20 - R * Math.cos(rad)];
}

function arc(from: number, to: number): string {
  if (Math.abs(to - from) < 0.001) return '';
  const [x0, y0] = pt(from);
  const [x1, y1] = pt(to);
  const large = Math.abs(to - from) * SWEEP > 180 ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function makeMiniKnob(o: MiniKnobOpts): MiniKnob {
  let value = o.value;
  const norm = (v: number) => (v - o.min) / (o.max - o.min);
  const denorm = (n: number) => o.min + n * (o.max - o.min);

  const el = document.createElement('div');
  el.className = 'mknob';
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', o.label);
  el.innerHTML = `
    <div class="mknob__dial">
      <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
        <path class="mknob__track" d="${arc(0, 1)}" />
        <path class="mknob__fill" d="" />
      </svg>
      <div class="mknob__cap"><i class="mknob__ptr"></i></div>
    </div>
    <span class="mknob__label">${o.label}</span>`;

  const fill = el.querySelector<SVGPathElement>('.mknob__fill')!;
  const ptr = el.querySelector<HTMLElement>('.mknob__ptr')!;

  const render = () => {
    const n = Math.min(1, Math.max(0, norm(value)));
    // Bipolar knobs read as a deviation from centre, so the arc grows out of
    // 12 o'clock in whichever direction the knob went.
    fill.setAttribute('d', o.bipolar ? arc(0.5, n) : arc(0, n));
    el.classList.toggle('mknob--centred', o.bipolar && Math.abs(n - 0.5) < 0.005);
    ptr.style.transform = `rotate(${(n - 0.5) * SWEEP}deg)`;
    el.setAttribute('aria-valuenow', o.format(value));
    el.title = `${o.label} · ${o.format(value)}${o.unit ?? ''}`;
  };

  const commit = (v: number, x?: number, y?: number) => {
    value = Math.min(o.max, Math.max(o.min, v));
    render();
    o.onChange(value);
    if (x !== undefined && y !== undefined) showValueChip(x, y, o.format(value), o.unit ?? '');
  };

  let startY = 0, startN = 0, dragging = false;
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startN = norm(value);
    el.setPointerCapture(e.pointerId);
    el.classList.add('mknob--live');
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const fine = e.shiftKey ? 0.22 : 1;
    const n = Math.min(1, Math.max(0, startN + (startY - e.clientY) * 0.006 * fine));
    commit(denorm(n), e.clientX, e.clientY);
  });
  const release = () => { dragging = false; el.classList.remove('mknob--live'); };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('dblclick', () => commit(o.def));
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    commit(denorm(Math.min(1, Math.max(0, norm(value) - Math.sign(e.deltaY) * 0.04))));
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.01 : 0.05;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') commit(denorm(norm(value) + step));
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') commit(denorm(norm(value) - step));
    else if (e.key === 'Home') commit(o.def);
    else return;
    e.preventDefault();
  });

  render();
  return { el, set(v: number) { value = v; render(); } };
}
