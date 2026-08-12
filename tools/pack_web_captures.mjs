#!/usr/bin/env node
/* Pack the web player's factory captures + factory cab IR into the web vault.
 *
 * Reads the PLAIN sources from assets-src/ (git-ignored — the plain files
 * must not be committed or served) and writes ChaCha20-encrypted twins the
 * page actually serves:
 *
 *   assets-src/captures/<stem>.nam  -> app/public/assets/captures/<stem>.namx
 *   assets-src/irs/katahdin_cab.wav -> app/public/assets/irs/katahdin_cab.wavx
 *
 * app/src/vault.ts is the decrypting mirror — the key, the per-file nonce
 * rule (SHA-256(served filename)[0..12), counter from 1) and the block
 * function must match. Change one, change both.
 *
 * HONEST LIMIT: the key ships in the page's JS (a browser must decrypt what
 * it plays), so this is deterrence against casual copying, not DRM. It is a
 * DIFFERENT key from the desktop plugin's vault — never reuse that one here.
 *
 * Run whenever a factory capture/IR changes:  node tools/pack_web_captures.mjs
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_HEX = 'ca739228f0e18628fb4e0c4b9bb8a8b52b845a5a5986d0a3c31d4db905aa3dbc';

const keyWords = new Uint32Array(Uint8Array.from(Buffer.from(KEY_HEX, 'hex')).buffer);

function quarter(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) >>> 0; s[d] ^= s[a]; s[d] = ((s[d] << 16) | (s[d] >>> 16)) >>> 0;
  s[c] = (s[c] + s[d]) >>> 0; s[b] ^= s[c]; s[b] = ((s[b] << 12) | (s[b] >>> 20)) >>> 0;
  s[a] = (s[a] + s[b]) >>> 0; s[d] ^= s[a]; s[d] = ((s[d] << 8) | (s[d] >>> 24)) >>> 0;
  s[c] = (s[c] + s[d]) >>> 0; s[b] ^= s[c]; s[b] = ((s[b] << 7) | (s[b] >>> 25)) >>> 0;
}

function chachaBlock(counter, nonce) {
  const init = new Uint32Array(16);
  init.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574], 0);
  init.set(keyWords, 4);
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

function encrypt(servedName, data) {
  const nameHash = createHash('sha256').update(servedName, 'utf8').digest();
  const nonce = new Uint32Array(Uint8Array.from(nameHash.subarray(0, 12)).buffer);
  const out = new Uint8Array(data.length);
  let counter = 1;
  for (let off = 0; off < data.length; off += 64) {
    const ks = chachaBlock(counter++, nonce);
    const n = Math.min(64, data.length - off);
    for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ ks[i];
  }
  return out;
}

let packed = 0;
const jobs = [];
for (const f of readdirSync(join(root, 'assets-src/captures'))) {
  if (f.endsWith('.nam'))
    jobs.push(['assets-src/captures/' + f, 'app/public/assets/captures/' + f + 'x']);
}
for (const f of readdirSync(join(root, 'assets-src/irs'))) {
  if (f.endsWith('.wav'))
    jobs.push(['assets-src/irs/' + f, 'app/public/assets/irs/' + f + 'x']);
}
for (const [src, dst] of jobs) {
  const served = dst.split('/').pop();
  const data = readFileSync(join(root, src));
  mkdirSync(dirname(join(root, dst)), { recursive: true });
  writeFileSync(join(root, dst), encrypt(served, data));
  console.log(`  packed ${served}  (${data.length} bytes)`);
  packed++;
}
console.log(`web vault: ${packed} files encrypted`);
