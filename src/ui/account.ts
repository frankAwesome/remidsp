/* The account layer — a right-hand drawer in the same editorial language as
 * the captures browser. Signed out: Google + the usual providers + email
 * sign-in/up (all optional — the rig never needs an account). Signed in:
 * profile (avatar · username · bio) and MY SOUNDS, the cloud preset library. */

import {
  onUser, consumeRedirect, signInWithProvider, emailSignIn, emailSignUp,
  resetPassword, signOut, authErrorText, type User,
} from '../cloud/fb';
import {
  ensureProfile, saveProfile, myPresets, setShared, deletePreset,
  type Profile, type CloudPreset,
} from '../cloud/store';
import { toast } from './toast';

export const session: { user: User | null; profile: Profile | null } = { user: null, profile: null };

type ApplyCloudPreset = (p: CloudPreset) => Promise<void>;

export class AccountUI {
  root: HTMLElement;
  chip: HTMLButtonElement;
  private body: HTMLElement;
  private applyPreset: ApplyCloudPreset;
  onSessionChange: (() => void) | null = null;

  constructor(applyPreset: ApplyCloudPreset) {
    this.applyPreset = applyPreset;
    this.chip = document.createElement('button');
    this.chip.className = 'hdr__btn account-chip';
    this.chip.textContent = 'SIGN IN';
    this.chip.addEventListener('click', () => this.open());

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
    consumeRedirect()
      .then((u) => { if (u) toast(`Signed in as <b>${escape(u.displayName ?? u.email ?? '')}</b>`); })
      .catch((err) => toast(`Sign-in failed — ${authErrorText(err)}`, 5000));
  }

  open() { this.root.classList.add('open'); this.render(); }
  close() { this.root.classList.remove('open'); }

  private syncChip() {
    const p = session.profile;
    if (session.user && p) {
      this.chip.innerHTML = `${p.avatarUrl
        ? `<img class="account-chip__ava" crossorigin="anonymous" src="${escape(p.avatarUrl)}" alt="">`
        : '<span class="account-chip__dot"></span>'}${escape(p.username)}`;
    } else {
      this.chip.textContent = 'SIGN IN';
    }
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
        <button data-p="google">CONTINUE WITH GOOGLE</button>
        <button data-p="apple">APPLE</button>
        <button data-p="github">GITHUB</button>
        <button data-p="facebook">FACEBOOK</button>
      </div>
      <div class="account-rule"><span>OR EMAIL</span></div>
      <form class="account-form">
        <input name="username" placeholder="username (for new accounts)" maxlength="40" autocomplete="nickname" />
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
        await emailSignUp(val('email'), val('password'), val('username'));
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

  /* ── signed in ── */
  private renderSignedIn() {
    const user = session.user!;
    const p = session.profile ?? { username: 'player', bio: '', avatarUrl: '' };

    const prof = el('div', 'account-profile');
    prof.innerHTML = `
      <div class="account-profile__head">
        ${p.avatarUrl ? `<img crossorigin="anonymous" src="${escape(p.avatarUrl)}" alt="">` : '<div class="account-profile__blank"></div>'}
        <div>
          <div class="account-profile__name">${escape(p.username)}</div>
          <div class="account-profile__mail">${escape(user.email ?? '')}</div>
          <div class="account-profile__mail">${p.followersCount ?? 0} followers · following ${p.followingCount ?? 0}</div>
        </div>
        <button class="hdr__btn" data-a="signout">SIGN OUT</button>
      </div>
      <form class="account-form">
        <input name="username" maxlength="40" value="${escape(p.username)}" placeholder="username" />
        <input name="avatarUrl" maxlength="500" value="${escape(p.avatarUrl)}" placeholder="avatar image url" />
        <textarea name="bio" maxlength="400" rows="3" placeholder="bio — amps, bands, worship team, whatever">${escape(p.bio)}</textarea>
        <div class="account-form__row"><button type="submit" class="hdr__btn hdr__btn--lit">SAVE PROFILE</button></div>
      </form>
      <div class="account-rule"><span>MY SOUNDS</span></div>
      <div class="account-sounds"><div class="t3k__note">Loading…</div></div>`;
    prof.querySelector('[data-a=signout]')!.addEventListener('click', async () => {
      await signOut();
      toast('Signed out.');
      this.render();
    });
    const form = prof.querySelector('form')!;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = (n: string) => (form.elements.namedItem(n) as HTMLInputElement | HTMLTextAreaElement).value.trim();
      const next: Profile = { username: v('username') || 'player', bio: v('bio'), avatarUrl: v('avatarUrl') };
      try {
        await saveProfile(user.uid, next);
        session.profile = next;
        this.syncChip();
        toast('<b>Profile saved.</b>');
      } catch (err) { toast(`Profile save failed — ${(err as Error).message}`, 4500); }
    });
    this.body.appendChild(prof);
    void this.renderSounds(prof.querySelector('.account-sounds')!);
  }

  private async renderSounds(box: HTMLElement) {
    try {
      const list = await myPresets(session.user!.uid);
      box.innerHTML = list.length ? '' : '<div class="t3k__note">Nothing saved yet — dial a sound and hit SAVE.</div>';
      for (const pr of list) {
        const row = el('div', 'sound-row');
        row.innerHTML = `
          <div class="sound-row__body">
            <b>${escape(pr.name)}</b>
            <span>${escape(pr.amp)} · ${escape(pr.capture?.label ?? pr.voice)}${pr.shared ? ' · <i class="sound-row__shared">ON FEED</i>' : ''}</span>
          </div>
          <button data-a="load">LOAD</button>
          <button data-a="share">${pr.shared ? 'UNSHARE' : 'SHARE'}</button>
          <button data-a="del">✕</button>`;
        row.querySelector('[data-a=load]')!.addEventListener('click', async () => {
          await this.applyPreset(pr);
          this.close();
        });
        row.querySelector('[data-a=share]')!.addEventListener('click', async () => {
          try {
            if (pr.shared) { await setShared(pr.id, false); toast('Taken off the feed.'); }
            else {
              const desc = prompt('Say something about this sound (shows on the feed):', pr.description || '') ?? '';
              await setShared(pr.id, true, desc.slice(0, 500));
              toast('<b>Shared to the feed.</b>');
            }
            this.render();
          } catch (err) { toast(`Share failed — ${(err as Error).message}`, 4500); }
        });
        row.querySelector('[data-a=del]')!.addEventListener('click', async () => {
          if (!confirm(`Delete "${pr.name}" from your cloud library?`)) return;
          await deletePreset(pr.id);
          this.render();
        });
        box.appendChild(row);
      }
    } catch (err) {
      box.innerHTML = `<div class="t3k__note">Library unavailable — ${(err as Error).message}</div>`;
    }
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
