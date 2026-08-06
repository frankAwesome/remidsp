/* Sending something to somebody.
 *
 * Three tiers, because each one can be missing:
 *   navigator.share  — the native sheet. On a phone this is the whole point:
 *                      it reaches WhatsApp and Messages directly, which is
 *                      where a guitarist actually sends a link to a friend.
 *   clipboard        — the desktop answer.
 *   the raw link     — when the clipboard is refused, which it can be.
 *
 * A cancelled share sheet is a normal thing a person does, not an error to
 * report, so AbortError is swallowed rather than shown.
 */

import { toast } from './toast';
import { esc } from './esc';

export async function shareLink(url: string, title: string, text: string): Promise<void> {
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (nav.share) {
    try {
      await nav.share({ title, text, url });
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      // any other failure falls through to the clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(`<b>Link copied</b> — ${esc(url)}`, 4500);
  } catch {
    toast(`Copy this link: ${esc(url)}`, 9000);
  }
}
