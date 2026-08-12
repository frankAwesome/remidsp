/* The web capture vault — the site-side twin of the plugin's CaptureVault.
 *
 * Factory captures and the factory cab IR are served ENCRYPTED (.namx/.wavx,
 * ChaCha20, built by tools/pack_web_captures.mjs) and decrypted here just
 * before they feed the engine, so the files sitting on the CDN are not
 * loadable .nam/.wav documents anybody can curl.
 *
 * HONEST LIMIT (same as the plugin's vault): a browser must be able to
 * decrypt what it plays, so this key ships in the page's JavaScript — a
 * determined person with devtools can still recover the content. What this
 * ends is the trivial copy: fetching /assets/captures/<stem>.nam by URL.
 * Deterrence, not DRM. The key is deliberately NOT the desktop vault's key.
 *
 * Per-file nonce = SHA-256(served filename)[0..12), counter starts at 1 —
 * mirror of pack_web_captures.mjs; change one, change both.
 */

const KEY_HEX = 'ca739228f0e18628fb4e0c4b9bb8a8b52b845a5a5986d0a3c31d4db905aa3dbc';

function keyWords(): Uint32Array {
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) k[i] = parseInt(KEY_HEX.slice(i * 2, i * 2 + 2), 16);
  return new Uint32Array(k.buffer);
}

/* eslint-disable no-bitwise */
function quarter(s: Uint32Array, a: number, b: number, c: number, d: number) {
  s[a] = (s[a] + s[b]) >>> 0; s[d] ^= s[a]; s[d] = ((s[d] << 16) | (s[d] >>> 16)) >>> 0;
  s[c] = (s[c] + s[d]) >>> 0; s[b] ^= s[c]; s[b] = ((s[b] << 12) | (s[b] >>> 20)) >>> 0;
  s[a] = (s[a] + s[b]) >>> 0; s[d] ^= s[a]; s[d] = ((s[d] << 8) | (s[d] >>> 24)) >>> 0;
  s[c] = (s[c] + s[d]) >>> 0; s[b] ^= s[c]; s[b] = ((s[b] << 7) | (s[b] >>> 25)) >>> 0;
}

function chachaBlock(key: Uint32Array, counter: number, nonce: Uint32Array): Uint8Array {
  const init = new Uint32Array(16);
  init.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574], 0);
  init.set(key, 4);
  init[12] = counter >>> 0;
  init.set(nonce, 13);
  const w = new Uint32Array(init);
  for (let i = 0; i < 10; i++) {
    quarter(w, 0, 4, 8, 12); quarter(w, 1, 5, 9, 13);
    quarter(w, 2, 6, 10, 14); quarter(w, 3, 7, 11, 15);
    quarter(w, 0, 5, 10, 15); quarter(w, 1, 6, 11, 12);
    quarter(w, 2, 7, 8, 13); quarter(w, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) w[i] = (w[i] + init[i]) >>> 0;
  return new Uint8Array(w.buffer);
}

/** Decrypt one vault file. `servedName` is the filename the bytes were packed
 *  under (e.g. "camden_clean.namx") — it seeds the per-file nonce. */
export async function decryptVault(servedName: string, data: ArrayBuffer): Promise<Uint8Array> {
  const nameHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(servedName));
  const nonce = new Uint32Array(nameHash.slice(0, 12));
  const key = keyWords();
  const src = new Uint8Array(data);
  const out = new Uint8Array(src.length);
  let counter = 1;
  for (let off = 0; off < src.length; off += 64) {
    const ks = chachaBlock(key, counter++, nonce);
    const n = Math.min(64, src.length - off);
    for (let i = 0; i < n; i++) out[off + i] = src[off + i] ^ ks[i];
  }
  return out;
}

/** Fetch + decrypt a vault file to text (NAM capture JSON). */
export async function fetchVaultText(url: string): Promise<string> {
  const name = url.split('/').pop()!;
  const bytes = await decryptVault(name, await (await fetch(url)).arrayBuffer());
  return new TextDecoder().decode(bytes);
}

/** Fetch + decrypt a vault file to raw bytes (cab IR wav). */
export async function fetchVaultBytes(url: string): Promise<ArrayBuffer> {
  const name = url.split('/').pop()!;
  const bytes = await decryptVault(name, await (await fetch(url)).arrayBuffer());
  return bytes.buffer as ArrayBuffer;
}
