/* The rig controller: owns the NAM WASM module, the AudioContext it creates,
 * and the processing graph around it.
 *
 *   mic ──▶ pre worklet (gate·comp·drive·capture-in) ──▶ NAM node ─┐
 *                                        └─ amp-bypass ─┐          │
 *                                                       ▼          ▼
 *                                                      cab sum ──▶ convolver ─▶ wet ─┐
 *                                                          └────────── dry ──────────┤
 *                                                                                    ▼
 *                                post worklet (tone·sauce·studio·chorus·delay·reverb) ─▶ out
 *
 * The wasm build is Emscripten's Wasm Audio Worklet flavour: it creates its
 * OWN AudioContext and mono worklet node, handed to us via
 * window.wasmAudioWorkletCreated. Everything else attaches to that context.
 */

declare global {
  interface Window {
    wasmAudioWorkletCreated?: (node: AudioWorkletNode, ctx: AudioContext) => void;
    Module?: EmModule;
  }
}

interface EmModule {
  _malloc(n: number): number;
  _free(p: number): void;
  stringToUTF8(s: string, ptr: number, len: number): void;
  ccall(
    name: string, ret: null, argTypes: string[], args: (number | string)[],
    opts?: { async?: boolean },
  ): Promise<void> | void;
}

export interface CaptureInfo {
  name: string;
  source: 'bundled' | 'tone3000';
  toneTitle?: string;
  creator?: string;
  license?: string;
  url?: string;
  /** Does the capture already have a speaker cabinet baked into it? Every
   *  bundled voice does — they are full-rig captures — so the cab IR after
   *  them is a second speaker on top of the first. TONE3000 models answer
   *  from their gear tag. `undefined` means nobody knows, and in that case
   *  nothing warns: a guess that cries wolf is worse than staying quiet. */
  hasCab?: boolean;
}

/** Which physical input, and which channel of it, feeds the rig. */
export interface InputChoice {
  deviceId?: string;
  /** Channel index on a multi-input interface; omit to take the stream as-is
   *  (which for a mono device is the only channel there is). */
  channel?: number;
}

/** A bounced loop, straight from the worklet's buffers. */
export interface LoopExport {
  L: Float32Array;
  R: Float32Array;
  sampleRate: number;
  bpm: number;
  bars: number;
  tracks: number;
}

export interface Meters {
  in: number; out: number; gr: number; gate: number; compGr: number;
  loopState: string; loopPos: number;
}
export interface LooperMsg {
  type: 'looper' | 'wave';
  state?: string; armed?: boolean;
  beat?: number; beatsPerBar?: number; countBeats?: number;
  bars?: number; bpm?: number; loopBpm?: number;
  tracks?: { id: number; muted: boolean; gain?: number; pan?: number }[];
  trackId?: number; peaks?: Float32Array; bins?: number;
}

type EngineState = 'idle' | 'booting' | 'running' | 'error';

const num = (v: number) => v;

/** The bundled demo DI.
 *
 *  Synthesised from `scripts/make-di.mjs` so it is ours outright and carries
 *  no sample licence. It is a starting point, not the destination: the house
 *  DI library lives on R2 and this is what plays before one is chosen. */
export const DEFAULT_DI = {
  id: 'house/ambient-dmaj-92',
  url: '/assets/di/ambient_dmaj_92.wav',
  label: 'AMBIENT · D MAJOR',
  bpm: 92,
};

export class RigEngine {
  state: EngineState = 'idle';
  ctx: AudioContext | null = null;
  namNode: AudioWorkletNode | null = null;
  private pre: AudioWorkletNode | null = null;
  private post: AudioWorkletNode | null = null;
  private convolver: ConvolverNode | null = null;
  private cabWet: GainNode | null = null;
  private cabDry: GainNode | null = null;
  private namIn: GainNode | null = null;
  private namOut: GainNode | null = null;
  private ampBypass: GainNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micStream: MediaStream | null = null;
  private micSplit: ChannelSplitterNode | null = null;
  /* ── the DI source ────────────────────────────────────────────────────
   * A looping dry instrument recording standing in for a guitar, so the rig
   * can be played by someone who has neither a guitar nor an interface — and
   * so the microphone permission prompt is never the price of admission.
   * It occupies exactly the position the mic does: a node into `pre`. */
  private diNode: AudioBufferSourceNode | null = null;
  private diGain: GainNode | null = null;
  private diBuffer: AudioBuffer | null = null;
  /** Which of the two is currently feeding the chain. */
  inputSource: 'mic' | 'di' = 'mic';
  onInputSourceChange: ((s: 'mic' | 'di') => void) | null = null;
  /** Which device/channel the rig listens to. Settable before launch. */
  input: InputChoice = {};
  output = 'default';
  /** How many channels the open input actually gave us — the picker offers
   *  a channel per one of these, and nothing when there is only the one. */
  inputChannels = 1;
  inputLabel = '';
  private module: EmModule | null = null;
  private paramQueue: [string, number][] = [];
  private exportWaiters: ((d: LoopExport | null) => void)[] = [];

  capture: CaptureInfo | null = null;
  cabOn = false;
  ampActive = true;
  micError: string | null = null;
  analyser: AnalyserNode | null = null;
  onLooper: ((m: LooperMsg) => void) | null = null;
  onMeters: ((m: Partial<Meters>) => void) | null = null;
  onStateChange: ((s: EngineState, detail?: string) => void) | null = null;
  onCaptureChange: ((c: CaptureInfo | null) => void) | null = null;

  private setState(s: EngineState, detail?: string) {
    this.state = s;
    this.onStateChange?.(s, detail);
  }

  /** Boot: load wasm, load the default capture (this creates the context),
   *  then build the graph and open the input. Must run from a user gesture.
   *
   *  `source: 'di'` boots WITHOUT ever calling getUserMedia. That is the whole
   *  point of it: a visitor who arrived from a link has not agreed to hand
   *  over a microphone, and asking before they have heard anything is how the
   *  product used to lose them at the door. The mic can be opened later, on
   *  purpose, by someone who has decided they want it. */
  async start(defaultCaptureUrl: string, defaultCapture: CaptureInfo,
              opts: { source?: 'mic' | 'di' } = {}): Promise<void> {
    if (this.state === 'running' || this.state === 'booting') return;
    this.setState('booting', 'loading engine');

    const graphReady = new Promise<{ node: AudioWorkletNode; ctx: AudioContext }>((res) => {
      window.wasmAudioWorkletCreated = (node, ctx) => res({ node, ctx });
    });

    await this.injectModuleScript();
    this.module = await this.waitForModule();

    this.setState('booting', 'loading capture');
    const namJson = await (await fetch(defaultCaptureUrl)).text();
    // First setDsp spins up the module's AudioContext + worklet thread.
    await this.setDsp(namJson);

    const { node, ctx } = await graphReady;
    this.namNode = node;
    this.ctx = ctx;

    this.setState('booting', 'building graph');
    await ctx.audioWorklet.addModule('/worklet/remi-processor.js');

    this.pre = new AudioWorkletNode(ctx, 'remi-chain', {
      numberOfInputs: 1, numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'discrete',
      processorOptions: { stage: 'pre' },
    });
    this.post = new AudioWorkletNode(ctx, 'remi-chain', {
      numberOfInputs: 1, numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 1, channelCountMode: 'explicit',
      processorOptions: { stage: 'post' },
    });

    this.namIn = ctx.createGain();
    this.namOut = ctx.createGain();
    this.ampBypass = ctx.createGain();
    this.ampBypass.gain.value = 0;
    const cabSum = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    this.cabWet = ctx.createGain();
    this.cabDry = ctx.createGain();
    this.cabWet.gain.value = 0;
    this.cabDry.gain.value = 1;

    this.pre.connect(this.namIn);
    this.namIn.connect(node);
    node.connect(this.namOut);
    this.pre.connect(this.ampBypass);
    this.namOut.connect(cabSum);
    this.ampBypass.connect(cabSum);
    cabSum.connect(this.convolver);
    this.convolver.connect(this.cabWet);
    cabSum.connect(this.cabDry);
    this.cabWet.connect(this.post);
    this.cabDry.connect(this.post);
    this.post.connect(ctx.destination);

    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (d?.type === 'meters') this.onMeters?.(d);
      else if (d?.type === 'export') {
        // splice(0) so a waiter cannot be settled twice, and so a second
        // export starting mid-flight cannot inherit the first one's audio.
        for (const done of this.exportWaiters.splice(0)) done(d.empty ? null : d as LoopExport);
      } else if (d?.type === 'looper' || d?.type === 'wave') this.onLooper?.(d);
    };
    this.pre.port.onmessage = onMsg;
    this.post.port.onmessage = onMsg;

    // Spectrum tap for the SAUCE glass (and anything else that wants to look).
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.82;
    this.post.connect(this.analyser);

    for (const [id, v] of this.paramQueue) this.sendParam(id, v);
    this.paramQueue = [];

    if (opts.source === 'di') {
      this.setState('booting', 'loading demo track');
      this.inputSource = 'di';
      // A failure here is not fatal either: the rig still runs, silently, and
      // the player can switch to the mic or retry.
      try { await this.startDi(); } catch (err) {
        console.warn('DI unavailable:', err);
      }
    } else {
      this.setState('booting', 'opening input');
      try {
        await this.openMic();
      } catch (err) {
        // No input is not fatal — the rig runs, the player can grant mic later.
        console.warn('mic unavailable:', err);
        this.micError = (err as Error).message;
      }
    }
    await ctx.resume();
    this.capture = defaultCapture;
    this.onCaptureChange?.(this.capture);
    this.setState('running');
  }

  private injectModuleScript(): Promise<void> {
    return new Promise((res, rej) => {
      if (document.querySelector('script[data-t3k]')) return res();
      const s = document.createElement('script');
      s.src = '/t3k-wasm-module.js';
      s.dataset.t3k = '1';
      s.onload = () => res();
      s.onerror = () => rej(new Error('failed to load NAM wasm module'));
      document.head.appendChild(s);
    });
  }

  private waitForModule(): Promise<EmModule> {
    return new Promise((res, rej) => {
      const t0 = performance.now();
      const poll = () => {
        const M = window.Module as Partial<EmModule> | undefined;
        if (M && typeof M._malloc === 'function' && typeof M.stringToUTF8 === 'function'
            && typeof M.ccall === 'function') {
          const ready = M as EmModule;
          try { ready._free(ready._malloc(1)); return res(ready); } catch { /* not ready */ }
        }
        if (performance.now() - t0 > 20000) return rej(new Error('NAM wasm module never became ready'));
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  private async setDsp(namJson: string, forceNano = false): Promise<void> {
    const M = this.module!;
    const len = new TextEncoder().encode(namJson).length + 1;
    const ptr = M._malloc(len);
    M.stringToUTF8(namJson, ptr, len);
    await M.ccall('setDsp', null, ['number', 'number'], [num(ptr), forceNano ? 1 : 0], { async: true });
    M._free(ptr);
  }

  /** Retry input open after an initial denial. */
  async retryMic(): Promise<boolean> {
    if (this.micSource || !this.ctx) return !!this.micSource;
    try {
      await this.openMic();
      this.micError = null;
      return true;
    } catch (err) {
      this.micError = (err as Error).message;
      return false;
    }
  }

  /** Debug/testing: route an oscillator into the chain instead of the mic. */
  injectTestTone(freq = 196): () => void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = 0.08;
    osc.connect(g);
    g.connect(this.pre!);
    osc.start();
    return () => { osc.stop(); osc.disconnect(); g.disconnect(); };
  }

  private async openMic(choice: InputChoice = this.input): Promise<void> {
    const audio: MediaTrackConstraints = {
      // The three processing blocks a browser adds for voice calls and a
      // guitar never wants: they chase the signal, duck the tail of every
      // note and re-level the picking hand.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      // Ask for every channel the interface has rather than pinning to 1. A
      // 2-in box puts the guitar on ONE of its inputs; letting the browser
      // downmix to mono would fold the empty input's noise floor in with it.
      // The channel the player picked is split back out below.
      channelCount: { ideal: 2 },
    };
    // `exact` on purpose: if the chosen interface was unplugged, this must
    // fail loudly so the picker can say so, not silently land on the laptop
    // mic and leave someone wondering why their amp sounds like a room.
    if (choice.deviceId && choice.deviceId !== 'default') {
      audio.deviceId = { exact: choice.deviceId };
    }
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio });

    const ctx = this.ctx!;
    const track = this.micStream.getAudioTracks()[0];
    this.inputChannels = track?.getSettings().channelCount ?? 1;
    this.micSource = ctx.createMediaStreamSource(this.micStream);

    if (this.inputChannels > 1 && typeof choice.channel === 'number') {
      // pre is channelCount 1 / explicit / discrete, so it takes the one
      // channel the splitter hands it and never mixes the other in.
      const split = ctx.createChannelSplitter(this.inputChannels);
      this.micSource.connect(split);
      split.connect(this.pre!, Math.min(choice.channel, this.inputChannels - 1));
      this.micSplit = split;
    } else {
      this.micSource.connect(this.pre!);
    }
    this.inputLabel = track?.label ?? '';
  }

  /* ── DI playback ──────────────────────────────────────────────────────
   *
   * The DI enters the graph at exactly the point the microphone does, so
   * everything downstream — gate, comp, drive, the capture, the whole post
   * chain — treats it identically to a plugged-in guitar. It is not a
   * "preview mode"; it is the same rig with a different string on the front.
   */

  /** Which DI is loaded, so the UI can show it and a take can name it. */
  diId: string | null = null;

  /** Fetch and decode a DI, replacing whatever is playing. */
  async loadDi(url: string, id: string): Promise<void> {
    if (!this.ctx) throw new Error('engine not running');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`DI ${res.status}`);
    this.diBuffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
    this.diId = id;
    if (this.inputSource === 'di') this.restartDi();
  }

  private async startDi(): Promise<void> {
    if (!this.diBuffer) await this.loadDi(DEFAULT_DI.url, DEFAULT_DI.id);
    this.restartDi();
  }

  /** (Re)start the loop. An AudioBufferSourceNode is single-use by spec, so
   *  every start builds a new one — reusing one silently does nothing. */
  private restartDi() {
    if (!this.ctx || !this.diBuffer || !this.pre) return;
    this.stopDi();
    const ctx = this.ctx;
    this.diGain = ctx.createGain();
    this.diGain.gain.value = 1;
    this.diNode = ctx.createBufferSource();
    this.diNode.buffer = this.diBuffer;
    this.diNode.loop = true;
    this.diNode.connect(this.diGain);
    this.diGain.connect(this.pre);
    this.diNode.start();
  }

  private stopDi() {
    try { this.diNode?.stop(); } catch { /* never started */ }
    this.diNode?.disconnect();
    this.diGain?.disconnect();
    this.diNode = null;
    this.diGain = null;
  }

  /** Is the demo track currently the thing feeding the rig? */
  get diPlaying(): boolean { return this.inputSource === 'di' && !!this.diNode; }

  /* Stop and start the loop WITHOUT leaving DI mode.
   *
   * These are separate from setInputSource on purpose. Wanting the loop to
   * shut up is not the same as wanting the microphone — someone tweaking a
   * reverb tail, or reading the feed with the rig open, or just sick of
   * hearing the same four bars, wants silence and nothing else. Making that
   * cost a microphone permission would be absurd. */

  /** Silence the loop, keeping DI as the input. */
  pauseDi() {
    if (this.inputSource !== 'di') return;
    this.stopDi();
    this.onInputSourceChange?.('di');
  }

  /** Start it again from the top. */
  resumeDi() {
    if (this.inputSource !== 'di' || this.diNode) return;
    this.restartDi();
    this.onInputSourceChange?.('di');
  }

  /** Flip it, returning whether it is now playing. */
  toggleDi(): boolean {
    if (this.diNode) { this.pauseDi(); return false; }
    this.resumeDi();
    return this.diPlaying;
  }

  /** Swap what feeds the chain.
   *
   *  Going to 'mic' is the first moment a permission prompt can appear, and
   *  it is a deliberate act by then. If it is refused we stay on the DI and
   *  say so rather than dropping the player into silence. */
  async setInputSource(next: 'mic' | 'di'): Promise<boolean> {
    if (!this.ctx) { this.inputSource = next; return true; }
    if (next === 'di') {
      this.closeMic();
      this.inputSource = 'di';
      try { await this.startDi(); } catch { return false; }
      this.onInputSourceChange?.('di');
      return true;
    }
    try {
      await this.openMic();
    } catch (err) {
      this.micError = (err as Error).message;
      return false;                      // still on the DI, still making sound
    }
    this.stopDi();
    this.inputSource = 'mic';
    this.micError = null;
    this.onInputSourceChange?.('mic');
    return true;
  }

  /** Drop the current input and free the device, so a re-open can take it. */
  private closeMic() {
    this.micSplit?.disconnect();
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micSplit = null;
    this.micSource = null;
    this.micStream = null;
  }

  /** Point the rig at a different input, or a different channel of the same
   *  one. Safe to call before the engine is running: the choice is stored and
   *  applied when start() opens the input. */
  async setInput(choice: InputChoice): Promise<boolean> {
    this.input = { ...choice };
    if (!this.ctx) return true;          // pre-launch: remembered, not applied
    this.closeMic();
    try {
      await this.openMic();
      this.micError = null;
      return true;
    } catch (err) {
      this.micError = (err as Error).message;
      return false;
    }
  }

  /** Send the rig's output to a specific device. Returns false where the
   *  browser has no AudioContext.setSinkId (Safari, Firefox at time of
   *  writing) — the caller says so rather than pretending it worked. */
  async setOutput(sinkId: string): Promise<boolean> {
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!ctx?.setSinkId) return false;
    // '' is the spec's "system default", which is not the same as the device
    // that happens to be listed with deviceId 'default'.
    await ctx.setSinkId(sinkId === 'default' ? '' : sinkId);
    this.output = sinkId;
    return true;
  }

  static get canPickOutput(): boolean {
    return typeof AudioContext !== 'undefined'
      && 'setSinkId' in AudioContext.prototype;
  }

  /** Swap the amp capture (bundled path or a fetched NAM json string). */
  async loadCapture(namJson: string, info: CaptureInfo, forceNano = false): Promise<void> {
    if (!this.ctx || !this.module) throw new Error('engine not running');
    await this.ctx.suspend();
    try {
      await this.setDsp(namJson, forceNano);
      this.capture = info;
      this.onCaptureChange?.(info);
    } finally {
      await this.ctx.resume();
    }
  }

  /** Load a cab IR from a decoded AudioBuffer; null clears + bypasses. */
  setCabIr(buffer: AudioBuffer | null) {
    if (!this.convolver) return;
    this.convolver.buffer = buffer;
    if (!buffer) this.enableCab(false);
  }

  enableCab(on: boolean) {
    if (!this.ctx || !this.cabWet || !this.cabDry) return;
    this.cabOn = on;
    const t = this.ctx.currentTime;
    this.cabWet.gain.setTargetAtTime(on ? 1 : 0, t, 0.015);
    this.cabDry.gain.setTargetAtTime(on ? 0 : 1, t, 0.015);
  }

  enableAmp(on: boolean) {
    if (!this.ctx || !this.namOut || !this.ampBypass) return;
    this.ampActive = on;
    const t = this.ctx.currentTime;
    this.namOut.gain.setTargetAtTime(on ? 1 : 0, t, 0.015);
    this.ampBypass.gain.setTargetAtTime(on ? 0 : 1, t, 0.015);
    this.sendParam('amp_on', on ? 1 : 0); // post stage gates the tone stack too
  }

  sendLooper(msg: Record<string, unknown>) {
    this.post?.port.postMessage({ type: 'looper-cmd', ...msg });
  }

  /** Bounce the loop stack to a stereo pair. Resolves null when there is
   *  nothing recorded, or nothing left unmuted. */
  exportLoop(): Promise<LoopExport | null> {
    if (!this.post) return Promise.resolve(null);
    return new Promise((res) => {
      this.exportWaiters.push(res);
      this.sendLooper({ cmd: 'export' });
    });
  }

  sendParam(id: string, v: number) {
    if (!this.pre || !this.post) { this.paramQueue.push([id, v]); return; }
    const msg = { type: 'param', id, v };
    // Both stages share one processor class — each ignores ids it doesn't own.
    this.pre.port.postMessage(msg);
    this.post.port.postMessage(msg);
  }

  latencyMs(): { base: number; output: number; quantum: number } | null {
    if (!this.ctx) return null;
    return {
      base: this.ctx.baseLatency * 1000,
      output: ((this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0) * 1000,
      quantum: (128 / this.ctx.sampleRate) * 1000,
    };
  }

  sampleRate(): number | null { return this.ctx?.sampleRate ?? null; }
}

export const engine = new RigEngine();
