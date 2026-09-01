/* Serve dist/ the way Firebase Hosting will: cross-origin isolation on the
 * rig document (/play) ONLY — the landing and /signin.html stay un-isolated
 * so cross-origin scripts (gstatic firebase) and the auth helper iframe keep
 * working. No deps; `npm run serve`, then http://localhost:8790. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json', '.webp': 'image/webp',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg',
  '.nam': 'application/json', '.txt': 'text/plain', '.mp4': 'video/mp4',
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
  try {
    let body;
    try { body = await readFile(file); }
    catch { body = await readFile(join(dist, path, 'index.html')); path += '/index.html'; }
    if (/^\/play(\/|\/index\.html)?$/.test(new URL(req.url, 'http://x').pathname)) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    try {
      const nf = await readFile(join(dist, '404.html'));
      res.writeHead(404, { 'Content-Type': 'text/html' }).end(nf);
    } catch { res.writeHead(404).end('not found'); }
  }
}).listen(8790, () => console.log('one site on http://localhost:8790 — landing at /, rig at /play/'));
