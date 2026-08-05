/* THE PROFILE PAGE — who you are on the feed, and everything you've done.
 * Big editorial header (avatar · Oswald name · bio · DSEG7 stat tiles),
 * inline profile editing, your sounds as full amp-accented cards with
 * owner controls (LOAD · SHARE/UNSHARE · DELETE), and your comment
 * history across everyone's posts. */

import { signOut } from '../cloud/fb';
import {
  saveProfile, getProfile, myPresets, myComments, publicTones,
  setShared, deletePreset, isFollowing, setFollowing,
  type Profile, type CloudPreset, type CommentDoc,
} from '../cloud/store';
import { session } from './account';
import { renderCommentRow, timeAgo } from './feed';
import { toast } from './toast';
import { encodeAvatar, AVATAR_ACCEPT, AVATAR_MAX_B64 } from './avatar';

/** Resolves false when the preset's own capture could not be fetched. */
type ApplyCloudPreset = (p: CloudPreset) => Promise<boolean>;
type RenderToneCard = (p: CloudPreset) => HTMLElement;

const AMP_ACCENT: Record<string, string> = {
  camden: '#8fd8cf', portland: '#e9b765', katahdin: '#c25a52',
};

export class ProfileView {
  root: HTMLElement;
  private applyPreset: ApplyCloudPreset;
  private openAuth: () => void;
  private renderToneCard: RenderToneCard;
  private viewUid: string | null = null; // null = your own profile
  onSignedOut: (() => void) | null = null;
  onProfileSaved: (() => void) | null = null;

  constructor(applyPreset: ApplyCloudPreset, openAuth: () => void, renderToneCard: RenderToneCard) {
    this.applyPreset = applyPreset;
    this.openAuth = openAuth;
    this.renderToneCard = renderToneCard;
    this.root = document.createElement('section');
    this.root.className = 'profile';
    this.root.hidden = true;
  }

  /** Point the page at a player (null / your own uid = your profile). */
  show(uid: string | null) {
    this.viewUid = uid && uid !== session.user?.uid ? uid : null;
  }

  async refresh() {
    if (this.viewUid) return this.refreshPublic(this.viewUid);
    const user = session.user;
    // counters move under batched writes (follows, likes) — read fresh
    if (user) {
      const fresh = await getProfile(user.uid).catch(() => null);
      if (fresh) session.profile = fresh;
    }
    const p = session.profile;
    if (!user || !p) {
      this.root.innerHTML = `<div class="t3k__note" style="padding:2rem 0">
        Sign in to build a profile — your sounds and comments live against it.</div>`;
      const b = document.createElement('button');
      b.className = 'hdr__btn hdr__btn--lit';
      b.textContent = 'SIGN IN';
      b.addEventListener('click', () => this.openAuth());
      this.root.appendChild(b);
      return;
    }

    this.root.innerHTML = `
      <header class="profile__head">
        ${p.avatarUrl
          ? `<img class="profile__ava" crossorigin="anonymous" src="${escape(p.avatarUrl)}" alt="">`
          : `<div class="profile__ava profile__ava--blank">${escape((p.username || '?')[0].toUpperCase())}</div>`}
        <div class="profile__id">
          <div class="profile__name">${escape(p.username)}</div>
          ${p.bio ? `<p class="profile__bio">${escape(p.bio)}</p>` : '<p class="profile__bio profile__bio--empty">no bio yet — tell the feed who you are</p>'}
          <div class="profile__mail mono">${escape(user.email ?? '')}
            <span class="profile__private">PRIVATE · ONLY YOU SEE THIS</span></div>
        </div>
        <div class="profile__actions">
          <button class="hdr__btn" data-a="edit">EDIT PROFILE</button>
          <button class="hdr__btn" data-a="signout">SIGN OUT</button>
        </div>
      </header>
      <form class="account-form profile__edit" hidden>
        <div class="avatar-edit">
          <div class="avatar-edit__preview" data-el="avaPreview">
            ${p.avatarUrl
              ? `<img crossorigin="anonymous" src="${escape(p.avatarUrl)}" alt="">`
              : `<span>${escape((p.username || '?')[0].toUpperCase())}</span>`}
          </div>
          <div class="avatar-edit__body">
            <div class="avatar-edit__row">
              <button type="button" class="hdr__btn" data-a="pick-ava">UPLOAD PICTURE</button>
              <button type="button" class="hdr__btn" data-a="clear-ava"
                ${p.avatarUrl ? '' : 'hidden'}>REMOVE</button>
              <input type="file" accept="${AVATAR_ACCEPT}" hidden data-el="avaFile" />
            </div>
            <div class="avatar-edit__note" data-el="avaNote">
              Square works best — it is cropped to a circle and shrunk to 128 px.
            </div>
            <input name="avatarUrl" maxlength="${AVATAR_MAX_B64}"
              value="${escape(p.avatarUrl)}" placeholder="…or paste an image url" />
          </div>
        </div>
        <input name="username" maxlength="40" value="${escape(p.username)}" placeholder="username" />
        <textarea name="bio" maxlength="400" rows="3" placeholder="bio — amps, bands, worship team, whatever">${escape(p.bio)}</textarea>
        <label class="profile__vis">
          <span class="profile__vis__head">PROFILE PAGE</span>
          <select name="isPublic">
            <option value="1"${p.isPublic === false ? '' : ' selected'}>Public — anyone can open it</option>
            <option value="0"${p.isPublic === false ? ' selected' : ''}>Private — only you can open it</option>
          </select>
          <span class="profile__vis__note">Private hides this page and keeps you out of player search.
            Tones you have already shared stay on the feed — sharing a tone is its own choice.</span>
        </label>
        <div class="account-form__row">
          <button type="submit" class="hdr__btn hdr__btn--lit">SAVE</button>
          <button type="button" class="hdr__btn" data-a="cancel">CANCEL</button>
        </div>
      </form>
      <div class="profile__stats"></div>
      <div class="profile__cols">
        <div class="profile__col">
          <div class="account-rule"><span>MY SOUNDS</span></div>
          <div class="profile__sounds"><div class="t3k__note">Loading…</div></div>
        </div>
        <div class="profile__col">
          <div class="account-rule"><span>MY COMMENTS</span></div>
          <div class="profile__comments"><div class="t3k__note">Loading…</div></div>
        </div>
      </div>`;

    // edit toggle + save
    const form = this.root.querySelector<HTMLFormElement>('.profile__edit')!;
    this.root.querySelector('[data-a=edit]')!.addEventListener('click', () => { form.hidden = !form.hidden; });
    this.root.querySelector('[data-a=cancel]')!.addEventListener('click', () => { form.hidden = true; });

    // Picture upload. The encoded image goes straight into the avatarUrl
    // field, so one code path saves it whether it was uploaded or pasted.
    const avaField = form.elements.namedItem('avatarUrl') as HTMLInputElement;
    const avaFile = form.querySelector<HTMLInputElement>('[data-el=avaFile]')!;
    const avaPreview = form.querySelector<HTMLElement>('[data-el=avaPreview]')!;
    const avaNote = form.querySelector<HTMLElement>('[data-el=avaNote]')!;
    const avaClear = form.querySelector<HTMLButtonElement>('[data-a=clear-ava]')!;
    const paintAva = (src: string) => {
      avaPreview.innerHTML = src
        ? `<img crossorigin="anonymous" src="${escape(src)}" alt="">`
        : `<span>${escape(((form.elements.namedItem('username') as HTMLInputElement).value.trim() || '?')[0].toUpperCase())}</span>`;
      avaClear.hidden = !src;
    };
    form.querySelector('[data-a=pick-ava]')!.addEventListener('click', () => avaFile.click());
    avaFile.addEventListener('change', async () => {
      const file = avaFile.files?.[0];
      avaFile.value = ''; // so re-picking the same file fires change again
      if (!file) return;
      avaNote.textContent = 'Resizing…';
      avaNote.classList.remove('avatar-edit__note--bad');
      try {
        const data = await encodeAvatar(file);
        avaField.value = data;
        paintAva(data);
        avaNote.textContent = `Ready — ${(data.length / 1024).toFixed(1)} kB. Hit SAVE to keep it.`;
      } catch (err) {
        avaNote.textContent = (err as Error).message;
        avaNote.classList.add('avatar-edit__note--bad');
      }
    });
    avaClear.addEventListener('click', () => {
      avaField.value = '';
      paintAva('');
      avaNote.textContent = 'Picture cleared. Hit SAVE to confirm.';
      avaNote.classList.remove('avatar-edit__note--bad');
    });
    avaField.addEventListener('input', () => paintAva(avaField.value.trim()));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = (n: string) => (form.elements.namedItem(n) as HTMLInputElement | HTMLTextAreaElement).value.trim();
      const isPublic = (form.elements.namedItem('isPublic') as HTMLSelectElement).value === '1';
      const avatarUrl = v('avatarUrl');
      if (avatarUrl.length > AVATAR_MAX_B64) {
        toast('That picture is too large to store — upload it again and it will be resized.', 4500);
        return;
      }
      const next: Profile = { username: v('username') || 'player', bio: v('bio'), avatarUrl, isPublic };
      try {
        await saveProfile(user.uid, next);
        session.profile = { ...session.profile, ...next };
        toast('<b>Profile saved.</b>');
        this.onProfileSaved?.();
        void this.refresh();
      } catch (err) { toast(`Profile save failed — ${(err as Error).message}`, 4500); }
    });
    this.root.querySelector('[data-a=signout]')!.addEventListener('click', async () => {
      await signOut();
      toast('Signed out.');
      this.onSignedOut?.();
    });

    // data
    const [sounds, comments] = await Promise.all([
      myPresets(user.uid).catch(() => [] as CloudPreset[]),
      myComments(user.uid).catch(() => [] as CommentDoc[]),
    ]);

    // stat tiles
    const shared = sounds.filter((s) => s.shared).length;
    const likes = sounds.reduce((a, s) => a + (s.likesCount ?? 0), 0);
    const loads = sounds.reduce((a, s) => a + (s.downloadsCount ?? 0), 0);
    this.root.querySelector('.profile__stats')!.innerHTML = [
      tile(sounds.length, 'SOUNDS'), tile(shared, 'ON FEED'),
      tile(likes, 'LIKES WON'), tile(loads, 'LOADS'),
      tile(p.followersCount ?? 0, 'FOLLOWERS'), tile(p.followingCount ?? 0, 'FOLLOWING'),
      tile(comments.length, 'COMMENTS'),
    ].join('');

    // sounds as owner cards
    const sbox = this.root.querySelector<HTMLElement>('.profile__sounds')!;
    sbox.innerHTML = sounds.length ? '' :
      `<div class="t3k__note">Nothing saved yet — dial a sound on the rig and hit SAVE.</div>`;
    for (const s of sounds) sbox.appendChild(this.soundCard(s));

    // comment history
    const cbox = this.root.querySelector<HTMLElement>('.profile__comments')!;
    cbox.innerHTML = comments.length ? '' :
      `<div class="t3k__note">No comments yet — say something on the feed.</div>`;
    for (const cm of comments) cbox.appendChild(renderCommentRow(cm, cm.presetName || 'a sound'));
  }

  /* ── someone else's profile ──────────────────────────────────────────
   * PUBLIC SURFACE. Everything here comes from the profiles/{uid} document,
   * which by rule can only ever hold username · usernameLower · bio ·
   * avatarUrl · counters — the email is not merely unrendered, it is not
   * storable. Never add a field here that reads from an auth record. */
  private async refreshPublic(uid: string) {
    this.root.innerHTML = `<div class="t3k__note" style="padding:2rem 0">Loading profile…</div>`;
    const [p, tones] = await Promise.all([
      getProfile(uid).catch(() => null),
      publicTones(uid).catch(() => [] as CloudPreset[]),
    ]);
    // A private profile reads as "not there" through the rules, so a null
    // here covers both cases; say so without guessing which.
    if (!p) {
      this.root.innerHTML = `<div class="t3k__note" style="padding:2rem 0">
        This profile is private, or the player has deleted it. Any tones they
        shared are still on the feed.</div>`;
      return;
    }
    if (p.isPublic === false) {
      this.root.innerHTML = `<div class="t3k__note" style="padding:2rem 0">
        <b>${escape(p.username)}</b> keeps their profile page private. Any tones
        they shared are still on the feed.</div>`;
      return;
    }
    const likes = tones.reduce((a, s) => a + (s.likesCount ?? 0), 0);
    const loads = tones.reduce((a, s) => a + (s.downloadsCount ?? 0), 0);
    this.root.innerHTML = `
      <header class="profile__head">
        ${p.avatarUrl
          ? `<img class="profile__ava" crossorigin="anonymous" src="${escape(p.avatarUrl)}" alt="">`
          : `<div class="profile__ava profile__ava--blank">${escape((p.username || '?')[0].toUpperCase())}</div>`}
        <div class="profile__id">
          <div class="profile__name">${escape(p.username)}</div>
          ${p.bio ? `<p class="profile__bio">${escape(p.bio)}</p>` : ''}
        </div>
        <div class="profile__actions">
          <button class="t3k__pill profile__follow" data-a="follow">FOLLOW</button>
        </div>
      </header>
      <div class="profile__stats">
        ${tile(p.followersCount ?? 0, 'FOLLOWERS')}
        ${tile(p.followingCount ?? 0, 'FOLLOWING')}
        ${tile(tones.length, 'TONES ON FEED')}
        ${tile(likes, 'LIKES WON')}
        ${tile(loads, 'LOADS')}
      </div>
      <div class="account-rule"><span>PUBLIC TONES</span></div>
      <div class="feed__list profile__tones"></div>`;

    const followBtn = this.root.querySelector<HTMLButtonElement>('[data-a=follow]')!;
    const me = session.user?.uid;
    if (!me) followBtn.textContent = 'SIGN IN TO FOLLOW';
    else {
      void isFollowing(me, uid).then((f) => {
        followBtn.classList.toggle('on', f);
        followBtn.textContent = f ? 'FOLLOWING' : 'FOLLOW';
      });
    }
    followBtn.addEventListener('click', async () => {
      if (!session.user) { this.openAuth(); return; }
      const now = !followBtn.classList.contains('on');
      try {
        await setFollowing(session.user.uid, uid, now);
        followBtn.classList.toggle('on', now);
        followBtn.textContent = now ? 'FOLLOWING' : 'FOLLOW';
        toast(now ? `Following <b>${escape(p.username)}</b>` : `Unfollowed ${escape(p.username)}`);
      } catch (err) { toast(`Follow failed — ${(err as Error).message}`); }
    });

    const box = this.root.querySelector<HTMLElement>('.profile__tones')!;
    if (!tones.length) box.innerHTML = `<div class="t3k__note">Nothing shared yet.</div>`;
    for (const t of tones) box.appendChild(this.renderToneCard(t));
  }

  private soundCard(s: CloudPreset): HTMLElement {
    const c = document.createElement('article');
    c.className = 'feed-card profile-sound';
    c.style.setProperty('--tone', AMP_ACCENT[s.amp] ?? '#9fd8e8');
    const when = s.createdAt ? timeAgo(s.createdAt.toMillis()) : '';
    c.innerHTML = `
      <div class="profile-sound__row">
        <div class="profile-sound__body">
          <div class="feed-card__title profile-sound__title">${escape(s.name)}</div>
          <div class="feed-card__by">${escape(s.amp)} · ${escape(s.capture?.label ?? s.voice)}${when ? ` · ${when}` : ''}</div>
          <div class="tone-card__tags" style="margin-top:.35rem">
            ${s.shared ? `<span class="tone-card__tag profile-sound__onfeed">ON FEED</span>` : `<span class="tone-card__tag">PRIVATE</span>`}
            <span class="tone-card__tag">♥ ${s.likesCount}</span>
            <span class="tone-card__tag">⤓ ${s.downloadsCount}</span>
            <span class="tone-card__tag">💬 ${s.commentsCount}</span>
          </div>
        </div>
        <div class="profile-sound__acts">
          <button class="tone-card__load" data-a="load">LOAD</button>
          <button class="t3k__pill ${s.shared ? 'on' : ''}" data-a="share">${s.shared ? 'UNSHARE' : 'SHARE'}</button>
          <button class="looper__btn" data-a="del" title="delete">✕</button>
        </div>
      </div>`;
    c.querySelector('[data-a=load]')!.addEventListener('click', () => void this.applyPreset(s));
    c.querySelector('[data-a=share]')!.addEventListener('click', async () => {
      try {
        if (s.shared) { await setShared(s.id, false); toast('Taken off the feed.'); }
        else {
          const desc = prompt('Say something about this sound (shows on the feed):', s.description || '') ?? '';
          await setShared(s.id, true, desc.slice(0, 500));
          toast('<b>Shared to the feed.</b>');
        }
        void this.refresh();
      } catch (err) { toast(`Share failed — ${(err as Error).message}`, 4500); }
    });
    c.querySelector('[data-a=del]')!.addEventListener('click', async () => {
      if (!confirm(`Delete "${s.name}" from your cloud library?`)) return;
      await deletePreset(s.id);
      void this.refresh();
    });
    return c;
  }
}

function tile(n: number, label: string): string {
  return `<div class="profile-tile"><span class="led-text">${n}</span><i>${label}</i></div>`;
}
function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
