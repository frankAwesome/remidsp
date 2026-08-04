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
