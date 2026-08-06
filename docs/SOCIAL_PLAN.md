# Same hands. Different rig.

The plan for REMI DSP Maine's social layer, and the reasoning behind it.

---

## 1. Where we actually are

The rig is finished. The social layer is a **silent, unlinkable preset exchange**, and
that is the one shape this market has already proved does not work.

Line 6 CustomTone, Fractal Axe-Change, Kemper Rig Exchange, IK ToneNET and Positive Grid
ToneCloud are all the same product: a file, a download counter, and a comment box. All of
them silted up. The diagnosed failure modes are consistent and worth naming, because we
are one decision away from repeating each of them:

- **Ratings rot.** Kemper's 5-star Crowd Rating is the best-documented own-goal in the
  category — thousands of rigs tied at five stars, taste-based downvoting, and commercial
  profilers leaving the platform over it. *We will never ship stars.*
- **Level wins, not tone.** ToneCloud's junk problem was diagnosed as presets "so quiet
  you can hardly hear them". In any A/B, the louder one wins. *We normalise at print.*
- **No sound, no share.** A preset is a number soup. Nothing about it travels.

What we have that none of them do: **the rig is executable in the viewer's tab.**

---

## 2. The bet

**Stop sharing presets. Start sharing takes.**

The social object is not the rig. It is **a TAKE: one fixed performance (a DI) heard
through one specific rig.** The playing is the constant, the rig is the variable.

Every format is that same primitive wearing a different hat:

| Format | What it is |
|---|---|
| **Shootout** | one DI, many rigs, side by side |
| **REMI Friday** | one DI the whole site gets on a Friday |
| **Tone request** | one DI plus "make it sound like this" |
| **Fork** | one rig changed, re-printed on the same DI — you *hear* what changed |
| **Personal A/B** | one DI, three of your own rigs, before you commit |

The verb is not LIKE. It is **ANSWER**: load the DI, dial your rig, print, post. Answering
is a creative act, it takes ninety seconds, and it produces the next piece of content.
That is the loop.

### Why it cannot be copied

To render *everyone's rig against one performance*, every rig must be executable by the
viewer. Kemper, Fractal, Neural DSP, Positive Grid and ToneHub cannot do this — their
rigs live in hardware or in a plugin the viewer must own and install. TONE3000 comes
closest, but their object is a **single capture**, not an editable chain with delay,
reverb, a studio strip and a looper.

Our advantage is *not* "NAM in a browser" — TONE3000 open-sourced that. It is:

> **A stranger with no account, no interface and no guitar can be inside the actual
> editable rig, turning knobs, hearing real playing change in real time.**

---

## 3. The funnel, inverted

Today the entire social layer sits behind `PLUG IN` → a 33 MB asset preload → a
**microphone permission prompt**. We ask for a microphone before we have given anyone a
reason to care, and the feed is invisible until they say yes.

The new order — each step earns the next:

1. **A link lands.** A take plays. No engine, no wasm, no mic, no account, no 33 MB.
   Works on a phone, in a Discord embed, in iMessage.
2. **HEAR IT AGAINST.** The same DI through two or three other rigs, gapless. All takes
   on one DI are the same length, so they play in sync and we just unmute one.
   *This is the moment the visitor understands what the site is.*
3. **TURN THE KNOBS.** Boots the engine with the DI looping as the input. Still no mic,
   still no account. They move the delay feedback and it changes in their ears.
   **This is the conversion event, and nothing else in the category has it.**
4. **They change something** → the save dialog opens itself: *"you changed it — name it."*
   That is where the account ask lands. Activation is governed by whether a first
   creative act happened, not by onboarding copy.
5. **PLAY IT WITH YOUR GUITAR** is the fourth click, and only there does the mic prompt
   appear.

---

## 4. Ranking, and why it is not likes

Every public number in the product is currently forgeable — `downloadBump` in
`firestore.rules` needs no authentication at all, and a preset's owner can set
`likesCount` to anything in one write. The moment a tone page is public and ranked, those
numbers decide what gets seen.

Ranking is therefore **blind pairwise votes on identical playing**: two takes of the same
DI, names hidden until you pick. It is fair, it is fun, it is the one ranking a
file-exchange physically cannot run — and it sidesteps the Kemper star-rot entirely.

Two integrity rules ride with it:

- **A tone without a printed take is a second-class post.** It can exist; it does not get
  the EVERYONE lane, an OG audio card, or entry to a challenge. This gates *distribution*,
  not upload, so it needs no moderation queue.
- **Loudness is normalised at print** (≈ −16 LUFS, true-peak clamped). Otherwise the
  ranking is a level contest.

---

## 5. Cloudflare: yes, and here is the split

The instinct is right. The split is:

**In R2** — everything big, immutable and served to strangers:
printed takes (mp3), the house DI library, avatars (moving them off Firestore),
generated OG share images. R2 has **zero egress fees**, which is the entire ball game for
audio: a take that goes mildly viral in a Discord costs nothing to serve.

**In Firestore** — everything small, queried and rule-governed:
the preset document, the take's *URL* and its metadata (duration, LUFS, peaks, DI id),
likes, comments, follows, votes.

**In a Worker** — the share surface Firebase Hosting cannot provide:
`/t/{id}`, `/u/{handle}`, `/x/{slug}` server-rendered with per-item `og:title`,
`og:image` and `og:audio`; the OG image renderer; `sitemap.xml`.

Two constraints that will silently break this if ignored:

- **R2 must return `Cross-Origin-Resource-Policy: cross-origin`.** Without it a printed
  clip plays fine on the share page and is *silently blocked inside the rig*, because the
  rig document is `COEP: require-corp`. This is the most confusing failure available here.
- **Deep links must be hash links** (`/#/t/{id}`). The COOP/COEP headers in
  `firebase.json` are scoped to `/` and `/index.html`; a naive SPA path rewrite drops
  them, which kills `SharedArrayBuffer` and the NAM engine fails to instantiate.

The Worker needs **no secrets to read**: the Firestore REST API enforces our rules for
unauthenticated callers, so a `shared == true` query returns 200 and anything else 403.

---

## 6. Phases

### Phase 0 — Close the holes *(done)*
Two live account-takeover bugs, both firing on the feed's primary action. Fixed in
`815d581`. Routing is what makes a feed worth attacking, so this had to land first.

### Phase 1 — Play without signing up, and be linkable *(this branch)*
The DI input source, the re-shaped gateway, hash routing, share links, persisted fork
lineage, and the Worker share page written but not deployed.
**Exit:** a stranger can open a link, hear a rig, turn its knobs and change it — having
installed nothing, signed up for nothing and granted no microphone.

### Phase 2 — Print, and the take becomes the object
Realtime print → loudness normalise → mp3 → R2 → `takes/{id}`. OG audio cards.
Redirect `engine.exportLoop()`, which today dies in the user's Downloads folder.
**Exit:** a shared link previews with sound in Discord and X.

### Phase 3 — The shootout, and the reason to return
N rigs on one DI with keyboard A/B and blind mode; REMI Friday on a fixed DI ranked by
blind pairwise vote; notifications so anything you earn is visible to you.
**Exit:** week-two return rate is measurable and non-zero.

### Phase 4 — Supply
Creator pages, verified capture makers, curated lanes. Outreach to TONE3000's top capture
creators with the one thing they do not have: a page where their capture is *playable* by
someone who owns nothing.

---

## 7. The kill list

Things that will feel urgent and are not:

- **Collaborative multi-layer loops.** The most natural-looking use of the looper and the
  trap. Needs per-user stem storage, cross-user bar alignment, a mixing UI and moderation
  of arbitrary user audio. This is Endlesss, which shut down in May 2024; Splice killed
  its collaboration product in 2023 for the same reason. Critically it does *not* use our
  structural advantage — it uses the looper as a DAW, competing with real DAWs.
  Asynchronous answer-on-a-fixed-DI gets the same feeling for ~5% of the engineering.
- **Star ratings.** See Kemper, above.
- **A paid marketplace, for now.** The economics are real, but there are no Cloud
  Functions, no payments and no entitlements — and TONE3000's API terms require a signed
  commercial agreement and pre-publication sign-off if we charge for anything, while
  their capture integration is load-bearing for us. Have that conversation *before*
  building a tier, not after.
- **User-uploaded DIs, initially.** The looper records *post-rig* audio, so a bar-aligned
  dry DI needs a worklet change; and it opens arbitrary user audio hosting with the
  moderation and licensing that implies. Ship the curated house DI library first.
- **Lessons and courses.** Different product, different audience, a content treadmill
  nobody here can staff.

---

## 8. Beachhead

**Worship first.** It is the only guitar sub-community that already accepts a computer as
the on-stage rig, is direct/IEM by default, is organised around named songs with a hard
weekly deadline, buys tones by band name, and has heavy volunteer churn and borrowed
gear. "Which rig for this Sunday" is a recurring weekly query with a fixed cadence — and
it maps one-to-one onto REMI Friday. The ambient Camden/Portland cleans are already its
palette.

**Metal second** (r/metalguitar answers shootouts enthusiastically). **Bedroom/practice
third**, positioned as the inverse of the $100–150 headphone-amp category: zero hardware,
zero install, works on a school Chromebook.

Seed in this order: 15–25 house tones each with a printed take *before anyone sees an
empty state*; 8–12 entries in the first challenge *before it opens* — a challenge with no
entries is worse than no challenge.

---

**Positioning line, everywhere:**

> *Same hands. Different rig. Hear it before you own anything.*
