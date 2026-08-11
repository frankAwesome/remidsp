/* Sending a link to somebody.
 *
 * WHERE THIS WENT WRONG THE FIRST TIME: it called navigator.share whenever it
 * existed, on the reasoning that a native sheet is the whole point on a phone.
 * True on a phone. On a Mac, navigator.share ALSO exists, and choosing Copy in
 * the macOS sheet hands back the title and the description CONCATENATED WITH
 * the url:
 *
 *     https://…/#/t/abc
 *     Francois Jam Sound Plex by frankAwesome. Runs in your browser, …
 *
 * which is not a link any more. Paste it in an address bar and you get a web
 * search. A button labelled SHARE that yields a paragraph is worse than no
 * button, because it looks like it worked.
 *
 * So the sheet is now used only where it genuinely wins — a touch device,
 * where it reaches WhatsApp and Messages and there is no comfortable
 * right-click-copy — and everywhere else the clipboard gets THE URL AND
 * NOTHING ELSE.
 */

import { toast } from './toast';
import { esc } from './esc';

/**
 * Is the native share sheet the better tool here?
 *
 * Coarse pointer AND no hover: a phone or tablet. A desktop with a
 * touchscreen still reports `hover: hover`, so it correctly stays on the
 * clipboard. Deliberately not a user-agent test.
 */
function preferNativeSheet(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
}

/** Put exactly `url` on the clipboard, and say so. */
async function copyUrl(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    toast(`<b>Link copied</b><br><span class="toast__url">${esc(url)}</span>`, 5000);
  } catch {
    // Clipboard access can be refused outright. Showing the link is still a
    // way to share it; leaving them with nothing is not.
    toast(`Copy this link: <span class="toast__url">${esc(url)}</span>`, 12000);
  }
}

export async function shareLink(url: string, title: string, text: string): Promise<void> {
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (nav.share && preferNativeSheet()) {
    try {
      await nav.share({ title, text, url });
      return;
    } catch (err) {
      // A cancelled sheet is a normal thing a person does, not an error to
      // report. Anything else falls through to the clipboard.
      if ((err as Error).name === 'AbortError') return;
    }
  }
  await copyUrl(url);
}
