/* Factory presets — style-evoking starting points, delay times from the
 * documented BPM maths (dotted 8th = 45000/BPM ms via the sync engine).
 *
 * Every preset names its own `tempo`, because anything a preset leaves out
 * falls back to that param's default (120 BPM) — and a synced delay whose
 * tempo did not travel with the patch is just a wrong delay time. The BPMs
 * below are the researched tempos of the records these voices are chasing,
 * so DIVISION does the rest: pick 3/16 and the repeats land where the part
 * expects them.
 *
 * House rules the bank follows, so the captures are heard for what they are:
 *   · The pushed/driven/max captures already contain their gain. Nothing
 *     squeezes or overdrives their front end — no stomp comp, no drive.
 *   · DRIVE only ever sits in front of a clean-ish capture (Camden Clean,
 *     Portland Bloom), where it is the gain stage rather than a second one.
 *   · The studio FET is glue, not a grip: low INPUT, and MIX kept parallel
 *     (20–35 %) so the dry transient survives it. OUTPUT rides up to ~0.76
 *     because the wet path is ~9 dB down at these INPUT settings.
 *   · AMP GAIN is the honest loudness control — it drives the capture itself
 *     ((v − 0.45) × 24 dB), so pushing an amp is turning it up, not stacking
 *     a pedal on it.
 */

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
  /** The cloud document this local copy mirrors, when there is one. A save
   *  writes to both libraries, so a delete has to be able to find the twin —
   *  otherwise the sound disappears from the profile and stays in the preset
   *  strip, which is what it did before this existed. */
  cloudId?: string;
}

const P = (name: string, group: Preset['group'], amp: string, voice: string,
           params: Record<string, number>): Preset => ({ name, group, amp, voice, params });

export const FACTORY_PRESETS: Preset[] = [
  // ── 176 BPM · the city post-punk ────────────────────────────────────────
  // The boot patch. Index 0 is what boot() opens on — it loads this voice
  // straight onto the amp and applies these params without going back through
  // applyPreset, so whatever sits here IS the opening sound.
  //
  // Bloom is the clean-ish Marshall, so the drive pedal is allowed to be the
  // gain stage here — and the stomp comp stays off, because tremolo-picked
  // 16ths at 176 BPM need their dynamics or the part turns to mush. Reverb is
  // a small dark room, not a wash: this should sound like a venue, not a hall.
  P('Dublin Jangle', 'FACTORY', 'portland', 'portland_bloom', {
    tempo: 176, comp_on: 0,
    amp_gain: 0.55, amp_bass: 0.45, amp_mid: 0.55, amp_treble: 0.6, amp_cut: 0.2,
    drive_on: 1, drive_gain: 0.34, drive_treble: 0.62, drive_bass: 0.42, drive_level: 0.68,
    dlyA_div: 3, dlyA_fb: 0.18, dlyA_mix: 0.15, dlyA_mode: 3, dlyA_grit: 0.45,
    dlyA_hicut: 4800,
    rvb_machine: 0, rvb_decay: 1.4, rvb_predelay: 12, rvb_mix: 0.16, rvb_tone: -0.15,
    sauce_on: 1, sauce_tight: 0.35, sauce_punch: 0.4, sauce_pres: 0.25,
    fet_input: 0.18, fet_output: 0.76, fet_mix: 0.26,
    gate_on: 1, gate_thresh: -48,
  }),

  // ── 126 BPM · the rooftop anthem ────────────────────────────────────────
  // The whole part is the delay: 3/16 at 126 BPM = 357 ms, which turns a
  // six-note arpeggio into a twelve-note one. The second engine runs in
  // PARALLEL at a quarter note rather than in series, because the original
  // was a tape echo with more than one playback head — two taps off the same
  // dry signal, not one tap feeding the other. B is darker, grittier and
  // ping-ponged: it is the tape head, A is the pristine rack.
  P('Rooftop Sunrise', 'SIGNATURE', 'camden', 'camden_clean', {
    tempo: 126,
    amp_gain: 0.42, amp_bass: 0.44, amp_mid: 0.46, amp_treble: 0.62, amp_cut: 0.18,
    comp_on: 1, comp_sustain: 0.3, comp_attack: 12,
    dly_routing: 1,
    dlyA_div: 2, dlyA_fb: 0.42, dlyA_mix: 0.5, dlyA_mode: 1, dlyA_grit: 0.12,
    dlyA_hicut: 7500, dlyA_mod_depth: 0.08,
    dlyB_on: 1, dlyB_div: 1, dlyB_fb: 0.2, dlyB_mix: 0.22, dlyB_mode: 3,
    dlyB_grit: 0.35, dlyB_hicut: 5200, dlyB_pingpong: 1,
    rvb_machine: 1, rvb_decay: 3.2, rvb_predelay: 40, rvb_mix: 0.24, rvb_tone: 0.1,
    fet_input: 0.18, fet_output: 0.78, fet_mix: 0.3, gate_thresh: -54,
  }),

  // ── 100 BPM · the gospel search ─────────────────────────────────────────
  // Same 3/16 signature, but at 100 BPM it stretches to 450 ms, which is why
  // this one rings like a hymn instead of pulsing like the rooftop. Shimmer
  // is only at 22 % — enough to put a choir behind the chords, not enough to
  // turn the amp into a synth. The reverb hi-passes at 180 Hz so the low
  // strings stay a guitar.
  P("Pilgrim's Chime", 'SIGNATURE', 'camden', 'camden_clean', {
    tempo: 100,
    amp_gain: 0.4, amp_bass: 0.46, amp_mid: 0.48, amp_treble: 0.6, amp_cut: 0.2,
    comp_on: 1, comp_sustain: 0.34, comp_attack: 15,
    dlyA_div: 2, dlyA_fb: 0.36, dlyA_mix: 0.38, dlyA_mode: 1, dlyA_grit: 0.15,
    dlyA_hicut: 8000, dlyA_mod_depth: 0.1,
    rvb_machine: 1, rvb_decay: 5.5, rvb_predelay: 60, rvb_mix: 0.32, rvb_tone: 0.15,
    rvb_mod: 0.4, rvb_shimmer: 0.22, rvb_hp: 180,
    fet_input: 0.2, fet_output: 0.78, fet_mix: 0.32, gate_thresh: -54,
  }),

  // ── 90 BPM · the airship riff ───────────────────────────────────────────
  // Pushed is already a cranked JTM45, so the extra grind comes from AMP GAIN
  // (+3.6 dB into the capture) and MASTER comes down to pay for it — no comp,
  // no drive in front of a capture that has its own. The delay is a 1/16 tape
  // slap at 167 ms: era-correct thickening, not an audible repeat.
  P('Airship Swagger', 'SIGNATURE', 'portland', 'portland_pushed', {
    tempo: 90, comp_on: 0, drive_on: 0,
    amp_gain: 0.6, amp_bass: 0.55, amp_mid: 0.58, amp_treble: 0.58, amp_cut: 0.22,
    amp_master: 0.66,
    dlyA_div: 7, dlyA_fb: 0.12, dlyA_mix: 0.14, dlyA_mode: 3, dlyA_grit: 0.45,
    dlyA_hicut: 5600,
    rvb_machine: 2, rvb_decay: 2.2, rvb_predelay: 25, rvb_mix: 0.2, rvb_tone: -0.1,
    sauce_on: 1, sauce_body: 0.3, sauce_punch: 0.35, sauce_pres: 0.2,
    fet_input: 0.22, fet_output: 0.76, fet_mix: 0.28, gate_thresh: -50,
  }),

  // ── 150 BPM · the castaway ──────────────────────────────────────────────
  // The one patch where compression is the tone rather than the glue: those
  // add9 shapes only shimmer because a comp is holding them up. Chorus sits
  // where the original's flanger did — rate and depth low, "felt more than
  // heard" — and the 1/8 tape echo at 200 ms has real wow on it (MOD 25 %).
  P('Castaway Chorus', 'SIGNATURE', 'camden', 'camden_clean', {
    tempo: 150,
    amp_gain: 0.52, amp_bass: 0.42, amp_mid: 0.44, amp_treble: 0.64, amp_cut: 0.15,
    comp_on: 1, comp_sustain: 0.4, comp_attack: 6,
    cho_on: 1, cho_rate: 0.25, cho_depth: 0.38, cho_tone: 0.6, cho_mix: 0.45,
    dlyA_div: 3, dlyA_fb: 0.24, dlyA_mix: 0.22, dlyA_mode: 3, dlyA_grit: 0.4,
    dlyA_hicut: 5500, dlyA_mod_depth: 0.25,
    rvb_machine: 2, rvb_decay: 1.8, rvb_predelay: 20, rvb_mix: 0.18,
    fet_input: 0.2, fet_output: 0.78, fet_mix: 0.3, gate_thresh: -54,
  }),

  // ── 162 BPM · the north-east anthem ─────────────────────────────────────
  // A Jazzmaster into a big clean American combo: the drive is barely on
  // (0.2) — just enough shove to get the Camden clean to the edge — and the
  // reverb does the stadium work with a 45 ms pre-delay so the strum still
  // has an attack. HP at 150 Hz keeps the hall off the low strings.
  P('Tyneside Anthem', 'SIGNATURE', 'camden', 'camden_clean', {
    tempo: 162,
    amp_gain: 0.48, amp_bass: 0.48, amp_mid: 0.5, amp_treble: 0.6, amp_cut: 0.18,
    drive_on: 1, drive_gain: 0.2, drive_treble: 0.58, drive_bass: 0.5, drive_level: 0.7,
    comp_on: 1, comp_sustain: 0.22, comp_attack: 14,
    dlyA_div: 3, dlyA_fb: 0.3, dlyA_mix: 0.28, dlyA_mode: 1, dlyA_grit: 0.18,
    dlyA_hicut: 8500, dlyA_mod_depth: 0.12,
    rvb_machine: 1, rvb_decay: 4.2, rvb_predelay: 45, rvb_mix: 0.3, rvb_tone: 0.12,
    rvb_mod: 0.35, rvb_hp: 150,
    sauce_on: 1, sauce_pres: 0.2, sauce_air: 0.3,
    fet_input: 0.2, fet_output: 0.78, fet_mix: 0.32, gate_thresh: -50,
  }),

  // ── 131 BPM · the crown, rhythm ─────────────────────────────────────────
  // Camden DRIVEN, and therefore hands off the front end: COMP and DRIVE are
  // both explicitly off. The treble-booster push is AMP GAIN at +1.2 dB and
  // nothing else. SAUCE does the AC30 midrange thickening, with TAME pulling
  // 3 kHz down so the layered parts stack without turning into an ice pick.
  P('Crown Crunch', 'SIGNATURE', 'camden', 'camden_driven', {
    tempo: 131, comp_on: 0, drive_on: 0,
    amp_gain: 0.5, amp_bass: 0.46, amp_mid: 0.6, amp_treble: 0.6, amp_cut: 0.24,
    amp_master: 0.68,
    dlyA_div: 3, dlyA_fb: 0.22, dlyA_mix: 0.18, dlyA_mode: 1, dlyA_grit: 0.2,
    dlyA_hicut: 7000,
    rvb_machine: 2, rvb_decay: 2.4, rvb_predelay: 25, rvb_mix: 0.22, rvb_tone: 0.05,
    sauce_on: 1, sauce_body: 0.25, sauce_tame: 0.2, sauce_pres: 0.3,
    fet_input: 0.16, fet_output: 0.76, fet_mix: 0.22, gate_thresh: -50,
  }),

  // ── 72 BPM · the sixpence solo ──────────────────────────────────────────
  // Camden MAX, front end untouched for the same reason as above. This is the
  // one lead patch in the bank: mids up for the singing sustain, CUT at 0.3 to
  // close the top the way the little home-built amp did, and SMOOTH + TAME
  // taking the fizz out at 6.5 k and 3 k. 3/16 at 72 BPM is a long 625 ms —
  // slow enough to answer the phrase rather than crowd it.
  P('Sixpence Solo', 'SIGNATURE', 'camden', 'camden_max', {
    tempo: 72, comp_on: 0, drive_on: 0,
    amp_gain: 0.5, amp_bass: 0.44, amp_mid: 0.64, amp_treble: 0.56, amp_cut: 0.3,
    amp_master: 0.66,
    dlyA_div: 2, dlyA_fb: 0.3, dlyA_mix: 0.26, dlyA_mode: 1, dlyA_grit: 0.2,
    dlyA_hicut: 6500, dlyA_mod_depth: 0.12,
    rvb_machine: 1, rvb_decay: 4.5, rvb_predelay: 50, rvb_mix: 0.28, rvb_tone: 0.05,
    rvb_mod: 0.35,
    sauce_on: 1, sauce_body: 0.3, sauce_tame: 0.3, sauce_smooth: 0.35, sauce_pres: 0.15,
    fet_input: 0.15, fet_output: 0.76, fet_mix: 0.2, gate_thresh: -48,
  }),

  // ── 118 BPM · the heartland jangle ──────────────────────────────────────
  // Twelve-string chime faked honestly: CUT wide open at 0.14, treble up, and
  // a hair of chorus (28 % mix) to double the strings. The 1/16 tape slap at
  // 127 ms is the trick that makes a six-string strum sound doubled. Spring
  // reverb because that is what the record was plugged into.
  P('Gainesville Jangle', 'SIGNATURE', 'camden', 'camden_clean', {
    tempo: 118,
    amp_gain: 0.44, amp_bass: 0.44, amp_mid: 0.48, amp_treble: 0.64, amp_cut: 0.14,
    comp_on: 1, comp_sustain: 0.3, comp_attack: 10,
    cho_on: 1, cho_rate: 0.18, cho_depth: 0.22, cho_tone: 0.62, cho_mix: 0.28,
    dlyA_div: 7, dlyA_fb: 0.14, dlyA_mix: 0.16, dlyA_mode: 3, dlyA_grit: 0.35,
    dlyA_hicut: 6000,
    rvb_machine: 3, rvb_decay: 1.9, rvb_predelay: 15, rvb_mix: 0.24, rvb_tone: -0.05,
    sauce_on: 1, sauce_pres: 0.18, sauce_air: 0.32,
    fet_input: 0.2, fet_output: 0.78, fet_mix: 0.3, gate_thresh: -54,
  }),

  // ── 144 BPM · the boardwalk twang ───────────────────────────────────────
  // A Telecaster into a tweed-voiced clean: Bloom pushed to +2.6 dB with a
  // light drive on top for the bridge-pickup bite. The echo is the wobbliest
  // in the bank on purpose — GRIT 0.5, MOD 22 %, top rolled to 5 kHz — because
  // the record's slap came off a tape unit that was never quite in tune.
  P('Asbury Twang', 'SIGNATURE', 'portland', 'portland_bloom', {
    tempo: 144, comp_on: 0,
    amp_gain: 0.56, amp_bass: 0.46, amp_mid: 0.54, amp_treble: 0.62, amp_cut: 0.18,
    drive_on: 1, drive_gain: 0.24, drive_treble: 0.65, drive_bass: 0.42, drive_level: 0.7,
    dlyA_div: 7, dlyA_fb: 0.18, dlyA_mix: 0.2, dlyA_mode: 3, dlyA_grit: 0.5,
    dlyA_hicut: 5000, dlyA_mod_depth: 0.22,
    rvb_machine: 2, rvb_decay: 2.6, rvb_predelay: 30, rvb_mix: 0.24,
    sauce_on: 1, sauce_body: 0.28, sauce_punch: 0.3, sauce_pres: 0.22,
    fet_input: 0.2, fet_output: 0.76, fet_mix: 0.28, gate_thresh: -50,
  }),

  // ── 136 BPM · the one high-gain patch ───────────────────────────────────
  // Katahdin gets a single seat in the bank. Same front-end rule as the other
  // hot captures — no comp, no drive, gate and nothing else — because the
  // capture already carries all the compression and gain the riff needs, and
  // a stomp comp in front of it only lifts the noise floor between notes.
  P('Harmonic Minor Riff', 'SIGNATURE', 'katahdin', 'katahdin_red', {
    tempo: 136, comp_on: 0, drive_on: 0,
    amp_gain: 0.45, amp_bass: 0.48, amp_mid: 0.52, amp_treble: 0.56, amp_cut: 0.28,
    amp_master: 0.68,
    gate_on: 1, gate_thresh: -44, gate_release: 60,
    dlyA_div: 3, dlyA_fb: 0.24, dlyA_mix: 0.2, dlyA_mode: 1, dlyA_grit: 0.2,
    dlyA_hicut: 7000,
    rvb_machine: 1, rvb_decay: 2.6, rvb_predelay: 30, rvb_mix: 0.2,
    sauce_on: 1, sauce_tight: 0.5, sauce_tame: 0.35, sauce_smooth: 0.25, sauce_punch: 0.4,
    fet_input: 0.16, fet_output: 0.76, fet_mix: 0.22, fet_ratio: 1,
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

/** Remove a local preset by cloud id, or by name for copies saved before ids
 *  were kept. Returns whether anything actually went. */
export function deleteUserPreset(match: { name?: string; cloudId?: string }): boolean {
  const all = loadUserPresets();
  const keep = all.filter((p) => !(
    (match.cloudId !== undefined && p.cloudId === match.cloudId)
    || (match.name !== undefined && p.name === match.name)));
  if (keep.length === all.length) return false;
  localStorage.setItem(LS_USER, JSON.stringify(keep));
  return true;
}

/** Point a just-saved local copy at the cloud document it became, so a later
 *  delete can match on the id rather than hoping the names still line up. */
export function tagUserPresetCloudId(name: string, cloudId: string) {
  const all = loadUserPresets();
  const hit = all.find((p) => p.name === name);
  if (!hit) return;
  hit.cloudId = cloudId;
  localStorage.setItem(LS_USER, JSON.stringify(all));
}
