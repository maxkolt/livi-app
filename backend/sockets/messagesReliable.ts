// Надежная система сообщений с персистентным хранением офлайн сообщений
import { Server, Socket } from 'socket.io';
import mongoose from 'mongoose';
import User from '../models/User';
import FriendshipMessages, { IFriendshipMessages } from '../models/FriendshipMessages';
import FriendshipMessageItem from '../models/FriendshipMessageItem';
import OfflineMessage from '../models/OfflineMessage';
import { areFriendsCached, getOrCreateFriendship, invalidateFriendshipCache } from '../utils/friendshipUtils';
import { sendMessagePushToUser } from '../utils/push';
import { emitToUser } from '../utils/emitToUser';

const isOid = (s?: string) => !!s && mongoose.Types.ObjectId.isValid(String(s));
const CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9:_-]{1,120}$/;
const OID_HEX_24 = /^[a-f\d]{24}$/i;

/** Socket rooms use lowercase Mongo ids (see identity.ts bindUser). */
export function socketUserRoomId(userId: string): string {
  const raw = String(userId || '').trim();
  return OID_HEX_24.test(raw) ? raw.toLowerCase() : raw;
}

export function emitMessageDeletedToParticipants(
  io: Server,
  fromUserId: string | undefined,
  toUserId: string | undefined,
  payload: { messageId: string; deletedBy: string },
): void {
  const users = new Set<string>();
  if (fromUserId) users.add(String(fromUserId));
  if (toUserId) users.add(String(toUserId));
  for (const uid of users) {
    emitToUser(io, uid, 'message:deleted', payload);
  }
}

export function emitMessagesDeletedToParticipants(
  io: Server,
  recipientUserIds: Iterable<string>,
  payload: { messageIds: string[]; deletedBy: string },
): void {
  const users = new Set<string>();
  for (const userId of recipientUserIds) {
    const uid = String(userId || '').trim();
    if (uid) users.add(uid);
  }
  for (const uid of users) {
    emitToUser(io, uid, 'messages:deleted', payload);
  }
}
export const MAX_MESSAGE_BATCH_SIZE = 100;
export const READ_RECEIPT_CHUNK_SIZE = 500;

function normalizeClientMessageId(payload: any): string {
  const raw = String(payload?.clientMessageId || payload?.clientId || '').trim();
  return CLIENT_MESSAGE_ID_RE.test(raw) ? raw : '';
}

export function normalizeMessageIdBatch(input: unknown): string[] {
  return Array.from(new Set(
    (Array.isArray(input) ? input : [])
      .map((id: any) => String(id || '').trim())
      .filter((id: string) => {
        if (!id || id.length > 120) return false;
        if (CLIENT_MESSAGE_ID_RE.test(id)) return true;
        // Legacy numeric / mixed ids from older clients (e.g. Date.now() message ids).
        return /^[\d_a-zA-Z:-]{1,120}$/.test(id);
      })
  ));
}

function formatExistingMessageAck(doc: any, delivered: boolean) {
  return {
    ok: true,
    duplicate: true,
    messageId: String(doc?.id || ''),
    timestamp: doc?.timestamp || new Date(),
    delivered,
  };
}

function isDuplicateKeyError(error: any): boolean {
  return error?.code === 11000 || String(error?.message || '').includes('E11000');
}

function toFriendshipMessageSnapshot(message: any): any {
  const snapshot: any = {
    id: String(message.id),
    from: message.from,
    to: message.to,
    type: message.type,
    text: message.text,
    uri: message.uri,
    name: message.name,
    size: message.size,
    duration: message.duration,
    stickerId: message.stickerId,
    stickerPackId: message.stickerPackId,
    stickerEmoji: message.stickerEmoji,
    stickerLabel: message.stickerLabel,
    timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp || Date.now()),
    read: !!message.read,
  };
  if (Array.isArray(message.uris) && message.uris.length > 0) {
    snapshot.uris = message.uris.map((u: any) => String(u || '').trim()).filter(Boolean).slice(0, 10);
    if (!snapshot.uri && snapshot.uris[0]) snapshot.uri = snapshot.uris[0];
  }
  if (Array.isArray(message.reactions)) snapshot.reactions = message.reactions;
  if (message.replyTo && message.replyTo.id) snapshot.replyTo = message.replyTo;
  return snapshot;
}

const MAX_IMAGE_ALBUM = 10;

/** Normalize image album URIs from client payload (uris[] and/or uri). */
export function normalizeIncomingImageUris(payload: { uri?: unknown; uris?: unknown }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    const s = String(raw || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(payload?.uris)) {
    for (const u of payload.uris) {
      push(u);
      if (out.length >= MAX_IMAGE_ALBUM) break;
    }
  }
  if (out.length === 0) push(payload?.uri);
  return out;
}

const LEGACY_MESSAGE_ARRAYS: Array<{ field: string; type: 'text' | 'image' | 'audio' | 'sticker' }> = [
  { field: 'textMessages', type: 'text' },
  { field: 'imageMessages', type: 'image' },
  { field: 'audioMessages', type: 'audio' },
  { field: 'stickerMessages', type: 'sticker' },
];
const legacyBackfillAttempts = new Set<string>();

export async function removeLegacyFriendshipMessages(
  friendshipId: mongoose.Types.ObjectId | null,
  messageIds: string[]
): Promise<void> {
  if (!friendshipId) return;
  const ids = Array.from(new Set(messageIds.map((id) => String(id || '').trim()).filter(Boolean)));
  if (ids.length === 0) return;

  const pull: Record<string, any> = {};
  for (const { field } of LEGACY_MESSAGE_ARRAYS) {
    pull[field] = { id: { $in: ids } };
  }

  await mongoose.connection.collection('friendshipmessages').updateOne(
    { _id: friendshipId },
    { $pull: pull }
  );
}

export async function clearLegacyFriendshipMessages(friendshipId: mongoose.Types.ObjectId | null): Promise<void> {
  if (!friendshipId) return;

  const set: Record<string, any[]> = {};
  for (const { field } of LEGACY_MESSAGE_ARRAYS) {
    set[field] = [];
  }

  await mongoose.connection.collection('friendshipmessages').updateOne(
    { _id: friendshipId },
    { $set: set }
  );
}

function asObjectId(value: any): mongoose.Types.ObjectId | null {
  const raw = String(value || '').trim();
  return mongoose.Types.ObjectId.isValid(raw) ? new mongoose.Types.ObjectId(raw) : null;
}

function asValidDate(value: any): Date {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function legacyMessageToItem(friendshipId: mongoose.Types.ObjectId, message: any, fallbackType: string) {
  if (!message || !message.id) return null;
  const from = asObjectId(message.from);
  const to = asObjectId(message.to);
  if (!from || !to) return null;
  const type = ['text', 'image', 'audio', 'sticker'].includes(String(message.type))
    ? String(message.type)
    : fallbackType;

  return {
    friendshipId,
    id: String(message.id),
    from,
    to,
    type,
    text: message.text,
    uri: message.uri,
    uris: Array.isArray(message.uris)
      ? message.uris.map((u: any) => String(u || '').trim()).filter(Boolean).slice(0, 10)
      : undefined,
    name: message.name,
    size: message.size,
    duration: message.duration,
    stickerId: message.stickerId,
    stickerPackId: message.stickerPackId,
    stickerEmoji: message.stickerEmoji,
    stickerLabel: message.stickerLabel,
    timestamp: asValidDate(message.timestamp),
    read: !!message.read,
    reactions: Array.isArray(message.reactions) ? message.reactions : undefined,
    replyTo: message.replyTo && message.replyTo.id ? message.replyTo : undefined,
  };
}

export async function backfillFriendshipMessageItems(friendshipId: mongoose.Types.ObjectId | null): Promise<number> {
  if (!friendshipId) return 0;
  const friendshipKey = String(friendshipId);
  if (legacyBackfillAttempts.has(friendshipKey)) return 0;

  const legacyDoc = await mongoose.connection.collection('friendshipmessages').findOne(
    { _id: friendshipId },
    { projection: { textMessages: 1, imageMessages: 1, audioMessages: 1, stickerMessages: 1 } }
  );
  if (!legacyDoc) {
    legacyBackfillAttempts.add(friendshipKey);
    return 0;
  }

  const items: any[] = [];
  for (const { field, type } of LEGACY_MESSAGE_ARRAYS) {
    const legacyMessages = Array.isArray((legacyDoc as any)[field]) ? (legacyDoc as any)[field] : [];
    for (const message of legacyMessages) {
      const item = legacyMessageToItem(friendshipId, message, type);
      if (item) items.push(item);
    }
  }
  if (items.length === 0) {
    legacyBackfillAttempts.add(friendshipKey);
    return 0;
  }

  const ids = Array.from(new Set(items.map((item) => item.id)));
  const existing = await FriendshipMessageItem.find({ friendshipId, id: { $in: ids } }).select('id').lean();
  const existingIds = new Set((existing as any[]).map((item) => String(item.id)));
  const toInsert = items.filter((item) => !existingIds.has(item.id));
  if (toInsert.length === 0) {
    legacyBackfillAttempts.add(friendshipKey);
    return 0;
  }

  try {
    await FriendshipMessageItem.insertMany(toInsert, { ordered: false });
    legacyBackfillAttempts.add(friendshipKey);
    return toInsert.length;
  } catch (error: any) {
    if (error?.code === 11000 || error?.writeErrors) {
      legacyBackfillAttempts.add(friendshipKey);
      return error?.insertedDocs?.length || 0;
    }
    throw error;
  }
}

export async function findLegacyMessageFriendshipId(messageId: string): Promise<mongoose.Types.ObjectId | null> {
  const trimmed = String(messageId || '').trim();
  if (!trimmed) return null;

  const or = LEGACY_MESSAGE_ARRAYS.map(({ field }) => ({ [`${field}.id`]: trimmed }));
  const legacyDoc = await mongoose.connection.collection('friendshipmessages').findOne(
    { $or: or },
    { projection: { _id: 1 } }
  );
  return legacyDoc?._id ? asObjectId(legacyDoc._id) : null;
}

async function readLegacyFriendshipMessageItems(friendshipId: mongoose.Types.ObjectId): Promise<any[]> {
  try {
    const legacyDoc = await mongoose.connection.collection('friendshipmessages').findOne(
      { _id: friendshipId },
      { projection: { textMessages: 1, imageMessages: 1, audioMessages: 1, stickerMessages: 1 } }
    );
    if (!legacyDoc) return [];

    const items: any[] = [];
    for (const { field, type } of LEGACY_MESSAGE_ARRAYS) {
      const legacyMessages = Array.isArray((legacyDoc as any)[field]) ? (legacyDoc as any)[field] : [];
      for (const message of legacyMessages) {
        const item = legacyMessageToItem(friendshipId, message, type);
        if (item) items.push(item);
      }
    }
    return items;
  } catch (error) {
    console.warn('[messages] legacy read fallback failed:', error);
    return [];
  }
}

export async function findLegacyMessageForUser(
  messageId: string,
  meOid: mongoose.Types.ObjectId
): Promise<{ id: string; from: mongoose.Types.ObjectId; to: mongoose.Types.ObjectId; type?: string; friendshipId: mongoose.Types.ObjectId } | null> {
  const legacyFriendshipId = await findLegacyMessageFriendshipId(messageId);
  if (!legacyFriendshipId) return null;

  const legacyItems = await readLegacyFriendshipMessageItems(legacyFriendshipId);
  const me = String(meOid);
  const legacyMessage = legacyItems.find((item) =>
    String(item?.id || '') === messageId && (String(item?.from) === me || String(item?.to) === me)
  );
  if (!legacyMessage) return null;

  return {
    id: messageId,
    from: legacyMessage.from,
    to: legacyMessage.to,
    type: legacyMessage.type,
    friendshipId: legacyFriendshipId,
  };
}

function formatMessageForClient(msg: any) {
  const uris = Array.isArray(msg.uris)
    ? msg.uris.map((u: any) => String(u || '').trim()).filter(Boolean).slice(0, 10)
    : undefined;
  return {
    id: String(msg.id),
    from: msg.from?.toString?.() || String(msg.from),
    to: msg.to?.toString?.() || String(msg.to),
    type: msg.type,
    text: msg.text,
    uri: msg.uri || (uris && uris[0]) || undefined,
    ...(uris && uris.length > 1 ? { uris } : {}),
    name: msg.name,
    size: msg.size,
    duration: msg.duration,
    stickerId: msg.stickerId,
    stickerPackId: msg.stickerPackId,
    stickerEmoji: msg.stickerEmoji,
    stickerLabel: msg.stickerLabel,
    timestamp: msg.timestamp?.toISOString?.() || String(msg.timestamp),
    read: !!msg.read,
    reactions: Array.isArray(msg.reactions) ? msg.reactions.map((r: any) => ({ emoji: r.emoji, userId: String(r.userId) })) : [],
    ...(msg.replyTo && msg.replyTo.id ? { replyTo: { id: String(msg.replyTo.id), text: msg.replyTo.text, from: String(msg.replyTo.from || '') } } : {}),
  };
}

export async function fetchFriendshipMessagesPage(
  friendshipId: mongoose.Types.ObjectId,
  limit: number,
  before?: string
): Promise<{ messages: any[]; hasMore: boolean }> {
  try {
    await backfillFriendshipMessageItems(friendshipId);
  } catch (error) {
    console.warn('[messages] legacy backfill failed; serving read fallback:', error);
  }

  const legacyItems = await readLegacyFriendshipMessageItems(friendshipId);
  let beforeTimestamp: Date | null = null;
  const beforeId = String(before || '').trim();
  if (beforeId) {
    const beforeDoc = await FriendshipMessageItem.findOne(
      { friendshipId, id: beforeId },
      { timestamp: 1 }
    ).lean();
    if (beforeDoc && (beforeDoc as any).timestamp) {
      beforeTimestamp = asValidDate((beforeDoc as any).timestamp);
    } else {
      const legacyBefore = legacyItems.find((item) => String(item.id) === beforeId);
      if (legacyBefore) beforeTimestamp = asValidDate(legacyBefore.timestamp);
    }
  }

  const query: any = { friendshipId };
  if (beforeTimestamp) query.timestamp = { $lt: beforeTimestamp };
  const itemDocs = await FriendshipMessageItem.find(query)
    .sort({ timestamp: -1 })
    .limit(limit + 1)
    .lean();

  const byId = new Map<string, any>();
  const isBeforeCursor = (msg: any) => !beforeTimestamp || asValidDate(msg.timestamp).getTime() < beforeTimestamp.getTime();
  for (const msg of legacyItems) {
    const id = String(msg?.id || '');
    if (id && isBeforeCursor(msg)) byId.set(id, msg);
  }
  for (const msg of itemDocs as any[]) {
    const id = String(msg?.id || '');
    if (id && isBeforeCursor(msg)) byId.set(id, msg);
  }

  const raw = [...byId.values()].sort((a, b) => asValidDate(b.timestamp).getTime() - asValidDate(a.timestamp).getTime());
  const hasMore = raw.length > limit;
  const slice = hasMore ? raw.slice(0, limit) : raw;
  return { messages: slice.reverse().map(formatMessageForClient), hasMore };
}

async function refreshFriendshipLastMessage(friendshipId: mongoose.Types.ObjectId | null) {
  if (!friendshipId) return;
  const latestItem = await FriendshipMessageItem.findOne({ friendshipId })
    .sort({ timestamp: -1 })
    .lean();
  if (latestItem) {
    const snapshot = toFriendshipMessageSnapshot(latestItem);
    await FriendshipMessages.updateOne(
      { _id: friendshipId },
      { $set: { lastMessage: snapshot, lastActivity: snapshot.timestamp } }
    ).exec();
    return;
  }

  await FriendshipMessages.updateOne(
    { _id: friendshipId },
    { $unset: { lastMessage: '' }, $set: { lastActivity: new Date() } }
  ).exec();
}

async function deleteMessageForBothUsers(me: string, messageId: string): Promise<{
  ok: boolean;
  fromUserId?: string;
  toUserId?: string;
  error?: string;
}> {
  let fromUserId = '';
  let toUserId = '';
  let friendshipId: mongoose.Types.ObjectId | null = null;

  const meOid = new mongoose.Types.ObjectId(me);
  let doc = await FriendshipMessageItem.findOne({
    id: messageId,
    $or: [{ from: meOid }, { to: meOid }],
  }).select('from to friendshipId type').lean();
  if (!doc) {
    const legacyFriendshipId = await findLegacyMessageFriendshipId(messageId);
    if (legacyFriendshipId) {
      await backfillFriendshipMessageItems(legacyFriendshipId);
      doc = await FriendshipMessageItem.findOne({
        id: messageId,
        $or: [{ from: meOid }, { to: meOid }],
      }).select('from to friendshipId type').lean();
    }
  }
  if (!doc) {
    doc = await findLegacyMessageForUser(messageId, meOid) as any;
  }
  if (doc) {
    fromUserId = String((doc as any).from);
    toUserId = String((doc as any).to);
    friendshipId = (doc as any).friendshipId;
    await Promise.all([
      FriendshipMessageItem.deleteOne({ friendshipId, id: messageId }).exec(),
      removeLegacyFriendshipMessages(friendshipId, [messageId]),
    ]);
    await refreshFriendshipLastMessage(friendshipId);
  } else {
    return { ok: false, error: 'not_found' };
  }

  try {
    if (toUserId && fromUserId) {
      removeUnreadMessage(toUserId, fromUserId, messageId);
      await OfflineMessage.deleteMany({
        recipientId: new mongoose.Types.ObjectId(toUserId),
        senderId: new mongoose.Types.ObjectId(fromUserId),
        messageId,
      });
      invalidateFriendshipCache(fromUserId, toUserId);
    }
  } catch (cleanupError) {
    console.warn('[message:delete] unread cleanup failed:', cleanupError);
  }

  return { ok: true, fromUserId, toUserId };
}

// Простое хранение непрочитанных сообщений в памяти (для быстрого доступа)
const unreadMessages = new Map<string, Array<{ id: string; from: string; timestamp: string }>>();

/** Присутствие "смотрит чат": userId -> { with: peerId, at: timestamp }. TTL 90s — не слать пуш о сообщении, если получатель в этом чате (как в Telegram). */
const viewingChat = new Map<string, { with: string; at: number }>();
const VIEWING_CHAT_TTL_MS = 90_000;

function isViewingChatWith(recipientUserId: string, senderUserId: string): boolean {
  const entry = viewingChat.get(recipientUserId);
  if (!entry) return false;
  if (Date.now() - entry.at > VIEWING_CHAT_TTL_MS) {
    viewingChat.delete(recipientUserId);
    return false;
  }
  return entry.with === senderUserId;
}

function setViewingChat(userId: string, withPeerId: string | null) {
  if (!userId) return;
  if (withPeerId) {
    viewingChat.set(userId, { with: withPeerId, at: Date.now() });
  } else {
    viewingChat.delete(userId);
  }
}

/**
 * Добавить сообщение в дружбу (и в отдельную коллекцию FriendshipMessageItem для быстрого GET)
 */
async function addMessageToFriendship(friendship: IFriendshipMessages, message: any): Promise<{
  ok: boolean;
  duplicate?: boolean;
  conflict?: boolean;
  timestamp?: Date;
}> {
  try {
    const friendshipId = (friendship as any)._id;
    const messageItem: any = {
      id: message.id,
      from: new mongoose.Types.ObjectId(message.from),
      to: new mongoose.Types.ObjectId(message.to),
      type: message.type,
      text: message.text,
      uri: message.uri,
      name: message.name,
      size: message.size,
      duration: message.duration,
      stickerId: message.stickerId,
      stickerPackId: message.stickerPackId,
      stickerEmoji: message.stickerEmoji,
      stickerLabel: message.stickerLabel,
      timestamp: message.timestamp,
      read: message.read
    };
    if (Array.isArray(message.uris) && message.uris.length > 0) {
      messageItem.uris = message.uris.map((u: any) => String(u || '').trim()).filter(Boolean).slice(0, 10);
      if (!messageItem.uri) messageItem.uri = messageItem.uris[0];
    }
    if (message.replyTo && typeof message.replyTo === 'object' && message.replyTo.id) {
      messageItem.replyTo = {
        id: String(message.replyTo.id),
        text: message.replyTo.text != null ? String(message.replyTo.text) : undefined,
        from: String(message.replyTo.from || ''),
      };
    }

    const createPayload: any = {
      friendshipId,
      id: message.id,
      from: messageItem.from,
      to: messageItem.to,
      type: message.type,
      text: message.text,
      uri: messageItem.uri,
      name: message.name,
      size: message.size,
      duration: message.duration,
      stickerId: message.stickerId,
      stickerPackId: message.stickerPackId,
      stickerEmoji: message.stickerEmoji,
      stickerLabel: message.stickerLabel,
      timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
      read: !!message.read,
    };
    if (Array.isArray(messageItem.uris) && messageItem.uris.length > 0) {
      createPayload.uris = messageItem.uris;
    }
    if (messageItem.replyTo) createPayload.replyTo = messageItem.replyTo;
    await FriendshipMessageItem.create(createPayload);
    await (friendship as any).addMessage(messageItem);
    return { ok: true };
  } catch (error: any) {
    if (isDuplicateKeyError(error)) {
      const friendshipId = (friendship as any)._id;
      const existing = await FriendshipMessageItem.findOne({
        friendshipId,
        id: String(message.id || ''),
        from: new mongoose.Types.ObjectId(message.from),
        to: new mongoose.Types.ObjectId(message.to),
      }).select('id timestamp').lean();
      if (existing) {
        return { ok: true, duplicate: true, timestamp: (existing as any).timestamp || new Date() };
      }
      return { ok: false, conflict: true };
    }
    console.error('Error adding message to friendship:', error);
    return { ok: false };
  }
}

/**
 * Сохранить офлайн сообщение в базу данных
 */
async function saveOfflineMessage(recipientId: string, message: any): Promise<boolean> {
  try {
    const offlineMessage = new OfflineMessage({
      recipientId: new mongoose.Types.ObjectId(recipientId),
      senderId: new mongoose.Types.ObjectId(message.from),
      messageId: message.id,
      messageData: message
    });

    await offlineMessage.save();
    return true;
  } catch (error) {
    console.error('Error saving offline message:', error);
    return false;
  }
}

/**
 * Получить и удалить офлайн сообщения для пользователя
 */
export async function getAndClearOfflineMessages(userId: string): Promise<any[]> {
  try {
    const recipientId = new mongoose.Types.ObjectId(userId);
    const drainStartedAt = new Date();
    const messages: any[] = [];

    while (true) {
      const offlineMessage = await OfflineMessage.findOneAndDelete({
        recipientId,
        createdAt: { $lte: drainStartedAt },
      })
        .sort({ createdAt: 1, _id: 1 })
        .lean();

      if (!offlineMessage) break;
      messages.push((offlineMessage as any).messageData);
    }

    return messages;
  } catch (error) {
    console.error('Error getting offline messages:', error);
    return [];
  }
}

/**
 * Получить и очистить очередь офлайн уведомлений об очистке чата
 */
export function getAndClearOfflineChatClearedQueue(userId: string): Array<any> {
  // Пока возвращаем пустой массив, так как эта функциональность не реализована
  return [];
}

/**
 * Проверить, находится ли пользователь онлайн
 */
async function isUserOnline(io: Server, userId: string): Promise<boolean> {
  try {
    const sockets = await io.in(`u:${String(userId)}`).fetchSockets();
    return sockets.length > 0;
  } catch (error) {
    console.warn('[messages] user room presence check failed:', error);
    return false;
  }
}

/**
 * Отправить сообщение пользователю если он онлайн
 */
async function sendMessageToUser(io: Server, userId: string, message: any): Promise<boolean> {
  try {
    const online = await isUserOnline(io, userId);
    if (online) io.to(`u:${String(userId)}`).emit('message:received', message);
    return online;
  } catch (error) {
    console.error('Error sending message to user:', error);
    return false;
  }
}

/**
 * Добавить непрочитанное сообщение
 */
function addUnreadMessage(userId: string, messageId: string, fromUser: string) {
  if (!unreadMessages.has(userId)) {
    unreadMessages.set(userId, []);
  }
  unreadMessages.get(userId)!.push({
    id: messageId,
    from: fromUser,
    timestamp: new Date().toISOString()
  });
}

/**
 * Отметить сообщения как прочитанные
 */
function markMessagesAsRead(userId: string, fromUser: string) {
  const userUnreads = unreadMessages.get(userId) || [];
  const filtered = userUnreads.filter(msg => msg.from !== fromUser);
  unreadMessages.set(userId, filtered);
}

/**
 * Получить количество непрочитанных сообщений
 */
function getUnreadCount(userId: string, fromUser: string): number {
  const userUnreads = unreadMessages.get(userId) || [];
  return userUnreads.filter(msg => msg.from === fromUser).length;
}

/**
 * Отметить одно сообщение как прочитанное (из in-memory очереди)
 */
function markSingleMessageAsRead(userId: string, fromUser: string, messageId: string) {
  const userUnreads = unreadMessages.get(userId) || [];
  const filtered = userUnreads.filter(msg => !(msg.from === fromUser && msg.id === messageId));
  unreadMessages.set(userId, filtered);
}

/**
 * Удалить одно сообщение из server-side unread очереди.
 * Нужен для delete-for-both, когда сообщение еще не было прочитано получателем.
 */
export function removeUnreadMessage(userId: string, fromUser: string, messageId: string) {
  markSingleMessageAsRead(userId, fromUser, messageId);
}

export function removeUnreadMessages(userId: string, fromUser: string, messageIds: string[]) {
  const ids = new Set(messageIds.map((id) => String(id || '').trim()).filter(Boolean));
  if (ids.size === 0) return;
  const userUnreads = unreadMessages.get(userId) || [];
  unreadMessages.set(
    userId,
    userUnreads.filter((msg) => !(msg.from === fromUser && ids.has(msg.id)))
  );
}

function clearUnreadMessagesBetween(userA: string, userB: string) {
  markMessagesAsRead(userA, userB);
  markMessagesAsRead(userB, userA);
}

export async function markMessagesReadForUser(
  me: string,
  from: string,
  onReceiptChunk?: (messageIds: string[]) => void | Promise<void>
): Promise<number> {
  const friendship = await getOrCreateFriendship(me, from);
  if (!friendship) throw new Error('friendship_not_found');

  const fid = (friendship as any)._id;
  const fromOid = new mongoose.Types.ObjectId(from);
  const meOid = new mongoose.Types.ObjectId(me);
  let total = 0;

  while (true) {
    const unreadItems = await FriendshipMessageItem.find(
      { friendshipId: fid, from: fromOid, to: meOid, read: { $ne: true } },
      { _id: 1, id: 1 }
    )
      .sort({ timestamp: 1, _id: 1 })
      .limit(READ_RECEIPT_CHUNK_SIZE)
      .lean();

    if (unreadItems.length === 0) break;

    const ids = unreadItems.map((doc: any) => String(doc.id)).filter(Boolean);

    await FriendshipMessageItem.updateMany(
      { _id: { $in: unreadItems.map((doc: any) => doc._id) } },
      { $set: { read: true } }
    ).exec();

    if (ids.length > 0) {
      total += ids.length;
      await onReceiptChunk?.(ids);
    }
  }

  await Promise.all([
    FriendshipMessages.updateOne(
      { _id: fid, 'lastMessage.from': fromOid, 'lastMessage.to': meOid },
      { $set: { 'lastMessage.read': true } }
    ).exec(),
  ]);

  return total;
}

export async function markSingleMessageReadForUser(me: string, from: string, messageId: string): Promise<boolean> {
  const friendship = await getOrCreateFriendship(me, from);
  if (!friendship) throw new Error('friendship_not_found');

  const fid = (friendship as any)._id;
  const fromOid = new mongoose.Types.ObjectId(from);
  const meOid = new mongoose.Types.ObjectId(me);

  const [itemResult] = await Promise.all([
    FriendshipMessageItem.updateOne(
      {
        friendshipId: fid,
        id: messageId,
        from: fromOid,
        to: meOid,
        read: { $ne: true },
      },
      { $set: { read: true } }
    ).exec(),
    FriendshipMessages.updateOne(
      { _id: fid, 'lastMessage.id': messageId },
      { $set: { 'lastMessage.read': true } }
    ).exec(),
  ]);

  return !!((itemResult as any)?.modifiedCount || (itemResult as any)?.matchedCount);
}

export async function deleteMessagesForBothUsersBatch(me: string, rawMessageIds: unknown): Promise<{
  ok: boolean;
  deletedIds: string[];
  failedIds: string[];
  recipients: string[];
  error?: string;
}> {
  const messageIds = normalizeMessageIdBatch(rawMessageIds);
  if (messageIds.length === 0) {
    return { ok: false, deletedIds: [], failedIds: [], recipients: [], error: 'bad_message_ids' };
  }
  if (messageIds.length > MAX_MESSAGE_BATCH_SIZE) {
    return {
      ok: false,
      deletedIds: [],
      failedIds: messageIds,
      recipients: [],
      error: 'too_many_message_ids',
    };
  }

  const meOid = new mongoose.Types.ObjectId(me);
  let docs = await FriendshipMessageItem.find({
    id: { $in: messageIds },
    $or: [{ from: meOid }, { to: meOid }],
  }).select('id from to friendshipId').lean();

  const foundIds = new Set((docs as any[]).map((doc) => String(doc.id)));
  const missingIds = messageIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    const legacyFriendshipIds = new Set<string>();
    for (const messageId of missingIds) {
      const legacyFriendshipId = await findLegacyMessageFriendshipId(messageId);
      if (legacyFriendshipId) legacyFriendshipIds.add(String(legacyFriendshipId));
    }
    if (legacyFriendshipIds.size > 0) {
      await Promise.all(
        [...legacyFriendshipIds].map((friendshipId) =>
          backfillFriendshipMessageItems(new mongoose.Types.ObjectId(friendshipId))
        )
      );
      docs = await FriendshipMessageItem.find({
        id: { $in: messageIds },
        $or: [{ from: meOid }, { to: meOid }],
      }).select('id from to friendshipId').lean();
    }
  }

  const foundAfterBackfill = new Set((docs as any[]).map((doc) => String(doc.id)));
  const stillMissingIds = messageIds.filter((id) => !foundAfterBackfill.has(id));
  if (stillMissingIds.length > 0) {
    const legacyDocs: any[] = [];
    for (const messageId of stillMissingIds) {
      const legacyDoc = await findLegacyMessageForUser(messageId, meOid);
      if (legacyDoc) legacyDocs.push(legacyDoc);
    }
    if (legacyDocs.length > 0) {
      docs = [...(docs as any[]), ...legacyDocs] as any;
    }
  }

  const docsById = new Map<string, any[]>();
  for (const doc of docs as any[]) {
    const id = String(doc.id);
    const list = docsById.get(id) || [];
    list.push(doc);
    docsById.set(id, list);
  }

  const deletedIds = messageIds.filter((id) => docsById.has(id));
  const failedIds = messageIds.filter((id) => !docsById.has(id));
  if (deletedIds.length === 0) {
    return { ok: false, deletedIds, failedIds, recipients: [], error: 'not_found' };
  }

  const recipients = new Set<string>();
  const friendshipIds = new Map<string, mongoose.Types.ObjectId>();
  const legacyDeleteIdsByFriendship = new Map<string, string[]>();
  const unreadByRecipientAndSender = new Map<string, { recipientId: string; senderId: string; ids: string[] }>();
  const cachePairs = new Set<string>();

  const deleteDocIds: mongoose.Types.ObjectId[] = [];
  const offlineDeleteClauses: any[] = [];
  for (const messageId of deletedIds) {
    for (const doc of docsById.get(messageId) || []) {
      const fromUserId = String(doc.from);
      const toUserId = String(doc.to);
      const friendshipId = doc.friendshipId as mongoose.Types.ObjectId;
      const friendshipKey = String(friendshipId);

      if ((doc as any)._id) deleteDocIds.push((doc as any)._id);
      recipients.add(fromUserId);
      recipients.add(toUserId);
      friendshipIds.set(friendshipKey, friendshipId);
      const legacyIds = legacyDeleteIdsByFriendship.get(friendshipKey) || [];
      legacyIds.push(messageId);
      legacyDeleteIdsByFriendship.set(friendshipKey, legacyIds);
      offlineDeleteClauses.push({
        messageId,
        senderId: new mongoose.Types.ObjectId(fromUserId),
        recipientId: new mongoose.Types.ObjectId(toUserId),
      });

      const unreadKey = `${toUserId}:${fromUserId}`;
      const unread = unreadByRecipientAndSender.get(unreadKey) || { recipientId: toUserId, senderId: fromUserId, ids: [] };
      unread.ids.push(messageId);
      unreadByRecipientAndSender.set(unreadKey, unread);
      cachePairs.add(`${fromUserId}:${toUserId}`);
    }
  }

  await Promise.all([
    FriendshipMessageItem.deleteMany({ _id: { $in: deleteDocIds } }).exec(),
    FriendshipMessageItem.deleteMany({
      id: { $in: deletedIds },
      $or: [{ from: meOid }, { to: meOid }],
    }).exec(),
    offlineDeleteClauses.length > 0 ? OfflineMessage.deleteMany({ $or: offlineDeleteClauses }).exec() : Promise.resolve(),
    ...[...legacyDeleteIdsByFriendship.entries()].map(([friendshipKey, ids]) =>
      removeLegacyFriendshipMessages(new mongoose.Types.ObjectId(friendshipKey), ids)
    ),
  ]);

  await Promise.all([...friendshipIds.values()].map((friendshipId) => refreshFriendshipLastMessage(friendshipId)));

  for (const unread of unreadByRecipientAndSender.values()) {
    removeUnreadMessages(unread.recipientId, unread.senderId, unread.ids);
  }
  for (const pair of cachePairs) {
    const [fromUserId, toUserId] = pair.split(':');
    invalidateFriendshipCache(fromUserId, toUserId);
  }

  return { ok: true, deletedIds, failedIds, recipients: [...recipients] };
}

export async function clearChatMessagesForUsers(me: string, withId: string, forAll: boolean): Promise<{
  ok: boolean;
  payload?: { by: string; with: string; forAll: boolean };
  error?: string;
}> {
  const isFriend = await areFriendsCached(me, withId);
  if (!isFriend) return { ok: false, error: 'not_friends' };

  if (forAll) {
    const friendship = await getOrCreateFriendship(me, withId);
    if (!friendship) return { ok: false, error: 'friendship_not_found' };

    const fid = (friendship as any)._id;
    const meOid = new mongoose.Types.ObjectId(me);
    const withOid = new mongoose.Types.ObjectId(withId);

    await Promise.all([
      FriendshipMessages.updateOne(
        { _id: fid },
        {
          $set: { lastActivity: new Date() },
          $unset: { lastMessage: '' },
        }
      ).exec(),
      FriendshipMessageItem.deleteMany({ friendshipId: fid }).exec(),
      clearLegacyFriendshipMessages(fid),
      OfflineMessage.deleteMany({
        $or: [
          { senderId: meOid, recipientId: withOid },
          { senderId: withOid, recipientId: meOid },
        ],
      }).exec(),
    ]);

    clearUnreadMessagesBetween(me, withId);
    invalidateFriendshipCache(me, withId);
  }

  return { ok: true, payload: { by: me, with: withId, forAll } };
}

export default function registerMessageSockets(io: Server) {
  io.on('connection', (sock) => {
    registerMessageHandlers(io, sock);
  });
}

function registerMessageHandlers(io: Server, sock: Socket) {
  const meId = () => String((sock as any).data?.userId || '');

  // per-socket handlers
  // console.log(`[sockets] handlers for ${sock.id} user=${meId()}`);

  /** ===== Присутствие "смотрю чат с X" — не слать пуш о сообщении получателю, пока он в этом чате (как в Telegram) ===== */
  sock.on('chat:viewing', (payload: { with: string | null }, ack?: Function) => {
    try {
      const me = meId();
      if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
      const withPeer = payload?.with && isOid(String(payload.with)) ? String(payload.with).trim() : null;
      setViewingChat(me, withPeer);
      ack?.({ ok: true });
    } catch (e: any) {
      ack?.({ ok: false, error: e?.message || 'server_error' });
    }
  });

  sock.on('disconnect', () => {
    const me = meId();
    if (me) setViewingChat(me, null);
  });

  /** ===== Typing/Recording indicator (chat) ===== */
  sock.on('chat:typing', async (payload: { to: string; typing?: boolean; recording?: boolean }, ack?: Function) => {
    try {
      const me = meId();

      if (!isOid(me)) {
        return ack?.({ ok: false, error: 'unauthorized' });
      }
      if (!isOid(payload?.to)) {
        return ack?.({ ok: false, error: 'invalid_to' });
      }

      // Проверяем дружбу (защита от спама)
      const isFriend = await areFriendsCached(me, payload.to);
      if (!isFriend) {
        return ack?.({ ok: false, error: 'not_friends' });
      }

      // Best-effort realtime event (только если получатель онлайн)
      try {
        const typing = !!(payload as any)?.typing;
        const recording = !!(payload as any)?.recording;
        io.to(`u:${payload.to}`).emit('chat:typing', {
          from: me,
          to: payload.to,
          typing,
          recording,
          ts: new Date().toISOString(),
        });
      } catch {}

      return ack?.({ ok: true });
    } catch (e: any) {
      console.error('[chat:typing] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Отправка сообщения другу ===== */
  sock.on('message:send', async (payload: {
    to: string;
    text?: string;
    type: 'text' | 'image' | 'audio' | 'sticker';
    uri?: string;
    uris?: string[];
    name?: string;
    size?: number;
    duration?: number;
    stickerId?: string;
    stickerPackId?: string;
    stickerEmoji?: string;
    stickerLabel?: string;
    clientMessageId?: string;
    clientId?: string;
    replyTo?: { id: string; text?: string; from: string };
  }, ack?: Function) => {
    try {
      const me = meId();

      if (!isOid(me)) {
        return ack?.({ ok: false, error: 'unauthorized' });
      }
      if (!isOid(payload.to)) {
        return ack?.({ ok: false, error: 'invalid_to' });
      }
      if (payload.type !== 'text' && payload.type !== 'image' && payload.type !== 'audio' && payload.type !== 'sticker') {
        return ack?.({ ok: false, error: 'invalid_type' });
      }

      const imageUris =
        payload.type === 'image' ? normalizeIncomingImageUris(payload) : [];
      if (payload.type === 'image' && imageUris.length === 0) {
        return ack?.({ ok: false, error: 'invalid_uri' });
      }
      const primaryUri = payload.type === 'image' ? imageUris[0] : payload.uri;

      // Проверяем дружбу
      const isFriend = await areFriendsCached(me, payload.to);
      if (!isFriend) {
        return ack?.({ ok: false, error: 'not_friends' });
      }

      // Получаем или создаем документ дружбы
      const friendship = await getOrCreateFriendship(me, payload.to);
      if (!friendship) {
        return ack?.({ ok: false, error: 'friendship_not_found' });
      }

      const friendshipId = (friendship as any)._id;
      const clientMessageId = normalizeClientMessageId(payload);
      if (clientMessageId) {
        const existing = await FriendshipMessageItem.findOne({
          friendshipId,
          id: clientMessageId,
          from: new mongoose.Types.ObjectId(me),
          to: new mongoose.Types.ObjectId(payload.to),
        }).select('id timestamp').lean();
        if (existing) {
          return ack?.(formatExistingMessageAck(existing, await isUserOnline(io, payload.to)));
        }
      }

      // Создаем ID сообщения. New clients provide an optimistic id, old clients keep generated ids.
      const messageId = clientMessageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Создаем объект сообщения
      const message: any = {
        id: messageId,
        from: me,
        to: payload.to,
        type: payload.type,
        text: payload.text,
        uri: primaryUri,
        name: payload.name,
        size: payload.size,
        duration: payload.duration,
        stickerId: payload.stickerId,
        stickerPackId: payload.stickerPackId,
        stickerEmoji: payload.stickerEmoji,
        stickerLabel: payload.stickerLabel,
        timestamp: new Date(),
        read: false
      };
      if (payload.type === 'image' && imageUris.length > 1) {
        message.uris = imageUris;
      }
      if (payload.replyTo && typeof payload.replyTo === 'object' && payload.replyTo.id) {
        message.replyTo = {
          id: String(payload.replyTo.id),
          text: payload.replyTo.text != null ? String(payload.replyTo.text) : undefined,
          from: String(payload.replyTo.from || ''),
        };
      }

      // Добавляем сообщение в дружбу
      const saveResult = await addMessageToFriendship(friendship, message);
      if (saveResult.duplicate) {
        return ack?.(formatExistingMessageAck(
          { id: messageId, timestamp: saveResult.timestamp || message.timestamp },
          await isUserOnline(io, payload.to)
        ));
      }
      if (saveResult.conflict) {
        return ack?.({ ok: false, error: 'message_id_conflict' });
      }
      if (!saveResult.ok) {
        return ack?.({ ok: false, error: 'save_failed' });
      }

      // Счётчик непрочитанных: не копим, если получатель уже в этом чате (chat:viewing), иначе бейдж/Home дергаются до mark_read.
      if (!isViewingChatWith(payload.to, me)) {
        addUnreadMessage(payload.to, messageId, me);
      }

      // Отправляем сообщение получателю если он онлайн
      const recipientOnline = await isUserOnline(io, payload.to);

      const emitPayload: any = {
        id: messageId,
        from: me,
        to: payload.to,
        type: payload.type,
        text: payload.text,
        uri: primaryUri,
        name: payload.name,
        size: payload.size,
        duration: payload.duration,
        stickerId: payload.stickerId,
        stickerPackId: payload.stickerPackId,
        stickerEmoji: payload.stickerEmoji,
        stickerLabel: payload.stickerLabel,
        timestamp: message.timestamp.toISOString(),
        read: false
      };
      if (payload.type === 'image' && imageUris.length > 1) {
        emitPayload.uris = imageUris;
      }
      if (message.replyTo) emitPayload.replyTo = message.replyTo;

      if (recipientOnline) {
        const delivered = await sendMessageToUser(io, payload.to, emitPayload);
        if (delivered) {}
      } else {
        await saveOfflineMessage(payload.to, { ...emitPayload, id: messageId });
      }

      // Отправляем подтверждение отправителю
      ack?.({ 
        ok: true, 
        messageId,
        timestamp: message.timestamp,
        delivered: recipientOnline
      });

      // 📲 PUSH: новое сообщение. Не слать пуш, если получатель сейчас в этом чате (как в Telegram).
      try {
        if (isViewingChatWith(payload.to, me)) {
          // Получатель смотрит чат с отправителем — пуш не отправляем
        } else {
          let fromNick: string | undefined;
          try {
            const u = await User.findById(me).select('nick').lean();
            if (u && typeof (u as any).nick === 'string') fromNick = String((u as any).nick).trim() || undefined;
          } catch {}

          const unreadCount = (unreadMessages.get(payload.to) || []).length;
          const msgType = payload.type === 'image' ? 'image' : payload.type === 'audio' ? 'audio' : payload.type === 'sticker' ? 'sticker' : 'text';
          const albumCount = payload.type === 'image' ? imageUris.length : 0;
          const messagePreview =
            msgType === 'text'
              ? (typeof payload.text === 'string' ? String(payload.text).trim().slice(0, 80) : '')
              : msgType === 'image'
                ? (albumCount > 1 ? `[Фото ×${albumCount}]` : '[Фото]')
                : msgType === 'sticker'
                  ? '[Стикер]'
                  : '[Голосовое]';

          await sendMessagePushToUser(String(payload.to), {
          type: 'message',
          messageId,
          from: String(me),
          to: String(payload.to),
          fromNick: fromNick || '',
          sentAt: message.timestamp.toISOString(),
          unreadCount,
          messagePreview,
        });
        }
      } catch {}
    } catch (e: any) {
      console.error('[message:send] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Получение сообщений (из отдельной коллекции FriendshipMessageItem) ===== */
  sock.on('messages:fetch', async (payload: {
    with: string;
    limit?: number;
    before?: string;
  }, ack?: Function) => {
    try {
      const me = meId();

      if (!isOid(me)) {
        return ack?.({ ok: false, error: 'unauthorized' });
      }
      if (!isOid(payload.with)) {
        return ack?.({ ok: false, error: 'invalid_with' });
      }

      const isFriend = await areFriendsCached(me, payload.with);
      if (!isFriend) {
        return ack?.({ ok: false, error: 'not_friends' });
      }

      const friendship = await getOrCreateFriendship(me, payload.with);
      if (!friendship) {
        return ack?.({ ok: false, error: 'friendship_not_found' });
      }

      const friendshipId = (friendship as any)._id;
      const limit = Math.min(200, Math.max(1, payload.limit || 50));
      const { messages, hasMore } = await fetchFriendshipMessagesPage(friendshipId, limit, payload.before);

      ack?.({ ok: true, messages, hasMore });
    } catch (e: any) {
      console.error('[messages:fetch] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Отметка сообщений как прочитанных ===== */
  sock.on('messages:mark_read', async (payload: {
    from: string;
  }, ack?: Function) => {
    try {
      const me = meId();

      if (!isOid(me)) {
        return ack?.({ ok: false, error: 'unauthorized' });
      }
      if (!isOid(payload.from)) {
        return ack?.({ ok: false, error: 'invalid_from' });
      }

      const timestamp = new Date().toISOString();
      await markMessagesReadForUser(me, payload.from, (messageIds) => {
        io.to(`u:${payload.from}`).emit('messages:read_receipt', {
          messageIds,
          readBy: me,
          timestamp,
        });
      });

      // In-memory очередь непрочитанных
      markMessagesAsRead(me, payload.from);

      ack?.({ ok: true });
    } catch (e: any) {
      console.error('[messages:mark_read] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Подтверждение прочтения одного сообщения (read receipt) ===== */
  sock.on('message:read', async (payload: {
    messageId: string;
    from: string; // автор сообщения (от кого мне пришло)
  }, ack?: Function) => {
    try {
      const me = meId();

      if (!isOid(me)) {
        return ack?.({ ok: false, error: 'unauthorized' });
      }
      if (!isOid(payload.from) || !payload.messageId) {
        return ack?.({ ok: false, error: 'bad_payload' });
      }

      const messageId = String(payload.messageId || '').trim();
      if (messageId) {
        await markSingleMessageReadForUser(me, payload.from, messageId);
      }

      // Чистим из in-memory очереди одно сообщение
      markSingleMessageAsRead(me, payload.from, payload.messageId);

      const receipt = {
        messageId: payload.messageId,
        readBy: me,
        timestamp: new Date().toISOString(),
      };

      io.to(`u:${payload.from}`).emit('message:read_receipt', receipt);

      return ack?.({ ok: true });
    } catch (e: any) {
      console.error('[message:read] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Реакция на сообщение (добавить/снять эмодзи) ===== */
  sock.on('message:react', async (payload: {
    messageId: string;
    emoji: string;
    with: string; // peerId чата
  }, ack?: Function) => {
    try {
      const me = meId();
      const messageId = String(payload?.messageId || '').trim();
      const emoji = String(payload?.emoji || '').trim();
      const peerId = String(payload?.with || '').trim();

      if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
      if (!messageId || !emoji || !isOid(peerId)) return ack?.({ ok: false, error: 'bad_payload' });

      const isFriend = await areFriendsCached(me, peerId);
      if (!isFriend) return ack?.({ ok: false, error: 'not_friends' });

      const friendship = await getOrCreateFriendship(me, peerId);
      if (!friendship) return ack?.({ ok: false, error: 'friendship_not_found' });

      const fid = (friendship as any)._id;
      const itemDoc = await FriendshipMessageItem.findOne({
        friendshipId: fid,
        id: messageId,
      }).select('_id').lean();
      const msg = itemDoc;
      if (!msg) return ack?.({ ok: false, error: 'message_not_found' });

      const myReaction = { emoji, userId: me };
      const pullResult = await FriendshipMessageItem.updateOne(
        { friendshipId: fid, id: messageId },
        { $pull: { reactions: myReaction } }
      ).exec();

      if (!((pullResult as any)?.modifiedCount || 0)) {
        await FriendshipMessageItem.updateOne(
          { friendshipId: fid, id: messageId },
          { $addToSet: { reactions: myReaction } }
        ).exec();
      }

      const updated = await FriendshipMessageItem.findOne(
        { friendshipId: fid, id: messageId },
        { reactions: 1 }
      ).lean();
      const newReactions = Array.isArray((updated as any)?.reactions)
        ? (updated as any).reactions.map((r: any) => ({ emoji: String(r.emoji), userId: String(r.userId) }))
        : [];

      await FriendshipMessages.updateOne(
        { _id: fid, 'lastMessage.id': messageId },
        { $set: { 'lastMessage.reactions': newReactions } }
      ).exec();

      const payloadOut = { messageId, reactions: newReactions };
      io.to(`u:${String(me)}`).emit('message:reaction', payloadOut);
      io.to(`u:${String(peerId)}`).emit('message:reaction', payloadOut);

      return ack?.({ ok: true, reactions: newReactions });
    } catch (e: any) {
      console.error('[message:react] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Получение количества непрочитанных сообщений ===== */
  sock.on('messages:unread_count', async (payload: {
    from?: string;
  }, ack?: Function) => {
    try {
      const me = meId();
      
      if (!isOid(me)) {
        return ack?.({ ok: false, error: 'unauthorized' });
      }

      if (payload.from && isOid(payload.from)) {
        // Количество непрочитанных от конкретного пользователя
        const count = getUnreadCount(me, payload.from);
        ack?.({ ok: true, count });
      } else {
        // Общее количество непрочитанных сообщений
        const allUnreads = unreadMessages.get(me) || [];
        const count = allUnreads.length;
        ack?.({ ok: true, count });
      }

    } catch (e: any) {
      console.error('[messages:unread_count] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Batch: непрочитанные по списку собеседников (один round-trip) ===== */
  sock.on('messages:unread_counts', async (payload: {
    fromIds?: string[];
  }, ack?: Function) => {
    try {
      const me = meId();

      if (!isOid(me)) {
        return ack?.({ ok: false, error: 'unauthorized' });
      }

      const counts: Record<string, number> = {};
      const ids = Array.isArray(payload?.fromIds)
        ? payload.fromIds.map((id) => String(id).trim()).filter((id) => isOid(id))
        : [];

      if (ids.length > 0) {
        for (const from of ids) {
          counts[from] = getUnreadCount(me, from);
        }
      } else {
        const allUnreads = unreadMessages.get(me) || [];
        for (const msg of allUnreads) {
          const from = String(msg.from || '').trim();
          if (!isOid(from)) continue;
          counts[from] = (counts[from] || 0) + 1;
        }
      }

      ack?.({ ok: true, counts });
    } catch (e: any) {
      console.error('[messages:unread_counts] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Удаление одного сообщения (для обоих). Поиск по messageId в БД. ===== */
  sock.on('message:delete', async (payload: { messageId: string }, ack?: Function) => {
    try {
      const me = meId();
      const messageId = String(payload?.messageId || '').trim();
      if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
      if (!messageId) return ack?.({ ok: false, error: 'bad_message_id' });
      const result = await deleteMessageForBothUsers(me, messageId);
      if (!result.ok) return ack?.({ ok: false, error: result.error || 'not_found' });

      const eventPayload = { messageId, deletedBy: me };
      emitMessageDeletedToParticipants(io, result.fromUserId, result.toUserId, eventPayload);

      return ack?.({ ok: true });
    } catch (e: any) {
      console.error('[message:delete] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  sock.on('messages:delete', async (payload: { messageIds: string[] }, ack?: Function) => {
    try {
      const me = meId();
      if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized', deletedIds: [], failedIds: [] });
      const messageIds = normalizeMessageIdBatch(payload?.messageIds);
      if (messageIds.length === 0) {
        return ack?.({ ok: false, error: 'bad_message_ids', deletedIds: [], failedIds: [] });
      }
      if (messageIds.length > MAX_MESSAGE_BATCH_SIZE) {
        return ack?.({
          ok: false,
          error: 'too_many_message_ids',
          deletedIds: [],
          failedIds: messageIds,
          max: MAX_MESSAGE_BATCH_SIZE,
        });
      }

      const result = await deleteMessagesForBothUsersBatch(me, messageIds);

      if (result.deletedIds.length > 0) {
        const eventPayload = { messageIds: result.deletedIds, deletedBy: me };
        emitMessagesDeletedToParticipants(io, result.recipients, eventPayload);
      }

      return ack?.({
        ok: result.deletedIds.length > 0,
        deletedIds: result.deletedIds,
        failedIds: result.failedIds,
        ...(result.error ? { error: result.error } : {}),
      });
    } catch (e: any) {
      console.error('[messages:delete] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error', deletedIds: [], failedIds: [] });
    }
  });

  sock.on('message:clear_chat', async (payload: { with: string; forAll?: boolean }, ack?: Function) => {
    try {
      const me = meId();
      const withId = String(payload?.with || '').trim();
      const forAll = !!payload?.forAll;

      if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
      if (!isOid(withId)) return ack?.({ ok: false, error: 'invalid_with' });

      const result = await clearChatMessagesForUsers(me, withId, forAll);
      if (!result.ok || !result.payload) {
        return ack?.({ ok: false, error: result.error || 'server_error' });
      }

      emitToUser(io, me, 'message:chat_cleared', result.payload);
      if (forAll) {
        emitToUser(io, withId, 'message:chat_cleared', result.payload);
      }

      return ack?.({ ok: true });
    } catch (e: any) {
      console.error('[message:clear_chat] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Обновление альбома фото (удалить одно фото из сообщения). Только отправитель. ===== */
  sock.on('message:update_uris', async (payload: { messageId: string; uris?: string[] }, ack?: Function) => {
    try {
      const me = meId();
      const messageId = String(payload?.messageId || '').trim();
      if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
      if (!messageId) return ack?.({ ok: false, error: 'bad_request' });

      const nextUris = normalizeIncomingImageUris({ uris: payload?.uris });
      const meOid = new mongoose.Types.ObjectId(me);
      let doc = await FriendshipMessageItem.findOne({ id: messageId, from: meOid })
        .select('from type friendshipId uri uris')
        .lean();
      if (!doc) {
        const legacyFriendshipId = await findLegacyMessageFriendshipId(messageId);
        if (legacyFriendshipId) {
          await backfillFriendshipMessageItems(legacyFriendshipId);
          doc = await FriendshipMessageItem.findOne({ id: messageId, from: meOid })
            .select('from type friendshipId uri uris')
            .lean();
        }
      }
      if (!doc) return ack?.({ ok: false, error: 'not_found_or_forbidden' });
      if ((doc as any).type !== 'image') return ack?.({ ok: false, error: 'not_found_or_forbidden' });

      const friendshipId = (doc as any).friendshipId;
      const fr = await FriendshipMessages.findById(friendshipId).select('user1 user2').lean();
      const u1 = fr ? String((fr as any).user1) : '';
      const u2 = fr ? String((fr as any).user2) : '';

      if (nextUris.length === 0) {
        const del = await deleteMessagesForBothUsersBatch(me, [messageId]);
        if (!del?.ok || !del.deletedIds?.length) {
          return ack?.({ ok: false, error: del?.error || 'delete_failed' });
        }
        try {
          const recipients = new Set<string>([me, u1, u2, ...(del.recipients || [])].filter(Boolean));
          emitMessagesDeletedToParticipants(io, recipients, {
            messageIds: del.deletedIds,
            deletedBy: me,
          });
        } catch {}
        return ack?.({ ok: true, messageId, deleted: true, uris: [] });
      }

      const primaryUri = nextUris[0];
      const setDoc: any = { uri: primaryUri };
      if (nextUris.length > 1) setDoc.uris = nextUris;
      const unsetDoc: any = nextUris.length > 1 ? {} : { uris: '' };

      await FriendshipMessageItem.updateOne(
        { friendshipId, id: messageId },
        {
          $set: setDoc,
          ...(Object.keys(unsetDoc).length ? { $unset: unsetDoc } : {}),
        }
      ).exec();

      const lastSet: any = {
        'lastMessage.uri': primaryUri,
        lastActivity: new Date(),
      };
      if (nextUris.length > 1) lastSet['lastMessage.uris'] = nextUris;
      await FriendshipMessages.updateOne(
        { _id: friendshipId, 'lastMessage.id': messageId },
        {
          $set: lastSet,
          ...(nextUris.length > 1 ? {} : { $unset: { 'lastMessage.uris': '' } }),
        }
      ).exec();

      const payloadOut: any = {
        messageId,
        uri: primaryUri,
        uris: nextUris.length > 1 ? nextUris : undefined,
      };
      if (u1) io.to(`u:${u1}`).emit('message:uris_updated', payloadOut);
      if (u2) io.to(`u:${u2}`).emit('message:uris_updated', payloadOut);
      return ack?.({ ok: true, ...payloadOut });
    } catch (e: any) {
      console.error('[message:update_uris] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Редактирование текстового сообщения (только отправитель). Поиск по messageId в БД. ===== */
  sock.on('message:edit', async (payload: { messageId: string; text: string }, ack?: Function) => {
    try {
      const me = meId();
      const messageId = String(payload?.messageId || '').trim();
      const text = typeof payload?.text === 'string' ? String(payload.text).trim() : '';
      if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
      if (!messageId || text === '') return ack?.({ ok: false, error: 'bad_request' });

      let u1 = '';
      let u2 = '';

      const meOid = new mongoose.Types.ObjectId(me);
      let doc = await FriendshipMessageItem.findOne({ id: messageId, from: meOid }).select('from type friendshipId').lean();
      if (!doc) {
        const legacyFriendshipId = await findLegacyMessageFriendshipId(messageId);
        if (legacyFriendshipId) {
          await backfillFriendshipMessageItems(legacyFriendshipId);
          doc = await FriendshipMessageItem.findOne({ id: messageId, from: meOid }).select('from type friendshipId').lean();
        }
      }
      if (!doc) return ack?.({ ok: false, error: 'not_found_or_forbidden' });
      if ((doc as any).type !== 'text') return ack?.({ ok: false, error: 'not_found_or_forbidden' });
      if (String((doc as any).from) !== me) return ack?.({ ok: false, error: 'not_found_or_forbidden' });
      await FriendshipMessageItem.updateOne(
        { friendshipId: (doc as any).friendshipId, id: messageId },
        { $set: { text } }
      ).exec();
      const fr = await FriendshipMessages.findById((doc as any).friendshipId).select('user1 user2').lean();
      if (fr) {
        u1 = String((fr as any).user1);
        u2 = String((fr as any).user2);
      }
      await FriendshipMessages.updateOne(
        { _id: (doc as any).friendshipId, 'lastMessage.id': messageId },
        { $set: { 'lastMessage.text': text, lastActivity: new Date() } }
      ).exec();

      const payloadOut = { messageId, text };
      if (u1 || u2) {
        if (u1) io.to(`u:${String(u1)}`).emit('message:edited', payloadOut);
        if (u2) io.to(`u:${String(u2)}`).emit('message:edited', payloadOut);
      }
      return ack?.({ ok: true, messageId, text });
    } catch (e: any) {
      console.error('[message:edit] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });
}

