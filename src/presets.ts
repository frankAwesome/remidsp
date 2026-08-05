/* Factory presets — style-evoking starting points, delay times from the
 * documented BPM maths (dotted 8th = 45000/BPM ms via the sync engine). */

import type { CaptureRefDoc } from './cloud/store';

export interface Preset {
  name: string;
  group: 'FACTORY' | 'SIGNATURE' | 'USER';
  amp: string;          // amp key in AMP_FACES
  voice: string;        // bundled capture stem — also the fallback if the
                        // capture below is a TONE3000 model that won't load
  params: Record<string, number>;
  /** What was actually on the amp when this was saved. A TONE3000 model is
   *  re-fetched on recall; absent (older presets) means the bundled voice. */
  capture?: CaptureRefDoc | null;
}

const P = (name: string, group: Preset['group'], amp: string, voice: string,
           params: Record<string, number>): Preset => ({ name, group, amp, voice, params });

export const FACTORY_PRESETS: Preset[] = [
  // The boot patch: the app opens on Portland's Pushed voice (a '66 JTM45
  // through a Bluesbreaker). Index 0 is what boot() applies, so it stays first.
  // The compressor is OFF here — the capture is already pushed, and a comp in
  // front of it is the player's choice, not the opening statement.
  P('Pushed Crunch', 'FACTORY', 'portland', 'portland_pushed', {
    tempo: 120, comp_on: 0, dlyA_mix: 0.13,
  }),
  P('Init — Bloom Clean', 'FACTORY', 'camden', 'camden_clean', {
    tempo: 120,
  }),
  P('Pedal Platform', 'FACTORY', 'camden', 'camden_clean', {
    dly_on: 0, rvb_mix: 0.14, rvb_machine: 0, rvb_decay: 1.4, comp_on: 1, comp_sustain: 0.25,
  }),
  P('Slap + Crunch', 'FACTORY', 'camden', 'camden_driven', {
    tempo: 106, dlyA_div: 7, dlyA_fb: 0.18, dlyA_mix: 0.3, dlyA_mode: 2,
    rvb_machine: 0, rvb_decay: 1.1, rvb_mix: 0.16,
  }),
  P('Stadium Chime', 'SIGNATURE', 'camden', 'camden_driven', {
    tempo: 126, dlyA_div: 2, dlyA_fb: 0.55, dlyA_mix: 0.52, dlyA_mode: 1, dlyA_grit: 0.3,
    dlyB_on: 1, dlyB_div: 6, dlyB_fb: 0.35, dlyB_mix: 0.35, dlyB_mode: 1, dly_routing: 1,
    dlyB_pingpong: 1, rvb_machine: 1, rvb_decay: 2.6, rvb_mix: 0.22, comp_sustain: 0.45,
  }),
  P('Worship Wash', 'SIGNATURE', 'camden', 'camden_clean', {
    tempo: 72, dlyA_div: 2, dlyA_fb: 0.68, dlyA_mix: 0.55, dlyA_mode: 1, dlyA_grit: 0.42,
    dlyA_duck: 0.45, rvb_machine: 1, rvb_decay: 7, rvb_mix: 0.42, rvb_shimmer: 0.4,
    rvb_mod: 0.5, rvb_duck: 1, cho_on: 0,
  }),
  P('Dream-Pop Haze', 'SIGNATURE', 'camden', 'camden_driven', {
    tempo: 98, cho_on: 1, cho_depth: 0.55, cho_mix: 0.6, dlyA_mode: 3, dlyA_div: 3,
    dlyA_fb: 0.5, dlyA_mix: 0.45, dlyA_grit: 0.6, rvb_machine: 2, rvb_decay: 4.5,
    rvb_mix: 0.35, sauce_on: 1, sauce_air: 0.5, sauce_body: 0.3,
  }),
  P('80s Widescreen', 'SIGNATURE', 'portland', 'portland_bloom', {
    tempo: 118, cho_on: 1, cho_rate: 0.3, cho_depth: 0.65, cho_mix: 0.55,
    dlyA_mode: 0, dlyA_div: 3, dlyA_fb: 0.4, dlyA_mix: 0.42, dlyA_pingpong: 1,
    rvb_machine: 2, rvb_decay: 2.8, rvb_mix: 0.24, fet_input: 0.6,
  }),
  P('Smooth Blues', 'SIGNATURE', 'portland', 'portland_bloom', {
    tempo: 84, drive_on: 1, drive_gain: 0.28, comp_sustain: 0.4, dlyA_div: 1,
    dlyA_fb: 0.22, dlyA_mix: 0.24, dlyA_mode: 2, rvb_machine: 0, rvb_decay: 1.8, rvb_mix: 0.2,
  }),
  P('Classic Rock Crunch', 'SIGNATURE', 'portland', 'portland_pushed', {
    tempo: 132, dly_on: 0, rvb_machine: 0, rvb_decay: 1.3, rvb_mix: 0.15,
    gate_thresh: -52, sauce_on: 1, sauce_tame: 0.3, sauce_pres: 0.35,
  }),
  P('Spring King', 'SIGNATURE', 'portland', 'portland_bloom', {
    tempo: 110, dlyA_div: 7, dlyA_fb: 0.15, dlyA_mix: 0.26, dlyA_mode: 3, dlyA_grit: 0.5,
    rvb_machine: 3, rvb_decay: 2.4, rvb_mix: 0.38, rvb_tone: -0.2,
  }),
  P('Modern Djent', 'SIGNATURE', 'katahdin', 'katahdin_red', {
    tempo: 140, gate_thresh: -44, gate_release: 60, dly_on: 0,
    sauce_on: 1, sauce_tight: 0.6, sauce_punch: 0.5, sauce_tame: 0.4, sauce_smooth: 0.3,
    rvb_machine: 0, rvb_decay: 0.9, rvb_mix: 0.1, fet_input: 0.55, fet_ratio: 1,
  }),
  P('Katahdin Lead', 'SIGNATURE', 'katahdin', 'katahdin_red', {
    tempo: 96, dlyA_div: 1, dlyA_fb: 0.35, dlyA_mix: 0.3, dlyA_mode: 2,
    rvb_machine: 1, rvb_decay: 3.8, rvb_mix: 0.3, cho_on: 0, comp_on: 0,
  }),
  P('Ambient Swell Bed', 'SIGNATURE', 'camden', 'camden_clean', {
    tempo: 66, dlyA_div: 0, dlyA_fb: 0.75, dlyA_mix: 0.6, dlyA_mode: 1, dlyA_grit: 0.5,
    dlyB_on: 1, dlyB_div: 2, dlyB_fb: 0.6, dlyB_mix: 0.5, dlyB_mode: 3, dly_routing: 0,
    rvb_machine: 1, rvb_decay: 9, rvb_mix: 0.5, rvb_shimmer: 0.5, rvb_shimmer_mode: 1,
    rvb_mod: 0.6, cho_on: 1, cho_mix: 0.35,
  }),
];

const LS_USER = 'remi_user_presets';

export function loadUserPresets(): Preset[] {
  try { return JSON.parse(localStorage.getItem(LS_USER) ?? '[]'); } catch { return []; }
}
export function saveUserPreset(p: Preset) {
  const all = loadUserPresets().filter((x) => x.name !== p.name);
  all.push(p);
  localStorage.setItem(LS_USER, JSON.stringify(all));
}
