/* NOTIFICATIONS — the return loop.
 *
 * A like, a comment, a follow: each one is a small fact that somebody out
 * there heard you. The panel lists them newest first, marks everything read
 * the moment it is looked at (a badge you have seen is a badge answered),
 * and every row is a door — a tone note opens the tone, a follow opens the
 * player. Nothing here is precious: notifications are decoration on top of
 * the product, never load-bearing, and a failure paints an empty list. */

import { myNotes, markNotesRead, type NoteDoc } from '../cloud/store';
import { session } from './account';
import { toast } from './toast';
import { timeAgo } from './feed';
import { esc } from './esc';
import { go } from './router';

const VERB: Record<NoteDoc['kind'], string> = {
  like: 'likes', comment: 'commented on', follow: 'now follows you',
};

export class NoticesUI {
  root: HTMLElement;
  private body: HTMLElement;
  /** Fired after the panel marks things read, so the header dot can clear. */
  onSeen: (() => void) | null = null;
  private onEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.root.classList.contains('open')) this.close();
  };

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 't3k notices';
    this.root.innerHTML = `
      <div class="t3k__panel modal__panel--sm">
        <div class="t3k__head">
          <div class="t3k__title">Activity<br><em>WHO HEARD YOU</em></div>
          <button class="t3k__close" aria-label="close">✕</button>
        </div>
        <div class="t3k__list notices__list"></div>
      </div>`;
    document.body.appendChild(this.root);
    this.body = this.root.querySelector('.notices__list')!;
    this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
    this.root.querySelector('.t3k__close')!.addEventListener('click', () => this.close());
  }

  async open() {
    const user = session.user;
    if (!user) { toast('Sign in to see your activity.'); return; }
    this.root.classList.add('open');
    window.addEventListener('keydown', this.onEsc);
    this.body.innerHTML = `<div class="t3k__note">Loading…</div>`;
    let notes: NoteDoc[] = [];
    try { notes = await myNotes(user.uid); } catch { /* painted below */ }

    this.body.innerHTML = notes.length ? '' :
      `<div class="t3k__note">Nothing yet. Share a tone to the feed — likes,
        comments and follows land here the moment they happen.</div>`;

    for (const n of notes) {
      const row = document.createElement('button');
      row.className = 'notice' + (n.read ? '' : ' notice--fresh');
      row.innerHTML = `
        <span class="notice__glyph notice__glyph--${n.kind}">${
          n.kind === 'like' ? '♥' : n.kind === 'comment' ? '💬' : '＋'}</span>
        <span class="notice__body">
          <b>${esc(n.actorName)}</b> ${VERB[n.kind]}
          ${n.toneName ? `<i>${esc(n.toneName)}</i>` : ''}
        </span>
        <span class="notice__when">${n.createdAt ? timeAgo(n.createdAt.toMillis()) : ''}</span>`;
      row.addEventListener('click', () => {
        this.close();
        if (n.kind === 'follow') go({ view: 'user', handle: n.actorName });
        else if (n.toneId) go({ view: 'tone', id: n.toneId });
      });
      this.body.appendChild(row);
    }

    // Looked at means read. The rows keep their fresh tint until reopen.
    const unread = notes.filter((n) => !n.read).map((n) => n.id);
    if (unread.length) {
      void markNotesRead(user.uid, unread).then(() => this.onSeen?.());
    }
  }

  close() {
    this.root.classList.remove('open');
    window.removeEventListener('keydown', this.onEsc);
  }
}
