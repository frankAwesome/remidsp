/* THE PROFILE PAGE — who you are on the feed, and everything you've done.
 * Big editorial header (avatar · Oswald name · bio · DSEG7 stat tiles),
 * inline profile editing, your sounds as full amp-accented cards with
 * owner controls (LOAD · SHARE/UNSHARE · DELETE), and your comment
 * history across everyone's posts. */

import { signOut } from '../cloud/fb';
import {
  saveProfile, getProfile, myPresets, myComments, publicTones,
  setShared, deletePreset, isFollowing, setFollowing, setPinned,
  addPost, deletePost, postsBy,
  handleProblem, handleAvailable, HandleTakenError, HANDLE_MAX,
  type Profile, type CloudPreset, type CommentDoc, type PostDoc,
} from '../cloud/store';
import { deleteUserPreset } from '../presets';
import { session } from './account';
import { renderCommentRow, timeAgo } from './feed';
import { toast } from './toast';
import { AVATAR_MAX_B64 } from './avatar';
import { uploadImage, mediaEnabled, AVATAR_ACCEPT } from '../cloud/media';
import { urlFor } from './router';
import { shareLink } from './share';
import { confirmDialog, promptDialog } from './dialog';

/** Resolves false when the preset's own capture could not be fetched. */
type ApplyCloudPreset = (p: CloudPreset) => Promise<boolean>;
type RenderToneCard = (p: CloudPreset) => HTMLElement;

const AMP_ACCENT: Record<string, string> = {
  camden: '#8fd8cf', portland: '#e9b765', katahdin: '#c25a52',
};

/* The banner. A player's own image when they have set one (an https URL —
 * there is no media store yet, so a pasted link is what exists, and a link
 * that will not load falls back), otherwise the house banner: tubes glowing
 * over a waveform, shipped with the app so the default is never an empty
 * rectangle. 'deck:' values from the short-lived colour-deck design render
 * as the house banner too. */
const HOUSE_BANNER = '/assets/site/banner-default.webp';

function coverHtml(coverUrl?: string): string {
  const c = (coverUrl ?? '').trim();
  return `<div class="profile__cover">
    ${c.startsWith('https://')
      ? `<img crossorigin="anonymous" src="${escape(c)}" data-cover alt="">`
      : `<img src="${HOUSE_BANNER}" alt="">`}
  </div>`;
}

/** A pasted banner that cannot load (dead link, a host that refuses CORS —
 *  this page is COEP-isolated, so cross-origin images must play along)
 *  quietly becomes the house banner instead of a broken strip. */
function wireCoverFallback(root: HTMLElement) {
  const img = root.querySelector<HTMLImageElement>('.profile__cover img[data-cover]');
  img?.addEventListener('error', () => {
    img.removeAttribute('crossorigin');
    img.removeAttribute('data-cover');
    img.src = HOUSE_BANNER;
  });
}

/** One wall post — a person saying a thing, maybe pointing at a tone. */
function postRow(post: PostDoc, own: boolean): HTMLElement {
  const row = document.createElement('article');
  row.className = 'wall-post';
  const when = post.createdAt ? timeAgo(post.createdAt.toMillis()) : 'just now';
  row.innerHTML = `
    <div class="wall-post__meta">
      ${post.avatarUrl
        ? `<img class="wall-post__ava" crossorigin="anonymous" src="${escape(post.avatarUrl)}"
            data-name="${escape(post.username || '?')}" alt="">`
        : `<span class="wall-post__ava wall-post__ava--blank">${escape((post.username || '?')[0].toUpperCase())}</span>`}
      <b>${escape(post.username)}</b><span>${when}</span>
      ${own ? `<button class="wall-post__del" title="delete this post">✕</button>` : ''}
    </div>
    <p class="wall-post__text">${escape(post.text)}</p>
    ${post.toneId ? `<a class="wall-post__tone" href="#/t/${escape(post.toneId)}">
        <span class="wall-post__tonelabel">TONE</span>${escape(post.toneName || 'listen')}</a>` : ''}`;
  return row;
}

export class ProfileView {
  root: HTMLElement;
  private applyPreset: ApplyCloudPreset;
  private openAuth: () => void;
  private renderToneCard: RenderToneCard;
  private viewUid: string | null = null; // null = your own profile
  onSignedOut: (() => void) | null = null;
  onProfileSaved: (() => void) | null = null;
  /** Open a conversation with this player — wired to the messages panel. */
  onMessage: ((target: { uid: string; username: string; avatarUrl: string }) => void) | null = null;
  /** Fired when the local preset library changed under the rig's feet, so the
   *  preset strip can re-sync instead of pointing at something deleted. */
  onLibraryChanged: (() => void) | null = null;

  /* Tell the player where they stand while they type, rather than after they
   * submit. The shape check is instant and local; only a well-formed handle
   * that has actually changed is worth a read, and the sequence guard drops
   * the answer to a query the player has already typed past. */
  private handleSeq = 0;
  private wireHandleField(form: HTMLFormElement, original: string) {
    const input = form.elements.namedItem('username') as HTMLInputElement;
    const note = form.querySelector<HTMLElement>('[data-el=handleNote]')!;
    const save = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    const set = (cls: string, html: string, ok: boolean) => {
      note.className = `handle-note ${cls}`;
      note.innerHTML = html;
      save.disabled = !ok;
    };
    let timer = 0;
    const check = async () => {
      const raw = input.value.trim();
      if (raw.toLowerCase() === original.toLowerCase()) {
        set('', 'This is your handle.', true);
        return;
      }
      const problem = handleProblem(raw);
      if (problem) { set('handle-note--bad', `Needs ${problem}.`, false); return; }
      const seq = ++this.handleSeq;
      set('', `Checking <b>@${escape(raw)}</b>…`, false);
      try {
        const free = await handleAvailable(raw, session.user?.uid);
        if (seq !== this.handleSeq) return;   // the player typed on
        set(free ? 'handle-note--ok' : 'handle-note--bad',
            free ? `<b>@${escape(raw)}</b> is free.` : `<b>@${escape(raw)}</b> is taken.`,
            free);
      } catch {
        if (seq !== this.handleSeq) return;
        set('', 'Could not check that one — saving will tell you for sure.', true);
      }
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void check(), 300);
    });
  }

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
      ${coverHtml(p.coverUrl)}
      <header class="profile__head profile__head--covered">
        ${p.avatarUrl
          ? `<img class="profile__ava" crossorigin="anonymous" src="${escape(p.avatarUrl)}"
              data-name="${escape(p.username || '?')}" alt="">`
          : `<div class="profile__ava profile__ava--blank">${escape((p.username || '?')[0].toUpperCase())}</div>`}
        <div class="profile__id">
          <div class="profile__name">${escape(p.username)}</div>
          ${p.bio ? `<p class="profile__bio">${escape(p.bio)}</p>` : '<p class="profile__bio profile__bio--empty">no bio yet — tell the feed who you are</p>'}
          ${p.link ? `<a class="profile__link" href="${escape(p.link)}" target="_blank" rel="noopener">${escape(p.link.replace(/^https:\/\//, ''))}</a>` : ''}
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
              Square works best — it is cropped to a circle${mediaEnabled()
                ? ' and stored at 256 px.'
                : ' and shrunk to 128 px to fit on your profile document.'}
            </div>
            <input name="avatarUrl" maxlength="${AVATAR_MAX_B64}"
              value="${escape(p.avatarUrl)}" placeholder="…or paste an image url" />
          </div>
        </div>
        <div class="handle-field">
          <span class="handle-field__at">@</span>
          <input name="username" maxlength="${HANDLE_MAX}" value="${escape(p.username)}"
            placeholder="username" autocapitalize="off" autocorrect="off" spellcheck="false" />
        </div>
        <div class="handle-note" data-el="handleNote">Your handle is unique — it is how players
          find you, and it will be your address on the app. Letters, numbers and underscores.</div>
        <textarea name="bio" maxlength="400" rows="3" placeholder="bio — amps, bands, worship team, whatever">${escape(p.bio)}</textarea>
        <input name="link" maxlength="200" placeholder="https:// — one link: your channel, your band"
          value="${escape(p.link ?? '')}" autocapitalize="off" autocorrect="off" spellcheck="false" />
        <input name="coverUrl" maxlength="500"
          placeholder="https:// — a banner image of your own"
          value="${escape((p.coverUrl ?? '').startsWith('https://') ? p.coverUrl! : '')}"
          autocapitalize="off" autocorrect="off" spellcheck="false" />
        <div class="handle-note">The banner sits behind your name, cropped to a wide strip.
          Leave it empty and you get the house banner — the tubes.</div>
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
          <div class="account-rule"><span>THE WALL</span></div>
          <form class="wall-compose">
            <textarea name="text" maxlength="600" rows="2"
              placeholder="say something that isn't a preset — a question, a win, this Sunday's setlist…"></textarea>
            <div class="wall-compose__row">
              <select name="tone" title="attach one of your shared tones">
                <option value="">NO TONE ATTACHED</option>
              </select>
              <button type="submit" class="hdr__btn hdr__btn--lit">POST</button>
            </div>
          </form>
          <div class="profile__wall"></div>
          <div class="account-rule"><span>MY COMMENTS</span></div>
          <div class="profile__comments"><div class="t3k__note">Loading…</div></div>
        </div>
      </div>`;

    // edit toggle + save
    const form = this.root.querySelector<HTMLFormElement>('.profile__edit')!;
    this.wireHandleField(form, p.username);
    wireCoverFallback(this.root);
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
      // uploadImage picks the backend: a real upload where a media origin is
      // configured, the inline 12 kB data URI where it is not. One call site,
      // and the difference is invisible from here on purpose — the field
      // below stores whatever comes back either way.
      avaNote.textContent = mediaEnabled() ? 'Resizing and uploading…' : 'Resizing…';
      avaNote.classList.remove('avatar-edit__note--bad');
      try {
        const data = await uploadImage(file, 'avatar');
        avaField.value = data;
        paintAva(data);
        avaNote.textContent = mediaEnabled()
          ? 'Uploaded. Hit SAVE to keep it.'
          : `Ready — ${(data.length / 1024).toFixed(1)} kB. Hit SAVE to keep it.`;
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
      const link = v('link');
      if (link && !link.startsWith('https://')) {
        toast('The link needs to start with <b>https://</b>');
        return;
      }
      const coverUrl = v('coverUrl');
      if (coverUrl && !coverUrl.startsWith('https://')) {
        toast('The banner needs an <b>https://</b> image URL — or leave it empty for the house banner.');
        return;
      }
      const next: Profile = {
        username: v('username'), bio: v('bio'), avatarUrl, isPublic,
        link, coverUrl, pinnedId: p.pinnedId ?? '',
      };
      try {
        await saveProfile(user.uid, next);
        session.profile = { ...session.profile, ...next };
        toast(`<b>Saved.</b> You are <b>@${escape(next.username)}</b>.`);
        this.onProfileSaved?.();
        void this.refresh();
      } catch (err) {
        // A taken handle is not a failure to explain in stack terms — it is a
        // normal thing that happens, and the player just needs another name.
        toast(err instanceof HandleTakenError
          ? `<b>@${escape(err.handle)}</b> is already someone's. Pick another.`
          : `Profile save failed — ${(err as Error).message}`, 4500);
      }
    });
    this.root.querySelector('[data-a=signout]')!.addEventListener('click', async () => {
      await signOut();
      toast('Signed out.');
      this.onSignedOut?.();
    });

    // data
    const [sounds, comments, posts] = await Promise.all([
      myPresets(user.uid).catch(() => [] as CloudPreset[]),
      myComments(user.uid).catch(() => [] as CommentDoc[]),
      postsBy(user.uid).catch(() => [] as PostDoc[]),
    ]);
    // The pinned sound leads, whatever the clock says.
    const pinned = p.pinnedId ?? '';
    if (pinned) sounds.sort((a, b) => Number(b.id === pinned) - Number(a.id === pinned));

    // stat tiles
    const shared = sounds.filter((s) => s.shared).length;
    const likes = sounds.reduce((a, s) => a + (s.likesCount ?? 0), 0);
    const loads = sounds.reduce((a, s) => a + (s.downloadsCount ?? 0), 0);
    // Usage before popularity: in a TOOL community what a player has made
    // outranks who is watching. FOLLOWING is gone entirely — nobody has ever
    // followed anyone because of their following count.
    this.root.querySelector('.profile__stats')!.innerHTML = [
      sinceTile(p.createdAt),
      tile(loads, 'LOADS'),
      tile(likes, 'LIKES'),
      tile(shared, 'ON FEED'),
      tile(p.followersCount ?? 0, 'FOLLOWERS', 5),
    ].join('');

    // sounds as owner cards
    const sbox = this.root.querySelector<HTMLElement>('.profile__sounds')!;
    sbox.innerHTML = sounds.length ? '' :
      `<div class="t3k__note">Nothing saved yet — dial a sound on the rig and hit SAVE.</div>`;
    for (const s of sounds) sbox.appendChild(this.soundCard(s, pinned === s.id));

    // the wall — composer + posts
    const compose = this.root.querySelector<HTMLFormElement>('.wall-compose')!;
    const toneSel = compose.elements.namedItem('tone') as HTMLSelectElement;
    for (const s of sounds.filter((x) => x.shared)) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name.toUpperCase();
      toneSel.appendChild(o);
    }
    compose.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ta = compose.elements.namedItem('text') as HTMLTextAreaElement;
      const text = ta.value.trim();
      if (!text || !session.user || !session.profile) return;
      const tone = sounds.find((x) => x.id === toneSel.value);
      try {
        await addPost(session.user, session.profile, text,
          tone ? { id: tone.id, name: tone.name } : undefined);
        ta.value = '';
        toneSel.value = '';
        toast('<b>Posted to your wall.</b>');
        void this.refresh();
      } catch (err) { toast(`Post failed — ${(err as Error).message}`, 4500); }
    });
    const wbox = this.root.querySelector<HTMLElement>('.profile__wall')!;
    wbox.innerHTML = posts.length ? '' :
      `<div class="t3k__note">Nothing on the wall yet.</div>`;
    for (const post of posts) {
      const row = postRow(post, true);
      row.querySelector('.wall-post__del')?.addEventListener('click', async () => {
        try { await deletePost(post.id); row.remove(); toast('Post deleted.'); }
        catch (err) { toast(`Delete failed — ${(err as Error).message}`); }
      });
      wbox.appendChild(row);
    }

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
    const [p, tones, posts] = await Promise.all([
      getProfile(uid).catch(() => null),
      publicTones(uid).catch(() => [] as CloudPreset[]),
      postsBy(uid).catch(() => [] as PostDoc[]),
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
    // Their pinned sound opens the page, whatever the clock says.
    const pinned = p.pinnedId ?? '';
    if (pinned) tones.sort((a, b) => Number(b.id === pinned) - Number(a.id === pinned));
    this.root.innerHTML = `
      ${coverHtml(p.coverUrl)}
      <header class="profile__head profile__head--covered">
        ${p.avatarUrl
          ? `<img class="profile__ava" crossorigin="anonymous" src="${escape(p.avatarUrl)}"
              data-name="${escape(p.username || '?')}" alt="">`
          : `<div class="profile__ava profile__ava--blank">${escape((p.username || '?')[0].toUpperCase())}</div>`}
        <div class="profile__id">
          <div class="profile__name">${escape(p.username)}</div>
          ${p.bio ? `<p class="profile__bio">${escape(p.bio)}</p>` : ''}
          ${p.link ? `<a class="profile__link" href="${escape(p.link)}" target="_blank" rel="noopener">${escape(p.link.replace(/^https:\/\//, ''))}</a>` : ''}
        </div>
        <div class="profile__actions">
          <button class="t3k__pill profile__follow" data-a="follow">FOLLOW</button>
          <button class="t3k__pill" data-a="message"
            title="1:1 messages open between players who follow each other">MESSAGE</button>
          <button class="t3k__pill" data-a="share" title="copy a link to this profile">SHARE</button>
        </div>
      </header>
      <div class="profile__stats">
        ${sinceTile(p.createdAt)}
        ${tile(loads, 'LOADS')}
        ${tile(likes, 'LIKES')}
        ${tile(tones.length, 'TONES')}
        ${tile(p.followersCount ?? 0, 'FOLLOWERS', 5)}
      </div>
      ${posts.length ? `<div class="account-rule"><span>THE WALL</span></div>
      <div class="profile__wall profile__wall--public"></div>` : ''}
      <div class="account-rule"><span>PUBLIC TONES</span></div>
      <div class="feed__list profile__tones"></div>`;

    wireCoverFallback(this.root);
    const wall = this.root.querySelector<HTMLElement>('.profile__wall');
    if (wall) for (const post of posts) wall.appendChild(postRow(post, false));

    this.root.querySelector('[data-a=message]')!.addEventListener('click', () => {
      if (!session.user) { this.openAuth(); return; }
      this.onMessage?.({ uid, username: p.username, avatarUrl: p.avatarUrl ?? '' });
    });

    this.root.querySelector('[data-a=share]')!.addEventListener('click',
      () => void shareLink(urlFor({ view: 'user', handle: p.username }),
        `${p.username} on REMI DSP`,
        `${p.username}'s guitar rigs — playable in a browser, nothing to install.`));

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
        await setFollowing(session.user.uid, uid, now, session.profile?.username);
        followBtn.classList.toggle('on', now);
        followBtn.textContent = now ? 'FOLLOWING' : 'FOLLOW';
        toast(now ? `Following <b>${escape(p.username)}</b>` : `Unfollowed ${escape(p.username)}`);
      } catch (err) { toast(`Follow failed — ${(err as Error).message}`); }
    });

    const box = this.root.querySelector<HTMLElement>('.profile__tones')!;
    if (!tones.length) box.innerHTML = `<div class="t3k__note">Nothing shared yet.</div>`;
    for (const t of tones) {
      const card = this.renderToneCard(t);
      if (t.id === pinned) {
        card.classList.add('feed-card--pinned');
        const badge = document.createElement('span');
        badge.className = 'feed-card__pin';
        badge.textContent = 'PINNED';
        card.prepend(badge);
      }
      box.appendChild(card);
    }
  }

  private soundCard(s: CloudPreset, isPinned = false): HTMLElement {
    const c = document.createElement('article');
    c.className = 'feed-card profile-sound' + (isPinned ? ' feed-card--pinned' : '');
    c.style.setProperty('--tone', AMP_ACCENT[s.amp] ?? '#9fd8e8');
    const when = s.createdAt ? timeAgo(s.createdAt.toMillis()) : '';
    c.innerHTML = `
      ${isPinned ? '<span class="feed-card__pin">PINNED</span>' : ''}
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
          <button class="t3k__pill ${isPinned ? 'on' : ''}" data-a="pin"
            title="${isPinned ? 'unpin from the top of your profile' : 'pin to the top of your profile'}">${isPinned ? 'PINNED' : 'PIN'}</button>
          <!-- "SHARE" used to sit here meaning PUT ON THE FEED, while the same
               word on a feed card means COPY A LINK. Two different actions
               under one label is a good way to be told sharing is broken. -->
          <button class="t3k__pill ${s.shared ? 'on' : ''}" data-a="feed">${s.shared ? 'ON FEED' : 'PUT ON FEED'}</button>
          ${s.shared ? `<button class="t3k__pill" data-a="copy" title="copy a link to this tone">COPY LINK</button>` : ''}
          <button class="looper__btn" data-a="del" title="delete">✕</button>
        </div>
      </div>`;
    c.querySelector('[data-a=load]')!.addEventListener('click', () => void this.applyPreset(s));
    c.querySelector('[data-a=pin]')!.addEventListener('click', async () => {
      const user = session.user;
      if (!user) return;
      const next = isPinned ? '' : s.id;
      try {
        await setPinned(user.uid, next);
        if (session.profile) session.profile.pinnedId = next;
        toast(next ? `<b>${escape(s.name)}</b> pinned to the top of your profile.`
                   : 'Unpinned.');
        void this.refresh();
      } catch (err) { toast(`Pin failed — ${(err as Error).message}`); }
    });
    // Only a tone that is ON the feed has a public page — a link to a private
    // one would 404 for everybody the owner sent it to.
    c.querySelector('[data-a=copy]')?.addEventListener('click', () => void shareLink(
      urlFor({ view: 'tone', id: s.id }),
      `${s.name} — a rig by ${session.profile?.username ?? 'me'}`,
      `${s.name}. Runs in your browser, nothing to install.`));

    c.querySelector('[data-a=feed]')!.addEventListener('click', async () => {
      try {
        if (s.shared) { await setShared(s.id, false); toast('Taken off the feed.'); }
        else {
          const desc = await promptDialog({
            title: 'Share it on the feed',
            body: 'Say what this sound is for. It shows under the name on your post.',
            placeholder: 'big ambient clean for the pad section…',
            value: s.description || '',
            confirmLabel: 'SHARE',
            multiline: true,
            maxLength: 500,
          });
          if (desc === null) return;          // cancelled — leave it unshared
          await setShared(s.id, true, desc.slice(0, 500));
          toast('<b>Shared to the feed.</b>');
        }
        void this.refresh();
      } catch (err) { toast(`Share failed — ${(err as Error).message}`, 4500); }
    });
    c.querySelector('[data-a=del]')!.addEventListener('click', async () => {
      if (!await confirmDialog({
        title: `Delete "${s.name}"?`,
        body: 'It goes from your profile and from this device\u2019s preset list.',
        note: s.shared
          ? 'It is on the feed, so it disappears from there too — including for anyone who has loaded it.'
          : undefined,
        confirmLabel: 'DELETE',
        danger: true,
      })) return;
      try {
        await deletePreset(s.id);
        // A save writes to BOTH libraries, so a delete has to clear both.
        // Removing only the cloud document is what left deleted sounds sitting
        // in the preset strip with nothing to remove them.
        const local = deleteUserPreset({ name: s.name, cloudId: s.id });
        this.onLibraryChanged?.();
        toast(local ? `<b>${s.name}</b> deleted — profile and preset list.`
                    : `<b>${s.name}</b> deleted.`);
        void this.refresh();
      } catch (err) { toast(`Delete failed — ${(err as Error).message}`, 4500); }
    });
    return c;
  }
}

/* ── the numbers ──────────────────────────────────────────────────────────
 *
 * Two rules, both learned the expensive way by everyone else in this
 * category:
 *
 * ZEROS ARE WORSE THAN NOTHING. "0 FOLLOWERS · 0 LIKES · 0 LOADS" is negative
 * social proof: it does not read as a new player, it reads as a rejected one.
 * The fix is thresholding rather than removal — a player with 300 loads must
 * still see 300, because hiding counts outright measurably costs engagement.
 * So a tile below its floor renders as nothing and the row collapses.
 *
 * DSEG7 IS THE MACHINE'S TYPEFACE. Seven-segment numerals are a promise that
 * something is being measured live — a delay time, a gain reduction. On a
 * follower count they are a category error, and on a zero they make the
 * emptiest fact on the page the brightest object on it. Social counts get
 * ordinary tabular figures; the rig keeps DSEG7. */
function tile(n: number, label: string, floor = 1): string {
  if (n < floor) return '';
  return `<div class="profile-tile"><span class="profile-tile__n">${n.toLocaleString()}</span><i>${label}</i></div>`;
}

/** Tenure — the one stat that can never be zero, which is exactly why it is
 *  here. It makes a brand-new player read as NEW instead of as NOBODY. */
function sinceTile(createdAt?: { toMillis(): number }): string {
  const ms = createdAt?.toMillis();
  const d = ms ? new Date(ms) : new Date();
  const when = d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }).toUpperCase();
  return `<div class="profile-tile profile-tile--since"><span class="profile-tile__n">${escape(when)}</span><i>PLAYING SINCE</i></div>`;
}
function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
