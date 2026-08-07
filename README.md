# REMI DSP — Maine · Web Suite

**Live: https://remidsp-maine.web.app** · deployed on Firebase Hosting (site `remidsp-maine`
in project `remidsp-98208`; `npm run build && npx firebase-tools deploy --only hosting`).
For TONE3000 CONNECT on the live site, register
`https://remidsp-maine.web.app/t3k-callback.html` as a redirect URI on your publishable key
(tone3000.com → Settings → API Keys) — localhost is auto-allowed in dev, production is not.

The **REMI DSP "Over the Edge" guitar suite** ([the_guitar_guy](../the_guitar_guy)) rebuilt
for the browser: the NAM capture amp runs in **WebAssembly inside an AudioWorklet**, the
rest of the rig (gate · comp · drive · sauce · studio strip · chorus · dual-engine delay ·
Vast Sky reverb) is hand-rolled DSP in a second AudioWorklet on the same render thread.

**Low latency is the design constraint**: no lookahead, no internal buffering — the whole
chain costs one 128-sample render quantum (~2.7 ms @ 48 kHz) plus device I/O.

## Architecture

```
mic ─▶ pre worklet (gate·comp·drive·capture-in) ─▶ NAM wasm node ─┬─▶ ConvolverNode (cab IR) ─ wet ─┐
                                    └── amp bypass ──────────────┘└──────────────────  dry ─────────┤
                                                                                                    ▼
                          post worklet (tone stack·sauce·studio EQ+FET·chorus·delay A/B·reverb) ─▶ out
```

- **NAM engine**: [tone-3000/neural-amp-modeler-wasm](https://github.com/tone-3000/neural-amp-modeler-wasm)
  (MIT, SIMD build of NeuralAmpModelerCore ≥ 0.5.2). Loads classic **A1** WaveNet/LSTM `.nam`
  files *and* the new **A2 SlimmableContainer** format. Prebuilt artifacts are vendored in
  `public/` (`t3k-wasm-module.*`); the module creates its own AudioContext + mono worklet node
  (Emscripten Wasm Audio Worklets) — the rest of the graph attaches to that context.
- **Chain DSP**: `public/worklet/remi-processor.js` — one processor class, two stages
  (`pre` mono / `post` stereo). Delay engines have the desktop suite's soul: in-loop
  saturation + compounding HF loss, diffusion smear, tape wow/flutter, ducking, >100 %
  feedback bloom. The reverb is a modulated 8-line FDN with granular shimmer.
- **Cab**: `ConvolverNode` (spec-zero-latency partitioned convolution) — bundled UK 2x12 /
  US 1x12 IRs, or cab IRs from TONE3000. Bundled amp captures are full-rig, so the cab
  defaults **off**.
- **UI**: the desktop suite's own photoreal renders + knob sprites, positioned by the
  geometry measured in `ModulePanels.cpp`. BLACKOUT design language (true black, white
  light, Oswald / Space Grotesk / DSEG7) per the remidsp-site system.

## TONE3000

The **CAPTURES** drawer browses the TONE3000 catalog:

- **Trending** rails (all / amp / amp+cab / cab IR / pedal) work anonymously.
- **Full search** (latest · popular · all-time, gear filters, per-model loading) requires a
  free **publishable key**: tone3000.com → Settings → API Keys → paste into the CONNECT
  prompt. OAuth PKCE runs entirely client-side; localhost redirect URIs are auto-allowed
  in dev. For production, register your origin's `/t3k-callback.html` on the key.
- Amp models load into the capture slot (A2 preferred, A1 fallback); IR files load into
  the cab convolver. Creator names + licenses stay visible per the
  [API terms](https://www.tone3000.com/api/terms) — non-commercial use is free.

## Run

```bash
npm install
npm run dev        # http://localhost:5199
```

Chrome/Edge recommended. The page must be **cross-origin isolated** (COOP/COEP headers —
already set in `vite.config.ts` for dev/preview; mirror them on your production host) because
the wasm build uses SharedArrayBuffer + pthreads.

Pick your audio interface as the browser "microphone" (echo cancellation / noise
suppression / AGC are all disabled). Use 48 kHz output if you can — captures are
48 kHz-native and the engine runs at the device rate.

## Why a loop lands late, and the ALIGN control

The looper's clock is sample-exact — the count-in hands over on the very sample
the downbeat is generated — and takes still came back late, because that is not
where the delay lives.

Follow one note. The downbeat click is generated in the worklet at time `T`. The
player hears it at `T + outputLatency`, once it has been through the device
buffer and the converter. They play in response, perfectly, at
`T + outputLatency`. That note goes down the cable, through their interface's
buffer, and back into the worklet at `T + outputLatency + inputLatency`. So a
flawlessly timed note is recorded a **round trip** past the beat it belongs on,
and every overdub inherits the shift again.

Nothing in a browser can remove that delay — it is the price of real hardware —
but it is a constant, so the looper takes it back out on the way to the
speakers: the loop is read `ALIGN` milliseconds ahead of the grid.

Two things follow from doing it on playback rather than on the way in. The takes
on disk stay exactly what came off the guitar, and **the figure can be changed
after the fact** — nudging ALIGN slides every layer already recorded, live, so
it is dialled in by ear (and by eye, against the lane's gridlines) instead of by
re-recording. And every take **over-records a 250 ms tail** past the loop top,
because reading ahead means the end of the cycle comes from after the grid ended;
with no tail it would wrap to the count-in and swallow the attack of a note
played on the final beat.

ALIGN seeds itself from the device the first time record is pressed — Web Audio
reports the output side, and Chrome reports the input side on the track — then
remembers whatever the player settles on, because it is a property of their
interface and not of the rig. `AUTO` puts the measured figure back. On the demo
track it is zero, and that is exact rather than approximate: the DI is a buffer
inside the graph and has been through no converter at either end.

Verified against an irregular pulse train driven into the input bus, bounced at
each setting and cross-correlated: **sample-exact from −20 ms to the +250 ms
tail ceiling**, clamping correctly beyond it, with whole-loop energy unchanged.

## The tuner

`TUNER` in the header opens the chromatic tuner — a port of the desktop suite's
`TunerOverlay`, down to the ±5-cent lock window and the smoothing constants, so
the two behave the same under the hands.

**It mutes the rig while it is open**, like a tuner pedal: a gain ramp on the
last node before the speakers (`src/audio/engine.ts` → `setMuted`), not a
disconnect, so the meters, the looper's clock and the spectrum all keep running.
To be clear about what that buys — it is silence, not speed. The chain still
costs its one render quantum whether or not the final gain is at zero. What it
does fix is a laptop with an open mic hearing its own speakers, which is the
difference between locking onto a note and chasing one.

Pitch detection (`src/dsp/pitch.ts`) is the desktop's YIN — same band-pass, same
0.13 threshold, same descend-to-the-valley rule — but **coarse-to-fine**, because
a full-rate search is ~2.7 M inner iterations and this one runs on the thread
that paints the page. It searches at ~12 kHz to find *which* period, then
re-measures that one period at the device rate. About a twelfth of the work, and
the final reading keeps the desktop's precision: measured against injected
tones, within **±0.8 cents from E2 to E5**, at a steady 60 fps with zero long
tasks.

## Two doors, and addresses

The gate offers **LISTEN FIRST** and **PLUG IN**. Listen First boots the same
rig with a looping demo DI as its input and **never calls `getUserMedia`** — no
microphone, no interface, no account, and no guitar required. The mic ask lives
on the `DEMO / GUITAR` switch in the header instead, behind a deliberate press,
after the rig is already making sound; refusing it leaves the demo running.

The demo DI is synthesised by `scripts/make-di.mjs` (Karplus-Strong plucked
strings, D–Bm7–Gmaj9–Asus4 at 92 BPM) so it carries no sample licence and is
reproducible from source. Regenerate with `node scripts/make-di.mjs`. It is a
starting point — a real recorded DI will always beat it, and the plumbing is
identical either way.

Everything now has an address (`src/ui/router.ts`):

| Route | What |
|---|---|
| `/#/` | the rig |
| `/#/feed` | the feed |
| `/#/t/<presetId>` | a shared tone, loaded straight onto the rig |
| `/#/u/<handle>` | a player's profile |
| `/#/me` | your own profile |

**They are hash routes for a load-bearing reason.** The COOP/COEP headers in
`firebase.json` are scoped to `/` and `/index.html`. A hosting rewrite for a
path like `/t/abc` would serve the rig *without* them — not cross-origin
isolated, `SharedArrayBuffer` undefined, NAM wasm unable to instantiate. The rig
would break only on shared links. `/#/t/abc` is the same document at `/`, so the
headers apply. Do not "tidy this up" into clean paths without moving the headers.

A link arriving before the engine exists lands on a share page — whose sound it
is, what it is made of, one PLAY THIS RIG button — because the feed, profiles
and tone cards are ordinary DOM over a database that already allows anonymous
reads. Only the rig itself needs audio.

## The share Worker (`worker/`, not deployed)

Serves the crawlable twin of each route: `/t/<id>` and `/u/<handle>` as real
HTML with per-item `og:` tags, `/og/t/<id>.svg`, and `/m/<key>` for R2 media.

Two things it exists for: crawlers and unfurlers never run JS, so the feed is
otherwise invisible to search and to every chat app; and R2 media must return
`Cross-Origin-Resource-Policy: cross-origin` or it is **silently blocked inside
the rig** by COEP while playing fine everywhere else. Firebase Storage cannot
set that header — this is why the media lives on R2, not a preference.

It holds no credentials: the rules already permit anonymous reads of shared
presets and public profiles, so it reads as nobody.

Deploy is deliberately not wired up. Rotate the API token in `.dev.vars` first,
put the Worker on a subdomain before the apex, and assert after any routing
change that `/` still returns both `cross-origin-*` headers and `/signin.html`
still returns neither.

## Accounts, profiles & the feed (optional)

Sign-in is optional — the rig runs fully without it. With an account you get a profile
(username · bio · avatar URL), a **cloud preset library** (params + amp/voice + capture
provenance, including TONE3000 model refs — the reference is stored, never the file),
and **THE FEED**: share a sound with a description when you save it, browse everyone's
tones or just the people you **follow** (user search + follow live in the feed header),
sort by latest / most liked / most loaded, filter by amp, like ♥ and comment. Feed posts
render the whole rig: amp-accented card, the chain in chip art, DSEG7 tempo/delay/reverb
tiles, capture provenance.

Backend is Firebase (project `remidsp-98208`): Auth + Firestore. Rules and indexes are
deployed from this repo (`firestore.rules` **also contains the remidsp-site analytics
rules** — the two apps share the project, edit both here). Email/password sign-in is
enabled; **Google needs one console click** (Firebase console → Authentication →
Sign-in method → Google → enable, which mints its OAuth client). Apple/GitHub/Facebook
need their platform credentials in the same screen — the buttons are wired and will work
the moment a provider is switched on. Provider sign-in uses the redirect flow (the page
is cross-origin isolated, which breaks auth popups) and therefore works on the deployed
origin, not localhost.

## Licensing notes

- NAM core + wasm build: MIT (`public/t3k-wasm-LICENSE.txt`).
- Fonts: Oswald / Space Grotesk / Yellowtail (SIL OFL), DSEG7 (SIL OFL).
- UI renders, sprites and IRs: original artwork from the REMI DSP desktop suite.
- Bundled captures (`public/assets/captures`): community NAM captures sourced via
  TONE3000 (see the desktop suite's README for provenance) — personal-use convenience
  bundle; review source licenses before public distribution.
