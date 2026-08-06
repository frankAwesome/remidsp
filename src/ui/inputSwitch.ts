/* The input switch — DEMO TRACK ⇄ MY GUITAR.
 *
 * This is where the microphone prompt lives now. It used to be on the boot
 * path, which meant every visitor was asked to hand over a microphone before
 * they had heard the product make a single sound, and the ones without a
 * guitar plugged in — most of them, on the machine they are reading this on —
 * had no way past it at all.
 *
 * So the ask moved here, behind a deliberate press, after the rig is already
 * making noise. If it is refused, nothing breaks: the demo track keeps
 * playing and the switch says what happened.
 */

import { engine, DEFAULT_DI } from '../audio/engine';
import { toast } from './toast';
import { esc } from './esc';

export class InputSwitch {
  root: HTMLElement;
  private demo: HTMLButtonElement;
  private live: HTMLButtonElement;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'insw';
    // The DI's own name is too long for a header chip and truncated to
    // "AMBIE…", which says nothing. The button says what it IS; the title
    // carries which track it is.
    this.root.innerHTML = `
      <button class="insw__btn" data-a="demo"
        title="${esc(DEFAULT_DI.label)} · ${DEFAULT_DI.bpm} BPM — a demo track through the rig">
        DEMO
      </button>
      <button class="insw__btn" data-a="live" title="play your own guitar — asks for the microphone">
        GUITAR
      </button>`;
    this.demo = this.root.querySelector('[data-a=demo]')!;
    this.live = this.root.querySelector('[data-a=live]')!;

    this.demo.addEventListener('click', () => void this.pick('di'));
    this.live.addEventListener('click', () => void this.pick('mic'));

    engine.onInputSourceChange = () => this.sync();
    this.sync();
  }

  private async pick(next: 'mic' | 'di') {
    if (engine.inputSource === next) return;
    this.busy(true);
    const ok = await engine.setInputSource(next);
    this.busy(false);
    this.sync();
    if (ok) {
      toast(next === 'di'
        ? `Demo track running — <b>turn anything</b>.`
        : `<b>Input open</b> — play.`);
      return;
    }
    // Only the mic direction can fail this way, and the honest thing is to
    // name the refusal and point out that sound is still happening.
    toast(`Could not open the microphone${engine.micError ? ` — ${esc(engine.micError)}` : ''}. `
      + `Still on the demo track, so the rig is not silent.`, 6000);
  }

  private busy(on: boolean) {
    this.demo.disabled = on;
    this.live.disabled = on;
  }

  /** Reflect the engine, never the click — the engine is what decides, and a
   *  refused permission must not leave the button looking like it won. */
  sync() {
    const di = engine.inputSource === 'di';
    this.demo.classList.toggle('on', di);
    this.live.classList.toggle('on', !di);
  }
}
