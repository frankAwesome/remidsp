/* The TONE3000 capture browser — a right-hand drawer in the site's editorial
 * language. Anonymous TRENDING rails out of the box; connect a free
 * publishable key for full search (newest / popular / gear filters) and
 * per-model loading. Amps load into the capture slot, IRs into the cab. */

import { t3k, Tone, T3kModel } from '../tone3000';
import { engine, CaptureInfo } from '../audio/engine';
import { store } from '../params';
import { toast } from './toast';
import { addRecent } from '../captures';

type LoadIr = (buf: AudioBuffer, name: string) => void;

export class T3kBrowser {
  root: HTMLElement;
  private list: HTMLElement;
  private mode: 'trending' | 'search' = 'trending';
  private gear: string | undefined;
  private sort: 'trending' | 'newest' | 'downloads-all-time' = 'trending';
  private query = '';
  private page = 1;
  private connectBtn!: HTMLButtonElement;
  private searchInput!: HTMLInputElement;
  private onLoadIr: LoadIr;

  constructor(onLoadIr: LoadIr) {
    this.onLoadIr = onLoadIr;
    this.root = document.createElement('div');
    this.root.className = 't3k';
    this.root.innerHTML = `
      <div class="t3k__panel">
        <div class="t3k__head">
          <div class="t3k__title">Captures<br><em>POWERED BY TONE3000</em></div>
          <button class="t3k__close" aria-label="close">✕</button>
        </div>
        <div class="t3k__bar" data-row="gear">
          <button class="t3k__pill on" data-gear="">ALL</button>
          <button class="t3k__pill" data-gear="amp">AMP</button>
          <button class="t3k__pill" data-gear="amp-cab">AMP + CAB</button>
          <button class="t3k__pill" data-gear="cab">CAB IR</button>
          <button class="t3k__pill" data-gear="pedal">PEDAL</button>
        </div>
        <div class="t3k__bar" data-row="search">
          <input type="search" placeholder="search the library… (connect to unlock)" disabled />
          <button class="t3k__pill" data-sort="trending">POPULAR</button>
          <button class="t3k__pill" data-sort="newest">LATEST</button>
          <button class="t3k__pill" data-sort="downloads-all-time">ALL-TIME</button>
        </div>
        <div class="t3k__list"></div>
        <div class="t3k__keyrow" hidden>
          <input type="password" placeholder="t3k_pub_… (tone3000.com → Settings → API Keys)" spellcheck="false" />
          <button class="t3k__pill" data-act="key-save">USE KEY</button>
          <button class="t3k__pill" data-act="key-reset">RESET</button>
        </div>
        <div class="t3k__foot">
          <button class="t3k__pill" data-act="connect">CONNECT</button>
          <button class="t3k__pill" data-act="key" title="the publishable key used for sign-in"></button>
          <span class="mono">CREATOR LICENSES APPLY</span>
          <a class="mono" style="margin-left:auto" href="https://www.tone3000.com" target="_blank" rel="noreferrer">TONE3000.COM ↗</a>
        </div>
      </div>`;
    document.body.appendChild(this.root);
    this.list = this.root.querySelector('.t3k__list')!;
    this.searchInput = this.root.querySelector('input')!;
    this.connectBtn = this.root.querySelector('[data-act=connect]')!;

    this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
    this.root.querySelector('.t3k__close')!.addEventListener('click', () => this.close());
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-gear]')) {
      b.addEventListener('click', () => {
        this.root.querySelectorAll('[data-gear]').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        this.gear = b.dataset.gear || undefined;
        this.page = 1;
        this.refresh();
      });
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-sort]')) {
      b.addEventListener('click', () => {
        this.root.querySelectorAll('[data-sort]').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        this.sort = b.dataset.sort as typeof this.sort;
        this.mode = t3k.connected ? 'search' : 'trending';
        this.page = 1;
        this.refresh();
      });
    }
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.query = this.searchInput.value;
        this.mode = 'search';
        this.page = 1;
        this.refresh();
      }
    });
    this.connectBtn.addEventListener('click', () => this.handleConnect());

    // Publishable-key management: pasted once, kept in localStorage. The
    // baked-in default works out of the box; players can bring their own.
    const keyRow = this.root.querySelector<HTMLElement>('.t3k__keyrow')!;
    const keyInput = keyRow.querySelector('input')!;
    const keyBtn = this.root.querySelector<HTMLButtonElement>('[data-act=key]')!;
    const syncKeyBtn = () => {
      keyBtn.textContent = `KEY · ${t3k.hasCustomKey ? 'YOURS' : 'DEFAULT'} (${t3k.maskedKey})`;
    };
    syncKeyBtn();
    keyBtn.addEventListener('click', () => {
      keyRow.hidden = !keyRow.hidden;
      if (!keyRow.hidden) keyInput.focus();
    });
    keyRow.querySelector('[data-act=key-save]')!.addEventListener('click', () => {
      const k = keyInput.value.trim();
      if (!k.startsWith('t3k_pub_')) { toast('That does not look like a publishable key (t3k_pub_…).'); return; }
      t3k.disconnect(); // tokens belong to the old client
      t3k.pubKey = k;
      keyInput.value = '';
      keyRow.hidden = true;
      syncKeyBtn();
      this.syncConnected();
      toast('<b>Key saved.</b> Hit CONNECT to sign in with it.');
    });
    keyRow.querySelector('[data-act=key-reset]')!.addEventListener('click', () => {
      t3k.disconnect();
      t3k.clearKey();
      keyRow.hidden = true;
      syncKeyBtn();
      this.syncConnected();
      toast('Back on the built-in key.');
    });

    // The capture gate can connect or re-key without this drawer ever opening.
    window.addEventListener('remi:t3k-changed', () => { syncKeyBtn(); this.syncConnected(); });

    this.syncConnected();
  }

  open() { this.root.classList.add('open'); this.refresh(); }
  close() { this.root.classList.remove('open'); }

  private syncConnected() {
    if (t3k.connected) {
      this.connectBtn.textContent = 'CONNECTED ●';
      this.connectBtn.classList.add('on');
      this.searchInput.disabled = false;
      this.searchInput.placeholder = 'search the library…';
    } else {
      this.connectBtn.textContent = 'CONNECT';
      this.connectBtn.classList.remove('on');
      this.searchInput.disabled = true;
    }
  }

  private async handleConnect() {
    if (t3k.connected) {
      t3k.disconnect();
      this.syncConnected();
      return;
    }
    try {
      toast('Opening TONE3000 sign-in…');
      await t3k.connect();
      toast('<b>Connected</b> to TONE3000');
      this.syncConnected();
      this.mode = 'search';
      this.refresh();
    } catch (err) {
      const msg = (err as Error).message;
      toast(/invalid|client|unauthorized/i.test(msg)
        ? `Connect failed — ${msg}. Check the KEY below (yours comes from tone3000.com → Settings → API Keys, with this site's /t3k-callback.html as a redirect URI).`
        : `Connect failed — ${msg}`, 6000);
    }
  }

  private async refresh() {
    this.list.innerHTML = `<div class="t3k__note">Loading…</div>`;
    let tones: Tone[];
    let footNote = '';
    try {
      if (this.mode === 'search' && t3k.connected) {
        const gears = this.gear === 'cab' ? 'cab' : this.gear;
        const res = await t3k.search({
          query: this.query || undefined, sort: this.sort, page: this.page,
          gears, format: this.gear === 'cab' ? 'ir' : 'nam',
        });
        tones = res.data ?? [];
        footNote = `page ${res.page} / ${res.total_pages}`;
      } else {
        tones = await t3k.trending(this.gear as Tone['gear'] | undefined) ?? [];
        footNote = t3k.connected ? '' :
          `Trending only — <b>CONNECT</b> a free TONE3000 key below to search the full library (latest · popular · all-time).`;
      }
    } catch (err) {
      this.list.innerHTML = `<div class="t3k__note">TONE3000 unreachable — ${(err as Error).message}</div>`;
      return;
    }
    try {
      this.render(tones, footNote);
    } catch (err) {
      this.list.innerHTML = `<div class="t3k__note">Display error — ${(err as Error).message}</div>`;
      console.error('t3k render', err, tones);
    }
  }

  private render(tones: Tone[], note: string) {
    this.list.innerHTML = '';
    if (note) {
      const n = document.createElement('div');
      n.className = 't3k__note';
      n.innerHTML = note;
      this.list.appendChild(n);
    }
    for (const t of tones) this.list.appendChild(this.card(t));
    if (this.mode === 'search') {
      const more = document.createElement('button');
      more.className = 't3k__pill';
      more.textContent = 'MORE →';
      more.addEventListener('click', () => { this.page++; this.refresh(); });
      this.list.appendChild(more);
    }
  }

  private card(t: Tone): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tone-card';
    const img = t.images?.[0];
    el.innerHTML = `
      ${img ? `<img class="tone-card__img" crossorigin="anonymous" loading="lazy" src="${escapeHtml(img)}" alt="">` : `<div class="tone-card__img"></div>`}
      <div class="tone-card__body">
        <div class="tone-card__title">${escapeHtml(t.title ?? `tone ${t.id}`)}</div>
        <div class="tone-card__meta">by <b>${escapeHtml(t.user?.username ?? '—')}</b>
          · ${(t.downloads_count ?? 0).toLocaleString()} downloads · ${escapeHtml(t.license ?? '—')}</div>
        <div class="tone-card__tags">
          ${t.gear ? `<span class="tone-card__tag">${escapeHtml(t.gear)}</span>` : ''}
          ${t.format ? `<span class="tone-card__tag">${escapeHtml(t.format)}</span>` : ''}
          ${t.a2_models_count ? `<span class="tone-card__tag">A2 ×${t.a2_models_count}</span>` : ''}
          ${t.irs_count ? `<span class="tone-card__tag">IR ×${t.irs_count}</span>` : ''}
        </div>
        <div class="t3k__models" hidden></div>
      </div>
      <button class="tone-card__load">${t3k.connected ? 'MODELS' : 'VIEW ↗'}</button>`;
    const btn = el.querySelector<HTMLButtonElement>('.tone-card__load')!;
    const modelsBox = el.querySelector<HTMLElement>('.t3k__models')!;
    btn.addEventListener('click', async () => {
      if (!t3k.connected) { window.open(t.url, '_blank', 'noreferrer'); return; }
      if (!modelsBox.hidden) { modelsBox.hidden = true; return; }
      modelsBox.hidden = false;
      modelsBox.innerHTML = `<div class="t3k__note">Loading models…</div>`;
      try {
        const isIr = t.format === 'ir';
        const models = isIr ? await t3k.models(t.id) :
          (await t3k.models(t.id, 2)).length ? await t3k.models(t.id, 2) : await t3k.models(t.id, 1);
        modelsBox.innerHTML = '';
        if (!models.length) modelsBox.innerHTML = `<div class="t3k__note">No loadable files on this tone.</div>`;
        for (const m of models) modelsBox.appendChild(this.modelRow(t, m, isIr));
      } catch (err) {
        modelsBox.innerHTML = `<div class="t3k__note">${(err as Error).message}</div>`;
      }
    });
    return el;
  }

  private modelRow(t: Tone, m: T3kModel, isIr: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 't3k__model';
    row.innerHTML = `<b>${escapeHtml(m.name || `model ${m.id}`)}</b>
      <span>${isIr ? 'IR' : `A${escapeHtml(m.architecture_version ?? '?')}`}${m.size && m.size !== 'custom' ? ` · ${escapeHtml(m.size)}` : ''}</span>
      <button>${isIr ? 'LOAD CAB' : 'LOAD AMP'}</button>`;
    row.querySelector('button')!.addEventListener('click', async () => {
      try {
        toast(`Loading <b>${escapeHtml(m.name || t.title)}</b>…`);
        const res = await t3k.fetchModelFile(m.model_url);
        if (isIr) {
          const arr = await res.arrayBuffer();
          const buf = await engine.ctx!.decodeAudioData(arr);
          this.onLoadIr(buf, m.name || t.title);
          toast(`<b>${escapeHtml(m.name || t.title)}</b> in the cab`);
        } else {
          const json = await res.text();
          const info: CaptureInfo = {
            name: m.name || t.title, source: 'tone3000',
            toneTitle: t.title, creator: t.user?.username,
            license: t.license, url: t.url,
            // 'amp-cab' means the speaker is already in there, so the cab IR
            // would be a second one; 'amp' is a DI that actually wants one.
            hasCab: t.gear === 'amp-cab' ? true : t.gear === 'amp' ? false : undefined,
          };
          await engine.loadCapture(json, info);
          store.set('amp_on', 1);
          // Remember it — the amp drawer's CAPTURE menu lists recent loads.
          addRecent({
            kind: 'tone3000', id: String(m.id), label: m.name || t.title,
            url: m.model_url, creator: t.user?.username, license: t.license, toneUrl: t.url,
            gear: t.gear,
          });
          window.dispatchEvent(new CustomEvent('remi:capture-loaded'));
          toast(`<b>${escapeHtml(info.name)}</b> on the amp · by ${escapeHtml(info.creator ?? '')}`);
        }
      } catch (err) {
        toast(`Load failed — ${(err as Error).message}`);
      }
    });
    return row;
  }
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
