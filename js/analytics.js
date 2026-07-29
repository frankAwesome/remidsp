/* ══════════════════════════════════════════════════════════════
   REMI DSP — metrics

   Four Firestore collections, one per event kind:
     pageviews · downloads · clicks · engagement

   Every document shares the same envelope (see envelope()), so a new
   product is a new `product` value — never a new collection or a schema
   change. Downloads self-instrument off the href, so shipping the next
   plugin needs no code here at all: link to its installer and it counts.

   Deliberately cookieless and IP-free. There is no persistent visitor id
   (session id lives in sessionStorage and dies with the tab) and the raw IP
   is never stored — only the coarse geo derived from it, rounded to a tenth
   of a degree (~11 km, no finer than the city name beside it). That is what
   keeps the site out of consent-banner territory; see ANALYTICS.md before
   adding any durable identifier, because it changes the legal position.

   TRANSPORT — why this is not the Firestore SDK.
   A download click navigates the tab to the installer immediately, which
   tears down the page's network stack. The SDK's addDoc() is a WebChannel
   round-trip with no unload guarantee, so a share of real downloads were
   simply never recorded — the one number that most needs to be right.
   Instead every event is one POST to the Firestore REST :commit endpoint
   with `keepalive: true`, which the browser is obliged to finish even after
   the page is gone. Same rules, same collections, same envelope; the write
   is just no longer racing the navigation. `ts` is set by a REQUEST_TIME
   transform, so firestore.rules can still pin it to request.time and a
   client still cannot backdate an event.

   Never throws into the page: a failed metric must never break the site.
   ══════════════════════════════════════════════════════════════ */
import { initializeApp }
  from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAnalytics, logEvent, setConsent }
  from "https://www.gstatic.com/firebasejs/12.16.0/firebase-analytics.js";
import { initializeAppCheck, ReCaptchaV3Provider, getToken }
  from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app-check.js";

/* ── config ─────────────────────────────────────────────────────
   Firebase web config is public by design — it identifies the project, it
   does not authorise anything. Access is controlled by firestore.rules and
   App Check, not by hiding these values. */
const firebaseConfig = {
  apiKey: "AIzaSyCc5q1QVR5KlV3khzwCryrO0ScB6P-D1xY",
  authDomain: "remidsp-98208.firebaseapp.com",
  projectId: "remidsp-98208",
  storageBucket: "remidsp-98208.firebasestorage.app",
  messagingSenderId: "5196542133",
  appId: "1:5196542133:web:4e67b8c7c9d27c8222cefc",
  measurementId: "G-17B3ZSVKY0",
};

/* reCAPTCHA v3 site key for App Check. Empty = App Check off, writes still
   work (until you switch Firestore to *enforced* in the console, which is the
   point of the whole exercise). See ANALYTICS.md step 3. */
const APPCHECK_SITE_KEY = "";

const SCHEMA   = 2;                // bump when the envelope shape changes
const GEO_TTL  = 30 * 60 * 1000;   // re-resolve geo at most twice an hour
const GEO_WAIT = 2000;             // longest the pageview waits on the geo lookup

const COMMIT = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}`
             + `/databases/(default)/documents:commit?key=${firebaseConfig.apiKey}`;
const DOC = `projects/${firebaseConfig.projectId}/databases/(default)/documents`;

/* ── plumbing ───────────────────────────────────────────────── */
const app = initializeApp(firebaseConfig);

let appCheck = null;
if (APPCHECK_SITE_KEY) {
  try {
    appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(APPCHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (e) { /* never let App Check setup break the page */ }
}

/* GA4 runs alongside Firestore for the free realtime/funnel dashboards, but
   cookieless: analytics_storage denied means no persistent _ga client id, which
   is the piece that would otherwise demand a consent banner. Firestore below is
   the source of truth for anything you actually want to query. */
let ga = null;
try {
  setConsent({ analytics_storage: "denied", ad_storage: "denied",
               ad_user_data: "denied", ad_personalization: "denied" });
  ga = getAnalytics(app);
} catch (e) { ga = null; }

/* ── helpers ────────────────────────────────────────────────── */
const nz = v => (v === undefined || v === null || v === "" ? null : v);
const cap = (s, n) => (typeof s === "string" ? s.slice(0, n) : null);
const clamp01 = n => Math.min(1, Math.max(0, n));

/* Coarse enough to be a dot on a map and nothing more. One decimal place is
   ~11 km — a city, not a street, matching the city name we already keep. */
const coarse = n => (typeof n === "number" && isFinite(n) ? Math.round(n * 10) / 10 : null);

/* The document id the SDK used to mint for us. 20 chars of the same alphabet,
   so ids stay indistinguishable from every row written before this change. */
const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function autoId() {
  const bytes = new Uint8Array(20);
  try { crypto.getRandomValues(bytes); }
  catch { for (let i = 0; i < 20; i++) bytes[i] = Math.floor(Math.random() * 256); }
  let out = "";
  for (const b of bytes) out += ID_CHARS[b % ID_CHARS.length];
  return out;
}

/* Plain JS → Firestore's typed JSON. The inverse of decode() in the exporter. */
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string")  return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    if (!isFinite(v)) return { nullValue: null };
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === "object") {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = enc(v[k]);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

/* Session-scoped, not persistent: dies with the tab, so it can group one
   visit's events without becoming a durable identifier for a person. */
function sessionId() {
  try {
    let s = sessionStorage.getItem("remi_sid");
    if (!s) {
      s = "s_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      sessionStorage.setItem("remi_sid", s);
    }
    return s;
  } catch { return "s_nostorage"; }
}

/* Coarse geo only. We ask an IP-geo service where the visitor is and keep the
   answer; we never keep the address it looked it up by. Cached per session so a
   visit costs one request no matter how many events it fires. Two providers
   because a single free endpoint will rate-limit (ipapi.co already 429s).

   `geoNow` mirrors the resolved value synchronously — the unload path cannot
   await anything, so it reads this rather than the promise. */
const GEO_NULL = { country: null, countryName: null, region: null, city: null,
                   tz: null, lat: null, lon: null };
let geoNow = null;
let geoPromise = null;

async function geo() {
  if (geoNow) return geoNow;
  try {
    const hit = JSON.parse(sessionStorage.getItem("remi_geo") || "null");
    // Spread over GEO_NULL: a cache written by schema 1 has no lat/lon, and
    // the shape must not change between the first event and the rest.
    if (hit && Date.now() - hit.at < GEO_TTL) return (geoNow = { ...GEO_NULL, ...hit.geo });
  } catch { /* fall through and re-resolve */ }

  if (!geoPromise) {
    geoPromise = (async () => {
      const sources = [
        ["https://ipwho.is/", d => ({
          country: nz(d.country_code), countryName: nz(d.country),
          region: nz(d.region), city: nz(d.city), tz: nz(d.timezone?.id || d.timezone),
          lat: coarse(d.latitude), lon: coarse(d.longitude),
        })],
        ["https://get.geojs.io/v1/ip/geo.json", d => ({
          country: nz(d.country_code), countryName: nz(d.country),
          region: nz(d.region), city: nz(d.city), tz: nz(d.timezone),
          lat: coarse(parseFloat(d.latitude)), lon: coarse(parseFloat(d.longitude)),
        })],
      ];
      for (const [url, map] of sources) {
        try {
          const ctl = AbortSignal.timeout ? AbortSignal.timeout(3500) : undefined;
          const r = await fetch(url, { signal: ctl, cache: "no-store" });
          if (!r.ok) continue;
          const g = map(await r.json());
          if (!g.country) continue;
          try { sessionStorage.setItem("remi_geo", JSON.stringify({ at: Date.now(), geo: g })); } catch {}
          return (geoNow = g);
        } catch { /* try the next provider */ }
      }
      return (geoNow = { ...GEO_NULL });
    })();
  }
  return geoPromise;
}

function utm(q = new URLSearchParams(location.search)) {
  const g = k => cap(nz(q.get(k)), 120);
  return { source: g("utm_source"), medium: g("utm_medium"), campaign: g("utm_campaign"),
           term: g("utm_term"), content: g("utm_content") };
}

/* Which product an event belongs to. Link-level data-product wins, else the
   page-level one on <body>, else null for site-wide events. This is the whole
   future-proofing story: a new plugin sets data-product and everything else —
   collections, rules, queries, this file — stays exactly as it is. */
function productOf(el) {
  return cap(nz(el?.closest?.("[data-product]")?.dataset.product)
          ?? nz(document.body.dataset.product), 40);
}

/* Synchronous: safe to call from a pagehide handler, where there is no time
   left to await anything. Uses whatever geo has already resolved. */
function envelope(el) {
  const s = screen || {};
  return {
    schema: SCHEMA,
    clientTs: new Date().toISOString(),         // for clock-skew forensics
    session: sessionId(),
    product: productOf(el),
    page: {
      path: cap(location.pathname, 300),
      title: cap(document.title, 200),
      referrer: cap(nz(document.referrer), 300),
      host: cap(location.hostname, 120),
    },
    utm: utm(),
    device: {
      ua: cap(navigator.userAgent, 400),
      lang: cap(nz(navigator.language), 20),
      platform: cap(nz(navigator.userAgentData?.platform || navigator.platform), 60),
      mobile: !!(navigator.userAgentData?.mobile ?? matchMedia("(pointer:coarse)").matches),
      tz: cap(nz(Intl.DateTimeFormat().resolvedOptions().timeZone), 60),
      screenW: s.width ?? null, screenH: s.height ?? null,
      dpr: devicePixelRatio ?? null,
      viewW: innerWidth ?? null, viewH: innerHeight ?? null,
    },
    geo: geoNow || { ...GEO_NULL },              // country/city/latlon — never the IP
  };
}

/* One POST, `keepalive` so the browser finishes it even if the tab is already
   navigating to the installer. `ts` comes from the server via the transform,
   so the client never supplies it and firestore.rules can pin it. */
function commit(col, data, el) {
  /* `update.fields` is the bare field map, NOT a wrapped mapValue — encode the
     top level key by key. Wrapping it produces a 400 that firestore.rules never
     even sees, which looks exactly like "analytics is fine, traffic is zero". */
  const all = { ...envelope(el), ...data };
  const fields = {};
  for (const k of Object.keys(all)) fields[k] = enc(all[k]);

  const body = JSON.stringify({
    writes: [{
      update: {
        name: `${DOC}/${col}/${autoId()}`,
        fields,
      },
      updateTransforms: [{ fieldPath: "ts", setToServerValue: "REQUEST_TIME" }],
      currentDocument: { exists: false },
    }],
  });
  return { body, headers: { "content-type": "application/json" } };
}

async function send(col, data, el) {
  let req;
  try { req = commit(col, data, el); }
  catch (e) {                                    // never let a metric throw
    if (location.hostname === "localhost") console.warn("[metrics] encode", col, e);
    return;
  }

  if (appCheck) {
    try { req.headers["X-Firebase-AppCheck"] = (await getToken(appCheck)).token; } catch {}
  }
  try {
    const r = await fetch(COMMIT, { method: "POST", body: req.body,
                                    headers: req.headers, keepalive: true });
    if (!r.ok && location.hostname === "localhost") {
      console.warn("[metrics]", col, r.status, (await r.text()).slice(0, 200));
    }
  } catch (e) {
    /* Last resort: keepalive fetch refused (rare — some browsers cap the
       in-flight keepalive budget at 64 KB). A Blob carries the content-type
       that sendBeacon would otherwise strip. */
    try {
      navigator.sendBeacon?.(COMMIT, new Blob([req.body], { type: "application/json" }));
    } catch {}
    if (location.hostname === "localhost") console.warn("[metrics]", col, e?.message || e);
  }
}

/* ── public API ─────────────────────────────────────────────── */
export const track = {
  pageview: (extra = {}) => send("pageviews", { ...extra }),
  download: (d, el) => send("downloads", d, el),
  click:    (c, el) => send("clicks", c, el),
};

/* ── auto-instrumentation ───────────────────────────────────── */

/* What counts as a download, by href alone — so a future product's installer is
   tracked the moment it is linked, with no change here. */
const DL_RE = /\/releases\/.*\/download\/|\.(pkg|dmg|exe|msi|zip|tar\.gz)(\?|$)/i;
const osOf = href => /macos|\.pkg|\.dmg/i.test(href) ? "macos"
                   : /windows|win|\.exe|\.msi/i.test(href) ? "windows"
                   : /linux|\.tar\.gz/i.test(href) ? "linux" : "unknown";

/* Where in the page the visitor clicked — explicit data-placement wins,
   otherwise infer from the nearest landmark section. */
function placementOf(a) {
  const p = nz(a.dataset.placement);
  if (p) return cap(p, 40);
  const sec = a.closest("footer,.showcase,.download,.hero,.nav,.rig,section[id]");
  if (!sec) return null;
  return cap(sec.tagName === "FOOTER" ? "footer"
           : nz(sec.id) || nz(sec.className.split(" ")[0]) || null, 40);
}

let clickCount = 0;

function onClick(e) {
  const a = e.target.closest("a[href], button[data-track]");
  if (!a) return;
  const href = a.getAttribute("href") || "";
  const abs  = a.href || "";
  const label = cap(a.dataset.label || a.textContent.trim().replace(/\s+/g, " "), 120);
  const placement = placementOf(a);
  clickCount++;

  if (DL_RE.test(abs)) {
    const asset = cap(abs.split("/").pop().split("?")[0], 120);
    track.download({ asset, os: osOf(abs), url: cap(abs, 400), label, placement,
                     channel: /github\.com/i.test(abs) ? "github-releases" : "direct" }, a);
    if (ga) try { logEvent(ga, "file_download", { file_name: asset, link_url: abs, product: productOf(a) }); } catch {}
    return;                                    // a download is not also a click
  }

  const external = abs && !abs.startsWith(location.origin) && /^https?:/i.test(abs);
  track.click({ label, href: cap(abs || href, 400), placement,
                kind: external ? "outbound" : href.startsWith("#") ? "anchor" : "internal" }, a);
  if (ga) try { logEvent(ga, "select_content", { content_type: "link", item_id: label }); } catch {}
}

/* ── engagement ─────────────────────────────────────────────────
   A pageview says someone arrived; it cannot say whether they read anything.
   One summary row per visit, written on the way out: how long the page was
   actually in front of them (hidden time does not count), how far down they
   got, and the last section they reached. Together with the download rate
   this is what distinguishes a real visit from a bounce.

   Layout is read once per animation frame, never per scroll event — the site's
   scroll budget is spent on content, not on metrics. */

let maxScroll = 0;
let deepest = null;
let visibleMs = 0;
let since = document.visibilityState === "visible" ? performance.now() : null;
let queued = false;
let sections = [];

function measure() {
  queued = false;
  const doc = document.documentElement;
  const height = doc.scrollHeight;

  /* A backgrounded or never-painted tab reports 0 for both the viewport and the
     document. Treating that as "scrolled to the end" would score every prerender
     and every hidden tab as a complete read, so an unmeasurable page is left
     alone rather than guessed at. */
  if (!height || !innerHeight) return;

  const span = height - innerHeight;
  maxScroll = Math.max(maxScroll, span > 0 ? clamp01(scrollY / span) : 1);

  /* Lowest section whose top has passed the middle of the viewport. Measured
     here rather than from a list sorted at DOMContentLoaded: at that point the
     hero image has not laid out and every offsetTop is still 0, so a sorted
     list would be in arbitrary order and name the wrong section for the
     whole visit. */
  const mid = scrollY + innerHeight / 2;
  let best = -1;
  for (const s of sections) {
    const top = s.offsetTop;
    if (top <= mid && top >= best) { best = top; deepest = s.id; }
  }
}

function onScroll() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(measure);
}

function onVisibility() {
  if (document.visibilityState === "visible") {
    since = performance.now();
  } else if (since !== null) {
    visibleMs += performance.now() - since;
    since = null;
    flush();                        // mobile often never fires pagehide
  }
}

let flushed = false;
function flush() {
  if (flushed) return;
  flushed = true;
  if (since !== null) { visibleMs += performance.now() - since; since = null; }
  measure();
  send("engagement", {
    dwellMs: Math.round(visibleMs),
    maxScroll: Math.round(maxScroll * 100) / 100,
    clicks: clickCount,
    section: cap(deepest, 60),
  });
}

function start() {
  sections = [...document.querySelectorAll("section[id]")];

  /* Wait for geo so the pageview carries it — but never longer than GEO_WAIT.
     A third-party lookup that hangs must not hold the pageview hostage: a
     visitor who leaves at four seconds is exactly the visitor whose bounce we
     most want on record. Late geo still reaches every later event via geoNow. */
  Promise.race([geo(), new Promise(r => setTimeout(r, GEO_WAIT))]).then(() => {
    track.pageview({
      loadMs: Math.round(performance.getEntriesByType("navigation")[0]?.duration ?? performance.now()),
      entry: !document.referrer || !document.referrer.includes(location.hostname),
    });
  });
  if (ga) try { logEvent(ga, "page_view", { page_path: location.pathname, product: productOf(null) }); } catch {}

  // capture phase: still counts if something downstream stops propagation
  addEventListener("click", onClick, { capture: true, passive: true });
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("visibilitychange", onVisibility);
  addEventListener("pagehide", flush);
}

if (document.readyState === "loading") addEventListener("DOMContentLoaded", start, { once: true });
else start();
