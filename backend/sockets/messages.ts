// backend/sockets/messages.ts
import { Server, Socket } from 'socket.io';
import mongoose from 'mongoose';
import User from '../models/User';
import Message from '../models/Message';
import { areFriendsCached } from '../utils/friendshipUtils';

const isOid = (s?: string) => !!s && mongoose.Types.ObjectId.isValid(String(s));

// Простое хранение непрочитанных сообщений в памяти
const unreadMessages = new Map<string, Array<{ id: string; from: string; timestamp: string }>>();

// Очередь сообщений для офлайн пользователей
const offlineMessageQueue = new Map<string, Array<any>>();

// Очередь уведомлений об очистке чата для офлайн пользователей
const offlineChatClearedQueue = new Map<string, Array<any>>();

// Получить количество непрочитанных сообщений для пользователя
function getUnreadCount(userId: string, fromUser: string): number {
  const userUnreads = unreadMessages.get(userId) || [];
  return userUnreads.filter(msg => msg.from === fromUser).length;
}

// Добавить непрочитанное сообщение
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

// Отметить сообщения как прочитанные
function markMessagesAsRead(userId: string, fromUser: string) {
  const userUnreads = unreadMessages.get(userId) || [];
  const filtered = userUnreads.filter(msg => msg.from !== fromUser);
  unreadMessages.set(userId, filtered);
}

// Добавить сообщение в очередь для офлайн пользователя
function addToOfflineQueue(userId: string, message: any) {
  if (!offlineMessageQueue.has(userId)) {
    offlineMessageQueue.set(userId, []);
  }
  offlineMessageQueue.get(userId)!.push(message);
}

// Получить и очистить очередь сообщений для пользователя
export function getAndClearOfflineQueue(userId: string): any[] {
  const messages = offlineMessageQueue.get(userId) || [];
  offlineMessageQueue.delete(userId);
  return messages;
}

// Добавить уведомление об очистке чата в очередь для офлайн пользователя
function addToOfflineChatClearedQueue(userId: string, data: any) {
  if (!offlineChatClearedQueue.has(userId)) {
    offlineChatClearedQueue.set(userId, []);
  }
  offlineChatClearedQueue.get(userId)!.push(data);
}

// Получить и очистить очередь уведомлений об очистке чата для пользователя
export function getAndClearOfflineChatClearedQueue(userId: string): any[] {
  const notifications = offlineChatClearedQueue.get(userId) || [];
  offlineChatClearedQueue.delete(userId);
  return notifications;
}

// Очистить сообщения между двумя пользователями
export async function clearChatMessages(userId1: string, userId2: string, forAll: boolean = true): Promise<boolean> {
  try {
    let result;
    if (forAll) {
      // Удаляем все сообщения между пользователями (для обоих)
      result = await Message.deleteMany({
        $or: [
          { from: new mongoose.Types.ObjectId(userId1), to: new mongoose.Types.ObjectId(userId2) },
          { from: new mongoose.Types.ObjectId(userId2), to: new mongoose.Types.ObjectId(userId1) }
        ]
      });
    } else {
      // Удаляем только сообщения, где userId1 является отправителем (только для себя)
      result = await Message.deleteMany({
        from: new mongoose.Types.ObjectId(userId1),
        to: new mongoose.Types.ObjectId(userId2)
      });
    }
    
    return result.deletedCount > 0;
  } catch (error) {
    console.error('[clearChatMessages] error:', error);
    return false;
  }
}

// Удалить одно сообщение
export async function deleteMessage(messageId: string, userId: string): Promise<boolean> {
  try {
    const result = await Message.deleteOne({
      clientId: messageId,
      from: new mongoose.Types.ObjectId(userId)
    });

    return result.deletedCount > 0;
  } catch (error) {
    console.error('[deleteMessage] error:', error);
    return false;
  }
}

// Загрузить сообщения из базы данных для пользователя
export async function loadMessagesFromDB(userId: string, fromUserId: string, limit: number = 50): Promise<any[]> {
  try {
    const messages = await Message.find({
      $or: [
        { from: new mongoose.Types.ObjectId(userId), to: new mongoose.Types.ObjectId(fromUserId) },
        { from: new mongoose.Types.ObjectId(fromUserId), to: new mongoose.Types.ObjectId(userId) }
      ]
    })
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();

    return messages.map(msg => ({
      id: msg.clientId || msg._id.toString(),
      from: msg.from.toString(),
      to: msg.to.toString(),
      type: msg.type,
      text: msg.text,
      uri: msg.uri,
      name: msg.name,
      size: msg.size,
      timestamp: msg.timestamp.toISOString(),
      read: msg.read,
    }));
  } catch (error) {
    console.error('[loadMessagesFromDB] error:', error);
    return [];
  }
}

export default function registerMessageSockets(io: Server) {
  io.on('connection', (sock) => {
    const meId = () => String((sock as any).data?.userId || '');

    // Офлайн сообщения доставляются в identity.ts после установки userId

    /** ===== Отправка сообщения другу ===== */
    sock.on('message:send', async (payload: { 
      to: string; 
      text?: string; 
      type: 'text' | 'image' | 'video' | 'document';
      uri?: string;
      name?: string;
      size?: number;
    }, ack?: Function) => {
      try {
        const me = meId();

        if (!isOid(me)) {
          return ack?.({ ok: false, error: 'unauthorized' });
        }
        if (!isOid(payload.to)) {
          return ack?.({ ok: false, error: 'invalid_to' });
        }

        // Проверяем дружбу с оптимизацией
        const isFriend = await areFriendsCached(me, payload.to);

        if (!isFriend) {
          return ack?.({ ok: false, error: 'not_friends' });
        }

        // Простой ID сообщения (как в старой версии)
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Сохраняем сообщение в базу данных
        const messageDoc = await Message.create({
          clientId: messageId,
          from: new mongoose.Types.ObjectId(me),
          to: new mongoose.Types.ObjectId(payload.to),
          type: payload.type,
          text: payload.type === 'text' ? (payload.text || '') : '',
          uri: payload.uri || '',
          name: payload.name || '',
          size: payload.size || 0,
          timestamp: new Date(),
          read: false,
        });

        const message = {
          id: messageId,
          from: me,
          to: payload.to,
          type: payload.type,
          text: payload.type === 'text' ? (payload.text || '') : '',
          uri: payload.uri,
          name: payload.name,
          size: payload.size,
          timestamp: new Date().toISOString(),
          read: false,
        };

        // Добавляем в счетчик непрочитанных
        addUnreadMessage(payload.to, messageId, me);

        // Отправляем получателю (НЕ отправителю!)
        let delivered = false;

        // Сначала пробуем отправить через room (более надежно)
        try {
          const recipientRoom = `u:${payload.to}`;
          io.to(recipientRoom).emit('message:received', message);

          // Проверяем, есть ли кто-то в этой комнате
          const roomSockets = await io.in(recipientRoom).fetchSockets();
          if (roomSockets.length > 0) {
            delivered = true;
          } else {}
        } catch (error) {
          console.warn(`⚠️ Failed to send via room, falling back to direct search:`, error);
        }

        // Fallback: прямой поиск по всем сокетам
        if (!delivered) {
          for (const s of io.sockets.sockets.values()) {
            const socketUserId = String((s as any).data?.userId);

            if (socketUserId === String(payload.to)) {
              (s as any).emit('message:received', message);
              delivered = true;
              break; // Найден получатель, выходим из цикла
            }
          }
        }

        if (!delivered) {
          addToOfflineQueue(payload.to, message);
        } else {}

        return ack?.({ ok: true, messageId, message, delivered });
      } catch (e: any) {
        console.error('[message:send] error:', e?.message || e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });

    /** ===== Очистка переписки ===== */
    sock.on('message:clear_chat', async (payload: { with: string; forAll?: boolean }, ack?: Function) => {
      try {
        const me = meId();
        const withUser = payload.with;

        if (!isOid(me)) {
          return ack?.({ ok: false, error: 'unauthorized' });
        }
        if (!isOid(withUser)) {
          return ack?.({ ok: false, error: 'invalid_user' });
        }

        // Проверяем дружбу с оптимизацией
        const isFriend = await areFriendsCached(me, withUser);

        if (!isFriend) {
          return ack?.({ ok: false, error: 'not_friends' });
        }

        // Очищаем сообщения в MongoDB
        const forAll = payload.forAll || false;
        const success = await clearChatMessages(me, withUser, forAll);

        if (success) {
          if (forAll) {
            // Уведомляем ОБОИХ пользователей об очистке чата
            const notificationData = { by: me, with: withUser, forAll: true };

            // 1. Уведомляем инициатора очистки (me) через комнату
            try {
              const initiatorRoom = `u:${me}`;
              io.to(initiatorRoom).emit('message:chat_cleared', notificationData);

              // Проверяем, есть ли кто-то в комнате инициатора
              const initiatorSockets = await io.in(initiatorRoom).fetchSockets();
              if (initiatorSockets.length === 0) {
                addToOfflineChatClearedQueue(me, notificationData);
              } else {}
            } catch (error) {
              console.warn(`⚠️ Failed to send to initiator room, using fallback:`, error);
              addToOfflineChatClearedQueue(me, notificationData);
            }

            // 2. Уведомляем получателя (withUser) через комнату
            try {
              const recipientRoom = `u:${withUser}`;
              io.to(recipientRoom).emit('message:chat_cleared', notificationData);

              // Проверяем, есть ли кто-то в комнате получателя
              const recipientSockets = await io.in(recipientRoom).fetchSockets();
              if (recipientSockets.length === 0) {
                addToOfflineChatClearedQueue(withUser, notificationData);
              } else {}
            } catch (error) {
              console.warn(`⚠️ Failed to send to recipient room, using fallback:`, error);
              addToOfflineChatClearedQueue(withUser, notificationData);
            }
          } else {
            // Уведомляем только инициатора об очистке чата
            const notificationData = { by: me, with: withUser, forAll: false };

            try {
              const initiatorRoom = `u:${me}`;
              io.to(initiatorRoom).emit('message:chat_cleared', notificationData);

              // Проверяем, есть ли кто-то в комнате инициатора
              const initiatorSockets = await io.in(initiatorRoom).fetchSockets();
              if (initiatorSockets.length === 0) {
                addToOfflineChatClearedQueue(me, notificationData);
              } else {}
            } catch (error) {
              console.warn(`⚠️ Failed to send to initiator room, using fallback:`, error);
              addToOfflineChatClearedQueue(me, notificationData);
            }
          }
        }

        return ack?.({ ok: success });
      } catch (e: any) {
        console.error('[message:clear_chat] error:', e?.message || e);
        return ack?.({ ok: false, error: e?.message || 'unknown' });
      }
    });

    /** ===== Удаление одного сообщения ===== */
    sock.on('message:delete', async (payload: { messageId: string }, ack?: Function) => {
      try {
        const me = meId();
        const messageId = payload.messageId;

        if (!isOid(me)) {
          return ack?.({ ok: false, error: 'unauthorized' });
        }
        if (!messageId) {
          return ack?.({ ok: false, error: 'invalid_message_id' });
        }

        // Удаляем сообщение из MongoDB
        const success = await deleteMessage(messageId, me);

        if (success) {
          // Уведомляем другого пользователя об удалении
          const message = await Message.findOne({ clientId: messageId }).lean();
          if (message) {
            const recipientId = String(message.to);
            for (const s of io.sockets.sockets.values()) {
              const socketUserId = String((s as any).data?.userId);
              if (socketUserId === recipientId) {
                (s as any).emit('message:deleted', { messageId, deletedBy: me });
              }
            }
          }
        }

        return ack?.({ ok: success });
      } catch (e: any) {
        console.error('[message:delete] error:', e?.message || e);
        return ack?.({ ok: false, error: e?.message || 'unknown' });
      }
    });

    /** ===== Отметка сообщения как прочитанного ===== */
    sock.on('message:read', async (payload: { 
      messageId: string; 
      from: string;
    }, ack?: Function) => {
      try {
        const me = meId();
        if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });

        // Отмечаем сообщения от этого пользователя как прочитанные (только в памяти)
        markMessagesAsRead(me, payload.from);

        // Уведомляем отправителя о прочтении
        for (const s of io.sockets.sockets.values()) {
          if (String((s as any).data?.userId) === String(payload.from)) {
            (s as any).emit('message:read_receipt', {
              messageId: payload.messageId,
              readBy: me,
              timestamp: new Date().toISOString(),
            });
          }
        }

        return ack?.({ ok: true });
      } catch (e: any) {
        console.error('[message:read] error:', e?.message || e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });

    /** ===== Получить количество непрочитанных сообщений ===== */
    sock.on('message:unread_count', async (payload: { from: string }, ack?: Function) => {
      try {
        const me = meId();
        if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });

        const count = getUnreadCount(me, payload.from);
        return ack?.({ ok: true, count });
      } catch (e: any) {
        console.error('[message:unread_count] error:', e?.message || e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });

    /** ===== Загрузить сообщения из базы данных ===== */
    sock.on('message:load', async (payload: { from: string; limit?: number }, ack?: Function) => {
      try {
        const me = meId();
        if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
        if (!isOid(payload.from)) return ack?.({ ok: false, error: 'invalid_from' });

        const messages = await loadMessagesFromDB(me, payload.from, payload.limit || 50);

        return ack?.({ ok: true, messages });
      } catch (e: any) {
        console.error('[message:load] error:', e?.message || e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });
  });
}
