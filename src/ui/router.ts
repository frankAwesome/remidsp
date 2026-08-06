/* Addresses.
 *
 * Until now nothing in this product had one. RIG and FEED were a variable in
 * main.ts, so a tone somebody loved could not be sent to anyone, could not be
 * linked from a forum post, and could not be indexed. That is the whole
 * acquisition story, and it was missing.
 *
 * WHY HASH ROUTES, and not clean paths.
 *
 * firebase.json scopes `Cross-Origin-Opener-Policy` and
 * `Cross-Origin-Embedder-Policy` to exactly two sources: `/` and
 * `/index.html`. The NAM wasm is a pthreads/SharedArrayBuffer build, so those
 * two headers are what make the engine able to exist at all.
 *
 * A path route like /t/abc needs a hosting rewrite to serve index.html. The
 * rewritten response is served for the URL /t/abc, which matches NEITHER
 * header source — so the document arrives without COOP/COEP, is not
 * cross-origin isolated, SharedArrayBuffer is undefined, and the wasm fails to
 * instantiate. The rig would break only on shared links, which is the worst
 * possible place for it to break and the hardest to notice in testing.
 *
 * `/#/t/abc` is the same document at `/`. The headers apply, the engine works,
 * and the route is still a real address that can be pasted anywhere.
 *
 * The crawlable, unfurlable twin of each route is server-rendered by the
 * Cloudflare Worker in worker/ — that is what Google, Discord and iMessage
 * see, and its OPEN IN THE RIG button points back here.
 */

export type Route =
  | { view: 'rig' }
  | { view: 'feed' }
  | { view: 'tone'; id: string }
  | { view: 'user'; handle: string }
  | { view: 'profile' };

/** Parse a hash into a route. Anything unrecognised is the rig, because a
 *  broken link should still land somebody somewhere that works. */
export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  if (!h) return { view: 'rig' };
  const [head, ...rest] = h.split('/');
  const arg = decodeURIComponent(rest.join('/') || '');
  switch (head) {
    case 't': return arg ? { view: 'tone', id: arg } : { view: 'feed' };
    case 'u': return arg ? { view: 'user', handle: arg } : { view: 'feed' };
    case 'feed': return { view: 'feed' };
    case 'me': return { view: 'profile' };
    default: return { view: 'rig' };
  }
}

/** The hash a route should live at. */
export function hashFor(r: Route): string {
  switch (r.view) {
    case 'rig': return '#/';
    case 'feed': return '#/feed';
    case 'profile': return '#/me';
    case 'tone': return `#/t/${encodeURIComponent(r.id)}`;
    case 'user': return `#/u/${encodeURIComponent(r.handle)}`;
  }
}

/** An absolute, pasteable URL for a route. */
export function urlFor(r: Route): string {
  return `${location.origin}/${hashFor(r)}`;
}

/** Watch the address bar. Fires immediately with the route the page opened
 *  on, so a deep link is honoured on first paint and not only on later
 *  navigation. */
export function onRoute(fn: (r: Route) => void): () => void {
  const handler = () => fn(parseHash(location.hash));
  window.addEventListener('hashchange', handler);
  handler();
  return () => window.removeEventListener('hashchange', handler);
}

/** Move to a route.
 *
 *  `replace` is for corrections the player did not ask for — landing on a
 *  dead tone id, say. Pushing those would trap Back: the player presses it,
 *  gets sent to the dead link again, and is corrected again forever. */
export function go(r: Route, replace = false) {
  const h = hashFor(r);
  if (location.hash === h) return;
  if (replace) history.replaceState(null, '', h);
  else location.hash = h;
}
