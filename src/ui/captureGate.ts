/* The TONE3000 gate.
 *
 * Presets carry a capture reference, not the capture itself — a NAM file is
 * the creator's work and lives on TONE3000 under their license. So a preset
 * built on a custom capture only makes its own sound once TONE3000 hands the
 * file over, and that needs a free account plus a publishable key.
 *
 * When that chain is not in place the preset does NOT silently play the wrong
 * amp. This screen says which capture is missing, why, and exactly what to do
 * about it — then retries the load in place, so the player lands on the sound
 * they clicked without touching the drawer or reloading the page.
 */

import { t3k, type T3kFailure } from '../tone3000';
import { toast } from './toast';
import { esc, escUpper } from './esc';

export interface GateOpts {
  presetName: string;
  captureLabel: string;
  creator?: string;
  fallbackLabel: string;
  reason: T3kFailure;
  /** Re-attempt the capture load; resolves true once it is on the amp. */
  retry: () => Promise<boolean>;
}

const SIGNUP = 'https://www.tone3000.com/signup';
const KEYS = 'https://www.tone3000.com/settings/api-keys';

/** Headline + explanation per failure, in the player's terms.
 *
 *  `capture` is a label off somebody else's shared preset, so it is escaped
 *  once here and the bolding around it is ours. Everything this returns is
 *  trusted HTML by the time it leaves. */
function copy(reason: T3kFailure, rawCapture: string): { head: string; body: string } {
  const capture = esc(rawCapture);
  switch (reason) {
    case 'auth':
      return {
        head: 'Your TONE3000 session has expired',
        body: `<b>${capture}</b> is still there — the sign-in that unlocks it timed out.
               Reconnect and the preset finishes loading.`,
      };
    case 'network':
      return {
        head: 'Could not reach TONE3000',
        body: `<b>${capture}</b> could not be downloaded. Check the connection and try
               again — nothing is wrong with the preset.`,
      };
    case 'missing':
      return {
        head: 'That capture is gone from TONE3000',
        body: `The creator has taken <b>${capture}</b> down, so it cannot be loaded.
               Everything else in the preset — the pedals, the amp settings — still applies.`,
      };
    default:
      return {
        head: 'This preset uses a TONE3000 capture',
        body: `<b>${capture}</b> is not packaged with REMI DSP — it lives on TONE3000,
               and downloading it needs a free account and a publishable key.
               It takes about a minute, once.`,
      };
  }
}

export function openCaptureGate(o: GateOpts): Promise<boolean> {
  return new Promise((resolve) => {
    document.getElementById('captureGate')?.remove();
    const needsKey = o.reason === 'not-connected' || o.reason === 'auth';
    const { head, body } = copy(o.reason, o.captureLabel);

    const wrap = document.createElement('div');
    wrap.id = 'captureGate';
    wrap.className = 't3k open';
    wrap.innerHTML = `
      <div class="t3k__panel" style="max-width:520px">
        <div class="t3k__head">
          <div class="t3k__title">${head}<br><em>PRESET · ${escUpper(o.presetName)}</em></div>
          <button class="t3k__close" aria-label="close">✕</button>
        </div>
        <div class="t3k__list" style="padding:.9rem 1rem;display:block">
          <p class="gate__body">${body}</p>
          ${o.creator ? `<p class="gate__by">capture by <b>${esc(o.creator)}</b> · their license applies</p>` : ''}
          ${needsKey ? `
            <ol class="gate__steps">
              <li><a href="${SIGNUP}" target="_blank" rel="noreferrer">Create a free TONE3000 account ↗</a></li>
              <li><a href="${KEYS}" target="_blank" rel="noreferrer">Copy a publishable key (Settings → API Keys) ↗</a>
                  — starts with <code>t3k_pub_</code></li>
              <li>Paste it below, then <b>CONNECT</b>. It is saved on this device, so this is a one-time step.</li>
            </ol>
            <div class="gate__keyrow">
              <input type="password" name="key" spellcheck="false" autocomplete="off"
                     placeholder="t3k_pub_… (leave blank to use the built-in key)" />
              <button class="t3k__pill" data-a="save-key">SAVE KEY</button>
            </div>
            <div class="gate__keynote" data-el="keynote"></div>` : ''}
          <div class="gate__status" data-el="status"></div>
        </div>
        <div class="t3k__foot">
          ${needsKey
            ? `<button class="t3k__pill on" data-a="connect">CONNECT TO TONE3000</button>`
            : `<button class="t3k__pill on" data-a="retry">TRY AGAIN</button>`}
          <button class="t3k__pill" data-a="skip">USE ${escUpper(o.fallbackLabel)} INSTEAD</button>
          <a class="mono" style="margin-left:auto" href="https://www.tone3000.com" target="_blank"
             rel="noreferrer">TONE3000.COM ↗</a>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const status = wrap.querySelector<HTMLElement>('[data-el=status]')!;
    const keyNote = wrap.querySelector<HTMLElement>('[data-el=keynote]');
    const keyInput = wrap.querySelector<HTMLInputElement>('[name=key]');
    const syncKeyNote = () => {
      if (keyNote) {
        keyNote.innerHTML = t3k.hasCustomKey
          ? `Using <b>your key</b> — ${t3k.maskedKey}`
          : `Using the <b>built-in key</b> — ${t3k.maskedKey}. That is usually enough; paste your own if CONNECT is refused.`;
      }
    };
    syncKeyNote();

    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      wrap.remove();
      resolve(ok);
    };
    const say = (html: string, bad = false) => {
      status.innerHTML = html;
      status.classList.toggle('gate__status--bad', bad);
    };
    const busy = (on: boolean) => {
      wrap.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = on));
    };

    wrap.querySelector('.t3k__close')!.addEventListener('click', () => finish(false));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(false); });
    wrap.querySelector('[data-a=skip]')!.addEventListener('click', () => finish(false));

    wrap.querySelector('[data-a=save-key]')?.addEventListener('click', () => {
      const k = keyInput?.value.trim() ?? '';
      if (!k) { t3k.clearKey(); t3k.disconnect(); syncKeyNote(); say('Back on the built-in key.'); return; }
      if (!k.startsWith('t3k_pub_')) {
        say('That is not a publishable key — it should start with <code>t3k_pub_</code>. '
            + 'The secret key (t3k_sk_…) must never go in a browser.', true);
        return;
      }
      t3k.disconnect();       // tokens belong to the old client id
      t3k.pubKey = k;         // persisted in localStorage
      if (keyInput) keyInput.value = '';
      syncKeyNote();
      window.dispatchEvent(new CustomEvent('remi:t3k-changed'));
      say('Key saved on this device. Now hit <b>CONNECT TO TONE3000</b>.');
    });

    const attempt = async () => {
      busy(true);
      say(`Loading <b>${esc(o.captureLabel)}</b>…`);
      const ok = await o.retry();
      busy(false);
      if (ok) {
        toast(`<b>${esc(o.captureLabel)}</b> loaded — ${esc(o.presetName)} is complete.`);
        finish(true);
      } else {
        say(`<b>${esc(o.captureLabel)}</b> still would not load. Try again, or carry on with `
            + `<b>${esc(o.fallbackLabel)}</b> — every other setting in the preset is already applied.`, true);
      }
    };

    wrap.querySelector('[data-a=retry]')?.addEventListener('click', () => void attempt());
    wrap.querySelector('[data-a=connect]')?.addEventListener('click', async () => {
      busy(true);
      say('Opening the TONE3000 sign-in window… (allow the pop-up)');
      try {
        await t3k.connect();
        window.dispatchEvent(new CustomEvent('remi:t3k-changed'));
        say('Connected. Fetching the capture…');
        busy(false);
        await attempt();
      } catch (err) {
        busy(false);
        const msg = (err as Error).message;
        say(/invalid|client|unauthorized/i.test(msg)
          ? `Sign-in refused — ${msg}. That usually means the publishable key is wrong, or this
             site's <code>/t3k-callback.html</code> is not listed as a redirect URI on the key.`
          : `Sign-in failed — ${msg}`, true);
      }
    });
  });
}
