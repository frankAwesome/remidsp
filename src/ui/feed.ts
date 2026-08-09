/* THE FEED — shared tones from everyone, straight into your rig.
 *
 * Two lanes: EVERYONE and FOLLOWING (the people you follow). Search players
 * by name and follow them. Every post is a rig you can read before you load
 * it: amp-accented card, the chain spelled out in the suite's own chip art,
 * DSEG7 tempo/delay/reverb tiles, and TONE3000 provenance when the capture
 * came from the library. */

import {
  feed, followingFeed, hasLiked, setLiked, addComment, comments, countDownload,
  searchUsers, setFollowing, myFollowingIds,
  type CloudPreset, type FeedSort, type ProfileHit,
} from '../cloud/store';
import { session } from './account';
import { toast } from './toast';
import { DIVISIONS } from '../params';
import { t3k } from '../tone3000';
import { urlFor, hashFor } from './router';
import { shareLink } from './share';

/** Resolves false when the preset's own capture could not be fetched and the
 *  rig fell back to a bundled voice — the caller must not claim success. */
type ApplyCloudPreset = (p: CloudPreset) => Promise<boolean>;

const CHAIN: [string, string][] = [
  ['gate', 'gate_on'], ['comp', 'comp_on'], ['drive', 'drive_on'], ['amp', 'amp_on'],
  ['cab', 'cab_on'], ['sauce', 'sauce_on'], ['studio', 'studio_on'], ['chorus', 'cho_on'],
  ['delay', 'dly_on'], ['reverb', 'rvb_on'],
];
const AMP_ACCENT: Record<string, string> = {
  camden: '#8fd8cf', portland: '#e9b765', katahdin: '#c25a52',
};
/* A capture from TONE3000 is its own amp, and it gets its own accent. The
 * preset's `amp` field is the FACE — which render the rig wears — and a
 * player who loads someone's Marshall capture onto the Portland face has
 * not made a Portland. Colouring those cards by face would say they had. */
const T3K_ACCENT = '#9fd8e8';

/** Bundled voices, and pre-capture presets that predate the field, are the
 *  only ones the face actually describes. */
const isBundledAmp = (p: CloudPreset) => !p.capture || p.capture.source === 'bundled';
/** Stable per-capture key — the model id where there is one, else the label. */
const captureKey = (p: CloudPreset) => p.capture?.modelId || p.capture?.label || '';
const MACHINES = ['ROOM', 'HALL', 'PLATE', 'SPRING'];

export class FeedView {
  root: HTMLElement;
  private list: HTMLElement;
  private people: HTMLElement;
  private lane: 'everyone' | 'following' = 'everyone';
  private sort: FeedSort = 'latest';
  /** '' | 'bundled:<face>' | 't3k:*' | 't3k:<captureKey>' */
  private amp = '';
  /** Every TONE3000 capture the feed has shown, so the picker can offer them
   *  by name. Built from what comes back rather than from a second query —
   *  the list is only ever as complete as what has actually been seen. */
  private t3kSeen = new Map<string, string>();
  private followingIds: string[] | null = null;
  private followingSet = new Set<string>();
  private applyPreset: ApplyCloudPreset;
  private openAccount: () => void;
  private openUser: (uid: string, username?: string) => void;

  constructor(applyPreset: ApplyCloudPreset, openAccount: () => void,
              openUser: (uid: string, username?: string) => void = () => {}) {
    this.applyPreset = applyPreset;
    this.openAccount = openAccount;
    this.openUser = openUser;
    this.root = document.createElement('section');
    this.root.className = 'feed';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="feed__head">
        <div>
          <div class="feed__title">The Feed</div>
          <div class="hdr__caption">SHARED TONES · LOAD THEM STRAIGHT INTO THE RIG</div>
        </div>
        <div class="feed__filters">
          <div class="feed__lanes">
            <button class="t3k__pill on" data-lane="everyone">EVERYONE</button>
            <button class="t3k__pill" data-lane="following">FOLLOWING</button>
          </div>
          <button class="t3k__pill on" data-sort="latest">LATEST</button>
          <button class="t3k__pill" data-sort="liked">MOST LIKED</button>
          <button class="t3k__pill" data-sort="downloads">MOST LOADED</button>
          <select data-f="amp">
            <option value="">ALL AMPS</option>
            <optgroup label="BUNDLED">
              <option value="bundled:camden">CAMDEN</option>
              <option value="bundled:portland">PORTLAND</option>
              <option value="bundled:katahdin">KATAHDIN</option>
            </optgroup>
            <optgroup label="TONE3000" data-el="t3kgroup">
              <option value="t3k:*">ANY TONE3000 CAPTURE</option>
            </optgroup>
          </select>
          <input type="search" class="feed__search" placeholder="find players…" />
        </div>
      </div>
      <div class="feed__people" hidden></div>
      <div class="feed__list"></div>`;
    this.list = this.root.querySelector('.feed__list')!;
    this.people = this.root.querySelector('.feed__people')!;

    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-lane]')) {
      b.addEventListener('click', () => {
        this.root.querySelectorAll('[data-lane]').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        this.lane = b.dataset.lane as 'everyone' | 'following';
        void this.refresh();
      });
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-sort]')) {
      b.addEventListener('click', () => {
        this.root.querySelectorAll('[data-sort]').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        this.sort = b.dataset.sort as FeedSort;
        void this.refresh();
      });
    }
    this.root.querySelector<HTMLSelectElement>('[data-f=amp]')!.addEventListener('change', (e) => {
      this.amp = (e.target as HTMLSelectElement).value;
      void this.refresh();
    });
    const search = this.root.querySelector<HTMLInputElement>('.feed__search')!;
    let timer = 0;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void this.renderPeople(search.value), 250);
    });
  }

  invalidateFollowing() { this.followingIds = null; }

  private async ensureFollowing(): Promise<string[]> {
    if (!session.user) return [];
    if (this.followingIds) return this.followingIds;
    this.followingIds = await myFollowingIds(session.user.uid);
    this.followingSet = new Set(this.followingIds);
    return this.followingIds;
  }

  /** Bumped per refresh; a late response whose token is stale is dropped.
   *  Two refreshes can easily overlap — the router paints the feed and the
   *  auth listener refreshes it a moment later — and without this the slower
   *  one lands on top of the faster one's DOM, briefly showing every card
   *  twice. */
  private refreshSeq = 0;

  async refresh() {
    const seq = ++this.refreshSeq;
    this.list.innerHTML = `<div class="t3k__note">Loading the feed…</div>`;
    try {
      const [kind, val] = this.amp ? this.amp.split(':') : ['', ''];
      // Only a bundled selection can be narrowed server-side, and even then
      // only by face: `amp` is the render, so the query also returns TONE3000
      // presets wearing it. The capture test below is what actually decides.
      const serverAmp = kind === 'bundled' ? val : undefined;

      let items: CloudPreset[];
      if (this.lane === 'following') {
        if (!session.user) {
          this.list.innerHTML = `<div class="t3k__note">Sign in to follow players — their tones land here.</div>`;
          return;
        }
        const ids = await this.ensureFollowing();
        if (!ids.length) {
          this.list.innerHTML = `<div class="t3k__note">You're not following anyone yet — search players above and hit FOLLOW.</div>`;
          return;
        }
        items = await followingFeed(this.sort, ids);
        if (serverAmp) items = items.filter((p) => p.amp === serverAmp);
      } else {
        items = await feed(this.sort, serverAmp);
      }

      if (seq !== this.refreshSeq) return;     // a newer refresh owns the list
      this.rememberCaptures(items);
      items = items.filter((p) => this.matches(p, kind, val));

      this.list.innerHTML = items.length ? '' : `<div class="t3k__note">${this.emptyNote(kind, val)}</div>`;
      // One card per try. A preset whose params carry a string where a number
      // belongs makes .toFixed() throw, and throwing out here used to take the
      // WHOLE feed down to "Feed unavailable" for every visitor — a denial of
      // service costing one document write, removable by nobody but its author.
      // A card that cannot be drawn is now just a card that is not drawn.
      for (const p of items) {
        try {
          this.list.appendChild(this.card(p));
        } catch (err) {
          console.warn('skipped an unrenderable tone', p.id, err);
        }
      }
    } catch (err) {
      if (seq !== this.refreshSeq) return;
      this.list.innerHTML = `<div class="t3k__note">Feed unavailable — ${escape((err as Error).message)}</div>`;
    }
  }

  /** Does this preset belong under the chosen amp?
   *
   *  A bundled pick means the face AND a bundled capture: a TONE3000 capture
   *  sitting on the Camden render is not a Camden, however much it looks like
   *  one. A TONE3000 pick is the capture itself, which is the only thing that
   *  actually identifies the amp on those. */
  private matches(p: CloudPreset, kind: string, val: string): boolean {
    if (!kind) return true;
    if (kind === 'bundled') return isBundledAmp(p) && p.amp === val;
    if (p.capture?.source !== 'tone3000') return false;
    return val === '*' || captureKey(p) === val;
  }

  private emptyNote(kind: string, val: string): string {
    if (kind === 'bundled') return `No shared tones on <b>${escape(val)}</b> yet — the bundled amp, not a capture wearing its face.`;
    if (kind === 't3k') {
      return val === '*'
        ? 'No shared tones built on a TONE3000 capture yet.'
        : `No shared tones on <b>${escape(this.t3kSeen.get(val) ?? val)}</b> yet.`;
    }
    return 'Nothing here yet — dial a sound, hit SAVE, tick "share to the feed".';
  }

  /** Grow the TONE3000 group from whatever the feed has returned. */
  private rememberCaptures(items: CloudPreset[]) {
    let added = false;
    for (const p of items) {
      if (p.capture?.source !== 'tone3000') continue;
      const k = captureKey(p);
      if (!k || this.t3kSeen.has(k)) continue;
      this.t3kSeen.set(k, p.capture.label || k);
      added = true;
    }
    if (!added) return;
    const group = this.root.querySelector<HTMLElement>('[data-el=t3kgroup]');
    const sel = this.root.querySelector<HTMLSelectElement>('[data-f=amp]');
    if (!group || !sel) return;
    const keep = sel.value;
    group.innerHTML = `<option value="t3k:*">ANY TONE3000 CAPTURE</option>`
      + [...this.t3kSeen.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([k, label]) => `<option value="t3k:${escape(k)}">${escape(label.toUpperCase())}</option>`)
        .join('');
    sel.value = keep;   // rebuilding the group must not move the selection
  }

  /* ── people search ── */

  private async renderPeople(q: string) {
    if (!q.trim()) { this.people.hidden = true; this.people.innerHTML = ''; return; }
    this.people.hidden = false;
    this.people.innerHTML = `<div class="t3k__note">Searching players…</div>`;
    try {
      await this.ensureFollowing();
      const hits = await searchUsers(q);
      this.people.innerHTML = hits.length ? '' : `<div class="t3k__note">No players called "${escape(q)}".</div>`;
      for (const h of hits) this.people.appendChild(this.personCard(h));
    } catch (err) {
      this.people.innerHTML = `<div class="t3k__note">${(err as Error).message}</div>`;
    }
  }

  personCard(h: ProfileHit): HTMLElement {
    const me = session.user?.uid;
    const card = document.createElement('div');
    card.className = 'person-card';
    const following = this.followingSet.has(h.uid);
    card.innerHTML = `
      ${h.avatarUrl ? `<img crossorigin="anonymous" src="${escape(h.avatarUrl)}" alt="">` : `<div class="person-card__blank">${escape((h.username || '?')[0].toUpperCase())}</div>`}
      <div class="person-card__body">
        <b>${escape(h.username)}</b>
        <span>${h.followersCount ?? 0} follower${(h.followersCount ?? 0) === 1 ? '' : 's'}${h.bio ? ` · ${escape(h.bio.slice(0, 70))}` : ''}</span>
      </div>
      ${h.uid === me ? '<span class="person-card__you">YOU</span>'
        : `<button class="t3k__pill ${following ? 'on' : ''}">${following ? 'FOLLOWING' : 'FOLLOW'}</button>`}`;
    // the card body opens their profile; the pill stays the follow control
    card.classList.add('person-card--link');
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      this.openUser(h.uid, h.username);
    });
    const btn = card.querySelector('button');
    btn?.addEventListener('click', async () => {
      if (!session.user) { toast('Sign in to follow players.'); this.openAccount(); return; }
      const now = !this.followingSet.has(h.uid);
      try {
        await setFollowing(session.user.uid, h.uid, now, session.profile?.username);
        if (now) this.followingSet.add(h.uid); else this.followingSet.delete(h.uid);
        this.followingIds = [...this.followingSet];
        btn.classList.toggle('on', now);
        btn.textContent = now ? 'FOLLOWING' : 'FOLLOW';
        toast(now ? `Following <b>${escape(h.username)}</b>` : `Unfollowed ${escape(h.username)}`);
      } catch (err) { toast(`Follow failed — ${(err as Error).message}`); }
    });
    return card;
  }

  /* ── the tone post ── */

  toneCard(p: CloudPreset): HTMLElement { return this.card(p); }

  private card(p: CloudPreset): HTMLElement {
    const c = document.createElement('article');
    c.className = 'feed-card';
    const t3kAmp = p.capture?.source === 'tone3000';
    const accent = t3kAmp ? T3K_ACCENT : (AMP_ACCENT[p.amp] ?? T3K_ACCENT);
    c.style.setProperty('--tone', accent);
    const when = p.createdAt ? timeAgo(p.createdAt.toMillis()) : '';
    // Belt as well as the try/catch in refresh(): a params value is supposed
    // to be a number and the rules now insist on it, but documents written
    // before they did are still out there.
    const g = (id: string, dflt = 0) => {
      const v = p.params?.[id];
      return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
    };
    // Flag the sign-in up front — better than finding out after the click.
    const needsT3k = p.capture?.source === 'tone3000' && !t3k.connected;

    const chips = CHAIN.map(([key, param]) =>
      `<img class="feed-chip ${g(param, key === 'amp' ? 1 : 0) > 0.5 ? 'on' : ''}"
        src="/assets/ui/chip_${key}_${g(param, key === 'amp' ? 1 : 0) > 0.5 ? 'on' : 'off'}.png"
        alt="${key}" title="${key}${g(param) > 0.5 ? '' : ' (off)'}">`).join('');

    const stats: string[] = [];
    stats.push(stat('TEMPO', `${(g('tempo', 120)).toFixed(0)}`, 'BPM'));
    if (g('dly_on', 1) > 0.5 && g('dlyA_on', 1) > 0.5) {
      const div = DIVISIONS[g('dlyA_div', 2) | 0] ?? '';
      stats.push(stat('DELAY', `${Math.round(g('dlyA_time', 357))}`, `MS${div && div !== 'Manual' ? ' · ' + div.toUpperCase() : ''}`));
    }
    if (g('rvb_on', 1) > 0.5) {
      stats.push(stat(MACHINES[g('rvb_machine', 1) | 0] ?? 'VERB', `${g('rvb_decay', 3.5).toFixed(1)}`, 'S DECAY'));
    }
    stats.push(stat('GAIN', (g('amp_gain', 0.45) * 10).toFixed(1), '/ 10'));

    c.innerHTML = `
      <header class="feed-card__head">
        <button class="feed-card__byline" data-a="user" title="open profile">
          ${p.avatarUrl ? `<img class="feed-card__ava" crossorigin="anonymous" src="${escape(p.avatarUrl)}" alt="">`
            : `<div class="feed-card__ava feed-card__ava--blank">${escape((p.username || '?')[0].toUpperCase())}</div>`}
          <span class="feed-card__who"><b>${escape(p.username)}</b><span>${when}</span></span>
        </button>
        ${t3kAmp
          ? `<span class="feed-card__ampbadge feed-card__ampbadge--t3k"
               title="${escape(p.capture!.label)} — a TONE3000 capture${p.capture!.creator ? `, by ${escape(p.capture!.creator)}` : ''}. Shown on the ${escape(p.amp)} face.">
               ${escape(p.capture!.label.toUpperCase())}</span>`
          : `<span class="feed-card__ampbadge" title="the bundled ${escape(p.amp)} amp">${escape(p.amp.toUpperCase())}</span>`}
      </header>
      <a class="feed-card__title" href="${escape(hashFor({ view: 'tone', id: p.id }))}"
         title="open this tone on its own page">${escape(p.name)}</a>
      ${p.description ? `<p class="feed-card__desc">${escape(p.description)}</p>` : ''}
      <div class="feed-card__rig">
        <div class="feed-card__chain">${chips}</div>
        <div class="feed-card__stats">${stats.join('')}
          ${p.capture ? `<div class="feed-stat feed-stat--capture${needsT3k ? ' feed-stat--locked' : ''}"
            title="${escape(p.capture.creator ? `by ${p.capture.creator} · ${p.capture.license ?? ''}` : '')}">
            <span class="feed-stat__label">${p.capture.source === 'tone3000' ? 'TONE3000' : 'CAPTURE'}</span>
            <span class="feed-stat__cap">${escape(p.capture.label)}</span></div>` : ''}
          ${needsT3k ? `<div class="feed-stat feed-stat--needs" title="LOAD THIS RIG will walk you through it">
            <span class="feed-stat__label">NEEDS</span>
            <span class="feed-stat__cap">TONE3000 SIGN-IN</span></div>` : ''}
        </div>
      </div>
      <footer class="feed-card__foot">
        <button class="feed-card__like" data-a="like">♥ <span>${p.likesCount}</span></button>
        <button class="feed-card__mini" data-a="comments">COMMENTS <span>${p.commentsCount}</span></button>
        <span class="feed-card__mini">LOADS ${p.downloadsCount}</span>
        <button class="feed-card__mini feed-card__share" data-a="share" title="copy a link to this tone">SHARE</button>
        <button class="tone-card__load" data-a="load">LOAD THIS RIG</button>
      </footer>
      <div class="feed-card__comments" hidden></div>`;

    const likeBtn = c.querySelector<HTMLButtonElement>('[data-a=like]')!;
    if (session.user) void hasLiked(session.user.uid, p.id).then((v) => likeBtn.classList.toggle('on', v));
    likeBtn.addEventListener('click', async () => {
      if (!session.user) { toast('Sign in to like tones.'); this.openAccount(); return; }
      const liked = likeBtn.classList.contains('on');
      try {
        await setLiked(session.user.uid, p.id, !liked, {
          ownerUid: p.uid, presetName: p.name,
          actorName: session.profile?.username ?? 'a player',
        });
        likeBtn.classList.toggle('on', !liked);
        const n = likeBtn.querySelector('span')!;
        n.textContent = String(Number(n.textContent) + (liked ? -1 : 1));
      } catch (err) { toast(`Like failed — ${(err as Error).message}`); }
    });

    c.querySelector('[data-a=user]')!.addEventListener('click', () => this.openUser(p.uid, p.username));

    c.querySelector('[data-a=share]')!.addEventListener('click', () => void sharePreset(p));

    c.querySelector('[data-a=load]')!.addEventListener('click', async () => {
      const whole = await this.applyPreset(p);
      void countDownload(p.id);
      // When the capture did not come down, applyPreset has already said so
      // in plain terms — do not paper over it with a cheerful "loaded".
      if (whole) toast(`<b>${escape(p.name)}</b> loaded — by ${escape(p.username)}`);
    });

    const box = c.querySelector<HTMLElement>('.feed-card__comments')!;
    c.querySelector('[data-a=comments]')!.addEventListener('click', async () => {
      if (!box.hidden) { box.hidden = true; return; }
      box.hidden = false;
      await this.renderComments(box, p);
    });
    return c;
  }

  private async renderComments(box: HTMLElement, p: CloudPreset) {
    box.innerHTML = `<div class="t3k__note">Loading comments…</div>`;
    try {
      const list = await comments(p.id);
      box.innerHTML = list.length ? '' : `<div class="t3k__note">No comments yet — say the first thing.</div>`;
      for (const cm of list) box.appendChild(renderCommentRow(cm));
      const form = document.createElement('form');
      form.className = 'feed-comment__form';
      form.innerHTML = `<input maxlength="500" placeholder="${session.user ? 'say something…' : 'sign in to comment'}"
        ${session.user ? '' : 'disabled'} /><button class="t3k__pill" ${session.user ? '' : 'disabled'}>POST</button>`;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = form.querySelector('input')!;
        const text = input.value.trim();
        if (!text || !session.user || !session.profile) return;
        try {
          await addComment(session.user, session.profile, p.id, text, p.name, p.uid);
          input.value = '';
          const n = box.closest('.feed-card')?.querySelector('[data-a=comments] span');
          if (n) n.textContent = String(Number(n.textContent) + 1);
          await this.renderComments(box, p);
        } catch (err) { toast(`Comment failed — ${(err as Error).message}`); }
      });
      box.appendChild(form);
    } catch (err) {
      box.innerHTML = `<div class="t3k__note">${(err as Error).message}</div>`;
    }
  }
}

/** Send a tone somewhere. The mechanics live in ui/share.ts; this is just
 *  the words that go with a rig. */
export async function sharePreset(p: CloudPreset): Promise<void> {
  await shareLink(
    urlFor({ view: 'tone', id: p.id }),
    `${p.name} — a rig by ${p.username}`,
    `${p.name} by ${p.username}. Runs in your browser, nothing to install.`,
  );
}

function stat(label: string, value: string, unit: string): string {
  return `<div class="feed-stat"><span class="feed-stat__label">${label}</span>
    <span class="feed-stat__val led-text">${value}</span>
    <span class="feed-stat__unit">${unit}</span></div>`;
}
/** One spoken line: avatar disc · name · time · the words. Shared with the
 *  profile page so comments speak the same language everywhere. */
export function renderCommentRow(cm: { username: string; avatarUrl?: string; text: string;
  createdAt?: { toMillis(): number } }, context?: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'feed-comment';
  const when = cm.createdAt ? timeAgo(cm.createdAt.toMillis()) : '';
  row.innerHTML = `
    ${cm.avatarUrl
      ? `<img class="feed-comment__ava" crossorigin="anonymous" src="${escape(cm.avatarUrl)}" alt="">`
      : `<span class="feed-comment__ava feed-comment__ava--blank">${escape((cm.username || '?')[0].toUpperCase())}</span>`}
    <div class="feed-comment__body">
      <div class="feed-comment__meta"><b>${escape(cm.username)}</b>
        ${context ? `<i>on ${escape(context)}</i>` : ''}<span>${when}</span></div>
      <div class="feed-comment__text">${escape(cm.text)}</div>
    </div>`;
  return row;
}

export function timeAgo(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
