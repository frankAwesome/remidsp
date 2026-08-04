import { defineConfig } from 'vite';

// The worklet + wasm live in public/ and load at runtime via
// audioWorklet.addModule / fetch — Vite must not try to bundle them.
export default defineConfig({
  server: {
    port: 5199,
    headers: {
      // The NAM wasm module is a pthread/SharedArrayBuffer build — the page
      // must be cross-origin isolated. Tone3000 API/storage send ACAO:* so
      // CORS-mode fetches and crossorigin="anonymous" images still work.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: { target: 'es2022', assetsInlineLimit: 0 },
});
