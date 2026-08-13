/* ══════════════════════════════════════════════════════════════
   The rig's metrics — one `rig_sessions` document per visit to /play.

   WHY A SEPARATE MODULE FROM js/analytics.js.
   That file is the landing site's, loaded as a classic module from the page
   and pulling the Firebase SDK off gstatic. The rig is a different animal:
   it runs cross-origin-isolated (COEP require-corp for the pthreads wasm),
   where every cross-origin subresource has to satisfy CORP/CORS — so the
   fewer CDN imports inside /play, the fewer ways the audio engine's page can
   fail to load. This module therefore talks to the Firestore REST endpoint
   with plain fetch and imports nothing.

   It deliberately reuses the SAME envelope, the same session id key and the
   same keepalive transport, so a rig row sits beside a pageview row in the
   aggregator with no special cases. Envelope shape is pinned by
   firestore.rules envelopeOk(); change one, change both.

   ONE DOCUMENT PER SESSION, NOT ONE PER EVENT.
   A rig session is long and chatty — amps get switched, presets loaded,
   audio runs for minutes. Writing an event per action would cost a document
   per click and tell us little. Instead the session is accumulated in memory
   and flushed as a single row: what was used, and for how long. That keeps
   the cost of the flagship page at ~1 write per visitor.

   Cookieless and IP-free, exactly like the site: the session id lives in
   sessionStorage and dies with the tab, and no geo lookup happens here (the
   landing page already resolves it for the same visitor when they arrive
   through it). Never throws into the page — a failed metric must never take
   the audio engine down with it.
   ══════════════════════════════════════════════════════════════ */

const PROJECT = 'remidsp-98208';
const API_KEY = 'AIzaSyCc5q1QVR5KlV3khzwCryrO0ScB6P-D1xY';
const DOC = `projects/${PROJECT}/databases/(default)/documents`;
const COMMIT = `https://firestore.googleapis.com/v1/${DOC}:commit?key=${API_KEY}`;
const SCHEMA = 2; // must match js/analytics.js + firestore.rules

const cap = (s: unknown, n: number) => (s == null ? null : String(s).slice(0, n));
const nz = (s: unknown) => (s === '' || s == null ? null : s);

function sessionId(): string {
  try {
    let s = sessionStorage.getItem('remi_sid');
    if (!s) {
      s = 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      sessionStorage.setItem('remi_sid', s);
    }
    return s;
  } catch { return 's_nostorage'; }
}

function autoId(): string {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 20; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

/* Firestore REST value encoding. Mirrors enc() in js/analytics.js. */
function enc(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as object)) fields[k] = enc(x);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function envelope() {
  const s = screen || ({} as Screen);
  const q = new URLSearchParams(location.search);
  const g = (k: string) => cap(nz(q.get(k)), 120);
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string; mobile?: boolean };
  };
  return {
    schema: SCHEMA,
    clientTs: new Date().toISOString(),
    session: sessionId(),
    product: 'rig',
    page: {
      path: cap(location.pathname, 300),
      title: cap(document.title, 200),
      referrer: cap(nz(document.referrer), 300),
      host: cap(location.hostname, 120),
    },
    utm: {
      source: g('utm_source'), medium: g('utm_medium'), campaign: g('utm_campaign'),
      term: g('utm_term'), content: g('utm_content'),
    },
    device: {
      ua: cap(navigator.userAgent, 400),
      lang: cap(nz(navigator.language), 20),
      platform: cap(nz(nav.userAgentData?.platform || navigator.platform), 60),
      mobile: !!(nav.userAgentData?.mobile ?? matchMedia('(pointer:coarse)').matches),
      tz: cap(nz(Intl.DateTimeFormat().resolvedOptions().timeZone), 60),
      screenW: s.width ?? null, screenH: s.height ?? null,
      dpr: devicePixelRatio ?? null,
      viewW: innerWidth ?? null, viewH: innerHeight ?? null,
    },
    // The rig does no geo lookup of its own — see the header note.
    geo: { country: null, countryName: null, region: null, city: null,
           tz: null, lat: null, lon: null },
  };
}

/* ── the session accumulator ──────────────────────────────────
   Everything the rig learns about this visit, flushed once. */
const state = {
  booted: false,
  bootSource: null as string | null,   // engine BootSource: 'mic' (LISTEN FIRST) | 'di' (PLUG IN)
  isolated: false,                     // did cross-origin isolation succeed
  sampleRate: null as number | null,
  audioMs: 0,                          // engine running AND making sound
  amps: new Set<string>(),
  voices: new Set<string>(),
  presetLoads: 0,
  captureLoads: 0,                     // TONE3000 / custom captures
  t3kOpened: false,
  looperUsed: false,
  signedIn: false,
  demoSec: 0,      // seconds of the demo track actually heard
  demoLoops: 0,    // whole playthroughs of it
  sent: false,
};

let audioSince: number | null = null;

/** The engine started producing audio. */
export function audioStarted() {
  if (audioSince === null) audioSince = performance.now();
}

/** The engine stopped (paused, suspended, tab hidden). */
export function audioStopped() {
  if (audioSince !== null) {
    state.audioMs += performance.now() - audioSince;
    audioSince = null;
  }
}

export function rigBooted(source: string, sampleRate: number | null) {
  state.booted = true;
  state.bootSource = source;
  state.sampleRate = sampleRate;
  state.isolated = !!(window as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  audioStarted();
}

export function noteAmp(amp: string, voice: string) {
  if (amp) state.amps.add(amp);
  if (voice) state.voices.add(voice);
}
export function notePresetLoad() { state.presetLoads++; }
export function noteCaptureLoad() { state.captureLoads++; }
export function noteT3kOpened() { state.t3kOpened = true; }
export function noteLooperUsed() { state.looperUsed = true; }
export function noteSignedIn(on: boolean) { state.signedIn = on; }
/** Demo-track listening, read off the engine at flush time. */
export function noteDemo(seconds: number, loops: number) {
  state.demoSec = Math.max(state.demoSec, Math.round(seconds));
  state.demoLoops = Math.max(state.demoLoops, Math.round(loops * 10) / 10);
}

/* ── the flush ────────────────────────────────────────────────
   keepalive so the browser finishes the POST after the tab is gone; `ts`
   comes from the server transform so rules can pin it to request.time. */
/* The page registers this so the flush can read the engine's live totals
   at the last possible moment, without this module importing the engine. */
let demoProvider: (() => { seconds: number; loops: number }) | null = null;
export function provideDemoStats(fn: () => { seconds: number; loops: number }) {
  demoProvider = fn;
}

function flush() {
  if (state.sent) return;
  try {
    if (demoProvider) { const d = demoProvider(); noteDemo(d.seconds, d.loops); }
  } catch { /* metrics never break the page */ }
  // A visitor who opened /play and never started the engine is still worth
  // counting — that IS the gate→play conversion denominator.
  state.sent = true;
  audioStopped();

  const data = {
    ...envelope(),
    booted: state.booted,
    bootSource: state.bootSource,
    isolated: state.isolated,
    sampleRate: state.sampleRate,
    audioSec: Math.round(state.audioMs / 1000),
    amps: [...state.amps].slice(0, 10),
    voices: [...state.voices].slice(0, 20),
    presetLoads: state.presetLoads,
    captureLoads: state.captureLoads,
    t3kOpened: state.t3kOpened,
    looperUsed: state.looperUsed,
    signedIn: state.signedIn,
    demoSec: state.demoSec,
    demoLoops: state.demoLoops,
  };

  let body: string;
  try {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) fields[k] = enc(v);
    body = JSON.stringify({
      writes: [{
        update: { name: `${DOC}/rig_sessions/${autoId()}`, fields },
        updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }],
        currentDocument: { exists: false },
      }],
    });
  } catch { return; }

  try {
    fetch(COMMIT, {
      method: 'POST', body, keepalive: true,
      headers: { 'content-type': 'application/json' },
    }).catch(() => {});
  } catch {
    try { navigator.sendBeacon?.(COMMIT, new Blob([body], { type: 'application/json' })); } catch {}
  }
}

/** Arm the flush. `pagehide` is the reliable one — `beforeunload` does not
 *  fire on mobile Safari, and `visibilitychange` alone fires on tab switches
 *  we do not want to end the session on. */
export function armRigMetrics() {
  addEventListener('pagehide', flush, { once: true });
  // Backstop: a tab hidden for good never fires pagehide on some platforms.
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { audioStopped(); }
    else { if (state.booted) audioStarted(); }
  });
}
