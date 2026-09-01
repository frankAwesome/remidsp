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

  /* the film ships with a data-src, not a src, so that nothing downloads
     until it is wanted — see the note on the <video> in index.html */
  const attach = v => { if (v.dataset.src) { v.src = v.dataset.src; delete v.dataset.src; } };

  /* reduced motion: the film must not run on its own — hand it a transport.
     Attaching the src costs nothing here: preload="none" means the browser
     fetches only once the visitor works the transport. */
  if (reduce) $$("video[autoplay]").forEach(v => {
    v.removeAttribute("autoplay"); v.pause?.(); v.controls = true; attach(v);
  });
  /* otherwise keep the film running whenever it's on screen — browsers park
     offscreen/backgrounded loops and don't always resume them on their own.
     The same observer does the fetching: rootMargin buys the download a head
     start so the loop is running by the time the frame is properly in view. */
  if (!reduce) $$("video[autoplay]").forEach(v =>
    new IntersectionObserver(es => es.forEach(e => {
      if (e.isIntersecting) { attach(v); v.play().catch(() => {}); }
      else v.pause();
    }), { threshold: 0.15, rootMargin: "400px 0px" }).observe(v));

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
    const ledsEl = $("#bootLeds");
    const LEDS = 26;
    for (let i = 0; i < LEDS; i++) ledsEl.appendChild(document.createElement("i"));
    const leds = [...ledsEl.children];

    /* Every image on the page loads eagerly now; the bar tracks what has
       actually arrived rather than acting out a load. `error` counts too —
       a missing render should not hold the door. The cap still guarantees
       nobody is ever trapped behind the overlay on a slow connection.
       Wordless by design: no counter, no status copy — the mark and a
       filling LED rack say everything. */
    const imgs = [...document.images];
    let loadedN = imgs.filter(i => i.complete).length;
    imgs.forEach(i => {
      if (i.complete) return;
      const done = () => { loadedN++; };
      i.addEventListener("load",  done, { once: true });
      i.addEventListener("error", done, { once: true });
    });
    let fontsIn = false;
    document.fonts?.ready.then(() => { fontsIn = true; });

    let ready = false;
    setTimeout(() => { ready = true; }, 3800); // never trap the visitor

    const t0 = performance.now();
    let shown = 0;
    (function tick(t) {
      const el = t - t0;
      const real = (imgs.length ? loadedN / imgs.length : 1) * (fontsIn ? 1 : 0.92);
      if (real >= 1 && el > 700) ready = true;
      // the bar answers to the network: a floor eases it off zero, real
      // progress carries it, and only `ready` may fill the rack
      const target = ready ? 100 : Math.min(99, Math.max(real * 100, 12 * Math.min(el / 700, 1)));
      shown = Math.min(100, lerp(shown, target, ready ? 0.25 : 0.14));
      const on = Math.round((shown / 100) * LEDS);
      leds.forEach((l, i) => l.classList.toggle("on", i < on));
      if (shown >= 99.6 && el > 700) {
        boot.classList.add("is-done");
        sessionStorage.setItem("remiBoot", "1");
        initReveals();
        setTimeout(() => boot.classList.add("is-gone"), 800);
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
  const deckEl    = $("#deck");
  const deckCards = $$(".deckcard");
  const ghost     = $(".download__ghost");
  const vuNeedle  = $("#vuNeedle");
  const marqBand  = $(".marquee__band");
  const marqTracks= $$(".marquee__track");

  // Camden / Portland / Katahdin — keyed to each head's own colour: Camden's
  // cool seafoam, Portland's gold-on-black, Katahdin's warm carving. The hero
  // reel washes the page with whichever head is live.
  const AMP_BGS   = ["#edf6f4", "#f6f2e9", "#f6efe8"];
  const CARD_BGS  = ["#f7f2e4", "#f7efe7", "#e9f4f3", "#eaf1f8"]; // drive/chorus/delay/reverb
  const BASE_BG   = "#f6f8fa";

  const M = { vh: 0, docH: 1, hero: 0,
              deck: [], ghostMid: 0, marqW: 1, ranges: [] };

  function measure() {
    M.vh = innerHeight;
    const top = el => el.getBoundingClientRect().top + scrollY;
    M.docH   = document.documentElement.scrollHeight - M.vh;
    M.hero   = M.vh;
    // Deck geometry: layout tops are derived from the (static) container plus
    // accumulated card heights — a stuck card's own rect lies about where it
    // lives, its flow position doesn't. sTop is the resolved sticky offset.
    if (deckEl && deckCards.length) {
      const gap = parseFloat(getComputedStyle(deckEl).rowGap) || 0;
      let cy = top(deckEl);
      M.deck = deckCards.map(el => {
        const g = { el, top: cy, h: el.offsetHeight,
                    sTop: parseFloat(getComputedStyle(el).top) || 0, cover: -1 };
        cy += g.h + gap;
        return g;
      });
    }
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
  let deckIdx = 0, marqX = 0, marqDir = -1;
  let stringsOn = false;

  function setBg(bg) {
    if (bg && bg !== curBg) { document.body.style.backgroundColor = curBg = bg; }
  }

  function themeAt(mid) {
    for (const r of M.ranges) {
      if (mid < r.top || mid >= r.bot) continue;
      if (r.kind === "rig")   return AMP_BGS[clamp(rig.i, 0, 2)];   // page washes with the live head
      if (r.kind === "board") return CARD_BGS[clamp(deckIdx, 0, CARD_BGS.length - 1)];
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

      /* the deck — each settled card sinks and dims as the next lands on it.
         Sticky does the pinning; this only feeds --cover from cached geometry. */
      if (M.deck.length > 1) {
        deckIdx = 0;
        for (let i = 0; i < M.deck.length; i++) {
          const cur = M.deck[i];
          if (y >= cur.top - cur.sTop) deckIdx = i;      // card i has locked in
          if (i === M.deck.length - 1) break;
          const nxt = M.deck[i + 1];
          // nxt's top edge travels from cur's stuck bottom down to its own stick line
          const start = nxt.top - (cur.sTop + cur.h);
          const end   = nxt.top - nxt.sTop;
          const c = clamp((y - start) / Math.max(1, end - start), 0, 1);
          if (c !== cur.cover) { cur.cover = c; cur.el.style.setProperty("--cover", c.toFixed(3)); }
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
      setBg(themeAt(y + M.vh * 0.5));

      /* hero strings */
      if (stringsOn) strings.step(now);
    }

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

    // ink hairlines on paper — the plucked middle string runs the plugin blue
    const COLORS = ["rgba(11,16,24,.12)", "rgba(27,132,173,.4)", "rgba(11,16,24,.09)"];
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
  $$(".ampcol__shot img,.deckcard__img img").forEach(img => {
    if (img.complete) return;
    img.addEventListener("load", () => measure(), { once: true });
  });
  requestAnimationFrame(frame);
})();
