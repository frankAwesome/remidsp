/* HTML escaping, in one place.
 *
 * This module exists because it did not. Five UI files had each grown their
 * own private copy of the same five-line function, and captureGate.ts — the
 * one screen that renders strings written by a STRANGER — had none, so a
 * shared preset's capture label, its creator and its name went into innerHTML
 * exactly as another player had typed them.
 *
 * Anything that came off a Firestore document was typed by someone else.
 * Route it through esc() before it reaches innerHTML.
 */

const MAP: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/** Escape for interpolation into an HTML template. Accepts anything: a
 *  Firestore field that should have been a string may not be one, and a
 *  `.replace is not a function` crash on the feed is its own outage. */
export function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => MAP[c]);
}

/** Escape and upper-case, for the label voice the rig uses on its panels.
 *  Upper-casing FIRST and escaping second would be a bug: toUpperCase() on
 *  an already-escaped string turns `&amp;` into `&AMP;`, which renders as
 *  literal text instead of an ampersand. */
export function escUpper(v: unknown): string {
  return esc(String(v ?? '').toUpperCase());
}
