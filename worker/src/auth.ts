/* Verifying a Firebase ID token inside a Cloudflare Worker.
 *
 * There is no Admin SDK here, so this does what the Admin SDK does: fetch
 * Google's public signing keys, check the RS256 signature, then check every
 * claim that matters. All four of the claim checks below have been the subject
 * of real-world auth bypasses, so none of them is optional:
 *
 *   alg   — must be RS256 from the header. A token declaring "none", or
 *           declaring HS256 so the public key is treated as an HMAC secret,
 *           is the textbook JWT forgery and both are refused here.
 *   iss   — https://securetoken.google.com/<projectId>. Without this, a token
 *           minted by ANY Firebase project on earth would be accepted.
 *   aud   — <projectId>. Same reasoning from the other direction.
 *   exp   — with a small skew allowance, because client clocks are wrong.
 *
 * Keys are cached in module scope for the isolate's lifetime, bounded by the
 * cache-control max-age Google sends, so this is one fetch per isolate rather
 * than one per upload.
 */

const JWK_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

interface Jwk { kid: string; n: string; e: string; alg?: string; kty: string }

let keyCache: { keys: Map<string, CryptoKey>; expires: number } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function signingKeys(): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (keyCache && keyCache.expires > now) return keyCache.keys;

  const res = await fetch(JWK_URL);
  if (!res.ok) throw new Error('could not fetch Google signing keys');
  const body = await res.json() as { keys: Jwk[] };

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA') continue;
    keys.set(jwk.kid, await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    ));
  }
  // Respect Google's own rotation window rather than inventing one.
  const cc = res.headers.get('cache-control') ?? '';
  const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? 3600);
  keyCache = { keys, expires: now + Math.min(maxAge, 86400) * 1000 };
  return keys;
}

export interface VerifiedUser { uid: string; email?: string }

/** Verify a Firebase ID token, or throw. Returns the uid it genuinely
 *  belongs to — never a uid the client asserted. */
export async function verifyIdToken(token: string, projectId: string): Promise<VerifiedUser> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [rawHeader, rawPayload, rawSig] = parts;

  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawHeader)));
  // Refuse anything that is not RS256 BEFORE touching a key. "alg: none" and
  // algorithm-confusion attacks both die here.
  if (header.alg !== 'RS256') throw new Error('unexpected token algorithm');
  if (!header.kid) throw new Error('token has no key id');

  const keys = await signingKeys();
  const key = keys.get(header.kid);
  if (!key) throw new Error('unknown signing key');

  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(rawSig) as BufferSource, signed);
  if (!ok) throw new Error('bad token signature');

  const p = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawPayload)));
  const now = Math.floor(Date.now() / 1000);
  const SKEW = 60;                       // client clocks are routinely wrong

  if (p.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('wrong issuer');
  if (p.aud !== projectId) throw new Error('wrong audience');
  if (typeof p.exp !== 'number' || p.exp + SKEW < now) throw new Error('token expired');
  if (typeof p.iat === 'number' && p.iat - SKEW > now) throw new Error('token issued in the future');
  if (!p.sub) throw new Error('token has no subject');

  return { uid: String(p.sub), email: p.email ? String(p.email) : undefined };
}
