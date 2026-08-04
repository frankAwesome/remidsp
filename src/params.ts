/* Central parameter registry — ids mirror the plugin's APVTS ids (worklet
 * routes on the prefix). Every knob/toggle/choice in the UI binds here; the
 * store forwards changes to the engine and snapshots into presets. */

import { engine } from './audio/engine';

export interface ParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  def: number;
  skew?: number;          // <1 gives low-end resolution like JUCE skew
  unit?: string;
  choices?: string[];     // discrete parameter
  format?: (v: number) => string;
}

const pct = (v: number) => `${Math.round(v * 100)}`;
const ms0 = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}`;
const hz = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
const db1 = (v: number) => v.toFixed(1);
const dial = (v: number) => (v * 10).toFixed(1);

function delayEngineParams(x: 'A' | 'B', onDef: number, modeDef: number): ParamDef[] {
  const p = `dly${x}_`;
  return [
    { id: p + 'on', label: 'ENABLE', min: 0, max: 1, def: onDef },
    { id: p + 'sync', label: 'SYNC', min: 0, max: 1, def: 1 },
    { id: p + 'div', label: 'DIVISION', min: 0, max: 8, def: 2, choices: DIVISIONS },
    { id: p + 'time', label: 'TIME', min: 20, max: 1500, def: 357, skew: 0.5, unit: 'ms', format: ms0 },
    { id: p + 'fb', label: 'FEEDBACK', min: 0, max: 1.1, def: 0.42, unit: '%', format: pct },
    { id: p + 'mix', label: 'MIX', min: 0, max: 1.2, def: 0.35, unit: '%', format: pct },
    { id: p + 'mode', label: 'TYPE', min: 0, max: 3, def: modeDef, choices: ['Digital', 'Studio', 'Analog', 'Tape'] },
    { id: p + 'mod_rate', label: 'MOD RATE', min: 0.1, max: 10, def: 0.8, skew: 0.6, unit: 'Hz' },
    { id: p + 'mod_depth', label: 'MOD', min: 0, max: 1, def: 0.15, unit: '%', format: pct },
    { id: p + 'grit', label: 'GRIT', min: 0, max: 1, def: 0.25, unit: '%', format: pct },
    { id: p + 'hicut', label: 'TONE', min: 1000, max: 16000, def: 9000, skew: 0.5, unit: 'Hz', format: hz },
    { id: p + 'pingpong', label: 'PING-PONG', min: 0, max: 1, def: 0 },
    { id: p + 'offset', label: 'OFFSET', min: -30, max: 30, def: 0, unit: 'ms' },
    { id: p + 'duck', label: 'DUCK', min: 0, max: 1, def: 0, unit: '%', format: pct },
    { id: p + 'wet_hp', label: 'HI-PASS', min: 20, max: 2000, def: 20, skew: 0.35, unit: 'Hz', format: hz },
    { id: p + 'wet_lp', label: 'LO-PASS', min: 800, max: 20000, def: 20000, skew: 0.35, unit: 'Hz', format: hz },
  ];
}

export const DIVISIONS = ['1/2', '1/4', '3/16 dotted 8th', '1/8', '1/8 triplet', '3/32', '9/32', '1/16', 'Manual'];
// Multiples of a quarter note, index-aligned with DIVISIONS ('Manual' = free).
export const DIVISION_FACTORS = [2, 1, 0.75, 0.5, 1 / 3, 0.375, 1.125, 0.25, 0];

export const PARAMS: ParamDef[] = [
  { id: 'in', label: 'INPUT', min: -24, max: 24, def: 0, unit: 'dB', format: db1 },
  { id: 'out', label: 'OUTPUT', min: -24, max: 24, def: 0, unit: 'dB', format: db1 },
  { id: 'tempo', label: 'TEMPO', min: 40, max: 240, def: 120, unit: 'BPM' },

  { id: 'gate_on', label: 'GATE', min: 0, max: 1, def: 1 },
  { id: 'gate_global', label: 'GLOBAL', min: 0, max: 1, def: 1 },
  { id: 'gate_thresh', label: 'THRESH', min: -90, max: -20, def: -56, unit: 'dB' },
  { id: 'gate_release', label: 'RELEASE', min: 20, max: 600, def: 140, skew: 0.4, unit: 'ms', format: ms0 },
  { id: 'gate_range', label: 'RANGE', min: 6, max: 90, def: 80, unit: 'dB' },

  { id: 'comp_on', label: 'COMP', min: 0, max: 1, def: 1 },
  { id: 'comp_sustain', label: 'SUSTAIN', min: 0, max: 1, def: 0.35, unit: '%', format: pct },
  { id: 'comp_attack', label: 'ATTACK', min: 1, max: 50, def: 8, skew: 0.5, unit: 'ms', format: ms0 },
  { id: 'comp_level', label: 'LEVEL', min: -12, max: 12, def: 0, unit: 'dB', format: db1 },

  { id: 'drive_on', label: 'DRIVE', min: 0, max: 1, def: 0 },
  { id: 'drive_gain', label: 'DRIVE', min: 0, max: 1, def: 0.35, format: dial },
  { id: 'drive_tone', label: 'TONE', min: 0, max: 1, def: 0.5, format: dial },
  { id: 'drive_level', label: 'LEVEL', min: 0, max: 1, def: 0.5, format: dial },
  { id: 'drive_air', label: 'AIR', min: 0, max: 1, def: 0.5, format: dial },

  { id: 'amp_on', label: 'AMP', min: 0, max: 1, def: 1 },
  { id: 'amp_gain', label: 'GAIN', min: 0, max: 1, def: 0.45, format: dial },
  { id: 'amp_bass', label: 'BASS', min: 0, max: 1, def: 0.5, format: dial },
  { id: 'amp_mid', label: 'MIDDLE', min: 0, max: 1, def: 0.5, format: dial },
  { id: 'amp_treble', label: 'TREBLE', min: 0, max: 1, def: 0.55, format: dial },
  { id: 'amp_cut', label: 'CUT', min: 0, max: 1, def: 0.25, format: dial },
  { id: 'amp_master', label: 'MASTER', min: 0, max: 1, def: 0.7, format: dial },
  { id: 'amp_output', label: 'OUTPUT', min: 0, max: 1, def: 0.5, format: dial },

  { id: 'cab_on', label: 'CAB', min: 0, max: 1, def: 0 },
  { id: 'cab_ir', label: 'IR', min: 0, max: 3, def: 0, choices: ['UK 2x12 ON-AXIS', 'UK 2x12 OFF-AXIS', 'US 1x12 ON-AXIS', 'US 1x12 OFF-AXIS'] },

  { id: 'sauce_on', label: 'SAUCE', min: 0, max: 1, def: 0 },
  { id: 'sauce_body', label: 'BODY', min: 0, max: 1, def: 0, format: dial },
  { id: 'sauce_sub', label: 'SUB', min: 0, max: 1, def: 0, format: dial },
  { id: 'sauce_tight', label: 'TIGHT', min: 0, max: 1, def: 0, format: dial },
  { id: 'sauce_tame', label: 'TAME', min: 0, max: 1, def: 0, format: dial },
  { id: 'sauce_smooth', label: 'SMOOTH', min: 0, max: 1, def: 0, format: dial },
  { id: 'sauce_punch', label: 'PUNCH', min: 0, max: 1, def: 0, format: dial },
  { id: 'sauce_pres', label: 'PRES', min: 0, max: 1, def: 0, format: dial },
  { id: 'sauce_air', label: 'AIR', min: 0, max: 1, def: 0, format: dial },
  { id: 'sauce_mix', label: 'MIX', min: 0, max: 1, def: 1, unit: '%', format: pct },

  { id: 'studio_on', label: 'STUDIO', min: 0, max: 1, def: 1 },
  { id: 'eq_on', label: 'EQ IN', min: 0, max: 1, def: 1 },
  { id: 'eq_hpf', label: 'FILTER', min: 20, max: 500, def: 20, skew: 0.5, unit: 'Hz', format: hz },
  { id: 'eq_lf_f', label: 'LF FREQ', min: 30, max: 450, def: 110, skew: 0.5, unit: 'Hz', format: hz },
  { id: 'eq_lf_g', label: 'LF', min: -15, max: 15, def: 0, unit: 'dB', format: db1 },
  { id: 'eq_lmf_f', label: 'LMF FREQ', min: 200, max: 2500, def: 700, skew: 0.5, unit: 'Hz', format: hz },
  { id: 'eq_lmf_g', label: 'LMF', min: -15, max: 15, def: 0, unit: 'dB', format: db1 },
  { id: 'eq_hmf_f', label: 'HMF FREQ', min: 600, max: 7000, def: 2400, skew: 0.5, unit: 'Hz', format: hz },
  { id: 'eq_hmf_g', label: 'HMF', min: -15, max: 15, def: 0, unit: 'dB', format: db1 },
  { id: 'eq_hf_f', label: 'HF FREQ', min: 1500, max: 16000, def: 8000, skew: 0.5, unit: 'Hz', format: hz },
  { id: 'eq_hf_g', label: 'HF', min: -15, max: 15, def: 0, unit: 'dB', format: db1 },
  { id: 'eq_trim', label: 'TRIM', min: -12, max: 12, def: 0, unit: 'dB', format: db1 },

  { id: 'fet_on', label: 'COMP IN', min: 0, max: 1, def: 1 },
  { id: 'fet_input', label: 'INPUT', min: 0, max: 1, def: 0.5, format: dial },
  { id: 'fet_output', label: 'OUTPUT', min: 0, max: 1, def: 0.5, format: dial },
  { id: 'fet_attack', label: 'ATTACK', min: 0, max: 1, def: 0.35, format: dial },
  { id: 'fet_release', label: 'RELEASE', min: 0, max: 1, def: 0.4, format: dial },
  { id: 'fet_mix', label: 'MIX', min: 0, max: 1, def: 1, unit: '%', format: pct },
  { id: 'fet_ratio', label: 'RATIO', min: 0, max: 3, def: 0, choices: ['4:1', '8:1', '12:1', '20:1'] },

  { id: 'cho_on', label: 'CHORUS', min: 0, max: 1, def: 0 },
  { id: 'cho_rate', label: 'RATE', min: 0, max: 1, def: 0.4, format: dial },
  { id: 'cho_depth', label: 'DEPTH', min: 0, max: 1, def: 0.4, format: dial },
  { id: 'cho_tone', label: 'TONE', min: 0, max: 1, def: 0.5, format: dial },
  { id: 'cho_mix', label: 'MIX', min: 0, max: 1, def: 0.5, unit: '%', format: pct },

  { id: 'dly_on', label: 'DELAY', min: 0, max: 1, def: 1 },
  { id: 'dly_routing', label: 'ROUTING', min: 0, max: 1, def: 0, choices: ['Series', 'Parallel'] },
  ...delayEngineParams('A', 1, 1),
  ...delayEngineParams('B', 0, 3),

  { id: 'rvb_on', label: 'REVERB', min: 0, max: 1, def: 1 },
  { id: 'rvb_machine', label: 'MACHINE', min: 0, max: 3, def: 1, choices: ['Room', 'Hall', 'Plate', 'Spring'] },
  { id: 'rvb_decay', label: 'DECAY', min: 0.2, max: 60, def: 3.5, skew: 0.3, unit: 's', format: (v) => v.toFixed(1) },
  { id: 'rvb_predelay', label: 'PRE-DELAY', min: 0, max: 500, def: 20, skew: 0.5, unit: 'ms', format: ms0 },
  { id: 'rvb_mix', label: 'MIX', min: 0, max: 1, def: 0.3, unit: '%', format: pct },
  { id: 'rvb_tone', label: 'TONE', min: -1, max: 1, def: 0, format: (v) => v.toFixed(2) },
  { id: 'rvb_mod', label: 'MOD', min: 0, max: 1, def: 0.35, unit: '%', format: pct },
  { id: 'rvb_shimmer', label: 'SHIMMER', min: 0, max: 1, def: 0, unit: '%', format: pct },
  { id: 'rvb_shimmer_mode', label: 'INTERVAL', min: 0, max: 1, def: 0, choices: ['+OCT', '+OCT & 5TH'] },
  { id: 'rvb_duck', label: 'DUCK', min: 0, max: 1, def: 0 },
  { id: 'rvb_hp', label: 'HI-PASS', min: 20, max: 2000, def: 20, skew: 0.35, unit: 'Hz', format: hz },
  { id: 'rvb_lp', label: 'LO-PASS', min: 800, max: 20000, def: 20000, skew: 0.35, unit: 'Hz', format: hz },
];

export const paramById = new Map(PARAMS.map((p) => [p.id, p]));

type Listener = (id: string, v: number) => void;

class ParamStore {
  values = new Map<string, number>();
  private listeners = new Set<Listener>();

  constructor() {
    for (const p of PARAMS) this.values.set(p.id, p.def);
  }
  get(id: string): number { return this.values.get(id) ?? 0; }
  set(id: string, v: number, notifyEngine = true) {
    const def = paramById.get(id);
    if (def) v = Math.min(def.max, Math.max(def.min, v));
    this.values.set(id, v);
    if (notifyEngine) this.route(id, v);
    for (const l of this.listeners) l(id, v);
  }
  private route(id: string, v: number) {
    if (id === 'tempo') { this.syncDelays(); return; }
    if (id === 'fet_ratio') { engine.sendParam('fet_ratio', [4, 8, 12, 20][v | 0]); return; }
    engine.sendParam(id, v);
    if (id.startsWith('dly') && (id.endsWith('_sync') || id.endsWith('_div'))) this.syncDelays();
  }
  /** Tempo-synced engines get TIME written from BPM × division (the plugin's
   *  single-source-of-truth sync maths: 45000/BPM for the dotted 8th). */
  syncDelays() {
    const bpm = this.get('tempo');
    for (const x of ['A', 'B'] as const) {
      if (this.get(`dly${x}_sync`) < 0.5) continue;
      const div = this.get(`dly${x}_div`) | 0;
      const f = DIVISION_FACTORS[div];
      if (!f) continue; // Manual
      const ms = Math.min(1500, Math.max(20, (60000 / bpm) * f));
      this.set(`dly${x}_time`, ms);
    }
  }
  /** Push every current value into the engine (post-boot or preset load). */
  pushAll() {
    for (const [id, v] of this.values) {
      if (id === 'tempo') continue;
      this.route(id, v);
    }
    this.syncDelays();
  }
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }
  load(snap: Record<string, number>) {
    for (const p of PARAMS) {
      const v = snap[p.id];
      this.set(p.id, typeof v === 'number' ? v : p.def, false);
    }
    this.pushAll();
    for (const l of this.listeners) l('*', 0);
  }
}

export const store = new ParamStore();
