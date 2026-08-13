/* The sign-in leg, run on a page without cross-origin isolation.
 *
 * Firebase's redirect flow reads its result back through a helper iframe at
 * /__/auth/iframe. That document carries no COEP header, and Hosting serves
 * it from a reserved namespace we cannot add headers to — so inside the rig
 * page, which must run COEP require-corp for the wasm audio engine, it is
 * blocked outright and the result never arrives.
 *
 * Here isolation is off, so the helper loads normally. The session Firebase
 * persists goes to localStorage, shared with the rig on the same origin, so
 * there is nothing to hand back: the rig's onAuthStateChanged simply finds a
 * user when the player lands on it again.
 */

import { auth, makeProvider, authErrorText } from './cloud/fb';
import { getRedirectResult, signInWithRedirect } from 'firebase/auth';

const params = new URLSearchParams(location.search);
const provider = params.get('p') ?? 'google';
// Only ever return to a path on this origin — never to whatever a query
// string asks for, or this page becomes an open redirect.
const back = (() => {
  const r = params.get('r') ?? '/';
  return r.startsWith('/') && !r.startsWith('//') ? r : '/';
})();

/** Guards the one-shot: without it, a redirect that comes back empty would
 *  bounce straight back out to the provider, forever. */
const TRIED = 'remi_signin_tried';

const el = (id: string) => document.getElementById(id)!;
function say(head: string, body: string, bad = false, link = true) {
  el('spin').remove();
  el('head').textContent = head;
  el('body').innerHTML = body + (link ? `<br><a href="${back}">BACK TO THE RIG</a>` : '');
  if (bad) el('w').classList.add('bad');
}

async function run() {
  try {
    const res = await getRedirectResult(auth);
    if (res?.user) {
      sessionStorage.removeItem(TRIED);
      // The session is already in localStorage; the rig reads it on load.
      location.replace(back);
      return;
    }
  } catch (err) {
    sessionStorage.removeItem(TRIED);
    say('That sign-in did not go through', authErrorText(err), true);
    return;
  }

  if (sessionStorage.getItem(TRIED)) {
    sessionStorage.removeItem(TRIED);
    say('The provider sent you back without a sign-in',
        'Nothing was saved, so nothing is half-done — you can try again, or use email '
        + 'on the rig instead. If it keeps happening, a browser extension blocking '
        + 'third-party storage is the usual cause.', true);
    return;
  }

  try {
    sessionStorage.setItem(TRIED, '1');
    await signInWithRedirect(auth, makeProvider(provider));
  } catch (err) {
    sessionStorage.removeItem(TRIED);
    say('Could not start sign-in', authErrorText(err), true);
  }
}

void run();
