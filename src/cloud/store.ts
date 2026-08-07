/* Firestore data layer — profiles, the cloud preset library, and the feed.
 *
 *   profiles/{uid}                   username · bio · avatarUrl
 *   presets/{id}                     a saved sound: params + amp/voice +
 *                                    capture ref (incl. TONE3000 model refs —
 *                                    we store the reference, never the file),
 *                                    shared flag + description + counters
 *   presets/{id}/likes/{uid}         one doc per liker
 *   presets/{id}/comments/{cid}      uid · username · text
 */

import {
  collection, collectionGroup, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, serverTimestamp, increment, writeBatch, runTransaction,
  type Timestamp,
} from 'firebase/firestore';
import { db, type User } from './fb';

export interface Profile {
  username: string;
  bio: string;
  avatarUrl: string;
  /** Is the profile PAGE browsable by other players? Default true. Turning it
   *  off hides the page (bio, sounds list, comment history) and drops the
   *  player out of user search. Tones already shared to the feed stay on the
   *  feed with their byline — sharing a tone is its own, separate choice. */
  isPublic?: boolean;
  followersCount?: number;
  followingCount?: number;
  /** One link — a YouTube channel, a band page. For a guitarist this is the
   *  proof-of-existence a bio cannot be. */
  link?: string;
  /** When this player showed up.
   *
   *  This exists to solve the empty profile. A new player's every social
   *  number is zero, and a page of zeros reads as "nobody" rather than as
   *  "new" — negative social proof, in the literature's terms. Tenure is the
   *  one fact that can never be zero, which is why it is the thing to show
   *  when everything else would be. */
  createdAt?: Timestamp;
}
export interface ProfileHit extends Profile { uid: string }

export interface CaptureRefDoc {
  source: 'bundled' | 'tone3000';
  label: string;
  stem?: string;
  modelId?: string;
  modelUrl?: string;
  creator?: string;
  license?: string;
  toneUrl?: string;
}

export interface CloudPreset {
  id: string;
  uid: string;
  username: string;
  avatarUrl?: string;
  name: string;
  amp: string;
  voice: string;
  params: Record<string, number>;
  capture: CaptureRefDoc | null;
  shared: boolean;
  description: string;
  likesCount: number;
  commentsCount: number;
  downloadsCount: number;
  createdAt?: Timestamp;
}

export interface CommentDoc {
  id: string;
  uid: string;
  username: string;
  avatarUrl?: string;
  presetName?: string;   // denormalized for the profile's comment history
  presetId?: string;     // derived from the doc path on read
  text: string;
  createdAt?: Timestamp;
}

export type FeedSort = 'latest' | 'liked' | 'downloads';

const presetsCol = () => collection(db, 'presets');

/* ── profiles ── */

export async function ensureProfile(user: User): Promise<Profile> {
  const ref = doc(db, 'profiles', user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const p = snap.data() as Profile;
    // Fix these in memory and let the migration write below carry them, if it
    // gets that far. A separate earlier write cannot work any more: the rules
    // refuse ANY profile write whose handle is unclaimed, and the claim is the
    // very thing this function is on its way to make. Writing isPublic first
    // was denied, threw, and left the caller with no profile at all — which
    // renders as a signed-out rig for someone who is signed in.
    if (typeof p.isPublic !== 'boolean') p.isPublic = true;

    // Best-effort, and deliberately so. A profile that already exists must be
    // RETURNED whatever happens to its handle: failing here used to reject the
    // whole call, and a null profile is indistinguishable from signed out.
    // Worst case the player keeps their old name for now and is asked again
    // next time.
    try {
      const needsClaim = !!handleProblem(p.username)
        || !(await getDoc(doc(db, 'usernames', p.username.toLowerCase()))).exists();
      if (needsClaim) {
        // A name that cannot be a handle, or that somebody else already holds,
        // moves to the nearest free one instead of locking its owner out.
        const usable = !handleProblem(p.username)
          && await handleAvailable(p.username, user.uid);
        const handle = usable ? p.username
          : await freeHandleNear(p.username || user.displayName || 'player', user.uid);
        await saveProfile(user.uid, { ...p, username: handle });
        p.username = handle;
      }
    } catch (err) {
      console.warn('username migration deferred:', err);
    }
    return p;
  }
  // The username is PUBLIC — it rides every post, comment and search result,
  // and it is about to ride URLs too. Never derive it from the email:
  // 'john.smith@work.com' would publish 'john.smith' to the whole feed for
  // anyone who never edited it. A display name is already public where it
  // came from, so it seeds the handle; failing that, a neutral one.
  const username = await freeHandleNear(user.displayName || 'player', user.uid);
  const fresh: Profile = {
    username, bio: '', avatarUrl: user.photoURL ?? '', isPublic: true,
    followersCount: 0, followingCount: 0,
  };
  // saveProfile claims the handle before writing the profile, so a new player
  // can never exist with a name nobody holds. If it cannot be written at all
  // the player is still signed in and still has a profile in hand — returning
  // null here would show them a signed-out rig, which is a worse lie than a
  // profile that has not persisted yet.
  try {
    await saveProfile(user.uid, fresh);
  } catch (err) {
    console.warn('profile not written yet:', err);
  }
  return fresh;
}

export async function getProfile(uid: string): Promise<Profile | null> {
  const snap = await getDoc(doc(db, 'profiles', uid));
  return snap.exists() ? (snap.data() as Profile) : null;
}

/* ── usernames ────────────────────────────────────────────────────────────
 *
 * A username is a handle, not a display name: it will end up in a URL, an
 * @mention and a search box, so it is unique across the whole app.
 *
 * Firestore has no unique constraint, so uniqueness comes from where document
 * IDs already are unique — a claim collection keyed by the LOWERCASED handle.
 * /usernames/frankawesome can only be created once, and the rules only let
 * you create one that points at yourself. Case is kept on the profile, so
 * "frankAwesome" displays as typed while "FrankAwesome" can never be a second
 * account.
 *
 * A rename is a delete and a create, both inside one transaction with the
 * profile write, so the old handle is never released without the new one
 * being taken — and two people racing for the same free handle cannot both
 * win: the loser's transaction sees the doc and retries into a failure.
 */

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;
/** Letters, digits and underscore. No spaces, no dots, no leading digit-only
 *  handles that could be mistaken for an id. */
const HANDLE_RE = /^[a-z][a-z0-9_]{2,19}$/;
/** Kept back for routes and system voices the app may want later. */
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'support', 'help', 'api', 'remi', 'remidsp',
  'me', 'you', 'user', 'users', 'profile', 'profiles', 'feed', 'rig', 'settings',
  'account', 'login', 'logout', 'signin', 'signup', 'new', 'edit', 'delete',
  'null', 'undefined', 'anonymous', 'system', 'staff', 'moderator', 'mod',
]);

/** Why a handle is not allowed, or null when it is fine. */
export function handleProblem(raw: string): string | null {
  const h = raw.trim();
  if (h.length < HANDLE_MIN) return `at least ${HANDLE_MIN} characters`;
  if (h.length > HANDLE_MAX) return `at most ${HANDLE_MAX} characters`;
  if (/\s/.test(h)) return 'no spaces — letters, numbers and _ only';
  if (!HANDLE_RE.test(h.toLowerCase())) return 'letters, numbers and _ only, starting with a letter';
  if (RESERVED.has(h.toLowerCase())) return 'that one is reserved';
  return null;
}

/** Squeeze any display name into something that could be a handle. */
export function slugifyHandle(raw: string): string {
  const s = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9_]+/g, '').slice(0, HANDLE_MAX);
  return /^[a-z]/.test(s) ? s : `player${s}`.slice(0, HANDLE_MAX);
}

/** Is this handle free — or already yours? */
export async function handleAvailable(handle: string, forUid?: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'usernames', handle.toLowerCase()));
  return !snap.exists() || (!!forUid && snap.data().uid === forUid);
}

export class HandleTakenError extends Error {
  constructor(readonly handle: string) { super(`@${handle} is taken`); }
}

/** Claim `username` for `uid` and write the profile, atomically.
 *  Throws HandleTakenError when somebody else holds it. */
export async function saveProfile(uid: string, p: Profile): Promise<void> {
  const problem = handleProblem(p.username);
  if (problem) throw new Error(`Username needs ${problem}.`);
  const lower = p.username.toLowerCase();

  const profRef = doc(db, 'profiles', uid);
  const prev = (await getDoc(profRef)).data()?.usernameLower as string | undefined;

  // Three steps, in this order, and the order is the whole design.
  //
  // 1. CLAIM, in a transaction of its own. It has to commit before the
  //    profile write, because the profile rule verifies the claim with a
  //    get() — and inside a transaction, rules see the database as it was
  //    BEFORE that transaction's own writes. Claim and profile in one
  //    transaction would therefore be refused by the very rule meant to
  //    protect it. The transaction is still what makes the claim safe: two
  //    players racing for the same free handle both read "free", and the
  //    loser's commit is rejected and retried into the taken branch.
  // Claim unless the claim is ALREADY HELD BY THIS PLAYER.
  //
  // This used to key off "did the handle change?" (`prev !== lower`), which
  // cannot repair the one state that actually needs repairing: a profile whose
  // usernameLower is set but whose claim document is missing. There is at
  // least one such account in production. The handle has not changed, so the
  // claim step is skipped — and then the profile write is refused, because the
  // rule verifies the claim with holdsHandle(). ensureProfile() DETECTS the
  // missing claim and calls this to fix it, and this skipped the fix for the
  // same reason. A dead end that repaired itself into itself: the profile
  // could never be saved again, and /u/<handle> could never resolve.
  //
  // Asking "do I hold it?" instead of "did it change?" makes the next save
  // self-heal. The extra read is one document, on a path that already reads
  // and writes several.
  const alreadyHeld = prev === lower
    && (await getDoc(doc(db, 'usernames', lower))).data()?.uid === uid;
  if (!alreadyHeld) {
    await runTransaction(db, async (tx) => {
      const claimRef = doc(db, 'usernames', lower);
      const claim = await tx.get(claimRef);
      if (claim.exists()) {
        if (claim.data().uid !== uid) throw new HandleTakenError(lower);
        return;                       // already ours; nothing to write
      }
      tx.set(claimRef, { uid, createdAt: serverTimestamp() });
    });
  }

  // 2. PROFILE. The claim is committed, so the rule's get() can see it.
  // createdAt is written ONLY when the document does not already have one.
  // Re-stamping it on every save would reset the player's tenure — the single
  // fact on the profile that is supposed to be immovable.
  const existing = (await getDoc(profRef)).data();
  await setDoc(profRef,
    { username: p.username.trim(), bio: p.bio, avatarUrl: p.avatarUrl,
      link: p.link ?? '',
      isPublic: p.isPublic !== false,
      usernameLower: lower, updatedAt: serverTimestamp(),
      ...(existing?.createdAt ? {} : { createdAt: serverTimestamp() }) },
    { merge: true });

  // 3. RELEASE the old handle, last and best-effort. Failing here leaves a
  //    handle held by someone who no longer uses it, which costs one name.
  //    Doing it first and then failing would leave the player holding none.
  if (prev && prev !== lower) {
    await deleteDoc(doc(db, 'usernames', prev)).catch(() => undefined);
  }
}

/** Find a free handle near `base`, widening with a numeric tail. */
async function freeHandleNear(base: string, uid: string): Promise<string> {
  const stem = slugifyHandle(base) || 'player';
  const first = stem.length >= HANDLE_MIN ? stem : `${stem}${uid.slice(0, 4).toLowerCase()}`;
  if (!handleProblem(first) && await handleAvailable(first, uid)) return first;
  for (let i = 0; i < 12; i++) {
    // A short tail off the uid first (stable across retries for the same
    // player), then random, so two people slugging to the same stem do not
    // walk the same ladder in lockstep.
    const tail = i < 4 ? uid.slice(i * 2, i * 2 + 3).toLowerCase().replace(/[^a-z0-9]/g, '')
                       : Math.floor(Math.random() * 9000 + 1000).toString();
    const cand = `${first.slice(0, HANDLE_MAX - tail.length - 1)}_${tail}`;
    if (!handleProblem(cand) && await handleAvailable(cand, uid)) return cand;
  }
  return `player_${uid.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

/* ── people: search + follows ── */

export async function searchUsers(q: string): Promise<ProfileHit[]> {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  // isPublic is not decoration: the rules gate profile reads on it, and
  // Firestore rejects any query it cannot prove returns only readable docs.
  const qq = query(collection(db, 'profiles'),
    where('isPublic', '==', true),
    where('usernameLower', '>=', needle),
    where('usernameLower', '<=', needle + ''),
    orderBy('usernameLower'), limit(20));
  return (await getDocs(qq)).docs.map((d) => ({ uid: d.id, ...d.data() } as ProfileHit));
}

/** Resolve @handle → uid, for the /u/<handle> route.
 *
 *  This is what the usernames collection was always for — its rules comment
 *  says so — and it is why the claim doc is world-readable. The handle is
 *  lowercased because the claim id is, while the profile keeps the casing the
 *  player typed. */
export async function uidForHandle(handle: string): Promise<string | null> {
  const snap = await getDoc(doc(db, 'usernames', handle.trim().toLowerCase()));
  return snap.exists() ? (snap.data().uid as string) ?? null : null;
}

/** One shared tone by id, for the /t/<id> route.
 *
 *  Returns null for a tone that is private, deleted, or never existed — the
 *  rules refuse the read in the first two cases and the caller has nothing
 *  useful to tell them apart with anyway. */
export async function getSharedPreset(id: string): Promise<CloudPreset | null> {
  try {
    const snap = await getDoc(doc(db, 'presets', id));
    if (!snap.exists()) return null;
    const p = { id: snap.id, ...snap.data() } as CloudPreset;
    return p.shared ? p : null;
  } catch {
    return null;                    // a rules refusal is a "no", not a crash
  }
}

export async function isFollowing(me: string, target: string): Promise<boolean> {
  return (await getDoc(doc(db, 'profiles', me, 'following', target))).exists();
}

/** A player's public (shared) tones, newest first — the public profile. */
export async function publicTones(uid: string): Promise<CloudPreset[]> {
  const q = query(presetsCol(), where('uid', '==', uid), where('shared', '==', true),
    orderBy('createdAt', 'desc'), limit(30));
  return (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() } as CloudPreset));
}

export async function myFollowingIds(uid: string): Promise<string[]> {
  const snap = await getDocs(collection(db, 'profiles', uid, 'following'));
  return snap.docs.map((d) => d.id);
}

export async function setFollowing(me: string, target: string, follow: boolean): Promise<void> {
  if (me === target) throw new Error('that would be you');
  const batch = writeBatch(db);
  const edge = doc(db, 'profiles', me, 'following', target);
  if (follow) batch.set(edge, { createdAt: serverTimestamp() });
  else batch.delete(edge);
  batch.update(doc(db, 'profiles', target), { followersCount: increment(follow ? 1 : -1) });
  batch.update(doc(db, 'profiles', me), { followingCount: increment(follow ? 1 : -1) });
  await batch.commit();
}

/** Shared tones from the people you follow ('in' caps at 30 uids a chunk). */
export async function followingFeed(sort: FeedSort, ids: string[]): Promise<CloudPreset[]> {
  if (!ids.length) return [];
  const order = sort === 'liked' ? 'likesCount' : sort === 'downloads' ? 'downloadsCount' : 'createdAt';
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length && i < 90; i += 30) chunks.push(ids.slice(i, i + 30));
  const all: CloudPreset[] = [];
  for (const chunk of chunks) {
    const q = query(presetsCol(), where('shared', '==', true), where('uid', 'in', chunk),
      orderBy(order, 'desc'), limit(30));
    all.push(...(await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() } as CloudPreset)));
  }
  const key = sort === 'liked' ? 'likesCount' : sort === 'downloads' ? 'downloadsCount' : '';
  all.sort((a, b) => key
    ? (b[key as 'likesCount' | 'downloadsCount'] ?? 0) - (a[key as 'likesCount' | 'downloadsCount'] ?? 0)
    : (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0));
  return all.slice(0, 30);
}

/* ── the preset library ── */

export async function savePreset(
  user: User, profile: Profile,
  data: { name: string; amp: string; voice: string; params: Record<string, number>;
          capture: CaptureRefDoc | null; shared: boolean; description: string },
): Promise<string> {
  const ref = await addDoc(presetsCol(), {
    uid: user.uid,
    username: profile.username,
    avatarUrl: profile.avatarUrl ?? '',
    ...data,
    likesCount: 0, commentsCount: 0, downloadsCount: 0,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function myPresets(uid: string): Promise<CloudPreset[]> {
  const q = query(presetsCol(), where('uid', '==', uid), orderBy('createdAt', 'desc'), limit(60));
  return (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() } as CloudPreset));
}

export async function setShared(id: string, shared: boolean, description?: string): Promise<void> {
  const patch: Record<string, unknown> = { shared, updatedAt: serverTimestamp() };
  if (description !== undefined) patch.description = description;
  await updateDoc(doc(db, 'presets', id), patch);
}

export async function deletePreset(id: string): Promise<void> {
  await deleteDoc(doc(db, 'presets', id));
}

/* ── the feed ── */

export async function feed(sort: FeedSort, amp?: string): Promise<CloudPreset[]> {
  const order = sort === 'liked' ? 'likesCount' : sort === 'downloads' ? 'downloadsCount' : 'createdAt';
  const parts = [where('shared', '==', true)];
  if (amp) parts.push(where('amp', '==', amp));
  const q = query(presetsCol(), ...parts, orderBy(order, 'desc'), limit(30));
  return (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() } as CloudPreset));
}

export async function hasLiked(uid: string, presetId: string): Promise<boolean> {
  return (await getDoc(doc(db, 'presets', presetId, 'likes', uid))).exists();
}

export async function setLiked(uid: string, presetId: string, like: boolean): Promise<void> {
  const batch = writeBatch(db);
  const likeRef = doc(db, 'presets', presetId, 'likes', uid);
  if (like) batch.set(likeRef, { createdAt: serverTimestamp() });
  else batch.delete(likeRef);
  batch.update(doc(db, 'presets', presetId), { likesCount: increment(like ? 1 : -1) });
  await batch.commit();
}

export async function addComment(
  user: User, profile: Profile, presetId: string, text: string, presetName = '',
): Promise<void> {
  const batch = writeBatch(db);
  const cRef = doc(collection(db, 'presets', presetId, 'comments'));
  batch.set(cRef, {
    uid: user.uid, username: profile.username, avatarUrl: profile.avatarUrl ?? '',
    presetName: presetName.slice(0, 60), text, createdAt: serverTimestamp(),
  });
  batch.update(doc(db, 'presets', presetId), { commentsCount: increment(1) });
  await batch.commit();
}

export async function comments(presetId: string): Promise<CommentDoc[]> {
  const q = query(collection(db, 'presets', presetId, 'comments'), orderBy('createdAt', 'asc'), limit(80));
  return (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() } as CommentDoc));
}

/** Everything a player has said, newest first — for the profile page. */
export async function myComments(uid: string): Promise<CommentDoc[]> {
  const q = query(collectionGroup(db, 'comments'),
    where('uid', '==', uid), orderBy('createdAt', 'desc'), limit(50));
  return (await getDocs(q)).docs.map((d) => ({
    id: d.id, presetId: d.ref.parent.parent?.id, ...d.data(),
  } as CommentDoc));
}

/** Anyone loading a shared sound bumps its counter — signed in or not. */
export async function countDownload(presetId: string): Promise<void> {
  await updateDoc(doc(db, 'presets', presetId), { downloadsCount: increment(1) })
    .catch(() => { /* a blocked counter must never block the load */ });
}
