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
                   "LOADING CAPTURES…", "LEVEL-MATCHING…", "ON AIR"];
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
  const fillA     = $("#fillA"), fillB = $("#fillB");
  const stmt      = $(".statement");
  const ampsSec   = $(".amps");
  const ampFaces  = $$(".amps__face");
  const ampPanels = $$(".amps__panel");
  const ampTabs   = $$("#ampTabs button");
  const ampIndex  = $("#ampIndex");
  const ampRail   = $("#ampRail");
  const ampFrame  = $("#ampFrame");
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
  // cool seafoam, Portland's gold-on-marble, Katahdin's warm carving. Shared by
  // the home rig hero and the Maine amps section, which show the same three amps.
  const AMP_BGS   = ["#05090b", "#0b0906", "#0b0705"];
  const CARD_BGS  = ["#0d0a04", "#0e0704", "#04100f", "#060a12"]; // drive/chorus/delay/reverb
  const BASE_BG   = "#050506";

  const M = { vh: 0, docH: 1, hero: 0, stmtTop: 0, stmtH: 1,
              ampsTop: 0, ampsTravel: 1, boardTop: 0, boardTravel: 1, boardDist: 0,
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
    if (stmt)    { M.stmtTop = top(stmt); M.stmtH = stmt.offsetHeight; }
    if (ampsSec) { M.ampsTop = top(ampsSec); M.ampsTravel = ampsSec.offsetHeight - M.vh; }
    if (boardPin){ M.boardTop = top(boardPin); M.boardTravel = Math.max(1, boardPin.offsetHeight - M.vh); }
    if (ghost)   { const g = $(".download"); M.ghostMid = top(g) + g.offsetHeight / 2; }
    if (marqTracks[0]) M.marqW = marqTracks[0].scrollWidth;
    // theme ranges: every [data-bg] section + amps + board
    M.ranges = [];
    $$("[data-bg],.amps,.board,.rig").forEach(el => {
      M.ranges.push({ top: top(el), bot: top(el) + el.offsetHeight,
                      bg: el.dataset.bg || null,
                      kind: el.classList.contains("amps") ? "amps"
                          : el.classList.contains("board") ? "board"
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
  let ampStage = -1, lastBoardCount = "", marqX = 0, marqDir = -1;
  let stringsOn = false;

  function setBg(bg) {
    if (bg && bg !== curBg) { document.body.style.backgroundColor = curBg = bg; }
  }

  function themeAt(mid, ampP, boardP) {
    for (const r of M.ranges) {
      if (mid < r.top || mid >= r.bot) continue;
      if (r.kind === "amps")  return AMP_BGS[clamp(Math.floor(ampP * 3), 0, 2)];
      if (r.kind === "rig")   return AMP_BGS[clamp(rig.i, 0, 2)];   // page washes with the live head
      if (r.kind === "board") return mqWide.matches ? CARD_BGS[clamp(Math.floor(boardP * 4), 0, 3)] : BASE_BG;
      return r.bg;
    }
    return BASE_BG;
  }

  function setAmpStage(i) {
    if (i === ampStage) return;
    ampStage = i;
    ampFaces.forEach((f, k) => f.classList.toggle("is-active", k === i));
    ampPanels.forEach((p, k) => p.classList.toggle("is-active", k === i));
    ampTabs.forEach((t, k) => { t.classList.toggle("is-active", k === i); t.setAttribute("aria-selected", k === i); });
    if (ampIndex) ampIndex.textContent = pad(i + 1);
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

      /* statement fill — 1:1 with scroll */
      if (fillA) {
        const p = clamp((y + M.vh * 0.78 - M.stmtTop) / (M.stmtH * 0.85), 0, 1);
        const pA = clamp(p * 1.7, 0, 1), pB = clamp(p * 1.7 - 0.6, 0, 1);
        fillA.style.clipPath = `inset(0 ${((1 - pA) * 100).toFixed(2)}% 0 0)`;
        fillB.style.clipPath = `inset(0 ${((1 - pB) * 100).toFixed(2)}% 0 0)`;
      }

      /* amps channel switcher — live rect read (self-correcting vs layout shifts).
         One getBoundingClientRect, read before any style write → no reflow thrash. */
      let ampP = 0;
      if (ampsSec && mqWide.matches) {
        const r = ampsSec.getBoundingClientRect();
        if (r.top < M.vh && r.bottom > 0) {              // section near/at view
          ampP = clamp(-r.top / M.ampsTravel, 0, 1);
          setAmpStage(clamp(Math.floor(ampP * 3), 0, 2));
          if (ampRail)  ampRail.style.transform  = `scaleY(${ampP.toFixed(4)})`;
          if (ampFrame) ampFrame.style.transform = `translate3d(0,${((0.5 - ampP) * 26).toFixed(1)}px,0)`;
          if (ampIndex) ampIndex.style.transform = `translate3d(0,${(-50 + (0.5 - ampP) * 6).toFixed(1)}%,0) translateZ(0)`;
        }
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
        if (marqBand) marqBand.style.transform =
          `rotate(-1.6deg) scale(1.03) skewX(${clamp(vel * 0.05, -5, 5).toFixed(2)}deg)`;
      }

      /* theme morph */
      setBg(themeAt(y + M.vh * 0.5, ampP, boardP));

      /* hero strings */
      if (stringsOn) strings.step(now);
    }

    requestAnimationFrame(frame);
  }

  /* ────────────────────────────────────────────────────────────
     AMP TABS — click to jump (wide: scroll to stage; narrow: swap)
     ──────────────────────────────────────────────────────────── */
  ampTabs.forEach(btn => btn.addEventListener("click", () => {
    const i = +btn.dataset.goto;
    if (mqWide.matches && !reduce) {
      scrollTo({ top: M.ampsTop + M.ampsTravel * (i / 3 + 1 / 6), behavior: "smooth" });
    } else setAmpStage(i);
  }));

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
    // gold-on-marble, Katahdin's warm cherub carving.
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
     STATS — LED odometer count-up
     ──────────────────────────────────────────────────────────── */
  const statIO = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      statIO.unobserve(e.target);
      const el = e.target, target = +el.dataset.count, prefix = el.dataset.prefix || "";
      const render = v => { el.innerHTML = (prefix ? `<span class="stat__pre">${prefix}</span>` : "") + v; };
      if (reduce || target === 0) { render(target); return; }
      const t0 = performance.now(), dur = 1300;
      (function tick(t) {
        const p = clamp((t - t0) / dur, 0, 1);
        render(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(tick);
      })(t0);
    });
  }, { threshold: 0.6 });
  $$("[data-count]").forEach(el => statIO.observe(el));

  /* ────────────────────────────────────────────────────────────
     POINTER KIT — cursor, magnetic, tilt, card spotlight
     ──────────────────────────────────────────────────────────── */
  if (finePtr && !reduce) {
    document.body.classList.add("has-cursor");
    const dot = $(".cursor__dot"), ring = $(".cursor__ring"), cursor = $(".cursor");
    // Both follow directly in the pointer event (no rAF loop, no lerp). The ring's
    // gentle "life" comes from a short CSS transform transition, and it no longer
    // uses mix-blend-mode — that was repainting a blended region every move over
    // the screenshots, which is what read as lag.
    addEventListener("pointermove", e => {
      const t = `translate(${e.clientX}px,${e.clientY}px) translate(-50%,-50%)`;
      dot.style.transform = t; ring.style.transform = t;
    }, { passive: true });
    const HOT = "a,button,.pcard,.feature,.dcard";
    document.addEventListener("pointerover", e => { if (e.target.closest(HOT)) cursor.classList.add("is-hot"); });
    document.addEventListener("pointerout",  e => { if (e.target.closest(HOT)) cursor.classList.remove("is-hot"); });

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

    const COLORS = ["rgba(240,237,230,.16)", "rgba(224,168,78,.42)", "rgba(240,237,230,.12)"];
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
  // Lazy amp/pedal images settle the sticky-section heights too.
  $$(".amps__face,.pcard__img img").forEach(img => {
    if (img.complete) return;
    img.addEventListener("load", () => measure(), { once: true });
  });
  requestAnimationFrame(frame);
})();
