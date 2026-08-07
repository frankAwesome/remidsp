/* The input switch — a transport for the demo track, and the door to the mic.
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
 *
 * The ▶/❚❚ is deliberately NOT the same control as DEMO/GUITAR. Wanting the
 * loop to stop is not wanting the microphone: someone auditioning a reverb
 * tail, or reading the feed with the rig open, wants silence and nothing else,
 * and charging a permission prompt for that would be absurd.
 */

import { engine, DEFAULT_DI } from '../audio/engine';
import { toast } from './toast';
import { esc } from './esc';

export class InputSwitch {
  root: HTMLElement;
  private play: HTMLButtonElement;
  private demo: HTMLButtonElement;
  private live: HTMLButtonElement;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'insw';
    this.root.innerHTML = `
      <button class="insw__play" data-a="play" aria-label="play or stop the demo track"
        title="stop the demo track"><span>❚❚</span></button>
      <button class="insw__btn" data-a="demo"
        title="${esc(DEFAULT_DI.label)} · ${DEFAULT_DI.bpm} BPM — a demo track through the rig">
        DEMO
      </button>
      <button class="insw__btn" data-a="live" title="play your own guitar — asks for the microphone">
        GUITAR
      </button>`;
    this.play = this.root.querySelector('[data-a=play]')!;
    this.demo = this.root.querySelector('[data-a=demo]')!;
    this.live = this.root.querySelector('[data-a=live]')!;

    this.play.addEventListener('click', () => this.onPlay());
    this.demo.addEventListener('click', () => void this.pick('di'));
    this.live.addEventListener('click', () => void this.pick('mic'));

    engine.inputSourceHooks.add(() => this.sync());
    this.sync();
  }

  /** Space toggles the loop, the way every transport in the world does — but
   *  never while someone is typing into the feed's comment box. */
  handleKey(e: KeyboardEvent): boolean {
    if (e.code !== 'Space' || e.metaKey || e.ctrlKey || e.altKey) return false;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return false;
    if (engine.inputSource !== 'di') return false;
    e.preventDefault();
    this.onPlay();
    return true;
  }

  private onPlay() {
    if (engine.inputSource !== 'di') {
      // On the mic there is no loop to stop, and stopping "the input" would
      // mean closing the device — which is what GUITAR/DEMO is for.
      toast('The demo track is what this stops — you are on your guitar.');
      return;
    }
    const playing = engine.toggleDi();
    this.sync();
    if (!playing) toast('Demo track stopped. Press ▶ or hit <b>space</b> to start it again.');
  }

  private async pick(next: 'mic' | 'di') {
    if (engine.inputSource === next) {
      // Pressing DEMO while already on a STOPPED demo should obviously start
      // it, rather than doing nothing and looking broken.
      if (next === 'di' && !engine.diPlaying) this.onPlay();
      return;
    }
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
    this.play.disabled = on;
  }

  /** Reflect the engine, never the click — the engine is what decides, and a
   *  refused permission must not leave the button looking like it won. */
  sync() {
    const di = engine.inputSource === 'di';
    this.demo.classList.toggle('on', di);
    this.live.classList.toggle('on', !di);
    const playing = engine.diPlaying;
    this.play.hidden = !di;
    this.play.querySelector('span')!.textContent = playing ? '❚❚' : '▶';
    this.play.title = playing ? 'stop the demo track (space)' : 'play the demo track (space)';
    this.play.classList.toggle('insw__play--stopped', !playing);
  }
}
