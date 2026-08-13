/* SAVE dialog — one place saves everywhere: always into the local library,
 * and (signed in) into the cloud library, optionally shared to the feed
 * with a description. */

import { session } from './account';
import { savePreset, type CaptureRefDoc } from '../cloud/store';
import { toast } from './toast';

export interface SaveState {
  amp: string;
  voice: string;
  params: Record<string, number>;
  /** The three capture slots: the amp, the drive pedal, the cab IR. Each is
   *  a reference — TONE3000 files are delivered per player and never ride
   *  inside a preset. */
  capture: CaptureRefDoc | null;
  drive?: CaptureRefDoc | null;
  ir?: CaptureRefDoc | null;
}

export function openSaveDialog(
  getState: () => SaveState,
  saveLocal: (name: string) => void,
  /** Whose sound this still is. Set while a tone loaded from someone else's
   *  library is unchanged; null the moment the player alters it. */
  borrowedFrom: string | null = null,
  onSaved?: (name: string, cloudId: string) => void,
) {
  document.getElementById('saveDialog')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'saveDialog';
  wrap.className = 't3k open';
  const signedIn = !!session.user;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  wrap.innerHTML = `
    <div class="t3k__panel modal__panel--sm">
      <div class="t3k__head">
        <div class="t3k__title">Save Sound${borrowedFrom ? `<em>BORROWED FROM ${esc(borrowedFrom.toUpperCase())}</em>` : ''}</div>
        <button class="t3k__close" aria-label="close">✕</button>
      </div>
      <form class="t3k__list account-form" style="gap:.7rem">
        <input name="name" placeholder="preset name" maxlength="60" required autofocus />
        ${!signedIn ? `<div class="account-note">Saving locally. Sign in to keep sounds on your
            profile and share them on the feed.</div>`
        : borrowedFrom ? `
          <div class="save-borrowed">
            <b>This is ${esc(borrowedFrom)}'s sound, unchanged.</b>
            Keep it — it saves to your profile and your preset list like any other. It just
            cannot go back on the feed under your name while it is still theirs.
            <i>Change anything — the amp, a pedal, one knob — and it becomes yours to post.</i>
          </div>`
        : `
          <label class="save-share"><input type="checkbox" name="share" />
            <span>share it on <b>the feed</b></span></label>
          <textarea name="description" maxlength="500" rows="3"
            placeholder="description — what is this sound for?" hidden></textarea>`}
        <div class="account-form__row">
          <button type="submit" class="hdr__btn hdr__btn--lit">SAVE</button>
          <button type="button" class="hdr__btn" data-a="cancel">CANCEL</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('.t3k__close')!.addEventListener('click', close);
  wrap.querySelector('[data-a=cancel]')!.addEventListener('click', close);

  const form = wrap.querySelector('form')!;
  const shareBox = form.querySelector<HTMLInputElement>('[name=share]');
  const desc = form.querySelector<HTMLTextAreaElement>('[name=description]');
  shareBox?.addEventListener('change', () => { if (desc) desc.hidden = !shareBox.checked; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
    if (!name) return;
    saveLocal(name);
    if (session.user && session.profile) {
      try {
        const st = getState();
        // Belt as well as braces: the checkbox is not even rendered for a
        // borrowed sound, so this can only matter if one is ever put back.
        const share = !!shareBox?.checked && !borrowedFrom;
        const id = await savePreset(session.user, session.profile, {
          name,
          amp: st.amp,
          voice: st.voice,
          params: st.params,
          capture: st.capture,
          drive: st.drive ?? null,
          ir: st.ir ?? null,
          shared: share,
          description: (desc?.value ?? '').trim().slice(0, 500),
        });
        onSaved?.(name, id);
        toast(share
          ? `<b>${name}</b> saved — and it's on the feed.`
          : borrowedFrom
            ? `<b>${name}</b> saved privately — still ${borrowedFrom}'s sound until you change it.`
            : `<b>${name}</b> saved to your profile.`);
      } catch (err) {
        toast(`Cloud save failed — ${(err as Error).message}`, 4500);
      }
    } else {
      toast(`Saved <b>${name}</b> locally.`);
    }
    close();
  });
}
