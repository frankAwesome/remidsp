/* The inline avatar's size budget.
 *
 * The encoding itself moved to cloud/media.ts, which picks between a real
 * upload and this inline fallback. What stayed here is the number, because
 * the number is the interesting part and it is referenced from three places:
 * the profile form's maxlength, the media encoder, and firestore.rules.
 *
 * WHY 12 kB. The profile document's byline — name and avatar — is
 * denormalised onto EVERY preset and EVERY comment the player writes. A feed
 * page pulls thirty presets, so the avatar rides thirty times. At 12 kB that
 * is ~360 kB of base64 that no CDN can cache, that no <img> can downscale for
 * a 38 px person-card, and that goes permanently stale the moment the player
 * changes their picture — every old copy keeps the old face forever.
 *
 * That is the whole argument for hosting pictures properly, and it is why
 * this cap is not a style choice. Where a media origin is configured the
 * avatar is an https URL of about ninety characters instead, and none of the
 * above applies.
 */

/** Hard ceiling on an inline data URI. firestore.rules enforces this too. */
export const AVATAR_MAX_B64 = 12000;
