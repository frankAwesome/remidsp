/* TONE3000 API client — the world's NAM capture library, straight into the amp.
 *
 *  · GET /api/v1/tones/trending           — anonymous, CORS-open (top 10, ?gear=)
 *  · everything else (search/latest/models/model_url) — OAuth 2.0 PKCE with a
 *    publishable key (t3k_pub_…) created free at tone3000.com → Settings → API Keys.
 *    Localhost redirect URIs are auto-allowed in dev.
 *
 *  Terms: per-user delivery, no bulk caching, keep creator attribution +
 *  licenses visible, "Powered by TONE3000". https://www.tone3000.com/api/terms
 */

const API = 'https://www.tone3000.com/api/v1';

/* ── where a capture may legitimately live ────────────────────────────────
 *
 * A capture url on a preset is attacker-controlled: anyone can share a tone
 * whose capture.modelUrl points anywhere they like. Two separate rules keep
 * that harmless, and they are deliberately not the same rule:
 *
 *   safeModelUrl()   — may we FETCH it at all? https only, no credentials
 *                      embedded in the url, no loopback or private address.
 *   isTone3000Host() — may it see the BEARER TOKEN? tone3000.com only.
 *
 * Keeping them apart is what lets TONE3000's pre-signed storage urls keep
 * working (they authenticate themselves through the query string) without
 * ever being trusted with the player's session. */

const T3K_HOSTS = ['tone3000.com', 'www.tone3000.com'];

/** True when the token may ride along — an exact host match, never a suffix
 *  test. `endsWith('tone3000.com')` would also accept `eviltone3000.com`. */
function isTone3000Host(u: URL): boolean {
  return T3K_HOSTS.includes(u.hostname.toLowerCase());
}

/** Parse and vet a capture url, or null when it must not be fetched. */
function safeModelUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  // `https://user:pass@host/` — credentials in a url are never legitimate
  // here, and some fetch stacks forward them.
  if (u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  // No pointing the app at things only this machine can reach. Cloud
  // metadata endpoints and dev servers both live behind names like these.
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0'
      || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)
      || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
      || h.startsWith('[')) return null;
  return u;
}
const LS_KEY = 't3k_pub_key';
const LS_TOKENS = 't3k_tokens';
// Publishable key (t3k_pub_… — safe for browser code by design; the secret
// key never leaves tone3000.com). Override via the CONNECT prompt if needed.
const DEFAULT_PUB_KEY = 't3k_pub_BGEnQopyUb7-rabiGgkTTAP1tpNCEKep';

export type Gear = 'amp' | 'amp-cab' | 'pedal' | 'outboard' | 'cab' | 'space' | 'experimental';

export interface T3kUser { id: string; username: string; avatar_url?: string; url?: string }
export interface Tone {
  id: number;
  title: string;
  description?: string;
  gear: Gear;
  format: string;
  license: string;
  images: string[];
  models_count: number;
  a1_models_count: number;
  a2_models_count: number;
  irs_count: number;
  downloads_count: number;
  favorites_count: number;
  user: T3kUser;
  url: string;
  makes?: { id: number; name: string }[];
  tags?: { id: number; name: string }[];
}
export interface T3kModel {
  id: number;
  model_url: string;
  name: string;
  size: string;
  architecture_version: '1' | '2' | 'custom';
  tone_id: number;
}
interface Tokens { access_token: string; refresh_token: string; expires_at: number }

/** Why a TONE3000 call failed, in terms a player can act on. */
export type T3kFailure =
  | 'not-connected'   // never signed in, or the capture is not public
  | 'auth'            // signed in once, token is dead — reconnect
  | 'network'         // offline, DNS, CORS, TONE3000 down
  | 'missing'         // the creator took the capture down
  | 'unknown';

export class T3kError extends Error {
  readonly reason: T3kFailure;
  constructor(message: string, reason: T3kFailure) {
    super(message);
    this.name = 'T3kError';
    this.reason = reason;
  }
}

export class Tone3000 {
  get pubKey(): string { return localStorage.getItem(LS_KEY) ?? DEFAULT_PUB_KEY; }
  set pubKey(k: string) { localStorage.setItem(LS_KEY, k.trim()); }
  /** True when the player pasted their own key over the baked-in default. */
  get hasCustomKey(): boolean { return !!localStorage.getItem(LS_KEY); }
  clearKey() { localStorage.removeItem(LS_KEY); }
  /** Masked form for display: t3k_pub_AB…YZ */
  get maskedKey(): string {
    const k = this.pubKey;
    return k.length > 16 ? `${k.slice(0, 10)}…${k.slice(-4)}` : k;
  }

  private get tokens(): Tokens | null {
    try { return JSON.parse(localStorage.getItem(LS_TOKENS) ?? 'null'); } catch { return null; }
  }
  private set tokens(t: Tokens | null) {
    if (t) localStorage.setItem(LS_TOKENS, JSON.stringify(t));
    else localStorage.removeItem(LS_TOKENS);
  }
  get connected(): boolean { return !!this.tokens; }
  disconnect() { this.tokens = null; }

  /* ---- anonymous ---- */
  async trending(gear?: Gear): Promise<Tone[]> {
    const url = `${API}/tones/trending${gear ? `?gear=${gear}` : ''}`;
    let r: Response;
    try {
      r = await fetch(url);
    } catch (err) {
      throw new T3kError((err as Error).message, 'network');
    }
    if (!r.ok) throw new T3kError(`TONE3000 returned ${r.status}`, 'unknown');
    return (await r.json()).data as Tone[];
  }

  /* ---- OAuth PKCE (mirrors the official tone3000-client.ts flow) ---- */
  async connect(): Promise<void> {
    if (!this.pubKey) throw new Error('no publishable key');
    const verifier = this.b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = await this.s256(verifier);
    const state = this.b64url(crypto.getRandomValues(new Uint8Array(16)));
    sessionStorage.setItem('t3k_verifier', verifier);
    sessionStorage.setItem('t3k_state', state);
    const redirect = `${location.origin}/t3k-callback.html`;
    const u = new URL(`${API}/oauth/authorize`);
    u.searchParams.set('client_id', this.pubKey);
    u.searchParams.set('redirect_uri', redirect);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', state); // required — omitting it is an invalid request
    const popup = window.open(u.toString(), 't3k_auth', 'width=520,height=720');
    const code = await new Promise<string>((res, rej) => {
      const bc = new BroadcastChannel('t3k_oauth');
      const timer = setTimeout(() => { bc.close(); rej(new Error('sign-in timed out')); }, 300000);
      bc.onmessage = (e) => {
        const d = e.data ?? {};
        clearTimeout(timer); bc.close();
        if (d.state !== state) rej(new Error('state mismatch — try again'));
        else if (d.error) rej(new Error(d.error));
        else if (d.canceled || !d.code) rej(new Error('sign-in cancelled'));
        else res(d.code);
      };
    });
    popup?.close();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: sessionStorage.getItem('t3k_verifier') ?? '',
      redirect_uri: redirect,
      client_id: this.pubKey,
    });
    const r = await fetch(`${API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) throw new Error(`token exchange failed (${r.status})`);
    const j = await r.json();
    this.tokens = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 - 60000,
    };
  }

  private async accessToken(): Promise<string> {
    let t = this.tokens;
    if (!t) throw new T3kError('not connected to TONE3000', 'not-connected');
    if (Date.now() > t.expires_at && t.refresh_token) {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: this.pubKey,
      });
      const r = await fetch(`${API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!r.ok) { this.tokens = null; throw new T3kError('session expired — reconnect', 'auth'); }
      const j = await r.json();
      t = {
        access_token: j.access_token,
        refresh_token: j.refresh_token ?? t.refresh_token,
        expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 - 60000,
      };
      this.tokens = t;
    }
    return t.access_token;
  }

  private async authed(path: string): Promise<Response> {
    const tok = await this.accessToken();
    let r: Response;
    try {
      r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
    } catch (err) {
      throw new T3kError((err as Error).message, 'network');
    }
    if (r.status === 401) { this.tokens = null; throw new T3kError('session expired — reconnect', 'auth'); }
    if (!r.ok) throw new T3kError(`TONE3000 returned ${r.status}`, 'unknown');
    return r;
  }

  /* ---- authed catalog ---- */
  async latest(): Promise<Tone[]> {
    return (await (await this.authed('/tones/latest')).json()).data as Tone[];
  }
  async search(opts: {
    query?: string; page?: number; sort?: 'best-match' | 'newest' | 'trending' | 'downloads-all-time';
    gears?: string; format?: 'nam' | 'ir';
  }): Promise<{ data: Tone[]; page: number; total_pages: number }> {
    const u = new URLSearchParams();
    if (opts.query) u.set('query', opts.query);
    u.set('page', String(opts.page ?? 1));
    u.set('page_size', '25');
    u.set('sort', opts.sort ?? 'trending');
    if (opts.gears) u.set('gears', opts.gears);
    if (opts.format) u.set('format', opts.format);
    return (await this.authed(`/tones/search?${u}`)).json();
  }
  async models(toneId: number, architecture?: 1 | 2): Promise<T3kModel[]> {
    const u = new URLSearchParams({ tone_id: String(toneId), page_size: '300' });
    if (architecture) u.set('architecture', String(architecture));
    return ((await (await this.authed(`/models?${u}`)).json()).data ?? []) as T3kModel[];
  }
  /** Fetch a model file (NAM json text, or binary for IR wavs). Throws a
   *  T3kError so callers can tell "you need to sign in" apart from "TONE3000
   *  is down" apart from "the creator deleted it" — three very different
   *  things to tell a player whose preset just failed to load. */
  async fetchModelFile(modelUrl: string, opts: { trusted?: boolean } = {}): Promise<Response> {
    // WHERE this url came from decides whether it may see the token.
    //
    // A model url reaches here two ways. From the TONE3000 API, which is the
    // only thing that knows the real storage host — that url is TRUSTED and
    // keeps its Bearer header exactly as before, so browsing and loading
    // captures behave identically to how they always have.
    //
    // Or off a PRESET SHARED BY A STRANGER, where the url is whatever they
    // typed and the rules only ever checked its length. Sending the token
    // there handed that player's TONE3000 session to whoever posted the tone.
    // Those are fetched anonymously; a real TONE3000 storage url is
    // pre-signed and authenticates itself, so honest presets still load.
    const target = safeModelUrl(modelUrl);
    if (!target) throw new T3kError('that capture link is not a usable address', 'missing');
    const mayAuth = opts.trusted === true || isTone3000Host(target);
    const tok = mayAuth ? await this.accessToken().catch(() => null) : null;
    let r: Response;
    try {
      r = await fetch(target.href, tok ? { headers: { Authorization: `Bearer ${tok}` } } : undefined);
    } catch (err) {
      // A blocked cross-origin fetch and a dead network look identical from
      // here; if we never had a token, the sign-in is the likelier fix.
      throw new T3kError((err as Error).message, tok ? 'network' : 'not-connected');
    }
    if (r.status === 401 || r.status === 403) {
      if (!tok) throw new T3kError('this capture is not public', 'not-connected');
      this.tokens = null;
      throw new T3kError('TONE3000 session expired', 'auth');
    }
    if (r.status === 404 || r.status === 410) {
      throw new T3kError('the capture is no longer on TONE3000', 'missing');
    }
    if (!r.ok) throw new T3kError(`TONE3000 returned ${r.status}`, 'unknown');
    return r;
  }

  /* ---- helpers ---- */
  private b64url(buf: Uint8Array): string {
    return btoa(String.fromCharCode(...buf))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  private async s256(v: string): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    return this.b64url(new Uint8Array(d));
  }
}

export const t3k = new Tone3000();
