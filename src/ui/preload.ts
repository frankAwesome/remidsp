/* Asset preloader — every face render, knob sprite and chip is fetched and
 * decoded before the rig opens, so switching modules never shows a bare
 * panel. The manifest is derived from the same geometry tables the panels
 * use; decoded Images are pinned here so the cache can't evict them. */

import { AMP_FACES, PEDAL_FACES, STUDIO_FACE, delayFace } from '../geometry';

const SLOT_KEYS = ['gate', 'comp', 'drive', 'amp', 'cab', 'sauce', 'studio', 'chorus', 'delay', 'reverb'];

function manifest(): string[] {
  const urls = new Set<string>();
  for (const a of Object.values(AMP_FACES)) { urls.add(a.img); urls.add(a.sprite); }
  for (const p of Object.values(PEDAL_FACES)) { urls.add(p.img); urls.add(p.sprite); }
  for (const i of [0, 1] as const) { const d = delayFace(i); urls.add(d.img); urls.add(d.sprite); }
  urls.add(STUDIO_FACE.img);
  for (const k of STUDIO_FACE.knobs) urls.add(k.sprite);
  for (const key of SLOT_KEYS) {
    urls.add(`/assets/ui/chip_${key}_on.png`);
    urls.add(`/assets/ui/chip_${key}_off.png`);
  }
  urls.add('/assets/ui/brand_logo.png');
  urls.add('/assets/ui/knob_ssl_silver.png');
  urls.add('/assets/ui/cab_face_ac30.png');
  return [...urls];
}

const pinned: HTMLImageElement[] = [];

export function preloadAssets(onProgress: (done: number, total: number) => void): Promise<void> {
  const urls = manifest();
  const total = urls.length;
  let done = 0;
  onProgress(0, total);
  const jobs = urls.map((url) => {
    const img = new Image();
    img.src = url;
    pinned.push(img);
    // decode() can stall indefinitely in a hidden/background tab — a missing
    // file or a throttled decode must never gate the PLUG IN button.
    return Promise.race([
      img.decode().catch(() => undefined),
      new Promise((r) => setTimeout(r, 8000)),
    ]).then(() => onProgress(++done, total));
  });
  return Promise.race([
    Promise.all(jobs),
    new Promise((r) => setTimeout(r, 12000)),
  ]).then(() => undefined);
}
