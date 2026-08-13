/* The double-cab guard.
 *
 * A full-rig capture already contains a speaker: the cone, the mic and the
 * room are all baked into the NAM file. Switching the cab IR on after one of
 * those convolves a second speaker onto the first — the two cone roll-offs
 * stack, nearly everything above ~4 kHz goes with them, and what comes out is
 * the muffled, blanket-over-the-amp sound players usually mistake for a broken
 * preset or a bad capture.
 *
 * The Camden and Portland voices are full-rig, so the cabinet belongs OFF for
 * them. The Katahdin's voice is the exception: an amp-only capture that pairs
 * its own factory cab IR — for it (and any amp-only DI capture) the cab is
 * the missing half of the rig, and the OPPOSITE warning applies: switching
 * the cab OFF leaves a raw amp with no speaker (openNoCabWarning below).
 *
 * These are warnings, not locks: the player can still flip either way, and
 * some do it deliberately. They just make sure nobody lands there by
 * accident and blames the amp. Mirrors the plugin's cab cross-check dialogs.
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
      ? `<b>${o.captureName}</b> is one of the bundled <b>full-rig</b> captures — amp, cab,
         mic and room in a single file.`
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

/* ── the missing-speaker guard (the double-cab guard's mirror image) ───────
 * An AMP-ONLY capture has no speaker in the file: the cab IR IS its speaker.
 * Switching the cab off under one leaves the raw amplifier output — a harsh,
 * fizzy sound players mistake for a broken capture. Same contract as the
 * plugin's "Capture has no cabinet" dialog. */

export interface NoCabWarnOpts {
  captureName: string;
  /** 'off' — the player is switching the cab off under an amp-only capture;
   *  'load' — an amp-only capture just loaded while the cab is off. */
  moment: 'off' | 'load';
}

/** Resolves true when the cab should end up ON. */
export function openNoCabWarning(o: NoCabWarnOpts): Promise<boolean> {
  return new Promise((resolve) => {
    document.getElementById('cabWarn')?.remove();

    const lead = o.moment === 'off'
      ? `<b>${o.captureName}</b> is an <b>amp-only</b> capture — no speaker was recorded into
         it, so the cab IR is its speaker.`
      : `<b>${o.captureName}</b> is loaded and running — but it is an <b>amp-only</b> capture
         (no speaker in the file), and the cabinet is currently <b>off</b>.`;
    const ask = o.moment === 'off' ? 'Switch it off anyway?' : 'Turn the cabinet on?';
    const okLabel = o.moment === 'off' ? 'KEEP THE CAB ON' : 'TURN THE CAB ON';
    const noLabel = o.moment === 'off' ? 'TURN IT OFF ANYWAY' : 'LEAVE IT OFF';

    const wrap = document.createElement('div');
    wrap.id = 'cabWarn';
    wrap.className = 't3k open';
    wrap.innerHTML = `
      <div class="t3k__panel" style="max-width:520px">
        <div class="t3k__head">
          <div class="t3k__title">That capture has no cabinet<br><em>CABINET · MISSING SPEAKER</em></div>
          <button class="t3k__close" aria-label="close">✕</button>
        </div>
        <div class="t3k__list" style="padding:.9rem 1rem;display:block">
          <p class="gate__body">${lead}</p>
          <p class="gate__body">Without a cabinet the raw amp output goes straight through —
             <b>harsh and fizzy</b>, all the top end a real speaker would roll away. It will
             sound broken, and the capture will get the blame.</p>
          <p class="gate__body">${ask}</p>
        </div>
        <div class="t3k__foot">
          <button class="t3k__pill on" data-a="yes">${okLabel}</button>
          <button class="t3k__pill" data-a="no">${noLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    let done = false;
    const finish = (cabOn: boolean) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      resolve(cabOn);
    };
    // Escape / click-away take the SAFE answer: cab stays (or comes) on when
    // switching off was the question, stays off when loading merely asked.
    const safe = o.moment === 'off';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(safe); };
    document.addEventListener('keydown', onKey);

    wrap.querySelector('.t3k__close')!.addEventListener('click', () => finish(safe));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(safe); });
    wrap.querySelector('[data-a=yes]')!.addEventListener('click', () => finish(true));
    wrap.querySelector('[data-a=no]')!.addEventListener('click', () => finish(false));
    wrap.querySelector<HTMLButtonElement>('[data-a=yes]')!.focus();
  });
}
