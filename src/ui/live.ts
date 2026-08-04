/* Live panel widgets — everything that moves. Each widget is a canvas/div
 * seated over its baked twin on the render, driven by the worklet's meter
 * frames (meterBus) or requestAnimationFrame. Every rAF loop self-terminates
 * when its element leaves the DOM. */

import { engine, Meters } from '../audio/engine';
import { store } from '../params';

export const meterBus = {
  latest: {} as Partial<Meters>,
  hooks: new Set<(m: Partial<Meters>) => void>(),
  dispatch(m: Partial<Meters>) {
    Object.assign(this.latest, m);
    for (const h of this.hooks) h(m);
  },
};

function canvasIn(nx: number, ny: number, nw: number, nh: number, cls = ''): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.className = cls;
  c.style.cssText = `position:absolute;left:${nx * 100}%;top:${ny * 100}%;width:${nw * 100}%;height:${nh * 100}%;transform:translate(-50%,-50%)`;
  return c;
}

function fit(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const r = c.getBoundingClientRect();
  if (r.width < 4) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

const dbOf = (v: number) => 20 * Math.log10(v + 1e-6);

/* ── Gate: LED ladder + threshold tick, red when the gate is closed ── */
export function gateMeter(): HTMLCanvasElement {
  const c = canvasIn(0.4972, 0.4543, 0.372, 0.1285);
  const draw = () => {
    if (!c.isConnected) { meterBus.hooks.delete(draw); return; }
    const g = fit(c);
    if (!g) return;
    const W = c.getBoundingClientRect().width, H = c.getBoundingClientRect().height;
    g.clearRect(0, 0, W, H);
    // recessed glass
    g.fillStyle = 'rgba(4,4,6,.88)';
    g.fillRect(0, 0, W, H);
    const segs = 36, gap = 2;
    const segW = (W - 14 - gap * (segs - 1)) / segs;
    const lvlDb = dbOf(meterBus.latest.in ?? 0);
    const open = (meterBus.latest.gate ?? 1) > 0.5;
    const lit = Math.round(((Math.max(-60, Math.min(0, lvlDb)) + 60) / 60) * segs);
    for (let i = 0; i < segs; i++) {
      const x = 7 + i * (segW + gap);
      const t = i / segs;
      if (i < lit) {
        g.fillStyle = open
          ? (t > 0.86 ? '#f0e468' : `rgba(${74 + t * 60},${216},${126 + t * 30},.95)`)
          : 'rgba(216,74,74,.8)';
        g.shadowColor = open ? 'rgba(95,224,138,.6)' : 'rgba(216,74,74,.5)';
        g.shadowBlur = 6;
      } else {
        g.fillStyle = 'rgba(255,255,255,.06)';
        g.shadowBlur = 0;
      }
      g.fillRect(x, H * 0.28, segW, H * 0.44);
    }
    g.shadowBlur = 0;
    // threshold tick
    const th = store.get('gate_thresh');
    const tx = 7 + ((Math.max(-60, th) + 60) / 60) * (W - 14);
    g.fillStyle = '#eef1f6';
    g.shadowColor = 'rgba(238,241,246,.8)';
    g.shadowBlur = 5;
    g.fillRect(tx - 1, H * 0.16, 2, H * 0.68);
    g.shadowBlur = 0;
  };
  meterBus.hooks.add(draw);
  return c;
}

/* ── Comp: the render's "GR" strip becomes a live reduction bar ── */
export function compGrStrip(): HTMLCanvasElement {
  const c = canvasIn(0.5, 0.492, 0.352, 0.055);
  const draw = () => {
    if (!c.isConnected) { meterBus.hooks.delete(draw); return; }
    const g = fit(c);
    if (!g) return;
    const W = c.getBoundingClientRect().width, H = c.getBoundingClientRect().height;
    const gr = meterBus.latest.compGr ?? 0;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(4,4,6,.9)';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,.16)';
    g.strokeRect(0.5, 0.5, W - 1, H - 1);
    // reduction grows right→left, 1176-style
    const frac = Math.min(1, gr / 15);
    const bw = (W - 58) * frac;
    const grad = g.createLinearGradient(W - 8 - bw, 0, W - 8, 0);
    grad.addColorStop(0, '#8a5f2a');
    grad.addColorStop(1, '#e9b765');
    g.fillStyle = grad;
    g.shadowColor = 'rgba(233,183,101,.55)';
    g.shadowBlur = 6;
    g.fillRect(W - 8 - bw, H * 0.25, bw, H * 0.5);
    g.shadowBlur = 0;
    g.fillStyle = '#9aa0ab';
    g.font = `600 ${Math.max(8, H * 0.42)}px "Space Grotesk"`;
    g.textBaseline = 'middle';
    g.fillText('GR', 8, H / 2);
    g.fillStyle = '#f4f5f7';
    g.font = `${Math.max(9, H * 0.5)}px Dseg7, monospace`;
    g.fillText(gr > 0.3 ? `-${gr.toFixed(0)}` : ' 0', 26, H / 2 + 1);
  };
  meterBus.hooks.add(draw);
  return c;
}

/* ── Studio 1176: VU needle over the baked dial window ── */
export function vuNeedle(): HTMLCanvasElement {
  // rc(943,434,237,127) in the 1224×600 face space; pivot below the window.
  const c = canvasIn(0.8676, 0.8292, 0.1936, 0.2117);
  let disp = 0;
  const loop = () => {
    if (!c.isConnected) return;
    const g = fit(c);
    if (g) {
      const W = c.getBoundingClientRect().width, H = c.getBoundingClientRect().height;
      const gr = meterBus.latest.gr ?? 0;
      const target = Math.min(20, gr);
      disp += (target - disp) * (target > disp ? 0.25 : 0.08); // VU ballistics
      g.clearRect(0, 0, W, H);
      // 0 GR rests right of centre; reduction swings the needle left.
      const ang = (0.42 - (disp / 20) * 0.84) * 0.9; // radians from vertical
      const px = W / 2, py = H * 1.62, len = H * 1.42;
      const nx = px + Math.sin(ang) * len, ny = py - Math.cos(ang) * len;
      g.strokeStyle = 'rgba(30,20,14,.9)';
      g.lineWidth = Math.max(1.2, W * 0.008);
      g.beginPath();
      g.moveTo(px + Math.sin(ang) * H * 0.55, py - Math.cos(ang) * H * 0.55);
      g.lineTo(nx, ny);
      g.stroke();
      g.strokeStyle = 'rgba(120,32,20,.55)';
      g.lineWidth = Math.max(0.7, W * 0.004);
      g.stroke();
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return c;
}

/* ── Sauce: live spectrum + the EQ curve, in the render's glass ── */
export function sauceScope(): HTMLCanvasElement {
  // The glass's visible grid area, calibrated against the render with a
  // debug outline: inside the inner bevel on every side.
  const c = canvasIn(0.5005, 0.2715, 0.622, 0.25);
  c.style.borderRadius = '3px';
  const bins = new Float32Array(2048);
  const fMin = 40, fMax = 16000;

  // Magnitude of the current sauce curve (matches the worklet's filters).
  const curveDb = (f: number): number => {
    const k = (id: string) => store.get(id);
    let db = 0;
    const bell = (fc: number, gain: number, width: number) =>
      gain * Math.exp(-0.5 * Math.pow(Math.log2(f / fc) / width, 2));
    const shelfHi = (fc: number, gain: number) => gain / (1 + Math.pow(fc / f, 2.4));
    const shelfLo = (fc: number, gain: number) => gain / (1 + Math.pow(f / fc, 2.4));
    db += bell(180, k('sauce_body') * 6, 0.9);
    db += shelfLo(65, k('sauce_sub') * 6);
    db += bell(3000, -k('sauce_tame') * 8, 0.8);
    db += bell(6500, -k('sauce_smooth') * 8, 0.7);
    db += shelfHi(3500, k('sauce_pres') * 5);
    db += shelfHi(12000, k('sauce_air') * 6);
    const hp = 20 + k('sauce_tight') * 110;
    db -= 12 * Math.max(0, Math.log2(hp / Math.max(f, 1)));
    return db;
  };

  const loop = () => {
    if (!c.isConnected) return;
    const g = fit(c);
    const an = engine.analyser;
    if (g && an) {
      const W = c.getBoundingClientRect().width, H = c.getBoundingClientRect().height;
      an.getFloatFrequencyData(bins);
      const sr = engine.sampleRate() ?? 48000;
      g.clearRect(0, 0, W, H);
      // warm filled spectrum
      const yOf = (db: number) => H - ((Math.max(-88, Math.min(-8, db)) + 88) / 80) * H;
      g.beginPath();
      g.moveTo(0, H);
      for (let x = 0; x <= W; x += 2) {
        const f = fMin * Math.pow(fMax / fMin, x / W);
        const bi = Math.min(bins.length - 1, Math.round((f / (sr / 2)) * bins.length));
        g.lineTo(x, yOf(bins[bi]));
      }
      g.lineTo(W, H);
      g.closePath();
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, 'rgba(255,170,80,.85)');
      grad.addColorStop(0.55, 'rgba(190,85,30,.55)');
      grad.addColorStop(1, 'rgba(40,14,6,.25)');
      g.fillStyle = grad;
      g.fill();
      g.strokeStyle = 'rgba(255,233,201,.9)';
      g.lineWidth = 1.2;
      g.shadowColor = 'rgba(255,190,110,.5)';
      g.shadowBlur = 5;
      g.stroke();
      g.shadowBlur = 0;
      // the sauce EQ curve, desktop-cyan
      if (store.get('sauce_on') > 0.5) {
        g.beginPath();
        for (let x = 0; x <= W; x += 3) {
          const f = fMin * Math.pow(fMax / fMin, x / W);
          const y = H * 0.5 - (curveDb(f) / 24) * H * 0.9;
          x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.strokeStyle = 'rgba(127,216,224,.9)';
        g.lineWidth = 1.4;
        g.shadowColor = 'rgba(127,216,224,.6)';
        g.shadowBlur = 4;
        g.stroke();
        g.shadowBlur = 0;
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return c;
}

/* ── Pedal pilot jewel — lit lens when engaged, dark glass when bypassed ──
 * The renders bake a LIT pilot, so the live jewel is drawn slightly larger
 * with a feathered dark surround that swallows the baked bloom when off. */
export function pilotLed(onParam: string, nx: number, ny: number, nr: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pilot';
  wrap.style.cssText = `position:absolute;left:${nx * 100}%;top:${ny * 100}%;
    width:${nr * 2 * 2.6 * 100}%;transform:translate(-50%,-50%);pointer-events:none`;
  const lens = document.createElement('i');
  wrap.appendChild(lens);
  const sync = () => wrap.classList.toggle('on', store.get(onParam) > 0.5);
  sync();
  const un = store.subscribe((id) => {
    if (!wrap.isConnected) { un(); return; }
    if (id === onParam || id === '*') sync();
  });
  return wrap;
}

/* ── Delay: the ECHO SYNC lamp — the ACTUAL echo rhythm, routing-aware ──
 * A virtual note strikes on a repeating cycle and the jewels flash exactly
 * when each engine's echoes would land, amplitude and all:
 *   A fires at k·tA (decaying by A's feedback).
 *   B in PARALLEL hears only the dry note → m·tB.
 *   B in SERIES hears the dry note AND A's whole train → m·tB, tA+m·tB,
 *   2tA+m·tB… — the compound rhythm the routing really produces. */
export function delayLamp(engineIdx: 0 | 1 = 0): HTMLElement {
  // The baked jewels' exact centres, pixel-scanned per print (they differ
  // slightly between the A and B faces — even their heights).
  const dots = engineIdx === 0
    ? { A: { x: 0.4577, y: 0.1357 }, B: { x: 0.5384, y: 0.1271 } }
    : { A: { x: 0.4573, y: 0.1264 }, B: { x: 0.5378, y: 0.1302 } };
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  const mk = (color: string, at: { x: number; y: number }, wPct: number) => {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:${at.x * 100}%;top:${at.y * 100}%;width:${wPct}%;aspect-ratio:1;
      transform:translate(-50%,-50%);border-radius:50%;background:${color};opacity:.12;transition:none`;
    wrap.appendChild(d);
    return d;
  };
  // Live jewels sit exactly over their baked twins, a hair larger to cover.
  const dotA = mk('#5ec9c0', dots.A, 2.2);
  const dotB = mk('#e2a35c', dots.B, 2.2);
  // A small white pip at the window's left edge marks the virtual note strike
  // that the echo pattern answers.
  const pip = mk('#eef1f6', { x: 0.4315, y: 0.133 }, 1.1);

  interface Ev { t: number; a: number }
  let evA: Ev[] = [], evB: Ev[] = [], period = 4000, sig = '', epoch = performance.now();

  const rebuild = () => {
    const clamp01 = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
    const master = store.get('dly_on') > 0.5;
    const aOn = master && store.get('dlyA_on') > 0.5;
    const bOn = master && store.get('dlyB_on') > 0.5;
    const series = store.get('dly_routing') < 0.5;
    const tA = Math.max(40, store.get('dlyA_time'));
    const tB = Math.max(40, store.get('dlyB_time'));
    const fbA = clamp01(store.get('dlyA_fb'), 0.92);
    const fbB = clamp01(store.get('dlyB_fb'), 0.92);
    const HORIZON = 4500, FLOOR = 0.09;
    evA = [];
    if (aOn) for (let k = 1, a = 1; k < 40; k++) {
      const t = k * tA; a = Math.pow(fbA, k - 1);
      if (t > HORIZON || a < FLOOR) break;
      evA.push({ t, a });
    }
    evB = [];
    if (bOn) {
      // What B hears: the dry note, plus (series only) A's whole echo train.
      const sources: Ev[] = [{ t: 0, a: 1 }, ...(series ? evA : [])];
      for (const src of sources) for (let m = 1; m < 40; m++) {
        const t = src.t + m * tB;
        const a = src.a * Math.pow(fbB, m - 1);
        if (t > HORIZON || a < FLOOR) break;
        evB.push({ t, a });
      }
      evB.sort((x, y) => x.t - y.t);
    }
    const last = Math.max(0, ...evA.map((e) => e.t), ...evB.map((e) => e.t));
    period = Math.max(1600, last + 650);
    epoch = performance.now();
  };

  const shine = (dot: HTMLElement, events: Ev[], phase: number, color: string) => {
    let b = 0;
    for (const e of events) {
      let dt = phase - e.t;
      if (dt < 0) dt += period; // the strike cycle wraps
      if (dt >= 0 && dt < 320) b = Math.max(b, e.a * Math.exp(-dt / 110));
    }
    dot.style.opacity = String(0.12 + Math.min(1, b) * 0.88);
    dot.style.boxShadow = b > 0.04 ? `0 0 ${3 + b * 16}px ${color}` : 'none';
  };

  const loop = () => {
    if (!wrap.isConnected) return;
    const now = ['dly_on', 'dlyA_on', 'dlyB_on', 'dly_routing', 'dlyA_time', 'dlyB_time', 'dlyA_fb', 'dlyB_fb']
      .map((id) => Math.round(store.get(id) * 100)).join(',');
    if (now !== sig) { sig = now; rebuild(); }
    const phase = (performance.now() - epoch) % period;
    shine(dotA, evA, phase, 'rgba(94,201,192,.85)');
    shine(dotB, evB, phase, 'rgba(226,163,92,.85)');
    // the note itself: one white blink at the top of every strike cycle
    const pb = phase < 300 ? Math.exp(-phase / 90) : 0;
    pip.style.opacity = String(0.1 + pb * 0.85);
    pip.style.boxShadow = pb > 0.05 ? `0 0 ${2 + pb * 10}px rgba(238,241,246,.8)` : 'none';
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return wrap;
}
