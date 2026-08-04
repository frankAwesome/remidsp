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
  capture: CaptureRefDoc | null;
}

export function openSaveDialog(getState: () => SaveState, saveLocal: (name: string) => void) {
  document.getElementById('saveDialog')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'saveDialog';
  wrap.className = 't3k open';
  const signedIn = !!session.user;
  wrap.innerHTML = `
    <div class="t3k__panel" style="max-width:440px">
      <div class="t3k__head">
        <div class="t3k__title">Save Sound</div>
        <button class="t3k__close">✕</button>
      </div>
      <form class="t3k__list account-form" style="gap:.6rem">
        <input name="name" placeholder="preset name" maxlength="60" required autofocus />
        ${signedIn ? `
          <label class="save-share"><input type="checkbox" name="share" />
            <span>share it on <b>the feed</b></span></label>
          <textarea name="description" maxlength="500" rows="3"
            placeholder="description — what is this sound for?" hidden></textarea>`
        : `<div class="account-note">Saving locally. Sign in to keep sounds on your profile and share them on the feed.</div>`}
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
        await savePreset(session.user, session.profile, {
          name,
          amp: st.amp,
          voice: st.voice,
          params: st.params,
          capture: st.capture,
          shared: !!shareBox?.checked,
          description: (desc?.value ?? '').trim().slice(0, 500),
        });
        toast(shareBox?.checked
          ? `<b>${name}</b> saved — and it's on the feed.`
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
