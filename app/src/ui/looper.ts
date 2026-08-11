/* LOOPER · PRACTICE — a multi-track section under the stage.
 *
 * The first pass sets the loop length (bars × beats, after a count-in).
 * Every pass after that is an OVERDUB: hit ● and it arms instantly, then
 * starts recording exactly at the next top of the loop, so layers can
 * never drift. Tracks stack as lanes you can mute or delete individually.
 */

import { engine, LooperMsg, Meters } from '../audio/engine';
import { store } from '../params';
import { meterBus } from './live';
import { makeMiniKnob, type MiniKnob } from './miniKnob';
import { encodeWav24, downloadBlob } from './wav';
import { toast } from './toast';
import { ICONS } from './icons';
import { confirmDialog } from './dialog';

interface TrackLane {
  id: number;
  muted: boolean;
  peaks: Float32Array | null;
  row: HTMLElement;
  canvas: HTMLCanvasElement;
  level: MiniKnob;
  pan: MiniKnob;
}

export class LooperSection {
  root: HTMLElement;
  private lanes: HTMLElement;
  private status: HTMLElement;
  private recBtn: HTMLButtonElement;
  private playBtn: HTMLButtonElement;
  private clearBtn: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private barsSel: HTMLSelectElement;
  private countSel: HTMLSelectElement;
  private metroBtn: HTMLButtonElement;
  private hint: HTMLElement;
  private state = 'idle';
  private armed = false;
  private beat = -1;
  private countBeats = 8;
  private beatsPerBar = 4;
  private bars = 4;
  /** The tempo the loop is turning at — not the rig's tempo control, which a
   *  preset can move without the loop following it. */
  private bpm = 120;
  private loopPos = 0;
  private metroOn = false;
  /* The demo track runs at a fixed 90 BPM and the loop's bar line is fixed in
   * samples at whatever tempo it was cut at. Those two cannot both be true, so
   * while the demo plays the looper is held: existing layers are kept but
   * silenced, and nothing new can be recorded over a track it would not line
   * up with. Leaving demo mode gives it all back untouched. */
  private demoLocked = false;
  /** Was the loop rolling when the lock came down? Restored on release. */
  private wasPlaying = false;
  private tracks: TrackLane[] = [];
  private pendingPeaks = new Map<number, Float32Array>();
  /* ── alignment ─────────────────────────────────────────────────────────
   * How far ahead of the grid the loop is read, in milliseconds, to cancel the
   * round trip a played note makes on its way to the recorder. See the long
   * note above the Looper class in the worklet for why a take lands late.
   *
   * Remembered per browser, because it is a property of the player's INTERFACE
   * and not of anything in the rig: whatever they dial in tonight is still
   * true tomorrow on the same box, and asking them to find it again every
   * session would make the control worse than useless. */
  private alignMs = 0;
  private alignInput!: HTMLInputElement;
  /** The cycle length in samples the worklet reports, so the lane can turn an
   *  alignment in milliseconds into a fraction of the loop. */
  private loopLen = 0;

  constructor() {
    this.root = document.createElement('section');
    this.root.className = 'looper';
    this.root.innerHTML = `
      <div class="looper__head">
        <span class="looper__title">Looper</span>
        <span class="hdr__caption">PRACTICE · MULTITRACK</span>
        <div class="looper__status led-text">READY</div>
        <div class="looper__controls">
          <label class="looper__field"><span>BARS</span>
            <select data-id="bars"><option>1</option><option>2</option><option selected>4</option><option>8</option></select></label>
          <label class="looper__field"><span>COUNT-IN</span>
            <select data-id="count"><option value="0">OFF</option><option value="1">1 BAR</option><option value="2" selected>2 BARS</option></select></label>
          <button class="tab" data-id="metro">METRO</button>
          <input data-id="metroGain" type="range" min="0" max="1" step="0.01" value="0.7" title="click level" />
          <label class="looper__field looper__field--align"><span>ALIGN</span>
            <span class="looper__align">
              <button class="looper__nudge" data-id="alignDown" title="less — takes sit later">−</button>
              <input data-id="align" type="number" min="-250" max="250" step="0.5" value="0"
                     title="How much lateness to cancel. A note you play on the beat reaches the recorder a round trip late — out through your speakers, back in through your interface — so the loop is read this far ahead of the grid. Raise it if takes still land late." />
              <span class="looper__unit">MS</span>
              <button class="looper__nudge" data-id="alignUp" title="more — takes land earlier">+</button>
              <button class="looper__nudge looper__nudge--auto" data-id="alignAuto" title="back to this device's measured round trip">AUTO</button>
            </span></label>
          <button class="looper__rec" data-id="rec" title="record / overdub">●</button>
          <button class="looper__btn" data-id="play" title="play / pause" disabled>▶</button>
          <button class="looper__btn" data-id="save" title="download this loop as a 24-bit WAV" disabled>${ICONS.download}</button>
          <button class="looper__btn" data-id="clear" title="clear all tracks" disabled>✕</button>
        </div>
      </div>
      <div class="looper__lanes"></div>
      <div class="looper__hint mono"></div>`;
    this.lanes = this.root.querySelector('.looper__lanes')!;
    this.status = this.root.querySelector('.looper__status')!;
    this.recBtn = this.root.querySelector('[data-id=rec]')!;
    this.playBtn = this.root.querySelector('[data-id=play]')!;
    this.clearBtn = this.root.querySelector('[data-id=clear]')!;
    this.barsSel = this.root.querySelector('[data-id=bars]')!;
    this.countSel = this.root.querySelector('[data-id=count]')!;
    this.metroBtn = this.root.querySelector('[data-id=metro]')!;
    this.hint = this.root.querySelector('.looper__hint')!;

    this.recBtn.addEventListener('click', () => this.onRec());
    this.playBtn.addEventListener('click', () => {
      engine.sendLooper({ cmd: this.state === 'play' ? 'pause' : 'play' });
    });
    this.clearBtn.addEventListener('click', async () => {
      if (this.tracks.length && !await confirmDialog({
        title: 'Clear every looper track?',
        body: `${this.tracks.length} layer${this.tracks.length === 1 ? '' : 's'} `
          + 'will be erased. Download the loop first if you want to keep it.',
        confirmLabel: 'CLEAR ALL',
        danger: true,
      })) return;
      engine.sendLooper({ cmd: 'clear' });
      this.tracks = [];
      this.lanes.innerHTML = '';
      this.syncUi();
    });
    this.saveBtn = this.root.querySelector('[data-id=save]')!;
    this.saveBtn.addEventListener('click', () => void this.download());
    this.metroBtn.addEventListener('click', () => {
      this.metroOn = !this.metroOn;
      this.metroBtn.classList.toggle('on', this.metroOn);
      engine.sendParam('metro_on', this.metroOn ? 1 : 0);
    });
    this.root.querySelector<HTMLInputElement>('[data-id=metroGain]')!
      .addEventListener('input', (e) => engine.sendParam('metro_gain', Number((e.target as HTMLInputElement).value)));

    this.alignInput = this.root.querySelector('[data-id=align]')!;
    // `input`, not `change`: the point of the control is that a player can
    // hold an arrow down and hear the loop walk onto the beat.
    this.alignInput.addEventListener('input', () => this.setAlign(Number(this.alignInput.value)));
    this.root.querySelector('[data-id=alignDown]')!
      .addEventListener('click', () => this.setAlign(this.alignMs - 0.5));
    this.root.querySelector('[data-id=alignUp]')!
      .addEventListener('click', () => this.setAlign(this.alignMs + 0.5));
    this.root.querySelector('[data-id=alignAuto]')!
      .addEventListener('click', () => this.setAlign(engine.suggestedAlignMs(), true));

    engine.onLooper = (m) => this.onMsg(m);
    meterBus.hooks.add((m) => this.onMeters(m));
    store.subscribe((id, v) => { if (id === 'tempo') engine.sendParam('metro_bpm', v); });

    const loop = () => { this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    this.syncUi();
  }

  /* ── alignment ───────────────────────────────────────────────────────── */

  private static readonly LS_ALIGN = 'remi_loop_align_ms';

  /** Adopt an alignment: push it to the worklet, show it, remember it.
   *
   *  `announce` is for the AUTO button, which is the one route where the value
   *  arrives without the player having typed it and so is the one place that
   *  owes them a word about where the number came from. */
  private setAlign(ms: number, announce = false) {
    if (!Number.isFinite(ms)) return;
    this.alignMs = Math.max(-250, Math.min(250, Math.round(ms * 2) / 2));
    if (this.alignInput.value !== String(this.alignMs)) {
      this.alignInput.value = String(this.alignMs);
    }
    const sr = engine.sampleRate() ?? 48000;
    engine.sendLooper({ cmd: 'align', samples: Math.round((this.alignMs / 1000) * sr) });
    try { localStorage.setItem(LooperSection.LS_ALIGN, String(this.alignMs)); } catch { /* private mode */ }
    if (announce) {
      toast(this.alignMs > 0
        ? `Loop alignment set to <b>${this.alignMs} ms</b> — this device's measured round trip. `
          + 'Trim it by ear if takes still land early or late.'
        : 'No round trip to cancel on the demo track — it never leaves the browser. '
          + 'Switch to your guitar and press AUTO again.', 6000);
    }
  }

  /** Whatever this browser was told last. Null the first time. */
  restoreAlign() {
    let saved: number | null = null;
    try {
      const v = localStorage.getItem(LooperSection.LS_ALIGN);
      if (v !== null && Number.isFinite(Number(v))) saved = Number(v);
    } catch { /* private mode */ }
    if (saved !== null) { this.alignSeeded = true; this.setAlign(saved); }
  }

  /** Has a figure been chosen for this browser — by the player, or by the
   *  first press of record? */
  private alignSeeded = false;

  /**
   * Seed the alignment from the device, at the last possible moment.
   *
   * Deliberately not at boot. `outputLatency` reads 0 until the device has
   * actually begun pushing audio, so a figure taken while the rig was still
   * opening is a figure taken too early — and it is only worth taking at all
   * once somebody has decided to record something on a real guitar.
   */
  private seedAlign() {
    if (this.alignSeeded || engine.inputSource !== 'mic') return;
    this.alignSeeded = true;
    const ms = engine.suggestedAlignMs();
    if (ms <= 0) return;
    this.setAlign(ms);
    toast(`Loop alignment started at <b>${this.alignMs} ms</b> — what this device reports for the `
      + 'round trip out to your ears and back in. If takes still land late, nudge <b>ALIGN</b> up.', 7000);
  }

  private onRec() {
    this.seedAlign();
    if (this.state === 'count' || this.state === 'rec' || this.armed) {
      engine.sendLooper({ cmd: 'stop' });
      return;
    }
    this.bars = Number(this.barsSel.value);
    engine.sendLooper({
      cmd: 'arm',
      bpm: store.get('tempo'),
      bars: this.bars,
      countBars: Number(this.countSel.value),
    });
  }

  private onMsg(m: LooperMsg) {
    if (m.type === 'wave' && m.peaks && m.trackId !== undefined) {
      const lane = this.tracks.find((t) => t.id === m.trackId);
      if (lane) { lane.peaks = m.peaks; }
      else this.pendingPeaks.set(m.trackId, m.peaks);
      return;
    }
    if (m.state) this.state = m.state;
    if (m.armed !== undefined) this.armed = m.armed;
    if (m.beat !== undefined) this.beat = m.beat;
    if (m.countBeats !== undefined) this.countBeats = m.countBeats;
    if (m.beatsPerBar) this.beatsPerBar = m.beatsPerBar;
    if (m.bars) this.bars = m.bars;
    if (m.loopBpm) this.bpm = Math.round(m.loopBpm);
    if (m.len !== undefined) this.loopLen = m.len;
    if (m.tracks) this.syncTracks(m.tracks);
    this.syncUi();
  }

  /** Reconcile the lane list with the worklet's authoritative track list. */
  private syncTracks(list: { id: number; muted: boolean; gain?: number; pan?: number }[]) {
    for (const lane of [...this.tracks]) {
      if (!list.some((t) => t.id === lane.id)) {
        lane.row.remove();
        this.tracks = this.tracks.filter((t) => t !== lane);
      }
    }
    for (const [i, t] of list.entries()) {
      let lane = this.tracks.find((l) => l.id === t.id);
      if (!lane) {
        lane = this.makeLane(t.id, i + 1);
        this.tracks.push(lane);
        this.lanes.appendChild(lane.row);
        const p = this.pendingPeaks.get(t.id);
        if (p) { lane.peaks = p; this.pendingPeaks.delete(t.id); }
      }
      lane.muted = t.muted;
      lane.row.classList.toggle('looper-lane--muted', t.muted);
      const mb = lane.row.querySelector<HTMLButtonElement>('[data-a=mute]')!;
      mb.classList.toggle('on', !t.muted);
      lane.row.querySelector('.looper-lane__no')!.textContent = String(i + 1).padStart(2, '0');
      // The worklet owns the mix; the knobs only echo it back. Skip the
      // knob the player is turning right now so their drag never fights the
      // round trip that their own turn just caused.
      if (t.gain !== undefined && !lane.level.el.classList.contains('mknob--live')) lane.level.set(t.gain);
      if (t.pan !== undefined && !lane.pan.el.classList.contains('mknob--live')) lane.pan.set(t.pan);
    }
  }

  private makeLane(id: number, index: number): TrackLane {
    const row = document.createElement('div');
    row.className = 'looper-lane';
    row.innerHTML = `
      <span class="looper-lane__no led-text">${String(index).padStart(2, '0')}</span>
      <canvas class="looper-lane__wave"></canvas>
      <div class="looper-lane__mix"></div>
      <div class="looper-lane__keys">
        <button class="looper-lane__btn on" data-a="mute" title="mute / unmute this layer">M</button>
        <button class="looper-lane__btn looper-lane__btn--del" data-a="del" title="delete this layer">✕</button>
      </div>`;
    row.querySelector('[data-a=mute]')!.addEventListener('click', () => {
      const lane = this.tracks.find((t) => t.id === id);
      engine.sendLooper({ cmd: 'mute', id, muted: !lane?.muted });
    });
    row.querySelector('[data-a=del]')!.addEventListener('click', () => {
      engine.sendLooper({ cmd: 'delete', id });
    });

    // LEVEL runs to 1.5 (+3.5 dB) so a layer that was played quietly can be
    // brought up to sit with the rest, not just pulled down.
    const level = makeMiniKnob({
      label: 'LEVEL', min: 0, max: 1.5, def: 1, value: 1,
      format: (v) => (v <= 0.0001 ? '−∞' : `${(20 * Math.log10(v)).toFixed(1)}`),
      unit: 'dB',
      onChange: (v) => engine.sendLooper({ cmd: 'mix', id, gain: v }),
    });
    const pan = makeMiniKnob({
      label: 'PAN', min: -1, max: 1, def: 0, value: 0, bipolar: true,
      format: (v) => (Math.abs(v) < 0.005 ? 'C'
        : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`),
      onChange: (v) => engine.sendLooper({ cmd: 'mix', id, pan: v }),
    });
    const mix = row.querySelector('.looper-lane__mix')!;
    mix.appendChild(level.el);
    mix.appendChild(pan.el);

    return { id, muted: false, peaks: null, row, canvas: row.querySelector('canvas')!, level, pan };
  }

  private onMeters(m: Partial<Meters>) {
    if (m.loopState) this.state = m.loopState;
    if (m.loopPos !== undefined) this.loopPos = m.loopPos;
  }

  /** Hold or release the looper for demo mode.
   *
   *  Deliberately NOT a clear: the layers a player has recorded are their
   *  work, and demo mode is a thing they may be passing through. They are
   *  parked, not destroyed, and come back exactly as they were. */
  setDemoLocked(on: boolean) {
    if (this.demoLocked === on) return;
    this.demoLocked = on;
    if (on) {
      // Anything mid-flight has to stop: an armed take would start recording
      // the demo track, and a rolling loop would play at the wrong tempo over
      // a 90 BPM performance.
      this.wasPlaying = this.state === 'play';
      if (this.state === 'count' || this.state === 'rec' || this.armed) {
        engine.sendLooper({ cmd: 'stop' });
      }
      if (this.state === 'play') engine.sendLooper({ cmd: 'pause' });
    } else if (this.wasPlaying && this.tracks.length) {
      engine.sendLooper({ cmd: 'play' });
      this.wasPlaying = false;
    }
    this.root.classList.toggle('looper--locked', on);
    this.syncUi();
  }

  /** Is there a loop on the deck, and what tempo is it turning at? The rig
   *  asks before it lets a preset change the tempo out from under it. */
  hasLoop(): boolean { return this.tracks.length > 0; }
  loopBpm(): number { return this.bpm; }
  layerCount(): number { return this.tracks.length; }
  clearLoop() {
    engine.sendLooper({ cmd: 'clear' });
    this.tracks = [];
    this.lanes.innerHTML = '';
    this.syncUi();
  }

  private async download() {
    this.saveBtn.disabled = true;
    try {
      const mix = await engine.exportLoop();
      if (!mix) { toast('Nothing to download — every layer is muted or empty.'); return; }
      const secs = mix.L.length / mix.sampleRate;
      const name = `remi-loop-${Math.round(mix.bpm)}bpm-${mix.bars}bar-${mix.tracks}x.wav`;
      downloadBlob(encodeWav24(mix.L, mix.R, mix.sampleRate), name);
      toast(`<b>${name}</b> — ${secs.toFixed(1)}s, ${mix.tracks} layer${mix.tracks === 1 ? '' : 's'}, 24-bit.`, 4500);
    } catch (err) {
      toast(`Could not bounce the loop — ${(err as Error).message}`, 5000);
    } finally {
      this.syncUi();
    }
  }

  private syncUi() {
    const s = this.state;
    const recording = s === 'rec';
    const counting = s === 'count';
    const lock = this.demoLocked;
    this.recBtn.classList.toggle('armed', !lock && (counting || this.armed));
    this.recBtn.classList.toggle('rec', !lock && recording);
    this.recBtn.disabled = lock;
    this.playBtn.disabled = lock || !this.tracks.length;
    this.playBtn.textContent = s === 'play' ? '❚❚' : '▶';
    this.clearBtn.disabled = lock || !this.tracks.length;
    // Nothing to bounce mid-take: the layer being played is not in the stack
    // until it closes on the loop top. The bounce stays available under the
    // lock though — a player who is about to try the demo should still be
    // able to save the work they already have.
    this.saveBtn.disabled = !this.tracks.length || recording || counting;
    // the loop length is fixed by track 1 — lock the shape controls after that
    this.barsSel.disabled = lock || this.tracks.length > 0;
    this.countSel.disabled = lock || this.tracks.length > 0;
    this.metroBtn.disabled = lock;

    if (lock) {
      this.status.textContent = 'DEMO';
      this.hint.textContent = this.tracks.length
        ? `HELD WHILE THE DEMO TRACK PLAYS · ${this.tracks.length} TAKE`
          + `${this.tracks.length === 1 ? '' : 'S'} KEPT · SWITCH INPUT TO GUITAR TO GET THEM BACK`
        : 'THE DEMO TRACK RUNS AT A FIXED 90 BPM · SWITCH INPUT TO GUITAR TO RECORD';
      return;
    }

    if (counting) this.status.textContent = `CNT ${Math.max(0, this.countBeats - this.beat)}`;
    else if (recording) {
      const b = this.beat - (this.tracks.length ? this.beat : this.countBeats);
      this.status.textContent = this.tracks.length
        ? `DUB ${this.tracks.length + 1}`
        : `REC ${Math.floor(Math.max(0, b) / this.beatsPerBar) + 1}.${(Math.max(0, b) % this.beatsPerBar) + 1}`;
    } else if (this.armed) this.status.textContent = 'ARMED';
    else if (s === 'play') this.status.textContent = `LOOP ${this.tracks.length}`;
    else this.status.textContent = this.tracks.length ? 'HELD' : 'READY';

    this.hint.textContent = !this.tracks.length
      ? 'RECORD SETS THE LOOP LENGTH · EVERY PASS AFTER THAT OVERDUBS ON THE NEXT LOOP TOP'
      : `${this.bars} BAR LOOP · ${this.tracks.length} TRACK${this.tracks.length === 1 ? '' : 'S'} · ● ADDS ANOTHER LAYER`;
  }

  private draw() {
    for (const lane of this.tracks) this.drawLane(lane);
  }

  private drawLane(lane: TrackLane) {
    const c = lane.canvas;
    if (!c.isConnected) return;
    const r = c.getBoundingClientRect();
    if (r.width < 4) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(r.width * dpr)) {
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height, mid = H / 2;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(3,3,5,.9)';
    g.fillRect(0, 0, W, H);

    const beats = this.bars * this.beatsPerBar;
    for (let b = 0; b <= beats; b++) {
      const x = (b / beats) * W;
      g.strokeStyle = b % this.beatsPerBar === 0 ? 'rgba(255,255,255,.13)' : 'rgba(255,255,255,.045)';
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }

    if (lane.peaks) {
      const bins = lane.peaks.length / 2;
      /* Slide the picture by the same amount the audio is slid by, so the
       * waveform under the gridlines IS what comes out of the speakers and
       * the player can dial the alignment by eye as well as by ear.
       *
       * Done here rather than by re-binning in the worklet because that would
       * be a few hundred thousand samples per track on the AUDIO THREAD, on
       * every step of a drag. This is one number added to an x.
       *
       * The wrap is the one approximation on screen: the far right of the lane
       * redraws the head of the same take, where the audio reads the recorded
       * tail. Different milliseconds, same performance, and only the picture. */
      const shift = this.loopLen > 0 ? -(this.alignMs / 1000) * (engine.sampleRate() ?? 48000) / this.loopLen : 0;
      const grad = g.createLinearGradient(0, 0, 0, H);
      if (lane.muted) {
        grad.addColorStop(0, 'rgba(120,130,140,.45)');
        grad.addColorStop(1, 'rgba(90,100,110,.4)');
      } else {
        grad.addColorStop(0, 'rgba(159,216,232,.9)');
        grad.addColorStop(0.5, 'rgba(238,241,246,.95)');
        grad.addColorStop(1, 'rgba(143,180,198,.85)');
      }
      g.fillStyle = grad;
      if (!lane.muted) { g.shadowColor = 'rgba(159,216,232,.3)'; g.shadowBlur = 5; }
      const bw = W / bins;
      const dx = shift * W;
      for (let b = 0; b < bins; b++) {
        const lo = lane.peaks[b * 2], hi = lane.peaks[b * 2 + 1];
        const y0 = mid - hi * mid * 0.9, y1 = mid - lo * mid * 0.9;
        let x = b * bw + dx;
        if (x < -bw) x += W;
        else if (x > W) x -= W;
        g.fillRect(x, y0, Math.max(1, bw * 0.85), Math.max(1, y1 - y0));
      }
      g.shadowBlur = 0;
    }

    if (this.state === 'play' || this.state === 'rec') {
      const x = this.loopPos * W;
      g.fillStyle = 'rgba(238,241,246,.95)';
      g.shadowColor = 'rgba(238,241,246,.7)';
      g.shadowBlur = 7;
      g.fillRect(x - 1, 0, 2, H);
      g.shadowBlur = 0;
    }
  }
}
