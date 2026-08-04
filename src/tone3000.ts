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
const LS_KEY = 't3k_pub_key';
const LS_TOKENS = 't3k_tokens';

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

export class Tone3000 {
  get pubKey(): string { return localStorage.getItem(LS_KEY) ?? ''; }
  set pubKey(k: string) { localStorage.setItem(LS_KEY, k.trim()); }

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
    const r = await fetch(url);
    if (!r.ok) throw new Error(`trending ${r.status}`);
    return (await r.json()).data as Tone[];
  }

  /* ---- OAuth PKCE ---- */
  async connect(): Promise<void> {
    if (!this.pubKey) throw new Error('no publishable key');
    const verifier = this.randomString(64);
    const challenge = await this.s256(verifier);
    sessionStorage.setItem('t3k_verifier', verifier);
    const redirect = `${location.origin}/t3k-callback.html`;
    const u = new URL(`${API}/oauth/authorize`);
    u.searchParams.set('client_id', this.pubKey);
    u.searchParams.set('redirect_uri', redirect);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    const popup = window.open(u.toString(), 't3k_auth', 'width=520,height=720');
    const code = await new Promise<string>((res, rej) => {
      const bc = new BroadcastChannel('t3k_oauth');
      const timer = setTimeout(() => { bc.close(); rej(new Error('sign-in timed out')); }, 300000);
      bc.onmessage = (e) => {
        clearTimeout(timer); bc.close();
        if (e.data?.code) res(e.data.code);
        else rej(new Error(e.data?.error ?? 'sign-in cancelled'));
      };
    });
    popup?.close();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.pubKey,
      redirect_uri: redirect,
      code_verifier: sessionStorage.getItem('t3k_verifier') ?? '',
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
    if (!t) throw new Error('not connected');
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
      if (!r.ok) { this.tokens = null; throw new Error('session expired — reconnect'); }
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
    const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (r.status === 401) { this.tokens = null; throw new Error('session expired — reconnect'); }
    if (!r.ok) throw new Error(`TONE3000 ${r.status}`);
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
  /** Fetch a model file (NAM json text, or binary for IR wavs). */
  async fetchModelFile(modelUrl: string): Promise<Response> {
    const tok = await this.accessToken().catch(() => null);
    const r = await fetch(modelUrl, tok ? { headers: { Authorization: `Bearer ${tok}` } } : undefined);
    if (!r.ok) throw new Error(`model download ${r.status}`);
    return r;
  }

  /* ---- helpers ---- */
  private randomString(len: number): string {
    const a = new Uint8Array(len);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[b % 66]).join('');
  }
  private async s256(v: string): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    return btoa(String.fromCharCode(...new Uint8Array(d)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}

export const t3k = new Tone3000();
