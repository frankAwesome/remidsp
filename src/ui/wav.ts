/* WAV writer — 24-bit PCM, stereo, interleaved.
 *
 * 24-bit rather than 16: a loop leaves here to be dropped into a DAW, and
 * 16-bit would put a dither decision on the player without asking. Rather
 * than 32-bit float, because plenty of things that open a .wav still cannot
 * read float, and a file that will not open is worse than one that is 40 %
 * larger.
 *
 * The engine hands over floats that have already been through the loop's soft
 * limiter, so they sit inside ±1 — but clamping is still done here, because a
 * sample that wraps instead of clipping is the ugliest sound a file can make.
 */

const HEADER = 44;

function writeAscii(view: DataView, at: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
}

export function encodeWav24(L: Float32Array, R: Float32Array, sampleRate: number): Blob {
  const frames = Math.min(L.length, R.length);
  const bytesPerSample = 3;
  const channels = 2;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buf = new ArrayBuffer(HEADER + dataBytes);
  const v = new DataView(buf);

  writeAscii(v, 0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeAscii(v, 8, 'WAVE');
  writeAscii(v, 12, 'fmt ');
  v.setUint32(16, 16, true);              // PCM fmt chunk size
  v.setUint16(20, 1, true);               // format 1 = integer PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bytesPerSample * 8, true);
  writeAscii(v, 36, 'data');
  v.setUint32(40, dataBytes, true);

  let at = HEADER;
  for (let i = 0; i < frames; i++) {
    for (const ch of [L, R]) {
      const x = Math.max(-1, Math.min(1, ch[i]));
      // Asymmetric on purpose: 24-bit signed runs -8388608..8388607, so the
      // positive side has one step less than the negative one.
      const s = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff);
      v.setUint8(at, s & 0xff);
      v.setUint8(at + 1, (s >> 8) & 0xff);
      v.setUint8(at + 2, (s >> 16) & 0xff);
      at += 3;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Hand a blob to the browser as a download and clean the URL up after. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers; a tick
  // later the fetch has already been handed off.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
