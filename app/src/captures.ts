/* The capture menu's single source of truth: every loadable capture as a
 * CaptureRef — the bundled set (stems on disk) plus a rolling "recently
 * loaded from TONE3000" list persisted in localStorage, so a capture found
 * in the browser drawer can be re-loaded straight from the amp menu. */

import type { Gear } from './tone3000';

export interface CaptureRef {
  kind: 'bundled' | 'tone3000';
  id: string;            // stem for bundled, model id for tone3000
  label: string;
  ampKey?: string;       // bundled amp captures: which face/voice set they belong to
  stem?: string;
  url?: string;          // tone3000: model_url
  creator?: string;
  license?: string;
  toneUrl?: string;
  /** tone3000: what the creator tagged it as. 'amp-cab' means the speaker is
   *  already in the capture, 'amp' means it is a DI that still needs one —
   *  which is exactly what decides whether the cab IR helps or ruins it. */
  gear?: Gear;
  /** Did this ref's url come from the TONE3000 API (or a recent that did), or
   *  out of a preset document somebody else wrote? Only the first kind may be
   *  fetched with the player's bearer token — see tone3000.fetchModelFile. */
  trusted?: boolean;
  /** Which module this belongs in. A capture browser now fills three slots,
   *  and the thing that decides is the creator's own gear tag — a pedal
   *  profile dropped on the amp is not a mistake the player made, it is one
   *  the app used to make for them. Absent on refs stored before the slots
   *  existed, which were all amp captures. */
  slot?: CaptureSlot;
}

/** The three places a capture can land. */
export type CaptureSlot = 'amp' | 'drive' | 'cab';

/** Where TONE3000's own gear tag says a tone belongs. `format: 'ir'` beats
 *  the tag — an IR is a speaker whatever else it claims to be. */
export function slotForTone(gear: string | undefined, format?: string): CaptureSlot {
  if (format === 'ir' || gear === 'cab') return 'cab';
  if (gear === 'pedal') return 'drive';
  return 'amp';
}

const B = (ampKey: string | undefined, stem: string, label: string): CaptureRef =>
  ({ kind: 'bundled', id: stem, stem, ampKey, label });

export const BUNDLED_AMP_CAPTURES: CaptureRef[] = [
  B('camden', 'camden_clean', 'Camden — Clean'),
  B('camden', 'camden_driven', 'Camden — Driven'),
  B('camden', 'camden_max', 'Camden — Max'),
  B('portland', 'portland_bloom', 'Portland — Bloom'),
  B('portland', 'portland_pushed', 'Portland — Pushed'),
  B('katahdin', 'katahdin_red', 'Katahdin — Red'),
];

/* The bundled pedal capture (drive1) is deliberately NOT listed as loadable.
 *
 * It used to sit in the amp drawer's capture menu, where picking it replaced
 * the amp with a pedal profile — a whole rig turned into an overdrive, which
 * is not a thing anyone meant to do. The plugin fixed the same bug on its own
 * side (its Drive owns a second capture engine and binds drive1 there).
 *
 * The browser cannot give the drive an engine of its own — the vendored NAM
 * wasm has one global DSP slot and the amp holds it — so here drive1 is what
 * the worklet's DrivePedal was VOICED from rather than something it loads.
 * The file still ships; there is simply nothing to point a menu entry at. */

const LS_RECENTS = 'remi_recent_captures';
// Three slots share the list now, so the cap is per-rig rather than per-amp:
// twelve was one menu's worth and would have let a run of cab picks push
// every remembered amp out of the drawer.
const MAX_RECENTS = 30;

/** Recent TONE3000 loads, newest first — every slot, or just one of them. */
export function loadRecents(slot?: CaptureSlot): CaptureRef[] {
  try {
    const list = JSON.parse(localStorage.getItem(LS_RECENTS) ?? '[]') as CaptureRef[];
    if (!Array.isArray(list)) return [];
    const usable = list.filter((r) => r.kind === 'tone3000' && r.url);
    // Everything stored before slots existed was an amp capture, so an
    // absent slot reads as 'amp' rather than as "belongs nowhere" — which
    // would empty the amp menu's recents for everyone who already had some.
    return slot ? usable.filter((r) => (r.slot ?? 'amp') === slot) : usable;
  } catch { return []; }
}

export function addRecent(ref: CaptureRef) {
  // Keyed by id AND slot: the same tone can legitimately be remembered as
  // both an amp pick and a cab pick, and de-duping on id alone would make
  // choosing one silently forget the other.
  const slot = ref.slot ?? 'amp';
  const list = loadRecents().filter((r) => !(r.id === ref.id && (r.slot ?? 'amp') === slot));
  list.unshift({ ...ref, slot });
  localStorage.setItem(LS_RECENTS, JSON.stringify(list.slice(0, MAX_RECENTS)));
}
