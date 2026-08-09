/* MESSAGES — 1:1 talk between players who follow each other.
 *
 * The gate IS the moderation model: a thread can only exist between mutual
 * follows (the rules enforce it server-side; this panel just explains it),
 * and either side can block, which stops new messages landing without ever
 * telling the sender. Public-first stays the product's centre of gravity —
 * this exists for the moment two players want to swap a capture link or set
 * up a Friday, not to be an inbox you live in.
 *
 * One panel, two panes: threads on the left, the open conversation on the
 * right. Realtime while open (onSnapshot), silent when closed — the header
 * dot is driven by the thread watcher in main.ts, not by this panel. */

import {
  watchThreads, watchMessages, sendDm, markThreadRead, ensureThread,
  isMutualFollow, setBlocked, isBlocked, otherOf, threadIdFor,
  type ThreadDoc, type DmDoc,
} from '../cloud/store';
import { session } from './account';
import { toast } from './toast';
import { timeAgo } from './feed';
import { ICONS } from './icons';
import { esc } from './esc';

export class MessagesUI {
  root: HTMLElement;
  private threadsBox: HTMLElement;
  private convoBox: HTMLElement;
  private threads: ThreadDoc[] = [];
  private openId: string | null = null;
  private unThreads: (() => void) | null = null;
  private unMsgs: (() => void) | null = null;
  /** Pre-seeded byline for a thread that has no doc yet (fresh DM from a
   *  profile) — watchThreads knows nothing about it until the first send. */
  private pending: { id: string; name: string } | null = null;
  private onEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.root.classList.contains('open')) this.close();
  };

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 't3k dm';
    this.root.innerHTML = `
      <div class="t3k__panel dm__panel">
        <div class="t3k__head">
          <div class="t3k__title">Messages<br><em>PLAYERS YOU FOLLOW · WHO FOLLOW YOU BACK</em></div>
          <button class="t3k__close" aria-label="close">✕</button>
        </div>
        <div class="dm__body">
          <div class="dm__threads"></div>
          <div class="dm__convo"></div>
        </div>
      </div>`;
    document.body.appendChild(this.root);
    this.threadsBox = this.root.querySelector('.dm__threads')!;
    this.convoBox = this.root.querySelector('.dm__convo')!;
    this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
    this.root.querySelector('.t3k__close')!.addEventListener('click', () => this.close());
  }

  /** Open the panel — on a specific player when coming from their profile. */
  async open(target?: { uid: string; username: string; avatarUrl: string }) {
    const me = session.user;
    if (!me || !session.profile) { toast('Sign in to message players.'); return; }
    this.root.classList.add('open');
    window.addEventListener('keydown', this.onEsc);
    this.startThreads();

    if (target && target.uid !== me.uid) {
      if (!(await isMutualFollow(me.uid, target.uid))) {
        this.paintConvoNote(`You and <b>${esc(target.username)}</b> need to follow
          each other before you can message. It keeps every inbox here wanted.`);
        return;
      }
      try {
        const id = await ensureThread(
          { uid: me.uid, username: session.profile.username, avatarUrl: session.profile.avatarUrl ?? '' },
          { uid: target.uid, username: target.username, avatarUrl: target.avatarUrl ?? '' });
        this.pending = { id, name: target.username };
        this.show(id);
      } catch {
        this.paintConvoNote('Could not open that conversation — they may have you blocked, or the follow is not mutual any more.');
      }
    } else if (!this.openId) {
      this.paintConvoNote('Pick a conversation — or open one from any player’s profile with the MESSAGE key.');
    }
  }

  close() {
    this.root.classList.remove('open');
    window.removeEventListener('keydown', this.onEsc);
    this.unThreads?.(); this.unThreads = null;
    this.unMsgs?.(); this.unMsgs = null;
    this.openId = null;
  }

  private startThreads() {
    const me = session.user!.uid;
    this.unThreads?.();
    this.threadsBox.innerHTML = `<div class="t3k__note">Loading…</div>`;
    this.unThreads = watchThreads(me, (ts) => {
      this.threads = ts;
      this.paintThreads();
    });
  }

  private paintThreads() {
    const me = session.user!.uid;
    this.threadsBox.innerHTML = this.threads.length ? '' :
      `<div class="t3k__note">No conversations yet. Follow a player who follows
        you back, then press <b>MESSAGE</b> on their profile.</div>`;
    for (const t of this.threads) {
      const other = otherOf(t, me);
      const unread = t.lastUid && t.lastUid !== me
        && (t.lastAt?.toMillis() ?? 0) > (t.reads?.[me]?.toMillis() ?? 0);
      const row = document.createElement('button');
      row.className = 'dm-thread' + (t.id === this.openId ? ' on' : '') + (unread ? ' unread' : '');
      const ava = t.avatars?.[other];
      row.innerHTML = `
        ${ava ? `<img class="dm-thread__ava" crossorigin="anonymous" src="${esc(ava)}" alt="">`
              : `<span class="dm-thread__ava dm-thread__ava--blank">${esc((t.names?.[other] || '?')[0].toUpperCase())}</span>`}
        <span class="dm-thread__body">
          <b>${esc(t.names?.[other] ?? 'player')}</b>
          <i>${t.lastText ? esc(t.lastText.slice(0, 60)) : 'say hello'}</i>
        </span>
        <span class="dm-thread__when">${t.lastAt ? timeAgo(t.lastAt.toMillis()) : ''}</span>`;
      row.addEventListener('click', () => this.show(t.id));
      this.threadsBox.appendChild(row);
    }
  }

  private paintConvoNote(html: string) {
    this.convoBox.innerHTML = `<div class="dm__empty"><div class="t3k__note">${html}</div></div>`;
  }

  private show(threadId: string) {
    const me = session.user!.uid;
    this.openId = threadId;
    this.paintThreads();
    this.unMsgs?.();

    const t = this.threads.find((x) => x.id === threadId);
    const otherUid = t ? otherOf(t, me)
      : threadId.replace(me, '').replace('_', '');
    const otherName = t?.names?.[otherUid]
      ?? (this.pending?.id === threadId ? this.pending.name : 'player');

    this.convoBox.innerHTML = `
      <div class="dm-convo__head">
        <b>${esc(otherName)}</b>
        <button class="t3k__pill dm-convo__block" title="block — their messages stop landing, they are not told">BLOCK</button>
      </div>
      <div class="dm-convo__scroll"><div class="t3k__note">Loading…</div></div>
      <form class="dm-convo__form">
        <input maxlength="1000" placeholder="write to ${esc(otherName)}…" autocomplete="off" />
        <button class="hdr__btn hdr__btn--lit dm-convo__send" title="send">${ICONS.send}</button>
      </form>`;

    const scroll = this.convoBox.querySelector<HTMLElement>('.dm-convo__scroll')!;
    const form = this.convoBox.querySelector<HTMLFormElement>('form')!;
    const input = form.querySelector('input')!;

    const blockBtn = this.convoBox.querySelector<HTMLButtonElement>('.dm-convo__block')!;
    void isBlocked(me, otherUid).then((b) => {
      blockBtn.classList.toggle('on', b);
      blockBtn.textContent = b ? 'BLOCKED' : 'BLOCK';
    });
    blockBtn.addEventListener('click', async () => {
      const now = !blockBtn.classList.contains('on');
      try {
        await setBlocked(me, otherUid, now);
        blockBtn.classList.toggle('on', now);
        blockBtn.textContent = now ? 'BLOCKED' : 'BLOCK';
        toast(now ? `<b>${esc(otherName)}</b> blocked — their messages stop landing.`
                  : `${esc(otherName)} unblocked.`);
      } catch (err) { toast(`That did not stick — ${(err as Error).message}`); }
    });

    this.unMsgs = watchMessages(threadId, (msgs) => {
      this.paintMessages(scroll, msgs);
      void markThreadRead(threadId, me);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try { await sendDm(threadId, me, text); }
      catch {
        toast('That message was refused — you may be blocked, or the follow is no longer mutual.', 5000);
      }
    });
    input.focus();
  }

  private paintMessages(scroll: HTMLElement, msgs: DmDoc[]) {
    const me = session.user!.uid;
    scroll.innerHTML = msgs.length ? '' :
      `<div class="t3k__note">Nothing here yet — say the first thing.</div>`;
    for (const m of msgs) {
      const b = document.createElement('div');
      b.className = 'dm-msg' + (m.uid === me ? ' dm-msg--mine' : '');
      b.innerHTML = `<span class="dm-msg__text">${esc(m.text)}</span>
        <span class="dm-msg__when">${m.createdAt ? timeAgo(m.createdAt.toMillis()) : 'now'}</span>`;
      scroll.appendChild(b);
    }
    scroll.scrollTop = scroll.scrollHeight;
  }
}

/** The id a conversation with `other` would have — for prefetch-y callers. */
export function dmThreadId(me: string, other: string): string {
  return threadIdFor(me, other);
}
