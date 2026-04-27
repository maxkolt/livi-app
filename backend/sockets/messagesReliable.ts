// Надежная система сообщений с персистентным хранением офлайн сообщений
import { Server, Socket } from 'socket.io';
import mongoose from 'mongoose';
import User from '../models/User';
import FriendshipMessages, { IFriendshipMessages } from '../models/FriendshipMessages';
import FriendshipMessageItem from '../models/FriendshipMessageItem';
import OfflineMessage from '../models/OfflineMessage';
import { areFriendsCached, getOrCreateFriendship, invalidateFriendshipCache } from '../utils/friendshipUtils';
import { sendMessagePushToUser } from '../utils/push';

const isOid = (s?: string) => !!s && mongoose.Types.ObjectId.isValid(String(s));

async function purgeMessageFromFriendship(friendshipId: mongoose.Types.ObjectId | null, messageId: string) {
  if (!friendshipId || !messageId) return;
  await FriendshipMessages.updateOne(
    { _id: friendshipId },
    {
      $pull: {
        textMessages: { id: messageId },
        imageMessages: { id: messageId },
        audioMessages: { id: messageId },
      },
      $set: { lastActivity: new Date() },
    }
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

  const doc = await FriendshipMessageItem.findOne({ id: messageId }).select('from to friendshipId type').lean();
  if (doc) {
    fromUserId = String((doc as any).from);
    toUserId = String((doc as any).to);
    friendshipId = (doc as any).friendshipId;
    if (fromUserId !== me && toUserId !== me) return { ok: false, error: 'not_found' };
    await FriendshipMessageItem.deleteOne({ id: messageId });
    await purgeMessageFromFriendship(friendshipId, messageId);
  } else {
    const list = await FriendshipMessages.find({
      $and: [
        { $or: [{ user1: me }, { user2: me }] },
        { $or: [{ 'textMessages.id': messageId }, { 'imageMessages.id': messageId }, { 'audioMessages.id': messageId }] },
      ],
    }).lean();
    const fd = list.find((f: any) => {
      const arr = [...(f.textMessages || []), ...(f.imageMessages || []), ...(f.audioMessages || [])];
      const m = arr.find((x: any) => x.id === messageId);
      if (m) {
        fromUserId = String(m.from);
        toUserId = String(m.to);
        friendshipId = f._id;
        return true;
      }
      return false;
    });
    if (!fd) return { ok: false, error: 'not_found' };
    const friendship = await FriendshipMessages.findOne({
      _id: friendshipId,
      $or: [{ user1: me }, { user2: me }],
    });
    if (friendship) await (friendship as any).removeMessage(messageId);
    await purgeMessageFromFriendship(friendshipId, messageId);
  }

  try {
    if (toUserId && fromUserId) {
      removeUnreadMessage(toUserId, fromUserId, messageId);
      await OfflineMessage.deleteMany({
        recipientId: new mongoose.Types.ObjectId(toUserId),
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
async function addMessageToFriendship(friendship: IFriendshipMessages, message: any): Promise<boolean> {
  try {
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
      timestamp: message.timestamp,
      read: message.read
    };
    if (message.replyTo && typeof message.replyTo === 'object' && message.replyTo.id) {
      messageItem.replyTo = {
        id: String(message.replyTo.id),
        text: message.replyTo.text != null ? String(message.replyTo.text) : undefined,
        from: String(message.replyTo.from || ''),
      };
    }

    await (friendship as any).addMessage(messageItem);

    const createPayload: any = {
      friendshipId: (friendship as any)._id,
      id: message.id,
      from: messageItem.from,
      to: messageItem.to,
      type: message.type,
      text: message.text,
      uri: message.uri,
      name: message.name,
      size: message.size,
      duration: message.duration,
      timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
      read: !!message.read,
    };
    if (messageItem.replyTo) createPayload.replyTo = messageItem.replyTo;
    await FriendshipMessageItem.create(createPayload);
    return true;
  } catch (error) {
    console.error('Error adding message to friendship:', error);
    return false;
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
    const offlineMessages = await OfflineMessage.find({
      recipientId: new mongoose.Types.ObjectId(userId)
    }).sort({ createdAt: 1 }); // Сортируем по времени создания
    
    if (offlineMessages.length > 0) {
      // Удаляем офлайн сообщения после получения
      await OfflineMessage.deleteMany({
        recipientId: new mongoose.Types.ObjectId(userId)
      });

      const messages = offlineMessages.map(msg => msg.messageData);
      return messages;
    }
    
    return [];
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
function isUserOnline(io: Server, userId: string): boolean {
  const onlineSockets = Array.from(io.sockets.sockets.values())
    .filter(s => (s as any).data?.userId === userId);
  
  return onlineSockets.length > 0;
}

/**
 * Отправить сообщение пользователю если он онлайн
 */
function sendMessageToUser(io: Server, userId: string, message: any): boolean {
  try {
    const userSockets = Array.from(io.sockets.sockets.values())
      .filter(s => (s as any).data?.userId === userId);
    
    if (userSockets.length > 0) {
      userSockets.forEach(socket => {
        socket.emit('message:received', message);
      });
      return true;
    }
    
    return false;
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
    type: 'text' | 'image' | 'audio';
    uri?: string;
    name?: string;
    size?: number;
    duration?: number;
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

      // Проверяем дружбу
      const isFriend = await areFriendsCached(me, payload.to);
      if (!isFriend) {
        return ack?.({ ok: false, error: 'not_friends' });
      }

      // Создаем ID сообщения
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Получаем или создаем документ дружбы
      const friendship = await getOrCreateFriendship(me, payload.to);
      if (!friendship) {
        return ack?.({ ok: false, error: 'friendship_not_found' });
      }

      // Создаем объект сообщения
      const message: any = {
        id: messageId,
        from: me,
        to: payload.to,
        type: payload.type,
        text: payload.text,
        uri: payload.uri,
        name: payload.name,
        size: payload.size,
        duration: payload.duration,
        timestamp: new Date(),
        read: false
      };
      if (payload.replyTo && typeof payload.replyTo === 'object' && payload.replyTo.id) {
        message.replyTo = {
          id: String(payload.replyTo.id),
          text: payload.replyTo.text != null ? String(payload.replyTo.text) : undefined,
          from: String(payload.replyTo.from || ''),
        };
      }

      // Добавляем сообщение в дружбу
      const success = await addMessageToFriendship(friendship, message);
      if (!success) {
        return ack?.({ ok: false, error: 'save_failed' });
      }

      // Счётчик непрочитанных: не копим, если получатель уже в этом чате (chat:viewing), иначе бейдж/Home дергаются до mark_read.
      if (!isViewingChatWith(payload.to, me)) {
        addUnreadMessage(payload.to, messageId, me);
      }

      // Отправляем сообщение получателю если он онлайн
      const recipientOnline = isUserOnline(io, payload.to);

      const emitPayload: any = {
        id: messageId,
        from: me,
        to: payload.to,
        type: payload.type,
        text: payload.text,
        uri: payload.uri,
        name: payload.name,
        size: payload.size,
        duration: payload.duration,
        timestamp: message.timestamp.toISOString(),
        read: false
      };
      if (message.replyTo) emitPayload.replyTo = message.replyTo;

      if (recipientOnline) {
        const delivered = sendMessageToUser(io, payload.to, emitPayload);
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
          const msgType = payload.type === 'image' ? 'image' : payload.type === 'audio' ? 'audio' : 'text';
          const messagePreview =
            msgType === 'text'
              ? (typeof payload.text === 'string' ? String(payload.text).trim().slice(0, 80) : '')
              : msgType === 'image'
                ? '[Фото]'
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
      const query: any = { friendshipId };
      if (payload.before) {
        const beforeDoc = await FriendshipMessageItem.findOne(
          { friendshipId, id: payload.before },
          { timestamp: 1 }
        ).lean();
        if (beforeDoc && (beforeDoc as any).timestamp) {
          query.timestamp = { $lt: (beforeDoc as any).timestamp };
        }
      }
      let raw = await FriendshipMessageItem.find(query)
        .sort({ timestamp: -1 })
        .limit(limit + 1)
        .lean();
      if (raw.length === 0) {
        const allMessages = (friendship as any).getAllMessages?.() || [];
        let messages = allMessages;
        if (payload.before) {
          const beforeIndex = messages.findIndex((msg: any) => msg.id === payload.before);
          if (beforeIndex > 0) messages = messages.slice(0, beforeIndex);
        }
        const limitOld = payload.limit || 50;
        messages = messages.slice(-limitOld);
        const formattedMessages = messages.map((msg: any) => ({
          id: msg.id,
          from: msg.from?.toString?.() || String(msg.from),
          to: msg.to?.toString?.() || String(msg.to),
          type: msg.type,
          text: msg.text,
          uri: msg.uri,
          name: msg.name,
          size: msg.size,
          duration: msg.duration,
          timestamp: msg.timestamp?.toISOString?.() || String(msg.timestamp),
          read: !!msg.read,
          reactions: Array.isArray(msg.reactions) ? msg.reactions.map((r: any) => ({ emoji: r.emoji, userId: String(r.userId) })) : [],
          ...(msg.replyTo && msg.replyTo.id ? { replyTo: { id: String(msg.replyTo.id), text: msg.replyTo.text, from: String(msg.replyTo.from || '') } } : {}),
        }));
        return ack?.({ ok: true, messages: formattedMessages, hasMore: allMessages.length > limitOld });
      }
      const hasMore = raw.length > limit;
      const slice = hasMore ? raw.slice(0, limit) : raw;
      const formattedMessages = slice.reverse().map((msg: any) => ({
        id: msg.id,
        from: msg.from?.toString?.() || String(msg.from),
        to: msg.to?.toString?.() || String(msg.to),
        type: msg.type,
        text: msg.text,
        uri: msg.uri,
        name: msg.name,
        size: msg.size,
        duration: msg.duration,
        timestamp: msg.timestamp?.toISOString?.() || String(msg.timestamp),
        read: !!msg.read,
        reactions: Array.isArray(msg.reactions) ? msg.reactions.map((r: any) => ({ emoji: r.emoji, userId: String(r.userId) })) : [],
        ...(msg.replyTo && msg.replyTo.id ? { replyTo: { id: String(msg.replyTo.id), text: msg.replyTo.text, from: String(msg.replyTo.from || '') } } : {}),
      }));

      ack?.({ ok: true, messages: formattedMessages, hasMore });
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

      const friendship = await getOrCreateFriendship(me, payload.from);
      if (!friendship) {
        return ack?.({ ok: false, error: 'friendship_not_found' });
      }

      const fid = (friendship as any)._id;
      const fromOid = new mongoose.Types.ObjectId(payload.from);

      // Собираем ID непрочитанных сообщений от payload.from, чтобы потом отправить read_receipt отправителю
      const unreadItems = await FriendshipMessageItem.find(
        { friendshipId: fid, from: fromOid, read: false },
        { id: 1 }
      ).lean();
      const messageIds = unreadItems.map((doc: any) => String(doc.id)).filter(Boolean);

      // Персистентно помечаем прочитанными в БД (как в HTTP /api/messages/mark_read)
      await FriendshipMessages.updateOne(
        { _id: fid },
        {
          $set: {
            'textMessages.$[t].read': true,
            'imageMessages.$[i].read': true,
            'audioMessages.$[a].read': true,
          },
        },
        {
          arrayFilters: [
            { 't.from': fromOid },
            { 'i.from': fromOid },
            { 'a.from': fromOid },
          ],
        }
      ).exec();

      await FriendshipMessageItem.updateMany(
        { friendshipId: fid, from: fromOid },
        { $set: { read: true } }
      ).exec();

      // In-memory очередь непрочитанных
      markMessagesAsRead(me, payload.from);

      // Уведомляем отправителя (payload.from) о прочтении каждого сообщения — тогда у него появятся две галочки
      const senderSockets = Array.from(io.sockets.sockets.values())
        .filter((s: any) => String(s?.data?.userId) === String(payload.from));

      for (const messageId of messageIds) {
        const receipt = {
          messageId,
          readBy: me,
          timestamp: new Date().toISOString(),
        };
        for (const s of senderSockets) {
          try {
            s.emit('message:read_receipt', receipt);
          } catch {}
        }
      }

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

      // Ищем дружбу и само сообщение
      const friendship = await getOrCreateFriendship(me, payload.from);
      if (!friendship) {
        return ack?.({ ok: false, error: 'friendship_not_found' });
      }

      // IMPORTANT:
      // Do NOT call friendship.save() here.
      // The friendship document is cached in-memory and can be saved concurrently by other handlers
      // (or multiple read receipts at once). Mongoose throws:
      // "Can't save() the same doc multiple times in parallel".
      //
      // Use atomic updateOne instead to make this idempotent and concurrency-safe.
      const messageId = String(payload.messageId || '').trim();
      if (messageId) {
        const fid: any = (friendship as any)?._id;
        try {
          const tryUpdate = async (path: 'textMessages' | 'imageMessages' | 'audioMessages') => {
            const filter: any = { _id: fid };
            filter[`${path}.id`] = messageId;
            filter[`${path}.read`] = { $ne: true };
            const update: any = { $set: { [`${path}.$.read`]: true } };
            return FriendshipMessages.updateOne(filter, update).exec();
          };

          // Try each message bucket; only one should match.
          await tryUpdate('textMessages');
          await tryUpdate('imageMessages');
          await tryUpdate('audioMessages');
        } catch {}

        // Keep in-memory cached doc consistent (best-effort, no save)
        try {
          const msg = (friendship as any).findMessageById?.(messageId);
          if (msg && !msg.read) msg.read = true;
        } catch {}
      }

      // Чистим из in-memory очереди одно сообщение
      markSingleMessageAsRead(me, payload.from, payload.messageId);

      // Уведомляем отправителя (payload.from)
      const senderSockets = Array.from(io.sockets.sockets.values())
        .filter(s => (s as any).data?.userId === payload.from);

      const receipt = {
        messageId: payload.messageId,
        readBy: me,
        timestamp: new Date().toISOString(),
      };

      for (const s of senderSockets) {
        s.emit('message:read_receipt', receipt);
      }

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

      const msg = (friendship as any).findMessageById?.(messageId);
      if (!msg) return ack?.({ ok: false, error: 'message_not_found' });

      const current: { emoji: string; userId: string }[] = Array.isArray(msg.reactions) ? msg.reactions.map((r: any) => ({ emoji: String(r.emoji), userId: String(r.userId) })) : [];
      const hasMine = current.some((r) => r.emoji === emoji && r.userId === me);
      const newReactions = hasMine
        ? current.filter((r) => !(r.emoji === emoji && r.userId === me))
        : [...current, { emoji, userId: me }];

      const path = msg.type === 'text' ? 'textMessages' : msg.type === 'image' ? 'imageMessages' : 'audioMessages';
      const fid = (friendship as any)._id;
      await FriendshipMessages.updateOne(
        { _id: fid, [`${path}.id`]: messageId },
        { $set: { [`${path}.$.reactions`]: newReactions } }
      ).exec();

      // Обновляем кэш в памяти
      try {
        const arr = (friendship as any).getMessagesArray?.(msg.type);
        const idx = arr?.findIndex?.((m: any) => m.id === messageId);
        if (arr && idx !== undefined && idx >= 0) arr[idx].reactions = newReactions;
      } catch {}

      const payloadOut = { messageId, reactions: newReactions };
      const emitToUser = (userId: string) => {
        const sockets = Array.from(io.sockets.sockets.values()).filter((s: any) => s.data?.userId === userId);
        sockets.forEach((s: any) => s.emit('message:reaction', payloadOut));
      };
      emitToUser(me);
      emitToUser(peerId);

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

  /** ===== Удаление одного сообщения (для обоих). Поиск по messageId в БД. ===== */
  sock.on('message:delete', async (payload: { messageId: string }, ack?: Function) => {
    try {
      const me = meId();
      const messageId = String(payload?.messageId || '').trim();
      if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
      if (!messageId) return ack?.({ ok: false, error: 'bad_message_id' });
      const result = await deleteMessageForBothUsers(me, messageId);
      if (!result.ok) return ack?.({ ok: false, error: result.error || 'not_found' });

      const recipients = [result.fromUserId, result.toUserId].filter(Boolean);
      for (const s of io.sockets.sockets.values()) {
        const uid = (s as any).data?.userId;
        if (uid && recipients.includes(String(uid))) {
          s.emit('message:deleted', { messageId, deletedBy: me });
        }
      }

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
      const messageIds = Array.from(new Set(
        (Array.isArray(payload?.messageIds) ? payload.messageIds : [])
          .map((id: any) => String(id || '').trim())
          .filter(Boolean)
      ));
      if (messageIds.length === 0) {
        return ack?.({ ok: false, error: 'bad_message_ids', deletedIds: [], failedIds: [] });
      }

      const deletedIds: string[] = [];
      const failedIds: string[] = [];
      const recipients = new Set<string>();
      for (const messageId of messageIds) {
        try {
          const result = await deleteMessageForBothUsers(me, messageId);
          if (!result.ok) {
            failedIds.push(messageId);
            continue;
          }
          deletedIds.push(messageId);
          if (result.fromUserId) recipients.add(String(result.fromUserId));
          if (result.toUserId) recipients.add(String(result.toUserId));
        } catch {
          failedIds.push(messageId);
        }
      }

      if (deletedIds.length > 0) {
        const eventPayload = { messageIds: deletedIds, deletedBy: me };
        for (const s of io.sockets.sockets.values()) {
          const uid = String((s as any).data?.userId || '');
          if (uid && recipients.has(uid)) {
            s.emit('messages:deleted', eventPayload);
            for (const messageId of deletedIds) {
              s.emit('message:deleted', { messageId, deletedBy: me });
            }
          }
        }
      }

      return ack?.({ ok: deletedIds.length > 0, deletedIds, failedIds });
    } catch (e: any) {
      console.error('[messages:delete] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error', deletedIds: [], failedIds: [] });
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
      let updated = false;

      const doc = await FriendshipMessageItem.findOne({ id: messageId }).select('from type friendshipId').lean();
      if (doc) {
        if ((doc as any).type !== 'text') return ack?.({ ok: false, error: 'not_found_or_forbidden' });
        if (String((doc as any).from) !== me) return ack?.({ ok: false, error: 'not_found_or_forbidden' });
        await FriendshipMessageItem.updateOne({ id: messageId }, { $set: { text } }).exec();
        const fr = await FriendshipMessages.findById((doc as any).friendshipId).select('user1 user2').lean();
        if (fr) {
          u1 = String((fr as any).user1);
          u2 = String((fr as any).user2);
        }
        await FriendshipMessages.updateOne(
          { _id: (doc as any).friendshipId, 'textMessages.id': messageId },
          { $set: { 'textMessages.$.text': text, lastActivity: new Date() } }
        ).exec();
        updated = true;
      } else {
        const list = await FriendshipMessages.find({
          $and: [
            { $or: [{ user1: me }, { user2: me }] },
            { 'textMessages.id': messageId },
          ],
        }).lean();
        const fd = list.find((f: any) => (f.textMessages || []).some((m: any) => m.id === messageId && String(m.from) === me));
        if (fd) {
          u1 = String((fd as any).user1);
          u2 = String((fd as any).user2);
          await FriendshipMessages.updateOne(
            { _id: (fd as any)._id, 'textMessages.id': messageId },
            { $set: { 'textMessages.$.text': text, lastActivity: new Date() } }
          ).exec();
          updated = true;
        }
      }

      if (!updated) return ack?.({ ok: false, error: 'not_found_or_forbidden' });

      const payloadOut = { messageId, text };
      if (u1 || u2) {
        for (const s of io.sockets.sockets.values()) {
          const uid = (s as any).data?.userId;
          if (uid && (uid === u1 || uid === u2)) s.emit('message:edited', payloadOut);
        }
      }
      return ack?.({ ok: true, messageId, text });
    } catch (e: any) {
      console.error('[message:edit] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });
}

