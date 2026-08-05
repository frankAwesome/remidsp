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
  GoogleAuthProvider, OAuthProvider, GithubAuthProvider, FacebookAuthProvider,
  signInWithRedirect, getRedirectResult,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile as updateAuthProfile,
  type User, type AuthProvider,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const PROD_HOSTS = ['remidsp-maine.web.app', 'remidsp-maine.firebaseapp.com'];

const app = initializeApp({
  apiKey: 'AIzaSyCc5q1QVR5KlV3khzwCryrO0ScB6P-D1xY',
  authDomain: PROD_HOSTS.includes(location.hostname) ? location.hostname : 'remidsp-98208.firebaseapp.com',
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
export const auth = initializeAuth(app, {
  persistence: [browserLocalPersistence, indexedDBLocalPersistence, inMemoryPersistence],
});
export const db = getFirestore(app);
export type { User };

const PROVIDERS: Record<string, () => AuthProvider> = {
  google: () => new GoogleAuthProvider(),
  apple: () => new OAuthProvider('apple.com'),
  github: () => new GithubAuthProvider(),
  facebook: () => new FacebookAuthProvider(),
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
