/* The loop-versus-preset tempo guard.
 *
 * A recorded loop has a fixed length in SAMPLES. Its bar line, its metronome
 * and the delay times that were dialled against it all agree only at the
 * tempo it was cut at — so a preset that wants a different one cannot simply
 * have its way. The loop would keep turning at its own speed while the click
 * and the repeats walked off the grid.
 *
 * So the rig keeps the loop's tempo and re-times the incoming preset to it.
 * Everything else in the preset lands untouched; only the number the delays
 * are derived from is held. This screen says so before it happens, prints the
 * tempo the patch will actually run at, and offers the other answer for a
 * player who would rather browse sounds than keep the take.
 */

export type TempoChoice = 'keep' | 'drop' | 'cancel';

export interface TempoClashOpts {
  presetName: string;
  presetBpm: number;
  loopBpm: number;
  layers: number;
}

export function openTempoClash(o: TempoClashOpts): Promise<TempoChoice> {
  return new Promise((resolve) => {
    document.getElementById('tempoClash')?.remove();

    const wrap = document.createElement('div');
    wrap.id = 'tempoClash';
    wrap.className = 'modal open';
    wrap.innerHTML = `
      <div class="modal__panel modal__panel--sm" role="dialog" aria-modal="true"
           aria-labelledby="tempoClashHead">
        <div class="modal__head">
          <div class="modal__title" id="tempoClashHead">The loop is at a different tempo
            <em>${o.layers} LAYER${o.layers === 1 ? '' : 'S'} ON THE DECK</em></div>
          <button class="modal__close" aria-label="close">✕</button>
        </div>
        <div class="modal__body">
          <div class="tempoclash">
            <div class="tempoclash__side">
              <span>YOUR LOOP</span><b>${Math.round(o.loopBpm)}</b><i>BPM</i>
            </div>
            <div class="tempoclash__arrow">→</div>
            <div class="tempoclash__side tempoclash__side--want">
              <span>${escapeHtml(o.presetName.toUpperCase())} WANTS</span><b>${Math.round(o.presetBpm)}</b><i>BPM</i>
            </div>
          </div>
          <p class="modal__body-text">A loop's length is fixed in samples, so its bar line only lands
            where it should at the tempo it was cut at. Load this patch and it will be
            <b>re-timed to ${Math.round(o.loopBpm)} BPM</b> — everything else about it arrives
            untouched, and its delays are recalculated against your loop so the repeats stay
            on the grid with the click.</p>
          <p class="modal__body-note">Rather browse sounds than keep the take? Drop the loop and the
            patch loads at its own ${Math.round(o.presetBpm)} BPM.</p>
        </div>
        <div class="modal__foot">
          <button class="modal__btn modal__btn--go" data-a="keep">KEEP THE LOOP · ${Math.round(o.loopBpm)} BPM</button>
          <button class="modal__btn" data-a="drop">DELETE THE LOOP</button>
          <button class="modal__btn modal__btn--quiet" data-a="cancel">STAY HERE</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    let done = false;
    const finish = (c: TempoChoice) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      wrap.classList.remove('open');
      // let the exit transition run before the node goes
      setTimeout(() => wrap.remove(), 160);
      resolve(c);
    };
    // Escape and click-away mean "don't change anything" — the take is the
    // thing that cannot be got back, so it is what the safe answer protects.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish('cancel'); };
    document.addEventListener('keydown', onKey);

    wrap.querySelector('.modal__close')!.addEventListener('click', () => finish('cancel'));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish('cancel'); });
    for (const c of ['keep', 'drop', 'cancel'] as const) {
      wrap.querySelector(`[data-a=${c}]`)!.addEventListener('click', () => finish(c));
    }
    wrap.querySelector<HTMLButtonElement>('[data-a=keep]')!.focus();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
