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
import fs from 'fs';
import type { AuthedSocket } from './sockets/types';
import friendsRouter from './routes/friends';
import meRouter from './routes/me';
import appSettingsRouter from './routes/app-settings';
import uploadRouter from './routes/upload';
import livekitRouter from './routes/livekit';
import avatarRouter from './routes/avatar';
import messagesRouter from './routes/messages';
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
import { createToken, getLiveKitUrl } from './routes/livekit';
import { sendPushToUser, sendCallPushToRecipient, sendCallCanceledToRecipient, sendCallDeclinedToCaller } from './utils/push';
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
// КРИТИЧНО: В продакшене используйте домен, не IP адрес!
// Например: TURN_HOST=turn.твойдомен.com или api.твойдомен.com
const TURN_SECRET = process.env.TURN_SECRET || process.env.TURN_SHARED_SECRET || '';
const TURN_HOST = (process.env.TURN_HOST || '').trim();
const TURN_PORT = Number(process.env.TURN_PORT || 3478);
const STUN_HOST = (process.env.STUN_HOST || TURN_HOST).trim();

// Проверка что TURN_HOST задан (критично для продакшена)
if (!TURN_HOST) {
  logger.warn('[TURN] ⚠️ TURN_HOST not configured! TURN credentials will not work.');
  logger.warn('[TURN] Set TURN_HOST environment variable (use domain, not IP for production)');
}
const TURN_ENABLE_TCP = String(process.env.TURN_ENABLE_TCP || '1') === '1';
// TCP/443 часто занят HTTPS (api/livekit). Поэтому включаем его ТОЛЬКО по явному флагу.
const TURN_ENABLE_TCP_443 = String(process.env.TURN_ENABLE_TCP_443 || process.env.TURN_TCP_443 || '0') === '1';
const TURN_TTL_SECONDS = Number(process.env.TURN_TTL || 600); // 10 min default

// Стартовая диагностика TURN (без утечки секретов)
if (!TURN_SECRET) {
  logger.warn('[TURN] ⚠️ TURN_SECRET not configured! /api/turn-credentials will return STUN-only config.');
} else {
  logger.info('[TURN] ✅ TURN shared secret configured', {
    hasTurnHost: !!TURN_HOST,
    turnHost: TURN_HOST ? (TURN_HOST.includes('.') ? TURN_HOST.split('.').slice(-2).join('.') : 'configured') : undefined,
    turnPort: TURN_PORT,
    stunHostConfigured: !!STUN_HOST,
    turnEnableTcp: TURN_ENABLE_TCP,
    turnEnableTcp443: TURN_ENABLE_TCP_443,
    turnTtlSeconds: TURN_TTL_SECONDS,
  });
}

/* ========= Helpers ========= */
const isOid = (s?: string) => !!s && /^[a-f\d]{24}$/i.test(String(s));
const normalizeAvatar = (s?: string) => {
  const url = String(s || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
};
// КРИТИЧНО: Проверка готовности MongoDB перед операциями
// readyState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
const isMongoReady = () => mongoose.connection.readyState === 1;

/* ========= App / HTTP / IO ========= */
const app = express();

// Resolve backend public directory robustly for:
// - dev (running from backend/ via ts-node)
// - prod (running compiled from backend/dist/)
// IMPORTANT: tsc does NOT copy backend/public into backend/dist by default,
// and sometimes an empty dist/public folder can exist, so we select by "known files".
const PUBLIC_DIR = (() => {
  const candidates = [
    // when running from dist/: __dirname = backend/dist -> ../public = backend/public
    path.resolve(__dirname, '..', 'public'),
    // when running from backend/: __dirname = backend -> public = backend/public
    path.join(__dirname, 'public'),
    // extra fallback (covers odd cwd layouts)
    path.resolve(__dirname, '..', '..', 'public'),
  ];

  const hasKnownFiles = (dir: string) => {
    try {
      return (
        fs.existsSync(path.join(dir, '.well-known', 'assetlinks.json')) ||
        fs.existsSync(path.join(dir, 'invite.html')) ||
        fs.existsSync(path.join(dir, 'uploads'))
      );
    } catch {
      return false;
    }
  };

  return candidates.find((d) => fs.existsSync(d) && hasKnownFiles(d)) ?? candidates[0]!;
})();

app.use(
  cors({
    origin: (() => {
      const raw = String(process.env.CORS_ORIGINS || '').trim();
      if (!raw) return '*';
      const list = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // If provided, enforce allowlist; otherwise fallback to '*'.
      return (origin: any, cb: any) => {
        if (!origin) return cb(null, true);
        const ok = list.includes(origin);
        return cb(null, ok);
      };
    })(),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-install-id'],
  })
);

// json/urlencoded парсеры — один раз и до роутеров
app.use(express.json({ limit: '500mb' })); // Увеличиваем лимит для очень больших видео
app.use('/chat', createChatRouter());
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

/** Резолвим userId ТОЛЬКО по installId (не доверяем x-user-id). */
app.use(async (req, _res, next) => {
  try {
    const installId = String(req.header('x-install-id') || '').trim();
    (req as any).installId = installId;

    if (installId && mongoose.connection.readyState === 1) {
      try {
        const rec = (await Install.findOne({ installId }).select('user').lean()) as
          | { user?: any }
          | null;
        if (rec?.user && isOid(String(rec.user))) {
          const uid = String(rec.user);
          (req as any).userId = uid;

          // If client still sends x-user-id, ensure it matches (audit only).
          const headerUserId = String(req.header('x-user-id') || '').trim();
          if (headerUserId && isOid(headerUserId) && headerUserId !== uid) {
            logger.warn('[auth] x-user-id mismatch for installId', {
              installId,
              headerUserId,
              resolvedUserId: uid,
              path: req.path,
              method: req.method,
            });
          }
        }
      } catch {
        // Ignore Mongo errors here (routes may handle DB unavailable separately).
      }
    }
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
app.use('/uploads', express.static(path.join(PUBLIC_DIR, 'uploads')));

// Android App Links / Apple AASA (dotfiles must be allowed)
app.use(
  '/.well-known',
  express.static(path.join(PUBLIC_DIR, '.well-known'), {
    dotfiles: 'allow',
  })
);

// Android App Links: assetlinks.json
// КРИТИЧНО: отдаём файл из корня проекта, чтобы работало и из dist/, и из исходников.
app.get('/.well-known/assetlinks.json', (_req, res) => {
  try {
    const assetLinksPath = path.join(PUBLIC_DIR, '.well-known/assetlinks.json');
    if (!fs.existsSync(assetLinksPath)) {
      logger.error('assetlinks.json not found', { assetLinksPath, __dirname, PUBLIC_DIR });
      return res.status(404).send('Not found');
    }
    res.type('application/json');
    return res.sendFile(assetLinksPath);
  } catch (e) {
    logger.error('Failed to send assetlinks.json', { error: (e as any)?.message || String(e) });
    return res.status(500).send('Error loading assetlinks.json');
  }
});

// КРИТИЧНО: Обработка веб-версии реферальных ссылок ДО express.static
// Иначе Express будет искать статический файл /invite/:code и вернет ошибку
app.get('/invite/:code', (req, res) => {
  const code = req.params.code;
  // Проверяем валидность кода
  if (!code || !/^[a-f\d]{24}$/i.test(code)) {
    return res.status(400).send('Invalid invite code');
  }
  // Отдаем HTML страницу
  // КРИТИЧНО: После компиляции __dirname указывает на dist/, нужно подняться на уровень выше к корню проекта
  // Используем абсолютный путь для надежности
  const fs = require('fs');
  const projectRoot = path.resolve(__dirname, '..');
  const htmlPath = path.join(projectRoot, 'public/invite.html');
  
  // Проверяем существование файла перед отправкой
  if (!fs.existsSync(htmlPath)) {
    logger.error('invite.html not found', { htmlPath, __dirname, projectRoot });
    return res.status(500).send('Invite page not found');
  }
  
  res.sendFile(htmlPath, (err) => {
    if (err) {
      logger.error('Failed to send invite.html', {
        error: (err as any)?.message || String(err),
        htmlPath,
        __dirname,
        projectRoot,
        fileExists: fs.existsSync(htmlPath),
      });
      res.status(500).send('Error loading invite page');
    }
  });
});

// Статические файлы после специфичных маршрутов
app.use(express.static(PUBLIC_DIR));

/* ========= REST API ========= */
app.use('/api', appSettingsRouter);
app.use('/api', meRouter);
app.use('/api', friendsRouter);
app.use('/api', uploadRouter);
app.use('/api', avatarRouter);
app.use('/api', messagesRouter);
app.use('/api', livekitRouter);

// Stream utility убран - больше не используется

app.post('/chat/ensure-dm', async (req, res) => {
  try {
    const meId = String(req.body?.meId ?? '').trim();
    const peerId = String(req.body?.peerId ?? '').trim();
    if (!isOid(meId) || !isOid(peerId)) {
      return res.status(400).json({ ok: false, error: 'bad_ids' });
    }

    // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
    if (!isMongoReady()) {
      return res.status(503).json({ ok: false, error: 'database_unavailable' });
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
      // Dev-friendly behavior: do NOT return 503 when TURN isn't configured.
      // Returning 503 causes clients to retry and spam logs, and can contribute to reconnect storms.
      // Instead, return a valid STUN-only config (200 OK).
      logger.warn('[TURN] TURN_SECRET not configured, returning fallback STUN only');
      return res.json({
        ok: true,
        username: '',
        credential: '',
        ttl: 300,
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
      });
    }

    // КРИТИЧНО: Проверяем что TURN_HOST задан
    if (!TURN_HOST) {
      logger.warn('[TURN] TURN_HOST not configured, returning fallback STUN only');
      // Возвращаем только публичные STUN серверы как fallback
      return res.json({
        ok: true,
        username: '',
        credential: '',
        ttl: 0,
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
      });
    }

    // Предупреждение если используется IP вместо домена (для продакшена)
    const isIP = /^\d+\.\d+\.\d+\.\d+$/.test(TURN_HOST);
    if (isIP) {
      logger.warn('[TURN] TURN_HOST uses IP address instead of domain', { TURN_HOST });
      logger.warn('[TURN] For production, use domain (e.g., turn.твойдомен.com)');
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
    // TURN TCP/443 — только если явно включено (часто конфликтует с HTTPS)
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
      if (TURN_ENABLE_TCP_443) {
        iceServers.push({ urls: turnTcp443, username, credential: hmac });
      }
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
    // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
    if (!isMongoReady()) {
      return res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
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

    // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
    if (!isMongoReady()) {
      return res.status(503).json({ ok: false, error: 'database_unavailable' });
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

    // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
    if (!isMongoReady()) {
      return res.json({ ok: true, exists: false }); // Если БД недоступна, считаем что пользователь не существует
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

      // Также проверяем коллекцию напрямую, если соединение с БД существует
      let directCount = 0;
      if (mongoose.connection?.db) {
        directCount = await mongoose.connection.db.collection('users').countDocuments();
        logger.info(`[MongoDB] Direct collection count (users): ${directCount}`);
      } else {
        logger.warn('[MongoDB] Не удалось получить прямое подключение к коллекции users (mongoose.connection.db undefined)');
      }

      if (userCount === 0 && directCount === 0) {
        logger.warn('[MongoDB] ⚠️  База данных пуста - пользователей нет!');
        logger.warn('[MongoDB] Убедитесь, что используется правильная БД', { dbName });
      }
    } catch (e) {
      logger.warn('[MongoDB] Could not check user count', { error: (e as any)?.message || String(e) });
    }
  })
  .catch((err) => {
    // КРИТИЧНО: Не завершаем процесс при ошибке MongoDB
    // Сервер должен работать даже без MongoDB для WebRTC/LiveKit функций
    logger.error('MongoDB connection failed (server will continue without DB):', {
      error: err?.message || String(err),
      uri: MONGO_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')
    });
    logger.warn('[MongoDB] Server will continue running, but database features will be unavailable');
    // УБРАНО: process.exit(1) - сервер должен работать даже без MongoDB
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
    
    // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
    if (!isMongoReady()) {
      // Если БД недоступна, просто отправляем событие самому пользователю
      io.to(`u:${userId}`).emit('presence:update', { userId, busy });
      return;
    }
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
/** callId -> roomId после call:accept (для call:end, когда клиент присылает только callId, напр. принятие из пуша) */
const callIdToRoomId = new Map<string, string>();
/** Участник не был подключён в момент call:accept — при reauth отправим ему call:accepted и он подключится в комнату */
const activeRoomByUserId = new Map<string, { callId: string; roomId: string; livekitRoomName: string; peerUserId: string }>();
// Пользователь занят рандом-видеочатом (по userId) — используется также для findRandom

function cleanupCall(callId: string, reason?: 'accepted' | 'declined' | 'canceled' | 'timeout') {
  const link = callsById.get(callId);
  if (!link) return;
  if (link.timer) { try { clearTimeout(link.timer); } catch {} }
  callsById.delete(callId);
  callOfUser.delete(link.a);
  callOfUser.delete(link.b);
}

/** Отклонение звонка по HTTP (из IncomingCallActivity без открытия приложения). Auth по x-install-id. */
app.post('/api/calls/decline', async (req, res) => {
  try {
    const userId = (req as any).userId;
    if (!userId || !isOid(userId)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const callId = String(req.body?.callId || '').trim();
    if (!callId) {
      return res.status(400).json({ ok: false, error: 'callId_required' });
    }
    const link = callsById.get(callId);
    if (!link) {
      return res.json({ ok: true }); // уже завершён — не ошибка
    }
    if (link.b !== userId) {
      return res.status(403).json({ ok: false, error: 'only_callee_can_decline' });
    }
    logger.info('[api/calls/decline] callee declined via HTTP', { callId, caller: link.a, callee: link.b });
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
    try { io.to(`u:${link.a}`).emit('call:declined', { callId, from: link.b }); } catch {}
    try { await sendCallDeclinedToCaller(link.a, callId); } catch (e: any) { logger.warn('[api/calls/decline] sendCallDeclinedToCaller failed', { error: e?.message }); }
    cleanupCall(callId, 'declined');
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

/** Отмена звонка по HTTP (из нативного OutgoingCallActivity при таймауте 20с). Auth по x-install-id. Только инициатор. */
app.post('/api/calls/cancel', async (req, res) => {
  try {
    const userId = (req as any).userId;
    if (!userId || !isOid(userId)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const callId = String(req.body?.callId || '').trim();
    if (!callId) {
      return res.status(400).json({ ok: false, error: 'callId_required' });
    }
    const link = callsById.get(callId);
    if (!link) {
      return res.json({ ok: true }); // уже завершён — не ошибка
    }
    if (link.a !== userId) {
      return res.status(403).json({ ok: false, error: 'only_caller_can_cancel' });
    }
    logger.info('[api/calls/cancel] caller canceled via HTTP (timeout)', { callId, caller: link.a, callee: link.b });
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
    try { io.to(`u:${link.a}`).emit('call:cancel', { callId, from: link.a }); } catch {}
    try { io.to(`u:${link.b}`).emit('call:cancel', { callId, from: link.a }); } catch {}
    try { await sendCallCanceledToRecipient(link.b, callId); } catch (e: any) { logger.warn('[api/calls/cancel] sendCallCanceledToRecipient failed', { error: e?.message }); }
    let fromNick: string | undefined;
    try {
      if (isMongoReady()) {
        const u = await User.findById(link.a).select('nick').lean();
        if (u && typeof (u as any).nick === 'string') fromNick = String((u as any).nick).trim() || undefined;
      }
    } catch {}
    try {
      await sendPushToUser(link.b, {
        kind: 'call',
        title: '',
        body: '',
        channelId: 'calls',
        data: { type: 'call_ended', callId, from: link.a, fromNick: fromNick || '' },
      });
    } catch (e: any) {
      logger.warn('[api/calls/cancel] call_ended push failed', { peerId: link.b, error: e?.message });
    }
    cleanupCall(callId, 'canceled');
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

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
      // SECURITY: do NOT trust client-provided userId. Re-authenticate by installId -> user mapping.
      const hs: any = sock.handshake || {};
      const rawInstallId =
        (typeof hs.auth?.installId === 'string' && hs.auth.installId) ||
        (typeof hs.query?.installId === 'string' && hs.query.installId) ||
        '';

      const installId = String(rawInstallId || '').trim();
      if (!installId) {
        logger.warn('[auth] Reauth failed: no installId', { socketId: sock.id });
        return ack?.({ ok: false, error: 'no_installId' });
      }

      if (!isMongoReady()) {
        logger.warn('Reauth failed: database unavailable');
        return ack?.({ ok: false, error: 'database_unavailable' });
      }

      const inst = await Install.findOne({ installId }).select('user').lean();
      const mappedUserId = inst?.user ? String((inst as any).user) : '';
      if (!isOid(mappedUserId)) {
        logger.warn('[auth] Reauth failed: install not found', { installId, socketId: sock.id });
        return ack?.({ ok: false, error: 'not_found' });
      }

      const exists = await User.exists({ _id: mappedUserId });
      if (!exists) {
        logger.warn('Reauth failed: user not found for install', { installId, userId: mappedUserId });
        return ack?.({ ok: false, error: 'user_not_found' });
      }

      bindUserIdentity(io, sock, mappedUserId);
      emitPresence(io);

      // Если пользователь был в ожидании принятого звонка (принятие было вне приложения) — отправляем call:accepted и подключаем в комнату
      const pendingRoom = activeRoomByUserId.get(mappedUserId);
      if (pendingRoom) {
        try {
          activeRoomByUserId.delete(mappedUserId);
          const token = await createToken({ identity: mappedUserId, roomName: pendingRoom.livekitRoomName });
          sock.join(pendingRoom.roomId);
          activeCallBySocket.set(sock.id, pendingRoom.roomId);
          (sock as any).data = (sock as any).data || {};
          (sock as any).data.busy = true;
          (sock as any).data.roomId = pendingRoom.roomId;
          (sock as any).data.partnerSid = null;
          (sock as any).data.inCall = true;
          sock.emit('call:accepted', {
            callId: pendingRoom.callId,
            from: null,
            fromUserId: pendingRoom.peerUserId,
            roomId: pendingRoom.roomId,
            livekitToken: token,
            livekitRoomName: pendingRoom.livekitRoomName,
            livekitUrl: getLiveKitUrl() || null,
          });
          logger.info('[reauth] Sent call:accepted to reconnected participant', { userId: mappedUserId, roomId: pendingRoom.roomId, callId: pendingRoom.callId });
        } catch (e: any) {
          logger.warn('[reauth] Failed to send pending call:accepted', { userId: mappedUserId, error: e?.message });
        }
      }

      // If client sent userId in payload and it differs, log it.
      const claimed = String(payload?.userId || '').trim();
      if (claimed && isOid(claimed) && claimed !== mappedUserId) {
        logger.warn('[auth] Reauth claimed userId mismatch', {
          installId,
          claimedUserId: claimed,
          mappedUserId,
          socketId: sock.id,
        });
      }

      logger.debug('User reauthorized successfully', { userId: mappedUserId });
      ack?.({ ok: true, userId: mappedUserId });
    } catch (e) {
      logger.error('Reauth error', { error: (e as any)?.message || String(e) });
      ack?.({ ok: false, error: 'server_error' });
    }
  });

  // SECURITY: restore auth ONLY by installId mapping (do NOT trust handshake userId)
  const hs: any = sock.handshake || {};
  const rawInstallId =
    (typeof hs.auth?.installId === 'string' && hs.auth.installId) ||
    (typeof hs.query?.installId === 'string' && hs.query.installId) ||
    '';

  let bindUid: string | null = null;
  // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
  if (isMongoReady()) {
    if (rawInstallId.trim()) {
      try {
        const inst = (await Install.findOne({ installId: rawInstallId.trim() })
          .select('user')
          .lean()) as { user?: any } | null;
        if (inst?.user && isOid(String(inst.user)) && (await User.exists({ _id: String(inst.user) }))) {
          bindUid = String(inst.user);
        }
      } catch (e) {
        // Игнорируем ошибки MongoDB при поиске installId
      }
    }
  }
  
  if (bindUid) {
    // Привязываем пользователя к сокету
    bindUserIdentity(io, sock, String(bindUid));
    emitPresence(io);
    // Участник переподключился — если был принятый звонок без него, отправляем call:accepted
    const pendingRoom = activeRoomByUserId.get(String(bindUid));
    if (pendingRoom) {
      (async () => {
        try {
          activeRoomByUserId.delete(String(bindUid));
          const token = await createToken({ identity: String(bindUid), roomName: pendingRoom.livekitRoomName });
          sock.join(pendingRoom.roomId);
          activeCallBySocket.set(sock.id, pendingRoom.roomId);
          (sock as any).data = (sock as any).data || {};
          (sock as any).data.busy = true;
          (sock as any).data.roomId = pendingRoom.roomId;
          (sock as any).data.partnerSid = null;
          (sock as any).data.inCall = true;
          sock.emit('call:accepted', {
            callId: pendingRoom.callId,
            from: null,
            fromUserId: pendingRoom.peerUserId,
            roomId: pendingRoom.roomId,
            livekitToken: token,
            livekitRoomName: pendingRoom.livekitRoomName,
            livekitUrl: getLiveKitUrl() || null,
          });
          logger.info('[connect] Sent call:accepted to reconnected participant (initial bind)', { userId: bindUid, roomId: pendingRoom.roomId });
        } catch (e: any) {
          logger.warn('[connect] Failed to send pending call:accepted', { userId: bindUid, error: e?.message });
        }
      })();
    }
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
      
      // КРИТИЧНО: Приоритетно берем roomId из параметров, сокет-данных, activeCallBySocket; если передан только callId — смотрим callIdToRoomId (принятие из пуша)
      const resolvedRoomId =
        roomId ||
        (sock as any)?.data?.roomId ||
        activeCallBySocket.get(sock.id) ||
        (callId ? callIdToRoomId.get(String(callId)) : undefined);
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
      logger.info('📥 [call:end] Room info', {
        roomId: id,
        participants: participantCount,
        socketIds: room ? Array.from(room) : [],
        roomExists: !!room
      });
      
      // КРИТИЧНО: Если комната не найдена, все равно отправляем call:ended всем сокетам
      // которые могут быть в звонке (через activeCallBySocket или socket.data.roomId)
      const socketsToNotify = new Set<string>();
      
      // Добавляем всех участников комнаты
      if (room) {
        for (const sid of room) {
          socketsToNotify.add(sid);
        }
      }
      
      // Добавляем сокеты, которые могут быть в звонке, но не в комнате
      // (например, если комната была удалена, но звонок еще активен)
      for (const [socketId, activeRoomId] of activeCallBySocket.entries()) {
        if (activeRoomId === id) {
          socketsToNotify.add(socketId);
          logger.debug('📥 [call:end] Добавлен сокет из activeCallBySocket', {
            socketId,
            roomId: id
          });
        }
      }
      
      // Также проверяем socket.data.roomId для всех подключенных сокетов
      // КРИТИЧНО: Это важно для случаев, когда комната не найдена, но звонок активен
      for (const [socketId, socket] of io.sockets.sockets.entries()) {
        const socketRoomId = (socket as any)?.data?.roomId;
        if (socketRoomId === id) {
          socketsToNotify.add(socketId);
          logger.debug('📥 [call:end] Добавлен сокет из socket.data.roomId', {
            socketId,
            userId: (socket as any)?.data?.userId,
            roomId: id
          });
        }
      }
      
      // КРИТИЧНО: Также проверяем partnerSid для всех сокетов
      // Если один участник имеет partnerSid другого, значит они в звонке
      for (const [socketId, socket] of io.sockets.sockets.entries()) {
        const partnerSid = (socket as any)?.data?.partnerSid;
        if (partnerSid && socketsToNotify.has(partnerSid)) {
          // Если партнер уже в списке, добавляем и этого участника
          socketsToNotify.add(socketId);
          logger.debug('📥 [call:end] Добавлен сокет через partnerSid', {
            socketId,
            partnerSid,
            userId: (socket as any)?.data?.userId,
            roomId: id
          });
        }
      }
      
      logger.info('📥 [call:end] Sockets to notify', {
        roomId: id,
        totalSockets: socketsToNotify.size,
        socketIds: Array.from(socketsToNotify)
      });
      
      // Снимаем busy со всех участников и очищаем состояние
      for (const sid of socketsToNotify) {
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
      
      // Отправляем call:ended всем участникам
      logger.info('📤 [call:end] Sending call:ended to all participants', {
        roomId: id,
        participantCount: socketsToNotify.size,
        socketIds: Array.from(socketsToNotify)
      });
      
      // КРИТИЧНО: Отправляем call:ended ВСЕМ участникам двумя способами для максимальной надежности:
      // 1. Через комнату (io.to(id).emit) - если комната существует
      // 2. Напрямую каждому сокету - гарантирует доставку даже если комната не найдена
      
      // Способ 1: Отправка через комнату (если комната существует)
      if (room && room.size > 0) {
        // ВАЖНО: roomId всегда является идентификатором комнаты (`room_...`),
        // а callId (если был передан клиентом) — это отдельный идентификатор звонка (timestamp).
        // Раньше мы отправляли callId=id, из-за чего часть клиентов, которые сравнивают только callId,
        // не распознавали завершение и звонок "закрывался" только у одного.
        io.to(id).emit('call:ended', {
          callId: callId || undefined,
          roomId: id,
          reason: 'ended',
          scope: 'room',
          resolvedRoomId: id,
        });
        logger.info('📤 [call:end] ✅ Отправлено call:ended через комнату', {
          roomId: id,
          participantCount: room.size
        });
      }
      
      // Способ 2: Отправка напрямую каждому сокету (гарантирует доставку)
      const notifiedSockets: string[] = [];
      for (const sid of socketsToNotify) {
        const socket = io.sockets.sockets.get(sid);
        if (socket) {
          socket.emit('call:ended', {
            callId: callId || undefined,
            roomId: id,
            reason: 'ended',
            scope: 'direct',
            resolvedRoomId: id,
          });
          notifiedSockets.push(sid);
          logger.info('📤 [call:end] ✅ Отправлено call:ended напрямую сокету', {
            socketId: sid,
            userId: (socket as any)?.data?.userId,
            roomId: id,
            callId: callId || id,
          });
        }
      }
      
      if (callId) callIdToRoomId.delete(String(callId));
      // Очищаем ожидание повторного входа в комнату (инициатор мог переподключиться и уже получил call:accepted)
      try {
        const parts = String(id).match(/^room_(.+)_(.+)$/);
        if (parts) {
          activeRoomByUserId.delete(parts[1]);
          activeRoomByUserId.delete(parts[2]);
        }
      } catch {}

      // Пуш второму участнику (если приложение в фоне/убито) — снять уведомление о звонке и закрыть UI при открытии
      const senderUserId = (sock as any)?.data?.userId;
      if (senderUserId) {
        try {
          const fromUser = await User.findById(senderUserId).select('nick').lean();
          const fromNick = (fromUser as any)?.nick ?? '';
          for (const sid of socketsToNotify) {
            if (sid === sock.id) continue;
            const peerSocket = io.sockets.sockets.get(sid);
            const peerUserId = peerSocket ? (peerSocket as any)?.data?.userId : null;
            if (peerUserId && peerUserId !== senderUserId) {
              await sendPushToUser(peerUserId, {
                kind: 'call',
                data: { type: 'call_ended', from: senderUserId, fromNick, callId: callId || id, endedFromActive: true },
              });
              break;
            }
          }
        } catch (e: any) {
          logger.warn('[call:end] send call_ended push failed', { error: e?.message });
        }
      }

      logger.info('✅ [call:end] Call cleanup completed', {
        callId: id,
        roomId: id,
        participants: socketsToNotify.size,
        notifiedSockets: Array.from(socketsToNotify)
      });

    } catch (e) {
      logger.error('❌ [call:end] Call end handler error', { error: (e as any)?.message || String(e) });
    }
  });



  /* ---- presence update от клиента ---- */
  sock.on('presence:update', async (payload: any) => {
    try {
      const userId = String((sock as any).data?.userId || '');
      if (!userId) return;
      
      const status = payload?.status;
      const busy = status === 'busy';
      
      // Обновляем состояние сокета
      (sock as any).data.busy = busy;
      if (payload?.roomId) {
        (sock as any).data.roomId = payload.roomId;
      } else if (!busy) {
        // КРИТИЧНО: Очищаем roomId только когда пользователь не busy
        // Если busy: true и roomId не передан, это означает что пользователь ищет (next()),
        // и roomId должен остаться undefined - не удаляем его явно, так как он уже undefined
        delete (sock as any).data.roomId;
      } else {
        // КРИТИЧНО: Если busy: true и roomId не передан (поиск после next()),
        // явно очищаем roomId чтобы синхронизировать состояние
        delete (sock as any).data.roomId;
      }
      
      // Рассылаем обновление друзьям
      await emitPresenceUpdateToFriends(io, userId, busy);
      
      logger.debug('📍 [presence:update] Status updated', {
        userId,
        status,
        busy,
        roomId: payload?.roomId
      });
    } catch (e) {
      logger.error('❌ [presence:update] Error', { error: (e as any)?.message || String(e) });
    }
  });

  // SECURITY: legacy attach_user is disabled (use identity:attach instead).

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

      // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
      if (!isMongoReady()) {
        if (typeof ack === 'function') ack({ ok: false, error: 'database_unavailable' });
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
        const isDataMarker = currentAvatar.startsWith('data:image'); // Маркер для base64 аватаров
      
        if (isEmpty) {
          // явное удаление аватара
          // НЕ очищаем, если это маркер base64 аватара (аватар загружен через user.uploadAvatar)
          if (!isDataMarker && (currentAvatar !== '' || current.avatarB64 || current.avatarThumbB64)) {
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

      // КРИТИЧНО: Отправляем обновление друзьям ВСЕГДА при изменении профиля
      // Это включает случаи: изменение никнейма, удаление никнейма, изменение аватара, удаление аватара
      // Отправляем даже если значение стало пустым - это важно для синхронизации
      if (changed && Array.isArray(fresh?.friends) && (fresh!.friends as any[]).length) {
        for (const fid of fresh!.friends as any[]) {
          try {
            io.to(`u:${String(fid)}`).emit('friend:profile', {
              userId: me,
              nick: fresh?.nick || '', // Может быть пустым - это нормально
              avatar: rawOut, // Может быть пустым - это нормально
              avatarVer, // Версия обновляется даже при удалении аватара
              avatarThumbB64: avatarThumbB64 || '', // Может быть пустым при удалении аватара
            });
            logger.debug('[profile:update] Отправлено обновление профиля другу', {
              from: me,
              to: String(fid),
              nick: fresh?.nick || '(пусто)',
              hasAvatar: !!(avatarVer && avatarVer > 0)
            });
          } catch (e) {
            logger.warn('[profile:update] Ошибка отправки обновления профиля другу', {
              from: me,
              to: String(fid),
              error: e
            });
          }
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
      
      // Найдём любой сокет получателя (может быть offline — тогда будем будить пушем)
      const peerSocket = Array.from(io.sockets.sockets.values()).find((s) => (s as any)?.data?.userId === peerId) as
        | AuthedSocket
        | undefined;
      
      // Если получатель онлайн — проверяем busy флаг
      if (peerSocket && (peerSocket as any)?.data?.busy === true) {
        try { sock.emit('call:busy', { from: peerId, userId: peerId }); } catch {}
        return ack?.({ ok: false, error: 'peer_busy' });
      }
      
      // Убрано: проверка randomBusyByUser - рандомный поиск не блокирует звонки другу
      
      if (peerSocket && callOfUser.has(peerId)) {
        // Получатель уже в активном звонке
        try { sock.emit('call:busy', { from: peerId, userId: peerId }); } catch {}
        return ack?.({ ok: false, error: 'peer_busy' });
      }

      const callId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      callsById.set(callId, { a: me, b: peerId });
      callOfUser.set(me, { with: peerId, callId });
      callOfUser.set(peerId, { with: me, callId });

      // КРИТИЧНО: Создаем комнату при инициации звонка (инициатором)
      // Используем user IDs для имени комнаты, чтобы совпадало с LiveKit roomName
      const sortedUserIds = [me, peerId].sort();
      const roomId = `room_${sortedUserIds[0]}_${sortedUserIds[1]}`;
      console.log('[call:initiate] roomId created', { me, peerId, roomId });
      
      // Инициатор сразу присоединяется к комнате
      try { 
        sock.join(roomId);
        logger.debug('Initiator joined room', { socketId: sock.id, roomId, callId });
      } catch {}
      
      // КРИТИЧНО: Устанавливаем busy флаг и состояние звонка для инициатора при инициации
      // Это гарантирует консистентность состояния, даже если инициатор отключится до принятия
      // Инициатор
      (sock as any).data = (sock as any).data || {};
      (sock as any).data.busy = true;
      (sock as any).data.roomId = roomId;
      if (peerSocket) (sock as any).data.partnerSid = peerSocket.id;
      
      // Если получатель онлайн — также отмечаем его как busy
      if (peerSocket) {
        (peerSocket as any).data = (peerSocket as any).data || {};
        (peerSocket as any).data.busy = true;
        (peerSocket as any).data.roomId = roomId;
        (peerSocket as any).data.partnerSid = sock.id;
      }
      
      // Рассылаем presence:update (только друзьям)
      await emitPresenceUpdateToFriends(io, me, true);
      if (peerSocket) await emitPresenceUpdateToFriends(io, peerId, true);
      logger.debug('Call initiated', { from: me, to: peerId, callId, roomId });
      
      // КРИТИЧНО: Отправляем инициатору roomId для немедленного использования
      // Включаем from (socket.id получателя) для сохранения partnerSocketId
      try {
        sock.emit('call:room:created', { callId, roomId, partnerId: peerId, from: peerSocket ? peerSocket.id : null });
        logger.debug('Room created event sent to initiator', { socketId: sock.id, roomId, callId, from: peerSocket ? peerSocket.id : null });
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
        // Пуш получателю: вибрация остановится (снимем уведомление), клиент покажет «Пропущенный от X» без вибрации
        let fromNick: string | undefined;
        try {
          if (isMongoReady()) {
            const u = await User.findById(link.a).select('nick').lean();
            if (u && typeof (u as any).nick === 'string') fromNick = String((u as any).nick).trim() || undefined;
          }
        } catch {}
        try {
          await sendPushToUser(link.b, {
            kind: 'call',
            title: '',
            body: '',
            channelId: 'calls',
            data: { type: 'call_ended', callId, from: link.a, fromNick: fromNick || '' },
          });
        } catch (e: any) {
          logger.warn('[call:timeout] call_ended push failed', { peerId: link.b, error: e?.message });
        }
        cleanupCall(callId, 'timeout');
      }, 20000);
      const link = callsById.get(callId);
      if (link) link.timer = timer;

      // отправим входящий вызов получателю (с ником инициатора, если есть)
      try {
        let fromNick: string | undefined;
        try {
          // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
          if (isMongoReady()) {
            const u = await User.findById(me).select('nick').lean();
            if (u && typeof (u as any).nick === 'string') fromNick = String((u as any).nick).trim() || undefined;
          }
        } catch {}
        
        // Всегда шлём в комнату u:peerId (получатель получает после reauth); при наличии сокета — дублируем напрямую
        const recipientSockets = Array.from(io.sockets.sockets.values()).filter((s) =>
          String((s as any)?.data?.userId || '') === String(peerId)
        );
        for (const recipientSocket of recipientSockets) {
          try {
            (recipientSocket as any).emit('call:incoming', { callId, from: me, fromNick });
            (recipientSocket as any).emit('friend:call:incoming', { callId, from: me, nick: fromNick });
          } catch {}
        }
        const room = io.sockets.adapter.rooms.get(`u:${peerId}`);
        const roomSize = room ? room.size : 0;
        logger.info('[call:initiate] emitting call:incoming to recipient', { peerId, callId, recipientSocketsCount: recipientSockets.length, roomUSize: roomSize });
        io.to(`u:${peerId}`).emit('call:incoming', { callId, from: me, fromNick });
        io.to(`u:${peerId}`).emit('friend:call:incoming', { callId, from: me, nick: fromNick });

        // Push для входящего звонка: Android с FCM-токеном — data-only через FCM (onMessageReceived в фоне);
        // остальные — через Expo без title/body. Так показывается нативный экран CallKeep при убитом/фоне.
        try {
          logger.info('[call:initiate] sending call push to recipient', { peerId, callId, from: me });
          await sendCallPushToRecipient(peerId, { callId, from: me, fromNick: fromNick || '' });
          logger.info('[call:initiate] call push sent', { peerId });
        } catch (pushErr: any) {
          logger.warn('[call:initiate] push to recipient failed', { peerId, error: pushErr?.message });
        }
      } catch {}

      return ack?.({ ok: true, callId });
    } catch (e: any) {
      return ack?.({ ok: false, error: e?.message || 'server_error' });
    }
  });

  // Получение LiveKit токена через сокет
  sock.on(
    'livekit:token',
    async (
      { roomName }: { roomName?: string },
      ack?: (response: { ok: boolean; token?: string; url?: string; error?: string }) => void
    ) => {
    try {
      const me = (sock as any)?.data?.userId;
      if (!me || !roomName) {
        logger.warn('[livekit:token] Missing parameters', { hasUserId: !!me, hasRoomName: !!roomName, socketId: sock.id });
        return ack?.({ ok: false, error: 'missing_user_or_roomName' });
      }
      
      console.log('[livekit:token] 📤 Creating token request', { 
        userId: me, 
        roomName, 
        socketId: sock.id,
        socketDataUserId: (sock as any)?.data?.userId,
      });
      
      logger.debug('[livekit:token] Creating token', { userId: me, roomName, socketId: sock.id });
      const token = await createToken({ identity: me, roomName });
      
      console.log('[livekit:token] ✅ Token created successfully', { 
        userId: me, 
        roomName, 
        tokenLength: token?.length || 0,
        identity: me,
        socketId: sock.id,
      });
      
      logger.debug('[livekit:token] Token created successfully', { userId: me, roomName, tokenLength: token?.length || 0 });
      return ack?.({ ok: true, token, url: getLiveKitUrl() || undefined });
    } catch (e: any) {
      console.error('[livekit:token] ❌ Error creating token:', {
        error: e?.message,
        userId: (sock as any)?.data?.userId,
        roomName,
        socketId: sock.id,
      });
      logger.error('[livekit:token] Error creating token:', { 
        error: e?.message, 
        stack: e?.stack,
        userId: (sock as any)?.data?.userId,
        roomName,
        socketId: sock.id,
      });
      return ack?.({ ok: false, error: e?.message || 'server_error' });
    }
    }
  );

  sock.on('call:accept', async ({ callId }: { callId?: string }) => {
    const id = String(callId || '');
    const link = callsById.get(id);
    if (!link) return;
    
    logger.debug('Call accepted', { callId: id });
    
    // КРИТИЧНО: Принятие возможно даже если инициатор (A) офлайн — он получит call:accepted при reauth
    const aSock = Array.from(io.sockets.sockets.values()).find((s) => (s as any)?.data?.userId === link.a) as AuthedSocket | undefined;
    const bSock = (sock as any)?.data?.userId === link.b ? (sock as AuthedSocket) : Array.from(io.sockets.sockets.values()).find((s) => (s as any)?.data?.userId === link.b) as AuthedSocket | undefined;
    
    if (!bSock) return;
    
    {
      // КРИТИЧНО: Используем user IDs для имени комнаты, чтобы совпадало с LiveKit
      // Это гарантирует что оба участника подключатся к одной LiveKit комнате
      let roomId: string;
      if (link.a && link.b) {
        const sortedUserIds = [link.a, link.b].sort();
        roomId = `room_${sortedUserIds[0]}_${sortedUserIds[1]}`;
        console.log('[call:accept] roomId from user IDs', { linkA: link.a, linkB: link.b, roomId });
      } else {
        // Fallback на socket IDs если user IDs недоступны
        const sorted = [aSock.id, bSock.id].sort();
        roomId = `room_${sorted[0]}_${sorted[1]}`;
        console.log('[call:accept] FALLBACK roomId from socket IDs', { aSockId: aSock.id, bSockId: bSock.id, roomId });
      }
      
      // КРИТИЧНО: Присоединяем к комнате всех, кто сейчас подключён; инициатор может подключиться позже (reauth)
      try { if (aSock) { aSock.join(roomId); logger.debug('Participant A joined room', { socketId: aSock.id, roomId, callId: id }); } } catch {}
      try { bSock.join(roomId); logger.debug('Participant B joined room', { socketId: bSock.id, roomId, callId: id }); } catch {}
      
      try { callIdToRoomId.set(id, roomId); } catch {}
      try { if (aSock) activeCallBySocket.set(aSock.id, roomId); } catch {}
      try { activeCallBySocket.set(bSock.id, roomId); } catch {}

      if (aSock) {
        (aSock as any).data = (aSock as any).data || {};
        (aSock as any).data.busy = true;
        (aSock as any).data.roomId = roomId;
        (aSock as any).data.partnerSid = bSock.id;
        (aSock as any).data.inCall = true;
      }
      (bSock as any).data = (bSock as any).data || {};
      (bSock as any).data.busy = true;
      (bSock as any).data.roomId = roomId;
      (bSock as any).data.partnerSid = aSock?.id ?? null;
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
      
      // КРИТИЧНО: Логируем детали перед созданием токенов
      console.log('[call:accept] Creating LiveKit tokens', {
        linkA: link.a,
        linkB: link.b,
        aSockId: aSock.id,
        bSockId: bSock.id,
        aSockUserId: (aSock as any)?.data?.userId,
        bSockUserId: (bSock as any)?.data?.userId,
        livekitIdentityA,
        livekitIdentityB,
        livekitRoomName,
        roomId,
      });
      
      try {
        const [tokenA, tokenB] = await Promise.all([
          createToken({ identity: livekitIdentityA, roomName: livekitRoomName }),
          createToken({ identity: livekitIdentityB, roomName: livekitRoomName }),
        ]);
        livekitTokenA = tokenA;
        livekitTokenB = tokenB;
        // КРИТИЧНО: Используем console.log вместо logger.debug для гарантированного вывода
        console.log('[call:accept] ✅ LiveKit tokens created successfully', { 
          roomName: livekitRoomName, 
          identityA: livekitIdentityA, 
          identityB: livekitIdentityB,
          tokenALength: tokenA?.length || 0,
          tokenBLength: tokenB?.length || 0,
          linkA: link.a,
          linkB: link.b,
        });
        logger.debug('LiveKit tokens created for call:accept', { roomName: livekitRoomName, identityA: livekitIdentityA, identityB: livekitIdentityB });
      } catch (e: any) {
        console.error('[call:accept] ❌ Failed to create LiveKit tokens:', e);
        logger.error('Failed to create LiveKit tokens for call:accept', { error: (e as any)?.message || String(e) });
      }
      
      // Отправляем call:accepted с LiveKit credentials
      if (aSock) {
        try {
          console.log('[call:accept] 📤 Sending call:accepted to participant A', {
            callId: id,
            socketId: aSock.id,
            userId: link.a,
            hasToken: !!livekitTokenA,
            roomName: livekitRoomName,
            tokenLength: livekitTokenA?.length || 0,
            identity: livekitIdentityA,
          });
          aSock.emit('call:accepted', { 
            callId: id, 
            from: bSock?.id, 
            fromUserId: link.b, 
            roomId,
            livekitToken: livekitTokenA,
            livekitRoomName,
            livekitUrl: getLiveKitUrl() || null,
          });
          console.log('[call:accept] ✅ call:accepted sent to participant A');
        } catch (e) {
          console.error('[call:accept] ❌ Error sending call:accepted to participant A:', e);
        }
      }
      if (bSock) {
        try {
          console.log('[call:accept] 📤 Sending call:accepted to participant B', {
            callId: id,
            socketId: bSock.id,
            userId: link.b,
            hasToken: !!livekitTokenB,
            roomName: livekitRoomName,
            tokenLength: livekitTokenB?.length || 0,
            identity: livekitIdentityB,
          });
          bSock.emit('call:accepted', { 
            callId: id, 
            from: aSock?.id, 
            fromUserId: link.a, 
            roomId,
            livekitToken: livekitTokenB,
            livekitRoomName,
            livekitUrl: getLiveKitUrl() || null,
          });
          console.log('[call:accept] ✅ call:accepted sent to participant B');
        } catch (e) {
          console.error('[call:accept] ❌ Error sending call:accepted to participant B:', e);
        }
      }
      
      // Инициатор (A) офлайн — сохраняем данные; при reauth отправим call:accepted и он подключится в комнату
      if (!aSock) {
        try {
          activeRoomByUserId.set(link.a, { callId: id, roomId, livekitRoomName, peerUserId: link.b });
          logger.info('[call:accept] Caller offline, stored pending call for reauth', { userId: link.a, roomId, callId: id });
        } catch {}
      }
      // Fallback: отправить через комнату, если прямой сокет не найден (редкий случай)
      try {
        if (!bSock) {
          io.to(`u:${link.b}`).emit('call:accepted', { 
            callId: id, from: aSock?.id, fromUserId: link.a, roomId,
            livekitToken: livekitTokenB, livekitRoomName, livekitUrl: getLiveKitUrl() || null,
          });
        }
      } catch {}
      
      logger.debug('Direct call room established', { roomId, callId: id, aConnected: !!aSock, bConnected: !!bSock });
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
    try { await sendCallDeclinedToCaller(link.a, id); } catch (e: any) { logger.warn('[call:decline] sendCallDeclinedToCaller failed', { error: e?.message }); }
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
    // FCM data-only получателю: на устройстве сразу снимаем уведомление и закрываем IncomingCallActivity без мельканий
    try { await sendCallCanceledToRecipient(link.b, id); } catch (e: any) { logger.warn('[call:cancel] sendCallCanceledToRecipient failed', { error: e?.message }); }
    // Пуш получателю: вибрация остановится (снимем уведомление), клиент покажет «Пропущенный от X» без вибрации
    let fromNick: string | undefined;
    try {
      if (isMongoReady()) {
        const u = await User.findById(link.a).select('nick').lean();
        if (u && typeof (u as any).nick === 'string') fromNick = String((u as any).nick).trim() || undefined;
      }
    } catch {}
    try {
      await sendPushToUser(link.b, {
        kind: 'call',
        title: '',
        body: '',
        channelId: 'calls',
        data: { type: 'call_ended', callId: id, from: link.a, fromNick: fromNick || '' },
      });
    } catch (e: any) {
      logger.warn('[call:cancel] call_ended push failed', { peerId: link.b, error: e?.message });
    }
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
      logger.error('Error handling partner:away', { error: (e as any)?.message || String(e) });
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
      logger.error('Error handling partner:returned', { error: (e as any)?.message || String(e) });
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
    // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
    if (!isMongoReady()) {
      return res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
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
  try {
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
      logger.info('Server running on', { urls: urls.join(', ') });
    } else {
      logger.info(`Server running on http://${HOST}:${port}`);
    }
  } catch (e: any) {
    // Some sandboxed environments can fail os.networkInterfaces().
    logger.warn('Failed to list LAN interfaces, falling back to HOST', { error: e?.message || String(e) });
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
