/* The account layer — a right-hand drawer in the same editorial language as
 * the captures browser. Signed out: Google + the usual providers + email
 * sign-in/up (all optional — the rig never needs an account). Signed in:
 * profile (avatar · username · bio) and MY SOUNDS, the cloud preset library. */

import {
  onUser, signInWithProvider, emailSignIn, emailSignUp,
  resetPassword, signOut, authErrorText, type User,
} from '../cloud/fb';
import {
  ensureProfile, saveProfile, handleProblem, handleAvailable, HandleTakenError,
  type Profile,
} from '../cloud/store';
import { toast } from './toast';
import { BRAND_MARKS, PROVIDER_LABEL } from './brandMarks';
import { ICONS } from './icons';

export const session: { user: User | null; profile: Profile | null } = { user: null, profile: null };

export class AccountUI {
  root: HTMLElement;
  chip: HTMLButtonElement;
  private body: HTMLElement;
  private openProfile: () => void;
  onSessionChange: (() => void) | null = null;

  constructor(openProfile: () => void) {
    this.openProfile = openProfile;
    this.chip = document.createElement('button');
    this.chip.className = 'hdr__btn account-chip';
    this.chip.textContent = 'SIGN IN';
    // signed out the chip opens the auth drawer; signed in it IS your profile
    this.chip.addEventListener('click', () => (session.user ? this.openProfile() : this.open()));

    this.root = document.createElement('div');
    this.root.className = 't3k';
    this.root.innerHTML = `
      <div class="t3k__panel">
        <div class="t3k__head">
          <div class="t3k__title">Account<br><em>OPTIONAL — THE RIG PLAYS WITHOUT ONE</em></div>
          <button class="t3k__close" aria-label="close">✕</button>
        </div>
        <div class="t3k__list account-body"></div>
      </div>`;
    document.body.appendChild(this.root);
    this.body = this.root.querySelector('.account-body')!;
    this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
    this.root.querySelector('.t3k__close')!.addEventListener('click', () => this.close());

    onUser(async (user) => {
      session.user = user;
      session.profile = user ? await ensureProfile(user).catch(() => null) : null;
      this.syncChip();
      if (this.root.classList.contains('open')) this.render();
      this.onSessionChange?.();
    });
    // No getRedirectResult here on purpose. Provider sign-in finishes on
    // /signin.html and leaves the session in localStorage, so the onUser
    // listener above already has the player. Calling it from this page would
    // only spin up Firebase's helper iframe, which cross-origin isolation
    // blocks — a guaranteed failure, on every single load, for nothing.
  }

  open() { this.root.classList.add('open'); this.render(); }
  close() { this.root.classList.remove('open'); }
  refreshChip() { this.syncChip(); }

  /* Signed in is signed in.
   *
   * This used to need a profile as well as a user, so anything that stopped
   * the profile loading — a rules change, a bad network second — printed
   * SIGN IN at someone who was signed in, on a page that would then take them
   * straight to their own profile. The user is the fact; the profile is
   * decoration on top of it, and a missing one falls back to a name rather
   * than to a lie. */
  private syncChip() {
    if (!session.user) {
      this.chip.innerHTML = `${ICONS.user}<span>SIGN IN</span>`;
      return;
    }
    const p = session.profile;
    const name = p?.username || session.user.displayName || session.user.email?.split('@')[0] || 'you';
    this.chip.innerHTML = `${p?.avatarUrl
      ? `<img class="account-chip__ava" crossorigin="anonymous" src="${escape(p.avatarUrl)}" alt="">`
      : '<span class="account-chip__dot"></span>'}${escape(name)}`;
  }

  private render() {
    this.body.innerHTML = '';
    if (!session.user) this.renderSignedOut();
    else this.renderSignedIn();
  }

  /* ── signed out ── */
  private renderSignedOut() {
    const wrap = el('div', 'account-auth');
    wrap.innerHTML = `
      <div class="account-note">Keep your sounds against a profile and share them on the feed.
        Sign-up is optional — everything on the rig works without it.</div>
      <div class="account-providers">
        ${Object.keys(BRAND_MARKS).map((p) => `
          <button data-p="${p}" type="button">
            <span class="provider__mark">${BRAND_MARKS[p]}</span>
            <span class="provider__label">${PROVIDER_LABEL[p]}</span>
          </button>`).join('')}
      </div>
      <div class="account-rule"><span>OR EMAIL</span></div>
      <form class="account-form">
        <input name="username" placeholder="username (for new accounts)" maxlength="20"
          autocomplete="nickname" autocapitalize="off" autocorrect="off" spellcheck="false" />
        <input name="email" type="email" placeholder="email" required autocomplete="email" />
        <input name="password" type="password" placeholder="password" required minlength="6" autocomplete="current-password" />
        <div class="account-form__row">
          <button type="submit" class="hdr__btn hdr__btn--lit" data-a="in">SIGN IN</button>
          <button type="button" class="hdr__btn" data-a="up">CREATE ACCOUNT</button>
          <button type="button" class="account-forgot" data-a="forgot">forgot?</button>
        </div>
      </form>`;
    for (const b of wrap.querySelectorAll<HTMLButtonElement>('[data-p]')) {
      b.addEventListener('click', async () => {
        try { await signInWithProvider(b.dataset.p!); }
        catch (err) { toast(`${b.dataset.p} sign-in failed — ${authErrorText(err)}`, 5000); }
      });
    }
    const form = wrap.querySelector('form')!;
    const val = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.trim();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await emailSignIn(val('email'), val('password'));
        toast('<b>Signed in.</b>');
        this.render();
      } catch (err) { toast(`Sign-in failed — ${authErrorText(err)}`, 5000); }
    });
    wrap.querySelector('[data-a=up]')!.addEventListener('click', async () => {
      try {
        if (!val('email') || !val('password')) { toast('Email and password first.'); return; }
        const wanted = val('username');
        // Check the shape BEFORE creating the account: failing after it exists
        // would leave a player signed in, wondering why their name did not
        // stick, with no obvious way to try again.
        if (wanted) {
          const problem = handleProblem(wanted);
          if (problem) { toast(`Username needs ${problem}.`, 4500); return; }
          if (!(await handleAvailable(wanted))) {
            toast(`<b>@${escape(wanted)}</b> is taken — pick another.`, 4500);
            return;
          }
        }
        const user = await emailSignUp(val('email'), val('password'), wanted);
        // ensureProfile already ran off the auth-state event and claimed an
        // auto-generated handle, so this is a rename to the one they typed.
        // Someone can still have taken it in between, which is exactly what
        // the transaction in saveProfile is there to catch.
        if (wanted) {
          const prof: Profile = { username: wanted, bio: '', avatarUrl: '' };
          try {
            await saveProfile(user.uid, prof);
            session.profile = { ...session.profile, ...prof };
          } catch (e) {
            toast(e instanceof HandleTakenError
              ? `<b>@${escape(wanted)}</b> went to somebody else just then — you are <b>@${escape(session.profile?.username ?? '')}</b> for now, change it on your profile.`
              : `Account made, but the username did not stick — ${(e as Error).message}`, 6000);
          }
          this.syncChip();
        }
        toast('<b>Account created.</b> Welcome.');
        this.render();
      } catch (err) { toast(`Sign-up failed — ${authErrorText(err)}`, 5000); }
    });
    wrap.querySelector('[data-a=forgot]')!.addEventListener('click', async () => {
      if (!val('email')) { toast('Type your email first.'); return; }
      try { await resetPassword(val('email')); toast('Reset email sent.'); }
      catch (err) { toast(authErrorText(err), 4500); }
    });
    this.body.appendChild(wrap);
  }

  /* ── signed in: a compact hand-off to the profile page ── */
  private renderSignedIn() {
    const user = session.user!;
    const p = session.profile ?? { username: 'player', bio: '', avatarUrl: '' };
    const wrap = el('div', 'account-profile');
    wrap.innerHTML = `
      <div class="account-profile__head">
        ${p.avatarUrl ? `<img crossorigin="anonymous" src="${escape(p.avatarUrl)}" alt="">` : '<div class="account-profile__blank"></div>'}
        <div>
          <div class="account-profile__name">${escape(p.username)}</div>
          <div class="account-profile__mail">${escape(user.email ?? '')}</div>
          <div class="account-profile__mail">${p.followersCount ?? 0} followers · following ${p.followingCount ?? 0}</div>
        </div>
      </div>
      <div class="account-form__row">
        <button class="hdr__btn hdr__btn--lit" data-a="profile">OPEN PROFILE PAGE</button>
        <button class="hdr__btn" data-a="signout">SIGN OUT</button>
      </div>
      <div class="account-note">Your sounds, comment history and profile editing live on the profile page.</div>`;
    wrap.querySelector('[data-a=profile]')!.addEventListener('click', () => { this.close(); this.openProfile(); });
    wrap.querySelector('[data-a=signout]')!.addEventListener('click', async () => {
      await signOut();
      toast('Signed out.');
      this.render();
    });
    this.body.appendChild(wrap);
  }
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
