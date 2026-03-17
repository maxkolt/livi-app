import mongoose from 'mongoose';
import User from '../models/User';
import FriendshipMessages, { IFriendshipMessages } from '../models/FriendshipMessages';

const TTL_MS = 30_000; // 30s cache for dev/perf

type CacheEntry<T> = { v: T; exp: number };
const friendsCache = new Map<string, CacheEntry<boolean>>();

/** Кэш документов дружбы (getOrCreateFriendship). Ключ: `${user1}_${user2}` (id отсортированы). */
const friendshipDocCache = new Map<string, IFriendshipMessages>();

const isOid = (s?: string) => !!s && mongoose.Types.ObjectId.isValid(String(s));

function key(a: string, b: string) {
  const [x, y] = [String(a), String(b)].sort();
  return `${x}_${y}`;
}

/**
 * Получить или создать документ дружбы. Общий кэш для routes/messages и sockets/messagesReliable.
 */
export async function getOrCreateFriendship(user1Id: string, user2Id: string): Promise<IFriendshipMessages | null> {
  try {
    const [user1, user2] = [user1Id, user2Id].sort();
    const cacheKey = `${user1}_${user2}`;
    const cached = friendshipDocCache.get(cacheKey);
    if (cached) return cached;

    let friendship = await FriendshipMessages.findOne({
      $or: [
        { user1: user1, user2: user2 },
        { user1: user2, user2: user1 },
      ],
    });

    if (!friendship) {
      friendship = new FriendshipMessages({
        user1: new mongoose.Types.ObjectId(user1),
        user2: new mongoose.Types.ObjectId(user2),
        textMessages: [],
        imageMessages: [],
        audioMessages: [],
        lastActivity: new Date(),
      });
      await friendship.save();
    }

    friendshipDocCache.set(cacheKey, friendship);
    return friendship;
  } catch (err) {
    console.error('[friendshipUtils] getOrCreateFriendship error:', (err as Error)?.message);
    return null;
  }
}

/** Инвалидация кэша дружбы при добавлении/удалении сообщения (по паре пользователей). */
export function invalidateFriendshipCache(user1Id: string, user2Id: string) {
  const cacheKey = key(user1Id, user2Id);
  friendshipDocCache.delete(cacheKey);
}

export function clearFriendshipCache(userId?: string) {
  if (!userId) {
    friendsCache.clear();
    return;
  }
  const uid = String(userId);
  for (const k of friendsCache.keys()) {
    if (k.includes(uid)) friendsCache.delete(k);
  }
}

export async function areFriendsCached(a: string, b: string): Promise<boolean> {
  if (!isOid(a) || !isOid(b) || String(a) === String(b)) return false;
  const k = key(a, b);
  const now = Date.now();
  const hit = friendsCache.get(k);
  if (hit && hit.exp > now) return hit.v;

  const doc = await User.findOne({ _id: a, friends: b }).select('_id').lean();
  const ok = !!doc;
  friendsCache.set(k, { v: ok, exp: now + TTL_MS });
  return ok;
}

export async function getFriendsPaginated(userId: string, page = 1, limit = 50): Promise<{ friends: any[]; total: number; hasMore: boolean }> {
  if (!isOid(userId)) return { friends: [], total: 0, hasMore: false };
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(200, Math.max(1, Number(limit) || 50));

  const me = await User.findById(userId).select('friends').lean();
  const ids: string[] = Array.isArray((me as any)?.friends) ? (me as any).friends.map((x: any) => String(x)) : [];
  const total = ids.length;

  const start = (p - 1) * l;
  const slice = ids.slice(start, start + l);
  if (slice.length === 0) return { friends: [], total, hasMore: start + l < total };

  // Загружаем профили друзей
  const friends = await User.find({ _id: { $in: slice } })
    .select('_id nick avatar avatarVer avatarThumbB64')
    .lean();

  // Стабильный порядок как в slice
  const byId = new Map(friends.map((f: any) => [String(f._id), f]));
  const ordered = slice.map((id) => byId.get(String(id))).filter(Boolean);

  return {
    friends: ordered,
    total,
    hasMore: start + l < total,
  };
}

