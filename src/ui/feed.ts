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

type ApplyCloudPreset = (p: CloudPreset) => Promise<void>;

const CHAIN: [string, string][] = [
  ['gate', 'gate_on'], ['comp', 'comp_on'], ['drive', 'drive_on'], ['amp', 'amp_on'],
  ['cab', 'cab_on'], ['sauce', 'sauce_on'], ['studio', 'studio_on'], ['chorus', 'cho_on'],
  ['delay', 'dly_on'], ['reverb', 'rvb_on'],
];
const AMP_ACCENT: Record<string, string> = {
  camden: '#8fd8cf', portland: '#e9b765', katahdin: '#c25a52',
};
const MACHINES = ['ROOM', 'HALL', 'PLATE', 'SPRING'];

export class FeedView {
  root: HTMLElement;
  private list: HTMLElement;
  private people: HTMLElement;
  private lane: 'everyone' | 'following' = 'everyone';
  private sort: FeedSort = 'latest';
  private amp = '';
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
            <option value="camden">CAMDEN</option>
            <option value="portland">PORTLAND</option>
            <option value="katahdin">KATAHDIN</option>
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

  async refresh() {
    this.list.innerHTML = `<div class="t3k__note">Loading the feed…</div>`;
    try {
      let items: CloudPreset[];
      if (this.lane === 'following') {
        if (!session.user) {
          this.list.innerHTML = `<div class="t3k__note">Sign in to follow players — their tones land here.</div>`;
          return;
        }
        const ids = await this.ensureFollowing();
        items = await followingFeed(this.sort, ids);
        if (this.amp) items = items.filter((p) => p.amp === this.amp);
        if (!ids.length) {
          this.list.innerHTML = `<div class="t3k__note">You're not following anyone yet — search players above and hit FOLLOW.</div>`;
          return;
        }
      } else {
        items = await feed(this.sort, this.amp || undefined);
      }
      this.list.innerHTML = items.length ? '' :
        `<div class="t3k__note">Nothing here yet — dial a sound, hit SAVE, tick "share to the feed".</div>`;
      for (const p of items) this.list.appendChild(this.card(p));
    } catch (err) {
      this.list.innerHTML = `<div class="t3k__note">Feed unavailable — ${(err as Error).message}</div>`;
    }
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
        await setFollowing(session.user.uid, h.uid, now);
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
    const accent = AMP_ACCENT[p.amp] ?? '#9fd8e8';
    c.style.setProperty('--tone', accent);
    const when = p.createdAt ? timeAgo(p.createdAt.toMillis()) : '';
    const g = (id: string, dflt = 0) => p.params?.[id] ?? dflt;

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
        <span class="feed-card__ampbadge">${escape(p.amp.toUpperCase())}</span>
      </header>
      <div class="feed-card__title">${escape(p.name)}</div>
      ${p.description ? `<p class="feed-card__desc">${escape(p.description)}</p>` : ''}
      <div class="feed-card__rig">
        <div class="feed-card__chain">${chips}</div>
        <div class="feed-card__stats">${stats.join('')}
          ${p.capture ? `<div class="feed-stat feed-stat--capture" title="${escape(p.capture.creator ? `by ${p.capture.creator} · ${p.capture.license ?? ''}` : '')}">
            <span class="feed-stat__label">${p.capture.source === 'tone3000' ? 'TONE3000' : 'CAPTURE'}</span>
            <span class="feed-stat__cap">${escape(p.capture.label)}</span></div>` : ''}
        </div>
      </div>
      <footer class="feed-card__foot">
        <button class="feed-card__like" data-a="like">♥ <span>${p.likesCount}</span></button>
        <button class="feed-card__mini" data-a="comments">COMMENTS <span>${p.commentsCount}</span></button>
        <span class="feed-card__mini">LOADS ${p.downloadsCount}</span>
        <button class="tone-card__load" data-a="load">LOAD THIS RIG</button>
      </footer>
      <div class="feed-card__comments" hidden></div>`;

    const likeBtn = c.querySelector<HTMLButtonElement>('[data-a=like]')!;
    if (session.user) void hasLiked(session.user.uid, p.id).then((v) => likeBtn.classList.toggle('on', v));
    likeBtn.addEventListener('click', async () => {
      if (!session.user) { toast('Sign in to like tones.'); this.openAccount(); return; }
      const liked = likeBtn.classList.contains('on');
      try {
        await setLiked(session.user.uid, p.id, !liked);
        likeBtn.classList.toggle('on', !liked);
        const n = likeBtn.querySelector('span')!;
        n.textContent = String(Number(n.textContent) + (liked ? -1 : 1));
      } catch (err) { toast(`Like failed — ${(err as Error).message}`); }
    });

    c.querySelector('[data-a=user]')!.addEventListener('click', () => this.openUser(p.uid, p.username));

    c.querySelector('[data-a=load]')!.addEventListener('click', async () => {
      await this.applyPreset(p);
      void countDownload(p.id);
      toast(`<b>${escape(p.name)}</b> loaded — by ${escape(p.username)}`);
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
          await addComment(session.user, session.profile, p.id, text, p.name);
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
