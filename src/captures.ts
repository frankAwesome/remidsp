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

export const BUNDLED_PEDAL_CAPTURES: CaptureRef[] = [
  B(undefined, 'drive1', 'Drive — Morning Glory'),
];

const LS_RECENTS = 'remi_recent_captures';
const MAX_RECENTS = 12;

export function loadRecents(): CaptureRef[] {
  try {
    const list = JSON.parse(localStorage.getItem(LS_RECENTS) ?? '[]') as CaptureRef[];
    return Array.isArray(list) ? list.filter((r) => r.kind === 'tone3000' && r.url) : [];
  } catch { return []; }
}

export function addRecent(ref: CaptureRef) {
  const list = loadRecents().filter((r) => r.id !== ref.id);
  list.unshift(ref);
  localStorage.setItem(LS_RECENTS, JSON.stringify(list.slice(0, MAX_RECENTS)));
}
