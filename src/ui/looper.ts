/* LOOPER · PRACTICE — a separate section under the stage. Arm it, get a
 * count-in (clicks from the worklet metronome, sample-accurate), it records
 * N bars of the finished rig sound and loops it. The waveform is the star:
 * peak-pair rendering in the ice palette, bar grid, sweeping playhead, and
 * a DSEG7 countdown printed onto the glass during the count-in. */

import { engine, LooperMsg, Meters } from '../audio/engine';
import { store } from '../params';
import { meterBus } from './live';

export class LooperSection {
  root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private status: HTMLElement;
  private recBtn: HTMLButtonElement;
  private playBtn: HTMLButtonElement;
  private metroBtn: HTMLButtonElement;
  private barsSel: HTMLSelectElement;
  private countSel: HTMLSelectElement;
  private state = 'idle';
  private beat = -1;
  private countBeats = 8;
  private beatsPerBar = 4;
  private bars = 4;
  private peaks: Float32Array | null = null;
  private loopPos = 0;
  private metroOn = false;

  constructor() {
    this.root = document.createElement('section');
    this.root.className = 'looper';
    this.root.innerHTML = `
      <div class="looper__head">
        <span class="looper__title">Looper</span>
        <span class="hdr__caption">PRACTICE SECTION</span>
        <div class="looper__status led-text">READY</div>
        <div class="looper__controls">
          <label class="looper__field"><span>BARS</span>
            <select data-id="bars"><option>1</option><option>2</option><option selected>4</option><option>8</option></select></label>
          <label class="looper__field"><span>COUNT-IN</span>
            <select data-id="count"><option value="0">OFF</option><option value="1">1 BAR</option><option value="2" selected>2 BARS</option></select></label>
          <button class="tab" data-id="metro">METRO</button>
          <input data-id="metroGain" type="range" min="0" max="1" step="0.01" value="0.7" title="click level" />
          <button class="looper__rec" data-id="rec" title="record">●</button>
          <button class="looper__btn" data-id="play" title="play / stop" disabled>▶</button>
          <button class="looper__btn" data-id="clear" title="clear" disabled>✕</button>
        </div>
      </div>
      <canvas class="looper__wave"></canvas>`;
    this.canvas = this.root.querySelector('canvas')!;
    this.status = this.root.querySelector('.looper__status')!;
    this.recBtn = this.root.querySelector('[data-id=rec]')!;
    this.playBtn = this.root.querySelector('[data-id=play]')!;
    this.metroBtn = this.root.querySelector('[data-id=metro]')!;
    this.barsSel = this.root.querySelector('[data-id=bars]')!;
    this.countSel = this.root.querySelector('[data-id=count]')!;

    this.recBtn.addEventListener('click', () => this.arm());
    this.playBtn.addEventListener('click', () => {
      if (this.state === 'play') engine.sendLooper({ cmd: 'stop' });
      else engine.sendLooper({ cmd: 'play' });
    });
    this.root.querySelector('[data-id=clear]')!.addEventListener('click', () => {
      engine.sendLooper({ cmd: 'clear' });
      this.peaks = null;
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
  }

  private arm() {
    if (this.state === 'count' || this.state === 'rec') { engine.sendLooper({ cmd: 'stop' }); return; }
    this.bars = Number(this.barsSel.value);
    engine.sendLooper({
      cmd: 'arm',
      bpm: store.get('tempo'),
      bars: this.bars,
      countBars: Number(this.countSel.value),
    });
  }

  private onMsg(m: LooperMsg) {
    if (m.type === 'wave' && m.peaks) {
      this.peaks = m.peaks;
      return;
    }
    if (m.state) this.state = m.state;
    if (m.beat !== undefined) this.beat = m.beat;
    if (m.countBeats !== undefined) this.countBeats = m.countBeats;
    if (m.beatsPerBar) this.beatsPerBar = m.beatsPerBar;
    if (m.bars) this.bars = m.bars;
    this.syncUi();
  }

  private onMeters(m: Partial<Meters>) {
    if (m.loopState) this.state = m.loopState;
    if (m.loopPos !== undefined) this.loopPos = m.loopPos;
  }

  private syncUi() {
    const s = this.state;
    this.recBtn.classList.toggle('armed', s === 'count');
    this.recBtn.classList.toggle('rec', s === 'rec');
    this.playBtn.disabled = !(s === 'play' || (s === 'idle' && !!this.peaks));
    this.playBtn.textContent = s === 'play' ? '■' : '▶';
    (this.root.querySelector('[data-id=clear]') as HTMLButtonElement).disabled = !this.peaks && s !== 'play';
    if (s === 'count') {
      const left = this.countBeats - this.beat;
      this.status.textContent = `CNT ${Math.max(0, left)}`;
    } else if (s === 'rec') {
      const b = this.beat - this.countBeats;
      this.status.textContent = `REC ${Math.floor(b / this.beatsPerBar) + 1}.${(b % this.beatsPerBar) + 1}`;
    } else if (s === 'play') {
      this.status.textContent = 'LOOP';
    } else {
      this.status.textContent = this.peaks ? 'HELD' : 'READY';
    }
  }

  private draw() {
    if (!this.canvas.isConnected) return;
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 4) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(r.width * dpr)) {
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
    }
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height, mid = H / 2;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(3,3,5,.9)';
    g.fillRect(0, 0, W, H);

    // bar / beat grid
    const beats = this.bars * this.beatsPerBar;
    for (let b = 0; b <= beats; b++) {
      const x = (b / beats) * W;
      const isBar = b % this.beatsPerBar === 0;
      g.strokeStyle = isBar ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.05)';
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,.08)';
    g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();

    // waveform
    if (this.peaks) {
      const bins = this.peaks.length / 2;
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, 'rgba(159,216,232,.9)');
      grad.addColorStop(0.5, 'rgba(238,241,246,.95)');
      grad.addColorStop(1, 'rgba(143,180,198,.85)');
      g.fillStyle = grad;
      g.shadowColor = 'rgba(159,216,232,.35)';
      g.shadowBlur = 6;
      const bw = W / bins;
      for (let b = 0; b < bins; b++) {
        const lo = this.peaks[b * 2], hi = this.peaks[b * 2 + 1];
        const y0 = mid - hi * mid * 0.92;
        const y1 = mid - lo * mid * 0.92;
        g.fillRect(b * bw, y0, Math.max(1, bw * 0.8), Math.max(1, y1 - y0));
      }
      g.shadowBlur = 0;
    }

    // record progress tint / playhead
    if (this.state === 'rec') {
      g.fillStyle = 'rgba(216,74,74,.12)';
      g.fillRect(0, 0, this.loopPos * W, H);
      g.fillStyle = 'rgba(216,74,74,.9)';
      g.fillRect(this.loopPos * W - 1, 0, 2, H);
    } else if (this.state === 'play') {
      const x = this.loopPos * W;
      g.fillStyle = 'rgba(238,241,246,.95)';
      g.shadowColor = 'rgba(238,241,246,.8)';
      g.shadowBlur = 8;
      g.fillRect(x - 1, 0, 2, H);
      g.shadowBlur = 0;
    }

    // count-in digits on the glass
    if (this.state === 'count') {
      const left = Math.max(0, this.countBeats - this.beat);
      g.fillStyle = 'rgba(238,241,246,.92)';
      g.font = `${H * 0.62}px Dseg7, monospace`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.shadowColor = 'rgba(159,216,232,.7)';
      g.shadowBlur = 18;
      g.fillText(String(left), W / 2, mid + 2);
      g.shadowBlur = 0;
      g.textAlign = 'start';
    }
  }
}
