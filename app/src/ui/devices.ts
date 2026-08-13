/* The input/output picker.
 *
 * Browsers hand a page whatever device the OS calls "default" and give the
 * player no say inside the app — and until microphone permission is granted,
 * enumerateDevices() returns entries whose labels are empty strings, so a
 * picker built before that point lists nothing but "Audio input 1, 2, 3".
 * That is the whole reason this asks for permission FIRST and enumerates
 * second: with permission in hand the labels are the real ones — "Scarlett
 * 2i2 USB", "Studio Monitors" — and the player is choosing gear by name.
 *
 * The channel selector matters as much as the device one. A 2-in interface
 * puts the guitar on ONE of its inputs; the browser's default mono downmix
 * folds the empty input in with it and drags its noise floor along. So the
 * stream is opened asking for both channels and the chosen one is split back
 * out — which is why the channel list can only be built after a probe: the
 * channel count is a property of the open stream, not of the device entry.
 *
 * Everything is chosen BEFORE the rig launches and remembered on the device,
 * so the second visit opens straight onto the right interface.
 */

import { engine, type InputChoice } from '../audio/engine';
import { RigEngine } from '../audio/engine';

const LS_IN = 'remi_audio_in';
const LS_CH = 'remi_audio_in_ch';
const LS_OUT = 'remi_audio_out';

export interface Saved { deviceId: string; channel: number; output: string }

export function loadSaved(): Saved {
  return {
    deviceId: localStorage.getItem(LS_IN) ?? 'default',
    channel: Number(localStorage.getItem(LS_CH) ?? '0') || 0,
    output: localStorage.getItem(LS_OUT) ?? 'default',
  };
}
function save(s: Saved) {
  localStorage.setItem(LS_IN, s.deviceId);
  localStorage.setItem(LS_CH, String(s.channel));
  localStorage.setItem(LS_OUT, s.output);
}

/** The choice, in the shape the engine wants. */
export function savedInputChoice(): InputChoice {
  const s = loadSaved();
  return { deviceId: s.deviceId, channel: s.channel };
}

/** Grant the microphone and drop the stream again — this is what turns the
 *  device labels from "" into the names printed on the hardware. */
async function grant(): Promise<void> {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  s.getTracks().forEach((t) => t.stop());
}

/** How many channels a device actually offers. Only an open stream knows, so
 *  this opens one, reads the setting and closes it again. */
async function probeChannels(deviceId: string): Promise<number> {
  try {
    const audio: MediaTrackConstraints = { channelCount: { ideal: 2 },
      echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (deviceId && deviceId !== 'default') audio.deviceId = { exact: deviceId };
    const s = await navigator.mediaDevices.getUserMedia({ audio });
    const n = s.getAudioTracks()[0]?.getSettings().channelCount ?? 1;
    s.getTracks().forEach((t) => t.stop());
    return Math.max(1, n);
  } catch { return 1; }
}

export class DevicePicker {
  root: HTMLElement;
  private state: Saved = loadSaved();
  private channels = 1;
  private granted = false;
  /** Has the stream-opening channel probe already run this session? */
  private probed = false;
  private onChange: (() => void) | null = null;

  constructor(onChange?: () => void) {
    this.onChange = onChange ?? null;
    this.root = document.createElement('div');
    this.root.className = 'devices';
    this.render();
    // Only re-probe on a device change if a probe was already legitimate this
    // session. Otherwise plugging in a pair of headphones would open the
    // microphone of somebody who never asked for the picker at all.
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      if (this.probed) void this.refresh(); else void this.render();
    });
    void this.init();
  }

  private async init() {
    // If permission was granted on an earlier visit the labels are already
    // readable, so the player never sees the prompt step twice.
    try {
      const p = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
      if (p?.state === 'granted') this.granted = true;
    } catch { /* Firefox has no microphone permission descriptor */ }
    if (!this.granted) {
      const list = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      this.granted = list.some((d) => d.kind === 'audioinput' && d.label !== '');
    }
    // NOT refresh(). This runs at page load, and refresh() probes the channel
    // count by OPENING A STREAM — so for anyone who had ever granted the
    // microphone on this origin, merely loading the page lit their mic
    // indicator before they had pressed anything. That is a privacy surprise
    // on its own, and it flatly contradicts the promise the LISTEN FIRST door
    // is making one element away on the same screen.
    //
    // Labels only need enumerateDevices(), which costs no stream. The channel
    // count is the only thing that needs one, and it is not needed until
    // somebody is actually choosing an interface.
    this.render();
  }

  /** Probe the channel count — opens and immediately closes a stream, so it
   *  is only ever called once somebody has asked for the picker. */
  private async refresh() {
    this.channels = await probeChannels(this.state.deviceId);
    if (this.state.channel >= this.channels) this.state.channel = 0;
    this.render();
  }

  /** The picker was actually opened. Now the stream-opening probe is fair.
   *  Idempotent: re-opening the drawer must not re-prompt. */
  async reveal(): Promise<void> {
    if (!this.granted || this.probed) return;
    this.probed = true;
    await this.refresh();
  }

  private async devices() {
    const list = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    return {
      inputs: list.filter((d) => d.kind === 'audioinput'),
      outputs: list.filter((d) => d.kind === 'audiooutput'),
    };
  }

  private async render() {
    if (!this.granted) {
      this.root.innerHTML = `
        <div class="devices__ask">
          <button class="devices__grant" type="button">CHOOSE YOUR INTERFACE</button>
          <span>Allow the microphone once and this lists your gear by name —
                inputs, channels and outputs, picked here instead of guessed by the OS.</span>
        </div>`;
      this.root.querySelector('button')!.addEventListener('click', async () => {
        const btn = this.root.querySelector('button')!;
        btn.disabled = true;
        btn.textContent = 'WAITING FOR PERMISSION…';
        try {
          await grant();
          this.granted = true;
          this.probed = true;   // permission is live; probing costs no prompt
          await this.refresh();
        } catch (err) {
          this.root.innerHTML = `<div class="devices__ask devices__ask--bad">
            <span>Microphone blocked — ${(err as Error).name}. Allow it in the browser's
            site settings, then reload. The rig still runs without an input.</span></div>`;
        }
      });
      return;
    }

    const { inputs, outputs } = await this.devices();
    const opt = (v: string, label: string, sel: boolean) =>
      `<option value="${v}" ${sel ? 'selected' : ''}>${label.replace(/</g, '&lt;')}</option>`;

    const chanRow = this.channels > 1 ? `
      <label class="devices__field">
        <span>INPUT CHANNEL</span>
        <select data-k="channel">
          ${Array.from({ length: this.channels }, (_, i) =>
            opt(String(i), `Input ${i + 1}${i === 0 ? ' (left)' : i === 1 ? ' (right)' : ''}`,
                i === this.state.channel)).join('')}
        </select>
      </label>` : '';

    // Output picking needs AudioContext.setSinkId. Where it is missing the
    // row is stated as unavailable rather than shown as a dead control.
    const outRow = RigEngine.canPickOutput ? `
      <label class="devices__field">
        <span>OUTPUT</span>
        <select data-k="output">
          ${opt('default', 'System default', this.state.output === 'default')}
          ${outputs.filter((d) => d.deviceId !== 'default')
            .map((d) => opt(d.deviceId, d.label || 'Output', d.deviceId === this.state.output)).join('')}
        </select>
      </label>` : `
      <div class="devices__field devices__field--off">
        <span>OUTPUT</span><em>follows the system — this browser cannot route it</em>
      </div>`;

    this.root.innerHTML = `
      <div class="devices__grid">
        <label class="devices__field">
          <span>INPUT</span>
          <select data-k="deviceId">
            ${opt('default', 'System default', this.state.deviceId === 'default')}
            ${inputs.filter((d) => d.deviceId !== 'default')
              .map((d) => opt(d.deviceId, d.label || 'Input', d.deviceId === this.state.deviceId)).join('')}
          </select>
        </label>
        ${chanRow}
        ${outRow}
      </div>`;

    for (const sel of this.root.querySelectorAll<HTMLSelectElement>('select')) {
      sel.addEventListener('change', () => void this.apply(sel.dataset.k!, sel.value));
    }
  }

  private async apply(key: string, value: string) {
    if (key === 'channel') this.state.channel = Number(value);
    else if (key === 'output') this.state.output = value;
    else {
      this.state.deviceId = value;
      this.state.channel = 0;
    }
    save(this.state);

    // Applied live when the rig is already up; stored for launch when it is
    // not. setInput handles both, so the picker does not care which it is.
    if (key === 'output') await engine.setOutput(this.state.output);
    else await engine.setInput({ deviceId: this.state.deviceId, channel: this.state.channel });

    if (key === 'deviceId') await this.refresh();
    this.onChange?.();
  }
}
