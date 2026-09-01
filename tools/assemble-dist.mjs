/* Assemble the one deployable dist/:
 *
 *   dist/
 *     index.html css/ js/ assets/img … ← the landing (this repo's root files)
 *     guitar.html                      ← retired URL, forwards to /
 *     t3k-callback.html                ← TONE3000 OAuth callback (see below)
 *
 * and, only when SHIP_RIG is on:
 *
 *     play/index.html                  ← the rig document (built by Vite)
 *     assets/play-*.js …               ← the rig's hashed bundles
 *     assets/ui|site|captures, worklet/, t3k-wasm-module.* ← the rig's public files
 *     signin.html                      ← auth, un-isolated at root
 *
 * The app's runtime paths are root-absolute (/assets/ui/…, /worklet/…,
 * /t3k-wasm-module.js, /t3k-callback.html) ON PURPOSE: the two trees are
 * disjoint below /assets (landing owns img/fonts+css/js, the rig owns
 * ui/site/captures + hashed bundles), so merging them at the root means not
 * one path in the app's source had to change. Keep it that way — a new
 * landing asset dir must not collide with an app public dir.
 */
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* THE WEB RIG DOES NOT SHIP (2026-09-01).
 *
 * One load of /play pulled 36.4 MB — it fetches essentially the whole 43 MB
 * UI art pool up front, with no interaction — against a Firebase Spark plan
 * capped at 10 GB of transfer a month. 275 loads would have been the entire
 * month. The rig was already unpublished from the landing (nothing links it),
 * so it was spending the budget without earning anything.
 *
 * The rig's SOURCE is untouched and it still builds; this only decides what
 * reaches the deploy. To put it back: flip this to true, redeploy, and undo
 * the landing's removals (the #live band and its JSON-LD node, in git as of
 * the commit that added this). Note that /play's Google sign-in needs
 * Firebase Hosting's same-origin /__/auth/handler — see app/src/cloud/fb.ts —
 * so the rig cannot simply move to a static host with the landing.
 *
 * Before turning it back on, convert assets/ui from PNG to WebP: measured at
 * 42.6 MB -> 3.7 MB, a 91% cut, and half those files carry no alpha at all. */
const SHIP_RIG = false;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const appDist = join(root, 'app', 'dist');

if (SHIP_RIG && !existsSync(appDist)) {
  console.error('app/dist missing — run `npm --prefix app run build` first');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

// the rig first, the landing second — on a same-name collision (favicon.ico)
// the landing's file is the site's face and wins
if (SHIP_RIG) cpSync(appDist, dist, { recursive: true });

for (const entry of ['index.html', '404.html', 'guitar.html', 'css', 'js',
                     'assets', 'favicon.ico', 'robots.txt', 'sitemap.xml']) {
  const src = join(root, entry);
  if (existsSync(src)) cpSync(src, join(dist, entry), { recursive: true, force: true });
}

/* The OAuth callback ships either way — it is 4 KB and it is a URL other
 * people have registered. The web rig sends TONE3000 to
 * <origin>/t3k-callback.html (app/src/tone3000.ts) and tells users to list
 * that exact URL as a redirect URI on their own API key. Whether the DESKTOP
 * plugin does the same is decided in another repo, so withdrawing the URL to
 * save four kilobytes is a bad trade: keep serving it. */
if (!SHIP_RIG) {
  const callback = join(root, 'app', 'public', 't3k-callback.html');
  if (existsSync(callback)) cpSync(callback, join(dist, 't3k-callback.html'));
}

/* MASTERS DON'T SHIP.
 * assets/img holds the full-size originals the webp/jpg deliverables are
 * baked from, and assets/video holds the raw grade. They're committed —
 * assets-src/ is gitignored, so this is where they have to live — but the
 * page references none of them, and at 3 MB a piece they are pure egress
 * risk: every one of these was a <picture> fallback or a <video> src until
 * the bandwidth cut, so crawlers know the URLs and will keep asking for
 * years. Better a 404 than 3 MB. Deliverables only below.
 *
 * Adding a master? Add it here too. If a name here ever comes back into the
 * markup, take it off this list — the build will not warn you. */
const mastersNotShipped = [
  'img/amp-ac30.png', 'img/amp-heavy.png', 'img/amp-hero.png',
  'img/amp-plexi.png', 'img/amp-window-portland.png', 'img/cab.png',
  'img/captures-tone3000.png', 'img/chorus.png', 'img/delay.png',
  'img/icon.png', 'img/logo-full.png', 'img/pedal.png', 'img/reverb.png',
  'img/studio.png', 'video/maine-film.mp4',
];
for (const rel of mastersNotShipped) rmSync(join(dist, 'assets', rel), { force: true });

console.log(`dist/ assembled — landing at /${SHIP_RIG ? ', rig at /play/' : ' (rig withheld)'}`
          + ` (${mastersNotShipped.length} masters withheld)`);
