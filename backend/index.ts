// backend/index.ts
import dotenv from "dotenv";
dotenv.config();

import express from 'express';
import crypto from 'crypto';
import { logger } from './utils/logger';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mongoose from 'mongoose';
import os from 'os';
import path from 'path';
import type { AuthedSocket } from './sockets/types';
import friendsRouter from './routes/friends';
import meRouter from './routes/me';
import appSettingsRouter from './routes/app-settings';
import uploadRouter from './routes/upload';
import livekitRouter from './routes/livekit';
import registerFriendSockets from './sockets/friends';
import registerIdentitySockets, { bindUser as bindUserIdentity } from './sockets/identity';
import registerMessageSockets from './sockets/messagesReliable';
import { socketHandler } from './sockets/handler';
import { bindAvatarSockets } from './sockets/avatar';
import { setIoInstance } from './utils/ioInstance';
import User from './models/User';
import Install from './models/Install';
import createChatRouter from './routes/chat';
import { buildAvatarDataUris } from './utils/avatars';
import { createToken } from './routes/livekit';
import * as queueStore from './utils/queueStore';
import { startQueueCleanup, stopQueueCleanup, tryMatch } from './sockets/match';

// Закрываем Redis соединение при завершении приложения
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing Redis connection');
  stopQueueCleanup();
  await queueStore.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing Redis connection');
  stopQueueCleanup();
  await queueStore.close();
  process.exit(0);
});


/* ========= Типы ========= */
type LeanUser = {
  _id?: any;
  nick?: string;
  avatar?: string;
  friends?: any[];
};

/* ========= ENV ========= */
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const MONGO_URI =
  process.env.MONGO_DB ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  '';

// Stream Chat переменные убраны - больше не используются

if (!MONGO_URI) {
  logger.error('Missing required environment variables: MONGO_URI/DB');
  process.exit(1);
}

// TURN/STUN configuration (for ephemeral credentials)
const TURN_SECRET = process.env.TURN_SECRET || process.env.TURN_SHARED_SECRET || '';
const TURN_HOST = (process.env.TURN_HOST || '89.111.152.241').trim();
const TURN_PORT = Number(process.env.TURN_PORT || 3478);
const STUN_HOST = (process.env.STUN_HOST || TURN_HOST).trim();
const TURN_ENABLE_TCP = String(process.env.TURN_ENABLE_TCP || '1') === '1';
const TURN_TTL_SECONDS = Number(process.env.TURN_TTL || 600); // 10 min default

/* ========= Helpers ========= */
const isOid = (s?: string) => !!s && /^[a-f\d]{24}$/i.test(String(s));
const normalizeAvatar = (s?: string) => {
  const url = String(s || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
};

/* ========= App / HTTP / IO ========= */
const app = express();

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-install-id'],
  })
);

// json/urlencoded парсеры — один раз и до роутеров
app.use(express.json({ limit: '500mb' })); // Увеличиваем лимит для очень больших видео
app.use('/chat', createChatRouter());
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

/** Резолвим userId из заголовков/квери/инсталла */
app.use(async (req, _res, next) => {
  try {
    const hUser = req.header('x-user-id') || undefined;
    const qUser = typeof req.query.userId === 'string' ? (req.query.userId as string) : undefined;

    let uid: string | undefined = [hUser, qUser].find((x): x is string => !!x && isOid(x));

    if (!uid) {
      const inst = req.header('x-install-id') || '';
      if (inst) {
        const rec = (await Install.findOne({ installId: inst }).select('user').lean()) as
          | { user?: any }
          | null;
        if (rec?.user && isOid(String(rec.user))) {
          uid = String(rec.user);
        }
      }
    }

    if (uid) (req as any).userId = uid;
  } catch {}
  next();
});

/* ========= Создаём HTTP + Socket.IO ========= */
const server = http.createServer(app);

const io = new Server(server, {
  path: "/socket.io",
  cors: {
    origin: "*", // для теста
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"], // websocket + polling для надежности
  pingInterval: 25000,
  pingTimeout: 30000,
});

// Сохраняем глобально для использования в роутах
setIoInstance(io);

// Запускаем периодическую очистку устаревших сокетов из очереди матчинга
startQueueCleanup(io);


// пробрасываем io в req ДО подключения роутеров
app.use((req, _res, next) => {
  (req as any).io = io;
  next();
});

// Stream Chat клиент убран - больше не используется

/* ========= Базовые маршруты ========= */
app.get('/', (_req, res) => res.send('🚀 Сервер работает!'));
app.get('/health', (_req, res) => res.json({ ok: true, mongo: mongoose.connection.readyState }));

/* ========= Static files ========= */
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

/* ========= REST API ========= */
app.use('/api', appSettingsRouter);
app.use('/api', meRouter);
app.use('/api', friendsRouter);
app.use('/api', uploadRouter);
app.use('/api', livekitRouter);

// Stream utility убран - больше не используется

app.post('/chat/ensure-dm', async (req, res) => {
  try {
    const meId = String(req.body?.meId ?? '').trim();
    const peerId = String(req.body?.peerId ?? '').trim();
    if (!isOid(meId) || !isOid(peerId)) {
      return res.status(400).json({ ok: false, error: 'bad_ids' });
    }

    const [me, peer] = (await Promise.all([
      User.findById(meId).select('nick avatar friends').lean(),
      User.findById(peerId).select('nick avatar friends').lean(),
    ])) as [LeanUser | null, LeanUser | null];

    if (!me || !peer) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        meExists: !!me,
        peerExists: !!peer,
      });
    }

    const meFriendWithPeer =
      Array.isArray(me.friends) && me.friends.some((x: any) => String(x) === peerId);
    if (!meFriendWithPeer) {
      return res.status(403).json({ ok: false, error: 'not_friends' });
    }

    // Stream Chat синхронизация убрана - больше не используется

    res.json({ ok: true });
  } catch (e: any) {
    logger.error('Chat ensure-dm failed:', e);
    res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

/**
 * Ephemeral TURN credentials (coturn REST API compatible)
 * Requires TURN_SECRET to be configured on this server and in coturn.
 * Returns a short-lived username (timestamp) and HMAC-SHA1 credential.
 */
app.get('/api/turn-credentials', async (_req, res) => {
  try {
    if (!TURN_SECRET) {
      return res.status(503).json({ ok: false, error: 'turn_secret_not_configured' });
    }

    const unixNow = Math.floor(Date.now() / 1000);
    const expiry = unixNow + Math.max(60, Math.min(TURN_TTL_SECONDS, 3600)); // clamp 1..60 min
    const username = String(expiry);
    const hmac = crypto
      .createHmac('sha1', TURN_SECRET)
      .update(username)
      .digest('base64');

    const stunUrl = `stun:${STUN_HOST}:${TURN_PORT}`;
    const turnUdp = `turn:${TURN_HOST}:${TURN_PORT}`;
    const turnTcp = `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`;
    // ОПТИМИЗИРОВАНО: Добавляем TURN TCP/443 для обхода строгих firewall
    const turnTcp443 = `turn:${TURN_HOST}:443?transport=tcp`;

    // ОПТИМИЗИРОВАНО: Приоритет TURN серверам для более быстрого подключения
    // TURN серверы идут ПЕРВЫМИ, так как они обеспечивают надежное соединение
    const iceServers: any[] = [
      // Основной TURN UDP сервер (приоритет #1)
      { urls: turnUdp, username, credential: hmac },
    ];
    
    // TURN TCP для обхода строгих NAT/firewall
    if (TURN_ENABLE_TCP) {
      // TURN TCP на стандартном порту (приоритет #2)
      iceServers.push({ urls: turnTcp, username, credential: hmac });
      // TURN TCP/443 для обхода firewall (приоритет #3)
      iceServers.push({ urls: turnTcp443, username, credential: hmac });
    }
    
    // STUN серверы идут ПОСЛЕ TURN для резервирования
    // Используем только основные STUN серверы для уменьшения времени подключения
    iceServers.push(
      // Основной STUN сервер (наш собственный)
      { urls: stunUrl },
      // Публичные STUN серверы для резервирования (только основные)
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    );

    return res.json({
      ok: true,
      username,
      credential: hmac,
      ttl: expiry - unixNow,
      iceServers,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

app.get('/whoami', async (req, res) => {
  try {
    const installId = String(req.query.installId || '').trim();
    if (!installId) return res.status(400).json({ ok: false, error: 'no_installId' });
    const inst = (await Install.findOne({ installId }).select('user').lean()) as
      | { user?: any }
      | null;
    if (!inst || !inst.user) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    return res.json({ ok: true, userId: String(inst.user) });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

app.get('/me', async (req, res) => {
  try {
    const userId = (req as any).userId;
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const user = await User.findById(userId).select('nick avatar avatarVer friends').lean();
    if (!user) {
      return res.status(404).json({ ok: false, error: 'user_not_found' });
    }

    return res.json({
      ok: true,
      user: {
        id: String(user._id),
        nick: user.nick || '',
        avatar: (user as any).avatar || '',
        avatarVer: (user as any).avatarVer || 0,
        friends: user.friends || [],
      },
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

// Endpoint для проверки существования пользователя
app.get('/api/exists/:userId', async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!userId || !isOid(userId)) {
      return res.status(400).json({ ok: false, error: 'invalid_userId' });
    }

    const exists = await User.exists({ _id: userId });
    return res.json({ ok: true, exists: !!exists });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

/* ========= Mongo ========= */
mongoose
  .connect(MONGO_URI)
  .then(async () => {
    const dbName = mongoose.connection.db?.databaseName;
    logger.info('MongoDB connected successfully', {
      uri: MONGO_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'), // Скрываем пароль
      dbName: dbName,
      readyState: mongoose.connection.readyState,
      host: mongoose.connection.host,
      port: mongoose.connection.port
    });
    
    // Проверяем количество пользователей при старте
    try {
      const User = (await import('./models/User')).default;
      const userCount = await User.countDocuments();
      logger.info(`[MongoDB] Current users count in database "${dbName}": ${userCount}`);
      
      // Также проверяем коллекцию напрямую
      const directCount = await mongoose.connection.db.collection('users').countDocuments();
      logger.info(`[MongoDB] Direct collection count (users): ${directCount}`);
      
      if (userCount === 0 && directCount === 0) {
        logger.warn('[MongoDB] ⚠️  База данных пуста - пользователей нет!');
        logger.warn('[MongoDB] Убедитесь, что используется правильная БД:', dbName);
      }
    } catch (e) {
      logger.warn('[MongoDB] Could not check user count:', e);
    }
  })
  .catch((err) => {
    logger.error('MongoDB connection failed:', {
      error: err?.message || String(err),
      uri: MONGO_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')
    });
    process.exit(1);
  });

/* ========= Presence helpers ========= */
function getOnlineListFromIo(io: Server): string[] {
  const set = new Set<string>();
  for (const s of io.sockets.sockets.values()) {
    const uid = (s as any)?.data?.userId;
    if (uid) set.add(String(uid));
  }
  return Array.from(set);
}
function bindUser(sock: AuthedSocket, userId: string) {
  (sock as any).data.userId = String(userId);
  try {
    sock.join(`u:${String(userId)}`);
  } catch {}
}
function unbindUser(sock: AuthedSocket) {
  const uid = (sock as any)?.data?.userId;
  (sock as any).data.userId = undefined;
  if (uid) {
    try {
      sock.leave(`u:${String(uid)}`);
    } catch {}
  }
}
function emitPresence(io: Server) {
  const list = getOnlineListFromIo(io);
  io.emit('presence_update', list);
  io.emit('presence:update', list);
}

/**
 * Оптимизированная отправка presence:update только друзьям пользователя
 * Вместо отправки всем подключенным (io.emit), отправляем только заинтересованным
 * Это критично для масштабирования: при 100k пользователей вместо 100k отправок - только друзьям (~50)
 */
async function emitPresenceUpdateToFriends(io: Server, userId: string, busy: boolean) {
  try {
    if (!userId) return;
    
    // Получаем список друзей пользователя
    const user = await User.findById(userId).select('friends').lean();
    if (!user || !Array.isArray(user.friends) || user.friends.length === 0) {
      // Если друзей нет, отправляем только самому пользователю (для синхронизации состояния)
      io.to(`u:${userId}`).emit('presence:update', { userId, busy });
      return;
    }
    
    // Отправляем обновление только друзьям через их комнаты
    const friends = user.friends.map(f => String(f));
    for (const friendId of friends) {
      try {
        io.to(`u:${friendId}`).emit('presence:update', { userId, busy });
      } catch {}
    }
    
    // Также отправляем самому пользователю для синхронизации состояния
    io.to(`u:${userId}`).emit('presence:update', { userId, busy });
  } catch (e) {
    // В случае ошибки отправляем только самому пользователю (fallback)
    try {
      io.to(`u:${userId}`).emit('presence:update', { userId, busy });
    } catch {}
  }
}

/* ========= Matching (ГЛОБАЛЬНО) ========= */
// Используем распределенное хранилище через queueStore
const partnerOf = async (id: string) => await queueStore.getPartner(id);
const pair = async (a: string, b: string) => {
  await queueStore.setPair(a, b);
};
const unpair = async (id: string) => {
  return await queueStore.removePair(id);
};

// Очередь ожидания для режима random (start/next/stop) - через queueStore
const removeFromWaitingQueue = async (sid: string) => {
  await queueStore.removeFromQueue(sid);
};
const enqueueWaiting = async (sid: string) => {
  await queueStore.addToQueue(sid);
};
const isConnected = (sid: string) => io.sockets.sockets.has(sid);
const getUserIdBySid = (sid: string): string | undefined => {
  const s = io.sockets.sockets.get(sid) as any;
  const userId = s?.data?.userId ? String(s.data.userId) : undefined;
  return userId;
};

// Пользователь занят рандом-видеочатом (по userId) - через queueStore
const setRandomBusy = async (uid?: string | null, busy?: boolean) => {
  if (!uid) return;
  await queueStore.setBusy(uid, !!busy);
  await emitPresenceUpdateToFriends(io, uid, !!busy);
};

// Отслеживание дружеских комнат (roomId -> participants[])
const friendRooms = new Map<string, string[]>();
const setFriendRoomState = (roomId: string, participants: string[]) => {
  if (participants.length === 0) {
    friendRooms.delete(roomId);
  } else {
    friendRooms.set(roomId, [...participants]);
  }
  
  // Отправляем состояние комнаты всем участникам
  try {
    io.to(roomId).emit('friends:room_state', { roomId, participants });
  } catch {}
  
  // Отправляем обновление статусов всем друзьям участников
  participants.forEach(userId => {
    try {
      io.emit('friends:room_state', { roomId, participants });
    } catch {}
  });
};

// Функция для обновления состояния дружеской комнаты
const updateFriendRoomState = (io: Server, roomId: string) => {
  // Проверяем, что это дружеская комната (не рандом)
  if (!roomId.startsWith('room_')) return;
  
  const room = io.sockets.adapter.rooms.get(roomId);
  if (!room) return;
  
  // Получаем userId всех участников комнаты
  const participants: string[] = [];
  room.forEach(socketId => {
    const socket = io.sockets.sockets.get(socketId) as AuthedSocket;
    if (socket && (socket as any)?.data?.userId) {
      participants.push(String((socket as any).data.userId));
    }
  });
  
  // Отправляем состояние комнаты
  try {
    io.to(roomId).emit('friends:room_state', { roomId, participants });
    
    // Отправляем обновление статусов всем друзьям участников
    participants.forEach(userId => {
      try {
        io.emit('friends:room_state', { roomId, participants });
      } catch {}
    });
  } catch {}
};

// tryPairFor и pairAndNotify удалены - теперь используется единая система матчинга через match.ts
// Все функции матчинга теперь используют tryMatch из match.ts через queueStore

// findRandom/cancelRandom удалены - используется match.ts

/* ========= Direct Calls (P2P invite) ========= */
type CallLink = { a: string; b: string; timer?: NodeJS.Timeout };
const callsById = new Map<string, CallLink>();
const callOfUser = new Map<string, { with: string; callId: string }>();
// Активный callId для конкретного socket.id (после accept)
const activeCallBySocket = new Map<string, string>();
// Пользователь занят рандом-видеочатом (по userId) — используется также для findRandom

function cleanupCall(callId: string, reason?: 'accepted' | 'declined' | 'canceled' | 'timeout') {
  const link = callsById.get(callId);
  if (!link) return;
  if (link.timer) { try { clearTimeout(link.timer); } catch {} }
  callsById.delete(callId);
  callOfUser.delete(link.a);
  callOfUser.delete(link.b);
}

/* ========= Socket.IO ========= */
io.on('connection', async (sock: AuthedSocket) => {
  sock.on('whoami', (payload?: any, ack?: Function) => {
    const id = (sock as any)?.data?.userId || null;

    // Если первый параметр - функция, то это callback
    if (typeof payload === 'function') {
      ack = payload;
      payload = null;
    }

    if (ack) {
      ack({ _id: id });
    } else {
      logger.debug('whoami called without ack function');
    }
  });

  // Обработчик события reauth для мягкой переавторизации
  sock.on('reauth', async (payload: any, ack?: Function) => {
    try {
      const userId = String(payload?.userId || '').trim();
      
      if (!userId || !isOid(userId)) {
        logger.warn('Reauth failed: invalid userId', userId);
        return ack?.({ ok: false, error: 'invalid_userId' });
      }
      
      // Проверяем существует ли пользователь
      const exists = await User.exists({ _id: userId });
      if (!exists) {
        logger.warn('Reauth failed: user not found', userId);
        return ack?.({ ok: false, error: 'user_not_found' });
      }
      
      // Привязываем пользователя к сокету
      bindUserIdentity(io, sock, userId);
      emitPresence(io);
      
      logger.debug('User reauthorized successfully', userId);
      ack?.({ ok: true, userId });
    } catch (e) {
      logger.error('Reauth error:', e);
      ack?.({ ok: false, error: 'server_error' });
    }
  });

  // ВОССТАНАВЛИВАЕМ: привязка по handshake: userId/installId
  const hs: any = sock.handshake || {};
  const rawUserId =
    (typeof hs.auth?.userId === 'string' && hs.auth.userId) ||
    (typeof hs.query?.userId === 'string' && hs.query.userId) ||
    '';
  const rawInstallId =
    (typeof hs.auth?.installId === 'string' && hs.auth.installId) ||
    (typeof hs.query?.installId === 'string' && hs.query.installId) ||
    '';

  let bindUid: string | null = null;
  if (isOid(rawUserId) && (await User.exists({ _id: rawUserId }))) {
    bindUid = String(rawUserId);
  } else if (rawInstallId.trim()) {
    const inst = (await Install.findOne({ installId: rawInstallId.trim() })
      .select('user')
      .lean()) as { user?: any } | null;
    if (inst?.user) {
      bindUid = String(inst.user);
    }
  }
  
  if (bindUid) {
    // Привязываем пользователя к сокету
    bindUserIdentity(io, sock, String(bindUid));
    emitPresence(io);
  }

  // === call:end → транслируем call:ended обоим участникам (УПРОЩЕНО для 1-на-1) ===
  sock.on('call:end', async ({ callId, roomId }: { callId?: string; roomId?: string }) => {
    try {
      logger.debug('📥 [call:end] Received call:end event', {
        socketId: sock.id,
        receivedRoomId: roomId,
        receivedCallId: callId,
        userId: (sock as any)?.data?.userId
      });
      
      // КРИТИЧНО: Приоритетно берем roomId из параметров, затем из сокет-данных, затем из activeCallBySocket, и только потом callId
      const resolvedRoomId = roomId || (sock as any)?.data?.roomId || activeCallBySocket.get(sock.id);
      const id = String(resolvedRoomId || callId || '');
      
      logger.debug('📥 [call:end] Resolved call identifier', {
        finalId: id,
        usedRoomId: !!roomId,
        usedSocketDataRoomId: !!(sock as any)?.data?.roomId && !roomId,
        usedActiveCallBySocket: !!activeCallBySocket.get(sock.id) && !roomId && !(sock as any)?.data?.roomId,
        usedCallId: !!callId && !resolvedRoomId,
        resolvedRoomId: resolvedRoomId || null
      });
      
      if (!id) {
        logger.warn('❌ [call:end] Call end: no callId or roomId provided', {
          socketId: sock.id,
          receivedRoomId: roomId,
          receivedCallId: callId,
          resolvedRoomId: resolvedRoomId || null
        });
        return;
      }
      
      // Получаем участников комнаты
      const room = io.sockets.adapter.rooms.get(id);
      const participantCount = room ? room.size : 0;
      logger.debug('📥 [call:end] Room info', {
        roomId: id,
        participants: participantCount,
        socketIds: room ? Array.from(room) : []
      });
      
      // Снимаем busy со всех участников и очищаем состояние
      if (room) {
        for (const sid of room) {
          const peerSocket = io.sockets.sockets.get(sid);
          if (peerSocket) {
            const peerUserId = (peerSocket as any)?.data?.userId;
            (peerSocket as any).data = (peerSocket as any).data || {};
            
            // КРИТИЧНО: Очищаем все состояние участника звонка
            (peerSocket as any).data.busy = false;
            delete (peerSocket as any).data.roomId;
            delete (peerSocket as any).data.partnerSid;
            delete (peerSocket as any).data.inCall;
            
            logger.debug('📥 [call:end] Cleaning up participant state', {
              socketId: sid,
              userId: peerUserId
            });
            
            // Снимаем presence (только друзьям)
            if (peerUserId) {
              await emitPresenceUpdateToFriends(io, peerUserId, false);
            }
          }
          
          // Очищаем activeCallBySocket
          try { activeCallBySocket.delete(sid); } catch {}
        }
      }
      
      // Отправляем call:ended обоим участникам
      logger.debug('📤 [call:end] Sending call:ended to room', {
        roomId: id,
        participantCount
      });
      
      io.to(id).emit('call:ended', { 
        callId: id, 
        roomId: id,
        reason: 'ended',
        scope: 'all'
      });
      
      logger.debug('✅ [call:end] Call cleanup completed', { 
        callId: id,
        roomId: id,
        participants: participantCount
      });
      
    } catch (e) {
      logger.error('❌ [call:end] Call end handler error:', e);
    }
  });



  /* ---- профиль ---- */
  sock.on('attach_user', async (payload: any, ack?: Function) => {
    const uid = String(payload?.userId || '').trim();

    if (uid && isOid(uid) && (await User.exists({ _id: uid }))) {
      bindUserIdentity(io, sock, uid);
      emitPresence(io);
      return ack?.({ ok: true, userId: uid });
    }
    return ack?.({ ok: false, error: 'not_found' });
  });

  // ВОТ ЗДЕСЬ: читаем профиль (ник + нормализованный https-аватар)
  sock.on('profile:me', async (_: any, ack?: Function) => {
    const me = String((sock as any).data?.userId || '');
    console.log('[profile:me] Request received (index.ts)', { userId: me || 'guest' });
    if (!me) {
      console.log('[profile:me] No userId, returning empty profile for guest');
      return ack?.({ ok: true, profile: {} }); // гость
    }
    const u = (await User.findById(me).select('nick avatar avatarVer avatarB64 avatarThumbB64').lean()) as any;
    const rawAvatar = String(u?.avatar || '');
    const avatarVer = u?.avatarVer || 0;
    const avatarB64 = u?.avatarB64 || '';
    const avatarThumbB64 = u?.avatarThumbB64 || '';
    const profile = u ? { nick: u.nick || '', avatar: rawAvatar, avatarVer, avatarB64, avatarThumbB64 } : {};
    console.log('[profile:me] Profile found (index.ts)', { 
      userId: me, 
      hasUser: !!u, 
      nick: profile.nick || '', 
      hasAvatar: !!(avatarB64 || avatarThumbB64),
      avatarVer 
    });
    ack?.({ ok: true, profile });
  });

  // ВОТ ЗДЕСЬ: обновление профиля (Ник/Аватар)
  // avatar — только https или пустая строка (удаление). file://, ph://, content:// игнорируем.
  sock.on('profile:update', async (patch: any, ack?: Function) => {
    try {
      const me = String((sock as any).data?.userId || '');
      if (!me) {
        if (typeof ack === 'function') ack({ ok: false, error: 'unauthorized' });
        return;
      }

      // текущий документ
      const current = (await User.findById(me)
        .select('nick avatar avatarVer avatarB64 avatarThumbB64 friends')
        .lean()) as any;
      if (!current) {
        if (typeof ack === 'function') ack({ ok: false, error: 'not_found' });
        return;
      }

      const $set: Record<string, any> = {};
      const $inc: Record<string, number> = {};
      let changed = false;

      if (Object.prototype.hasOwnProperty.call(patch, 'nick')) {
        const newNick = String(patch.nick ?? '').trim();
        if (newNick !== (current.nick || '')) {
          $set.nick = newNick;
          changed = true;
        }
      }

      // Обрабатываем только поле avatar
      const avatarField = Object.prototype.hasOwnProperty.call(patch, 'avatar') ? 'avatar' : null;
      
      if (avatarField) {
        const rawIn = (patch as any)[avatarField];
        const raw = typeof rawIn === 'string' ? rawIn.trim() : '';
        const isHttp = /^https?:\/\//i.test(raw);
        const isEmpty = rawIn === '' || rawIn === null;
        const currentAvatar = String(current.avatar || '');
      
        if (isEmpty) {
          // явное удаление аватара
          if (currentAvatar !== '' || current.avatarB64 || current.avatarThumbB64) {
            $set.avatar = '';
            $set.avatarB64 = '';
            $set.avatarThumbB64 = '';
            $inc.avatarVer = 1;
            changed = true;
          }
        } else if (isHttp && raw !== currentAvatar) {
          // новый HTTPS URL - скачиваем и обрабатываем
          try {
            // Скачиваем изображение с таймаутом
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            
            const response = await fetch(raw, { 
              signal: controller.signal,
              headers: { 'User-Agent': 'LiVi-App/1.0' }
            } as any);
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
              throw new Error(`Failed to download avatar: ${response.status}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const base64 = buffer.toString('base64');
            
            // Обрабатываем изображение и создаем миниатюры
            const { fullB64, thumbB64 } = await buildAvatarDataUris(base64);
            
            $set.avatar = raw;
            $set.avatarB64 = fullB64;
            $set.avatarThumbB64 = thumbB64;
            $inc.avatarVer = 1;
            changed = true;
          } catch (downloadError: any) {
            logger.error('Failed to download/process avatar:', { 
              userId: me, 
              url: raw, 
              error: downloadError?.message || downloadError 
            });
            // Если не удалось скачать, все равно сохраняем URL, но не обновляем версию
            // Это позволит пользователю видеть URL, но друзья не получат обновление
            $set.avatar = raw;
            changed = true;
          }
        } else {
          // file://, ph://, content://, data: — игнорируем
        }
      }

      // Обновляем базу данных
      if (Object.keys($set).length > 0 || Object.keys($inc).length > 0) {
        const updateOp: any = {};
        if (Object.keys($set).length > 0) updateOp.$set = $set;
        if (Object.keys($inc).length > 0) updateOp.$inc = $inc;
        await User.updateOne({ _id: me }, updateOp);
      }

      // Получаем свежие данные после обновления
      const fresh = (changed
        ? await User.findById(me).select('nick avatar avatarVer avatarB64 avatarThumbB64 friends').lean()
        : current) as any;

      const rawOut = String(fresh?.avatar || '');
      const avatarVer = fresh?.avatarVer || 0;
      const avatarThumbB64 = fresh?.avatarThumbB64 || '';

      if (typeof ack === 'function') {
        const response = { ok: true, profile: { nick: fresh?.nick || '', avatar: rawOut, avatarVer, avatarThumbB64 } };
        ack(response);
      } else {
        logger.debug('Profile update called without ack function', { socketId: sock.id, userId: me });
      }

      // Отправляем обновление друзьям (при изменении никнейма или аватара)
      if (changed && Array.isArray(fresh?.friends) && (fresh!.friends as any[]).length) {
        for (const fid of fresh!.friends as any[]) {
          try {
            io.to(`u:${String(fid)}`).emit('friend:profile', {
              userId: me,
              nick: fresh?.nick || '',
              avatar: rawOut,
              avatarVer,
              avatarThumbB64,
            });
          } catch {}
        }
      }
    } catch (e: any) {
      logger.error('Profile update error:', { socketId: sock.id, userId: (sock as any).data?.userId, error: e?.message || e });
      if (typeof ack === 'function') {
        ack({ ok: false, error: String(e?.message || e) });
      } else {
        logger.debug('Profile update error without ack function', { socketId: sock.id });
      }
    }
  });

  /* ---- Рандом-матчинг ---- */
  // Обработчики start/next/stop перенесены в match.ts для избежания дублирования
  
  /* ---- WebRTC и Matchmaking через handler ---- */
  socketHandler(io, sock);

  /* ---- Avatar sockets ---- */
  bindAvatarSockets(io, sock);

  // ---- Завершение прямого звонка (форвард по socket.id) ----
  sock.on('hangup', ({ to }: { to?: string }) => {
    const target = String(to || '').trim();
    if (target) {
      try { io.to(target).emit('hangup'); } catch {}
    }
  });

  // findRandom/cancelRandom удалены - используется match.ts

  // ---- Busy relay ----
  sock.on('call:busy', ({ to }: { to?: string }) => {
    const target = String(to || '').trim();
    if (target) {
      try { io.to(target).emit('call:busy', { from: sock.id }); } catch {}
    }
  });

  /* ---- Direct Calls ---- */
  sock.on('call:initiate', async ({ to }: { to?: string }, ack?: Function) => {
    try {
      const me = String((sock as any).data?.userId || '');
      if (!me) return ack?.({ ok: false, error: 'unauthorized' });
      const peerId = String(to || '').trim();
      if (!peerId || !peerId.match(/^[a-f\d]{24}$/i)) return ack?.({ ok: false, error: 'bad_peer' });

      // Проверяем busy флаг инициатора
      const initiatorSocket = io.sockets.sockets.get(sock.id);
      if (initiatorSocket && (initiatorSocket as any)?.data?.busy === true) {
        return ack?.({ ok: false, error: 'initiator_busy' });
      }
      
      // Убрано: проверка randomBusyByUser - рандомный поиск не блокирует звонки другу

      // Уже в звонке?
      if (callOfUser.has(me)) return ack?.({ ok: false, error: 'busy' });
      
      // Найдём любой сокет получателя
      const peerSocket = Array.from(io.sockets.sockets.values()).find((s) => (s as any)?.data?.userId === peerId);
      if (!peerSocket) return ack?.({ ok: false, error: 'peer_offline' });
      
      // Проверяем busy флаг получателя
      if ((peerSocket as any)?.data?.busy === true) {
        try { sock.emit('call:busy', { from: peerId, userId: peerId }); } catch {}
        return ack?.({ ok: false, error: 'peer_busy' });
      }
      
      // Убрано: проверка randomBusyByUser - рандомный поиск не блокирует звонки другу
      
      if (callOfUser.has(peerId)) {
        // Получатель уже в активном звонке
        try { sock.emit('call:busy', { from: peerId, userId: peerId }); } catch {}
        return ack?.({ ok: false, error: 'peer_busy' });
      }

      const callId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      callsById.set(callId, { a: me, b: peerId });
      callOfUser.set(me, { with: peerId, callId });
      callOfUser.set(peerId, { with: me, callId });

      // КРИТИЧНО: Создаем комнату при инициации звонка (инициатором)
      const sorted = [sock.id, peerSocket.id].sort();
      const roomId = `room_${sorted[0]}_${sorted[1]}`;
      
      // Инициатор сразу присоединяется к комнате
      try { 
        sock.join(roomId);
        logger.debug('Initiator joined room', { socketId: sock.id, roomId, callId });
      } catch {}
      
      // КРИТИЧНО: Устанавливаем busy флаг и состояние звонка для ОБОИХ участников при инициации
      // Это гарантирует консистентность состояния, даже если инициатор отключится до принятия
      // Инициатор
      (sock as any).data = (sock as any).data || {};
      (sock as any).data.busy = true;
      (sock as any).data.roomId = roomId;
      (sock as any).data.partnerSid = peerSocket.id;
      
      // КРИТИЧНО: Получатель также должен иметь roomId и partnerSid
      // Это позволяет восстановить состояние звонка, если инициатор отключится
      (peerSocket as any).data = (peerSocket as any).data || {};
      (peerSocket as any).data.busy = true;
      (peerSocket as any).data.roomId = roomId;
      (peerSocket as any).data.partnerSid = sock.id;
      
      // Рассылаем presence:update (только друзьям)
      await emitPresenceUpdateToFriends(io, me, true);
      await emitPresenceUpdateToFriends(io, peerId, true);
      logger.debug('Call initiated', { from: me, to: peerId, callId, roomId });
      
      // КРИТИЧНО: Отправляем инициатору roomId для немедленного использования
      // Включаем from (socket.id получателя) для сохранения partnerSocketId
      try {
        sock.emit('call:room:created', { callId, roomId, partnerId: peerId, from: peerSocket.id });
        logger.debug('Room created event sent to initiator', { socketId: sock.id, roomId, callId, from: peerSocket.id });
      } catch {}

      // таймаут 20с
      const timer = setTimeout(async () => {
        const link = callsById.get(callId);
        if (!link) return;
        
        // Снимаем busy статус с обоих участников при таймауте
        const aSock = Array.from(io.sockets.sockets.values()).find((s) => (s as any)?.data?.userId === link.a);
        const bSock = Array.from(io.sockets.sockets.values()).find((s) => (s as any)?.data?.userId === link.b);
        
        if (aSock) {
          (aSock as any).data = (aSock as any).data || {};
          (aSock as any).data.busy = false;
          await emitPresenceUpdateToFriends(io, link.a, false);
        }
        
        if (bSock) {
          (bSock as any).data = (bSock as any).data || {};
          (bSock as any).data.busy = false;
          await emitPresenceUpdateToFriends(io, link.b, false);
        }
        
        // уведомляем инициатора о таймауте
        try {
          io.to(`u:${link.a}`).emit('call:timeout', { callId });
        } catch {}
        // уведомим получателя, чтобы оба закрыли модалки
        try {
          io.to(`u:${link.b}`).emit('call:timeout', { callId });
        } catch {}
        cleanupCall(callId, 'timeout');
      }, 20000);
      const link = callsById.get(callId);
      if (link) link.timer = timer;

      // отправим входящий вызов получателю (с ником инициатора, если есть)
      try {
        let fromNick: string | undefined;
        try {
          const u = await User.findById(me).select('nick').lean();
          if (u && typeof (u as any).nick === 'string') fromNick = String((u as any).nick).trim() || undefined;
        } catch {}
        
        // КРИТИЧНО: Отправляем call:incoming напрямую на все сокеты получателя для гарантированной доставки
        const recipientSockets = Array.from(io.sockets.sockets.values()).filter((s) => 
          String((s as any)?.data?.userId || '') === String(peerId)
        );
        for (const recipientSocket of recipientSockets) {
          try {
            (recipientSocket as any).emit('call:incoming', { callId, from: me, fromNick });
            // Также отправляем friend:call:incoming для совместимости
            (recipientSocket as any).emit('friend:call:incoming', { callId, from: me, nick: fromNick });
          } catch {}
        }
        
        // Также отправляем через комнаты на случай, если сокеты не найдены напрямую
        io.to(`u:${peerId}`).emit('call:incoming', { callId, from: me, fromNick });
        io.to(`u:${peerId}`).emit('friend:call:incoming', { callId, from: me, nick: fromNick });
      } catch {}

      return ack?.({ ok: true, callId });
    } catch (e: any) {
      return ack?.({ ok: false, error: e?.message || 'server_error' });
    }
  });

  sock.on('call:accept', async ({ callId }: { callId?: string }) => {
    const id = String(callId || '');
    const link = callsById.get(id);
    if (!link) return;
    
    logger.debug('Call accepted', { callId: id });
    
    // Найдём активные сокеты обоих участников
    const aSock = Array.from(io.sockets.sockets.values()).find((s) => (s as any)?.data?.userId === link.a) as AuthedSocket | undefined;
    const bSock = Array.from(io.sockets.sockets.values()).find((s) => (s as any)?.data?.userId === link.b) as AuthedSocket | undefined;
    
    if (aSock && bSock) {
      // КРИТИЧНО: Комната уже создана инициатором при call:initiate
      // Получаем roomId из данных инициатора или создаем по той же логике
      const sorted = [aSock.id, bSock.id].sort();
      const roomId = (aSock as any)?.data?.roomId || (bSock as any)?.data?.roomId || `room_${sorted[0]}_${sorted[1]}`;
      
      // КРИТИЧНО: Принимающий ОБЯЗАТЕЛЬНО присоединяется к комнате
      try { 
        aSock.join(roomId);
        logger.debug('Participant A joined room', { socketId: aSock.id, roomId, callId: id });
      } catch {}
      try { 
        bSock.join(roomId);
        logger.debug('Participant B joined room', { socketId: bSock.id, roomId, callId: id });
      } catch {}
      
      // КРИТИЧНО: Сохраняем roomId в activeCallBySocket, а не callId, чтобы fallback для call:end всегда был корректным именем комнаты
      try { activeCallBySocket.set(aSock.id, roomId); } catch {}
      try { activeCallBySocket.set(bSock.id, roomId); } catch {}
      
      // Устанавливаем busy для обоих
      (aSock as any).data = (aSock as any).data || {};
      (aSock as any).data.busy = true;
      (aSock as any).data.roomId = roomId;
      (aSock as any).data.partnerSid = bSock.id;
      (aSock as any).data.inCall = true;
      
      (bSock as any).data = (bSock as any).data || {};
      (bSock as any).data.busy = true;
      (bSock as any).data.roomId = roomId;
      (bSock as any).data.partnerSid = aSock.id;
      (bSock as any).data.inCall = true;
      
      // Рассылаем presence:update (только друзьям)
      if (link.a) {
        await emitPresenceUpdateToFriends(io, link.a, true);
      }
      if (link.b) {
        await emitPresenceUpdateToFriends(io, link.b, true);
      }
      
      // Создаем LiveKit токены для обоих участников
      let livekitTokenA: string | null = null;
      let livekitTokenB: string | null = null;
      let livekitRoomName: string = roomId;
      
      const livekitIdentityA = link.a || `socket:${aSock.id}`;
      const livekitIdentityB = link.b || `socket:${bSock.id}`;
      
      if (link.a && link.b) {
        const sortedUserIds = [link.a, link.b].sort();
        livekitRoomName = `room_${sortedUserIds[0]}_${sortedUserIds[1]}`;
      }
      
      try {
        const [tokenA, tokenB] = await Promise.all([
          createToken({ identity: livekitIdentityA, roomName: livekitRoomName }),
          createToken({ identity: livekitIdentityB, roomName: livekitRoomName }),
        ]);
        livekitTokenA = tokenA;
        livekitTokenB = tokenB;
        logger.debug('LiveKit tokens created for call:accept', { roomName: livekitRoomName, identityA: livekitIdentityA, identityB: livekitIdentityB });
      } catch (e: any) {
        logger.error('Failed to create LiveKit tokens for call:accept:', e);
      }
      
      // Отправляем call:accepted с LiveKit credentials
      if (aSock) {
        try {
          aSock.emit('call:accepted', { 
            callId: id, 
            from: bSock.id, 
            fromUserId: link.b, 
            roomId,
            livekitToken: livekitTokenA,
            livekitRoomName
          });
        } catch {}
      }
      if (bSock) {
        try {
          bSock.emit('call:accepted', { 
            callId: id, 
            from: aSock.id, 
            fromUserId: link.a, 
            roomId,
            livekitToken: livekitTokenB,
            livekitRoomName
          });
        } catch {}
      }
      
      // Также отправляем через комнаты на случай, если сокеты не найдены напрямую
      try {
        io.to(`u:${link.a}`).emit('call:accepted', { 
          callId: id, 
          from: bSock.id, 
          fromUserId: link.b, 
          roomId,
          livekitToken: livekitTokenA,
          livekitRoomName
        });
        io.to(`u:${link.b}`).emit('call:accepted', { 
          callId: id, 
          from: aSock.id, 
          fromUserId: link.a, 
          roomId,
          livekitToken: livekitTokenB,
          livekitRoomName
        });
      } catch {}
      
      logger.debug('Direct call room established', { roomId, callId: id, participants: 2 });
    }
    
    cleanupCall(id, 'accepted');
  });

  sock.on('call:decline', async ({ callId }: { callId?: string }) => {
    const id = String(callId || '');
    const link = callsById.get(id);
    if (!link) return;
    
    // Снимаем busy статус с обоих участников при отклонении
    const aSock = Array.from(io.sockets.sockets.values()).find((s) => (s as any)?.data?.userId === link.a);
    const bSock = Array.from(io.sockets.sockets.values()).find((s) => (s as any)?.data?.userId === link.b);
    
    if (aSock) {
      (aSock as any).data = (aSock as any).data || {};
      (aSock as any).data.busy = false;
      await emitPresenceUpdateToFriends(io, link.a, false);
    }
    
    if (bSock) {
      (bSock as any).data = (bSock as any).data || {};
      (bSock as any).data.busy = false;
      await emitPresenceUpdateToFriends(io, link.b, false);
    }
    
    try { io.to(`u:${link.a}`).emit('call:declined', { callId: id, from: link.b }); } catch {}
    cleanupCall(id, 'declined');
  });

  sock.on('call:cancel', async ({ callId }: { callId?: string }) => {
    const id = String(callId || '');
    const link = callsById.get(id);
    if (!link) return;
    
    // Снимаем busy статус с обоих участников при отмене
    const aSock = Array.from(io.sockets.sockets.values()).find((s) => (s as any)?.data?.userId === link.a);
    const bSock = Array.from(io.sockets.sockets.values()).find((s) => (s as any)?.data?.userId === link.b);
    
    if (aSock) {
      (aSock as any).data = (aSock as any).data || {};
      (aSock as any).data.busy = false;
      await emitPresenceUpdateToFriends(io, link.a, false);
    }
    
    if (bSock) {
      (bSock as any).data = (bSock as any).data || {};
      (bSock as any).data.busy = false;
      await emitPresenceUpdateToFriends(io, link.b, false);
    }
    
    // уведомим получателя и инициатора одинаковым событием call:cancel,
    // чтобы оба клиента синхронно закрыли UI входящего/исходящего звонка
    try { io.to(`u:${link.a}`).emit('call:cancel', { callId: id, from: link.a }); } catch {}
    try { io.to(`u:${link.b}`).emit('call:cancel', { callId: id, from: link.a }); } catch {}
    cleanupCall(id, 'canceled');
  });

  // Обработчик: партнер ушел (активировал PiP)
  sock.on('partner:away', ({ partnerId, partnerUserId }: { partnerId?: string; partnerUserId?: string }) => {
    try {
      const me = String((sock as any).data?.userId || '');
      if (!me) return;
      
      logger.debug('Partner went away', { from: me, partnerId, partnerUserId });
      
      // Находим сокет партнера и отправляем ему уведомление
      if (partnerUserId) {
        const partnerSocket = Array.from(io.sockets.sockets.values()).find((s) => (s as any)?.data?.userId === partnerUserId);
        if (partnerSocket) {
          (partnerSocket as any).emit('partner:away');
          logger.debug('Sent partner:away to partner', { partnerUserId });
        }
      }
    } catch (e) {
      logger.error('Error handling partner:away:', e);
    }
  });

  // Обработчик: партнер вернулся (деактивировал PiP)
  sock.on('partner:returned', ({ partnerId, partnerUserId }: { partnerId?: string; partnerUserId?: string }) => {
    try {
      const me = String((sock as any).data?.userId || '');
      if (!me) return;
      
      logger.debug('Partner returned', { from: me, partnerId, partnerUserId });
      
      // Находим сокет партнера и отправляем ему уведомление
      if (partnerUserId) {
        const partnerSocket = Array.from(io.sockets.sockets.values()).find((s) => (s as any)?.data?.userId === partnerUserId);
        if (partnerSocket) {
          (partnerSocket as any).emit('partner:returned');
          logger.debug('Sent partner:returned to partner', { partnerUserId });
        }
      }
    } catch (e) {
      logger.error('Error handling partner:returned:', e);
    }
  });

  /* ---- disconnect ---- */
  sock.on('disconnect', async (reason: any) => {
    const userId = (sock as any)?.data?.userId;
    try {} catch {}
    const p = await unpair(sock.id);
    if (p) {
      io.to(p).emit('disconnected');
      // Партнёр освободился — сбросим busy и попробуем сматчить его с кем-то из очереди
      await setRandomBusy(getUserIdBySid(p), false);
      const partnerSock = io.sockets.sockets.get(p) as AuthedSocket | undefined;
      if (partnerSock) {
        // Очищаем состояние партнера перед повторным матчингом
        partnerSock.data.partnerSid = undefined;
        partnerSock.data.inCall = false;
        partnerSock.data.roomId = undefined;
        partnerSock.data.busy = false;
        // Добавляем в очередь и пытаемся сматчить через единую систему
        await enqueueWaiting(p);
        // Используем единую систему матчинга из match.ts
        tryMatch(io, partnerSock).catch((e: any) => {
          logger.error('Failed to re-pair partner after disconnect', { socketId: partnerSock.id, error: e?.message || e });
        });
      }
    }
    unbindUser(sock);
    emitPresence(io);
    // Удаляем из очереди random и снимаем занятость
    await removeFromWaitingQueue(sock.id);
    await setRandomBusy(String(userId || ''), false);
    
    // Очищаем дружеские комнаты при дисконнекте
    if (userId) {
      // Обновляем состояние всех комнат, где был этот пользователь
      sock.rooms.forEach((roomId) => {
        if (roomId.startsWith('room_')) {
          updateFriendRoomState(io, roomId);
        }
      });
    }
  });
});

/* ========= Регистрация доменных сокетов ========= */
registerIdentitySockets(io);
registerFriendSockets(io);
registerMessageSockets(io);

/* ========= REST whoami (как в старой версии) ========= */
app.get('/whoami', async (req, res) => {
  try {
    const installId = String(req.query.installId || '').trim();
    if (!installId) return res.status(400).json({ ok: false, error: 'no_installId' });
    const inst = (await Install.findOne({ installId }).select('user').lean()) as
      | { user?: any }
      | null;
    if (!inst || !inst.user) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    return res.json({ ok: true, userId: String(inst.user) });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

/* ========= REST presence ========= */
app.get('/api/presence', (_req, res) => res.json({ ok: true, list: getOnlineListFromIo(io) }));

/* ========= REST chat history REMOVED - using in-memory only ========= */

/* ========= Start ========= */
function printLanUrls(port: number) {
  const nets = os.networkInterfaces();
  const urls: string[] = [];
  Object.values(nets).forEach((ifaces) =>
    ifaces?.forEach((it) => {
      if (it && it.family === 'IPv4' && !it.internal) {
        urls.push(`http://${it.address}:${port}`);
      }
    })
  );
  if (urls.length > 0) {
    logger.info('Server running on:', urls.join(', '));
  } else {
    logger.info(`Server running on http://${HOST}:${port}`);
  }
}

server.listen(PORT, HOST, () => printLanUrls(PORT));

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  
  // Закрываем Redis соединение
  await queueStore.close();
  
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  
  // Закрываем Redis соединение
  await queueStore.close();
  
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
