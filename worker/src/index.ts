/* The share surface.
 *
 * Serves the crawlable, unfurlable twin of every hash route in the app:
 *
 *   /t/<presetId>   a tone — real <title>, per-tone og:image, og:audio when a
 *                   take has been printed, and OPEN IN THE RIG
 *   /u/<handle>     a player
 *   /m/<key>        media out of R2, with the CORP header the rig requires
 *   /og/t/<id>.svg  the share image, drawn from the tone's own data
 *   /sitemap.xml
 *
 * NOT DEPLOYED. See wrangler.toml.
 *
 * On credentials: there are none, on purpose. firestore.rules already allows
 * an unauthenticated client to read shared presets and public profiles, which
 * is precisely the set of things that belong on a public share page. Reading
 * as nobody means this Worker cannot leak anything the feed does not already
 * show, and a bug here cannot become a data breach.
 */

export interface Env {
  FIREBASE_PROJECT_ID: string;
  RIG_ORIGIN: string;
  MEDIA?: R2Bucket;
}

/* ── Firestore REST, read-only and unauthenticated ─────────────────────── */

/** Firestore's REST shape wraps every value in a type tag. Unwrap to plain JS. */
function unwrap(v: any): any {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v.mapValue.fields ?? {})) out[k] = unwrap(val);
    return out;
  }
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(unwrap);
  return null;
}

async function getDoc(env: Env, path: string): Promise<Record<string, any> | null> {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}`
    + `/databases/(default)/documents/${path}`;
  const r = await fetch(url);
  if (!r.ok) return null;                 // 403 from the rules reads as "no"
  const doc: any = await r.json();
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(doc.fields ?? {})) out[k] = unwrap(v);
  return out;
}

/* ── html ──────────────────────────────────────────────────────────────── */

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Everything on a share page comes out of a document a stranger wrote, so
 *  every interpolation below is escaped without exception. */
function page(o: {
  title: string; description: string; canonical: string; image: string;
  audio?: string; body: string; openInRig: string;
}): Response {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(o.canonical)}">
<meta property="og:type" content="music.song">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(o.canonical)}">
<meta property="og:image" content="${esc(o.image)}">
${o.audio ? `<meta property="og:audio" content="${esc(o.audio)}">
<meta property="og:audio:type" content="audio/mpeg">` : ''}
<meta name="twitter:card" content="${o.audio ? 'player' : 'summary_large_image'}">
<meta name="twitter:title" content="${esc(o.title)}">
<meta name="twitter:description" content="${esc(o.description)}">
<meta name="twitter:image" content="${esc(o.image)}">
<style>
:root{color-scheme:dark}
body{margin:0;background:#000;color:#eef1f6;
  font:16px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;
  display:flex;flex-direction:column;align-items:center;padding:3rem 1.2rem;gap:1.4rem}
main{width:min(620px,100%);display:flex;flex-direction:column;gap:1.2rem}
h1{font-size:1.9rem;line-height:1.15;margin:0;letter-spacing:-.01em}
.by{color:#9aa0ab;font-size:.9rem;margin:0}
.desc{color:#c4c9d2;margin:0}
audio{width:100%}
.cta{display:block;text-align:center;text-decoration:none;background:#9fd8e8;color:#0a0d12;
  font-weight:700;letter-spacing:.18em;text-transform:uppercase;font-size:.8rem;
  padding:1rem 1.4rem;border-radius:2px}
.cta small{display:block;font-weight:500;letter-spacing:.1em;opacity:.7;font-size:.6rem;margin-top:.3rem}
.foot{color:#6b7280;font-size:.72rem;text-align:center}
.foot a{color:#9aa0ab}
</style>
</head><body><main>
${o.body}
<a class="cta" href="${esc(o.openInRig)}">Open in the rig<small>no install · no account</small></a>
<p class="foot">REMI DSP · Maine — a guitar rig that runs in a browser tab.
<a href="https://www.tone3000.com">Powered by TONE3000</a></p>
</main></body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Short edge cache: counters and comments move, the tone itself rarely.
      'cache-control': 'public, max-age=60, s-maxage=600',
    },
  });
}

function notFound(msg: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Not found</title>
    <body style="background:#000;color:#eef1f6;font:16px system-ui;padding:3rem">
    <p>${esc(msg)}</p><p><a style="color:#9fd8e8" href="/">REMI DSP · Maine</a></p>`,
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/* ── the OG image ──────────────────────────────────────────────────────────
 *
 * Drawn as SVG from the tone's own fields, in the feed card's visual language.
 * SVG rather than a rasteriser because every unfurler that matters renders it
 * and it costs no wasm bundle; if a scraper is found that will not take SVG,
 * this is the one place to add resvg. */

const AMP_ACCENT: Record<string, string> = {
  camden: '#8fd8cf', portland: '#e9b765', katahdin: '#c25a52',
};

function ogSvg(p: Record<string, any>): Response {
  const accent = p.capture?.source === 'tone3000' ? '#9fd8e8' : (AMP_ACCENT[p.amp] ?? '#9fd8e8');
  const name = String(p.name ?? 'a rig');
  // Wrap by eye: the display face is wide, so ~22 characters a line holds.
  const words = name.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > 22) { if (cur) lines.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  const title = lines.slice(0, 3);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#000"/>
  <rect x="0" y="0" width="10" height="630" fill="${esc(accent)}"/>
  <text x="72" y="112" fill="#6b7280" font-family="system-ui,sans-serif"
    font-size="24" letter-spacing="6">REMI DSP · MAINE</text>
  ${title.map((l, i) => `<text x="72" y="${232 + i * 78}" fill="#eef1f6"
    font-family="system-ui,sans-serif" font-size="70" font-weight="700">${esc(l)}</text>`).join('')}
  <text x="72" y="${252 + title.length * 78}" fill="${esc(accent)}"
    font-family="system-ui,sans-serif" font-size="32">by ${esc(p.username ?? 'a player')}</text>
  <text x="72" y="556" fill="#9aa0ab" font-family="system-ui,sans-serif" font-size="27">
    ${esc(String(p.capture?.label ?? p.amp ?? '').toUpperCase())}</text>
  <text x="72" y="592" fill="#6b7280" font-family="system-ui,sans-serif" font-size="23">
    Runs in a browser tab · no install</text>
</svg>`;
  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=3600, s-maxage=86400',
      // The rig may draw this too, and it is COEP: require-corp.
      'cross-origin-resource-policy': 'cross-origin',
    },
  });
}

/* ── routes ────────────────────────────────────────────────────────────── */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const seg = url.pathname.split('/').filter(Boolean);

    // Media out of R2. THE CORP HEADER IS THE ENTIRE POINT OF THIS ROUTE:
    // without it a printed take plays perfectly on this page and is silently
    // blocked inside the rig, which is the most confusing failure available
    // in this architecture.
    if (seg[0] === 'm' && seg[1]) {
      if (!env.MEDIA) return new Response('media bucket not bound', { status: 503 });
      const key = seg.slice(1).join('/');
      const obj = await env.MEDIA.get(key);
      if (!obj) return new Response('not found', { status: 404 });
      const h = new Headers();
      obj.writeHttpMetadata(h);
      h.set('etag', obj.httpEtag);
      h.set('cache-control', 'public, max-age=31536000, immutable');
      h.set('cross-origin-resource-policy', 'cross-origin');
      h.set('access-control-allow-origin', '*');
      return new Response(obj.body, { headers: h });
    }

    if (seg[0] === 'og' && seg[1] === 't' && seg[2]) {
      const id = seg[2].replace(/\.svg$/, '');
      const p = await getDoc(env, `presets/${id}`);
      if (!p || p.shared !== true) return new Response('not found', { status: 404 });
      return ogSvg(p);
    }

    if (seg[0] === 't' && seg[1]) {
      const id = seg[1];
      const p = await getDoc(env, `presets/${id}`);
      // A private or deleted tone is a 404 here, exactly as the rules make it
      // a null in the app. Never explain which.
      if (!p || p.shared !== true) return notFound('That tone is not on the feed any more.');

      const title = `${p.name} — a guitar rig by ${p.username}`;
      const desc = String(p.description || '').trim()
        || `A rig on ${p.capture?.label ?? p.amp}. Open it in your browser and play it — `
           + `nothing to install.`;
      const take = p.previewUrl ? String(p.previewUrl) : undefined;

      return page({
        title,
        description: desc,
        canonical: `${url.origin}/t/${encodeURIComponent(id)}`,
        image: `${url.origin}/og/t/${encodeURIComponent(id)}.svg`,
        audio: take,
        openInRig: `${env.RIG_ORIGIN}/#/t/${encodeURIComponent(id)}`,
        body: `<h1>${esc(p.name)}</h1>
          <p class="by">by ${esc(p.username)} · ${esc(String(p.capture?.label ?? p.amp ?? '').toUpperCase())}</p>
          ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
          ${take ? `<audio controls preload="none" src="${esc(take)}"></audio>`
                 : `<p class="foot">No printed take on this one yet — open it in the rig to hear it.</p>`}`,
      });
    }

    if (seg[0] === 'u' && seg[1]) {
      const handle = seg[1].toLowerCase();
      const claim = await getDoc(env, `usernames/${encodeURIComponent(handle)}`);
      if (!claim?.uid) return notFound(`No player called @${handle}.`);
      const prof = await getDoc(env, `profiles/${claim.uid}`);
      if (!prof || prof.isPublic === false) return notFound(`@${handle} keeps their profile private.`);
      return page({
        title: `${prof.username} — rigs on REMI DSP Maine`,
        description: String(prof.bio || '').trim()
          || `${prof.username} shares guitar rigs you can play in a browser tab.`,
        canonical: `${url.origin}/u/${encodeURIComponent(handle)}`,
        image: `${url.origin}/og/u/${encodeURIComponent(handle)}.svg`,
        openInRig: `${env.RIG_ORIGIN}/#/u/${encodeURIComponent(handle)}`,
        body: `<h1>${esc(prof.username)}</h1>
          ${prof.bio ? `<p class="desc">${esc(prof.bio)}</p>` : ''}
          <p class="by">${esc(prof.followersCount ?? 0)} followers</p>`,
      });
    }

    if (url.pathname === '/robots.txt') {
      return new Response(`User-agent: *\nAllow: /\nSitemap: ${url.origin}/sitemap.xml\n`,
        { headers: { 'content-type': 'text/plain' } });
    }

    // Anything else belongs to the app.
    return Response.redirect(env.RIG_ORIGIN, 302);
  },
};
