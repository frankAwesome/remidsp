/* Firestore rules tests, without the emulator.
 *
 * WHY THIS EXISTS: the rules could not be compile-checked on this machine —
 * the emulator needs a JRE and there is none — so a change went out that
 * looked obviously correct and broke saving a preset, sharing to the feed and
 * editing a profile, all at once. "It compiled" is not a test.
 *
 * Google's Security Rules API evaluates a ruleset against synthetic requests
 * server-side. No Java, no emulator, no deploy. It is the real evaluator.
 *
 *   node scripts/test-rules.mjs
 *
 * Auth comes from the token firebase-tools already stored, so if you can
 * deploy, you can run this.
 *
 * A NOTE ON functionMocks: rules that call get()/exists() need those mocked
 * or the evaluation errors. profileShapeOk calls holdsHandle(), which does
 * both, so profile cases mock them.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROJECT = 'remidsp-98208';
const RULES_PATH = process.argv[2] ?? 'firestore.rules';
const RULES = readFileSync(RULES_PATH, 'utf8');

function accessToken() {
  const p = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
  const tok = JSON.parse(readFileSync(p, 'utf8')).tokens ?? {};
  if (!tok.access_token) throw new Error('no firebase-tools access token — run `firebase login`');
  return tok;
}

/** Refresh if the stored access token has expired. */
async function freshToken() {
  const t = accessToken();
  if (t.expires_at && t.expires_at > Date.now() + 60_000) return t.access_token;
  // firebase-tools ships a public desktop client id; refreshing with it is
  // exactly what the CLI itself does.
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: t.refresh_token,
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

const now = new Date().toISOString();

/* ── the shapes the CLIENTS actually write ────────────────────────────────
 * Taken from src/cloud/store.ts. If these drift from the client, the tests
 * pass while production breaks, which is precisely what happened. */

const UID = 'player-uid-1';

const preset = (over = {}) => ({
  uid: UID,
  username: 'frankawesome',
  avatarUrl: '',
  name: 'Sunday Morning Swell',
  amp: 'camden',
  voice: 'camden_clean',
  params: { tempo: 92, amp_gain: 0.32, rvb_decay: 6.2 },
  // The three capture slots the client always writes — amp, drive pedal,
  // cab IR — null when nothing is picked. Written explicitly rather than
  // omitted, because that is what savePreset() sends.
  capture: null,
  drive: null,
  ir: null,
  shared: false,
  description: '',
  likesCount: 0, commentsCount: 0, downloadsCount: 0,
  createdAt: now, updatedAt: now,
  ...over,
});

const profile = (over = {}) => ({
  username: 'frankawesome',
  usernameLower: 'frankawesome',
  bio: '',
  avatarUrl: '',
  link: '',
  isPublic: true,
  updatedAt: now,
  ...over,
});

const GOOGLE_AVA = 'https://lh3.googleusercontent.com/a/ACg8ocKq2xExample_photo_url=s96-c';
const T3K_CAPTURE = {
  source: 'tone3000',
  label: 'Matchless DC30 Clean',
  modelId: '48213',
  modelUrl: 'https://storage.tone3000.com/models/48213/model.nam',
  creator: 'somecreator',
  license: 'CC BY-NC 4.0',
  toneUrl: 'https://www.tone3000.com/tones/48213',
  gear: 'amp-cab',
};
const T3K_PEDAL = {
  source: 'tone3000',
  label: 'Morning Glory V4',
  modelId: '99001',
  modelUrl: 'https://storage.tone3000.com/models/99001/model.nam',
  creator: 'pedalperson',
  license: 'CC BY-NC 4.0',
  toneUrl: 'https://www.tone3000.com/tones/99001',
  gear: 'pedal',
};
const T3K_IR = {
  source: 'tone3000',
  label: 'Greenback 4x12 · SM57 cap edge',
  modelId: '77042',
  modelUrl: 'https://storage.tone3000.com/models/77042/ir.wav',
  creator: 'cabperson',
  license: 'CC BY 4.0',
  toneUrl: 'https://www.tone3000.com/tones/77042',
  gear: 'cab',
};

/** Mocks for the two lookups holdsHandle() performs. */
const handleMocks = (uid = UID) => ([
  {
    function: 'get',
    args: [{ exact_value: `/databases/(default)/documents/usernames/frankawesome` }],
    result: { value: { data: { uid } } },
  },
  {
    function: 'exists',
    args: [{ exact_value: `/databases/(default)/documents/usernames/frankawesome` }],
    result: { value: true },
  },
]);

const auth = { uid: UID, token: { email: 'p@example.com', email_verified: true } };

const CASES = [
  /* ── the three things that broke ── */
  { name: 'save a preset (plain, no avatar)',
    expect: 'ALLOW', method: 'create', path: `presets/new1`, data: preset() },

  { name: 'save a preset with a GOOGLE sign-in avatar',
    expect: 'ALLOW', method: 'create', path: `presets/new2`,
    data: preset({ avatarUrl: GOOGLE_AVA }) },

  { name: 'save a preset with an inline data: avatar',
    expect: 'ALLOW', method: 'create', path: `presets/new3`,
    data: preset({ avatarUrl: 'data:image/jpeg;base64,' + 'A'.repeat(400) }) },

  { name: 'save a preset built on a TONE3000 capture',
    expect: 'ALLOW', method: 'create', path: `presets/new4`,
    data: preset({ capture: T3K_CAPTURE, avatarUrl: GOOGLE_AVA }) },

  // All three slots at once: the amp, the drive pedal and the cab, each a
  // reference and never the file. This is the shape that has to survive, or
  // a rig saved with a full TONE3000 front end comes back as a third of it.
  { name: 'save a preset with TONE3000 amp + pedal + cab refs',
    expect: 'ALLOW', method: 'create', path: `presets/new5`,
    data: preset({ capture: T3K_CAPTURE, drive: T3K_PEDAL, ir: T3K_IR, avatarUrl: GOOGLE_AVA }) },

  // The same lock the amp ref has, on the other two: no http, no javascript:,
  // no unbounded strings on a document thirty of which the feed renders.
  { name: 'REJECT a pedal ref whose model url is not https',
    expect: 'DENY', method: 'create', path: `presets/bad1`,
    data: preset({ drive: { ...T3K_PEDAL, modelUrl: 'http://evil.example/model.nam' } }) },

  { name: 'REJECT a cab ref carrying an unknown field',
    expect: 'DENY', method: 'create', path: `presets/bad2`,
    data: preset({ ir: { ...T3K_IR, payload: 'x'.repeat(50) } }) },

  // A url too short to slice: must DENY, not error the whole write out.
  { name: 'REJECT a stub tone url on a pedal ref',
    expect: 'DENY', method: 'create', path: `presets/bad3`,
    data: preset({ drive: { ...T3K_PEDAL, toneUrl: 'https:/' } }) },

  { name: 'REJECT an oversized creator on a cab ref',
    expect: 'DENY', method: 'create', path: `presets/bad4`,
    data: preset({ ir: { ...T3K_IR, creator: 'z'.repeat(400) } }) },

  { name: 'SHARE TO THE FEED (update shared -> true)',
    expect: 'ALLOW', method: 'update', path: `presets/existing`,
    data: preset({ shared: true, description: 'big ambient clean', avatarUrl: GOOGLE_AVA }),
    resource: preset({ avatarUrl: GOOGLE_AVA }) },

  { name: 'unshare',
    expect: 'ALLOW', method: 'update', path: `presets/existing`,
    data: preset({ shared: false, avatarUrl: GOOGLE_AVA }),
    resource: preset({ shared: true, avatarUrl: GOOGLE_AVA }) },

  { name: 'save a profile (link empty, google avatar)',
    expect: 'ALLOW', method: 'create', path: `profiles/${UID}`,
    data: profile({ avatarUrl: GOOGLE_AVA }), mocks: handleMocks() },

  { name: 'save a profile with a real link',
    expect: 'ALLOW', method: 'create', path: `profiles/${UID}`,
    data: profile({ link: 'https://youtube.com/@someone' }), mocks: handleMocks() },

  /* isolating each cause on its own, so a future regression names itself */
  { name: 'ISOLATE link: profile with EMPTY link, no avatar',
    expect: 'ALLOW', method: 'create', path: `profiles/${UID}`,
    data: profile(), mocks: handleMocks() },

  { name: 'ISOLATE capture: T3K capture, EMPTY avatar',
    expect: 'ALLOW', method: 'create', path: `presets/iso1`,
    data: preset({ capture: T3K_CAPTURE }) },

  { name: 'ISOLATE avatar: pasted third-party image url',
    expect: 'ALLOW', method: 'create', path: `presets/iso2`,
    data: preset({ avatarUrl: 'https://i.imgur.com/abc123.jpg' }) },

  /* ── the protections must still hold ── */
  { name: 'DENY a preset whose uid is someone else',
    expect: 'DENY', method: 'create', path: `presets/evil`,
    data: preset({ uid: 'someone-else' }) },

  { name: 'DENY a preset created with inflated counters',
    expect: 'DENY', method: 'create', path: `presets/evil2`,
    data: preset({ likesCount: 9999 }) },

  { name: 'DENY a javascript: capture url',
    expect: 'DENY', method: 'create', path: `presets/evil3`,
    data: preset({ capture: { ...T3K_CAPTURE, modelUrl: 'javascript:alert(1)' } }) },

  { name: 'DENY a capture creator carrying markup past the cap',
    expect: 'DENY', method: 'create', path: `presets/evil4`,
    data: preset({ capture: { ...T3K_CAPTURE, creator: '<img src=x onerror=alert(1)>'.repeat(20) } }) },

  { name: 'DENY an oversized inline avatar',
    expect: 'DENY', method: 'create', path: `presets/evil5`,
    data: preset({ avatarUrl: 'data:image/jpeg;base64,' + 'A'.repeat(13000) }) },

  { name: 'DENY an unauthenticated preset create',
    expect: 'DENY', method: 'create', path: `presets/evil6`, data: preset(), noAuth: true },
];

const testCase = (c) => ({
  expectation: c.expect,
  request: {
    auth: c.noAuth ? null : auth,
    path: `/databases/(default)/documents/${c.path}`,
    method: c.method,
    time: now,
    resource: { data: c.data },
  },
  ...(c.resource ? { resource: { data: c.resource } } : {}),
  ...(c.mocks ? { functionMocks: c.mocks } : {}),
});

const token = await freshToken();
const res = await fetch(
  `https://firebaserules.googleapis.com/v1/projects/${PROJECT}:test`,
  {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      source: { files: [{ name: 'firestore.rules', content: RULES }] },
      testSuite: { testCases: CASES.map(testCase) },
    }),
  },
);

if (!res.ok) {
  console.error(`API ${res.status}:`, await res.text());
  process.exit(2);
}
const out = await res.json();

if (out.issues?.length) {
  console.error('\nRULES DID NOT COMPILE:');
  for (const i of out.issues) {
    console.error(`  ${i.severity} line ${i.sourcePosition?.line}: ${i.description}`);
  }
  process.exit(2);
}

let failed = 0;
console.log(`\n  rules: ${RULES_PATH}`);
for (const [i, r] of (out.testResults ?? []).entries()) {
  const c = CASES[i];
  const ok = r.state === 'SUCCESS';
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${c.expect.padEnd(5)}] ${c.name}`);
  if (!ok) {
    for (const e of r.errorPosition ? [r.errorPosition] : []) {
      console.log(`         at rules line ${e.line}`);
    }
    if (r.debugMessages?.length) console.log(`         ${r.debugMessages.join('\n         ')}`);
  }
}
console.log(`\n  ${CASES.length - failed}/${CASES.length} passed\n`);
process.exit(failed ? 1 : 0);
