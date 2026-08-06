/* Pictures.
 *
 * TWO BACKENDS, ONE CALL SITE. Which one runs is a build-time config value,
 * so connecting R2 later is a config change and not a rewrite.
 *
 *   R2 (when VITE_MEDIA_ORIGIN is set)
 *     The picture is encoded to WebP and PUT through the share Worker, which
 *     checks the caller's Firebase ID token before it writes. Firestore stores
 *     a URL. Avatars can be sharp, covers can exist at all.
 *
 *   INLINE (the fallback, and what runs today)
 *     The picture is a base64 data URI on the profile document, capped at
 *     12 kB — because that document's byline is denormalised onto EVERY preset
 *     and EVERY comment the player writes, so the cap is not a style choice,
 *     it is what stops a feed page pulling sixty copies of a photograph.
 *     Cover images are simply unavailable here: there is no honest way to put
 *     a banner in a field that has to stay under 12 kB.
 *
 * The fallback is not a stub. It is the behaviour that shipped, and it keeps
 * working untouched until the day a media origin exists.
 */

import { auth } from './fb';

/** Where uploaded media is served from — the share Worker's origin. Empty
 *  until R2 is actually connected, and everything keys off that. */
const MEDIA_ORIGIN: string = (import.meta.env.VITE_MEDIA_ORIGIN as string | undefined) ?? '';

/** Is real media hosting available? Every picture feature asks this rather
 *  than assuming, so a half-configured deploy degrades instead of throwing. */
export function mediaEnabled(): boolean { return MEDIA_ORIGIN !== ''; }

export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif';
/** Generous enough for a phone photo or a 5K screen grab; refuses the absurd
 *  before it is decoded into memory. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

export interface ImageSpec {
  /** Longest edge after resizing. */
  px: number;
  /** Aspect to crop to — 1 for an avatar disc, 3 for a cover banner. */
  aspect: number;
  /** Ceiling on the encoded bytes. */
  maxBytes: number;
}

export const AVATAR_R2: ImageSpec = { px: 256, aspect: 1, maxBytes: 60_000 };
export const COVER_R2: ImageSpec = { px: 1600, aspect: 3, maxBytes: 220_000 };
/** The inline avatar's budget is the Firestore document's, not the eye's. */
export const AVATAR_INLINE: ImageSpec = { px: 128, aspect: 1, maxBytes: 12_000 };

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('that file is not an image the browser can read')); };
    img.src = url;
  });
}

/** WebP where the browser has an encoder, JPEG where it does not.
 *
 *  Detected by encoding one pixel and reading the mime back, because
 *  canvas.toBlob silently FALLS BACK to PNG for a type it cannot encode —
 *  and a PNG photograph is several times the size of the JPEG we would have
 *  chosen, which would quietly blow every byte budget on this page. */
let cachedType: string | null = null;
function bestType(): string {
  if (cachedType) return cachedType;
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  cachedType = c.toDataURL('image/webp').startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg';
  return cachedType;
}

/** Centre-crop to the aspect, scale to the spec, and step quality down until
 *  it fits the byte budget. Returns the blob and the mime actually used. */
async function encode(file: File, spec: ImageSpec): Promise<{ blob: Blob; type: string }> {
  if (!file.type.startsWith('image/')) throw new Error('pick an image file (png, jpg, webp)');
  if (file.size > MAX_FILE_BYTES) throw new Error('that image is over 32 MB — pick a smaller one');

  const img = await loadImage(file);
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !ih) throw new Error('that image has no dimensions');

  // The source rectangle with the target aspect, taken from the middle.
  let sw = iw, sh = Math.round(iw / spec.aspect);
  if (sh > ih) { sh = ih; sw = Math.round(ih * spec.aspect); }
  const sx = Math.round((iw - sw) / 2), sy = Math.round((ih - sh) / 2);

  const w = Math.min(spec.px, sw);
  const h = Math.round(w / spec.aspect);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('this browser would not give us a canvas');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);

  const type = bestType();
  for (const q of [0.86, 0.78, 0.7, 0.62, 0.54, 0.46, 0.38]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));
    if (blob && blob.size <= spec.maxBytes) return { blob, type };
  }
  throw new Error('could not compress that image small enough — try a simpler picture');
}

/** The inline path: the same encode, handed back as a data URI. */
export async function encodeInline(file: File): Promise<string> {
  const { blob } = await encode(file, AVATAR_INLINE);
  return await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(new Error('could not read that image back'));
    fr.readAsDataURL(blob);
  });
}

export type MediaKind = 'avatar' | 'cover';

/**
 * Put a picture where it belongs and return the URL to store on the profile.
 *
 * With a media origin: encodes and uploads, returning an https URL.
 * Without one: an avatar becomes an inline data URI, and a cover throws —
 * the caller should not have offered a cover in the first place, and saying
 * so plainly beats silently storing something that will break the feed.
 */
export async function uploadImage(file: File, kind: MediaKind): Promise<string> {
  if (!mediaEnabled()) {
    if (kind === 'cover') {
      throw new Error('cover images need the media store connected — see worker/README.md');
    }
    return encodeInline(file);
  }

  const user = auth.currentUser;
  if (!user) throw new Error('sign in to upload a picture');
  const { blob, type } = await encode(file, kind === 'cover' ? COVER_R2 : AVATAR_R2);

  // The Worker checks this token before it writes anything, so the uid in the
  // object key is the signed-in player's and cannot be spoofed by the client.
  const idToken = await user.getIdToken();
  const res = await fetch(`${MEDIA_ORIGIN}/upload/${kind}`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${idToken}`, 'content-type': type },
    body: blob,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`upload failed (${res.status})${detail ? ` — ${detail.slice(0, 120)}` : ''}`);
  }
  const { url } = await res.json() as { url: string };
  if (!url) throw new Error('the upload returned no url');
  return url;
}
