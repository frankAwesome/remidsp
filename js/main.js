/* ══════════════════════════════════════════════════════════════
   REMI DSP — site engine
   Native scroll only. One persistent rAF loop; all layout offsets
   are cached on load/resize — the hot path never reads layout.
   Scroll-linked content answers 1:1; only decor may trail.
   ══════════════════════════════════════════════════════════════ */
(() => {
  "use strict";
  const $  = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp  = (a, b, t) => a + (b - a) * t;
  const pad   = (n, w = 2) => String(n).padStart(w, "0");

  const reduce  = matchMedia("(prefers-reduced-motion:reduce)").matches;
  const finePtr = matchMedia("(hover:hover) and (pointer:fine)").matches;
  const mqWide  = matchMedia("(min-width:881px)");

  const yEl = $("#year"); if (yEl) yEl.textContent = new Date().getFullYear();

  /* VU meter ticks (drawn once) */
  (() => {
    const g = $("#vuTicks"); if (!g) return;
    const NS = "http://www.w3.org/2000/svg";
    for (let i = 0; i <= 10; i++) {
      const a = (-46 + (i / 10) * 92) * Math.PI / 180;   // sweep -46°..+46°
      const cx = 100, cy = 98, r0 = 68, r1 = 78;
      const ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", cx + Math.sin(a) * r0); ln.setAttribute("y1", cy - Math.cos(a) * r0);
      ln.setAttribute("x2", cx + Math.sin(a) * r1); ln.setAttribute("y2", cy - Math.cos(a) * r1);
      if (i >= 8) ln.setAttribute("class", "hot");
      g.appendChild(ln);
    }
  })();

  /* ────────────────────────────────────────────────────────────
     SCRAMBLE — mono/tech text shuffle (kickers once, nav on hover)
     ──────────────────────────────────────────────────────────── */
  const GLYPHS = "▮▯/\\_#01XZA";
  function scramble(el, dur = 620) {
    if (reduce || el.dataset.scrambling) return;
    const original = el.dataset.orig || (el.dataset.orig = el.textContent);
    el.dataset.scrambling = "1";
    const t0 = performance.now();
    (function frame(t) {
      const p = clamp((t - t0) / dur, 0, 1);
      const solved = Math.floor(p * original.length);
      let out = "";
      for (let i = 0; i < original.length; i++) {
        const ch = original[i];
        out += i < solved || ch === " " ? ch
             : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      el.textContent = out;
      if (p < 1) requestAnimationFrame(frame);
      else { el.textContent = original; delete el.dataset.scrambling; }
    })(t0);
  }
  $$("[data-scramble]").forEach(el =>
    el.addEventListener("pointerenter", () => scramble(el, 420)));

  /* ────────────────────────────────────────────────────────────
     REVEALS — IntersectionObserver, fire once
     (started after the boot wipe so the hero sequences correctly)
     ──────────────────────────────────────────────────────────── */
  function initReveals() {
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        if (e.target.classList.contains("kicker")) scramble(e.target);
        io.unobserve(e.target);
      }
    }, { threshold: 0.16, rootMargin: "0px 0px -8% 0px" });
    // NOTE: observe the un-clipped line CONTAINER, not the line spans — the
    // spans start translated out of their overflow:hidden mask, so they'd
    // report 0% intersection and never fire. `.in [data-reveal-line]` reveals
    // the children (each with its own --d stagger).
    $$("[data-reveal],[data-reveal-lines],[data-reveal-wipe],.kicker").forEach(el => io.observe(el));
  }

  /* ────────────────────────────────────────────────────────────
     BOOT — counts against REAL load state; min .9s, hard cap 2.4s;
     once per session; clip-path wipe out.
     ──────────────────────────────────────────────────────────── */
  const boot = $("#boot");
  (function runBoot() {
    if (!boot) return initReveals();
    if (reduce || sessionStorage.getItem("remiBoot")) {
      boot.remove(); initReveals(); return;
    }
    const numEl = $("#bootNum"), ledsEl = $("#bootLeds"), lineEl = $(".boot__line");
    const LEDS = 26;
    for (let i = 0; i < LEDS; i++) ledsEl.appendChild(document.createElement("i"));
    const leds = [...ledsEl.children];
    const lines = ["POWERING ON · CAPTURE ENGINE · 48K", "WARMING TUBES…",
                   "LOADING CAPTURES…", "WAKING THE BOARD…", "ON AIR"];
    let li = 0;
    const lineTimer = setInterval(() => { lineEl.textContent = lines[li = (li + 1) % (lines.length - 1)]; }, 460);

    let ready = false;
    const heroImg = $(".hero__shot img");
    Promise.race([
      Promise.allSettled([document.fonts.ready, heroImg?.decode?.() ?? 0]),
      new Promise(r => setTimeout(r, 2000)),
    ]).then(() => { ready = true; });
    setTimeout(() => { ready = true; }, 2400); // never trap the visitor

    const t0 = performance.now();
    let shown = 0;
    (function tick(t) {
      const el = t - t0;
      // glide to 92% over ~1s, then wait for `ready`, then sprint to 100
      const target = ready ? 100 : Math.min(92, 92 * (1 - Math.pow(1 - Math.min(el / 1050, 1), 3)));
      shown = Math.min(100, lerp(shown, target, ready ? 0.25 : 0.12));
      const n = Math.round(shown);
      numEl.textContent = pad(n, 2);
      const on = Math.round((n / 100) * LEDS);
      leds.forEach((l, i) => l.classList.toggle("on", i < on));
      if (n >= 100 && el > 900) {
        clearInterval(lineTimer);
        lineEl.textContent = lines[lines.length - 1];
        setTimeout(() => {
          boot.classList.add("is-done");
          sessionStorage.setItem("remiBoot", "1");
          initReveals();
          setTimeout(() => boot.classList.add("is-gone"), 800);
        }, 140);
        return;
      }
      requestAnimationFrame(tick);
    })(t0);
  })();

  /* ────────────────────────────────────────────────────────────
     CACHED GEOMETRY — the hot path never touches layout
     ──────────────────────────────────────────────────────────── */
  const nav       = $("#nav");
  const scrollFill= $("#scrollFill");
  const hudPct    = $("#hudPct");
  const heroInner = $(".hero__inner");
  const heroStage = $(".hero__stage");
  const boardPin  = $("#boardPin");
  const boardTrack= $("#boardTrack");
  const boardFill = $("#boardFill");
  const boardCount= $("#boardCount");
  const cards     = $$(".pcard");
  const ghost     = $(".download__ghost");
  const vuNeedle  = $("#vuNeedle");
  const marqBand  = $(".marquee__band");
  const marqTracks= $$(".marquee__track");

  // Camden / Portland / Katahdin — keyed to each head's own colour: Camden's
  // cool seafoam, Portland's gold-on-black, Katahdin's warm carving. The hero
  // reel washes the page with whichever head is live.
  const AMP_BGS   = ["#05090b", "#0b0906", "#0b0705"];
  const CARD_BGS  = ["#0d0a04", "#0e0704", "#04100f", "#060a12", "#0e0605"]; // drive/chorus/delay/reverb/sauce
  const BASE_BG   = "#050506";

  const M = { vh: 0, docH: 1, hero: 0,
              boardTop: 0, boardTravel: 1, boardDist: 0,
              ghostMid: 0, marqW: 1, ranges: [] };

  function measure() {
    M.vh = innerHeight;
    // board pin height first — it shifts everything below it
    if (boardPin && boardTrack) {
      if (mqWide.matches) {
        M.boardDist = Math.max(0, boardTrack.scrollWidth - innerWidth + 48);
        // 1:1 map — vertical scroll through the section == horizontal rail travel.
        boardPin.style.height = Math.round(M.vh + M.boardDist) + "px";
      } else {
        boardPin.style.height = "";
        M.boardDist = 0;
      }
    }
    const top = el => el.getBoundingClientRect().top + scrollY;
    M.docH   = document.documentElement.scrollHeight - M.vh;
    M.hero   = M.vh;
    if (boardPin){ M.boardTop = top(boardPin); M.boardTravel = Math.max(1, boardPin.offsetHeight - M.vh); }
    if (ghost)   { const g = $(".download"); M.ghostMid = top(g) + g.offsetHeight / 2; }
    if (marqTracks[0]) M.marqW = marqTracks[0].scrollWidth;
    // theme ranges: every [data-bg] section + board + the hero reel
    M.ranges = [];
    $$("[data-bg],.board,.rig").forEach(el => {
      M.ranges.push({ top: top(el), bot: top(el) + el.offsetHeight,
                      bg: el.dataset.bg || null,
                      kind: el.classList.contains("board") ? "board"
                          : el.classList.contains("rig") ? "rig" : "flat" });
    });
    M.ranges.sort((a, b) => a.top - b.top);
  }

  /* JS drives the marquee (velocity-reactive) — kill the CSS fallback anim */
  if (!reduce && marqTracks.length) marqTracks.forEach(t => t.style.animation = "none");

  /* ────────────────────────────────────────────────────────────
     THE LOOP — one rAF for everything scroll/velocity-driven
     ──────────────────────────────────────────────────────────── */
  let lastY = scrollY, vel = 0, curBg = "", navStuck = null, lastPct = -1;
  let lastBoardCount = "", marqX = 0, marqDir = -1;
  let stringsOn = false;

  function setBg(bg) {
    if (bg && bg !== curBg) { document.body.style.backgroundColor = curBg = bg; }
  }

  function themeAt(mid, boardP) {
    for (const r of M.ranges) {
      if (mid < r.top || mid >= r.bot) continue;
      if (r.kind === "rig")   return AMP_BGS[clamp(rig.i, 0, 2)];   // page washes with the live head
      if (r.kind === "board") return mqWide.matches ? CARD_BGS[clamp(Math.floor(boardP * 5), 0, 4)] : BASE_BG;
      return r.bg;
    }
    return BASE_BG;
  }

  function frame(now) {
    const y = scrollY;
    vel = lerp(vel, y - lastY, 0.22);           // smoothed px/frame
    lastY = y;
    const scrolled = Math.abs(vel) > 0.01;

    /* progress chrome */
    const pct = M.docH > 0 ? clamp(y / M.docH, 0, 1) : 0;
    if (scrollFill) scrollFill.style.transform = `scaleX(${pct.toFixed(4)})`;
    const ip = Math.round(pct * 100);
    if (ip !== lastPct && hudPct) { hudPct.textContent = pad(ip, 3); lastPct = ip; }

    const stuck = y > 40;
    if (stuck !== navStuck && nav) { nav.classList.toggle("is-stuck", stuck); navStuck = stuck; }

    if (!reduce) {
      /* hero exit parallax — decorative trail, content-safe.
         The home hero has no .hero__stage (it uses .rig__stage, which stays put
         while the amp cycles), so guard rather than assume the pair exists. */
      if (y < M.hero && heroInner) {
        heroInner.style.transform = `translate3d(0,${(y * 0.16).toFixed(1)}px,0)`;
        if (heroStage) heroStage.style.transform = `translate3d(0,${(y * 0.08).toFixed(1)}px,0)`;
      }

      /* pedal rail — 1:1, live rect, with velocity skew */
      let boardP = 0;
      if (boardTrack && mqWide.matches) {
        const r = boardPin.getBoundingClientRect();
        if (r.top < M.vh && r.bottom > 0) {
          boardP = clamp(-r.top / M.boardTravel, 0, 1);
          const sk = clamp(-vel * 0.06, -4, 4);
          boardTrack.style.transform = `translate3d(${(-boardP * M.boardDist).toFixed(1)}px,0,0) skewX(${sk.toFixed(2)}deg)`;
          if (boardFill) boardFill.style.transform = `scaleX(${boardP.toFixed(4)})`;
          const c = pad(1 + Math.min(cards.length - 1, Math.floor(boardP * cards.length)));
          if (c !== lastBoardCount && boardCount) { boardCount.textContent = c; lastBoardCount = c; }
        }
      }

      /* download ghost drift */
      if (ghost) {
        const gp = clamp((y + M.vh / 2 - M.ghostMid) / M.vh, -1, 1);
        ghost.style.transform = `translate(-50%,-50%) translate3d(0,${(gp * 46).toFixed(1)}px,0)`;
      }

      /* VU needle rides scroll velocity */
      if (vuNeedle) {
        const a = clamp(-46 + Math.abs(vel) * 2.6, -46, 46);
        vuNeedle.style.transform = `rotate(${a.toFixed(1)}deg)`;
      }

      /* velocity marquee — speeds up with you, flips with you */
      if (marqTracks.length && M.marqW > 1) {
        if (scrolled) marqDir = vel > 0 ? -1 : 1;
        marqX += marqDir * (0.9 + Math.min(Math.abs(vel) * 0.35, 14));
        marqX = ((marqX % M.marqW) + M.marqW) % M.marqW;
        const tx = (-marqX).toFixed(1);
        marqTracks.forEach(t => t.style.transform = `translate3d(${tx}px,0,0)`);
        // the band sits straight now — velocity only shears it, never tilts it
        if (marqBand) marqBand.style.transform =
          `skewX(${clamp(vel * 0.05, -5, 5).toFixed(2)}deg)`;
      }

      /* theme morph */
      setBg(themeAt(y + M.vh * 0.5, boardP));

      /* hero strings */
      if (stringsOn) strings.step(now);
    }

    /* the deck — outside the motion guard on purpose: a playhead that stops
       tracking the audio isn't "reduced motion", it's a broken transport. It
       no-ops unless a clip is actually playing. */
    player.step();

    requestAnimationFrame(frame);
  }

  /* ────────────────────────────────────────────────────────────
     THE RIG — home hero amp cycler. One source of truth for the
     active head; everything else (glow, ghost word, tabs, voice
     chips, page wash) reads off it.
     ──────────────────────────────────────────────────────────── */
  const rig = (() => {
    const sec = $(".rig"), stage = $("#rig");
    if (!sec || !stage) return { i: 0, live: false };

    const amps  = $$(".rig__amp");
    const tabs  = $$("#rigTabs button");
    const vsets = $$(".rig__voiceset");
    // [halo, falloff] — pulled off each head: Camden's seafoam panel, Portland's
    // gold-on-black, Katahdin's warm cherub carving.
    const GLOW  = [["#8fd8cf", "#4a8f96"], ["#e8c877", "#8f6f2e"], ["#e0a878", "#96552e"]];
    const PERIOD = 5200;

    const api = { i: 0, live: false };
    let timer = 0, onScreen = false, held = false;

    // seed the sheen mask for the head that ships active in the markup
    if (amps[0]) sec.style.setProperty("--amp-mask", `url("${amps[0].currentSrc || amps[0].src}")`);

    function set(n) {
      n = ((n % amps.length) + amps.length) % amps.length;
      if (n === api.i) return;
      api.i = n;
      amps .forEach((a, k) => a.classList.toggle("is-active", k === n));
      vsets.forEach((v, k) => v.classList.toggle("is-active", k === n));
      tabs .forEach((t, k) => { t.classList.toggle("is-active", k === n); t.setAttribute("aria-selected", k === n); });
      sec.style.setProperty("--amp-glow",   GLOW[n][0]);
      sec.style.setProperty("--amp-glow-2", GLOW[n][1]);
      // Clip the specular sweep to this head's silhouette. Safe to swap outright:
      // the reel is held while the pointer is over the stage, so the mask never
      // changes mid-hover, and the sheen is invisible when it isn't.
      sec.style.setProperty("--amp-mask", `url("${amps[n].currentSrc || amps[n].src}")`);
    }

    const stop = () => { clearInterval(timer); timer = 0; };
    const play = () => { stop(); if (!reduce && onScreen && !held) timer = setInterval(() => set(api.i + 1), PERIOD); };

    tabs.forEach(btn => btn.addEventListener("click", () => { set(+btn.dataset.goto); play(); }));
    // Hold the reel while the visitor is actually looking at a head.
    stage.addEventListener("pointerenter", () => { held = true;  stop(); });
    stage.addEventListener("pointerleave", () => { held = false; play(); });

    new IntersectionObserver(es => es.forEach(e => {
      onScreen = api.live = e.isIntersecting;
      onScreen ? play() : stop();
    }), { threshold: 0.15 }).observe(sec);

    return api;
  })();

  /* ────────────────────────────────────────────────────────────
     THE DECK — audio samples, one voice in the room

     Exclusivity is structural, not policed: there is exactly ONE <audio>
     element for the whole section, and starting a clip re-points it. Two
     clips overlapping is not a bug that can happen here — there is no second
     thing to make a sound. (Three <audio> tags plus "pause the others"
     bookkeeping is the usual shape, and it leaks the moment a new entry point
     — a deep link, a keyboard seek, an auto-advance — forgets to call it.)

     Waveforms are measured peaks baked into #clipPeaks, so nothing is fetched
     or decoded until a visitor actually presses play; `preload="none"` keeps
     the 2.6 MB of MP3 off the critical path entirely.
     ──────────────────────────────────────────────────────────── */
  const player = (() => {
    const deck = $(".deck"), list = $("#clips");
    const noop = { step() {} };
    if (!deck || !list) return noop;

    let PEAKS = {};
    try { PEAKS = JSON.parse($("#clipPeaks")?.textContent || "{}"); } catch { PEAKS = {}; }

    const stateEl = $("#deckState"), nowEl = $("#deckNow"), liveEl = $("#deckLive");
    const timeEl  = $("#deckTime"),  durEl = $("#deckDur"), spec = $("#deckSpectrum");

    const audio = new Audio();
    audio.preload = "none";

    const fmt = s => (!isFinite(s) || s <= 0) ? "0:00"
                   : Math.floor(s / 60) + ":" + pad(Math.floor(s % 60));

    const clips = $$(".clip", list).map(el => ({
      el,
      key:    el.dataset.key,
      src:    el.dataset.src,
      name:   $("h3", el)?.textContent.trim() || el.dataset.key,
      peaks:  PEAKS[el.dataset.key]?.peaks || [],
      fallbackDur: PEAKS[el.dataset.key]?.dur || 0,
      toggle: $(".clip__toggle", el),
      wave:   $(".clip__wave", el),
      cv:     $("canvas", el),
      head:   $(".clip__head", el),
      ghost:  $(".clip__ghost", el),
      scrub:  $(".clip__scrub", el),
      dur:    $(".clip__time", el),
      ctx:    null, w: 0, h: 0, dpr: 0, drawnP: -1, grad: null, scrubW: 0,
    }));
    if (!clips.length) return noop;

    let cur = null;          // the clip the single <audio> is currently pointing at
    let pendingSeek = null;  // a seek asked for before metadata landed
    let finished = false;    // this clip ran to its end (see the ended handler)
    let lastSec = -1, lastState = "";

    /* ── the length we trust: the file's own once it has told us, the baked
       placeholder until then (so the rows read 0:23 rather than 0:00 on load) */
    const durOf = c =>
      (c === cur && isFinite(audio.duration) && audio.duration > 0) ? audio.duration
                                                                    : c.fallbackDur;

    /* ── waveform ──────────────────────────────────────────────
       Two passes over the same bars: everything in the idle grey, then the
       played span again in the brand light under a clip rect. That gives a
       pixel-exact progress edge without a second DOM layer, and the whole
       redraw is ~160 fillRects — cheap enough to run on the shared rAF. */
    const IDLE = "rgba(233,238,244,.20)";

    function sizeWave(c) {
      const r = c.wave.getBoundingClientRect();
      const dpr = Math.min(devicePixelRatio || 1, 2);
      if (!r.width || !r.height) return false;
      if (Math.abs(r.width - c.w) < .5 && Math.abs(r.height - c.h) < .5 && dpr === c.dpr) return false;
      c.w = r.width; c.h = r.height; c.dpr = dpr;
      c.cv.width  = Math.round(r.width  * dpr);
      c.cv.height = Math.round(r.height * dpr);
      c.ctx = c.cv.getContext("2d");
      c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // white light at the centre line, falling off toward the peaks — the same
      // gradient the hero headline is filled with
      c.grad = c.ctx.createLinearGradient(0, 0, 0, c.h);
      c.grad.addColorStop(0,   "#8fb4c6");
      c.grad.addColorStop(.5,  "#ffffff");
      c.grad.addColorStop(1,   "#8fb4c6");
      c.drawnP = -1;
      return true;
    }

    function bars(c, ctx, fill, n, mid, cw) {
      ctx.fillStyle = fill;
      const src = c.peaks, len = src.length;
      const barW = Math.max(1, cw - 1);
      for (let i = 0; i < n; i++) {
        const a = Math.floor(i * len / n);
        const b = Math.max(a + 1, Math.floor((i + 1) * len / n));
        let v = 0;
        for (let k = a; k < b; k++) if (src[k] > v) v = src[k];
        const bh = Math.max(1.5, (v / 100) * (c.h - 8));
        ctx.fillRect(i * cw, mid - bh / 2, barW, bh);
      }
    }

    function drawWave(c, p) {
      const ctx = c.ctx;
      if (!ctx || !c.peaks.length) return;
      ctx.clearRect(0, 0, c.w, c.h);
      const n   = clamp(Math.round(c.w / 3), 24, c.peaks.length);
      const cw  = c.w / n, mid = c.h / 2;
      // centre rule — keeps the quiet passages from reading as a gap in the row
      ctx.fillStyle = "rgba(255,255,255,.06)";
      ctx.fillRect(0, mid - .5, c.w, 1);
      bars(c, ctx, IDLE, n, mid, cw);
      const played = p * c.w;
      if (played > 0) {
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, played, c.h); ctx.clip();
        bars(c, ctx, c.grad, n, mid, cw);
        ctx.restore();
      }
      c.drawnP = p;
    }

    function layout() {
      for (const c of clips) if (sizeWave(c)) drawWave(c, c === cur ? progress() : 0);
      sizeSpec();
    }

    /* ── progress + readouts ─────────────────────────────────── */
    const progress = () => {
      const d = cur ? durOf(cur) : 0;
      return d > 0 ? clamp(audio.currentTime / d, 0, 1) : 0;
    };

    function render() {
      if (!cur) return;
      const d = durOf(cur), t = clamp(audio.currentTime, 0, d || 0), p = d > 0 ? t / d : 0;

      cur.head.style.transform = `translate3d(${(p * cur.w).toFixed(1)}px,0,0)`;
      // repaint only once the played edge has actually moved a whole pixel
      if (Math.abs(p - cur.drawnP) * cur.w >= 1) drawWave(cur, p);

      const sec = Math.floor(t);
      if (sec !== lastSec) {
        lastSec = sec;
        if (timeEl) timeEl.textContent = fmt(t);
        if (durEl)  durEl.textContent  = fmt(d);
        cur.wave.setAttribute("aria-valuenow", Math.round(p * 100));
        cur.wave.setAttribute("aria-valuetext", `${fmt(t)} of ${fmt(d)}`);
      }
    }

    /* Repainting is split from the state word on purpose, for two reasons.
       Switching straight from one playing clip to another goes PLAYING →
       PLAYING, so an early return on "same state" would leave the NEW row
       without .is-playing and the old label in place. And it reads `paused` off
       the element rather than the state word, because the word lags by an event
       loop turn — long enough to paint one frame with no row lit at all. */
    function paint() {
      const on = !!cur && !audio.paused;
      deck.classList.toggle("is-live", on);
      clips.forEach(c => {
        const live = on && c === cur;
        c.el.classList.toggle("is-playing", live);
        // the glyph flips to a pause bar, so the name for it has to flip too —
        // a button labelled "Play Clean" that stops Clean is worse than no label
        c.toggle.setAttribute("aria-label", (live ? "Pause " : "Play ") + c.name);
      });
    }

    function setState(s) {
      if (s !== lastState) {
        lastState = s;
        if (stateEl) stateEl.textContent = s;
      }
      paint();
    }

    const say = msg => { if (liveEl) liveEl.textContent = msg; };

    /* ── the single element, re-pointed ──────────────────────── */
    function select(c) {
      if (cur === c) return;
      if (cur) {
        audio.pause();
        cur.el.classList.remove("is-active");
        cur.head.style.transform = "translate3d(0,0,0)";
        drawWave(cur, 0);
        cur.wave.setAttribute("aria-valuenow", 0);
        cur.wave.setAttribute("aria-valuetext", `0:00 of ${fmt(durOf(cur))}`);
      }
      cur = c;
      pendingSeek = null; lastSec = -1; finished = false;
      c.el.classList.add("is-active");
      if (nowEl) nowEl.textContent = c.name;
      if (durEl) durEl.textContent = fmt(c.fallbackDur);
      if (timeEl) timeEl.textContent = "0:00";
      audio.src = c.src;          // ← the whole exclusivity guarantee, one line
      audio.load();
      paint();
    }

    function start(c) {
      select(c);
      finished = false;
      resumeCtx();
      const go = audio.play();
      // play() clears `paused` synchronously, so painting here — in the same
      // task select() darkened the old row in — hands the light straight over.
      // Waiting for the play event instead costs one frame with nothing lit.
      paint();
      if (go?.catch) go.catch(() => {
        // autoplay policy, a decode failure, or the visitor navigating away
        // mid-request: fall back to a state they can retry from.
        if (!audio.paused) return;
        setState("PAUSED");
      });
    }

    function toggle(c) {
      if (cur === c && !audio.paused) { audio.pause(); return; }
      start(c);
    }

    function seek(c, t) {
      if (cur !== c) select(c);
      const d = durOf(c) || 0;
      const to = clamp(t, 0, d ? d - .05 : 0);
      if (audio.readyState >= 1) { try { audio.currentTime = to; } catch { /* not seekable yet */ } }
      else pendingSeek = to;
      finished = false;
      lastSec = -1;
      render();
    }

    /* ── spectrum ──────────────────────────────────────────────
       Built on the first play gesture and never before: an AudioContext
       created at load is born suspended under autoplay policy, and — because
       createMediaElementSource re-routes the element through the graph —
       a suspended context means silence, not just a dead visualiser. */
    let actx = null, analyser = null, freq = null, srcNode = null;
    let sctx = null, sw = 0, sh = 0, sdpr = 0, sgrad = null;

    function sizeSpec() {
      if (!spec) return;
      const r = spec.getBoundingClientRect();
      const dpr = Math.min(devicePixelRatio || 1, 2);
      if (!r.width || !r.height) return;
      if (Math.abs(r.width - sw) < .5 && Math.abs(r.height - sh) < .5 && dpr === sdpr) return;
      sw = r.width; sh = r.height; sdpr = dpr;
      spec.width = Math.round(sw * dpr); spec.height = Math.round(sh * dpr);
      sctx = spec.getContext("2d");
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sgrad = sctx.createLinearGradient(0, sh, 0, 0);
      sgrad.addColorStop(0, "rgba(143,180,198,.55)");
      sgrad.addColorStop(1, "#ffffff");
    }

    let wired = false;

    /* The one irreversible step: createMediaElementSource takes the element off
       the native audio path for good and hands it to the graph. So it only runs
       once the context is CONFIRMED running — an element wired into a suspended
       context is a silent element, and no visualiser is worth that trade. If the
       context never starts, the deck simply plays with no spectrum. */
    function wire() {
      if (wired || !actx || actx.state !== "running") return;
      wired = true;
      try {
        srcNode  = actx.createMediaElementSource(audio);
        analyser = actx.createAnalyser();
        analyser.fftSize = 512;      // 256 bins ≈ 86 Hz each — enough resolution
        analyser.smoothingTimeConstant = .78;   // to show a chord, not just a blob
        srcNode.connect(analyser);
        analyser.connect(actx.destination);
        freq = new Uint8Array(analyser.frequencyBinCount);
      } catch {
        // If it threw after the source existed, the element is already re-routed
        // — wire it to the speakers ourselves rather than leave it dangling.
        analyser = null; freq = null;
        try { srcNode?.connect(actx.destination); } catch { /* nothing left to try */ }
      }
      sizeSpec();
    }

    /* Called from the click handler, i.e. inside a user gesture — the only
       moment an AudioContext is allowed to start. */
    function resumeCtx() {
      if (wired || reduce || !spec) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!actx) { try { actx = new AC(); } catch { return; } }
      if (actx.state === "running") wire();
      else actx.resume?.().then(wire).catch(() => { /* retry on the next play */ });
    }

    function drawSpec() {
      if (!sctx) return;
      sctx.clearRect(0, 0, sw, sh);
      if (!analyser || audio.paused) return;
      analyser.getByteFrequencyData(freq);
      const N = clamp(Math.round(sw / 7), 24, 128);
      const bw = sw / N;
      sctx.fillStyle = sgrad;
      // True log sweep across the band a guitar actually occupies (~85 Hz to
      // ~11 kHz). A linear split spends three-quarters of the strip above 5 kHz
      // where there is nothing to draw, which is what made this read as a rule
      // with a few blocks stacked on the left.
      const TOP = Math.max(4, Math.floor(freq.length * 0.5));
      const bin = i => Math.min(TOP, Math.floor(Math.pow(TOP, i / N)));
      for (let i = 0; i < N; i++) {
        const lo = bin(i), hi = Math.max(lo + 1, bin(i + 1));
        let v = 0;
        for (let k = lo; k < hi; k++) if (freq[k] > v) v = freq[k];
        if (v < 3) continue;                  // no 1px floor: silence draws nothing
        const bh = (v / 255) * (sh - 2);
        sctx.fillRect(i * bw, sh - bh, Math.max(1, bw - 1.5), bh);
      }
    }

    /* ── wiring ───────────────────────────────────────────────── */
    clips.forEach(c => {
      c.toggle.addEventListener("click", () => toggle(c));

      c.wave.addEventListener("pointerdown", e => {
        if (e.button != null && e.button !== 0) return;
        const r = c.wave.getBoundingClientRect();
        seek(c, ((e.clientX - r.left) / r.width) * durOf(c));
        if (cur === c && audio.paused) start(c);
      });

      if (finePtr) {
        c.wave.addEventListener("pointermove", e => {
          const r = c.wave.getBoundingClientRect();
          const x = clamp(e.clientX - r.left, 0, r.width);
          c.ghost.style.transform = `translate3d(${x.toFixed(1)}px,0,0)`;
          c.scrub.textContent = fmt((x / r.width) * durOf(c));
          if (!c.scrubW) c.scrubW = c.scrub.offsetWidth || 34;
          c.scrub.style.transform =
            `translate3d(${clamp(x - c.scrubW / 2, 0, Math.max(0, r.width - c.scrubW)).toFixed(1)}px,0,0)`;
        });
      }

      c.wave.addEventListener("keydown", e => {
        const d = durOf(c), t = cur === c ? audio.currentTime : 0;
        let to = null;
        if (e.key === "ArrowRight" || e.key === "ArrowUp")   to = t + 5;
        else if (e.key === "ArrowLeft" || e.key === "ArrowDown") to = t - 5;
        else if (e.key === "Home") to = 0;
        else if (e.key === "End")  to = d;
        else if (e.key === "Enter") { e.preventDefault(); toggle(c); return; }
        if (to === null) return;
        e.preventDefault();
        seek(c, to);
      });
    });

    audio.addEventListener("playing",     () => { setState("PLAYING"); say(`Playing ${cur?.name}`); });
    audio.addEventListener("play",        () => { resumeCtx(); setState("PLAYING"); });
    audio.addEventListener("waiting",     () => setState("LOADING"));
    audio.addEventListener("pause",       () => {
      // Two pauses are not the visitor's: the end-of-clip one (queued, and by
      // the time it runs the rewind has already cleared `audio.ended` — hence
      // the explicit flag), and the one select() fires while swapping clips.
      // For the second, play() has already run synchronously, so the element is
      // no longer paused: a pause event on an unpaused element is stale, and
      // acting on it flickers the transport through PAUSED on every switch.
      if (audio.ended || finished || !audio.paused) return;
      setState("PAUSED"); say("Paused");
    });
    audio.addEventListener("loadedmetadata", () => {
      if (durEl) durEl.textContent = fmt(audio.duration);
      if (cur) cur.dur.textContent = fmt(audio.duration);
      if (pendingSeek !== null) {
        try { audio.currentTime = clamp(pendingSeek, 0, audio.duration - .05); } catch { /* ignore */ }
        pendingSeek = null;
      }
      lastSec = -1; render();
    });
    audio.addEventListener("ended", () => {
      // Deliberately no auto-advance: a visitor who played one clip and walked
      // away should not get two more. Rewind in place so the row is armed again.
      //
      // pause() FIRST, and it is not ceremony: reaching the end does not set
      // `paused`, so seeking back to 0 on a still-unpaused element restarts it —
      // the clip loops forever instead of stopping. Caught by the deck's test
      // run, which found the transport back at 0:02 and PLAYING after the end.
      finished = true;
      audio.pause();
      if (cur) {
        try { audio.currentTime = 0; } catch { /* nothing to rewind */ }
        drawWave(cur, 0);
        cur.head.style.transform = "translate3d(0,0,0)";
      }
      lastSec = -1;
      setState("STANDBY");
      say(`Finished ${cur?.name}`);
      render();
      drawSpec();
    });
    audio.addEventListener("error", () => {
      setState("ERROR");
      say(`${cur?.name} could not be loaded`);
    });

    /* ── canvases follow the layout ───────────────────────────── */
    addEventListener("resize", layout);
    document.fonts?.ready.then(layout);
    // first paint can beat the grid's final column widths; one frame later the
    // rows have their real size
    requestAnimationFrame(layout);
    new IntersectionObserver((es, io) => {
      if (!es.some(e => e.isIntersecting)) return;
      layout(); io.disconnect();
    }, { threshold: 0 }).observe(deck);

    /* One frame's worth of work, called from the page's single rAF loop. */
    function step() {
      if (cur && !audio.paused) { render(); drawSpec(); }
    }
    return { step };
  })();

  /* ────────────────────────────────────────────────────────────
     POINTER KIT — magnetic, tilt, card spotlight
     (no custom cursor: the OS pointer stays native everywhere)
     ──────────────────────────────────────────────────────────── */
  if (finePtr && !reduce) {
    $$("[data-magnetic]").forEach(el => {
      el.addEventListener("pointermove", e => {
        const r = el.getBoundingClientRect();
        el.style.transition = "none";
        el.style.transform =
          `translate(${(e.clientX - r.left - r.width / 2) * 0.22}px,${(e.clientY - r.top - r.height / 2) * 0.3}px)`;
      });
      el.addEventListener("pointerleave", () => {
        el.style.transition = "transform .55s cubic-bezier(.22,1,.36,1)";
        el.style.transform = "";
      });
    });

    $$("[data-tilt]").forEach(el => {
      const inner = el.firstElementChild || el;
      el.addEventListener("pointermove", e => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        inner.style.transition = "transform .1s linear";
        inner.style.transform = `perspective(1400px) rotateY(${(px * 7).toFixed(2)}deg) rotateX(${(-py * 7).toFixed(2)}deg)`;
      });
      el.addEventListener("pointerleave", () => {
        inner.style.transition = "transform .7s cubic-bezier(.22,1,.36,1)";
        inner.style.transform = "";
      });
    });

    $$("[data-card]").forEach(card => card.addEventListener("pointermove", e => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100).toFixed(1) + "%");
      card.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100).toFixed(1) + "%");
    }));
  }

  /* ────────────────────────────────────────────────────────────
     HERO STRINGS — pluckable guitar-string wave sim on canvas
     ──────────────────────────────────────────────────────────── */
  const strings = (() => {
    const canvas = $("#strings");
    if (!canvas || reduce) return { step() {} };
    const ctx = canvas.getContext("2d");
    const N = 96, ROWS = [0.30, 0.52, 0.74];
    let w = 0, h = 0, dpr = 1;
    const ys  = ROWS.map(() => new Float32Array(N));
    const vs  = ROWS.map(() => new Float32Array(N));
    let px = -1, py = -1, hadP = false;

    function resize() {
      const r = canvas.parentElement.getBoundingClientRect();
      dpr = Math.min(devicePixelRatio || 1, 2);
      w = r.width; h = r.height;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    addEventListener("resize", resize);

    canvas.parentElement.addEventListener("pointermove", e => {
      const r = canvas.getBoundingClientRect();
      const nx = e.clientX - r.left, ny = e.clientY - r.top;
      if (hadP) {
        ROWS.forEach((f, s) => {
          const rest = f * h;
          // pluck when the pointer sweeps across a string
          if ((py - rest) * (ny - rest) < 0 || Math.abs(ny - rest) < 16) {
            const idx = clamp(Math.round(nx / w * (N - 1)), 2, N - 3);
            const power = clamp((ny - py) * 0.6, -12, 12);
            for (let k = -4; k <= 4; k++)
              vs[s][idx + clamp(k, 2 - idx, N - 3 - idx)] += power * (1 - Math.abs(k) / 5);
          }
        });
      }
      px = nx; py = ny; hadP = true;
    }, { passive: true });

    // no amber anywhere — the plucked middle string glows ice like the plugin
    const COLORS = ["rgba(240,237,230,.16)", "rgba(159,216,232,.4)", "rgba(240,237,230,.12)"];
    function step(t) {
      ctx.clearRect(0, 0, w, h);
      for (let s = 0; s < ROWS.length; s++) {
        const Y = ys[s], V = vs[s], rest = ROWS[s] * h;
        for (let i = 1; i < N - 1; i++)
          V[i] += 0.42 * (Y[i - 1] + Y[i + 1] - 2 * Y[i]);
        for (let i = 1; i < N - 1; i++) { V[i] *= 0.982; Y[i] += V[i]; }
        ctx.beginPath();
        for (let i = 0; i < N; i++) {
          const x = i / (N - 1) * w;
          const yy = rest + Y[i] + Math.sin(t * 0.0011 + i * 0.32 + s * 2.1) * 1.4;
          i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy);
        }
        ctx.strokeStyle = COLORS[s];
        ctx.lineWidth = s === 1 ? 1.4 : 1;
        ctx.stroke();
      }
    }
    return { step };
  })();

  if (!reduce) {
    const hero = $(".hero");
    if (hero) new IntersectionObserver(es =>
      es.forEach(e => { stringsOn = e.isIntersecting; })).observe(hero);
  }

  /* ────────────────────────────────────────────────────────────
     GO
     ──────────────────────────────────────────────────────────── */
  measure();
  addEventListener("load",   () => measure());
  addEventListener("resize", () => measure());
  mqWide.addEventListener?.("change", () => measure());
  // Display type (Oswald) reflows section heights when it swaps in, which
  // shifts every cached offset below the hero — re-measure once it lands.
  document.fonts?.ready.then(() => measure());
  // Lazy lineup/pedal images settle the section heights too.
  $$(".ampcol__shot img,.pcard__img img").forEach(img => {
    if (img.complete) return;
    img.addEventListener("load", () => measure(), { once: true });
  });
  requestAnimationFrame(frame);
})();
