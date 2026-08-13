/* Assemble the one deployable dist/:
 *
 *   dist/
 *     index.html css/ js/ assets/img … ← the landing (this repo's root files)
 *     play/index.html                  ← the rig document (built by Vite)
 *     assets/play-*.js …               ← the rig's hashed bundles
 *     assets/ui|site|captures, worklet/, t3k-wasm-module.* ← the rig's public files
 *     signin.html, t3k-callback.html   ← auth + OAuth callback, un-isolated at root
 *
 * The app's runtime paths are root-absolute (/assets/ui/…, /worklet/…,
 * /t3k-wasm-module.js, /t3k-callback.html) ON PURPOSE: the two trees are
 * disjoint below /assets (landing owns img/fonts+css/js/audio, the rig owns
 * ui/site/captures + hashed bundles), so merging them at the root means not
 * one path in the app's source had to change. Keep it that way — a new
 * landing asset dir must not collide with an app public dir.
 */
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const appDist = join(root, 'app', 'dist');

if (!existsSync(appDist)) {
  console.error('app/dist missing — run `npm --prefix app run build` first');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

// the rig first, the landing second — on a same-name collision (favicon.ico)
// the landing's file is the site's face and wins
cpSync(appDist, dist, { recursive: true });
for (const entry of ['index.html', '404.html', 'css', 'js', 'assets', 'audio',
                     'favicon.ico', 'robots.txt', 'sitemap.xml']) {
  const src = join(root, entry);
  if (existsSync(src)) cpSync(src, join(dist, entry), { recursive: true, force: true });
}
console.log('dist/ assembled — landing at /, rig at /play/');
