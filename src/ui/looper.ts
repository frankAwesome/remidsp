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
  private loopPos = 0;
  private metroOn = false;
  private tracks: TrackLane[] = [];
  private pendingPeaks = new Map<number, Float32Array>();

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
          <button class="looper__rec" data-id="rec" title="record / overdub">●</button>
          <button class="looper__btn" data-id="play" title="play / pause" disabled>▶</button>
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
    this.clearBtn.addEventListener('click', () => {
      if (this.tracks.length && !confirm('Clear every looper track?')) return;
      engine.sendLooper({ cmd: 'clear' });
      this.tracks = [];
      this.lanes.innerHTML = '';
      this.syncUi();
    });
    this.metroBtn.addEventListener('click', () => {
      this.metroOn = !this.metroOn;
      this.metroBtn.classList.toggle('on', this.metroOn);
      engine.sendParam('metro_on', this.metroOn ? 1 : 0);
    });
    this.root.querySelector<HTMLInputElement>('[data-id=metroGain]')!
      .addEventListener('input', (e) => engine.sendParam('metro_gain', Number((e.target as HTMLInputElement).value)));

    engine.onLooper = (m) => this.onMsg(m);
    meterBus.hooks.add((m) => this.onMeters(m));
    store.subscribe((id, v) => { if (id === 'tempo') engine.sendParam('metro_bpm', v); });

    const loop = () => { this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    this.syncUi();
  }

  private onRec() {
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

  private syncUi() {
    const s = this.state;
    const recording = s === 'rec';
    const counting = s === 'count';
    this.recBtn.classList.toggle('armed', counting || this.armed);
    this.recBtn.classList.toggle('rec', recording);
    this.playBtn.disabled = !this.tracks.length;
    this.playBtn.textContent = s === 'play' ? '❚❚' : '▶';
    this.clearBtn.disabled = !this.tracks.length;
    // the loop length is fixed by track 1 — lock the shape controls after that
    this.barsSel.disabled = this.tracks.length > 0;
    this.countSel.disabled = this.tracks.length > 0;

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
      for (let b = 0; b < bins; b++) {
        const lo = lane.peaks[b * 2], hi = lane.peaks[b * 2 + 1];
        const y0 = mid - hi * mid * 0.9, y1 = mid - lo * mid * 0.9;
        g.fillRect(b * bw, y0, Math.max(1, bw * 0.85), Math.max(1, y1 - y0));
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
