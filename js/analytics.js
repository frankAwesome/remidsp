/* ══════════════════════════════════════════════════════════════
   REMI DSP — metrics

   Three Firestore collections, one per event kind:
     pageviews · downloads · clicks

   Every document shares the same envelope (see envelope()), so a new
   product is a new `product` value — never a new collection or a schema
   change. Downloads self-instrument off the href, so shipping the next
   plugin needs no code here at all: link to its installer and it counts.

   Deliberately cookieless and IP-free. There is no persistent visitor id
   (session id lives in sessionStorage and dies with the tab) and the raw IP
   is never stored — only the coarse geo derived from it. That is what keeps
   the site out of consent-banner territory; see ANALYTICS.md before adding
   any durable identifier, because it changes the legal position.

   The site is static on GitHub Pages, so this is a bundler-free ESM module
   loading Firebase from gstatic. Firebase's own console snippet
   (`import ... from "firebase/app"`) is bare-specifier and cannot run here.

   Never throws into the page: a failed metric must never break the site.
   ══════════════════════════════════════════════════════════════ */
import { initializeApp }
  from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import { getAnalytics, logEvent, setConsent }
  from "https://www.gstatic.com/firebasejs/12.15.0/firebase-analytics.js";
import { initializeAppCheck, ReCaptchaV3Provider }
  from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app-check.js";
import { getFirestore, collection, addDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

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

const SCHEMA  = 1;                 // bump when the envelope shape changes
const GEO_TTL = 30 * 60 * 1000;    // re-resolve geo at most twice an hour

/* ── plumbing ───────────────────────────────────────────────── */
const app = initializeApp(firebaseConfig);

if (APPCHECK_SITE_KEY) {
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(APPCHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (e) { /* never let App Check setup break the page */ }
}

const db = getFirestore(app);

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
   because a single free endpoint will rate-limit (ipapi.co already 429s). */
let geoPromise = null;
async function geo() {
  try {
    const hit = JSON.parse(sessionStorage.getItem("remi_geo") || "null");
    if (hit && Date.now() - hit.at < GEO_TTL) return hit.geo;
  } catch { /* fall through and re-resolve */ }

  if (!geoPromise) {
    geoPromise = (async () => {
      const sources = [
        ["https://ipwho.is/", d => ({
          country: nz(d.country_code), countryName: nz(d.country),
          region: nz(d.region), city: nz(d.city), tz: nz(d.timezone?.id || d.timezone),
        })],
        ["https://get.geojs.io/v1/ip/geo.json", d => ({
          country: nz(d.country_code), countryName: nz(d.country),
          region: nz(d.region), city: nz(d.city), tz: nz(d.timezone),
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
          return g;
        } catch { /* try the next provider */ }
      }
      return { country: null, countryName: null, region: null, city: null, tz: null };
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

async function envelope(el) {
  const s = screen || {};
  return {
    schema: SCHEMA,
    ts: serverTimestamp(),                      // server clock; rules pin it
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
    geo: await geo(),                            // country/region/city — never the IP
  };
}

/* Fire-and-forget. A metric is never worth an exception in front of a visitor,
   and never worth delaying a download. */
async function send(col, data, el) {
  try {
    await addDoc(collection(db, col), { ...(await envelope(el)), ...data });
  } catch (e) {
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

function onClick(e) {
  const a = e.target.closest("a[href], button[data-track]");
  if (!a) return;
  const href = a.getAttribute("href") || "";
  const abs  = a.href || "";
  const label = cap(a.dataset.label || a.textContent.trim().replace(/\s+/g, " "), 120);
  const placement = placementOf(a);

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

function start() {
  track.pageview({
    loadMs: Math.round(performance.getEntriesByType("navigation")[0]?.duration ?? performance.now()),
    entry: !document.referrer || !document.referrer.includes(location.hostname),
  });
  if (ga) try { logEvent(ga, "page_view", { page_path: location.pathname, product: productOf(null) }); } catch {}
  // capture phase: still counts if something downstream stops propagation
  addEventListener("click", onClick, { capture: true, passive: true });
}

if (document.readyState === "loading") addEventListener("DOMContentLoaded", start, { once: true });
else start();
