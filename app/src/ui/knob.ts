/* Sprite knob — the render's own knob cut-out, rotated live over its baked
 * twin (±135°). Drag vertically, shift for fine, double-click to reset.
 * While dragging, a black-glass value chip prints the reading (Space
 * Grotesk, bright value + dim unit) — the same language as the plugin. */

import { paramById, store } from '../params';

const chip = document.createElement('div');
chip.className = 'value-chip';
document.body.appendChild(chip);
let chipTimer = 0;

/** The rig's one value read-out. Exported so the drawn knobs in the looper
 *  speak with the same voice instead of inventing a second chip. */
export function showValueChip(x: number, y: number, text: string, unit: string) {
  chip.innerHTML = `<b>${text}</b>${unit ? `<span>${unit}</span>` : ''}`;
  chip.style.left = `${x}px`;
  chip.style.top = `${y - 44}px`;
  chip.classList.add('on');
  clearTimeout(chipTimer);
  chipTimer = window.setTimeout(() => chip.classList.remove('on'), 700);
}

function norm(id: string, v: number): number {
  const d = paramById.get(id)!;
  const lin = (v - d.min) / (d.max - d.min);
  return d.skew ? Math.pow(lin, d.skew) : lin;
}
function denorm(id: string, n: number): number {
  const d = paramById.get(id)!;
  const lin = d.skew ? Math.pow(n, 1 / d.skew) : n;
  return d.min + lin * (d.max - d.min);
}

export function makeKnob(param: string, sprite: string, cls = ''): HTMLElement {
  const d = paramById.get(param);
  if (!d) throw new Error(`unknown param ${param}`);
  const el = document.createElement('div');
  el.className = `knob ${cls}`;
  el.title = d.label;
  const img = document.createElement('img');
  img.src = sprite;
  img.alt = d.label;
  img.draggable = false;
  el.appendChild(img);

  const render = () => {
    const n = norm(param, store.get(param));
    img.style.transform = `rotate(${(n - 0.5) * 270}deg)`;
  };
  render();
  const unsub = store.subscribe((id) => {
    if (!el.isConnected) { unsub(); return; }
    if (id === param || id === '*') render();
  });

  let startY = 0, startN = 0, dragging = false;
  const move = (e: PointerEvent) => {
    if (!dragging) return;
    const fine = e.shiftKey ? 0.22 : 1;
    const n = Math.min(1, Math.max(0, startN + (startY - e.clientY) * 0.006 * fine));
    store.set(param, denorm(param, n));
    const v = store.get(param);
    showValueChip(e.clientX, e.clientY, d.format ? d.format(v) : v.toFixed(2), d.unit ?? '');
  };
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startN = norm(param, store.get(param));
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', () => (dragging = false));
  el.addEventListener('dblclick', () => store.set(param, d.def));
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const n = Math.min(1, Math.max(0, norm(param, store.get(param)) - Math.sign(e.deltaY) * 0.03));
    store.set(param, denorm(param, n));
  }, { passive: false });
  return el;
}

/** Absolutely-positioned knob for a face overlay (fractions of the face box). */
export function placeKnob(param: string, sprite: string, nx: number, ny: number, nr: number): HTMLElement {
  const k = makeKnob(param, sprite, 'knob--face');
  const dia = nr * 2.16 * 100;
  k.style.width = `${dia}%`;
  k.style.left = `${nx * 100}%`;
  k.style.top = `${ny * 100}%`;
  return k;
}
