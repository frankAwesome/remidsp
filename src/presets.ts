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
  P('Bloom Clean', 'FACTORY', 'camden', 'camden_clean', {
    tempo: 120,
  }),
  P('Pedal Platform', 'FACTORY', 'camden', 'camden_clean', {
    dly_on: 0, rvb_mix: 0.14, rvb_machine: 0, rvb_decay: 1.4, comp_on: 1, comp_sustain: 0.25,
  }),
  P('Worship Wash', 'SIGNATURE', 'camden', 'camden_clean', {
    tempo: 72, dlyA_div: 2, dlyA_fb: 0.68, dlyA_mix: 0.55, dlyA_mode: 1, dlyA_grit: 0.42,
    dlyA_duck: 0.45, rvb_machine: 1, rvb_decay: 7, rvb_mix: 0.42, rvb_shimmer: 0.4,
    rvb_mod: 0.5, rvb_duck: 1, cho_on: 0,
  }),
  P('80s Widescreen', 'SIGNATURE', 'portland', 'portland_bloom', {
    tempo: 118, cho_on: 1, cho_rate: 0.3, cho_depth: 0.65, cho_mix: 0.55,
    dlyA_mode: 0, dlyA_div: 3, dlyA_fb: 0.4, dlyA_mix: 0.42, dlyA_pingpong: 1,
    rvb_machine: 2, rvb_decay: 2.8, rvb_mix: 0.24, fet_input: 0.2,
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
  // Katahdin is the high-gain amp, and it does not want anything squeezing or
  // driving the front end: the capture already has all the compression and all
  // the gain the part needs, and a stomp comp in front of it only pumps the
  // noise floor up between chugs. Front end is a gate and nothing else, with a
  // fast release so palm mutes stop dead instead of trailing.
  P('Modern Djent', 'SIGNATURE', 'katahdin', 'katahdin_red', {
    tempo: 140, comp_on: 0, drive_on: 0,
    gate_on: 1, gate_thresh: -44, gate_release: 45, dly_on: 0,
    sauce_on: 1, sauce_tight: 0.6, sauce_punch: 0.5, sauce_tame: 0.4, sauce_smooth: 0.3,
    rvb_machine: 0, rvb_decay: 0.9, rvb_mix: 0.1, fet_input: 0.18, fet_ratio: 1,
  }),
  P('Katahdin Lead', 'SIGNATURE', 'katahdin', 'katahdin_red', {
    tempo: 96, comp_on: 0, drive_on: 0,
    gate_on: 1, gate_thresh: -48, gate_release: 55,
    dlyA_div: 1, dlyA_fb: 0.35, dlyA_mix: 0.3, dlyA_mode: 2,
    rvb_machine: 1, rvb_decay: 3.8, rvb_mix: 0.3, cho_on: 0,
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
