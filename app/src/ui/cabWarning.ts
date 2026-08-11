/* The double-cab guard.
 *
 * A full-rig capture already contains a speaker: the cone, the mic and the
 * room are all baked into the NAM file. Switching the cab IR on after one of
 * those convolves a second speaker onto the first — the two cone roll-offs
 * stack, nearly everything above ~4 kHz goes with them, and what comes out is
 * the muffled, blanket-over-the-amp sound players usually mistake for a broken
 * preset or a bad capture.
 *
 * Every capture that ships with the suite is full-rig, so the cabinet belongs
 * OFF for all of them. It is there for amp-only DI captures — the ones where
 * the speaker was never recorded and the IR is the missing half of the rig.
 *
 * This is a warning, not a lock: the player can still switch it on, and some
 * people do it deliberately for a lo-fi effect. It just makes sure nobody
 * lands there by accident and blames the amp.
 */

export interface CabWarnOpts {
  /** The capture currently on the amp, named the way the player saw it. */
  captureName: string;
  source: 'bundled' | 'tone3000';
}

/** Resolves true when the player wants the cabinet on regardless. */
export function openCabWarning(o: CabWarnOpts): Promise<boolean> {
  return new Promise((resolve) => {
    document.getElementById('cabWarn')?.remove();

    const origin = o.source === 'bundled'
      ? `<b>${o.captureName}</b> is one of the bundled captures, and every one of those is a
         <b>full-rig</b> capture — amp, cab, mic and room in a single file.`
      : `<b>${o.captureName}</b> is tagged <b>amp + cab</b> on TONE3000, so its creator captured
         the speaker along with the amp.`;

    const wrap = document.createElement('div');
    wrap.id = 'cabWarn';
    wrap.className = 't3k open';
    wrap.innerHTML = `
      <div class="t3k__panel" style="max-width:520px">
        <div class="t3k__head">
          <div class="t3k__title">That capture already has a cabinet<br><em>CABINET · DOUBLE SPEAKER</em></div>
          <button class="t3k__close" aria-label="close">✕</button>
        </div>
        <div class="t3k__list" style="padding:.9rem 1rem;display:block">
          <p class="gate__body">${origin}</p>
          <p class="gate__body">Switching the cab IR on puts a <b>second speaker</b> after the first.
             The two cone roll-offs stack, most of the top end above ~4&nbsp;kHz disappears, and the
             rig goes muffled and boxy — it will sound broken, and the capture will get the blame.</p>
          <p class="gate__body">The cabinet is for <b>amp-only DI captures</b>, where the speaker was
             never recorded and the IR is the half that is missing.</p>
        </div>
        <div class="t3k__foot">
          <button class="t3k__pill on" data-a="off">LEAVE THE CAB OFF</button>
          <button class="t3k__pill" data-a="on">TURN IT ON ANYWAY</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    let done = false;
    const finish = (proceed: boolean) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      resolve(proceed);
    };
    // Escape and click-away both mean "no" — the safe answer is the default.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(false); };
    document.addEventListener('keydown', onKey);

    wrap.querySelector('.t3k__close')!.addEventListener('click', () => finish(false));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(false); });
    wrap.querySelector('[data-a=off]')!.addEventListener('click', () => finish(false));
    wrap.querySelector('[data-a=on]')!.addEventListener('click', () => finish(true));
    wrap.querySelector<HTMLButtonElement>('[data-a=off]')!.focus();
  });
}
