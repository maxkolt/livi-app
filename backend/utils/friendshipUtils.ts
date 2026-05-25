import mongoose from 'mongoose';
import User from '../models/User';
import FriendshipMessages, { IFriendshipMessages } from '../models/FriendshipMessages';
import FriendshipEdge from '../models/FriendshipEdge';

const TTL_MS = 5 * 60_000; // reduce repeated DB checks on hot realtime paths like typing

type CacheEntry<T> = { v: T; exp: number };
const friendsCache = new Map<string, CacheEntry<boolean>>();
const legacyEdgeMigrationAttempts = new Set<string>();

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

export async function ensureFriendshipEdges(a: string, b: string): Promise<void> {
  if (!isOid(a) || !isOid(b) || String(a) === String(b)) return;
  await Promise.all([
    migrateLegacyFriendEdgesForUser(a),
    migrateLegacyFriendEdgesForUser(b),
  ]);
  const now = new Date();
  await FriendshipEdge.bulkWrite(
    [
      {
        updateOne: {
          filter: { userId: new mongoose.Types.ObjectId(a), friendId: new mongoose.Types.ObjectId(b) },
          update: { $setOnInsert: { userId: new mongoose.Types.ObjectId(a), friendId: new mongoose.Types.ObjectId(b), createdAt: now } },
          upsert: true,
        },
      },
      {
        updateOne: {
          filter: { userId: new mongoose.Types.ObjectId(b), friendId: new mongoose.Types.ObjectId(a) },
          update: { $setOnInsert: { userId: new mongoose.Types.ObjectId(b), friendId: new mongoose.Types.ObjectId(a), createdAt: now } },
          upsert: true,
        },
      },
    ],
    { ordered: false }
  );
  clearFriendshipCache(a);
  clearFriendshipCache(b);
}

export async function removeFriendshipEdges(a: string, b: string): Promise<void> {
  if (!isOid(a) || !isOid(b)) return;
  await FriendshipEdge.deleteMany({
    $or: [
      { userId: new mongoose.Types.ObjectId(a), friendId: new mongoose.Types.ObjectId(b) },
      { userId: new mongoose.Types.ObjectId(b), friendId: new mongoose.Types.ObjectId(a) },
    ],
  }).exec();
  clearFriendshipCache(a);
  clearFriendshipCache(b);
}

async function getLegacyFriendIds(userId: string): Promise<string[]> {
  const me = await User.findById(userId).select('friends').lean();
  return Array.isArray((me as any)?.friends) ? (me as any).friends.map((x: any) => String(x)) : [];
}

async function getReverseLegacyFriendIds(userId: string): Promise<string[]> {
  if (!isOid(userId)) return [];
  const userOid = new mongoose.Types.ObjectId(userId);
  const docs = await User.find({ _id: { $ne: userOid }, friends: userOid }).select('_id').lean();
  return (docs as any[]).map((doc) => String(doc._id)).filter((id) => isOid(id) && id !== userId);
}

function addUniqueFriend(list: string[], seen: Set<string>, userId: string, friendId: string) {
  if (!isOid(friendId) || friendId === userId || seen.has(friendId)) return;
  seen.add(friendId);
  list.push(friendId);
}

async function upsertBidirectionalFriendshipEdges(userId: string, friendIds: string[]): Promise<void> {
  if (!isOid(userId)) return;
  const ids = Array.from(new Set(friendIds.filter((friendId) => isOid(friendId) && friendId !== userId)));
  if (ids.length === 0) return;

  const userOid = new mongoose.Types.ObjectId(userId);
  const now = new Date();
  const ops = ids.flatMap((friendId) => {
    const friendOid = new mongoose.Types.ObjectId(friendId);
    return [
      {
        updateOne: {
          filter: { userId: userOid, friendId: friendOid },
          update: { $setOnInsert: { userId: userOid, friendId: friendOid, createdAt: now } },
          upsert: true,
        },
      },
      {
        updateOne: {
          filter: { userId: friendOid, friendId: userOid },
          update: { $setOnInsert: { userId: friendOid, friendId: userOid, createdAt: now } },
          upsert: true,
        },
      },
    ];
  });

  try {
    for (let i = 0; i < ops.length; i += 500) {
      await FriendshipEdge.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    }
  } catch (error: any) {
    const writeErrors = Array.isArray(error?.writeErrors) ? error.writeErrors : [];
    const onlyDuplicateKeys = error?.code === 11000 || (writeErrors.length > 0 && writeErrors.every((err: any) => err?.code === 11000));
    if (!onlyDuplicateKeys) throw error;
  }

  clearFriendshipCache(userId);
  for (const friendId of ids) clearFriendshipCache(friendId);
}

async function migrateLegacyFriendEdgesForUser(userId: string): Promise<void> {
  if (!isOid(userId)) return;
  if (legacyEdgeMigrationAttempts.has(userId)) return;

  const legacyIds = Array.from(new Set(
    (await getLegacyFriendIds(userId)).filter((friendId) => isOid(friendId) && friendId !== userId)
  ));
  if (legacyIds.length === 0) {
    legacyEdgeMigrationAttempts.add(userId);
    return;
  }

  const userOid = new mongoose.Types.ObjectId(userId);
  const now = new Date();
  const ops = legacyIds.map((friendId) => ({
    updateOne: {
      filter: { userId: userOid, friendId: new mongoose.Types.ObjectId(friendId) },
      update: { $setOnInsert: { userId: userOid, friendId: new mongoose.Types.ObjectId(friendId), createdAt: now } },
      upsert: true,
    },
  }));

  try {
    for (let i = 0; i < ops.length; i += 500) {
      await FriendshipEdge.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    }
  } catch (error: any) {
    const writeErrors = Array.isArray(error?.writeErrors) ? error.writeErrors : [];
    const onlyDuplicateKeys = error?.code === 11000 || (writeErrors.length > 0 && writeErrors.every((err: any) => err?.code === 11000));
    if (!onlyDuplicateKeys) throw error;
  }
  legacyEdgeMigrationAttempts.add(userId);
}

export async function getFriendIds(userId: string): Promise<string[]> {
  if (!isOid(userId)) return [];
  await migrateLegacyFriendEdgesForUser(userId);
  const userOid = new mongoose.Types.ObjectId(userId);
  const [edges, ownLegacyIds, reverseLegacyIds] = await Promise.all([
    FriendshipEdge.find({
      $or: [
        { userId: userOid },
        { friendId: userOid },
      ],
    })
    .sort({ createdAt: 1, _id: 1 })
    .select('userId friendId')
    .lean(),
    getLegacyFriendIds(userId),
    getReverseLegacyFriendIds(userId),
  ]);

  const friendIds: string[] = [];
  const seen = new Set<string>();
  const outgoing = new Set<string>();
  const incoming = new Set<string>();
  for (const edge of edges as any[]) {
    const edgeUserId = String(edge.userId);
    const edgeFriendId = String(edge.friendId);
    if (edgeUserId === userId) {
      outgoing.add(edgeFriendId);
      addUniqueFriend(friendIds, seen, userId, edgeFriendId);
    }
    if (edgeFriendId === userId) {
      incoming.add(edgeUserId);
      addUniqueFriend(friendIds, seen, userId, edgeUserId);
    }
  }
  for (const friendId of ownLegacyIds) {
    addUniqueFriend(friendIds, seen, userId, friendId);
  }
  for (const friendId of reverseLegacyIds) {
    addUniqueFriend(friendIds, seen, userId, friendId);
  }

  const repairIds = friendIds.filter((friendId) =>
    ownLegacyIds.includes(friendId) || reverseLegacyIds.includes(friendId) || !outgoing.has(friendId) || !incoming.has(friendId)
  );
  if (repairIds.length > 0) await upsertBidirectionalFriendshipEdges(userId, repairIds);

  return friendIds;
}

export async function getFriendIdsForUsers(userIds: string[]): Promise<Map<string, string[]>> {
  const uniqueIds = [...new Set(userIds.map((id) => String(id || '').trim()).filter(isOid))];
  const byUser = new Map<string, string[]>();
  if (uniqueIds.length === 0) return byUser;

  await Promise.all(uniqueIds.map((id) => migrateLegacyFriendEdgesForUser(id)));

  const oidByString = new Map(uniqueIds.map((id) => [id, new mongoose.Types.ObjectId(id)]));
  const uniqueIdSet = new Set(uniqueIds);
  const [edges, reverseLegacyDocs] = await Promise.all([
    FriendshipEdge.find({
      $or: [
        { userId: { $in: [...oidByString.values()] } },
        { friendId: { $in: [...oidByString.values()] } },
      ],
    })
    .sort({ createdAt: 1, _id: 1 })
    .select('userId friendId')
    .lean(),
    User.find({
      $or: [
        { _id: { $in: [...oidByString.values()] } },
        { friends: { $in: [...oidByString.values()] } },
      ],
    }).select('_id friends').lean(),
  ]);

  const seenByUser = new Map<string, Set<string>>();
  const addForUser = (uid: string, friendId: string) => {
    if (!uniqueIdSet.has(uid)) return;
    const list = byUser.get(uid) || [];
    const seen = seenByUser.get(uid) || new Set<string>();
    addUniqueFriend(list, seen, uid, friendId);
    byUser.set(uid, list);
    seenByUser.set(uid, seen);
  };

  for (const edge of edges as any[]) {
    const uid = String(edge.userId);
    const fid = String(edge.friendId);
    addForUser(uid, fid);
    addForUser(fid, uid);
  }

  for (const doc of reverseLegacyDocs as any[]) {
    const ownerId = String(doc._id);
    const legacyFriends = Array.isArray(doc.friends) ? doc.friends.map((id: any) => String(id)) : [];
    for (const legacyFriendId of legacyFriends) {
      addForUser(ownerId, legacyFriendId);
      addForUser(legacyFriendId, ownerId);
    }
  }
  for (const id of uniqueIds) {
    if (!byUser.has(id)) byUser.set(id, []);
  }

  await Promise.all(uniqueIds.map((id) => upsertBidirectionalFriendshipEdges(id, byUser.get(id) || [])));

  return byUser;
}

export async function areFriendsCached(a: string, b: string): Promise<boolean> {
  if (!isOid(a) || !isOid(b) || String(a) === String(b)) return false;
  const k = key(a, b);
  const now = Date.now();
  const hit = friendsCache.get(k);
  if (hit && hit.exp > now) return hit.v;

  await Promise.all([
    migrateLegacyFriendEdgesForUser(a),
    migrateLegacyFriendEdgesForUser(b),
  ]);

  const aOid = new mongoose.Types.ObjectId(a);
  const bOid = new mongoose.Types.ObjectId(b);
  const edges = await FriendshipEdge.find({
    $or: [
      { userId: aOid, friendId: bOid },
      { userId: bOid, friendId: aOid },
    ],
  }).select('userId friendId').lean();
  let ok = edges.length > 0;
  if (!ok) {
    const doc = await User.findOne({
      $or: [
        { _id: aOid, friends: bOid },
        { _id: bOid, friends: aOid },
      ],
    }).select('_id').lean();
    ok = !!doc;
  }

  if (ok) {
    const hasForward = (edges as any[]).some((edge) => String(edge.userId) === a && String(edge.friendId) === b);
    const hasReverse = (edges as any[]).some((edge) => String(edge.userId) === b && String(edge.friendId) === a);
    if (!hasForward || !hasReverse) await upsertBidirectionalFriendshipEdges(a, [b]);
  }

  friendsCache.set(k, { v: ok, exp: now + TTL_MS });
  return ok;
}

export async function getFriendsPaginated(userId: string, page = 1, limit = 50): Promise<{ friends: any[]; total: number; hasMore: boolean }> {
  if (!isOid(userId)) return { friends: [], total: 0, hasMore: false };
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(200, Math.max(1, Number(limit) || 50));

  const start = (p - 1) * l;
  const allFriendIds = await getFriendIds(userId);
  const total = allFriendIds.length;
  const slice = allFriendIds.slice(start, start + l);

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

