/* The icon set.
 *
 * One family, one weight: 24×24, 1.6 stroke, round caps and joins, drawn on
 * currentColor so every icon inherits the state of the control it sits in
 * (muted at rest, white on hover, dark on a lit button). Inline rather than a
 * font or a sprite sheet — a dozen small paths cost less than the request,
 * and nothing can flash unstyled while a font loads.
 *
 * Keep new icons on the same grid: 3px padding, strokes on half-pixels, no
 * fills except where a shape is genuinely solid (the record dot).
 */

const svg = (body: string) =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = {
  /** the rig — a channel strip's faders */
  rig: svg(`<path d="M5 3v7M5 14v7M12 3v4M12 11v10M19 3v11M19 18v3"/>
            <circle cx="5" cy="12" r="2"/><circle cx="12" cy="9" r="2"/><circle cx="19" cy="16" r="2"/>`),
  /** the feed — stacked cards */
  feed: svg(`<rect x="3" y="4" width="18" height="7" rx="1.5"/>
             <path d="M3 15h18M3 19h12"/>`),
  /** captures — a waveform coming down from the cloud */
  capture: svg(`<path d="M7 16H5.5a3.5 3.5 0 1 1 .9-6.88A5 5 0 0 1 16.5 9a3.5 3.5 0 0 1 1 6.86"/>
                <path d="M8 19v-3M11.5 21v-7M15 19v-3"/>`),
  /** save — the classic disk, squared off */
  save: svg(`<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h10L20 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/>
             <path d="M8 4v5h7M8 20v-5h8v5"/>`),
  /** the preset list */
  list: svg(`<path d="M4 6h1M4 12h1M4 18h1M9 6h11M9 12h11M9 18h11"/>`),
  /** a signed-out player */
  user: svg(`<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>`),
  /** the cabinet — a speaker in a box */
  cab: svg(`<rect x="4" y="3" width="16" height="18" rx="1.5"/>
            <circle cx="12" cy="14" r="4"/><circle cx="12" cy="14" r="1.2"/><path d="M12 6.5h.01"/>`),
  /** a warning */
  warn: svg(`<path d="M12 3.8 21 19.5H3z"/><path d="M12 10v4M12 17h.01"/>`),
  check: svg(`<path d="m5 12.5 4.5 4.5L19 7.5"/>`),
  /** take it with you */
  download: svg(`<path d="M12 3.5v11M7.5 10 12 14.5 16.5 10"/><path d="M4.5 17.5v1.6a1.4 1.4 0 0 0 1.4 1.4h12.2a1.4 1.4 0 0 0 1.4-1.4v-1.6"/>`),
  /** the tuner — a tuning fork, the one object that means only this */
  tuner: svg(`<path d="M8 3v8a4 4 0 0 0 8 0V3"/><path d="M12 15v6"/>`),
  /** messages — a talkback bubble */
  chat: svg(`<path d="M20 12.5a7.5 7.5 0 0 1-7.5 7.5c-1.3 0-2.5-.3-3.6-.9L4 20.5l1.4-4.2A7.5 7.5 0 1 1 20 12.5z"/>
             <path d="M8.6 12.5h.01M12.5 12.5h.01M16.4 12.5h.01"/>`),
  /** notifications — a bell */
  bell: svg(`<path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5z"/>
             <path d="M10 20a2 2 0 0 0 4 0"/>`),
  /** pin a tone to the top of a profile */
  pin: svg(`<path d="M9 4h6l-.6 6.2 2.6 2.8H7l2.6-2.8z"/><path d="M12 13v7.5"/>`),
  /** send a message */
  send: svg(`<path d="M4.5 12 20 4.5 15 20l-3.2-5.8z"/><path d="M11.8 14.2 20 4.5"/>`),
  /** an outward link */
  link: svg(`<path d="M13.5 10.5 20 4M14.5 4H20v5.5"/>
             <path d="M20 13v5.5A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4H11"/>`),
  /** block a player */
  block: svg(`<circle cx="12" cy="12" r="8.2"/><path d="M6.3 6.3l11.4 11.4"/>`),
} as const;

export type IconName = keyof typeof ICONS;

/** Icon + label, in the order every control in the header uses. */
export function withIcon(name: IconName, label: string): string {
  return `${ICONS[name]}<span>${label}</span>`;
}
