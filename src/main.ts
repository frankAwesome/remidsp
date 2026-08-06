import './style.css';
import { engine, CaptureInfo } from './audio/engine';
import { store, paramById } from './params';
import { AMP_FACES, PEDAL_FACES, STUDIO_FACE, delayFace, FaceDef } from './geometry';
import { makeKnob, placeKnob } from './ui/knob';
import { T3kBrowser } from './ui/t3kBrowser';
import { toast } from './ui/toast';
import {
  FACTORY_PRESETS, loadUserPresets, saveUserPreset, tagUserPresetCloudId,
  deleteUserPresetAt, setPresetScope, replaceUserPresets, Preset,
} from './presets';
import { BUNDLED_AMP_CAPTURES, BUNDLED_PEDAL_CAPTURES, loadRecents, addRecent, CaptureRef } from './captures';
import { t3k, T3kError, type T3kFailure } from './tone3000';
import { openCaptureGate } from './ui/captureGate';
import { openCabWarning } from './ui/cabWarning';
import { ICONS, withIcon } from './ui/icons';
import { openTempoClash } from './ui/tempoClash';
import { DevicePicker, savedInputChoice, loadSaved } from './ui/devices';
import { meterBus, gateMeter, compGrStrip, vuNeedle, sauceScope, delayLamp, pilotLed, powerLed } from './ui/live';
import { LooperSection } from './ui/looper';
import { preloadAssets } from './ui/preload';
import { AccountUI, session } from './ui/account';
import { FeedView } from './ui/feed';
import { ProfileView } from './ui/profile';
import { openSaveDialog } from './ui/saveDialog';
import { deletePreset, myPresets, type CloudPreset, type CaptureRefDoc } from './cloud/store';

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
  // Named for what it does, like every other slot — and like the pedal's own
  // render, which reads REVERB · ONE LUSH SPACE. The rail was the only place
  // still calling it by a name the artwork underneath it never used.
  { key: 'reverb', title: 'REVERB', onParam: 'rvb_on' },
] as const;
type SlotKey = typeof SLOTS[number]['key'];

/* The boot patch is whatever sits first in the bank, and everything about the
 * opening state is derived from it rather than restated. boot() loads this
 * capture directly and then applies the preset's params WITHOUT going through
 * applyPreset — that would re-fetch the same file — which only holds together
 * while the two agree. Spelling the voice out separately is how they drift:
 * reorder the bank and the rig would claim one amp while playing another. */
const BOOT = FACTORY_PRESETS[0];
const BOOT_LABEL = BOOT.voice.replace('_', ' ');

let currentAmp = BOOT.amp;
let currentVoice = BOOT.voice;
let selectedSlot: SlotKey = 'amp';
let delayEngineShown: 0 | 1 = 0;
let quality: 'full' | 'eco' = 'full';
let customIrName: string | null = null;
let presetIdx = 0;
let currentCaptureRef: CaptureRefDoc = { source: 'bundled', stem: BOOT.voice, label: BOOT_LABEL };
let account: AccountUI;
let looper: LooperSection | null = null;
let feedView: FeedView;
let profileView: ProfileView;

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

/* ── the double-cab guard ──────────────────────────────────────────────────
 * Every switch a player can flip goes through toggleParam, so the one switch
 * that needs to ask a question first — the cabinet, on top of a capture that
 * already contains one — does not have to be wired into the drawer toggle,
 * the chain rail and the face footswitch separately.
 *
 * Preset recall deliberately does NOT come through here: it goes through
 * store.load(), so landing on a patch never throws a modal. No factory patch
 * ships with the cab on, and a saved patch that does is a call its owner
 * already made. */

/** The capture whose warning the player has already answered. Keyed by name,
 *  so loading a different capture asks again while reloading the same one
 *  respects the decision. */
let cabWarnAnsweredFor: string | null = null;

/** Turn the cabinet on, after a warning if the capture already has one. */
async function requestCabOn() {
  const cap = engine.capture;
  if (cap?.hasCab && cabWarnAnsweredFor !== cap.name) {
    const proceed = await openCabWarning({ captureName: cap.name, source: cap.source });
    cabWarnAnsweredFor = cap.name;
    if (!proceed) return;
    toast('Cab IR <b>on</b> over a full-rig capture — that is two speakers. '
          + 'Turn it off if the rig goes muffled.', 5000);
  }
  store.set('cab_on', 1);
}

function toggleParam(id: string) {
  const on = store.get(id) > 0.5;
  if (!on && id === 'cab_on') { void requestCabOn(); return; }
  store.set(id, on ? 0 : 1);
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
  b.addEventListener('click', () => toggleParam(id));
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
    hit.addEventListener('click', () => toggleParam(onParam));
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
  prev.title = 'previous preset';
  const name = el('button', 'preset__name', '');
  name.id = 'presetName';
  name.title = 'browse the preset bank';
  name.innerHTML = `${ICONS.list}<span class="preset__label">—</span>`;
  const next = el('button', 'preset__nav', '›');
  next.title = 'next preset';
  const save = el('button', 'hdr__btn hdr__btn--ico', '');
  save.innerHTML = withIcon('save', 'SAVE');
  save.title = 'save the rig as a preset';
  strip.append(prev, name, next, save);
  pr.append(strip, el('div', 'hdr__caption', 'PRESETS'));
  h.appendChild(pr);
  prev.addEventListener('click', () => stepPreset(-1));
  next.addEventListener('click', () => stepPreset(1));
  name.addEventListener('click', openPresetMenu);
  save.addEventListener('click', () => {
    openSaveDialog(
      () => ({ amp: currentAmp, voice: currentVoice, params: store.snapshot(), capture: currentCaptureRef }),
      (n) => saveUserPreset({
        name: n, group: 'USER', amp: currentAmp, voice: currentVoice,
        params: store.snapshot(), capture: currentCaptureRef,
      }),
      borrowedFrom(),
      // Remember which cloud document the local copy became, so deleting it
      // from the profile can find and remove its twin here.
      (n, cloudId) => { tagUserPresetCloudId(n, cloudId); resyncPresetStrip(); },
    );
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
  const capBtn = el('button', 'hdr__btn hdr__btn--lit hdr__btn--ico', '');
  capBtn.innerHTML = withIcon('capture', 'CAPTURES');
  capBtn.title = 'browse the TONE3000 capture library';
  cap.append(capBtn, el('div', 'hdr__caption', 'TONE3000'));
  h.appendChild(cap);
  capBtn.addEventListener('click', () => t3kBrowser.open());

  // view switch: RIG | FEED — the lit side is where you are.
  const fg = el('div', 'hdr__group');
  const sw = el('div', 'viewswitch');
  const rigBtn = el('button', 'hdr__btn hdr__btn--lit hdr__btn--ico', '');
  rigBtn.dataset.view = 'rig';
  rigBtn.innerHTML = withIcon('rig', 'RIG');
  rigBtn.title = 'the rig — amp, pedals and the looper';
  const feedBtn = el('button', 'hdr__btn hdr__btn--ico', '');
  feedBtn.dataset.view = 'feed';
  feedBtn.innerHTML = withIcon('feed', 'FEED');
  feedBtn.title = 'sounds other players have shared';
  sw.append(rigBtn, feedBtn);
  fg.append(sw, el('div', 'hdr__caption', 'VIEW'));
  h.appendChild(fg);
  rigBtn.addEventListener('click', () => setFeedMode(false));
  feedBtn.addEventListener('click', () => setFeedMode(true));

  // account
  const ag = el('div', 'hdr__group');
  ag.append(account.chip, el('div', 'hdr__caption', 'PROFILE'));
  h.appendChild(ag);

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

/** Per-slot art refresher, so selecting a module can repaint the two it affects. */
const chipArt = new Map<SlotKey, () => void>();

function buildRibbon(): HTMLElement {
  const r = el('nav', 'ribbon');
  chipArt.clear();
  for (const s of SLOTS) {
    const b = el('button', 'chip');
    b.dataset.slot = s.key;
    b.title = s.title;
    const img = document.createElement('img');
    // Two arts per module, and which one shows is a question of SELECTION, not
    // power: _off is the plain black-and-white icon, _on is the full-colour
    // one, and only the module you are looking at wears its colour. This
    // matches the desktop suite (PluginEditor.cpp keys the same filenames off
    // isSelected). Whether the module is engaged is the LED's job below.
    img.alt = s.title;
    const setImg = () => (img.src = `/assets/ui/chip_${s.key}_${s.key === selectedSlot ? 'on' : 'off'}.png`);
    setImg();
    chipArt.set(s.key, setImg);
    b.appendChild(img);
    // The corner jewel is the module's POWER switch. It used to be an 8px
    // dot — the visible glow is box-shadow, which captures no clicks, so
    // aiming at it hit the chip and merely selected the module. The live
    // hit target is now a padded corner region around the dot.
    const led = el('span', 'chip__led');
    led.setAttribute('role', 'button');
    led.title = `${s.title} — power`;
    const dot = el('span', 'led');
    led.appendChild(dot);
    b.appendChild(led);
    const syncLed = () => dot.classList.toggle('on', store.get(s.onParam) > 0.5);
    syncLed();
    store.subscribe((id) => { if (id === s.onParam || id === '*') syncLed(); });
    b.addEventListener('click', () => selectSlot(s.key));
    const togglePower = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      toggleParam(s.onParam);
    };
    led.addEventListener('pointerdown', (e) => e.stopPropagation());
    led.addEventListener('click', togglePower);
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
  // Repaint every icon: the one gaining colour and the one giving it up.
  for (const repaint of chipArt.values()) repaint();
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
  const f = facePanel(m.def, m.on);
  const ov = f.querySelector('.face__overlay')!;
  // Live pilot jewel over the render's painted dome. Positions come from a
  // LUMINANCE scan of each print (the LED is the one white-hot spot in the
  // top strip) — the earlier redness scan lied on the chorus, whose whole
  // enclosure is orange. Each was confirmed against the artwork.
  const pilots: Partial<Record<SlotKey, [number, number, number]>> = {
    gate: [0.4971, 0.0982, 0.0109],
    comp: [0.4996, 0.089, 0.0107],
    drive: [0.5, 0.113, 0.0119],
    chorus: [0.5019, 0.0926, 0.0118],
    sauce: [0.5002, 0.0729, 0.0104],
  };
  const pg = pilots[key];
  if (pg) ov.appendChild(pilotLed(m.on, pg[0], pg[1], pg[2]));
  if (key === 'drive') {
    // Live status bar covering the print's baked one under the name plate
    // (desktop resizedExtras geometry).
    const status = el('div', 'drive-status');
    status.textContent = 'CAPTURE LOADED';
    ov.appendChild(seat(status, 0.5014, 0.7489, 0.272, 0.08));
  }
  if (key === 'gate') {
    ov.appendChild(gateMeter());
    // AUTO + GLOBAL keys over their baked twins (desktop resizedExtras geometry).
    ov.appendChild(seat(autoThresholdKey(), 0.3906, 0.5665, 0.2131, 0.0868));
    ov.appendChild(seat(globalGateKey(), 0.6116, 0.5677, 0.2097, 0.0823));
  }
  else if (key === 'comp') ov.appendChild(compGrStrip());
  else if (key === 'sauce') ov.appendChild(sauceScope());
  return f;
}

/* ── Gate keys: AUTO learns the noise floor, GLOBAL pins the gate across presets ── */

const GATE_KEYS = ['gate_on', 'gate_thresh', 'gate_release', 'gate_range'] as const;
const LS_GLOBAL_GATE = 'remi_global_gate';

function autoThresholdKey(): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'gate-key';
  b.innerHTML = '<b>AUTO</b><small>learn noise floor</small>';
  const sub = b.querySelector('small')!;
  let busy = false;
  b.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    b.classList.add('learning');
    // Listen to the gate's own input (post input-trim peaks from the pre
    // worklet) while the player keeps quiet, then sit just above the floor.
    const frames: number[] = [];
    const hook = (m: { in?: number }) => { if (m.in !== undefined) frames.push(m.in); };
    meterBus.hooks.add(hook);
    let left = 2.0;
    const tick = window.setInterval(() => {
      left -= 0.25;
      sub.textContent = `listening… ${left.toFixed(1).replace(/\.0$/, '')}s`;
    }, 250);
    window.setTimeout(() => {
      clearInterval(tick);
      meterBus.hooks.delete(hook);
      b.classList.remove('learning');
      sub.textContent = 'learn noise floor';
      busy = false;
      if (frames.length < 6) { toast('No signal to measure — is the input open?'); return; }
      const floorDb = 20 * Math.log10(Math.max(...frames) + 1e-6);
      const th = Math.min(-20, Math.max(-90, floorDb + 6));
      store.set('gate_thresh', th);
      toast(`Noise floor ${floorDb.toFixed(0)} dB — gate threshold set to <b>${th.toFixed(0)} dB</b>`);
    }, 2000);
  });
  return b;
}

function globalGateKey(): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'gate-key';
  b.innerHTML = '<b>GLOBAL</b><small>every preset</small>';
  const sync = () => b.classList.toggle('on', store.get('gate_global') > 0.5);
  sync();
  const un = store.subscribe((id) => {
    if (!b.isConnected) { un(); return; }
    if (id === 'gate_global' || id === '*') sync();
  });
  b.addEventListener('click', () => {
    const on = store.get('gate_global') > 0.5 ? 0 : 1;
    store.set('gate_global', on);
    toast(on ? 'Gate is <b>global</b> — presets leave it alone'
             : 'Gate follows the <b>preset</b>');
  });
  return b;
}

function persistGlobalGate() {
  const snap: Record<string, number> = { gate_global: store.get('gate_global') };
  for (const k of GATE_KEYS) snap[k] = store.get(k);
  localStorage.setItem(LS_GLOBAL_GATE, JSON.stringify(snap));
}

function restoreGlobalGate() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_GLOBAL_GATE) ?? 'null');
    if (!saved || !(saved.gate_global > 0.5)) return;
    store.set('gate_global', 1, false);
    for (const k of GATE_KEYS) if (typeof saved[k] === 'number') store.set(k, saved[k]);
  } catch { /* stale entry */ }
}

function reverbPanel(): HTMLElement {
  const f = facePanel(PEDAL_FACES.reverb, 'rvb_on');
  const ov = f.querySelector('.face__overlay')!;
  const machine = paramSelect('rvb_machine');
  ov.appendChild(seat(machine, 0.325, 0.128, 0.14, 0.055));
  const interval = paramSelect('rvb_shimmer_mode');
  ov.appendChild(seat(interval, 0.675, 0.128, 0.15, 0.055));
  // DUCK latch fully covering its baked button (desktop resizedExtras geo).
  const duck = paramToggle('rvb_duck', 'DUCK');
  duck.style.cssText += ';width:100%;height:100%;padding:0;display:grid;place-items:center';
  ov.appendChild(seat(duck, 0.316, 0.79, 0.112, 0.07));
  ov.appendChild(pilotLed('rvb_on', 0.5, 0.132, 0.011));
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

  // Voice tabs. None of them is lit while a TONE3000 capture is on the amp —
  // currentVoice is only the bundled voice sitting underneath it, and lighting
  // it would claim the rig is playing something it isn't.
  const voices = el('div', '');
  voices.style.cssText = 'display:flex;gap:.25rem';
  const onBundled = engine.capture?.source !== 'tone3000';
  for (const v of amp.voices) {
    const b = el('button', 'tab' + (onBundled && currentVoice === v.stem ? ' on' : ''), v.label);
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
// Why the last TONE3000 capture load failed, so the gate can explain itself.
let lastCaptureError: T3kFailure | null = null;

async function loadBundledVoice(stem: string): Promise<boolean> {
  try {
    toast(`Loading <b>${stem.replace('_', ' ')}</b>…`);
    const json = await (await fetch(`/assets/captures/${stem}.nam`)).text();
    // Every bundled voice is a full-rig capture — cab, mic and room included —
    // which is what arms the double-cab warning if the cabinet gets switched on.
    const info: CaptureInfo = { name: stem.replace('_', ' '), source: 'bundled', hasCab: true };
    lastCaptureJson = json;
    await engine.loadCapture(json, info, quality === 'eco');
    currentVoice = stem;
    currentCaptureRef = { source: 'bundled', stem, label: stem.replace('_', ' ') };
    if (selectedSlot === 'amp') renderStage();
    return true;
  } catch (err) {
    toast(`Capture load failed — ${(err as Error).message}`);
    return false;
  }
}

/** Load any capture menu entry — bundled (face/voice follow) or a TONE3000
 *  recent (fetched from its model_url, Bearer applied when connected).
 *  Returns false if the capture never made it onto the amp, so a preset
 *  recall can fall back to its bundled voice instead of leaving whatever
 *  capture happened to be loaded before. */
async function loadCaptureRef(ref: CaptureRef, quiet = false): Promise<boolean> {
  if (ref.kind === 'bundled') {
    if (ref.ampKey && ref.ampKey !== currentAmp) currentAmp = ref.ampKey;
    return loadBundledVoice(ref.stem!);
  }
  lastCaptureError = null;
  try {
    toast(`Loading <b>${ref.label}</b>…`);
    const json = await (await t3k.fetchModelFile(ref.url!)).text();
    lastCaptureJson = json;
    await engine.loadCapture(json, {
      name: ref.label, source: 'tone3000',
      creator: ref.creator, license: ref.license, url: ref.toneUrl,
      // Only the gear tag can say; a ref that never carried one (an older
      // recent, or a preset's stored capture) leaves it undefined and the
      // cab warning stays quiet rather than guessing.
      hasCab: ref.gear === undefined ? undefined : ref.gear === 'amp-cab',
    }, quality === 'eco');
    currentCaptureRef = {
      source: 'tone3000', label: ref.label, modelId: ref.id, modelUrl: ref.url,
      creator: ref.creator, license: ref.license, toneUrl: ref.toneUrl,
    };
    addRecent(ref);
    store.set('amp_on', 1);
    toast(`<b>${ref.label}</b> on the amp${ref.creator ? ` · by ${ref.creator}` : ''}`);
    if (selectedSlot === 'amp') renderStage();
    return true;
  } catch (err) {
    lastCaptureError = err instanceof T3kError ? err.reason
      : t3k.connected ? 'unknown' : 'not-connected';
    if (!quiet) {
      toast(`<b>${ref.label}</b> didn't load — ${(err as Error).message}`
            + `${lastCaptureError === 'not-connected' ? '. Hit CONNECT below to sign in to TONE3000.' : '.'}`, 5000);
    }
    return false;
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
  const note = el('div', 'drawer__status drawer__status--warn');
  note.innerHTML = `${ICONS.warn}<span>Bundled amps are <b>full-rig</b> captures (cab baked in) — leave the cab
    OFF for those, or you get two speakers stacked. Pair it with amp-only DI captures from TONE3000.</span>`;
  drawer.appendChild(note);
  wrap.appendChild(drawer);
  return wrap;
}

function delayPanel(): HTMLElement {
  const wrap = el('div', '');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:.8rem;width:100%';
  const p = delayEngineShown === 0 ? 'dlyA_' : 'dlyB_';
  const f = facePanel(delayFace(delayEngineShown), p + 'on', false);
  const ov = f.querySelector('.face__overlay')!;

  // A/B engine keys + ENABLE + SYNC seated on the print's baked frames —
  // desktop-measured centre AND size, children stretched to fill the seat so
  // the live chip covers its baked twin exactly.
  const tg = delayEngineShown === 0
    ? { keyA: [0.2307, 0.1132, 0.0322, 0.0529], keyB: [0.2674, 0.1137, 0.0322, 0.0518],
        en: [0.36, 0.1137, 0.0966, 0.0541], sy: [0.6477, 0.1137, 0.0802, 0.0541] }
    : { keyA: [0.2311, 0.1063, 0.0328, 0.0551], keyB: [0.2678, 0.1063, 0.0328, 0.0551],
        en: [0.3542, 0.104, 0.0825, 0.0596], sy: [0.6483, 0.104, 0.0808, 0.0596] };
  const seatFill = (child: HTMLElement, g: number[]) => {
    child.style.cssText += ';width:100%;height:100%;padding:0;display:grid;place-items:center';
    const s = seat(child, g[0], g[1], g[2], g[3]);
    ov.appendChild(s);
  };
  const mkKey = (label: string, idx: 0 | 1, g: number[]) => {
    const b = el('button', 'tab' + (delayEngineShown === idx ? ' on' : ''), label);
    b.addEventListener('click', () => { delayEngineShown = idx; renderStage(); });
    seatFill(b, g);
  };
  mkKey('A', 0, tg.keyA);
  mkKey('B', 1, tg.keyB);
  seatFill(paramToggle(p + 'on', 'ENABLE', 'tab tab--lightlit'), tg.en);
  seatFill(paramToggle(p + 'sync', 'SYNC', 'tab tab--lightlit'), tg.sy);

  // DIVISION (bottom left) + ROUTING (bottom right) over their baked boxes.
  const divSel = paramSelect(p + 'div');
  divSel.style.height = '100%';
  ov.appendChild(seat(divSel, 0.3086, 0.827, 0.153, 0.052));
  const routSel = paramSelect('dly_routing');
  routSel.style.height = '100%';
  ov.appendChild(seat(routSel, 0.6903, 0.827, 0.155, 0.052));
  // PING-PONG chip: no baked twin — it sits top-right on the enclosure, in
  // the clear starfield between SYNC and Saturn, inside the corner screw.
  const pp = paramToggle(p + 'pingpong', 'PING-PONG', 'tab tab--mini');
  seatFill(pp, [0.7365, 0.1137, 0.0715, 0.0475]);
  // Live ECHO SYNC lamp — flashes the routing's ACTUAL echo rhythm.
  ov.appendChild(delayLamp(delayEngineShown));

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
  // The baked LED domes are now the live power controls: green jewels that
  // light when the unit is in and toggle on click (desktop rc geometry).
  ov.appendChild(powerLed('eq_on', 0.0441, 0.105, 0.0114));
  ov.appendChild(powerLed('fet_on', 0.9355, 0.65, 0.0114));
  // No text toggles here — the jewels above ARE the switches, which is how
  // the hardware reads.
  // RATIO keys — one button per baked cap, each seated on its pixel-scanned
  // rectangle so the lit key lands exactly on its printed twin.
  const d = paramById.get('fet_ratio')!;
  const capX = [0.5909, 0.6342, 0.6778, 0.7217];
  const btns: HTMLButtonElement[] = [];
  for (const [i, c] of (d.choices ?? []).entries()) {
    const b = document.createElement('button');
    b.className = 'tab';
    b.textContent = c;
    b.style.cssText = 'width:100%;height:100%;padding:0;display:grid;place-items:center';
    b.addEventListener('click', () => store.set('fet_ratio', i));
    btns.push(b);
    ov.appendChild(seat(b, capX[i], 0.812, 0.0425, 0.095));
  }
  const syncRatio = () => btns.forEach((b, i) => b.classList.toggle('on', (store.get('fet_ratio') | 0) === i));
  syncRatio();
  const unR = store.subscribe((id) => {
    if (!btns[0]?.isConnected) { unR(); return; }
    if (id === 'fet_ratio' || id === '*') syncRatio();
  });
  // Live VU needle over the baked GAIN REDUCTION dial window.
  ov.appendChild(vuNeedle());
  f.appendChild(ov);
  return f;
}

/* ────────────────────────── presets ────────────────────────── */

function allPresets(): Preset[] { return [...FACTORY_PRESETS, ...loadUserPresets()]; }

/* Somebody else's sound, on this rig.
 *
 * Loading a tone off the feed is the point of the feed — but posting it back
 * untouched is putting your name on their work. So a borrowed sound can
 * always be kept privately, and can only be shared once it has actually been
 * changed. The exact state it arrived in is held here, and the moment the
 * player moves anything away from it, it stops being theirs and starts being
 * a new sound. */
let borrowed: {
  username: string;
  snapshot: Record<string, number>;
  amp: string;
  voice: string;
  capture: string;
} | null = null;

const captureIdOf = (c: CaptureRefDoc | null | undefined) =>
  c ? `${c.source}:${c.modelId ?? c.stem ?? c.label}` : '';

/** Who this sound still belongs to, or null once it has been changed enough
 *  to be the player's own. */
function borrowedFrom(): string | null {
  if (!borrowed) return null;
  if (currentAmp !== borrowed.amp || currentVoice !== borrowed.voice) return null;
  if (captureIdOf(currentCaptureRef) !== borrowed.capture) return null;
  const now = store.snapshot();
  for (const [k, v] of Object.entries(borrowed.snapshot)) {
    if (Math.abs((now[k] ?? 0) - v) > 1e-6) return null;
  }
  return borrowed.username;
}

/* Hand the preset strip to whoever is signed in.
 *
 * The bank a player sees is the two built-in ones plus their OWN sounds, and
 * nobody else's ever appears in it. Signing in points the local store at that
 * profile's bucket and pulls their cloud library down into it, so the strip is
 * the same list on any machine they sign in on; signing out drops back to the
 * anonymous bucket, which is its own separate list rather than a view of the
 * last person's. */
async function switchPresetBank() {
  const uid = session.user?.uid ?? null;
  setPresetScope(uid);
  if (uid) {
    try {
      // YOUR SOUNDS for a signed-in player IS their cloud library — replaced,
      // not merged. That is what makes a sound deleted from the profile leave
      // the preset strip everywhere, instead of stranding a copy that nothing
      // can reach.
      const cloud = await myPresets(uid);
      replaceUserPresets(cloud.map((c) => ({
        name: c.name, group: 'USER' as const, amp: c.amp, voice: c.voice,
        params: c.params, capture: c.capture, cloudId: c.id,
      })));
    } catch { /* offline, or rules said no — the local bank still stands */ }
  }
  resyncPresetStrip();
}

/** Re-point the preset strip after the local library changed underneath it. */
function resyncPresetStrip() {
  const list = allPresets();
  const shown = document.querySelector('#presetName .preset__label')?.textContent ?? '';
  const at = list.findIndex((p) => p.name === shown);
  presetIdx = at >= 0 ? at : Math.min(presetIdx, list.length - 1);
}

/** Applies a preset; resolves false when its own TONE3000 capture could not
 *  be fetched and the rig landed on the bundled fallback instead. */
async function applyPreset(p: Preset): Promise<boolean> {
  // A recorded loop outranks a preset's tempo. Its length is fixed in samples,
  // so the bar line only lands right at the tempo it was cut at — let a preset
  // move the tempo and the click and the delays walk off the take. Ask, then
  // either hold the loop's tempo or drop the loop.
  // A patch change is a clean slate: whatever was borrowed is gone. The one
  // caller that IS loading somebody's sound re-marks it after this returns.
  borrowed = null;
  let holdTempo: number | null = null;
  if (looper?.hasLoop()) {
    const want = p.params.tempo ?? 120;
    const have = looper.loopBpm();
    if (Math.abs(want - have) >= 1) {
      const choice = await openTempoClash({
        presetName: p.name, presetBpm: want, loopBpm: have, layers: looper.layerCount(),
      });
      if (choice === 'cancel') return true;   // nothing changed, nothing failed
      if (choice === 'keep') holdTempo = have;
      else looper.clearLoop();
    }
  }

  const snap: Record<string, number> = { ...Object.fromEntries(
    [...store.values.keys()].map((k) => [k, paramById.get(k)?.def ?? 0])), ...p.params };
  // Held before the load, so syncDelays derives the repeats from the loop's
  // tempo rather than from the one the preset asked for.
  if (holdTempo !== null) snap.tempo = holdTempo;
  // GLOBAL is the player's switch, never the preset's; with it on, the
  // current gate settings outrank whatever the preset says.
  snap.gate_global = store.get('gate_global');
  if (snap.gate_global > 0.5) {
    for (const k of GATE_KEYS) snap[k] = store.get(k);
  }
  store.load(snap);
  currentAmp = p.amp;
  // The face is the preset's (p.amp), so the rig looks the way it did when
  // it was saved. The capture is whatever was actually on the amp: a
  // TONE3000 model gets re-fetched and installed directly — going through
  // the bundled voice first would swap the wasm DSP twice and stall the
  // graph for no reason. If that fetch fails (offline, not connected, model
  // pulled), the bundled voice underneath it is the fallback, so the preset
  // always lands on something.
  let captureOk = true;
  const cap = p.capture;
  if (cap?.source === 'tone3000' && cap.modelUrl) {
    currentVoice = p.voice;
    const ref: CaptureRef = {
      kind: 'tone3000', id: cap.modelId ?? cap.modelUrl, label: cap.label,
      url: cap.modelUrl, creator: cap.creator, license: cap.license, toneUrl: cap.toneUrl,
    };
    lastCaptureError = null;
    if (!await loadCaptureRef(ref, true)) {
      // Never leave the player guessing why the amp sounds wrong: name the
      // capture, say what is missing, and offer to fix it right here.
      const fallback = p.voice.replace('_', ' ');
      const ok = await openCaptureGate({
        presetName: p.name,
        captureLabel: cap.label,
        creator: cap.creator,
        fallbackLabel: fallback,
        reason: lastCaptureError ?? 'unknown',
        retry: () => loadCaptureRef(ref, true),
      });
      if (!ok) {
        captureOk = false;
        await loadBundledVoice(p.voice);
        toast(`<b>${p.name}</b> loaded on <b>${fallback}</b> — every setting applied, but `
              + `its own capture (<b>${cap.label}</b>) is still missing.`, 5000);
      }
    }
  } else {
    await loadBundledVoice(p.voice);
  }
  setPresetLabel(p.name);
  renderStage();
  return captureOk;
}

function stepPreset(dir: number) {
  const list = allPresets();
  presetIdx = (presetIdx + dir + list.length) % list.length;
  void applyPreset(list[presetIdx]);
}

/** Write the preset name into the strip without losing its icon. */
function setPresetLabel(name: string) {
  const lbl = document.querySelector<HTMLElement>('#presetName .preset__label');
  if (lbl) lbl.textContent = name;
}

/* The preset bank.
 *
 * Openable and fully drivable from the keyboard: ↑/↓ walk the list (skipping
 * the group captions), Home/End jump to the ends, Enter loads, Escape closes
 * and hands focus back to the strip. The patch you are on is marked and is
 * where the walk starts, so opening the menu and pressing ↓ always means
 * "the next one" rather than "the top of the list". */
function openPresetMenu() {
  const strip = document.getElementById('presetName')!;
  const existing = document.getElementById('presetMenu');
  if (existing) { closePresetMenu(); return; }

  const list = allPresets();
  const menu = el('div', 'presetmenu');
  menu.id = 'presetMenu';
  menu.setAttribute('role', 'listbox');
  const items: HTMLButtonElement[] = [];
  let lastGroup = '';
  list.forEach((p, i) => {
    // Same reason: a stored preset may carry no group at all, and a caption
    // reading "undefined" is how you find that out in production.
    const group = i < FACTORY_PRESETS.length ? (p.group || 'FACTORY') : 'YOUR SOUNDS';
    if (group !== lastGroup) {
      lastGroup = group;
      menu.appendChild(el('div', 'presetmenu__group', group));
    }
    const item = el('button', 'presetmenu__item') as HTMLButtonElement;
    item.setAttribute('role', 'option');
    item.type = 'button';
    const current = i === presetIdx;
    item.classList.toggle('presetmenu__item--on', current);
    item.setAttribute('aria-selected', String(current));
    item.innerHTML = `<span class="presetmenu__tick">${current ? ICONS.check : ''}</span>
      <span class="presetmenu__name">${p.name}</span>
      <span class="presetmenu__bpm">${p.params.tempo ?? 120}</span>`;
    item.addEventListener('click', () => { presetIdx = i; void applyPreset(p); closePresetMenu(); });
    items.push(item);

    // Your own patches can be thrown away from right here. This is the only
    // place that can reach a local preset whose cloud twin is already gone —
    // deleting from the profile removes both, but a preset orphaned before
    // that existed had nothing left pointing at it, and no way out of the
    // list. A row is a row and a button is a button: the ✕ is a SIBLING, not
    // a button inside a button, so keyboard walking still sees one option.
    // Deletable if it came out of the LOCAL library, decided by where it sits
    // rather than by what it claims. allPresets() is factory-then-local, so
    // the index is a fact; p.group is a field on a stored object that can be
    // absent or wrong on anything saved by an older build — and keying off it
    // is why presets have stayed stuck with no way to remove them.
    if (i >= FACTORY_PRESETS.length) {
      const row = el('div', 'presetmenu__row');
      const del = el('button', 'presetmenu__del', '✕') as HTMLButtonElement;
      del.type = 'button';
      del.title = `delete "${p.name}"`;
      del.setAttribute('aria-label', `delete ${p.name}`);
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${p.name}" from your preset list?`)) return;
        deleteUserPresetAt(i - FACTORY_PRESETS.length);
        // Take the cloud copy with it when there is one and it is reachable.
        // A missing document is the expected case for an orphan, not a fault.
        if (p.cloudId && session.user) {
          await deletePreset(p.cloudId).catch(() => undefined);
        }
        toast(`<b>${p.name}</b> deleted.`);
        resyncPresetStrip();
        closePresetMenu();
        openPresetMenu();
      });
      row.append(item, del);
      menu.appendChild(row);
    } else {
      menu.appendChild(item);
    }
  });
  strip.appendChild(menu);

  // Start the walk on the current patch so ↓ means "the next one".
  let cursor = Math.max(0, Math.min(items.length - 1, presetIdx));
  const focusAt = (n: number) => {
    cursor = (n + items.length) % items.length;
    items[cursor].focus();
    items[cursor].scrollIntoView({ block: 'nearest' });
  };
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') focusAt(cursor + 1);
    else if (e.key === 'ArrowUp') focusAt(cursor - 1);
    else if (e.key === 'Home') focusAt(0);
    else if (e.key === 'End') focusAt(items.length - 1);
    else if (e.key === 'Escape') { closePresetMenu(); strip.focus(); }
    else return;
    e.preventDefault();
  });
  focusAt(cursor);

  setTimeout(() => document.addEventListener('click', function off(e) {
    if (!menu.contains(e.target as Node) && e.target !== strip) {
      closePresetMenu();
      document.removeEventListener('click', off);
    }
  }), 0);
}

function closePresetMenu() {
  document.getElementById('presetMenu')?.remove();
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

/* Warm every face render / sprite / chip before the rig opens — module
 * switches then paint instantly. Starts at page load so the bar runs while
 * the player reads the gateway; PLUG IN waits for it to finish. */
/* The device picker is mounted at page load, not at boot: the whole point is
 * that the interface, its channel and the output are settled BEFORE the rig
 * opens, so start() takes the right input the first time instead of grabbing
 * the OS default and being corrected afterwards. */
const devicePicker = new DevicePicker();
document.getElementById('devicePicker')?.appendChild(devicePicker.root);
engine.input = savedInputChoice();

const assetsWarm = preloadAssets((done, total) => {
  const pct = Math.round((done / total) * 100);
  const bar = document.getElementById('assetBar');
  const pctEl = document.getElementById('assetPct');
  if (bar) bar.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = String(pct);
  if (done === total) document.getElementById('assetLoad')?.classList.add('done');
});

async function boot() {
  const status = document.getElementById('bootStatus')!;
  const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
  startBtn.disabled = true;
  engine.onStateChange = (s, detail) => { status.textContent = detail ?? s; };
  try {
    // Boot straight into the first patch in the bank — its voice on the amp,
    // every param it does not name left at its default.
    const bootUrl = `/assets/captures/${BOOT.voice}.nam`;
    const engineUp = engine.start(bootUrl,
      { name: BOOT_LABEL, source: 'bundled', hasCab: true });
    status.textContent = 'warming ui assets';
    await assetsWarm;
    await engineUp;
    lastCaptureJson = await (await fetch(bootUrl)).text();
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
    else if (id.startsWith('gate_') || id === '*') persistGlobalGate();
  });
  restoreGlobalGate();
  store.pushAll();
  void loadBundledIr(0);

  engine.onMeters = (m) => meterBus.dispatch(m);
  meterBus.hooks.add((m) => {
    if (m.in !== undefined && meters.in) meters.in.style.height = `${levelPct(m.in)}%`;
    if (m.out !== undefined && meters.out) meters.out.style.height = `${levelPct(m.out)}%`;
    if (m.gate !== undefined) document.getElementById('gateLed')?.classList.toggle('on', m.gate > 0.5);
  });

  const lat = engine.latencyMs();
  const latEl = document.getElementById('latency');
  if (lat && latEl) {
    const total = lat.base + lat.output + lat.quantum;
    latEl.textContent = `${total.toFixed(1)} MS @ ${((engine.sampleRate() ?? 0) / 1000).toFixed(1)}K`;
  }

  // The output device can only be routed once the context exists, so the
  // choice made on the gate is applied here rather than at pick time.
  const savedOut = loadSaved().output;
  if (savedOut !== 'default') void engine.setOutput(savedOut);

  document.getElementById('gateway')!.classList.add('hidden');
  app.hidden = false;
  if (engine.micError) {
    toast(`No input yet (${engine.micError}) — allow the microphone and click the ROUND TRIP chip to retry.`, 6000);
    document.getElementById('latency')?.addEventListener('click', async () => {
      if (await engine.retryMic()) toast('<b>Input open</b> — play.');
    });
  } else {
    toast(`<b>${BOOT.name}</b> on the amp — play.`);
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
  const openUserProfile = (uid: string) => { profileView.show(uid); setView('profile'); };
  account = new AccountUI(() => { profileView.show(null); setView('profile'); });
  feedView = new FeedView(applyCloudPreset, () => account.open(), openUserProfile);
  profileView = new ProfileView(applyCloudPreset, () => account.open(), (p) => feedView.toneCard(p));
  profileView.onSignedOut = () => setView('rig');
  profileView.onProfileSaved = () => account.refreshChip();
  profileView.onLibraryChanged = () => resyncPresetStrip();
  account.onSessionChange = () => {
    void switchPresetBank();
    if (currentView === 'feed') void feedView.refresh();
    if (currentView === 'profile') void profileView.refresh();
  };
  app.appendChild(buildHeader());
  app.appendChild(buildRibbon());
  stage.className = 'stage';
  app.appendChild(stage);
  looper = new LooperSection();
  app.appendChild(looper.root);
  app.appendChild(feedView.root);
  app.appendChild(profileView.root);
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
    // Loading a cab IR arms the cabinet — through the same guard, because
    // "I just loaded an IR" is exactly when someone stacks it on a full-rig
    // capture without realising.
    void requestCabOn();
    if (selectedSlot === 'cab') renderStage();
  });
  // Land on the boot patch for real. engine.start already loaded its voice, so
  // only the params are applied here — loading it through applyPreset would
  // re-fetch the same capture. Anything the preset doesn't name falls back to
  // that param's default, exactly as applyPreset does.
  const boot0 = FACTORY_PRESETS[0];
  store.load({
    ...Object.fromEntries([...store.values.keys()].map((k) => [k, paramById.get(k)?.def ?? 0])),
    ...boot0.params,
  });
  renderStage();
  setPresetLabel(boot0.name);
}

build();
document.getElementById('startBtn')!.addEventListener('click', () => void boot());
// A TONE3000 load lands in the CAPTURE menu's recents — refresh the drawer
// and remember it as the current capture for cloud saves.
window.addEventListener('remi:capture-loaded', () => {
  const r = loadRecents()[0];
  if (r) currentCaptureRef = {
    source: 'tone3000', label: r.label, modelId: r.id, modelUrl: r.url,
    creator: r.creator, license: r.license, toneUrl: r.toneUrl,
  };
  if (selectedSlot === 'amp') renderStage();
});

/* ── rig / feed / profile view switch + cloud preset apply ── */

type View = 'rig' | 'feed' | 'profile';
let currentView: View = 'rig';

function setView(v: View) {
  currentView = v;
  const rig = v === 'rig';
  document.querySelector<HTMLElement>('.ribbon')!.hidden = !rig;
  stage.hidden = !rig;
  document.querySelector<HTMLElement>('.looper')!.hidden = !rig;
  feedView.root.hidden = v !== 'feed';
  profileView.root.hidden = v !== 'profile';
  document.querySelectorAll<HTMLElement>('.viewswitch [data-view]').forEach((b) =>
    b.classList.toggle('hdr__btn--lit', b.dataset.view === v));
  account.chip.classList.toggle('account-chip--here', v === 'profile');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (v === 'feed') void feedView.refresh();
  if (v === 'profile') void profileView.refresh();
}

function setFeedMode(on: boolean) { setView(on ? 'feed' : 'rig'); }

async function applyCloudPreset(p: CloudPreset): Promise<boolean> {
  // The capture ref rides the preset; applyPreset installs it directly and
  // reports whether the rig ended up as its author heard it.
  const whole = await applyPreset({
    name: p.name, group: 'USER', amp: p.amp, voice: p.voice,
    params: p.params, capture: p.capture,
  });
  // Mark it as borrowed only if it is somebody else's. Reloading your own
  // sound leaves you free to post it, which you always were.
  borrowed = p.uid && p.uid === session.user?.uid ? null : {
    username: p.username || 'another player',
    snapshot: store.snapshot(),
    amp: currentAmp, voice: currentVoice, capture: captureIdOf(currentCaptureRef),
  };
  setFeedMode(false);
  return whole;
}
