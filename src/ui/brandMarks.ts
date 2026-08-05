/* Provider brand marks, inline.
 *
 * Sign-in buttons carry the provider's own mark — that is what their brand
 * guidelines ask for, and it is what makes the row instantly readable instead
 * of four identical grey rectangles. They are inlined as SVG rather than
 * fetched: an <img> per provider is four network round-trips on a panel that
 * should open instantly, and a tracker-shaped request to four third parties
 * from a page where the player has not signed in to anything yet.
 *
 * Google and Facebook keep their brand colours (their guidelines require the
 * full-colour mark); Apple and GitHub are monochrome marks and inherit the
 * button's text colour, which is what their guidelines ask for on dark.
 */

export const BRAND_MARKS: Record<string, string> = {
  google: `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>
    <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
    <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>
    <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>
  </svg>`,

  apple: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M17.05 12.54c-.02-2.4 1.96-3.55 2.05-3.61-1.12-1.63-2.86-1.86-3.47-1.88-1.48-.15-2.88.87-3.63.87-.75 0-1.9-.85-3.13-.83-1.61.02-3.09.93-3.92 2.37-1.67 2.9-.43 7.19 1.2 9.54.8 1.15 1.75 2.44 3 2.39 1.2-.05 1.66-.78 3.11-.78 1.45 0 1.86.78 3.13.75 1.29-.02 2.11-1.17 2.9-2.33.91-1.34 1.29-2.63 1.31-2.7-.03-.01-2.51-.96-2.55-3.79zM14.64 5.4c.66-.8 1.11-1.92.99-3.03-.95.04-2.11.63-2.79 1.43-.61.71-1.15 1.85-1.01 2.94 1.06.08 2.14-.54 2.81-1.34z"/>
  </svg>`,

  github: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
  </svg>`,

  facebook: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path fill="#1877F2" d="M24 12.07C24 5.44 18.63.07 12 .07S0 5.44 0 12.07c0 5.99 4.39 10.95 10.13 11.85v-8.38H7.08v-3.47h3.05V9.43c0-3.01 1.79-4.67 4.53-4.67 1.31 0 2.69.24 2.69.24v2.95h-1.51c-1.49 0-1.96.93-1.96 1.87v2.25h3.33l-.53 3.47h-2.8v8.38C19.61 23.02 24 18.06 24 12.07z"/>
    <path fill="#fff" d="M16.67 15.54l.53-3.47h-3.33V9.82c0-.94.47-1.87 1.96-1.87h1.51V5s-1.38-.24-2.69-.24c-2.74 0-4.53 1.66-4.53 4.67v2.64H7.08v3.47h3.05v8.38a12.1 12.1 0 0 0 3.74 0v-8.38h2.8z"/>
  </svg>`,
};

/** Label under/next to the mark. Google's is a full sentence per its
 *  guidelines ("Continue with Google"); the rest are just the name. */
export const PROVIDER_LABEL: Record<string, string> = {
  google: 'CONTINUE WITH GOOGLE',
  apple: 'APPLE',
  github: 'GITHUB',
  facebook: 'FACEBOOK',
};
