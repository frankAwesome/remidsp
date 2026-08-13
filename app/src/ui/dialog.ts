/* ASK and CONFIRM, in the suite's own voice.
 *
 * The rig had four native confirm()/prompt() calls left in it, and a browser
 * dialog is jarring here for reasons beyond taste: it is chrome-coloured in a
 * true-black app, it names the origin ("localhost:5199 says"), its buttons are
 * "OK/Cancel" rather than the thing you are about to do, and — the part that
 * actually matters — it BLOCKS THE MAIN THREAD. A blocking dialog while an
 * AudioWorklet is running is a real hazard, not just an ugly one.
 *
 * These are the same modal furniture as openTempoClash and openCaptureGate,
 * so nothing here invents a new visual language.
 *
 * Both resolve rather than reject on dismissal: cancelling is a normal thing a
 * person does, and making callers try/catch it produces worse code than making
 * them check a value.
 */

import { esc } from './esc';

let openCount = 0;

interface Base {
  title: string;
  /** Optional supporting sentence. Plain text — it is escaped. */
  body?: string;
  /** Quieter second line, for consequences worth stating once. */
  note?: string;
}

export interface ConfirmOpts extends Base {
  /** The button that DOES the thing. Name the action, never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive actions get the red treatment and never autofocus. */
  danger?: boolean;
}

export interface PromptOpts extends Base {
  confirmLabel: string;
  placeholder?: string;
  value?: string;
  maxLength?: number;
  /** Render a textarea rather than a single line. */
  multiline?: boolean;
  /** Reject an empty submission instead of returning ''. */
  required?: boolean;
}

/** Shared shell: builds the modal, wires dismissal, resolves once. */
function shell<T>(
  o: Base,
  bodyHtml: string,
  footHtml: string,
  wire: (panel: HTMLElement, finish: (v: T) => void) => void,
  dismissed: T,
): Promise<T> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal open';
    const titleId = `dlgTitle${++openCount}`;
    wrap.innerHTML = `
      <div class="modal__panel modal__panel--sm" role="dialog" aria-modal="true"
           aria-labelledby="${titleId}">
        <div class="modal__head">
          <div class="modal__title" id="${titleId}">${esc(o.title)}</div>
          <button class="modal__close" aria-label="close">✕</button>
        </div>
        <div class="modal__body">
          ${o.body ? `<p class="modal__body-text">${esc(o.body)}</p>` : ''}
          ${bodyHtml}
          ${o.note ? `<p class="modal__body-note">${esc(o.note)}</p>` : ''}
        </div>
        <div class="modal__foot">${footHtml}</div>
      </div>`;
    document.body.appendChild(wrap);

    // Give focus to the panel and put it back where it came from on close, so
    // a keyboard player is not dumped at the top of the document.
    const returnTo = document.activeElement as HTMLElement | null;

    let done = false;
    const finish = (v: T) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      returnTo?.focus?.();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Capture phase and stopPropagation: the rig listens for keys globally
      // (space toggles the demo loop), and an open dialog owns the keyboard.
      e.stopPropagation();
      e.preventDefault();
      finish(dismissed);
    };
    document.addEventListener('keydown', onKey, true);

    wrap.querySelector('.modal__close')!.addEventListener('click', () => finish(dismissed));
    // Only a click that both starts and ends on the backdrop dismisses —
    // otherwise a text selection dragged out of the panel closes the dialog
    // and throws away what was typed.
    let downOnBackdrop = false;
    wrap.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === wrap; });
    wrap.addEventListener('click', (e) => { if (e.target === wrap && downOnBackdrop) finish(dismissed); });

    wire(wrap.querySelector('.modal__panel')!, finish);
  });
}

/** Ask a yes/no question. Resolves false on cancel, Escape or backdrop. */
export function confirmDialog(o: ConfirmOpts): Promise<boolean> {
  const foot = `
    <button class="modal__btn ${o.danger ? 'modal__btn--danger' : 'modal__btn--go'}"
      data-a="ok">${esc(o.confirmLabel)}</button>
    <button class="modal__btn modal__btn--quiet" data-a="no">${esc(o.cancelLabel ?? 'CANCEL')}</button>`;

  return shell<boolean>(o, '', foot, (panel, finish) => {
    panel.querySelector('[data-a=ok]')!.addEventListener('click', () => finish(true));
    panel.querySelector('[data-a=no]')!.addEventListener('click', () => finish(false));
    // A destructive default is a trap: Enter should not delete anything, so
    // focus lands on CANCEL when the action is dangerous.
    const focus = o.danger ? '[data-a=no]' : '[data-a=ok]';
    panel.querySelector<HTMLButtonElement>(focus)!.focus();
  }, false);
}

/** Ask for a line of text. Resolves null on cancel — distinct from ''. */
export function promptDialog(o: PromptOpts): Promise<string | null> {
  const max = o.maxLength ?? 500;
  const field = o.multiline
    ? `<textarea class="dlg__field" rows="3" maxlength="${max}"
         placeholder="${esc(o.placeholder ?? '')}">${esc(o.value ?? '')}</textarea>`
    : `<input class="dlg__field" type="text" maxlength="${max}"
         placeholder="${esc(o.placeholder ?? '')}" value="${esc(o.value ?? '')}" />`;
  const foot = `
    <button class="modal__btn modal__btn--go" data-a="ok">${esc(o.confirmLabel)}</button>
    <button class="modal__btn modal__btn--quiet" data-a="no">CANCEL</button>`;

  return shell<string | null>(o, `<div class="dlg__row">${field}</div>`, foot, (panel, finish) => {
    const input = panel.querySelector<HTMLInputElement | HTMLTextAreaElement>('.dlg__field')!;
    const ok = panel.querySelector<HTMLButtonElement>('[data-a=ok]')!;
    const submit = () => {
      const v = input.value.trim();
      if (o.required && !v) { input.focus(); return; }
      finish(v);
    };
    ok.addEventListener('click', submit);
    panel.querySelector('[data-a=no]')!.addEventListener('click', () => finish(null));
    // Typed by hand: on the `input | textarea` union TypeScript falls back to
    // the bare Event overload, which has no .key.
    input.addEventListener('keydown', (ev: Event) => {
      const e = ev as KeyboardEvent;
      // Enter submits a single-line field. In a textarea it must not, or the
      // player cannot write a second sentence — there, Cmd/Ctrl+Enter does it.
      if (e.key !== 'Enter') return;
      if (o.multiline && !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      submit();
    });
    input.focus();
    input.select?.();
  }, null);
}
