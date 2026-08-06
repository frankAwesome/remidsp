/* Firebase bootstrap — auth + Firestore for the optional account layer.
 * The rig never requires an account; everything here is additive.
 *
 * Auth uses the REDIRECT flow: the page is cross-origin isolated (COOP
 * same-origin for the wasm build), which breaks signInWithPopup's
 * opener channel. On the production host the auth handler is served
 * same-origin by Firebase Hosting (/__/auth/*), so the redirect flow is
 * clean; on localhost, provider sign-in is limited — use email/password
 * in dev and test providers on the live URL. */

import { initializeApp } from 'firebase/app';
import {
  initializeAuth, onAuthStateChanged, signOut as fbSignOut,
  indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence,
  GoogleAuthProvider,
  signInWithRedirect, getRedirectResult, browserPopupRedirectResolver,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile as updateAuthProfile,
  type User, type AuthProvider,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

/* authDomain — the origin that hosts the OAuth handler at /__/auth/handler.
 *
 * Whatever this is set to, the SDK asks Google for a redirect_uri of
 * https://<authDomain>/__/auth/handler, and Google rejects any value that is
 * not registered on the OAuth client — "Error 400: redirect_uri_mismatch".
 *
 * Firebase only auto-registers the PROJECT's domain, remidsp-98208.firebaseapp.com.
 * The hosting site is a separate site (remidsp-maine), and its handler URL is
 * NOT registered, even though the site serves a perfectly good handler. So
 * pointing this at location.hostname on production — which is what it used to
 * do — asked Google for a URI nobody had authorised, and every Google sign-in
 * died at the consent screen.
 *
 * Same-origin is still the better end state. The redirect flow finishes by
 * reading its result back through an iframe on authDomain, and Safari's ITP
 * and Chrome's storage partitioning can cut that off when authDomain is a
 * different origin from the app. To move to it, do BOTH of these and flip the
 * flag below:
 *
 *   1. Google Cloud Console → APIs & Services → Credentials → the OAuth 2.0
 *      client "Web client (auto created by Google Service)" → Authorized
 *      redirect URIs → add  https://remidsp-maine.web.app/__/auth/handler
 *   2. Firebase Console → Authentication → Settings → Authorized domains →
 *      confirm remidsp-maine.web.app is listed.
 *
 * Until step 1 exists, this MUST stay false or sign-in breaks again.
 */
const SAME_ORIGIN_AUTH = false;
const PROD_HOSTS = ['remidsp-maine.web.app', 'remidsp-maine.firebaseapp.com'];

const app = initializeApp({
  apiKey: 'AIzaSyCc5q1QVR5KlV3khzwCryrO0ScB6P-D1xY',
  authDomain: SAME_ORIGIN_AUTH && PROD_HOSTS.includes(location.hostname)
    ? location.hostname
    : 'remidsp-98208.firebaseapp.com',
  projectId: 'remidsp-98208',
  appId: '1:5196542133:web:830fc79f654c91bf22cefc',
});

// localStorage FIRST, then IndexedDB, then memory. Firebase defaults to
// IndexedDB, which fails the whole sign-in with "Database is closing" if the
// connection dies mid-write (a reload in flight, private-mode quirks, an
// evicted origin) — and it fails AFTER the account was created server-side,
// the worst possible moment. Listing IDB as a fallback isn't enough: the
// chain only picks a store at init, so a database that is healthy then and
// broken later still takes sign-in down. A session token is a few hundred
// bytes; synchronous localStorage carries it without that failure mode.
//
// The resolver has to be named explicitly. getAuth() quietly bundles
// browserPopupRedirectResolver for you; initializeAuth() wires ONLY what it
// is handed, and the redirect flow is not part of the default set. Leave it
// out and every provider sign-in dies on `auth/argument-error` — on both
// legs, because getRedirectResult needs the same dependency to read the
// result back. Email/password never touches it, which is what made this look
// like a Google-only problem.
export const auth = initializeAuth(app, {
  persistence: [browserLocalPersistence, indexedDBLocalPersistence, inMemoryPersistence],
  popupRedirectResolver: browserPopupRedirectResolver,
});
export const db = getFirestore(app);
export type { User };

// Google is the only federated provider. Apple, GitHub and Facebook each
// carry their own console setup, review and (for Apple) a paid developer
// account, and none of them was earning that upkeep — email/password covers
// everyone who does not want a Google account.
const PROVIDERS: Record<string, () => AuthProvider> = {
  google: () => new GoogleAuthProvider(),
};

export function signInWithProvider(key: string): Promise<never> {
  const make = PROVIDERS[key];
  if (!make) throw new Error(`unknown provider ${key}`);
  return signInWithRedirect(auth, make());
}

export async function emailSignIn(email: string, password: string): Promise<User> {
  return (await signInWithEmailAndPassword(auth, email, password)).user;
}

export async function emailSignUp(email: string, password: string, username: string): Promise<User> {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  // The auth-state listener fires the instant the account exists — before
  // this update lands — so ensureProfile would otherwise stamp the profile
  // with the email prefix and the name the player typed would be lost. The
  // caller re-saves the profile with `username` after this resolves.
  if (username) await updateAuthProfile(cred.user, { displayName: username });
  return cred.user;
}

export function resetPassword(email: string): Promise<void> {
  return sendPasswordResetEmail(auth, email);
}

export function signOut(): Promise<void> {
  return fbSignOut(auth);
}

export function onUser(cb: (u: User | null) => void): void {
  onAuthStateChanged(auth, cb);
}

/** Surface a provider redirect result (or its error) once per page load. */
export async function consumeRedirect(): Promise<User | null> {
  const res = await getRedirectResult(auth);
  return res?.user ?? null;
}

/** Human message for the auth error codes players will actually hit. */
export function authErrorText(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  const map: Record<string, string> = {
    'auth/operation-not-allowed': 'that sign-in method is not switched on in the Firebase console yet',
    'auth/email-already-in-use': 'that email already has an account — sign in instead',
    'auth/invalid-credential': 'wrong email or password',
    'auth/weak-password': 'password needs at least 6 characters',
    'auth/invalid-email': 'that email does not look right',
    'auth/unauthorized-domain': 'this domain is not authorized for sign-in',
  };
  return map[code] ?? (err as Error)?.message ?? 'sign-in failed';
}
