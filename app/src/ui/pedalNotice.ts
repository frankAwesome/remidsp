/* What the DRIVE slot's pedal capture actually is, in the browser.
 *
 * This screen exists because the alternative is a lie of omission. Picking a
 * pedal profile on TONE3000 does something real here — it names the pedal on
 * the module, keeps its creator credited, and travels with the preset so the
 * patch is complete and plays in full on the desktop plugin. What it does NOT
 * do is run the capture through this tab's DSP, and a player who assumed
 * otherwise would spend an evening wondering why their Klon sounds like our
 * overdrive.
 *
 * The reason is structural, not an oversight: the NAM engine vendored here
 * (tone-3000/neural-amp-modeler-wasm) exposes one global capture slot per
 * page, and the amp is holding it. The plugin gives its Drive a second engine
 * of its own, which is why the same pick is audible there.
 *
 * So: say it once, at the moment of picking, in one screen the player can
 * dismiss — and leave a way back to it from the pedal itself.
 */

import { esc } from './esc';
import type { CaptureRefDoc } from '../cloud/store';

export type PedalNoticeResult = 'keep' | 'remove';

export function openPedalNotice(
  ref: CaptureRefDoc,
  mode: 'loaded' | 'info',
): Promise<PedalNoticeResult> {
  return new Promise((resolve) => {
    document.getElementById('pedalNotice')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'pedalNotice';
    wrap.className = 't3k open';
    wrap.innerHTML = `
      <div class="t3k__panel" style="max-width:520px">
        <div class="t3k__head">
          <div class="t3k__title">${mode === 'loaded' ? 'Pedal capture bound' : 'The pedal in the drive slot'}
            <br><em>DRIVE · ${esc((ref.label ?? '').toUpperCase())}</em></div>
          <button class="t3k__close" aria-label="close">✕</button>
        </div>
        <div class="t3k__list" style="padding:.9rem 1rem;display:block">
          <p class="gate__body"><b>${esc(ref.label)}</b> is now the drive pedal on this rig
            — named on the module, saved with your presets, and re-fetched from TONE3000
            whenever one of them is recalled.</p>
          ${ref.creator ? `<p class="gate__by">pedal capture by <b>${esc(ref.creator)}</b>${
            ref.license ? ` · ${esc(ref.license)}` : ''} — their license applies</p>` : ''}
          <p class="gate__body gate__body--quiet">One honest caveat: <b>the browser plays its own
            drive voicing, not this capture.</b> The neural engine in this tab runs a single
            capture at a time and the amp has it. The desktop plugin gives the drive its own
            engine, so the same preset opened there runs this pedal for real.</p>
          ${ref.toneUrl ? `<p class="gate__body"><a href="${esc(ref.toneUrl)}" target="_blank"
            rel="noreferrer">See it on TONE3000 ↗</a></p>` : ''}
        </div>
        <div class="t3k__foot">
          <button class="t3k__pill on" data-a="keep">KEEP IT</button>
          <button class="t3k__pill" data-a="remove">CLEAR THE SLOT</button>
          <a class="mono" style="margin-left:auto" href="https://www.tone3000.com" target="_blank"
             rel="noreferrer">TONE3000.COM ↗</a>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    let done = false;
    const finish = (r: PedalNoticeResult) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      resolve(r);
    };
    // The rig listens for keys globally (space runs the demo loop); an open
    // screen owns the keyboard while it is up.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      finish('keep');
    };
    document.addEventListener('keydown', onKey, true);

    wrap.querySelector('.t3k__close')!.addEventListener('click', () => finish('keep'));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish('keep'); });
    wrap.querySelector('[data-a=keep]')!.addEventListener('click', () => finish('keep'));
    wrap.querySelector('[data-a=remove]')!.addEventListener('click', () => finish('remove'));
    wrap.querySelector<HTMLButtonElement>('[data-a=keep]')!.focus();
  });
}
