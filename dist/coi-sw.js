/* Cross-origin isolation for GitHub Pages.
 *
 * The rig's NAM engine is a pthreads/SharedArrayBuffer wasm build, and
 * SharedArrayBuffer only exists in a cross-origin-isolated document —
 * which needs two response headers:
 *
 *     Cross-Origin-Opener-Policy:   same-origin
 *     Cross-Origin-Embedder-Policy: require-corp
 *
 * GitHub Pages cannot set response headers at all (that is what
 * firebase.json's hosting rules were for). A service worker can: it
 * re-serves same-origin responses with the headers attached, so the
 * document that registered it becomes isolated on the next load.
 *
 * SCOPE IS THE WHOLE POINT. This is registered for "/play/" only, so the
 * landing page and — critically — /signin.html stay UN-isolated: under
 * require-corp every document in the frame tree needs its own compatible
 * COEP, and Firebase's auth helper iframe carries none, so sign-in can
 * only happen on a page that is not isolated. Same split firebase.json
 * documents, enforced from the client instead of the edge.
 *
 * Same-origin subresources (/assets, /worklet) need no CORP of their own
 * under require-corp, so leaving them outside this scope costs nothing.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // A cache-only request that is not same-origin throws if we touch it.
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Opaque responses carry no readable headers — pass them straight
        // through rather than constructing a broken copy.
        if (res.status === 0) return res;
        const headers = new Headers(res.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      })
      // Network failures must surface as network failures, not as a
      // half-built Response — let the page's own error handling see it.
      .catch((err) => {
        console.error('[coi-sw]', err);
        throw err;
      }),
  );
});
