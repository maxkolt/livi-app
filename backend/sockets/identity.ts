// sockets/identity.ts
import { Server } from 'socket.io';
import mongoose, { ClientSession, Types } from 'mongoose';
import User from '../models/User';
import Message from '../models/Message';
import OfflineMessage from '../models/OfflineMessage';
import FriendshipMessages from '../models/FriendshipMessages';
import Install from '../models/Install';
import MissedCall from '../models/MissedCall';
// Cloudinary удален, используем только MongoDB
import { getAndClearOfflineMessages, getAndClearOfflineChatClearedQueue } from './messagesReliable';

type AttachPayload = {
  installId?: string | null;
  profile?: { nick?: string; avatar?: string } | null;
};

/** ===== presence helpers ===== */
function getOnlineList(io: Server): string[] {
  const set = new Set<string>();
  for (const s of io.sockets.sockets.values()) {
    const uid = (s as any)?.data?.userId;
    if (uid) set.add(String(uid));
  }
  return Array.from(set);
}
export async function bindUser(io: Server, sock: any, userId: string) {
  // Проверяем, не подключен ли уже этот пользователь
  const existingSocket = Array.from(io.sockets.sockets.values())
    .find(s => (s as any)?.data?.userId === userId && s.id !== sock.id);

  if (existingSocket) {
    console.warn(`[user] duplicate connection ${userId} old=${existingSocket.id} -> disconnect`);
    existingSocket.disconnect(true);
  }

  sock.data.userId = String(userId);

  // Присоединяем к комнате пользователя
  try { 
    sock.join(`u:${userId}`); 
    // room join ok
  } catch (error) {
    console.error(`❌ Failed to join room u:${userId}:`, error);
  }

  const list = getOnlineList(io);
  io.emit('presence_update', list);
  io.emit('presence:update', list);

  // Доставляем офлайн сообщения после установки userId
  const offlineMessages = await getAndClearOfflineMessages(userId);
  if (offlineMessages.length) {}

  if (offlineMessages.length > 0) {
    offlineMessages.forEach((message) => {
      sock.emit('message:received', message);
    });
    
    // delivered
  } else {
    // no offline
  }

  // Доставляем офлайн уведомления об очистке чата
  const offlineChatClearedNotifications = getAndClearOfflineChatClearedQueue(userId);

  if (offlineChatClearedNotifications.length > 0) {
    offlineChatClearedNotifications.forEach((notification: any) => {
      sock.emit('message:chat_cleared', notification);
    });
    
    // delivered
  } else {
    // none
  }

  // Пропущенные звонки за время офлайна (телефон выключен / нет сети): отдаём при подключении, чтобы при включении телефона всё пришло сразу
  if (mongoose.connection.readyState === 1) {
    try {
      const docs = await MissedCall.find({ calleeId: new mongoose.Types.ObjectId(userId) })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
      const missed = (docs as any[]).map((d) => ({
        from: String(d.callerId),
        fromNick: String(d.callerNick || '').trim(),
      }));
      if (missed.length > 0) {
        sock.emit('missed_calls:sync', { missed });
        await MissedCall.deleteMany({ _id: { $in: docs.map((d: any) => d._id) } });
      }
    } catch (e) {
      console.warn('[identity] bindUser missed_calls sync failed', (e as Error)?.message);
    }
  }
}

/** Сообщаем друзьям, что профиль userId поменялся */
export async function broadcastProfileToFriends(io: Server, userId: string) {
  // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
  if (mongoose.connection.readyState !== 1) {
    return; // Если БД недоступна, просто выходим
  }
  const u = await User.findById(userId).select('nick avatar avatarVer avatarThumbB64 friends').lean();
  if (!u) return;
  
  // Теперь avatar - просто маркер, avatarVer - версия для кеша
  const rawAvatar = String((u as any)?.avatar || '');
  const avatarVer = (u as any)?.avatarVer || 0;
  const avatarThumbB64 = (u as any)?.avatarThumbB64 || '';

  const payload = {
    userId: String(userId),
    nick: String(u.nick || '').trim(),
    avatar: rawAvatar, // маркер наличия
    avatarVer, // версия для инвалидации кеша клиента
    avatarThumbB64, // миниатюра для списков
  };
  const friends = Array.isArray(u.friends) ? (u.friends as any[]) : [];
  for (const fid of friends) {
    try { io.to(`u:${String(fid)}`).emit('friend:profile', payload); } catch {}
  }
}

/** Собираем $set только по реально переданным полям профиля */
function buildSetFromProfile(p?: { nick?: string; avatar?: string }) {
  const safe: any = {};
  if (!p) return safe;

  if ('nick' in p) {
    safe.nick = String(p.nick ?? '').trim(); // '' допустимо — осознанная очистка
  }

  if ('avatar' in p) {
    const raw = String(p.avatar ?? '').trim();
    // разрешаем только https
    if (/^https?:\/\//i.test(raw)) {
      safe.avatar = raw;
    } else if (!raw) {
      safe.avatar = '';
    }
  }

  return safe;
}

// Кэш для предотвращения дублирования запросов
const attachRequestCache = new Map<string, { timestamp: number; promise: Promise<any> }>();

export default function registerIdentitySockets(io: Server) {
  io.on('connection', (sock) => {
    // Обработка отключения пользователя
    sock.on('disconnect', (reason) => {
      const userId = (sock as any).data?.userId;
      if (userId) {
        try { 
          sock.leave(`u:${userId}`); 
          // left room
        } catch (error) {
          console.error(`❌ Failed to leave room u:${userId}:`, error);
        }

        // Обновляем список онлайн пользователей
        const list = getOnlineList(io);
        io.emit('presence_update', list);
        io.emit('presence:update', list);
      }
    });
    /* -------- identity:attach --------
       Привязка installId -> user + "мягкое" обновление профиля.
       ВАЖНО: апдейтим ТОЛЬКО поля, которые пришли в payload.profile. */
    sock.on('identity:attach', async (payload: AttachPayload, ack?: Function) => {
      const installId = String(payload?.installId || '').trim();
      const cacheKey = `${installId}_${sock.id}`;
      
      try {
        if (!installId) return ack?.({ ok: false, error: 'no_installId' });

        // Защита от дублирования запросов
        const now = Date.now();
        const cached = attachRequestCache.get(cacheKey);

        if (cached && (now - cached.timestamp) < 2000) { // 2 секунды защиты
          console.warn(`[identity] attach duplicate blocked install=${installId}`);
          return ack?.({ ok: false, error: 'duplicate_request' });
        }

        // Сохраняем запрос в кэш
        attachRequestCache.set(cacheKey, { timestamp: now, promise: Promise.resolve() });

        // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
        // readyState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
        if (mongoose.connection.readyState !== 1) {
          console.error(`[identity] MongoDB not ready (state: ${mongoose.connection.readyState}), cannot process identity:attach`);
          ack?.({ ok: false, error: 'database_unavailable' });
          setTimeout(() => attachRequestCache.delete(cacheKey), 1000);
          return;
        }

        // 1) install уже существует -> пользователь есть/нет
        // КРИТИЧНО: Проверка готовности уже выполнена выше, но проверяем еще раз для безопасности
        if (mongoose.connection.readyState !== 1) {
          console.error(`[identity] MongoDB not ready (state: ${mongoose.connection.readyState}) during Install.findOne`);
          ack?.({ ok: false, error: 'database_unavailable' });
          setTimeout(() => attachRequestCache.delete(cacheKey), 1000);
          return;
        }
        const inst = await Install.findOne({ installId }).lean();
        if (inst) {
          const userId = String((inst as any).user);
          console.log(`[identity] Install found for ${installId}, checking user: ${userId}`);
          // КРИТИЧНО: Проверяем готовность перед User.exists
          if (mongoose.connection.readyState !== 1) {
            console.error(`[identity] MongoDB not ready (state: ${mongoose.connection.readyState}) during User.exists`);
            ack?.({ ok: false, error: 'database_unavailable' });
            setTimeout(() => attachRequestCache.delete(cacheKey), 1000);
            return;
          }
          const exists = await User.exists({ _id: userId });

          if (!exists) {
            // Пользователь был удалён - создаём НОВОГО пользователя и обновляем привязку installId -> user.
            // ВАЖНО: нельзя "воскрешать" удалённый userId, иначе клиент будет зацикливаться на user_not_found.
            const newUserId = new Types.ObjectId();

            console.log(`[identity] User ${userId} not found, creating new user and rebinding install...`, {
              oldUserId: userId,
              newUserId: String(newUserId),
              installId,
            });
            
            // КРИТИЧНО: Проверяем готовность MongoDB перед User.create
            if (mongoose.connection.readyState !== 1) {
              console.error(`[identity] MongoDB not ready (state: ${mongoose.connection.readyState}) during User.create`);
              ack?.({ ok: false, error: 'database_unavailable' });
              setTimeout(() => attachRequestCache.delete(cacheKey), 1000);
              return;
            }
            
            const newUser = await User.create({
              _id: newUserId,
              nick: '', // ВСЕГДА пустой для нового пользователя
              avatar: '', // ВСЕГДА пустой для нового пользователя
              friends: [],
            });
            // Обновляем привязку installId -> newUserId
            try {
              await Install.updateOne({ installId }, { $set: { user: newUserId } }).exec();
            } catch (e) {
              console.warn('[identity] Failed to rebind install to new userId', e as any);
            }

            console.log(`[identity] ✅ User created (recovered): ${String(newUserId)}`, {
              _id: String(newUser._id),
              nick: newUser.nick,
              friendsCount: newUser.friends?.length || 0,
              dbName: mongoose.connection.db?.databaseName
            });
            // Переопределяем userId для bindUser/ack
            const reboundUserId = String(newUserId);
            await bindUser(io, sock, reboundUserId);
            ack?.({ ok: true, userId: reboundUserId });

            // Очищаем кэш
            setTimeout(() => attachRequestCache.delete(cacheKey), 1000);
            return;
          } else {
            console.log(`[identity] User ${userId} already exists, skipping creation`);
            // Пользователь существует - можно обновлять профиль
            // КРИТИЧНО: Проверяем готовность MongoDB перед User.updateOne
            if (mongoose.connection.readyState === 1) {
              const $set = buildSetFromProfile(payload?.profile || undefined);
              if (Object.keys($set).length) {
                await User.updateOne({ _id: userId }, { $set });
                await broadcastProfileToFriends(io, userId);
              }
            } else {
              console.warn(`[identity] MongoDB not ready (state: ${mongoose.connection.readyState}), skipping profile update`);
            }
          }

          await bindUser(io, sock, userId);
          ack?.({ ok: true, userId });

          // Очищаем кэш
          setTimeout(() => attachRequestCache.delete(cacheKey), 1000);
          return;
        }

        // 2) install нет — создаём user + install атомарно
        // ВАЖНО: создаём ПУСТОГО пользователя, игнорируем входящий profile
        // Это предотвращает "воскрешение" удалённых данных из черновика
        const newUserId = new Types.ObjectId();
        const incomingProfile = payload?.profile || {};
        const hasIncomingData = !!(incomingProfile.nick || incomingProfile.avatar);

        console.log(`[identity] Creating new user for installId: ${installId}, newUserId: ${newUserId}`);

        // КРИТИЧНО: Проверяем готовность MongoDB перед созданием пользователя
        if (mongoose.connection.readyState !== 1) {
          console.error(`[identity] MongoDB not ready (state: ${mongoose.connection.readyState}) during user creation`);
          ack?.({ ok: false, error: 'database_unavailable' });
          setTimeout(() => attachRequestCache.delete(cacheKey), 1000);
          return;
        }

        let session: ClientSession | null = null;
        try { session = await mongoose.startSession(); } catch {}

        const work = async (s?: ClientSession) => {
          // КРИТИЧНО: Проверяем готовность MongoDB внутри work функции
          if (mongoose.connection.readyState !== 1) {
            throw new Error('database_unavailable');
          }
          const opt = s ? { session: s } : undefined;
          const [newUser] = await User.create(
            [{
              _id: newUserId,
              nick: '', // ВСЕГДА пустой для нового пользователя
              avatar: '', // ВСЕГДА пустой для нового пользователя
              friends: [],
            }],
            opt as any
          );
          const [newInstall] = await Install.create([{ installId, user: newUserId }], opt as any);
          console.log(`[identity] ✅ User created (new): ${newUserId}`, {
            _id: String(newUser._id),
            nick: newUser.nick,
            friendsCount: newUser.friends?.length || 0,
            installId: newInstall.installId,
            dbName: mongoose.connection.db?.databaseName,
            collection: 'users'
          });
          
          // Дополнительная проверка - считаем пользователей после создания
          const totalUsers = await User.countDocuments();
          console.log(`[identity] 📊 Total users in database after creation: ${totalUsers}`);
        };

        if (session) {
          await session.withTransaction(async () => { await work(session!); });
          await session.endSession();
        } else {
          try { await work(); }
          catch (e) {
            try { await Install.deleteOne({ installId }); } catch {}
            try { await User.deleteOne({ _id: newUserId }); } catch {}
            throw e;
          }
        }

        await bindUser(io, sock, String(newUserId));
        ack?.({ ok: true, userId: String(newUserId) });

        // Очищаем кэш
        setTimeout(() => attachRequestCache.delete(cacheKey), 1000);
        return;
      } catch (e: any) {
        console.error(`[identity] ❌ attach error:`, {
          error: e?.message || String(e),
          stack: e?.stack?.substring(0, 500),
          installId,
          socketId: sock.id
        });
        ack?.({ ok: false, error: e?.message || 'server_error' });
        // Очищаем кэш при ошибке
        setTimeout(() => attachRequestCache.delete(cacheKey), 1000);
      }
    });

    /* -------- user:exists --------
       Проверка существования пользователя в MongoDB. */
    sock.on('user:exists', async ({ userId }: { userId?: string }, ack?: Function) => {
      try {
        const id = String(userId || '').trim();
        if (!id) return ack?.({ ok: false, error: 'no_userId' });

        // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
        if (mongoose.connection.readyState !== 1) {
          // Если БД недоступна — НЕ говорим "exists=false", иначе клиент будет делать hard reset по ложному отрицанию.
          return ack?.({ ok: false, error: 'database_unavailable' });
        }

        const exists = await User.exists({ _id: id });
        ack?.({ ok: true, exists: !!exists });
      } catch (e: any) {
        ack?.({ ok: false, error: e?.message || 'server_error' });
      }
    });

    /* -------- identity:wipeMe --------
       Полное удаление аккаунта по installId (+чистка дружб/заявок). */
    sock.on('identity:wipeMe', async ({ installId }: { installId?: string }, ack?: Function) => {
      let session: ClientSession | null = null;
      try {
        const id = String(installId || '').trim();
        if (!id) return ack?.({ ok: false, error: 'no_installId' });

        // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
        if (mongoose.connection.readyState !== 1) {
          return ack?.({ ok: false, error: 'database_unavailable' });
        }

        const inst = await Install.findOne({ installId: id }).lean();
        const userId = inst && (inst as any).user ? String((inst as any).user) : '';
        if (!userId) return ack?.({ ok: false, error: 'not_found' });

        try { session = await mongoose.startSession(); } catch {}

        const work = async (s?: ClientSession) => {
          const opt = s ? { session: s } : undefined;
          
          // FriendRequest больше не используется - удаляем только из друзей
          await User.updateMany(
            { friends: userId },
            { $pull: { friends: userId } },
            opt as any
          );
          // 1) Разрываем дружбы у других
          await User.updateMany(
            { friends: userId },
            { $pull: { friends: userId } },
            opt as any,
          );

          // 2) Удаляем входящие заявки у других
          await User.updateMany(
            { friendRequests: userId },
            { $pull: { friendRequests: userId } },
            opt as any,
          );

          // 3) Чистим сообщения (две модели + офлайн)
          await Message.deleteMany({ $or: [{ from: userId }, { to: userId }] }, opt as any);
          await OfflineMessage.deleteMany({ $or: [{ senderId: userId }, { recipientId: userId }] }, opt as any);
          await FriendshipMessages.deleteMany({ $or: [{ user1: userId }, { user2: userId }] }, opt as any);

          // 4) Очищаем данные пользователя вместо удаления
          await User.updateOne(
            { _id: userId }, 
            { 
              $set: { 
                nick: '', 
                avatar: '', 
                avatarB64: '', 
                avatarThumbB64: '', 
                avatarVer: 0,
                friends: [],
                friendRequests: []
              } 
            }, 
            opt as any
          );
          
          // Удаляем только инсталлы (пользователь остается с тем же ID)
          await Install.deleteMany({ user: userId }, opt as any);
        };

        if (session) {
          await session.withTransaction(async () => { await work(session!); });
          await session.endSession();
        } else {
          await work();
        }

        // отвязываем сокет и обновляем presence
        (sock as any).data.userId = undefined;
        try { sock.leave(`u:${userId}`); } catch {}
        const list = getOnlineList(io);
        io.emit('presence_update', list);
        io.emit('presence:update', list);

        ack?.({ ok: true });
      } catch (e: any) {
        try { session?.endSession(); } catch {}
        ack?.({ ok: false, error: e?.message || 'server_error' });
      }
    });
  });
}
