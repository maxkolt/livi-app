// Надежная система сообщений с персистентным хранением офлайн сообщений
import { Server, Socket } from 'socket.io';
import mongoose from 'mongoose';
import User from '../models/User';
import FriendshipMessages, { IFriendshipMessages } from '../models/FriendshipMessages';
import OfflineMessage from '../models/OfflineMessage';
import { areFriendsCached } from '../utils/friendshipUtils';

const isOid = (s?: string) => !!s && mongoose.Types.ObjectId.isValid(String(s));

// Простое хранение непрочитанных сообщений в памяти (для быстрого доступа)
const unreadMessages = new Map<string, Array<{ id: string; from: string; timestamp: string }>>();

// Кэш для быстрого доступа к дружбам
const friendshipCache = new Map<string, IFriendshipMessages>();

/**
 * Получить или создать документ дружбы
 */
async function getOrCreateFriendship(user1Id: string, user2Id: string): Promise<IFriendshipMessages | null> {
  try {
    // Сортируем ID для консистентности
    const [user1, user2] = [user1Id, user2Id].sort();
    const cacheKey = `${user1}_${user2}`;
    
    // Проверяем кэш
    if (friendshipCache.has(cacheKey)) {
      return friendshipCache.get(cacheKey) || null;
    }
    
    // Ищем существующую дружбу
    let friendship = await FriendshipMessages.findOne({
      $or: [
        { user1: user1, user2: user2 },
        { user1: user2, user2: user1 }
      ]
    });
    
    // Если дружба не найдена, создаем новую
    if (!friendship) {
      friendship = new FriendshipMessages({
        user1: new mongoose.Types.ObjectId(user1),
        user2: new mongoose.Types.ObjectId(user2),
        textMessages: [],
        imageMessages: [],
        lastActivity: new Date()
      });
      await friendship.save();
    }
    
    // Сохраняем в кэш
    friendshipCache.set(cacheKey, friendship);
    return friendship;
  } catch (error) {
    console.error('Error getting/creating friendship:', error);
    return null;
  }
}

/**
 * Добавить сообщение в дружбу
 */
async function addMessageToFriendship(friendship: IFriendshipMessages, message: any): Promise<boolean> {
  try {
    const messageItem = {
      id: message.id,
      from: new mongoose.Types.ObjectId(message.from),
      to: new mongoose.Types.ObjectId(message.to),
      type: message.type,
      text: message.text,
      uri: message.uri,
      timestamp: message.timestamp,
      read: message.read
    };
    
    await (friendship as any).addMessage(messageItem);
    // reduce noise; DB write ok
    // console.log(`[message] persisted ${message.id}`);
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

export default function registerMessageSockets(io: Server) {
  io.on('connection', (sock) => {
    registerMessageHandlers(io, sock);
  });
}

function registerMessageHandlers(io: Server, sock: Socket) {
  const meId = () => String((sock as any).data?.userId || '');

  // per-socket handlers
  // console.log(`[sockets] handlers for ${sock.id} user=${meId()}`);

  /** ===== Отправка сообщения другу ===== */
  sock.on('message:send', async (payload: {
    to: string;
    text?: string;
    type: 'text' | 'image';
    uri?: string;
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
      const message = {
        id: messageId,
        from: me,
        to: payload.to,
        type: payload.type,
        text: payload.text,
        uri: payload.uri,
        timestamp: new Date(),
        read: false
      };

      // Добавляем сообщение в дружбу
      const success = await addMessageToFriendship(friendship, message);
      if (!success) {
        return ack?.({ ok: false, error: 'save_failed' });
      }

      // Добавляем в счетчик непрочитанных
      addUnreadMessage(payload.to, messageId, me);

      // Отправляем сообщение получателю если он онлайн
      const recipientOnline = isUserOnline(io, payload.to);

      if (recipientOnline) {
        const delivered = sendMessageToUser(io, payload.to, {
          id: messageId,
          from: me,
          to: payload.to,
          type: payload.type,
          text: payload.text,
          uri: payload.uri,
          timestamp: message.timestamp.toISOString(),
          read: false
        });
        
        if (delivered) {}
      } else {
        // Сохраняем офлайн сообщение в базу данных
        await saveOfflineMessage(payload.to, {
          id: messageId,
          from: me,
          to: payload.to,
          type: payload.type,
          text: payload.text,
          uri: payload.uri,
          timestamp: message.timestamp.toISOString(),
          read: false
        });
      }

      // Отправляем подтверждение отправителю
      ack?.({ 
        ok: true, 
        messageId,
        timestamp: message.timestamp,
        delivered: recipientOnline
      });
    } catch (e: any) {
      console.error('[message:send] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Получение сообщений ===== */
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

      // Проверяем дружбу
      const isFriend = await areFriendsCached(me, payload.with);
      if (!isFriend) {
        return ack?.({ ok: false, error: 'not_friends' });
      }

      // Получаем дружбу
      const friendship = await getOrCreateFriendship(me, payload.with);
      if (!friendship) {
        return ack?.({ ok: false, error: 'friendship_not_found' });
      }

      // Получаем все сообщения
      const allMessages = (friendship as any).getAllMessages();

      // Применяем пагинацию
      let messages = allMessages;
      if (payload.before) {
        const beforeIndex = messages.findIndex((msg: any) => msg.id === payload.before);
        if (beforeIndex > 0) {
          messages = messages.slice(0, beforeIndex);
        }
      }

      const limit = payload.limit || 50;
      messages = messages.slice(-limit);

      // Форматируем сообщения для отправки
      const formattedMessages = messages.map((msg: any) => ({
        id: msg.id,
        from: msg.from.toString(),
        to: msg.to.toString(),
        type: msg.type,
        text: msg.text,
        uri: msg.uri,
        timestamp: msg.timestamp.toISOString(),
        read: msg.read
      }));

      ack?.({ 
        ok: true, 
        messages: formattedMessages,
        hasMore: allMessages.length > limit
      });
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

      // Отмечаем сообщения как прочитанные
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

      // Ищем дружбу и само сообщение
      const friendship = await getOrCreateFriendship(me, payload.from);
      if (!friendship) {
        return ack?.({ ok: false, error: 'friendship_not_found' });
      }

      const msg = (friendship as any).findMessageById(payload.messageId);
      if (msg && !msg.read) {
        msg.read = true;
        await friendship.save();
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

  /** ===== Удаление одного сообщения (для обоих) ===== */
  sock.on('message:delete', async (payload: { messageId: string }, ack?: Function) => {
    try {
      const me = meId();
      const messageId = String(payload?.messageId || '').trim();
      if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
      if (!messageId) return ack?.({ ok: false, error: 'bad_message_id' });

      // Находим дружбу, в которой есть это сообщение
      // Пробуем обе стороны: найдём все дружбы, где участвует пользователь
      // и проверим наличие сообщения (их обычно немного)
      const candidates: IFriendshipMessages[] = [];
      for (const [key, f] of friendshipCache.entries()) {
        const hasMe = (f.user1?.toString?.() === me) || (f.user2?.toString?.() === me);
        if (hasMe) candidates.push(f);
      }

      let foundFriendship: IFriendshipMessages | null = null;
      for (const f of candidates) {
        if ((f as any).findMessageById(messageId)) { foundFriendship = f; break; }
      }
      // Если в кэше нет — подгружаем из БД по пользователю
      if (!foundFriendship) {
        const list = await FriendshipMessages.find({
          $or: [ { user1: me }, { user2: me } ]
        });
        for (const f of list) {
          if ((f as any).findMessageById(messageId)) { foundFriendship = f; break; }
        }
      }

      if (!foundFriendship) return ack?.({ ok: false, error: 'not_found' });

      // Удаляем запись
      const removed = await (foundFriendship as any).removeMessage(messageId);
      if (!removed) return ack?.({ ok: false, error: 'remove_failed' });

      // Уведомляем обе стороны, если онлайн
      const u1 = foundFriendship.user1.toString();
      const u2 = foundFriendship.user2.toString();
      const recipients = [u1, u2];
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
}

