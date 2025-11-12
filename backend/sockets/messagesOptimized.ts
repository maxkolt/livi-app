// Оптимизированные обработчики сообщений с новой структурой данных
import { Server, Socket } from 'socket.io';
import mongoose from 'mongoose';
import User from '../models/User';
import FriendshipMessagesModel, { IFriendshipMessages, IMessageItem } from '../models/FriendshipMessages';

// Тип для экземпляра модели с методами (методы добавляются через Schema.methods)
type FriendshipMessages = InstanceType<typeof FriendshipMessagesModel> & {
  getAllMessages(): IMessageItem[];
  getMessagesArray(type: string): IMessageItem[];
  findMessageById(messageId: string): IMessageItem | undefined;
  addMessage(message: IMessageItem): Promise<InstanceType<typeof FriendshipMessagesModel>>;
};
import { areFriendsCached } from '../utils/friendshipUtils';

const isOid = (s?: string) => !!s && mongoose.Types.ObjectId.isValid(String(s));

// Простое хранение непрочитанных сообщений в памяти
const unreadMessages = new Map<string, Array<{ id: string; from: string; timestamp: string }>>();

// Очередь сообщений для офлайн пользователей
const offlineMessageQueue = new Map<string, Array<any>>();

/**
 * Получить и очистить очередь офлайн сообщений для пользователя
 */
export function getAndClearOfflineQueue(userId: string): Array<any> {
  const messages = offlineMessageQueue.get(userId) || [];
  offlineMessageQueue.delete(userId);
  return messages;
}

/**
 * Получить и очистить очередь офлайн уведомлений об очистке чата
 */
export function getAndClearOfflineChatClearedQueue(userId: string): Array<any> {
  // Пока возвращаем пустой массив, так как эта функциональность не реализована
  return [];
}

// Кэш для быстрого доступа к дружбам
const friendshipCache = new Map<string, FriendshipMessages>();

/**
 * Получить или создать документ дружбы
 */
async function getOrCreateFriendship(user1Id: string, user2Id: string): Promise<FriendshipMessages | null> {
  try {
    // Сортируем ID для консистентности
    const [user1, user2] = [user1Id, user2Id].sort();
    const cacheKey = `${user1}_${user2}`;
    
    // Проверяем кэш
    if (friendshipCache.has(cacheKey)) {
      return friendshipCache.get(cacheKey) || null;
    }
    
    // Ищем существующую дружбу
    let friendship = await FriendshipMessagesModel.findOne({
      $or: [
        { user1: user1, user2: user2 },
        { user1: user2, user2: user1 }
      ]
    });
    
    // Если не найдена, создаем новую
    if (!friendship) {
      friendship = new FriendshipMessagesModel({
        user1: new mongoose.Types.ObjectId(user1),
        user2: new mongoose.Types.ObjectId(user2),
        textMessages: [],
        imageMessages: []
      });
      
      await friendship.save();
    }
    
    // Сохраняем в кэш
    friendshipCache.set(cacheKey, friendship as FriendshipMessages);
    
    return friendship as FriendshipMessages;
  } catch (error) {
    console.error('[getOrCreateFriendship] Error:', error);
    return null;
  }
}

/**
 * Добавить сообщение в дружбу
 */
async function addMessageToFriendship(
  friendship: FriendshipMessages,
  message: {
    id: string;
    from: string;
    to: string;
    type: 'text' | 'image';
    text?: string;
    uri?: string;
    timestamp: Date;
    read: boolean;
  }
): Promise<boolean> {
  try {
    // Получаем массив сообщений по типу
    const messageArray = friendship.getMessagesArray(message.type);
    
    // Добавляем сообщение
    messageArray.push({
      id: message.id,
      from: new mongoose.Types.ObjectId(message.from),
      to: new mongoose.Types.ObjectId(message.to),
      type: message.type,
      text: message.text,
      uri: message.uri,
      timestamp: message.timestamp,
      read: message.read
    });
    
    // Обновляем последнее сообщение и активность
    friendship.lastMessage = {
      id: message.id,
      from: new mongoose.Types.ObjectId(message.from),
      to: new mongoose.Types.ObjectId(message.to),
      type: message.type,
      text: message.text,
      uri: message.uri,
      timestamp: message.timestamp,
      read: message.read
    };
    friendship.lastActivity = message.timestamp;
    
    await friendship.save();
    return true;
  } catch (error) {
    console.error('[addMessageToFriendship] Error:', error);
    return false;
  }
}

/**
 * Получить сообщения дружбы
 */
async function getFriendshipMessages(
  user1Id: string,
  user2Id: string,
  limit: number = 50,
  offset: number = 0
): Promise<{ messages: any[]; total: number }> {
  try {
    const friendship = await getOrCreateFriendship(user1Id, user2Id);
    if (!friendship) {
      return { messages: [], total: 0 };
    }
    
    // Получаем все сообщения и сортируем по времени
    const allMessages = friendship.getAllMessages();
    const total = allMessages.length;
    
    // Применяем пагинацию
    const messages = allMessages
      .slice(offset, offset + limit)
      .map((msg: IMessageItem) => ({
        id: msg.id,
        from: msg.from,
        to: msg.to,
        type: msg.type,
        content: msg.type === 'text' ? msg.text : msg.uri,
        timestamp: msg.timestamp,
        read: msg.read
      }));
    
    return { messages, total };
  } catch (error) {
    console.error('[getFriendshipMessages] Error:', error);
    return { messages: [], total: 0 };
  }
}

/**
 * Очистить сообщения дружбы
 */
async function clearFriendshipMessages(user1Id: string, user2Id: string): Promise<boolean> {
  try {
    const friendship = await getOrCreateFriendship(user1Id, user2Id);
    if (!friendship) {
      return false;
    }
    
    // Очищаем все массивы сообщений
    friendship.textMessages = [];
    friendship.imageMessages = [];
    friendship.lastMessage = undefined;
    friendship.lastActivity = new Date();
    
    await friendship.save();
    return true;
  } catch (error) {
    console.error('[clearFriendshipMessages] Error:', error);
    return false;
  }
}

export default function registerMessageSockets(io: Server) {
  // Регистрируем обработчики на существующих сокетах
  io.sockets.sockets.forEach((sock) => {
    registerMessageHandlers(io, sock);
  });

  // Регистрируем обработчики для новых подключений
  io.on('connection', (sock) => {
    registerMessageHandlers(io, sock);
  });
}

function registerMessageHandlers(io: Server, sock: Socket) {
  const meId = () => String((sock as any).data?.userId || '');

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

      // Отправляем сообщение получателю если он онлайн
      const recipientSocket = Array.from(io.sockets.sockets.values())
        .find(s => (s as any).data?.userId === payload.to);

      if (recipientSocket) {
        recipientSocket.emit('message:received', {
          id: messageId,
          from: me,
          to: payload.to,
          type: payload.type,
          text: payload.text,
          uri: payload.uri,
          timestamp: message.timestamp.toISOString(),
          read: false
        });
      } else {
        // Добавляем в очередь офлайн сообщений
        if (!offlineMessageQueue.has(payload.to)) {
          offlineMessageQueue.set(payload.to, []);
        }
        offlineMessageQueue.get(payload.to)!.push({
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
        timestamp: message.timestamp
      });
    } catch (e: any) {
      console.error('[message:send] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Получение сообщений ===== */
  sock.on('message:fetch', async (payload: {
    with: string;
    limit?: number;
    offset?: number;
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

      // Получаем сообщения
      const { messages, total } = await getFriendshipMessages(
        me,
        payload.with,
        payload.limit || 50,
        payload.offset || 0
      );

      ack?.({ 
        ok: true, 
        messages,
        total,
        hasMore: (payload.offset || 0) + messages.length < total
      });
    } catch (e: any) {
      console.error('[message:fetch] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Очистка сообщений ===== */
  sock.on('message:clear', async (payload: {
    with: string;
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

      // Очищаем сообщения
      const success = await clearFriendshipMessages(me, payload.with);
      if (!success) {
        return ack?.({ ok: false, error: 'clear_failed' });
      }

      ack?.({ ok: true });
    } catch (e: any) {
      console.error('[message:clear] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Отметка сообщения как прочитанного ===== */
  sock.on('message:read', async (payload: {
    messageId: string;
    from: string;
  }, ack?: Function) => {
    try {
      const me = meId();

      if (!isOid(me)) {
        return ack?.({ ok: false, error: 'unauthorized' });
      }

      // Получаем документ дружбы
      const friendship = await getOrCreateFriendship(me, payload.from);
      if (!friendship) {
        return ack?.({ ok: false, error: 'friendship_not_found' });
      }

      // Ищем сообщение и отмечаем как прочитанное
      const message = friendship.findMessageById(payload.messageId);
      if (message) {
        message.read = true;
        await friendship.save();
        
        // Отправляем подтверждение прочтения отправителю
        const senderSocket = Array.from(io.sockets.sockets.values())
          .find(s => (s as any).data?.userId === payload.from);
        
        if (senderSocket) {
          senderSocket.emit('message:read_receipt', {
            messageId: payload.messageId,
            readBy: me,
            timestamp: new Date().toISOString()
          });
        }
      }

      ack?.({ ok: true });
    } catch (e: any) {
      console.error('[message:read] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** ===== Получение количества непрочитанных сообщений ===== */
  sock.on('message:unread_count', async (payload: {
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

      // Проверяем дружбу
      const isFriend = await areFriendsCached(me, payload.from);
      if (!isFriend) {
        return ack?.({ ok: false, error: 'not_friends' });
      }

      // Получаем документ дружбы
      const friendship = await getOrCreateFriendship(me, payload.from);
      if (!friendship) {
        return ack?.({ ok: true, count: 0 });
      }

      // Подсчитываем непрочитанные сообщения от этого пользователя
      const allMessages = friendship.getAllMessages();
      const unreadCount = allMessages.filter((msg: IMessageItem) => 
        msg.from.toString() === payload.from && 
        msg.to.toString() === me && 
        !msg.read
      ).length;

      ack?.({ ok: true, count: unreadCount });
    } catch (e: any) {
      console.error('[message:unread_count] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });
}