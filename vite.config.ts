import { defineConfig } from 'vite';

// The worklet + wasm live in public/ and load at runtime via
// audioWorklet.addModule / fetch — Vite must not try to bundle them.
// The NAM wasm module is a pthread/SharedArrayBuffer build, so the rig page
// must be cross-origin isolated. Tone3000 API/storage send ACAO:* so CORS-mode
// fetches and crossorigin="anonymous" images still work.
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/* /signin.html must NOT be isolated: it exists to load Firebase's auth helper
 * iframe, which carries no COEP header of its own and is therefore blocked
 * inside a require-corp document. Hosting does the same exclusion in
 * firebase.json; this keeps dev honest so the flow can be tested locally
 * instead of only after a deploy. */
type Res = { setHeader: (k: string, v: string) => unknown };
type Srv = { middlewares: { use: (f: unknown) => void } };

/* Setting the headers here cannot work: Vite applies server.headers from its
 * own middleware, and the static-file middleware ends the response, so there
 * is no slot both after Vite's write and before the body is sent. Instead this
 * runs FIRST and makes the response refuse the two isolation headers outright,
 * so whoever writes them later is simply ignored.
 *
 * Braces on the arrow are load-bearing: connect's .use() returns the app, and
 * a value returned from configureServer is treated by Vite as a post-hook and
 * invoked with no arguments. */
const strip = (s: Srv): void => { s.middlewares.use(
  (req: { url?: string }, res: Res, next: () => void) => {
    if (req.url?.startsWith('/signin.html')) {
      const set = res.setHeader.bind(res);
      res.setHeader = (k: string, v: string) =>
        (/^cross-origin-(opener|embedder)-policy$/i.test(k) ? res : set(k, v));
    }
    next();
  }); };

const unisolateSignin = {
  name: 'unisolate-signin',
  configureServer: strip,
  configurePreviewServer: strip,
};

export default defineConfig({
  plugins: [unisolateSignin],
  server: { port: 5199, headers: ISOLATION },
  preview: { headers: ISOLATION },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: { input: { main: 'index.html', signin: 'signin.html' } },
  },
});
