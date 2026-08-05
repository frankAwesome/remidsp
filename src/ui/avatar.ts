/* Avatar encoding — a picked file becomes a small square data URI.
 *
 * The picture lives on the profile document itself, and that document's
 * byline (name + avatar) is denormalised onto every preset and comment the
 * player writes. So the encoded size is not a detail: a feed page pulls sixty
 * presets, and each one carries a copy. Everything here exists to hold that
 * copy to a few kilobytes — centre-crop to a square, downscale to AVATAR_PX,
 * then step JPEG quality down until the encoding fits AVATAR_MAX_B64.
 */

/** Rendered at most 92 px (profile header); 128 keeps it sharp on retina. */
const AVATAR_PX = 128;
/** Hard ceiling on the stored string. Firestore rules enforce this too. */
export const AVATAR_MAX_B64 = 12000;
const QUALITY_STEPS = [0.82, 0.72, 0.62, 0.52, 0.42, 0.34];

export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
/** Refuse absurd inputs before decoding them into memory. Generous enough
 *  for a phone photo or a full-screen PNG grab off a 5K display. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('that file is not an image the browser can read')); };
    img.src = url;
  });
}

/**
 * Encode a picked file as a square JPEG data URI within the size budget.
 * Throws with a message meant for the player, not the console.
 */
export async function encodeAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('pick an image file (png, jpg, webp)');
  if (file.size > MAX_FILE_BYTES) throw new Error('that image is over 32 MB — pick a smaller one');

  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error('that image has no dimensions');

  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_PX;
  canvas.height = AVATAR_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('this browser would not give us a canvas');
  ctx.imageSmoothingQuality = 'high';
  // Centre-crop: avatars are drawn in a circle, so the middle is what counts.
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2,
                side, side, 0, 0, AVATAR_PX, AVATAR_PX);

  for (const q of QUALITY_STEPS) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length <= AVATAR_MAX_B64) return url;
  }
  throw new Error('could not compress that image small enough — try a simpler picture');
}
