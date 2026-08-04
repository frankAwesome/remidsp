import './style.css';
import { engine, CaptureInfo } from './audio/engine';
import { store, paramById } from './params';
import { AMP_FACES, PEDAL_FACES, STUDIO_FACE, delayFace, FaceDef } from './geometry';
import { makeKnob, placeKnob } from './ui/knob';
import { T3kBrowser } from './ui/t3kBrowser';
import { toast } from './ui/toast';
import { FACTORY_PRESETS, loadUserPresets, saveUserPreset, Preset } from './presets';
import { BUNDLED_AMP_CAPTURES, BUNDLED_PEDAL_CAPTURES, loadRecents, CaptureRef } from './captures';
import { t3k } from './tone3000';

/* ────────────────────────── app state ────────────────────────── */

const SLOTS = [
  { key: 'gate', title: 'NOISE GATE', onParam: 'gate_on' },
  { key: 'comp', title: 'COMPRESSOR', onParam: 'comp_on' },
  { key: 'drive', title: 'DRIVE', onParam: 'drive_on' },
  { key: 'amp', title: 'CAPTURE AMP', onParam: 'amp_on' },
  { key: 'cab', title: 'CABINET', onParam: 'cab_on' },
  { key: 'sauce', title: 'SAUCE', onParam: 'sauce_on' },
  { key: 'studio', title: 'STUDIO STRIP', onParam: 'studio_on' },
  { key: 'chorus', title: 'CHORUS', onParam: 'cho_on' },
  { key: 'delay', title: 'DELAY', onParam: 'dly_on' },
  { key: 'reverb', title: 'VAST SKY', onParam: 'rvb_on' },
] as const;
type SlotKey = typeof SLOTS[number]['key'];

let currentAmp = 'camden';
let currentVoice = 'camden_clean';
let selectedSlot: SlotKey = 'amp';
let delayEngineShown: 0 | 1 = 0;
let quality: 'full' | 'eco' = 'full';
let customIrName: string | null = null;
let presetIdx = 0;

const BUNDLED_IRS = [
  'uk_2x12_blue_onaxis', 'uk_2x12_blue_offaxis',
  'us_1x12_deluxe_onaxis', 'us_1x12_deluxe_offaxis',
];

const app = document.getElementById('app')!;
const stage = document.createElement('section');
const meters: Record<string, HTMLElement> = {};
let t3kBrowser: T3kBrowser;

/* ────────────────────────── helpers ────────────────────────── */

function el(tag: string, cls = '', html = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** A control seated on a face by centre + size fractions. */
function seat(child: HTMLElement, nx: number, ny: number, nw?: number, nh?: number): HTMLElement {
  const s = el('div', 'seat');
  s.style.left = `${nx * 100}%`;
  s.style.top = `${ny * 100}%`;
  if (nw) s.style.width = `${nw * 100}%`;
  if (nh) s.style.height = `${nh * 100}%`;
  s.appendChild(child);
  return s;
}

function paramToggle(id: string, label: string, cls = 'tab'): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  const sync = () => b.classList.toggle('on', store.get(id) > 0.5);
  sync();
  const un = store.subscribe((pid) => {
    if (!b.isConnected) { un(); return; }
    if (pid === id || pid === '*') sync();
  });
  b.addEventListener('click', () => store.set(id, store.get(id) > 0.5 ? 0 : 1));
  return b;
}

function paramSelect(id: string): HTMLSelectElement {
  const d = paramById.get(id)!;
  const s = document.createElement('select');
  for (const [i, c] of (d.choices ?? []).entries()) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = c;
    s.appendChild(o);
  }
  const sync = () => (s.value = String(store.get(id) | 0));
  sync();
  const un = store.subscribe((pid) => {
    if (!s.isConnected) { un(); return; }
    if (pid === id || pid === '*') sync();
  });
  s.addEventListener('change', () => store.set(id, Number(s.value)));
  return s;
}

/** Face panel: the render + live sprite knobs + an invisible footswitch. */
function facePanel(def: FaceDef, onParam?: string, foot = true): HTMLElement {
  const f = el('div', 'face');
  (f.style as CSSStyleDeclaration).aspectRatio = String(def.aspect);
  const art = document.createElement('img');
  art.className = 'face__art';
  art.src = def.img;
  art.alt = '';
  f.appendChild(art);
  const ov = el('div', 'face__overlay');
  for (const k of def.knobs) ov.appendChild(placeKnob(k.param, def.sprite, k.nx, k.ny, k.nr));
  if (foot && onParam) {
    const hit = el('button', '');
    hit.title = 'stomp';
    hit.style.cssText = 'position:absolute;left:50%;top:83.5%;width:10%;height:20%;transform:translate(-50%,-50%);background:none;border:0;cursor:pointer';
    hit.addEventListener('click', () => store.set(onParam, store.get(onParam) > 0.5 ? 0 : 1));
    ov.appendChild(hit);
  }
  f.appendChild(ov);
  return f;
}

/* ────────────────────────── header ────────────────────────── */

function buildHeader(): HTMLElement {
  const h = el('header', 'hdr');

  const logo = el('div', 'hdr__logo');
  logo.innerHTML = `<img src="/assets/ui/brand_logo.png" alt="R">
    <div class="hdr__word">Remi DSP<small>Maine · Web</small></div>`;
  h.appendChild(logo);
  h.appendChild(el('div', 'hdr__sep'));

  // gate cluster
  const gate = el('div', 'hdr__group');
  const gateLed = el('div', 'led');
  gateLed.id = 'gateLed';
  const gk = makeKnob('gate_thresh', '/assets/ui/knob_fx_gate.png');
  const grow = el('div', '');
  grow.style.cssText = 'display:flex;align-items:center;gap:.5rem';
  grow.append(gateLed, gk);
  gate.append(grow, el('div', 'hdr__caption', 'THRESH'));
  h.appendChild(gate);
  h.appendChild(el('div', 'hdr__sep'));

  // presets
  const pr = el('div', 'hdr__group');
  const strip = el('div', 'preset');
  const prev = el('button', 'preset__nav', '‹');
  const name = el('button', 'preset__name', '—');
  name.id = 'presetName';
  const next = el('button', 'preset__nav', '›');
  const save = el('button', 'hdr__btn', 'SAVE');
  strip.append(prev, name, next, save);
  pr.append(strip, el('div', 'hdr__caption', 'PRESETS'));
  h.appendChild(pr);
  prev.addEventListener('click', () => stepPreset(-1));
  next.addEventListener('click', () => stepPreset(1));
  name.addEventListener('click', openPresetMenu);
  save.addEventListener('click', () => {
    const n = prompt('Preset name');
    if (!n) return;
    saveUserPreset({ name: n, group: 'USER', amp: currentAmp, voice: currentVoice, params: store.snapshot() });
    toast(`Saved <b>${n}</b>`);
  });

  // tempo
  const tg = el('div', 'hdr__group');
  const tempo = el('div', 'tempo');
  const tval = el('div', 'tempo__val led-text', '120.0');
  tval.id = 'tempoVal';
  const tap = el('button', 'tempo__tap', 'TAP');
  tempo.append(tval, el('span', 'tempo__unit', 'BPM'), tap);
  tg.append(tempo, el('div', 'hdr__caption', 'TEMPO'));
  h.appendChild(tg);
  wireTempo(tval, tap);

  // captures
  const cap = el('div', 'hdr__group');
  const capBtn = el('button', 'hdr__btn hdr__btn--lit', 'CAPTURES');
  cap.append(capBtn, el('div', 'hdr__caption', 'TONE3000'));
  h.appendChild(cap);
  capBtn.addEventListener('click', () => t3kBrowser.open());

  h.appendChild(el('div', 'hdr__spacer'));

  // latency chip
  const lat = el('div', 'hdr__group');
  const latVal = el('div', 'mono', '— MS');
  latVal.id = 'latency';
  lat.append(latVal, el('div', 'hdr__caption', 'ROUND TRIP'));
  h.appendChild(lat);
  h.appendChild(el('div', 'hdr__sep'));

  // io
  for (const [id, label] of [['in', 'INPUT'], ['out', 'OUTPUT']] as const) {
    const g = el('div', 'hdr__group');
    const row = el('div', '');
    row.style.cssText = 'display:flex;align-items:center;gap:.4rem';
    const m = el('div', 'meter');
    m.appendChild(el('i', ''));
    meters[id] = m.firstElementChild as HTMLElement;
    row.append(makeKnob(id, '/assets/ui/knob_ssl_silver.png'), m);
    g.append(row, el('div', 'hdr__caption', label));
    h.appendChild(g);
  }
  return h;
}

function wireTempo(tval: HTMLElement, tap: HTMLElement) {
  const render = () => (tval.textContent = store.get('tempo').toFixed(1));
  store.subscribe((id) => { if (id === 'tempo' || id === '*') render(); });
  render();
  let drag: { y: number; v: number } | null = null;
  tval.style.cursor = 'ns-resize';
  tval.addEventListener('pointerdown', (e) => {
    drag = { y: (e as PointerEvent).clientY, v: store.get('tempo') };
    (tval as HTMLElement & { setPointerCapture(id: number): void }).setPointerCapture((e as PointerEvent).pointerId);
  });
  tval.addEventListener('pointermove', (e) => {
    if (drag) store.set('tempo', Math.round((drag.v + (drag.y - (e as PointerEvent).clientY) * 0.25) * 2) / 2);
  });
  tval.addEventListener('pointerup', () => (drag = null));
  const taps: number[] = [];
  tap.addEventListener('click', () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length >= 2) {
      const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      store.set('tempo', Math.round((60000 / iv) * 2) / 2);
    }
  });
}

/* ────────────────────────── ribbon ────────────────────────── */

function buildRibbon(): HTMLElement {
  const r = el('nav', 'ribbon');
  for (const s of SLOTS) {
    const b = el('button', 'chip');
    b.dataset.slot = s.key;
    b.title = s.title;
    const img = document.createElement('img');
    const setImg = () => (img.src = `/assets/ui/chip_${s.key === 'chorus' ? 'chorus' : s.key}_${store.get(s.onParam) > 0.5 ? 'on' : 'off'}.png`);
    setImg();
    b.appendChild(img);
    const led = el('div', 'chip__led');
    const dot = el('div', 'led');
    led.appendChild(dot);
    b.appendChild(led);
    const syncLed = () => {
      dot.classList.toggle('on', store.get(s.onParam) > 0.5);
      setImg();
    };
    syncLed();
    store.subscribe((id) => { if (id === s.onParam || id === '*') syncLed(); });
    b.addEventListener('click', () => selectSlot(s.key));
    led.addEventListener('click', (e) => {
      e.stopPropagation();
      store.set(s.onParam, store.get(s.onParam) > 0.5 ? 0 : 1);
    });
    r.appendChild(b);
  }
  const sync = () => r.querySelectorAll<HTMLElement>('.chip').forEach(
    (c) => c.classList.toggle('sel', c.dataset.slot === selectedSlot));
  sync();
  r.addEventListener('click', sync);
  return r;
}

function selectSlot(k: SlotKey) {
  selectedSlot = k;
  document.querySelectorAll<HTMLElement>('.chip').forEach(
    (c) => c.classList.toggle('sel', c.dataset.slot === k));
  renderStage();
}

/* ────────────────────────── panels ────────────────────────── */

function renderStage() {
  stage.innerHTML = '';
  stage.appendChild(el('div', 'stage__glow'));
  switch (selectedSlot) {
    case 'amp': stage.appendChild(ampPanel()); break;
    case 'cab': stage.appendChild(cabPanel()); break;
    case 'delay': stage.appendChild(delayPanel()); break;
    case 'studio': stage.appendChild(studioPanel()); break;
    case 'reverb': stage.appendChild(reverbPanel()); break;
    default: stage.appendChild(pedalPanel(selectedSlot));
  }
}

function pedalPanel(key: SlotKey): HTMLElement {
  const map: Partial<Record<SlotKey, { def: FaceDef; on: string }>> = {
    gate: { def: PEDAL_FACES.gate, on: 'gate_on' },
    comp: { def: PEDAL_FACES.comp, on: 'comp_on' },
    drive: { def: PEDAL_FACES.drive, on: 'drive_on' },
    chorus: { def: PEDAL_FACES.chorus, on: 'cho_on' },
    sauce: { def: PEDAL_FACES.sauce, on: 'sauce_on' },
  };
  const m = map[key]!;
  return facePanel(m.def, m.on);
}

function reverbPanel(): HTMLElement {
  const f = facePanel(PEDAL_FACES.reverb, 'rvb_on');
  const ov = f.querySelector('.face__overlay')!;
  const machine = paramSelect('rvb_machine');
  ov.appendChild(seat(machine, 0.325, 0.128, 0.14, 0.055));
  const interval = paramSelect('rvb_shimmer_mode');
  ov.appendChild(seat(interval, 0.675, 0.128, 0.15, 0.055));
  const duck = paramToggle('rvb_duck', 'DUCK');
  ov.appendChild(seat(duck, 0.339, 0.847)); // over the print's baked DUCK pill
  return f;
}

function ampPanel(): HTMLElement {
  const wrap = el('div', '');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:.8rem;width:100%';
  const amp = AMP_FACES[currentAmp];
  wrap.appendChild(facePanel(amp, 'amp_on', false));

  const drawer = el('div', 'drawer');
  // power LED
  const pw = el('div', 'power');
  const led = el('div', 'led');
  const syncLed = () => led.classList.toggle('on', store.get('amp_on') > 0.5);
  syncLed();
  store.subscribe((id) => { if (id === 'amp_on' || id === '*') syncLed(); });
  pw.append(led, el('span', '', 'AMP'));
  pw.addEventListener('click', () => store.set('amp_on', store.get('amp_on') > 0.5 ? 0 : 1));
  drawer.appendChild(pw);

  // amp model select
  const sel = document.createElement('select');
  for (const [k, a] of Object.entries(AMP_FACES)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = a.name;
    if (k === currentAmp) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    currentAmp = sel.value;
    loadBundledVoice(AMP_FACES[currentAmp].voices[0].stem);
    renderStage();
  });
  drawer.appendChild(sel);

  // voice tabs
  const voices = el('div', '');
  voices.style.cssText = 'display:flex;gap:.25rem';
  for (const v of amp.voices) {
    const b = el('button', 'tab' + (currentVoice === v.stem ? ' on' : ''), v.label);
    b.addEventListener('click', () => loadBundledVoice(v.stem));
    voices.appendChild(b);
  }
  const vcap = el('div', 'hdr__group');
  vcap.append(voices, el('div', 'drawer__caption', 'VOICE'));
  drawer.appendChild(vcap);

  // capture menu: every bundled capture + recent TONE3000 loads, with LOAD.
  const capGroup = el('div', 'hdr__group');
  const capRow = el('div', '');
  capRow.style.cssText = 'display:flex;gap:.35rem;align-items:center';
  const capSel = document.createElement('select');
  const addGroup = (label: string, refs: CaptureRef[], prefix: string) => {
    if (!refs.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const r of refs) {
      const o = document.createElement('option');
      o.value = `${prefix}:${r.id}`;
      o.textContent = r.label;
      if (engine.capture &&
          ((r.kind === 'bundled' && engine.capture.source === 'bundled' && r.stem === currentVoice) ||
           (r.kind === 'tone3000' && engine.capture.source === 'tone3000' && engine.capture.name === r.label)))
        o.selected = true;
      g.appendChild(o);
    }
    capSel.appendChild(g);
  };
  const recents = loadRecents();
  addGroup('AMPS — BUNDLED', BUNDLED_AMP_CAPTURES, 'b');
  addGroup('PEDALS — BUNDLED', BUNDLED_PEDAL_CAPTURES, 'b');
  addGroup('TONE3000 — RECENT', recents, 'r');
  const loadBtn = el('button', 'hdr__btn', 'LOAD');
  loadBtn.addEventListener('click', () => {
    const [kind, id] = (capSel.value ?? '').split(/:(.*)/s);
    const ref = kind === 'b'
      ? [...BUNDLED_AMP_CAPTURES, ...BUNDLED_PEDAL_CAPTURES].find((r) => r.id === id)
      : recents.find((r) => r.id === id);
    if (ref) void loadCaptureRef(ref);
  });
  capRow.append(capSel, loadBtn);
  capGroup.append(capRow, el('div', 'drawer__caption', 'CAPTURE'));
  drawer.appendChild(capGroup);

  drawer.appendChild(el('div', 'drawer__spacer'));

  // capture status
  const status = el('div', 'drawer__status');
  const syncStatus = () => {
    const c = engine.capture;
    status.innerHTML = c
      ? c.source === 'tone3000'
        ? `<b>${c.name}</b> · by ${c.creator ?? '—'} · ${c.license ?? ''} · TONE3000`
        : `<b>${c.name}</b> · bundled capture`
      : 'no capture — amp runs clean';
  };
  syncStatus();
  engine.onCaptureChange = () => { syncStatus(); };
  drawer.appendChild(status);

  // tone3000 + quality
  const browse = el('button', 'hdr__btn', 'BROWSE CAPTURES');
  browse.addEventListener('click', () => t3kBrowser.open());
  drawer.appendChild(browse);
  const q = el('button', 'hdr__btn', quality === 'eco' ? 'ECO' : 'FULL');
  q.title = 'A2 capture quality — ECO runs the smallest submodel (lower CPU)';
  q.addEventListener('click', async () => {
    quality = quality === 'eco' ? 'full' : 'eco';
    q.textContent = quality.toUpperCase();
    await reloadCurrentCapture();
  });
  drawer.appendChild(q);

  wrap.appendChild(drawer);
  return wrap;
}

let lastCaptureJson: string | null = null;

async function loadBundledVoice(stem: string) {
  try {
    toast(`Loading <b>${stem.replace('_', ' ')}</b>…`);
    const json = await (await fetch(`/assets/captures/${stem}.nam`)).text();
    const info: CaptureInfo = { name: stem.replace('_', ' '), source: 'bundled' };
    lastCaptureJson = json;
    await engine.loadCapture(json, info, quality === 'eco');
    currentVoice = stem;
    if (selectedSlot === 'amp') renderStage();
  } catch (err) {
    toast(`Capture load failed — ${(err as Error).message}`);
  }
}

/** Load any capture menu entry — bundled (face/voice follow) or a TONE3000
 *  recent (fetched from its model_url, Bearer applied when connected). */
async function loadCaptureRef(ref: CaptureRef) {
  if (ref.kind === 'bundled') {
    if (ref.ampKey && ref.ampKey !== currentAmp) currentAmp = ref.ampKey;
    await loadBundledVoice(ref.stem!);
    return;
  }
  try {
    toast(`Loading <b>${ref.label}</b>…`);
    const json = await (await t3k.fetchModelFile(ref.url!)).text();
    lastCaptureJson = json;
    await engine.loadCapture(json, {
      name: ref.label, source: 'tone3000',
      creator: ref.creator, license: ref.license, url: ref.toneUrl,
    }, quality === 'eco');
    store.set('amp_on', 1);
    toast(`<b>${ref.label}</b> on the amp${ref.creator ? ` · by ${ref.creator}` : ''}`);
    if (selectedSlot === 'amp') renderStage();
  } catch (err) {
    toast(`Load failed — ${(err as Error).message}${t3k.connected ? '' : ' (connect TONE3000 in the CAPTURES drawer)'}`);
  }
}

async function reloadCurrentCapture() {
  if (!lastCaptureJson || !engine.capture) return;
  await engine.loadCapture(lastCaptureJson, engine.capture, quality === 'eco');
  toast(`Capture quality: <b>${quality.toUpperCase()}</b>`);
}

function cabPanel(): HTMLElement {
  const wrap = el('div', '');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:.8rem;width:100%';
  const f = el('div', 'face');
  f.style.maxWidth = '640px';
  const art = document.createElement('img');
  art.className = 'face__art';
  art.src = '/assets/ui/cab_face_ac30.png';
  f.appendChild(art);
  wrap.appendChild(f);

  const drawer = el('div', 'drawer');
  drawer.appendChild(paramToggle('cab_on', 'CAB IR', 'tab tab--lightlit'));
  const sel = paramSelect('cab_ir');
  if (customIrName) {
    const o = document.createElement('option');
    o.value = '99';
    o.textContent = `T3K · ${customIrName}`;
    o.selected = true;
    sel.appendChild(o);
  }
  drawer.appendChild(sel);
  drawer.appendChild(el('div', 'drawer__spacer'));
  drawer.appendChild(el('div', 'drawer__status',
    'Bundled amps are <b>full-rig</b> captures (cab baked in) — leave the cab OFF for those. ' +
    'Pair it with amp-only DI captures from TONE3000.'));
  wrap.appendChild(drawer);
  return wrap;
}

function delayPanel(): HTMLElement {
  const wrap = el('div', '');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:.8rem;width:100%';
  const p = delayEngineShown === 0 ? 'dlyA_' : 'dlyB_';
  const f = facePanel(delayFace(delayEngineShown), p + 'on', false);
  const ov = f.querySelector('.face__overlay')!;

  // A/B engine keys + ENABLE + SYNC seated on the print's baked frames.
  const tg = delayEngineShown === 0
    ? { keyA: [0.2307, 0.1132], keyB: [0.2674, 0.1137], en: [0.36, 0.1137, 0.0966, 0.0541], sy: [0.6477, 0.1137, 0.0802, 0.0541] }
    : { keyA: [0.2311, 0.1063], keyB: [0.2678, 0.1063], en: [0.3542, 0.104, 0.0825, 0.0596], sy: [0.6483, 0.104, 0.0808, 0.0596] };
  const mkKey = (label: string, idx: 0 | 1, at: number[]) => {
    const b = el('button', 'tab' + (delayEngineShown === idx ? ' on' : ''), label);
    b.addEventListener('click', () => { delayEngineShown = idx; renderStage(); });
    ov.appendChild(seat(b, at[0], at[1]));
  };
  mkKey('A', 0, tg.keyA);
  mkKey('B', 1, tg.keyB);
  ov.appendChild(seat(paramToggle(p + 'on', 'ENABLE', 'tab tab--lightlit'), tg.en[0], tg.en[1]));
  ov.appendChild(seat(paramToggle(p + 'sync', 'SYNC', 'tab tab--lightlit'), tg.sy[0], tg.sy[1]));

  // DIVISION (bottom left) + ROUTING (bottom right) over their baked boxes.
  ov.appendChild(seat(paramSelect(p + 'div'), 0.3086, 0.827, 0.153, 0.052));
  ov.appendChild(seat(paramSelect('dly_routing'), 0.6903, 0.827, 0.155, 0.052));
  // PING-PONG chip under the tempo lamp.
  ov.appendChild(seat(paramToggle(p + 'pingpong', 'PING-PONG'), 0.5, 0.235));

  // foot: stomps the ACTIVE engine (and revives the master).
  const hit = el('button', '');
  hit.style.cssText = 'position:absolute;left:50%;top:83.4%;width:9.5%;height:20%;transform:translate(-50%,-50%);background:none;border:0;cursor:pointer';
  hit.addEventListener('click', () => {
    const v = store.get(p + 'on') > 0.5 ? 0 : 1;
    store.set(p + 'on', v);
    if (v && store.get('dly_on') < 0.5) store.set('dly_on', 1);
  });
  ov.appendChild(hit);

  wrap.appendChild(f);
  return wrap;
}

function studioPanel(): HTMLElement {
  const f = el('div', 'face');
  (f.style as CSSStyleDeclaration).aspectRatio = String(STUDIO_FACE.aspect);
  const art = document.createElement('img');
  art.className = 'face__art';
  art.src = STUDIO_FACE.img;
  f.appendChild(art);
  const ov = el('div', 'face__overlay');
  for (const k of STUDIO_FACE.knobs) ov.appendChild(placeKnob(k.param, k.sprite, k.nx, k.ny, k.nr));
  // EQ + comp power jewels over their baked LED domes.
  ov.appendChild(seat(paramToggle('eq_on', 'EQ', 'tab tab--lightlit'), 0.055, 0.082));
  ov.appendChild(seat(paramToggle('fet_on', 'COMP', 'tab tab--lightlit'), 0.938, 0.627));
  // RATIO keys over the baked caps (render x 1006-1302, y 699-775 → 1224×600).
  const ratio = el('div', '');
  ratio.style.cssText = 'display:flex;gap:2.5%;width:100%;height:100%';
  const d = paramById.get('fet_ratio')!;
  const btns: HTMLButtonElement[] = [];
  for (const [i, c] of (d.choices ?? []).entries()) {
    const b = document.createElement('button');
    b.className = 'tab';
    b.textContent = c;
    b.style.flex = '1';
    b.style.padding = '0';
    b.addEventListener('click', () => store.set('fet_ratio', i));
    btns.push(b);
    ratio.appendChild(b);
  }
  const syncRatio = () => btns.forEach((b, i) => b.classList.toggle('on', (store.get('fet_ratio') | 0) === i));
  syncRatio();
  const unR = store.subscribe((id) => {
    if (!ratio.isConnected) { unR(); return; }
    if (id === 'fet_ratio' || id === '*') syncRatio();
  });
  ov.appendChild(seat(ratio, 0.6574, 0.8226, 0.169, 0.085));
  // GR readout over the VU window.
  const gr = el('div', 'led-text');
  gr.id = 'grReadout';
  gr.style.cssText = 'color:#2b2416;font-size:1.1rem;text-shadow:0 0 6px rgba(0,0,0,.2)';
  ov.appendChild(seat(gr, 0.868, 0.82));
  f.appendChild(ov);
  return f;
}

/* ────────────────────────── presets ────────────────────────── */

function allPresets(): Preset[] { return [...FACTORY_PRESETS, ...loadUserPresets()]; }

async function applyPreset(p: Preset) {
  const snap: Record<string, number> = { ...Object.fromEntries(
    [...store.values.keys()].map((k) => [k, paramById.get(k)?.def ?? 0])), ...p.params };
  store.load(snap);
  currentAmp = p.amp;
  await loadBundledVoice(p.voice);
  const nameEl = document.getElementById('presetName');
  if (nameEl) nameEl.textContent = p.name;
  renderStage();
}

function stepPreset(dir: number) {
  const list = allPresets();
  presetIdx = (presetIdx + dir + list.length) % list.length;
  void applyPreset(list[presetIdx]);
}

function openPresetMenu() {
  const existing = document.getElementById('presetMenu');
  if (existing) { existing.remove(); return; }
  const list = allPresets();
  const menu = el('div', '');
  menu.id = 'presetMenu';
  menu.style.cssText = `position:absolute;top:110%;left:50%;transform:translateX(-50%);z-index:250;
    background:#0a0a0d;border:1px solid var(--line-2);min-width:240px;max-height:340px;overflow-y:auto;
    box-shadow:0 20px 50px rgba(0,0,0,.7);padding:.3rem 0`;
  let lastGroup = '';
  list.forEach((p, i) => {
    if (p.group !== lastGroup) {
      lastGroup = p.group;
      menu.appendChild(el('div', 'hdr__caption', p.group)).setAttribute('style', 'padding:.45rem .9rem .2rem');
    }
    const item = el('button', '', p.name);
    item.style.cssText = 'display:block;width:100%;text-align:left;padding:.4rem .9rem;font-size:.8rem';
    item.addEventListener('mouseenter', () => (item.style.background = 'rgba(255,255,255,.06)'));
    item.addEventListener('mouseleave', () => (item.style.background = ''));
    item.addEventListener('click', () => { presetIdx = i; void applyPreset(p); menu.remove(); });
    menu.appendChild(item);
  });
  document.getElementById('presetName')!.appendChild(menu);
  setTimeout(() => document.addEventListener('click', function off(e) {
    if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener('click', off); }
  }), 0);
}

/* ────────────────────────── cab IR loading ────────────────────────── */

async function loadBundledIr(index: number) {
  try {
    const url = `/assets/irs/${BUNDLED_IRS[index]}.wav`;
    const arr = await (await fetch(url)).arrayBuffer();
    const buf = await engine.ctx!.decodeAudioData(arr);
    engine.setCabIr(buf);
    customIrName = null;
  } catch (err) {
    toast(`IR load failed — ${(err as Error).message}`);
  }
}

/* ────────────────────────── boot ────────────────────────── */

async function boot() {
  const status = document.getElementById('bootStatus')!;
  const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
  startBtn.disabled = true;
  engine.onStateChange = (s, detail) => { status.textContent = detail ?? s; };
  try {
    await engine.start('/assets/captures/camden_clean.nam',
      { name: 'camden clean', source: 'bundled' });
    lastCaptureJson = await (await fetch('/assets/captures/camden_clean.nam')).text();
  } catch (err) {
    status.textContent = `failed: ${(err as Error).message}`;
    startBtn.disabled = false;
    return;
  }

  // engine-level params that live outside the worklets
  store.subscribe((id, v) => {
    if (id === 'amp_on') engine.enableAmp(v > 0.5);
    else if (id === 'cab_on') engine.enableCab(v > 0.5);
    else if (id === 'cab_ir' && v < 90) void loadBundledIr(v | 0);
  });
  store.pushAll();
  void loadBundledIr(0);

  engine.onMeters = (m) => {
    if (m.in !== undefined && meters.in) meters.in.style.height = `${levelPct(m.in)}%`;
    if (m.out !== undefined && meters.out) meters.out.style.height = `${levelPct(m.out)}%`;
    if (m.gate !== undefined) document.getElementById('gateLed')?.classList.toggle('on', m.gate > 0.5);
    if (m.gr !== undefined) {
      const el2 = document.getElementById('grReadout');
      if (el2) el2.textContent = m.gr > 0.3 ? `-${m.gr.toFixed(0)}` : '0';
    }
  };

  const lat = engine.latencyMs();
  const latEl = document.getElementById('latency');
  if (lat && latEl) {
    const total = lat.base + lat.output + lat.quantum;
    latEl.textContent = `${total.toFixed(1)} MS @ ${((engine.sampleRate() ?? 0) / 1000).toFixed(1)}K`;
  }

  document.getElementById('gateway')!.classList.add('hidden');
  app.hidden = false;
  if (engine.micError) {
    toast(`No input yet (${engine.micError}) — allow the microphone and click the ROUND TRIP chip to retry.`, 6000);
    document.getElementById('latency')?.addEventListener('click', async () => {
      if (await engine.retryMic()) toast('<b>Input open</b> — play.');
    });
  } else {
    toast('<b>Camden clean</b> on the amp — play.');
  }
  // console access for driving the rig while testing
  (window as unknown as { __rig: unknown }).__rig = { engine, store };
}

function levelPct(v: number): number {
  const db = 20 * Math.log10(v + 1e-6);
  return Math.max(0, Math.min(100, (db + 60) / 60 * 100));
}

/* ────────────────────────── assemble ────────────────────────── */

function build() {
  app.appendChild(buildHeader());
  app.appendChild(buildRibbon());
  stage.className = 'stage';
  app.appendChild(stage);
  const foot = el('footer', 'foot');
  foot.innerHTML = `<span class="foot__brand">Remi</span>
    <span class="mono">MAINE · WEB SUITE · v0.1</span>
    <a href="https://www.tone3000.com" target="_blank" rel="noreferrer">Powered by TONE3000</a>
    <a href="https://github.com/sdatkinson/NeuralAmpModelerCore" target="_blank" rel="noreferrer">NAM core (MIT)</a>
    <span class="mono" id="cpuNote">WASM SIMD · AUDIOWORKLET · 128-SAMPLE QUANTUM</span>`;
  app.appendChild(foot);
  t3kBrowser = new T3kBrowser((buf, name) => {
    engine.setCabIr(buf);
    customIrName = name;
    store.set('cab_on', 1, true);
    if (selectedSlot === 'cab') renderStage();
  });
  renderStage();
  const nameEl = document.getElementById('presetName');
  if (nameEl) nameEl.textContent = FACTORY_PRESETS[0].name;
}

build();
document.getElementById('startBtn')!.addEventListener('click', () => void boot());
// A TONE3000 load lands in the CAPTURE menu's recents — refresh the drawer.
window.addEventListener('remi:capture-loaded', () => {
  if (selectedSlot === 'amp') renderStage();
});
