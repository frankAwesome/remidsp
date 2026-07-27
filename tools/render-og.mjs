#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════
   REMI DSP — link-preview card renderer

   Screenshots tools/og-card.html at exactly 1200x630 and writes
   assets/img/og-card-portland.jpg — the image Slack, iMessage,
   WhatsApp, X and Facebook show when remidsp.com is pasted.

   Served over HTTP rather than opened as file://, so @font-face
   and the .webp amp render load without CORS grief.

   Usage
   -----
     node tools/render-og.mjs

   Requires: Google Chrome (or any Chrome-family browser) and the
   macOS `sips` for the PNG -> JPG step. Nothing to npm install.

   After re-rendering, bump the ?v= on the og:image URLs in
   index.html — Slack, X and Facebook cache scraped cards hard and
   will keep serving the old picture otherwise.
   ══════════════════════════════════════════════════════════════ */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'tools/og-card.html';
const OUT  = path.join(ROOT, 'assets/img/og-card-portland.jpg');
const [W, H] = [1200, 630];

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find(p => existsSync(p));

if (!CHROME) {
  console.error('No Chrome-family browser found. Install Google Chrome and re-run.');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.webp': 'image/webp',
  '.ttf':  'font/ttf',
  '.svg':  'image/svg+xml',
};

/* Throwaway static server on the repo root. */
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const run = (cmd, args, wrote) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', d => { err += d; });
  p.on('close', code => {
    /* Headless Chrome can exit non-zero having written a perfectly good
       screenshot, so judge it on the file, not the code. */
    if (wrote ? existsSync(wrote) : code === 0) resolve();
    else reject(new Error(`${path.basename(cmd)} exited ${code}\n${err.split('\n').slice(-6).join('\n')}`));
  });
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const tmp = await mkdtemp(path.join(tmpdir(), 'remidsp-og-'));
const png = path.join(tmp, 'og.png');

try {
  await run(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    '--disable-lcd-text',                   // uniform AA — no colour fringing
    '--font-render-hinting=none',
    '--force-color-profile=srgb',
    `--window-size=${W},${H}`,
    '--virtual-time-budget=6000',           // let the fonts and the .webp land
    `--screenshot=${png}`,
    `http://127.0.0.1:${port}/${PAGE}`,
  ], png);

  /* PNG -> JPG. Quality 88 keeps it well under the 5 MB every scraper caps
     at while staying clean on the amp's tolex grain. */
  await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '88', png, '--out', OUT]);
  console.log(`wrote ${path.relative(ROOT, OUT)}  (${W}x${H})`);
} finally {
  server.close();
  await rm(tmp, { recursive: true, force: true });
}
