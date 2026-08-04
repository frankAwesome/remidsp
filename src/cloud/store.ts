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
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, serverTimestamp, increment, writeBatch,
  type Timestamp,
} from 'firebase/firestore';
import { db, type User } from './fb';

export interface Profile {
  username: string;
  bio: string;
  avatarUrl: string;
  followersCount?: number;
  followingCount?: number;
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
  text: string;
  createdAt?: Timestamp;
}

export type FeedSort = 'latest' | 'liked' | 'downloads';

const presetsCol = () => collection(db, 'presets');

/* ── profiles ── */

export async function ensureProfile(user: User): Promise<Profile> {
  const ref = doc(db, 'profiles', user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return snap.data() as Profile;
  const username = user.displayName || user.email?.split('@')[0] || 'player';
  const fresh: Profile = {
    username, bio: '', avatarUrl: user.photoURL ?? '',
    followersCount: 0, followingCount: 0,
  };
  await setDoc(ref, {
    ...fresh, usernameLower: username.toLowerCase(),
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  return fresh;
}

export async function getProfile(uid: string): Promise<Profile | null> {
  const snap = await getDoc(doc(db, 'profiles', uid));
  return snap.exists() ? (snap.data() as Profile) : null;
}

export async function saveProfile(uid: string, p: Profile): Promise<void> {
  await setDoc(doc(db, 'profiles', uid),
    { username: p.username, bio: p.bio, avatarUrl: p.avatarUrl,
      usernameLower: p.username.toLowerCase(), updatedAt: serverTimestamp() },
    { merge: true });
}

/* ── people: search + follows ── */

export async function searchUsers(q: string): Promise<ProfileHit[]> {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const qq = query(collection(db, 'profiles'),
    where('usernameLower', '>=', needle),
    where('usernameLower', '<=', needle + ''),
    orderBy('usernameLower'), limit(20));
  return (await getDocs(qq)).docs.map((d) => ({ uid: d.id, ...d.data() } as ProfileHit));
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

export async function addComment(user: User, profile: Profile, presetId: string, text: string): Promise<void> {
  const batch = writeBatch(db);
  const cRef = doc(collection(db, 'presets', presetId, 'comments'));
  batch.set(cRef, { uid: user.uid, username: profile.username, text, createdAt: serverTimestamp() });
  batch.update(doc(db, 'presets', presetId), { commentsCount: increment(1) });
  await batch.commit();
}

export async function comments(presetId: string): Promise<CommentDoc[]> {
  const q = query(collection(db, 'presets', presetId, 'comments'), orderBy('createdAt', 'asc'), limit(80));
  return (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() } as CommentDoc));
}

/** Anyone loading a shared sound bumps its counter — signed in or not. */
export async function countDownload(presetId: string): Promise<void> {
  await updateDoc(doc(db, 'presets', presetId), { downloadsCount: increment(1) })
    .catch(() => { /* a blocked counter must never block the load */ });
}
