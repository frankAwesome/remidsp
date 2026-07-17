# Metrics

Three Firestore collections — `pageviews`, `downloads`, `clicks` — written
straight from the browser. Cookieless and IP-free by design.

**Nothing is recorded until you do the two console steps below.** Firestore is
not yet enabled on the project, so every write currently fails (silently, by
design — a metric must never break the page).

---

## What you have to do

### 1. Enable Firestore  ← required, nothing works without it

<https://console.firebase.google.com/project/remidsp-98208/firestore> → **Create
database** → **Production mode** (rules below replace the default) → pick a
region near your users and *note it down*: **the region is permanent.**

### 2. Publish the rules  ← required, the default rules block every write

Either paste `firestore.rules` into the console (Firestore → Rules → Publish),
or:

```bash
npm i -g firebase-tools && firebase login
firebase deploy --only firestore:rules,firestore:indexes
```

`.firebaserc` already points at `remidsp-98208`.

### 3. Turn on App Check  ← recommended; this is the bill guard

These collections accept unauthenticated writes. That is unavoidable for
client-side analytics — and it means anyone who reads the page source can script
writes against your quota. The rules cap shape and size, which stops casual
abuse but not a determined script.

1. Get a **reCAPTCHA v3** site key: <https://www.google.com/recaptcha/admin/create>
   (type: reCAPTCHA v3, domain: `frankawesome.github.io`)
2. Firebase console → **App Check** → register the web app with that key
3. Put the key in `js/analytics.js`:
   ```js
   const APPCHECK_SITE_KEY = "6Lc...";   // empty = App Check off
   ```
4. Once real traffic shows tokens arriving: App Check → Firestore → **Enforce**

Leaving the key empty is safe — App Check simply stays off. Don't set
*Enforce* before step 3 or you will block your own site.

### 4. Set a budget alert  ← 2 minutes, saves a bad surprise

<https://console.cloud.google.com/billing/budgets> — the free Spark tier caps
writes at 20k/day and simply stops, so you cannot actually be billed until you
upgrade to Blaze. If you ever do upgrade, set this first.

---

## Privacy position — read before changing anything

The site currently needs **no consent banner**, and that is a deliberate,
fragile property:

- **No cookies.** Verified: `document.cookie` is empty, `localStorage` is empty.
- **No persistent identifier.** The session id lives in `sessionStorage` and
  dies with the tab. It groups one visit; it cannot follow a person.
- **No IP.** Coarse geo (country/region/city) is derived from the IP by the
  lookup provider, and only the geo is kept. `firestore.rules` *rejects* any
  document containing an `ip` field, so this cannot be undone by accident.
- **GA4 runs cookieless.** `setConsent({analytics_storage:'denied'})` before
  `getAnalytics()` means no `_ga` client id. You lose reliable unique-user
  counts in GA4 — Firestore is the source of truth for anything you query.

Add a persistent id, or store an IP, and you are processing personal data:
that needs a consent banner in the EU/UK and a privacy policy. Don't do it
casually.

> Not legal advice. If you start selling into the EU, get this reviewed.

---

## Adding the next product

Nothing in `js/analytics.js` changes. Two options:

```html
<!-- whole page belongs to a product -->
<body data-product="doppel">

<!-- or one section of a shared page -->
<section data-product="doppel"> ... </section>
```

Downloads self-instrument off the href — any link matching
`/releases/**/download/` or ending `.pkg .dmg .exe .msi .zip .tar.gz` is
counted, with the OS inferred. Link the installer and it counts.

Link-level `data-product` beats page-level. `data-placement="footer"` overrides
the inferred placement; `data-label` overrides the link text.

The home page's `<body>` is deliberately **untagged** so a home visit is a
site-wide pageview, not a Maine one.

---

## Schema

Every document in all three collections shares this envelope:

| field | example | note |
|---|---|---|
| `schema` | `1` | bump via `SCHEMA` in analytics.js |
| `ts` | server timestamp | rules pin it to `request.time` — unforgeable |
| `clientTs` | `2026-07-17T…` | client clock, for skew forensics |
| `session` | `s_w862fvi3…` | sessionStorage; dies with the tab |
| `product` | `"maine"` / `null` | `null` = site-wide |
| `page` | `{path,title,referrer,host}` | |
| `utm` | `{source,medium,campaign,term,content}` | |
| `device` | `{ua,lang,platform,mobile,tz,screenW,screenH,dpr,viewW,viewH}` | |
| `geo` | `{country,countryName,region,city,tz}` | never an IP |

Per collection:

- **`downloads`** — `asset`, `os` (`macos`/`windows`/`linux`), `url`, `label`,
  `placement`, `channel`
- **`clicks`** — `label`, `href`, `placement`, `kind`
  (`outbound`/`anchor`/`internal`)
- **`pageviews`** — `loadMs`, `entry` (true = arrived from off-site)

A download fires **only** a `downloads` row, never also a `clicks` row — so
`clicks` never double-counts them.

---

## Querying

Reads are blocked from the browser on purpose. Use the console, or the Admin
SDK from a trusted machine:

```js
// downloads per country, last 30 days
db.collection("downloads")
  .where("ts", ">", new Date(Date.now() - 30 * 864e5))
  .where("product", "==", "maine")
  .orderBy("ts", "desc")
```

Composite indexes for `product + ts` and `geo.country + ts` are in
`firestore.indexes.json`.

---

## Known limits

- **Ad blockers.** uBlock and friends block `firestore.googleapis.com` and
  `google-analytics.com`. Expect to undercount by roughly 10–30% on a
  developer/musician audience. Every provider has this problem; the numbers are
  a floor, not a census.
- **Geo depends on a third party.** `ipwho.is` with `get.geojs.io` as fallback
  (`ipapi.co` was rejected — it already rate-limits at 429). If both fail, geo
  fields are `null` and the event is still recorded.
- **Firestore free tier is 20k writes/day.** One visit is roughly 1 pageview +
  a few clicks. Fine at your traffic; revisit if you get a launch spike.
- **The Firebase config in `analytics.js` is public and that is correct.** Web
  config identifies the project, it does not authorise anything. Security comes
  from the rules and App Check, not from hiding it.
