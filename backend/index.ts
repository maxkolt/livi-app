// backend/index.ts
import dotenv from "dotenv";
dotenv.config();

import express from 'express';
import crypto from 'crypto';
import { logger } from './utils/logger';
import { auditNickChange } from './utils/profileNickAudit';
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
import moderationRouter from './routes/moderation';
import registerFriendSockets from './sockets/friends';
import registerIdentitySockets, { bindUser as bindUserIdentity } from './sockets/identity';
import registerMessageSockets from './sockets/messagesReliable';
import { socketHandler } from './sockets/handler';
import { bindAvatarSockets } from './sockets/avatar';
import { setIoInstance } from './utils/ioInstance';
import { setGetEffectiveBusy } from './utils/effectiveBusy';
import User from './models/User';
import Install from './models/Install';
import MissedCall from './models/MissedCall';
import createChatRouter from './routes/chat';
import { buildAvatarDataUris } from './utils/avatars';
import { createToken, getLiveKitUrl, isAllowedParticipant } from './routes/livekit';
import {
  sendPushToUser,
  sendCallPushToRecipient,
  sendCallEscalationPushToRecipient,
  sendCallCanceledToRecipient,
  sendCallMissedToRecipient,
  sendCallEndedToPeer,
  sendCallDeclinedToCaller,
  sendCallAcceptedToCaller,
  getCallKitUuid,
} from './utils/push';
import { pushLog } from './utils/pushLogBuffer';
import * as queueStore from './utils/queueStore';
import * as rateLimitStore from './utils/rateLimit';
import * as capacityMetrics from './utils/capacityMetrics';
import { startQueueCleanup, stopQueueCleanup, tryMatch } from './sockets/match';
import { onSocketDisconnectWebRTC } from './sockets/webrtc';
import {
  dissolveSocketIoRoom,
  evictExtraUserSocketsInDirectRoom,
  sanitizeDirectCallSocketIoRoom,
  setOnCallSocketDetached,
} from './sockets/directCallRoom';
import {
  addCallEvent,
  callFeatureFlags,
  createOrchestratedCall,
  finalizeCall,
  getCallTimeline,
  getCallTimelineFromDb,
  getOrchestrationMetrics,
  getOrchestrationMetricsFromDb,
  markIncomingShown as markIncomingShownOrchestration,
  markProviderDelivered,
  pruneOrchestratedCall,
  transitionCall,
} from './utils/callOrchestration';
import { callProviderAdapter, callProviderMode } from './utils/callProvider';
import { isShuttingDown, setShuttingDown } from './utils/shutdownState';
import {
  touchStickyForegroundOnline,
  clearStickyForegroundOnline,
  STICKY_FOREGROUND_ONLINE_MS,
} from './utils/visibleOnline';
import {
  getFriendVisibleOnlineUserIds,
  emitGlobalFriendPresence,
  scheduleGlobalFriendPresenceEmit,
  applyFastOfflineAfterCallIfAllSocketsBackground,
  scheduleDebouncedClearBackgroundOnForeground,
  cancelDebouncedForegroundAck,
  armInAppOfflinePresenceEmit,
  cancelInAppOfflinePresenceEmit,
} from './utils/friendOnlinePresence';
import { areFriendsCached, getFriendIds, getFriendIdsForUsers } from './utils/friendshipUtils';
import { isSocketIoRedisAdapterActive, setupSocketIoRedisAdapter } from './utils/socketIoRedisAdapter';

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

// Второй TURN (дополнительный VPS для лучшей доступности и распределения нагрузки)
const TURN_HOST_2 = (process.env.TURN_HOST_2 || '').trim();
const TURN_SECRET_2 = (process.env.TURN_SECRET_2 || '').trim();
const TURN_PORT_2 = Number(process.env.TURN_PORT_2 || 3478);
const TURN_ENABLE_TCP_2 = String(process.env.TURN_ENABLE_TCP_2 || '1') === '1';
const TURN_ENABLE_TCP_443_2 = String(process.env.TURN_ENABLE_TCP_443_2 || process.env.TURN_TCP_443_2 || '0') === '1';

// Проверка что TURN_HOST задан (критично для продакшена)
if (!TURN_HOST) {
  logger.warn('[TURN] ⚠️ TURN_HOST not configured! TURN credentials will not work.');
  logger.warn('[TURN] Set TURN_HOST environment variable (use domain, not IP for production)');
}
const TURN_ENABLE_TCP = String(process.env.TURN_ENABLE_TCP || '1') === '1';
// TCP/443 часто занят HTTPS (api/livekit). Поэтому включаем его ТОЛЬКО по явному флагу.
const TURN_ENABLE_TCP_443 = String(process.env.TURN_ENABLE_TCP_443 || process.env.TURN_TCP_443 || '0') === '1';
const TURN_TTL_SECONDS = Number(process.env.TURN_TTL || 600); // 10 min default
const CALL_OBSERVABILITY_API_KEY = String(process.env.CALL_OBSERVABILITY_API_KEY || '').trim();

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
if (TURN_HOST_2 && TURN_SECRET_2) {
  logger.info('[TURN] ✅ Second TURN (TURN_2) configured', {
    turnHost2: TURN_HOST_2.includes('.') ? TURN_HOST_2.split('.').slice(-2).join('.') : 'set',
    turnPort2: TURN_PORT_2,
  });
} else if (TURN_HOST_2 || TURN_SECRET_2) {
  logger.warn('[TURN] ⚠️ TURN_2 incomplete: set both TURN_HOST_2 and TURN_SECRET_2 to enable second TURN.');
}

/* ========= Helpers ========= */
const isOid = (s?: string) => !!s && /^[a-f\d]{24}$/i.test(String(s));
/** Mongo ObjectId as string is case-insensitive; rooms u:<id> and Map keys must match DB/client casing. */
const normalizeMongoObjectId = (s: string) => {
  const t = String(s || '').trim();
  return isOid(t) ? t.toLowerCase() : t;
};
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

// json/urlencoded парсеры — один раз и до роутеров.
// Legacy base64 media upload owns a smaller route-local JSON limit; large media must use multipart streaming.
const defaultJsonParser = express.json({ limit: '50mb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/upload/media') return next();
  return defaultJsonParser(req, res, next);
});
app.use('/chat', createChatRouter());
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
let closeSocketIoRedisAdapter: (() => Promise<void>) | null = null;

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
app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    mongo: mongoose.connection.readyState,
    socketIoRedisAdapter: isSocketIoRedisAdapterActive(),
    rateLimit: rateLimitStore.getRateLimitHealth(),
  })
);

// Capacity: только при CAPACITY_METRICS_ENABLED=1. В проде — 404.
app.get('/metrics', (_req, res) => {
  if (!capacityMetrics.isCapacityMetricsEnabled()) return res.status(404).end();
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(capacityMetrics.getPrometheusText());
});

app.get('/api/capacity/stats', (_req, res) => {
  if (!capacityMetrics.isCapacityMetricsEnabled()) return res.status(404).end();
  res.json(capacityMetrics.getStats());
});

app.post('/api/capacity/client-metrics', express.json(), (req, res) => {
  if (!capacityMetrics.isCapacityMetricsEnabled()) return res.status(404).end();
  try {
    const body = req.body || {};
    const num = (v: unknown) =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
    capacityMetrics.recordClientMetrics({
      joinTimeMs: num(body.joinTimeMs),
      remoteMediaFirstSeenMs: num(body.remoteMediaFirstSeenMs),
      acceptAckLatencyMs: num(body.acceptAckLatencyMs),
      livekitConnectLatencyMs: num(body.livekitConnectLatencyMs),
      publishLatencyMs: num(body.publishLatencyMs),
      subscribeLatencyMs: num(body.subscribeLatencyMs),
      timeToFirstRemoteFrameMs: num(body.timeToFirstRemoteFrameMs),
      remoteMediaStageBreakdown: !!body.remoteMediaStageBreakdown,
      rttMs: num(body.rttMs),
      packetLoss: num(body.packetLoss),
      reconnect: !!body.reconnect,
      joinSuccess: !!body.joinSuccess,
      joinFailure: !!body.joinFailure,
      roomReconnecting: !!body.roomReconnecting,
      roomReconnected: !!body.roomReconnected,
      remoteParticipantConnected: !!body.remoteParticipantConnected,
      remoteMediaTimeout: !!body.remoteMediaTimeout,
      remoteMediaRecovered: !!body.remoteMediaRecovered,
      relayFallback: !!body.relayFallback,
      remoteMediaNoParticipantTimeout: !!body.remoteMediaNoParticipantTimeout,
      remoteMediaNoParticipantAttempts: num(body.remoteMediaNoParticipantAttempts),
    });
    res.json({ ok: true });
  } catch {
    res.status(400).json({ ok: false });
  }
});

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
app.use('/api', moderationRouter);

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

    const [me, peer, meFriendWithPeer] = await Promise.all([
      User.findById(meId).select('nick avatar').lean(),
      User.findById(peerId).select('nick avatar').lean(),
      areFriendsCached(meId, peerId),
    ]) as [LeanUser | null, LeanUser | null, boolean];

    if (!me || !peer) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        meExists: !!me,
        peerExists: !!peer,
      });
    }

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
    const req = _req as express.Request & { userId?: string; installId?: string };
    const installId = String(req.installId || '').trim();
    if (!installId) {
      logger.warn('[TURN] Unauthorized TURN credentials request, returning STUN only', {
        hasInstallId: !!installId,
      });
      return res.status(401).json({
        ok: false,
        error: 'unauthorized',
        ttl: 300,
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
      });
    }
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

    // Второй TURN (дополнительный VPS) — те же креды по времени, свой секрет для HMAC
    if (TURN_HOST_2 && TURN_SECRET_2) {
      const hmac2 = crypto
        .createHmac('sha1', TURN_SECRET_2)
        .update(username)
        .digest('base64');
      iceServers.push({ urls: `turn:${TURN_HOST_2}:${TURN_PORT_2}`, username, credential: hmac2 });
      if (TURN_ENABLE_TCP_2) {
        iceServers.push({ urls: `turn:${TURN_HOST_2}:${TURN_PORT_2}?transport=tcp`, username, credential: hmac2 });
        if (TURN_ENABLE_TCP_443_2) {
          iceServers.push({ urls: `turn:${TURN_HOST_2}:443?transport=tcp`, username, credential: hmac2 });
        }
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
    const user = await User.findById(userId).select('nick avatar avatarVer').lean();
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
        friends: await getFriendIds(String(userId)),
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
      // Не возвращаем exists:false — клиент делает hard reset и теряет identity (см. socket user:exists).
      return res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
    const exists = await User.exists({ _id: userId });
    return res.json({ ok: true, exists: !!exists });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

/* ========= Mongo ========= */
mongoose
  .connect(MONGO_URI, {
    maxPoolSize: 50,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  })
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
  return getFriendVisibleOnlineUserIds(io);
}
function bindUser(sock: AuthedSocket, userId: string) {
  const uid = normalizeMongoObjectId(String(userId));
  (sock as any).data.userId = uid;
  try {
    sock.join(`u:${uid}`);
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

function getSocketsForUser(io: Server, userId: string): AuthedSocket[] {
  const uid = normalizeMongoObjectId(String(userId || ''));
  if (!uid) return [];
  const room = io.sockets.adapter.rooms.get(`u:${uid}`);
  if (!room || room.size === 0) return [];
  const sockets: AuthedSocket[] = [];
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid) as AuthedSocket | undefined;
    if (!s) continue;
    const suid = normalizeMongoObjectId(String((s as any)?.data?.userId || ''));
    if (suid === uid) sockets.push(s);
  }
  return sockets;
}

function findSocketForUser(io: Server, userId: string): AuthedSocket | undefined {
  return getSocketsForUser(io, userId)[0];
}

function hasSocketForUser(io: Server, userId: string): boolean {
  return getSocketsForUser(io, userId).length > 0;
}

function forEachSocketForUser(io: Server, userId: string, fn: (sock: AuthedSocket) => void): void {
  for (const s of getSocketsForUser(io, userId)) fn(s);
}

function emitPresence(io: Server, userId?: string | null) {
  const key = String(userId || '').trim();
  if (key) {
    scheduleGlobalFriendPresenceEmit(io, key);
    return;
  }
  void emitGlobalFriendPresence(io);
}

const PRESENCE_DISCONNECT_GRACE_MS = 2500;
const pendingPresenceOfflineByUserId = new Map<string, ReturnType<typeof setTimeout>>();
const lastBroadcastBusyByUserId = new Map<string, boolean>();

function clearPendingPresenceOffline(userId?: string | null): void {
  const key = String(userId || '').trim();
  if (!key) return;
  const pending = pendingPresenceOfflineByUserId.get(key);
  if (pending) {
    clearTimeout(pending);
    pendingPresenceOfflineByUserId.delete(key);
  }
}

/** По истечении STICKY_FOREGROUND_ONLINE_MS снимаем «липкий» онлайн и шлём актуальный список. */
const stickyForegroundPresenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelStickyForegroundPresenceTimer(userId: string): void {
  const key = String(userId || '').trim();
  if (!key) return;
  const t = stickyForegroundPresenceTimers.get(key);
  if (t) clearTimeout(t);
  stickyForegroundPresenceTimers.delete(key);
}

function armStickyForegroundPresenceResolution(io: Server, userId: string): void {
  const key = String(userId || '').trim();
  if (!key) return;
  cancelStickyForegroundPresenceTimer(key);
  const t = setTimeout(() => {
    stickyForegroundPresenceTimers.delete(key);
    clearStickyForegroundOnline(key);
    emitPresence(io, key);
  }, STICKY_FOREGROUND_ONLINE_MS);
  stickyForegroundPresenceTimers.set(key, t);
}

function clearStickyPresenceStateForUser(userId: string): void {
  const key = String(userId || '').trim();
  if (!key) return;
  clearStickyForegroundOnline(key);
  cancelStickyForegroundPresenceTimer(key);
}

function hasAnyOnlineSocketForUser(io: Server, userId: string): boolean {
  return hasSocketForUser(io, userId);
}

function schedulePresenceEmitAfterDisconnect(io: Server, userId?: string | null): void {
  const key = String(userId || '').trim();
  if (!key) {
    emitPresence(io);
    return;
  }
  clearPendingPresenceOffline(key);
  const t = setTimeout(() => {
    pendingPresenceOfflineByUserId.delete(key);
    // Пользователь мог переподключиться в пределах grace-окна.
    if (hasAnyOnlineSocketForUser(io, key)) return;
    lastBroadcastBusyByUserId.delete(key);
    emitPresence(io, key);
  }, PRESENCE_DISCONNECT_GRACE_MS);
  pendingPresenceOfflineByUserId.set(key, t);
}

/**
 * Оптимизированная отправка presence:update только друзьям пользователя
 * Вместо отправки всем подключенным (io.emit), отправляем только заинтересованным
 * Это критично для масштабирования: при 100k пользователей вместо 100k отправок - только друзьям (~50)
 */
async function emitPresenceUpdateToFriends(io: Server, userId: string, busy: boolean) {
  try {
    if (!userId) return;
    lastBroadcastBusyByUserId.set(String(userId), !!busy);

    // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
    if (!isMongoReady()) {
      // Если БД недоступна, просто отправляем событие самому пользователю
      io.to(`u:${userId}`).emit('presence:update', { userId, busy });
      return;
    }
    const friends = await getFriendIds(userId);
    if (friends.length === 0) {
      // Если друзей нет, отправляем только самому пользователю (для синхронизации состояния)
      io.to(`u:${userId}`).emit('presence:update', { userId, busy });
      return;
    }

    // Отправляем обновление только друзьям через их комнаты
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
  } finally {
    scheduleGlobalFriendPresenceEmit(io, userId);
  }
}

/**
 * Рассылает busy для обоих участников звонка всем друзьям обоих.
 * Чтобы у общего друга (напр. зритель списка) оба участника отображались «Занято».
 */
async function emitPresenceUpdateCallToFriends(
  io: Server,
  userIdA: string,
  userIdB: string,
  busy: boolean
) {
  if (!userIdA || !userIdB) {
    if (userIdA) await emitPresenceUpdateToFriends(io, userIdA, busy);
    if (userIdB) await emitPresenceUpdateToFriends(io, userIdB, busy);
    return;
  }
  try {
    if (!isMongoReady()) {
      io.to(`u:${userIdA}`).emit('presence:update', { userId: userIdA, busy });
      io.to(`u:${userIdB}`).emit('presence:update', { userId: userIdB, busy });
      return;
    }
    const friendMap = await getFriendIdsForUsers([userIdA, userIdB]);
    const friendsA = friendMap.get(userIdA) || [];
    const friendsB = friendMap.get(userIdB) || [];
    const allFriendIds = [...new Set([...friendsA, ...friendsB])];
    for (const friendId of allFriendIds) {
      try {
        io.to(`u:${friendId}`).emit('presence:update', { userId: userIdA, busy });
        io.to(`u:${friendId}`).emit('presence:update', { userId: userIdB, busy });
      } catch {}
    }
    io.to(`u:${userIdA}`).emit('presence:update', { userId: userIdA, busy });
    io.to(`u:${userIdA}`).emit('presence:update', { userId: userIdB, busy });
    io.to(`u:${userIdB}`).emit('presence:update', { userId: userIdA, busy });
    io.to(`u:${userIdB}`).emit('presence:update', { userId: userIdB, busy });
  } catch (e) {
    try {
      await emitPresenceUpdateToFriends(io, userIdA, busy);
      await emitPresenceUpdateToFriends(io, userIdB, busy);
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

function emitFriendRoomState(roomId: string, participants: string[]) {
  const payload = { roomId, participants };
  try {
    io.to(roomId).emit('friends:room_state', payload);
  } catch {}
  for (const userId of participants) {
    try {
      io.to(`u:${String(userId)}`).emit('friends:room_state', payload);
    } catch {}
  }
}

const setFriendRoomState = (roomId: string, participants: string[]) => {
  if (participants.length === 0) {
    friendRooms.delete(roomId);
  } else {
    friendRooms.set(roomId, [...participants]);
  }

  emitFriendRoomState(roomId, participants);
};

// Функция для обновления состояния дружеской комнаты
const updateFriendRoomState = async (io: Server, roomId: string) => {
  // Проверяем, что это дружеская комната (не рандом)
  if (!roomId.startsWith('room_')) return;

  let sockets: Awaited<ReturnType<Server['fetchSockets']>> = [];
  try {
    sockets = await io.in(roomId).fetchSockets();
  } catch {
    return;
  }
  if (sockets.length === 0) return;

  const participants = Array.from(new Set(
    sockets
      .map((socket: any) => String(socket?.data?.userId || ''))
      .filter((userId: string) => isOid(userId))
  ));
  emitFriendRoomState(roomId, participants);
};

// tryPairFor и pairAndNotify удалены - теперь используется единая система матчинга через match.ts
// Все функции матчинга теперь используют tryMatch из match.ts через queueStore

// findRandom/cancelRandom удалены - используется match.ts

/* ========= Direct Calls (P2P invite) ========= */
const CALL_RING_TIMEOUT_MS = 27_000;
type CallLink = {
  a: string;
  b: string;
  createdAtMs: number;
  expiresAtMs: number;
  timer?: NodeJS.Timeout;
  retryPushTimer?: NodeJS.Timeout;
  media?: 'audio' | 'video';
};
const callsById = new Map<string, CallLink>();
const callOfUser = new Map<string, { with: string; callId: string }>();
type CallDeliveryTelemetry = {
  callerId: string;
  calleeId: string;
  createdAtMs: number;
  expiresAtMs: number;
  callerNick?: string;
  pushSentAtMs?: number;
  incomingShownAtMs?: number;
  incomingShownBy?: 'socket' | 'native_http';
  retryPushCount?: number;
  escalationPushCount?: number;
  closeReason?: 'accepted' | 'declined' | 'canceled' | 'timeout' | 'ended';
  purgeTimer?: NodeJS.Timeout;
};
const callDeliveryById = new Map<string, CallDeliveryTelemetry>();
// Активный callId для конкретного socket.id (после accept)
const activeCallBySocket = new Map<string, string>();

async function persistDirectCallSharedState(callId: string, link: CallLink): Promise<void> {
  await queueStore.setDirectCall(callId, {
    a: link.a,
    b: link.b,
    createdAtMs: link.createdAtMs,
    expiresAtMs: link.expiresAtMs,
  });
  await queueStore.setUserDirectCall(link.a, {
    with: link.b,
    callId,
    expiresAtMs: link.expiresAtMs,
  });
  await queueStore.setUserDirectCall(link.b, {
    with: link.a,
    callId,
    expiresAtMs: link.expiresAtMs,
  });
}

async function clearDirectCallSharedState(callId: string, link?: { a: string; b: string }): Promise<void> {
  const resolved =
    link ??
    (await queueStore.getDirectCall(callId)) ?? {
      a: '',
      b: '',
    };
  await queueStore.removeDirectCall(callId);
  if (resolved.a) await queueStore.clearUserDirectCall(resolved.a, callId);
  if (resolved.b) await queueStore.clearUserDirectCall(resolved.b, callId);
}

/** Accepted / in-call: ringing maps and Redis must not drive incoming_replay or false timeouts. */
function isDirectCallAcceptedOrActive(callId: string, link?: { a: string; b: string } | null): boolean {
  const timeline = getCallTimeline(callId);
  if (timeline?.state === 'accepted') return true;
  if (callIdToRoomId.has(callId)) return true;
  if (link) {
    if (activeRoomByUserId.has(link.a) || activeRoomByUserId.has(link.b)) return true;
  } else {
    for (const pending of activeRoomByUserId.values()) {
      if (pending.callId === callId) return true;
    }
  }
  return false;
}

/** After accept: drop ringing occupancy (memory + Redis) while keeping activeRoom / callIdToRoomId for call:end. */
async function releaseRingingCallPersistence(callId: string, link: { a: string; b: string }): Promise<void> {
  const local = callsById.get(callId);
  if (local?.timer) {
    try {
      clearTimeout(local.timer);
    } catch {}
  }
  if (local?.retryPushTimer) {
    try {
      clearTimeout(local.retryPushTimer);
    } catch {}
  }
  callsById.delete(callId);
  callOfUser.delete(link.a);
  callOfUser.delete(link.b);
  try {
    await clearDirectCallSharedState(callId, link);
  } catch (e: any) {
    logger.warn('[call:accept] release ringing persistence failed', { callId, error: e?.message });
  }
}

/** Stale Redis/user entries left after accept or reconnect — no delivery_summary / no call:timeout. */
async function purgeStaleRingingDirectCallArtifacts(
  callId: string,
  link: { a: string; b: string },
  reason: string,
): Promise<void> {
  if (isDirectCallAcceptedOrActive(callId, link)) {
    logger.info('[call:ringing_state] purging stale ringing persistence (call active)', {
      callId,
      reason,
      caller: link.a,
      callee: link.b,
    });
    callOfUser.delete(link.a);
    callOfUser.delete(link.b);
    try {
      await clearDirectCallSharedState(callId, link);
    } catch (e: any) {
      logger.warn('[call:ringing_state] clear shared state failed', { callId, error: e?.message });
    }
    if (!isDirectCallAcceptedOrActive(callId, link)) {
      callsById.delete(callId);
    }
    return;
  }
  callOfUser.delete(link.a);
  callOfUser.delete(link.b);
  callsById.delete(callId);
  try {
    await clearDirectCallSharedState(callId, link);
  } catch (e: any) {
    logger.warn('[call:ringing_state] clear shared state failed', { callId, error: e?.message });
  }
}

async function getCallLinkFromAnyStore(callId: string): Promise<CallLink | null> {
  const local = callsById.get(callId);
  if (local) return local;
  const shared = await queueStore.getDirectCall(callId);
  if (!shared) return null;
  const hydrated: CallLink = {
    a: shared.a,
    b: shared.b,
    createdAtMs: shared.createdAtMs,
    expiresAtMs: shared.expiresAtMs,
  };
  callsById.set(callId, hydrated);
  return hydrated;
}

async function getUserCallEntryFromAnyStore(userId: string): Promise<{ with: string; callId: string; expiresAtMs?: number } | null> {
  const local = callOfUser.get(userId);
  if (local) {
    const link = callsById.get(local.callId);
    if (link) return { ...local, expiresAtMs: link.expiresAtMs };
    callOfUser.delete(userId);
  }
  const shared = await queueStore.getUserDirectCall(userId);
  if (!shared) return null;
  const hydrated = { with: shared.with, callId: shared.callId };
  callOfUser.set(userId, hydrated);
  return { ...hydrated, expiresAtMs: shared.expiresAtMs };
}

/** Если звонок уже инициирован, а сокет callee появился позже (reconnect / гонка с bind) — повторить call:incoming по прямому emit. */
async function replayIncomingToCalleeIfRinging(sock: AuthedSocket, userId: string) {
  try {
    const uid = normalizeMongoObjectId(String(userId || ''));
    if (!isOid(uid)) return;
    if (activeRoomByUserId.has(uid)) return;
    const entry = await getUserCallEntryFromAnyStore(uid);
    if (!entry) return;
    const link = await getCallLinkFromAnyStore(entry.callId);
    if (!link || link.b !== uid) return;
    if (isDirectCallAcceptedOrActive(entry.callId, link)) {
      await purgeStaleRingingDirectCallArtifacts(entry.callId, link, 'incoming_replay_active');
      return;
    }
    if (link.expiresAtMs <= Date.now()) {
      logger.info('[call:incoming_replay] skipped expired ringing call', {
        callId: entry.callId,
        callee: uid,
        expiresAtMs: link.expiresAtMs,
      });
      // Expired ringing call should be finalized once and removed from memory/shared stores,
      // otherwise reauth/user-bind can keep producing the same skip log in a loop.
      cleanupCall(entry.callId, 'timeout');
      return;
    }
    const telemetry = callDeliveryById.get(entry.callId);
    if (telemetry?.incomingShownAtMs != null) return;
    const fromNick =
      telemetry?.callerNick != null && String(telemetry.callerNick).trim() !== ''
        ? String(telemetry.callerNick).trim()
        : undefined;
    try {
      sock.emit('call:incoming', {
        callId: entry.callId,
        callKitId: getCallKitUuid(entry.callId),
        from: link.a,
        fromNick,
        ts: link.createdAtMs,
        expiresAt: link.expiresAtMs,
      });
      sock.emit('friend:call:incoming', { callId: entry.callId, from: link.a, nick: fromNick });
      logger.info('[call:incoming_replay] delivered on user bind', {
        callId: entry.callId,
        callee: uid,
        socketId: sock.id,
      });
    } catch (e: any) {
      logger.warn('[call:incoming_replay] emit failed', { error: e?.message });
    }
  } catch (e: any) {
    logger.warn('[call:incoming_replay] error', { error: e?.message });
  }
}
setOnCallSocketDetached((sid) => {
  try {
    activeCallBySocket.delete(sid);
  } catch {}
});
/** callId -> roomId после call:accept (для call:end, когда клиент присылает только callId, напр. принятие из пуша) */
const callIdToRoomId = new Map<string, string>();
/** roomId/callId, для которых call:end уже обработан недавно (защита от дублирующих call:end). */
const recentlyEndedCalls = new Map<string, ReturnType<typeof setTimeout>>();
/** Участник не был подключён в момент call:accept — при reauth отправим ему call:accepted и он подключится в комнату */
type PendingAcceptedRoom = {
  callId: string;
  roomId: string;
  livekitRoomName: string;
  peerUserId: string;
};
const activeRoomByUserId = new Map<string, PendingAcceptedRoom>();
type CallAcceptedDeliverySource = 'call:accept' | 'reauth' | 'call:getAccepted';
type CallAcceptedDeliveryState = PendingAcceptedRoom & {
  deliveredAtMs?: number;
  deliveredSource?: CallAcceptedDeliverySource;
  deliveredSocketId?: string;
};
const callAcceptedDeliveryByKey = new Map<string, CallAcceptedDeliveryState>();
// Пользователь занят рандом-видеочатом (по userId) — используется также для findRandom

function clearAcceptedCallStateForUser(userId: string, reason: string): string | null {
  const uid = normalizeMongoObjectId(String(userId || ''));
  if (!isOid(uid)) return null;
  const pending = activeRoomByUserId.get(uid);
  const entry = callOfUser.get(uid);
  const callId = pending?.callId || entry?.callId || null;
  const roomId = pending?.roomId || (callId ? callIdToRoomId.get(callId) : null) || null;
  const peerId = pending?.peerUserId || entry?.with || null;
  const ids = [uid, peerId ? normalizeMongoObjectId(String(peerId)) : ''].filter((id) => isOid(id));

  for (const id of ids) {
    callOfUser.delete(id);
    activeRoomByUserId.delete(id);
    if (callId) callAcceptedDeliveryByKey.delete(getCallAcceptedDeliveryKey(callId, id));
  }
  if (callId) {
    const linkForRedis = callsById.get(callId);
    callsById.delete(callId);
    callIdToRoomId.delete(callId);
    const peerForRedis =
      linkForRedis != null
        ? { a: linkForRedis.a, b: linkForRedis.b }
        : peerId && isOid(normalizeMongoObjectId(String(peerId)))
          ? { a: uid, b: normalizeMongoObjectId(String(peerId)) }
          : undefined;
    void clearDirectCallSharedState(callId, peerForRedis).catch((e) => {
      logger.warn('[call:clearAccepted] clear shared state failed', { callId, error: (e as Error)?.message });
    });
  }
  if (roomId) {
    for (const [sid, activeRoom] of activeCallBySocket.entries()) {
      if (activeRoom === roomId) activeCallBySocket.delete(sid);
    }
  }
  for (const id of ids) {
    forEachSocketForUser(io, id, (s) => {
      (s as any).data = (s as any).data || {};
      (s as any).data.busy = false;
      delete (s as any).data.roomId;
      delete (s as any).data.partnerSid;
      delete (s as any).data.inCall;
      try { activeCallBySocket.delete(s.id); } catch {}
    });
  }
  return callId;
}

function getCallAcceptedDeliveryKey(callId: string, userId: string): string {
  return `${String(callId)}:${String(userId)}`;
}

function getCallAcceptedDeliveryState(callId: string, userId: string): CallAcceptedDeliveryState | undefined {
  return callAcceptedDeliveryByKey.get(getCallAcceptedDeliveryKey(callId, userId));
}

function rememberCallAcceptedDelivery(
  callId: string,
  userId: string,
  pendingRoom: PendingAcceptedRoom,
  meta?: {
    source?: CallAcceptedDeliverySource;
    socketId?: string | null;
  },
): CallAcceptedDeliveryState {
  const key = getCallAcceptedDeliveryKey(callId, userId);
  const prev = callAcceptedDeliveryByKey.get(key);
  const next: CallAcceptedDeliveryState = {
    ...(prev || {}),
    ...pendingRoom,
  };
  if (meta?.source) next.deliveredSource = meta.source;
  if (meta?.socketId) next.deliveredSocketId = meta.socketId;
  if (meta?.source && meta?.socketId) next.deliveredAtMs = Date.now();
  callAcceptedDeliveryByKey.set(key, next);
  return next;
}

function hasLiveAcceptedDeliverySocket(
  io: Server,
  state?: CallAcceptedDeliveryState,
  excludeSocketId?: string,
): boolean {
  const deliveredSocketId = String(state?.deliveredSocketId || '').trim();
  if (!deliveredSocketId) return false;
  if (excludeSocketId && deliveredSocketId === excludeSocketId) return false;
  return io.sockets.sockets.has(deliveredSocketId);
}

function socketAlreadyAttachedToPendingRoom(sock: AuthedSocket, pendingRoom: PendingAcceptedRoom): boolean {
  const currentRoomId = String(
    (sock as any)?.data?.roomId ||
    activeCallBySocket.get(sock.id) ||
    ''
  ).trim();
  const inCall = (sock as any)?.data?.inCall === true;
  const joinedSocketIoRoom = !!(sock as any)?.rooms?.has?.(pendingRoom.roomId);
  return (inCall && currentRoomId === pendingRoom.roomId) || joinedSocketIoRoom;
}

function userAlreadyHasSocketAttachedToPendingRoom(
  io: Server,
  userId: string,
  pendingRoom: PendingAcceptedRoom,
  excludeSocketId?: string,
): boolean {
  for (const candidate of getSocketsForUser(io, userId)) {
    if (excludeSocketId && candidate.id === excludeSocketId) continue;
    if (socketAlreadyAttachedToPendingRoom(candidate as AuthedSocket, pendingRoom)) {
      return true;
    }
  }
  return false;
}

async function emitPendingCallAcceptedToSocket(
  io: Server,
  sock: AuthedSocket,
  userId: string,
  pendingRoom: PendingAcceptedRoom,
  source: CallAcceptedDeliverySource,
): Promise<boolean> {
  const deliveryState = rememberCallAcceptedDelivery(pendingRoom.callId, userId, pendingRoom);
  if (socketAlreadyAttachedToPendingRoom(sock, pendingRoom)) {
    return false;
  }

  if (hasLiveAcceptedDeliverySocket(io, deliveryState, sock.id)) {
    return false;
  }

  if (userAlreadyHasSocketAttachedToPendingRoom(io, userId, pendingRoom, sock.id)) {
    return false;
  }

  const token = await createToken({ identity: userId, roomName: pendingRoom.livekitRoomName });
  evictExtraUserSocketsInDirectRoom(io, pendingRoom.roomId, userId, sock.id);
  sock.join(pendingRoom.roomId);
  activeCallBySocket.set(sock.id, pendingRoom.roomId);
  (sock as any).data = (sock as any).data || {};
  (sock as any).data.busy = true;
  (sock as any).data.roomId = pendingRoom.roomId;
  (sock as any).data.partnerSid = null;
  (sock as any).data.inCall = true;
  try {
    sanitizeDirectCallSocketIoRoom(io, pendingRoom.roomId, activeCallBySocket);
  } catch {}
  sock.emit('call:accepted', {
    callId: pendingRoom.callId,
    from: null,
    fromUserId: pendingRoom.peerUserId,
    roomId: pendingRoom.roomId,
    livekitToken: token,
    livekitRoomName: pendingRoom.livekitRoomName,
    livekitUrl: getLiveKitUrl() || null,
  });
  rememberCallAcceptedDelivery(pendingRoom.callId, userId, pendingRoom, {
    source,
    socketId: sock.id,
  });
  return true;
}

function logCallEndSkipped(callId: string, action: 'cancel' | 'timeout', source: string) {
  const timeline = getCallTimeline(callId);
  logger.info(`[call:${action}] skipped (${source})`, {
    callId,
    orchestrationState: timeline?.state ?? null,
    closeReason: timeline?.closeReason ?? null,
    stillTrackedInMemory: callsById.has(callId),
  });
}

/** Late cancel after accept (or duplicate cancel): never emit canceled delivery_summary for an active call. */
function handleCancelDeduped(callId: string, link: { a: string; b: string }, source: 'socket_deduped' | 'http_deduped'): void {
  logCallEndSkipped(callId, 'cancel', source);
  if (isDirectCallAcceptedOrActive(callId, link)) {
    void purgeStaleRingingDirectCallArtifacts(callId, link, `cancel_${source}`).catch((e: any) => {
      logger.warn('[call:cancel] dedupe stale purge failed', { callId, source, error: e?.message });
    });
    return;
  }
  if (callsById.has(callId)) cleanupCall(callId, 'canceled');
}

function cleanupCall(callId: string, reason?: 'accepted' | 'declined' | 'canceled' | 'timeout' | 'ended') {
  if (reason === 'timeout' && isDirectCallAcceptedOrActive(callId)) {
    logger.warn('[call:cleanup] skip timeout cleanup for accepted/active call', { callId });
    const linkOnly = callsById.get(callId);
    if (linkOnly) {
      void purgeStaleRingingDirectCallArtifacts(callId, { a: linkOnly.a, b: linkOnly.b }, 'cleanup_guard').catch(
        (e: any) => {
          logger.warn('[call:cleanup] stale purge failed', { callId, error: e?.message });
        },
      );
    } else {
      void clearDirectCallSharedState(callId).catch((e) => {
        logger.warn('[call:cleanup] clear shared state failed', { callId, error: (e as Error)?.message });
      });
    }
    return;
  }
  const link = callsById.get(callId);
  if (!link) {
    void clearDirectCallSharedState(callId).catch((e) => {
      logger.warn('[call:cleanup] clear shared state failed', { callId, error: (e as Error)?.message });
    });
    return;
  }
  if (link.timer) { try { clearTimeout(link.timer); } catch {} }
  if (link.retryPushTimer) { try { clearTimeout(link.retryPushTimer); } catch {} }
  callsById.delete(callId);
  callOfUser.delete(link.a);
  callOfUser.delete(link.b);
  void clearDirectCallSharedState(callId, { a: link.a, b: link.b }).catch((e) => {
    logger.warn('[call:cleanup] clear shared state failed', { callId, error: (e as Error)?.message });
  });
  callAcceptedDeliveryByKey.delete(getCallAcceptedDeliveryKey(callId, link.a));
  callAcceptedDeliveryByKey.delete(getCallAcceptedDeliveryKey(callId, link.b));
  const telemetry = callDeliveryById.get(callId);
  if (reason) finalizeCall(callId, reason);
  if (telemetry) {
    telemetry.closeReason = reason;
    logger.info('[call:delivery_summary]', {
      callId,
      caller: telemetry.callerId,
      callee: telemetry.calleeId,
      push_sent: telemetry.pushSentAtMs != null,
      incoming_shown: telemetry.incomingShownAtMs != null,
      incoming_shown_by: telemetry.incomingShownBy || null,
      retry_push_count: telemetry.retryPushCount ?? 0,
      escalation_push_count: telemetry.escalationPushCount ?? 0,
      close_reason: reason || null,
      call_duration_before_close_ms: Date.now() - telemetry.createdAtMs,
    });
    pushLog('call_delivery_summary', {
      callId,
      callerId: telemetry.callerId,
      calleeId: telemetry.calleeId,
      push_sent: telemetry.pushSentAtMs != null,
      incoming_shown: telemetry.incomingShownAtMs != null,
      incoming_shown_by: telemetry.incomingShownBy || null,
      retry_push_count: telemetry.retryPushCount ?? 0,
      escalation_push_count: telemetry.escalationPushCount ?? 0,
      close_reason: reason || null,
      ageMs: Date.now() - telemetry.createdAtMs,
    });
    if (telemetry.purgeTimer) {
      try { clearTimeout(telemetry.purgeTimer); } catch {}
    }
    telemetry.purgeTimer = setTimeout(() => {
      callDeliveryById.delete(callId);
      pruneOrchestratedCall(callId);
    }, 10 * 60_000);
  } else {
    pruneOrchestratedCall(callId);
  }
}

function clearDirectCallSocketStateForUsers(userIds: string[]): void {
  const ids = new Set(
    userIds
      .map((id) => normalizeMongoObjectId(String(id || '')))
      .filter((id) => isOid(id))
  );
  if (ids.size === 0) return;
  for (const uid of ids) {
    forEachSocketForUser(io, uid, (s) => {
      (s as any).data = (s as any).data || {};
      (s as any).data.busy = false;
      delete (s as any).data.roomId;
      delete (s as any).data.partnerSid;
      delete (s as any).data.inCall;
      try { activeCallBySocket.delete(s.id); } catch {}
    });
  }
}

async function cleanupStaleRingingCallForImmediateRetry(callerId: string, calleeId: string): Promise<void> {
  const caller = normalizeMongoObjectId(String(callerId || ''));
  const callee = normalizeMongoObjectId(String(calleeId || ''));
  if (!isOid(caller) || !isOid(callee)) return;

  const entries = await Promise.all([
    getUserCallEntryFromAnyStore(caller),
    getUserCallEntryFromAnyStore(callee),
  ]);
  const callIds = Array.from(new Set(entries.map((entry) => entry?.callId).filter(Boolean) as string[]));

  for (const callId of callIds) {
    const link = await getCallLinkFromAnyStore(callId);
    if (!link) continue;
    const samePair = link.a === caller && link.b === callee;
    if (!samePair) continue;

    const timeline = getCallTimeline(callId);
    if (timeline?.state === 'accepted') continue;

    const alreadyAccepted =
      callIdToRoomId.has(callId) ||
      activeRoomByUserId.has(link.a) ||
      activeRoomByUserId.has(link.b);
    if (alreadyAccepted) continue;

    logger.info('[call:initiate] cleaning stale ringing call before immediate retry', {
      callId,
      caller,
      callee,
      ageMs: Date.now() - Number(link.createdAtMs || Date.now()),
    });

    transitionCall(callId, 'canceled', {
      actionKey: `retry_cancel:${callId}:${caller}`,
      source: 'retry_cancel',
    });
    clearDirectCallSocketStateForUsers([link.a, link.b]);
    await emitPresenceUpdateCallToFriends(io, link.a, link.b, false);
    try {
      const sortedU = [link.a, link.b].sort();
      dissolveSocketIoRoom(io, `room_${sortedU[0]}_${sortedU[1]}`);
    } catch {}
    try { io.to(`u:${link.a}`).emit('call:cancel', { callId, from: link.a }); } catch {}
    try { io.to(`u:${link.b}`).emit('call:cancel', { callId, from: link.a }); } catch {}
    cleanupCall(callId, 'canceled');
  }
}

/**
 * Найти ключ callsById по тому, что прислал клиент в call:end: сам callId, или roomId вида room_A_B.
 * Раньше call:end не вызывал cleanupCall — callsById/callOfUser оставались до таймаута, из‑за чего следующий call:initiate давал error: busy и пуш не уходил.
 */
function resolveCallIdFromEndIdentifier(roomOrCallId: string, explicitCallId?: string): string | null {
  const ex = explicitCallId ? String(explicitCallId).trim() : '';
  if (ex) {
    if (callsById.has(ex)) return ex;
    if (callIdToRoomId.has(ex)) return ex;
    for (const pending of activeRoomByUserId.values()) {
      if (pending.callId === ex) return ex;
    }
  }
  const id = String(roomOrCallId || '').trim();
  if (!id) return null;
  if (callsById.has(id)) return id;
  if (callIdToRoomId.has(id)) return id;
  const rm = id.match(/^room_([a-f\d]{24})_([a-f\d]{24})$/i);
  if (!rm) return null;
  const u1 = normalizeMongoObjectId(rm[1]);
  const u2 = normalizeMongoObjectId(rm[2]);
  if (!isOid(u1) || !isOid(u2)) return null;
  for (const uid of [u1, u2]) {
    const pending = activeRoomByUserId.get(uid);
    if (pending?.callId) return pending.callId;
    const entry = callOfUser.get(uid);
    if (!entry?.callId) continue;
    const link = callsById.get(entry.callId);
    if (!link) continue;
    const pair = new Set([normalizeMongoObjectId(link.a), normalizeMongoObjectId(link.b)]);
    if (pair.has(u1) && pair.has(u2)) return entry.callId;
  }
  return null;
}

/** Снять залипший callOfUser, если звонка уже нет в callsById (после сбоя или старого бага). */
function pruneOrphanCallOfUserEntry(userId: string): void {
  const uid = normalizeMongoObjectId(String(userId || ''));
  if (!isOid(uid)) return;
  const entry = callOfUser.get(uid);
  if (!entry?.callId) return;
  if (callsById.has(entry.callId)) return;
  const other = entry.with ? normalizeMongoObjectId(String(entry.with)) : '';
  logger.warn('[call:initiate] pruning orphan callOfUser (no callsById)', { userId: uid, staleCallId: entry.callId });
  callOfUser.delete(uid);
  if (other && isOid(other)) callOfUser.delete(other);
}

const CALL_DELIVERY_ACK_WAIT_MS = 3_000;
const CALL_DELIVERY_RETRY_EVERY_MS = 4_000;
const CALL_DELIVERY_ESCALATE_AFTER_RETRY = 1;
const CALL_DELIVERY_RETRY_MAX_WINDOW_MS = 18_000;

function scheduleCallPushRetry(callId: string, delayMs: number) {
  const link = callsById.get(callId);
  if (!link) return;
  if (link.retryPushTimer) {
    try { clearTimeout(link.retryPushTimer); } catch {}
  }
  link.retryPushTimer = setTimeout(() => {
    void runCallPushRetryCycle(callId);
  }, delayMs);
}

async function runCallPushRetryCycle(callId: string): Promise<void> {
  const link = await getCallLinkFromAnyStore(callId);
  if (!link) {
    cleanupCall(callId);
    return;
  }
  const telemetry = callDeliveryById.get(callId);
  if (!telemetry) return;
  if (telemetry.incomingShownAtMs) {
    logger.info('[call:initiate] stop push retry: incoming already shown', { callId, callee: telemetry.calleeId });
    return;
  }
  const elapsedMs = Date.now() - telemetry.createdAtMs;
  if (Date.now() >= telemetry.expiresAtMs) {
    logger.info('[call:initiate] stop push retry: call expired', {
      callId,
      callee: telemetry.calleeId,
      expiresAtMs: telemetry.expiresAtMs,
    });
    return;
  }
  if (elapsedMs >= CALL_DELIVERY_RETRY_MAX_WINDOW_MS) {
    logger.info('[call:initiate] stop push retry: retry window elapsed', { callId, callee: telemetry.calleeId, elapsedMs });
    return;
  }

  const callerNick = telemetry.callerNick ?? '';
  const retryPushCount = telemetry.retryPushCount ?? 0;
  const shouldEscalate = retryPushCount >= CALL_DELIVERY_ESCALATE_AFTER_RETRY;
  try {
    if (shouldEscalate) {
      logger.info('[call:initiate] escalation push attempt (no incoming_shown ACK)', {
        callId,
        callee: telemetry.calleeId,
        elapsedMs,
        retryPushCount,
      });
      await sendCallEscalationPushToRecipient(telemetry.calleeId, {
        callId,
        from: telemetry.callerId,
        fromNick: callerNick,
        createdAtMs: telemetry.createdAtMs,
        expiresAtMs: telemetry.expiresAtMs,
      });
      addCallEvent(callId, 'push_escalated', 'backend_retry', {
        elapsedMs,
        retryPushCount,
      });
      telemetry.escalationPushCount = (telemetry.escalationPushCount ?? 0) + 1;
      pushLog('call_push_retry_escalation', { callId, calleeId: telemetry.calleeId, elapsedMs, retryPushCount: telemetry.retryPushCount ?? 0 });
    } else {
      logger.info('[call:initiate] retry call push attempt (no incoming_shown ACK)', {
        callId,
        callee: telemetry.calleeId,
        elapsedMs,
        retryPushCount,
      });
      await sendCallPushToRecipient(telemetry.calleeId, {
        callId,
        from: telemetry.callerId,
        fromNick: callerNick,
        createdAtMs: telemetry.createdAtMs,
        expiresAtMs: telemetry.expiresAtMs,
      });
      addCallEvent(callId, 'push_retry', 'backend_retry', {
        elapsedMs,
        retryPushCount,
      });
      telemetry.retryPushCount = retryPushCount + 1;
      if (!telemetry.pushSentAtMs) telemetry.pushSentAtMs = Date.now();
      pushLog('call_push_retry_data_only', { callId, calleeId: telemetry.calleeId, elapsedMs, retryPushCount: telemetry.retryPushCount });
    }
    callDeliveryById.set(callId, telemetry);
  } catch (e: any) {
    logger.warn('[call:initiate] retry/escalation push failed', {
      callId,
      callee: telemetry.calleeId,
      elapsedMs,
      shouldEscalate,
      error: e?.message,
    });
  }

  if (!callsById.has(callId)) return;
  const latest = callDeliveryById.get(callId);
  if (!latest || latest.incomingShownAtMs) return;
  scheduleCallPushRetry(callId, CALL_DELIVERY_RETRY_EVERY_MS);
}

/** Callee в ожидающем звонке (без inCall) не считается занятым при отображении в списке друзей. */
function isSocketBusyForFriendsExport(data: Record<string, unknown> | undefined, userId: string): boolean {
  const d = data || {};
  const inCall = d.inCall === true;
  const busy = d.busy === true;
  const inSession = !!(inCall || busy || d.roomId || d.partnerSid);
  if (!inSession) return false;

  const entry = callOfUser.get(userId);
  if (entry) {
    const link = callsById.get(entry.callId);
    if (link && link.b === userId && !inCall && !busy) return false;
    // Инициатор на дозвоне (нативный исходящий, вызов ещё не принят) — не «Занято» в списке друзей.
    if (link && link.a === userId && !inCall) return false;
  }
  return true;
}

function clearDirectCallSessionForUser(io: Server, userId: string) {
  forEachSocketForUser(io, userId, (s) => {
    (s as any).data = (s as any).data || {};
    (s as any).data.busy = false;
    (s as any).data.inCall = false;
    delete (s as any).data.roomId;
    delete (s as any).data.partnerSid;
  });
}

function getEffectiveBusyForExport(io: Server, userId: string): boolean {
  for (const s of getSocketsForUser(io, userId)) {
    if (isSocketBusyForFriendsExport((s as any).data, userId)) return true;
  }
  return false;
}
setGetEffectiveBusy(getEffectiveBusyForExport);

/** Сохранить пропущенный вызов для получателя (после восстановления сети он подтянет через reauth). */
async function saveMissedCall(calleeId: string, callerId: string, callerNick: string) {
  if (!isMongoReady() || !isOid(calleeId) || !isOid(callerId)) return;
  try {
    await MissedCall.create({
      calleeId: new mongoose.Types.ObjectId(calleeId),
      callerId: new mongoose.Types.ObjectId(callerId),
      callerNick: String(callerNick || '').trim(),
    });
  } catch (e: any) {
    logger.warn('[saveMissedCall] failed', { calleeId, callerId, error: e?.message });
  }
}

/** Отклонение звонка по HTTP (из IncomingCallActivity без открытия приложения). Auth по x-install-id. */
app.post('/api/calls/decline', async (req, res) => {
  try {
    const userId = (req as any).userId;
    const installId = (req as any).installId;
    if (!userId || !isOid(userId)) {
      if (mongoose.connection.readyState !== 1) {
        logger.warn('[api/calls/decline] database_unavailable (cannot resolve installId)', {
          hasInstallId: !!installId,
          readyState: mongoose.connection.readyState,
        });
        return res.status(503).json({ ok: false, error: 'database_unavailable' });
      }
      logger.warn('[api/calls/decline] unauthorized', { hasInstallId: !!installId, installIdPrefix: installId ? String(installId).slice(0, 20) : '' });
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const callId = String(req.body?.callId || '').trim();
    if (!callId) {
      return res.status(400).json({ ok: false, error: 'callId_required' });
    }
    const link = await getCallLinkFromAnyStore(callId);
    if (!link) {
      return res.json({ ok: true }); // уже завершён — не ошибка
    }
    if (link.b !== userId) {
      return res.status(403).json({ ok: false, error: 'only_callee_can_decline' });
    }
    const shouldProcess = transitionCall(callId, 'declined', {
      actionKey: `http_decline:${callId}:${userId}`,
      source: 'http_decline',
    });
    if (!shouldProcess) {
      return res.json({ ok: true, deduped: true });
    }
    logger.info('[api/calls/decline] callee declined via HTTP', { callId, caller: link.a, callee: link.b });
    clearDirectCallSessionForUser(io, link.a);
    clearDirectCallSessionForUser(io, link.b);
    await emitPresenceUpdateCallToFriends(io, link.a, link.b, false);
    try { io.to(`u:${link.a}`).emit('call:declined', { callId, from: link.b }); } catch {}
    logger.info('[api/calls/decline] sending call_declined push to caller', { callId, caller: link.a, callee: link.b });
    try { await sendCallDeclinedToCaller(link.a, callId); } catch (e: any) { logger.warn('[api/calls/decline] sendCallDeclinedToCaller failed', { error: e?.message }); }
    // Отклонение получателем — не пропущенный вызов; call_ended получателю не шлём
    logger.info('[api/calls/decline] call ended for both: caller notified (socket+FCM), callee closed native screen', { callId, caller: link.a, callee: link.b });
    cleanupCall(callId, 'declined');
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

/** Получатель подтвердил, что экран входящего реально показан (метрика E2E по callId). */
app.post('/api/calls/incoming-shown', async (req, res) => {
  try {
    const userId = (req as any).userId;
    const callIdEarly = String(req.body?.callId || '').trim();
    const hasInstallHeader = !!String(req.header('x-install-id') || '').trim();
    if (!userId || !isOid(userId)) {
      logger.warn('[call:incoming_shown] rejected 401 (no user for install)', {
        hasInstallHeader,
        callId: callIdEarly || undefined,
      });
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const callId = callIdEarly;
    if (!callId) {
      logger.warn('[call:incoming_shown] rejected 400 (callId_required)', {
        userId: String(userId).slice(0, 8) + '…',
      });
      return res.status(400).json({ ok: false, error: 'callId_required' });
    }

    const link = await getCallLinkFromAnyStore(callId);
    const telemetry = callDeliveryById.get(callId);
    const expectedCallee = link?.b || telemetry?.calleeId;
    if (!expectedCallee || String(expectedCallee) !== String(userId)) {
      logger.warn('[call:incoming_shown] rejected 403 (callee mismatch)', {
        callId,
        userId: String(userId).slice(0, 8) + '…',
        expectedCallee: expectedCallee ? String(expectedCallee).slice(0, 8) + '…' : null,
        hasLink: !!link,
        hasTelemetry: !!telemetry,
      });
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const now = Date.now();
    const t = telemetry ?? {
      callerId: link?.a || '',
      calleeId: expectedCallee,
      createdAtMs: now,
      expiresAtMs: link?.expiresAtMs || now + CALL_RING_TIMEOUT_MS,
    };
    if (!t.incomingShownAtMs) {
      t.incomingShownAtMs = now;
      t.incomingShownBy = 'native_http';
      callDeliveryById.set(callId, t);
      markIncomingShownOrchestration(callId, 'native_http');
      const activeLink = callsById.get(callId);
      if (activeLink?.retryPushTimer) {
        try { clearTimeout(activeLink.retryPushTimer); } catch {}
        activeLink.retryPushTimer = undefined;
      }
      const ageFromStartMs = now - t.createdAtMs;
      const ageFromPushMs = t.pushSentAtMs != null ? now - t.pushSentAtMs : undefined;
      logger.info('[call:incoming_shown] received from native HTTP', {
        callId,
        caller: t.callerId,
        callee: t.calleeId,
        ageFromStartMs,
        ageFromPushMs,
      });
      pushLog('call_incoming_shown', { callId, via: 'native_http', ageFromStartMs, ageFromPushMs });
    }
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
    const link = await getCallLinkFromAnyStore(callId);
    if (!link) {
      return res.json({ ok: true }); // уже завершён — не ошибка
    }
    if (link.a !== userId) {
      return res.status(403).json({ ok: false, error: 'only_caller_can_cancel' });
    }
    const shouldProcess = transitionCall(callId, 'canceled', {
      actionKey: `http_cancel:${callId}:${userId}`,
      source: 'http_cancel',
    });
    if (!shouldProcess) {
      handleCancelDeduped(callId, link, 'http_deduped');
      return res.json({ ok: true, deduped: true });
    }
    logger.info('[api/calls/cancel] caller canceled via HTTP', { callId, caller: link.a, callee: link.b });
    clearDirectCallSessionForUser(io, link.a);
    clearDirectCallSessionForUser(io, link.b);
    await emitPresenceUpdateCallToFriends(io, link.a, link.b, false);
    try { io.to(`u:${link.a}`).emit('call:cancel', { callId, from: link.a }); } catch {}
    try { io.to(`u:${link.b}`).emit('call:cancel', { callId, from: link.a }); } catch {}
    logger.info('[api/calls/cancel] sending call_canceled push to callee', { callId, caller: link.a, callee: link.b });
    let fromNick: string | undefined;
    try {
      if (isMongoReady()) {
        const u = await User.findById(link.a).select('nick').lean();
        if (u && typeof (u as any).nick === 'string') fromNick = String((u as any).nick).trim() || undefined;
      }
    } catch {}
    try { await sendCallCanceledToRecipient(link.b, callId, link.a, fromNick); } catch (e: any) { logger.warn('[api/calls/cancel] sendCallCanceledToRecipient failed', { error: e?.message }); }
    if (!hasSocketForUser(io, link.b)) await saveMissedCall(link.b, link.a, fromNick || '');
    logger.info('[call:cancel] processed (http), clearing ring timer if any', {
      callId,
      hadTimer: !!callsById.get(callId)?.timer,
    });
    logger.info('[api/calls/cancel] call ended for both: callee got missed from native', { callId, caller: link.a, callee: link.b });
    cleanupCall(callId, 'canceled');
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

function hasObservabilityAccess(req: express.Request): boolean {
  if (!CALL_OBSERVABILITY_API_KEY) return true;
  const key = String(req.header('x-observability-key') || '').trim();
  return key.length > 0 && key === CALL_OBSERVABILITY_API_KEY;
}

app.get('/api/calls/metrics', async (req, res) => {
  if (!hasObservabilityAccess(req)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const windowMin = Number(req.query.windowMin || 60);
  const normalizedWindow = Number.isFinite(windowMin) ? windowMin : 60;
  let metricsSource: 'db' | 'memory' = 'db';
  let metrics: Awaited<ReturnType<typeof getOrchestrationMetricsFromDb>> | ReturnType<typeof getOrchestrationMetrics>;
  try {
    metrics = await getOrchestrationMetricsFromDb(normalizedWindow);
  } catch (e: any) {
    metricsSource = 'memory';
    metrics = getOrchestrationMetrics(normalizedWindow);
    logger.warn('[call:metrics] db metrics failed, fallback to memory', { error: e?.message });
  }
  return res.json({
    ok: true,
    source: metricsSource,
    featureFlags: callFeatureFlags,
    slo: {
      incoming_shown_p95_target_seconds: 3,
      fields: ['incomingShownRate', 'answeredSuccessRate', 'missedDueToDeliveryRate'],
    },
    metrics,
  });
});

app.get('/api/calls/:callId/timeline', (req, res) => {
  if (!hasObservabilityAccess(req)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const callId = String(req.params.callId || '').trim();
  if (!callId) return res.status(400).json({ ok: false, error: 'callId_required' });
  const timeline = getCallTimeline(callId);
  if (!timeline) return res.status(404).json({ ok: false, error: 'not_found' });
  return res.json({ ok: true, timeline });
});

app.get('/api/calls/:callId/timeline-db', async (req, res) => {
  if (!hasObservabilityAccess(req)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const callId = String(req.params.callId || '').trim();
  if (!callId) return res.status(400).json({ ok: false, error: 'callId_required' });
  const timeline = await getCallTimelineFromDb(callId);
  if (!timeline) return res.status(404).json({ ok: false, error: 'not_found' });
  return res.json({ ok: true, timeline });
});

app.post('/api/calls/provider-delivered', (req, res) => {
  if (!callProviderAdapter.isEnabled()) {
    return res.status(409).json({ ok: false, error: 'provider_disabled', mode: callProviderMode });
  }
  const verify = callProviderAdapter.verifyWebhook(req);
  if (!verify.ok) {
    const status = verify.error === 'provider_webhook_secret_missing' ? 503 : 403;
    return res.status(status).json({ ok: false, error: verify.error || 'forbidden' });
  }
  const event = callProviderAdapter.parseDeliveredEvent(req.body);
  if (!event?.callId) return res.status(400).json({ ok: false, error: 'callId_required' });
  const delivered = markProviderDelivered(event.callId, {
    provider: event.provider,
    mode: callProviderMode,
    payload: event.payload,
  });
  if (!delivered) return res.status(404).json({ ok: false, error: 'call_not_found' });
  return res.json({ ok: true });
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

      clearPendingPresenceOffline(mappedUserId);
      void bindUserIdentity(io, sock, mappedUserId).then(async () => {
        clearStickyPresenceStateForUser(mappedUserId);
        await replayIncomingToCalleeIfRinging(sock, mappedUserId);
      });
      emitPresence(io, mappedUserId);

      // Если пользователь был в ожидании принятого звонка (принятие было вне приложения) — отправляем call:accepted и подключаем в комнату
      const pendingRoom = activeRoomByUserId.get(mappedUserId);
      if (pendingRoom) {
        try {
          const callStillTracked =
            callsById.has(pendingRoom.callId) ||
            callIdToRoomId.has(pendingRoom.callId) ||
            activeRoomByUserId.has(mappedUserId);
          const recentlyEnded =
            recentlyEndedCalls.has(pendingRoom.callId) ||
            recentlyEndedCalls.has(pendingRoom.roomId);
          if (!callStillTracked || recentlyEnded) {
            clearAcceptedCallStateForUser(mappedUserId, `reauth-stale:${callStillTracked ? 'recently-ended' : 'missing-call'}`);
          } else {
            const emitted = await emitPendingCallAcceptedToSocket(io, sock, mappedUserId, pendingRoom, 'reauth');
            if (emitted) {
              logger.info('[reauth] Sent call:accepted to reconnected participant', {
                userId: mappedUserId,
                roomId: pendingRoom.roomId,
                callId: pendingRoom.callId,
              });
            }
          }
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
      let missed: { from: string; fromNick: string }[] = [];
      try {
        if (isMongoReady()) {
          const docs = await MissedCall.find({ calleeId: mappedUserId }).sort({ createdAt: -1 }).limit(50).lean();
          missed = (docs as any[]).map((d) => ({ from: String(d.callerId), fromNick: String(d.callerNick || '').trim() }));
          if (docs.length) await MissedCall.deleteMany({ _id: { $in: docs.map((d: any) => d._id) } });
        }
      } catch (e: any) {
        logger.warn('[reauth] fetch missed failed', { error: e?.message });
      }
      ack?.({ ok: true, userId: mappedUserId, missed });
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
    clearPendingPresenceOffline(String(bindUid));
    const boundUid = String(bindUid);
    void bindUserIdentity(io, sock, boundUid).then(async () => {
      clearStickyPresenceStateForUser(boundUid);
      await replayIncomingToCalleeIfRinging(sock, boundUid);
    });
    emitPresence(io, boundUid);
    // Replay call:accepted здесь не делаем: после connect клиент всегда шлёт reauth,
    // и duplicate source (connect + reauth + call:getAccepted) порождал лишние accepted.
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

      /** 1:1 друг-друг: только room_<24hex>_<24hex>. Иначе клиент иногда дублировал callId в поле roomId — Socket.IO room не находилась. */
      const isCanonicalFriendRoomId = (s: unknown): boolean =>
        /^room_[a-f\d]{24}_[a-f\d]{24}$/i.test(String(s ?? '').trim());

      let clientRoomParam = roomId ? String(roomId).trim() : '';
      const cidTrim = callId ? String(callId).trim() : '';
      if (clientRoomParam && !isCanonicalFriendRoomId(clientRoomParam)) {
        if (cidTrim && clientRoomParam === cidTrim) {
          logger.debug('[call:end] Dropping client roomId (same as callId, not a canonical room)', { callId: cidTrim });
        } else {
          logger.debug('[call:end] Dropping non-canonical client roomId', { roomId: clientRoomParam });
        }
        clientRoomParam = '';
      }

      // КРИТИЧНО: Приоритетно берем roomId из параметров, сокет-данных, activeCallBySocket; если передан только callId — смотрим callIdToRoomId (принятие из пуша)
      const resolvedRoomId =
        clientRoomParam ||
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
      if (recentlyEndedCalls.has(id)) {
        logger.info('⏭️ [call:end] duplicate ignored (already ended recently)', {
          roomId: id,
          callId: callId || null,
          socketId: sock.id,
        });
        return;
      }
      recentlyEndedCalls.set(id, setTimeout(() => {
        try { recentlyEndedCalls.delete(id); } catch {}
      }, 15_000));
      if (callId) {
        transitionCall(String(callId), 'ended', {
          actionKey: `socket_end:${String(callId)}`,
          source: 'socket_end',
        });
      }

      try {
        sanitizeDirectCallSocketIoRoom(io, id, activeCallBySocket);
      } catch (e: any) {
        logger.warn('[call:end] sanitizeDirectCallSocketIoRoom failed', { roomId: id, error: e?.message });
      }

      // Получаем участников комнаты
      const room = io.sockets.adapter.rooms.get(id);
      const participantCount = room ? room.size : 0;

      // КРИТИЧНО: Если комната не найдена, все равно отправляем call:ended всем сокетам
      // которые могут быть в звонке (через activeCallBySocket или socket.data.roomId)
      const socketsToNotify = new Set<string>();
      // КРИТИЧНО: Отправитель call:end всегда в списке — иначе у него остаётся busy и нельзя сразу перезвонить (initiator_busy).
      socketsToNotify.add(sock.id);

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

      // КРИТИЧНО: Сначала мгновенно уведомляем обоих клиентов о завершении звонка,
      // а уже потом делаем более тяжёлую серверную очистку (presence, room cleanup, push).
      // Иначе второй участник ждёт server-side await и экран VideoCall закрывается заметно позже.
      // Отправляем call:ended каждому участнику один раз (напрямую сокету), чтобы клиент не получал дубли и не мерцал при переходе на Home.
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
        }
      }

      // Снимаем busy со всех участников и очищаем состояние
      const callEndedParticipantUserIds = new Set<string>();
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
            callEndedParticipantUserIds.add(String(peerUserId));
            await emitPresenceUpdateToFriends(io, peerUserId, false);
          }
        }

        // Очищаем activeCallBySocket
        try { activeCallBySocket.delete(sid); } catch {}
      }
      for (const uid of callEndedParticipantUserIds) {
        applyFastOfflineAfterCallIfAllSocketsBackground(io, uid);
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

      const cidToCleanup = resolveCallIdFromEndIdentifier(id, callId);
      if (cidToCleanup) {
        cleanupCall(cidToCleanup, 'ended');
      }
      const pushCallId = cidToCleanup || (callId ? String(callId) : id);

      // Пуш второму участнику (если приложение в фоне/убито) — снять уведомление о звонке и закрыть UI при открытии
      const senderUserId = (sock as any)?.data?.userId;
      if (senderUserId) {
        try {
          const fromUser = await User.findById(senderUserId).select('nick').lean();
          const fromNick = (fromUser as any)?.nick ?? '';
          const rm = String(id).match(/^room_([a-f\d]{24})_([a-f\d]{24})$/i);
          let pushPeerUserId: string | null = null;
          if (rm) {
            if (rm[1] === String(senderUserId)) pushPeerUserId = rm[2];
            else if (rm[2] === String(senderUserId)) pushPeerUserId = rm[1];
          }
          if (!pushPeerUserId) {
            for (const sid of socketsToNotify) {
              if (sid === sock.id) continue;
              const peerSocket = io.sockets.sockets.get(sid);
              const peerUserId = peerSocket ? (peerSocket as any)?.data?.userId : null;
              if (peerUserId && peerUserId !== senderUserId) {
                pushPeerUserId = String(peerUserId);
                break;
              }
            }
          }
          if (pushPeerUserId) {
            await sendCallEndedToPeer(pushPeerUserId, pushCallId, senderUserId, fromNick);
          }
        } catch (e: any) {
          logger.warn('[call:end] send call_ended push failed', { error: e?.message });
        }
      }

      try {
        dissolveSocketIoRoom(io, id);
      } catch (e: any) {
        logger.warn('[call:end] dissolveSocketIoRoom failed', { roomId: id, error: e?.message });
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
      const idleOnline = !busy && payload?.idle === true;

      const hasAnotherBusySocket = getSocketsForUser(io, userId).some((s) => {
        if (s.id === sock.id) return false;
        const sdata = (s as any)?.data || {};
        return !!(sdata.inCall || sdata.busy || sdata.roomId);
      });

      if (idleOnline) {
        const hasLiveSameUserCallSocket = getSocketsForUser(io, userId).some((s) => {
          if (s.id === sock.id) return false;
          const sdata = (s as any)?.data || {};
          if (!sdata.inCall && !sdata.roomId && !sdata.partnerSid) return false;
          const rid = String(sdata.roomId || activeCallBySocket.get(s.id) || '');
          const room = rid ? io.sockets.adapter.rooms.get(rid) : null;
          return !!room && room.size > 1;
        });

        const sockData = (sock as any)?.data || {};
        const sockStillBusy =
          !!(sockData.busy || sockData.inCall || sockData.roomId || sockData.partnerSid);

        if (!hasLiveSameUserCallSocket && !sockStillBusy && !hasAnotherBusySocket) {
          const pendingActive = activeRoomByUserId.get(userId);
          if (pendingActive?.callId) {
            const timeline = getCallTimeline(pendingActive.callId);
            if (
              timeline?.state === 'accepted' ||
              callIdToRoomId.has(pendingActive.callId)
            ) {
              // In an accepted LiveKit call — do not tear down activeRoom / callIdToRoomId on idle presence.
            } else {
              const pending = pendingActive;
              const entry = callOfUser.get(userId);
              const peerId = pending?.peerUserId || entry?.with || null;
              clearAcceptedCallStateForUser(userId, 'presence-idle-online');
              lastBroadcastBusyByUserId.set(userId, false);
              await emitPresenceUpdateToFriends(io, userId, false);
              if (peerId && peerId !== userId) {
                lastBroadcastBusyByUserId.set(String(peerId), false);
                await emitPresenceUpdateToFriends(io, String(peerId), false);
              }
            }
          } else {
            const entry = callOfUser.get(userId);
            const peerId = entry?.with || null;
            clearAcceptedCallStateForUser(userId, 'presence-idle-online');

            lastBroadcastBusyByUserId.set(userId, false);
            await emitPresenceUpdateToFriends(io, userId, false);
            if (peerId && peerId !== userId) {
              lastBroadcastBusyByUserId.set(String(peerId), false);
              await emitPresenceUpdateToFriends(io, String(peerId), false);
            }
          }
        }
      }
      // Другие сокеты того же userId: пока хоть один в звонке/рандоме — не даём сбросить «занят» для друзей.
      // Текущий сокет сюда не включаем: иначе его же устаревшие busy/roomId (гонка со stop после рандома)
      // не дают перейти в online и оставляют initiator_busy на call:initiate.
      const busyRequested = busy || hasAnotherBusySocket;

      // КРИТИЧНО: Получатель (callee) не должен показывать бейдж «Занято» до принятия вызова.
      let ignoreBusyForCallee = false;
      // КРИТИЧНО: Инициатор (caller) не должен показывать бейдж «Занято» у того, кому звонят, пока вызов не принят (нативный экран входящего, дозвон).
      let ignoreBusyForCaller = false;
      if (busyRequested && callOfUser.has(userId)) {
        const entry = callOfUser.get(userId);
        if (entry) {
          const link = callsById.get(entry.callId);
          if (link) {
            const callAlreadyAccepted = isDirectCallAcceptedOrActive(entry.callId, link);
            if (link.b === userId && !(sock as any).data.inCall && !callAlreadyAccepted) {
              ignoreBusyForCallee = true;
              logger.info('📍 [presence:update] Callee busy ignored until call accepted', { userId, callId: entry.callId });
            }
            // Инициатор: не рассылаем его busy друзьям (в т.ч. получателю), пока получатель не принял (у получателя нет inCall).
            if (link.a === userId) {
              const calleeSock = findSocketForUser(io, link.b);
              const calleeInCall =
                callAlreadyAccepted ||
                !!(calleeSock && (calleeSock as any).data?.inCall) ||
                activeRoomByUserId.has(link.b);
              if (!calleeInCall) {
                ignoreBusyForCaller = true;
                logger.info('📍 [presence:update] Caller busy ignored until callee accepted (no badge during incoming)', { userId, callerId: link.a, calleeId: link.b, callId: entry.callId });
              }
            }
          }
        }
      }
      const effectiveBusy = busyRequested && !ignoreBusyForCallee && !ignoreBusyForCaller;

      // Обновляем состояние сокета (при ignoreBusyForCaller не трогаем data.busy — он уже true с call:initiate, просто не рассылаем друзьям)
      const prevBusy = !!(sock as any).data?.busy;
      const prevRoomId = String((sock as any).data?.roomId || '');
      const nextRoomId = payload?.roomId && !ignoreBusyForCallee ? String(payload.roomId) : '';
      if (!ignoreBusyForCaller) {
        (sock as any).data.busy = effectiveBusy;
        if (payload?.roomId && !ignoreBusyForCallee) {
          (sock as any).data.roomId = payload.roomId;
        } else if (!effectiveBusy) {
          delete (sock as any).data.roomId;
        } else {
          delete (sock as any).data.roomId;
        }
      }
      const presenceStateChanged = prevBusy !== effectiveBusy || prevRoomId !== nextRoomId;
      const lastBroadcastBusy = lastBroadcastBusyByUserId.get(userId);
      const shouldBroadcast =
        !ignoreBusyForCallee &&
        !ignoreBusyForCaller &&
        presenceStateChanged &&
        lastBroadcastBusy !== effectiveBusy;
      if (shouldBroadcast) {
        lastBroadcastBusyByUserId.set(userId, effectiveBusy);
        await emitPresenceUpdateToFriends(io, userId, effectiveBusy);
      }

      const presenceNoop =
        !presenceStateChanged && !shouldBroadcast && !ignoreBusyForCallee && !ignoreBusyForCaller;
      if (presenceNoop) {
        logger.debug('📍 [presence:update] skip duplicate (same busy/room, no broadcast)', {
          userId,
          status,
          effectiveBusy
        });
      } else {
        logger.info('📍 [presence:update] Status updated', {
          userId,
          status,
          busy,
          busyRequested,
          effectiveBusy,
          broadcast: shouldBroadcast,
          presenceStateChanged,
          lastBroadcastBusy,
          ignoreBusyForCallee,
          ignoreBusyForCaller
        });
      }
    } catch (e) {
      logger.error('❌ [presence:update] Error', { error: (e as any)?.message || String(e) });
    }
  });

  /** Видимый онлайн для друзей: в фоне сокет остаётся подключён, но пользователь не в списке «онлайн». */
  sock.on('app:visibility', (payload: any) => {
    try {
      const userId = String((sock as any).data?.userId || '');
      if (!userId) return;
      if (typeof payload?.foreground !== 'boolean') return;
      (sock as any).data = (sock as any).data || {};
      (sock as any).data.appForeground = payload.foreground;
      if (payload.foreground) {
        scheduleDebouncedClearBackgroundOnForeground(io, userId);
      } else {
        cancelDebouncedForegroundAck(userId);
        clearStickyPresenceStateForUser(userId);
        armInAppOfflinePresenceEmit(io, userId);
      }
      scheduleGlobalFriendPresenceEmit(io, userId);
    } catch (e) {
      logger.error('❌ [app:visibility] Error', { error: (e as any)?.message || String(e) });
    }
  });

  // SECURITY: legacy attach_user is disabled (use identity:attach instead).

  // ВОТ ЗДЕСЬ: читаем профиль (ник + нормализованный https-аватар)
  sock.on('profile:me', async (_: any, ack?: Function) => {
    const me = String((sock as any).data?.userId || '');
    if (!me) {
      return ack?.({ ok: true, profile: {} }); // гость
    }
    const u = (await User.findById(me).select('nick avatar avatarVer avatarB64 avatarThumbB64').lean()) as any;
    const rawAvatar = String(u?.avatar || '');
    const avatarVer = u?.avatarVer || 0;
    const avatarB64 = u?.avatarB64 || '';
    const avatarThumbB64 = u?.avatarThumbB64 || '';
    const profile = u ? { nick: u.nick || '', avatar: rawAvatar, avatarVer, avatarB64, avatarThumbB64 } : {};
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
        .select('nick avatar avatarVer avatarB64 avatarThumbB64')
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
        if (Object.prototype.hasOwnProperty.call($set, 'nick')) {
          auditNickChange({
            source: 'socket.profile:update',
            userId: me,
            prevNick: String(current.nick ?? ''),
            nextNick: String($set.nick ?? ''),
            socketId: sock.id,
          });
        }
        const updateOp: any = {};
        if (Object.keys($set).length > 0) updateOp.$set = $set;
        if (Object.keys($inc).length > 0) updateOp.$inc = $inc;
        await User.updateOne({ _id: me }, updateOp);
      }

      // Получаем свежие данные после обновления
      const fresh = (changed
        ? await User.findById(me).select('nick avatar avatarVer avatarB64 avatarThumbB64').lean()
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
      if (changed) {
        const friendIds = await getFriendIds(me);
        for (const fid of friendIds) {
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
  sock.on('call:initiate', async ({ to, media: mediaRaw }: { to?: string; media?: string }, ack?: Function) => {
    try {
      const meRaw = String((sock as any).data?.userId || '');
      if (!meRaw) return ack?.({ ok: false, error: 'unauthorized' });
      const me = normalizeMongoObjectId(meRaw);
      const peerRaw = String(to || '').trim();
      if (!peerRaw || !peerRaw.match(/^[a-f\d]{24}$/i)) return ack?.({ ok: false, error: 'bad_peer' });
      const peerId = normalizeMongoObjectId(peerRaw);
      const callMedia = String(mediaRaw || '').trim().toLowerCase() === 'audio' ? 'audio' : 'video';

      pruneOrphanCallOfUserEntry(me);
      pruneOrphanCallOfUserEntry(peerId);
      await cleanupStaleRingingCallForImmediateRetry(me, peerId);

      // Проверяем busy флаг инициатора
      const initiatorSocket = io.sockets.sockets.get(sock.id);
      if (
        initiatorSocket &&
        (initiatorSocket as any)?.data?.busy === true &&
        !(await getUserCallEntryFromAnyStore(me)) &&
        !activeRoomByUserId.has(me)
      ) {
        (initiatorSocket as any).data.busy = false;
        delete (initiatorSocket as any).data.roomId;
        delete (initiatorSocket as any).data.partnerSid;
        delete (initiatorSocket as any).data.inCall;
      }
      if (initiatorSocket && (initiatorSocket as any)?.data?.busy === true) {
        return ack?.({ ok: false, error: 'initiator_busy' });
      }

      // Убрано: проверка randomBusyByUser - рандомный поиск не блокирует звонки другу

      // Уже в звонке?
      if (await getUserCallEntryFromAnyStore(me)) return ack?.({ ok: false, error: 'busy' });

      // Найдём любой сокет получателя (может быть offline — тогда будем будить пушем)
      const peerSocket = findSocketForUser(io, peerId);

      // Если получатель онлайн — проверяем busy флаг
      if (peerSocket && (peerSocket as any)?.data?.busy === true) {
        try { sock.emit('call:busy', { from: peerId, userId: peerId }); } catch {}
        return ack?.({ ok: false, error: 'peer_busy' });
      }

      // Убрано: проверка randomBusyByUser - рандомный поиск не блокирует звонки другу

      if (await getUserCallEntryFromAnyStore(peerId)) {
        // Получатель уже в активном звонке
        try { sock.emit('call:busy', { from: peerId, userId: peerId }); } catch {}
        return ack?.({ ok: false, error: 'peer_busy' });
      }

      const createdAtMs = Date.now();
      const expiresAtMs = createdAtMs + CALL_RING_TIMEOUT_MS;
      const callId = `${createdAtMs}_${Math.random().toString(36).slice(2, 8)}`;
      callsById.set(callId, { a: me, b: peerId, createdAtMs, expiresAtMs, media: callMedia });
      createOrchestratedCall({ callId, callerId: me, calleeId: peerId });
      callDeliveryById.set(callId, {
        callerId: me,
        calleeId: peerId,
        createdAtMs,
        expiresAtMs,
      });
      callOfUser.set(me, { with: peerId, callId });
      callOfUser.set(peerId, { with: me, callId });
      await persistDirectCallSharedState(callId, { a: me, b: peerId, createdAtMs, expiresAtMs });

      // КРИТИЧНО: Создаем комнату при инициации звонка (инициатором)
      // Используем user IDs для имени комнаты, чтобы совпадало с LiveKit roomName
      const sortedUserIds = [me, peerId].sort();
      const roomId = `room_${sortedUserIds[0]}_${sortedUserIds[1]}`;
      console.log('[call:initiate] roomId created', { me, peerId, roomId });

      // Инициатор сразу присоединяется к комнате
      try {
        evictExtraUserSocketsInDirectRoom(io, roomId, me, sock.id);
      } catch {}
      try {
        sock.join(roomId);
        logger.debug('Initiator joined room', { socketId: sock.id, roomId, callId });
      } catch {}
      try {
        sanitizeDirectCallSocketIoRoom(io, roomId, activeCallBySocket);
      } catch {}

      // КРИТИЧНО: Устанавливаем busy только для инициатора при инициации (для проверки initiator_busy). Получатель станет busy только после принятия (call:accept).
      // Бейдж «Занято» не рассылаем друзьям до принятия: пока нативный экран входящего у одного и исходящего у другого — бейдж не показывается.
      (sock as any).data = (sock as any).data || {};
      (sock as any).data.busy = true;
      (sock as any).data.roomId = roomId;
      if (peerSocket) (sock as any).data.partnerSid = peerSocket.id;

      // Получатель НЕ помечаем busy до принятия. Presence друзьям не рассылаем до call:accept — бейдж только после принятия и на всё время разговора.
      logger.debug('Call initiated', { from: me, to: peerId, callId, roomId });

      // КРИТИЧНО: Отправляем инициатору roomId для немедленного использования
      // Включаем from (socket.id получателя) для сохранения partnerSocketId
      try {
        sock.emit('call:room:created', { callId, roomId, partnerId: peerId, from: peerSocket ? peerSocket.id : null });
        logger.debug('Room created event sent to initiator', { socketId: sock.id, roomId, callId, from: peerSocket ? peerSocket.id : null });
      } catch {}

      // таймаут 20с
      const timer = setTimeout(async () => {
        const link = await getCallLinkFromAnyStore(callId);
        if (!link) {
          cleanupCall(callId);
          return;
        }
        const shouldProcess = transitionCall(callId, 'timeout', {
          actionKey: `timeout:${callId}`,
          source: 'timer_timeout',
        });
        if (!shouldProcess) {
          logCallEndSkipped(callId, 'timeout', 'timer_after_cancel_or_dedup');
          if (callsById.has(callId)) cleanupCall(callId);
          return;
        }

        // Снимаем busy статус с обоих участников при таймауте
        clearDirectCallSessionForUser(io, link.a);
        clearDirectCallSessionForUser(io, link.b);
        await emitPresenceUpdateCallToFriends(io, link.a, link.b, false);

        try {
          const sortedU = [link.a, link.b].sort();
          dissolveSocketIoRoom(io, `room_${sortedU[0]}_${sortedU[1]}`);
        } catch {}

        // уведомляем инициатора о таймауте (from = caller, чтобы клиент не считал пропущенным у инициатора)
        try {
          io.to(`u:${link.a}`).emit('call:timeout', { callId, from: link.a });
        } catch {}
        // уведомим получателя, чтобы оба закрыли модалки
        try {
          io.to(`u:${link.b}`).emit('call:timeout', { callId, from: link.a });
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
          await sendCallMissedToRecipient(link.b, callId, link.a, fromNick || '');
        } catch (e: any) {
          logger.warn('[call:timeout] call_ended push failed', { peerId: link.b, error: e?.message });
        }
        // Сохраняем пропущенный только если получатель офлайн — иначе он уже получил socket+FCM и при reauth получит дубль через missed_calls:sync
        if (!hasSocketForUser(io, link.b)) await saveMissedCall(link.b, link.a, fromNick || '');
        logger.info('[call:timeout] call ended for both: callee notified (socket+missed push), caller gets timeout', { callId, caller: link.a, callee: link.b });
        cleanupCall(callId, 'timeout');
      }, CALL_RING_TIMEOUT_MS);
      const link = callsById.get(callId);
      if (link) link.timer = timer;

      // отправим входящий вызов получателю (с ником инициатора, если есть)
      let fromNick: string | undefined;
      try {
        try {
          // КРИТИЧНО: Проверяем готовность MongoDB перед операциями
          if (isMongoReady()) {
            const u = await User.findById(me).select('nick').lean();
            if (u && typeof (u as any).nick === 'string') fromNick = String((u as any).nick).trim() || undefined;
          }
        } catch {}

        const tNick = callDeliveryById.get(callId);
        if (tNick) tNick.callerNick = fromNick ?? '';

        // Шлём либо напрямую в уже связанные сокеты пользователя, либо в user-room fallback.
        // Одновременная отправка обоими путями давала дубль одного и того же call:incoming.
        const room = io.sockets.adapter.rooms.get(`u:${peerId}`);
        const recipientSockets = getSocketsForUser(io, peerId);
        for (const recipientSocket of recipientSockets) {
          try {
            (recipientSocket as any).emit('call:incoming', {
              callId,
              callKitId: getCallKitUuid(callId),
              from: me,
              fromNick,
              media: callMedia,
              ts: createdAtMs,
              expiresAt: expiresAtMs,
            });
            (recipientSocket as any).emit('friend:call:incoming', { callId, from: me, nick: fromNick });
          } catch {}
        }
        const roomSize = room ? room.size : 0;
        logger.info('[call:initiate] emitting call:incoming to recipient', { peerId, callId, recipientSocketsCount: recipientSockets.length, roomUSize: roomSize });
        if (recipientSockets.length === 0 && roomSize > 0) {
          io.to(`u:${peerId}`).emit('call:incoming', {
            callId,
            callKitId: getCallKitUuid(callId),
            from: me,
            fromNick,
            media: callMedia,
            ts: createdAtMs,
            expiresAt: expiresAtMs,
          });
          io.to(`u:${peerId}`).emit('friend:call:incoming', { callId, from: me, nick: fromNick });
        }
      } catch {}

      // КРИТИЧНО: пуш всегда отправляем в отдельном шаге, чтобы исключение в блоке с Mongo/сокетами не пропустило доставку в глубоком сне
      try {
        const t = callDeliveryById.get(callId);
        if (t) {
          t.callerNick = fromNick ?? '';
          callDeliveryById.set(callId, t);
        }
        logger.info('[call:initiate] sending call push to recipient', { peerId, callId, from: me });
        await sendCallPushToRecipient(peerId, {
          callId,
          from: me,
          fromNick: fromNick ?? '',
          createdAtMs,
          expiresAtMs,
          media: callMedia,
        });
        addCallEvent(callId, 'push_sent', 'backend_initial', {
          providerMode: callProviderMode,
          providerPrimary: callFeatureFlags.providerSignalingEnabled,
          pushFallbackEnabled: callFeatureFlags.pushFallbackEnabled,
        });
        if (t && !t.pushSentAtMs) t.pushSentAtMs = Date.now();
        logger.info('[call:initiate] call push sent', { peerId });
      } catch (pushErr: any) {
        logger.warn('[call:initiate] push to recipient failed', { peerId, error: pushErr?.message });
      }

      // Надёжная доставка: если incoming_shown ACK не пришёл, запускаем цикл retry + escalation.
      scheduleCallPushRetry(callId, CALL_DELIVERY_ACK_WAIT_MS);

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

      if (!isAllowedParticipant(roomName, String(me))) {
        logger.warn('[livekit:token] Rejected: user is not a participant', {
          userId: String(me).slice(0, 8) + '…',
          roomName: roomName.slice(0, 20) + '…',
          socketId: sock.id,
        });
        return ack?.({ ok: false, error: 'not_participant' });
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

  sock.on('call:accept', async ({ callId }: { callId?: string }, ack?: (resp: { ok: boolean; error?: string; duplicate?: boolean }) => void) => {
    const id = String(callId || '');
    const link = await getCallLinkFromAnyStore(id);
    if (!link) {
      ack?.({ ok: false, error: 'not_found' });
      return;
    }

    logger.debug('Call accepted', { callId: id });

    // КРИТИЧНО: Принятие возможно даже если инициатор (A) офлайн — он получит call:accepted при reauth
    const aSock = findSocketForUser(io, link.a);
    const bSock = (sock as any)?.data?.userId === link.b ? (sock as AuthedSocket) : findSocketForUser(io, link.b);

    if (!bSock) {
      ack?.({ ok: false, error: 'callee_socket_not_found' });
      return;
    }
    const shouldProcess = transitionCall(id, 'accepted', {
      actionKey: `socket_accept:${id}:${link.b}`,
      source: 'socket_accept',
    });
    if (!shouldProcess) {
      const timeline = getCallTimeline(id);
      const hasAcceptedRoom =
        callIdToRoomId.has(id) ||
        activeRoomByUserId.has(link.a) ||
        activeRoomByUserId.has(link.b);
      const isRealDuplicate =
        !!timeline &&
        (
          timeline.state === 'declined' ||
          timeline.state === 'canceled' ||
          timeline.state === 'timeout' ||
          timeline.state === 'ended' ||
          (timeline.state === 'accepted' && hasAcceptedRoom)
        );
      if (isRealDuplicate) {
        ack?.({ ok: true, duplicate: true });
        return;
      }
      logger.warn('[call:accept] orchestration transition skipped but accept flow will continue', {
        callId: id,
        hasTimeline: !!timeline,
        state: timeline?.state,
        hasAcceptedRoom,
      });
    }
    if (link.timer) {
      try { clearTimeout(link.timer); } catch {}
      link.timer = undefined;
    }
    if (link.retryPushTimer) {
      try { clearTimeout(link.retryPushTimer); } catch {}
      link.retryPushTimer = undefined;
    }

    {
      // КРИТИЧНО: Используем user IDs для имени комнаты, чтобы совпадало с LiveKit
      // Это гарантирует что оба участника подключатся к одной LiveKit комнате
      let roomId: string;
      if (link.a && link.b) {
        const sortedUserIds = [link.a, link.b].sort();
        roomId = `room_${sortedUserIds[0]}_${sortedUserIds[1]}`;
        console.log('[call:accept] roomId from user IDs', { linkA: link.a, linkB: link.b, roomId });
      } else {
        // Fallback на socket IDs если user IDs недоступны (aSock может быть undefined — инициатор офлайн)
        const sorted = [aSock?.id ?? 'unknown', bSock.id].sort();
        roomId = `room_${sorted[0]}_${sorted[1]}`;
        console.log('[call:accept] FALLBACK roomId from socket IDs', { aSockId: aSock?.id, bSockId: bSock.id, roomId });
      }

      // КРИТИЧНО: Присоединяем к комнате всех, кто сейчас подключён; инициатор может подключиться позже (reauth)
      try {
        if (link.a && aSock) evictExtraUserSocketsInDirectRoom(io, roomId, link.a, aSock.id);
        if (link.b && bSock) evictExtraUserSocketsInDirectRoom(io, roomId, link.b, bSock.id);
      } catch {}
      try { if (aSock) { aSock.join(roomId); logger.debug('Participant A joined room', { socketId: aSock.id, roomId, callId: id }); } } catch {}
      try { bSock.join(roomId); logger.debug('Participant B joined room', { socketId: bSock.id, roomId, callId: id }); } catch {}

      try { callIdToRoomId.set(id, roomId); } catch {}
      try { if (aSock) activeCallBySocket.set(aSock.id, roomId); } catch {}
      try { activeCallBySocket.set(bSock.id, roomId); } catch {}

      try {
        sanitizeDirectCallSocketIoRoom(io, roomId, activeCallBySocket);
      } catch {}

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

      // Создаем LiveKit токены для обоих участников
      const acceptFlowStartedAt = Date.now();
      let livekitTokenA: string | null = null;
      let livekitTokenB: string | null = null;
      let livekitRoomName: string = roomId;

      const livekitIdentityA = link.a || (aSock ? `socket:${aSock.id}` : 'unknown');
      const livekitIdentityB = link.b || `socket:${bSock.id}`;

      if (link.a && link.b) {
        const sortedUserIds = [link.a, link.b].sort();
        livekitRoomName = `room_${sortedUserIds[0]}_${sortedUserIds[1]}`;
      }

      // КРИТИЧНО: Логируем детали перед созданием токенов
      console.log('[call:accept] Creating LiveKit tokens', {
        linkA: link.a,
        linkB: link.b,
        aSockId: aSock?.id,
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

      // КРИТИЧНО: Отправляем call:accepted только если оба токена созданы. Иначе клиенты получат пустой токен и не подключатся к LiveKit.
      if (!livekitTokenA || !livekitTokenB) {
        logger.warn('[call:accept] Not sending call:accepted — token creation failed', { callId: id });
        try { callIdToRoomId.delete(id); } catch {}
        try { activeRoomByUserId.delete(link.a); } catch {}
        try { activeRoomByUserId.delete(link.b); } catch {}
        if (aSock) {
          try { aSock.leave(roomId); } catch {}
          try { activeCallBySocket.delete(aSock.id); } catch {}
          (aSock as any).data.busy = false;
          (aSock as any).data.roomId = undefined;
          (aSock as any).data.partnerSid = undefined;
          (aSock as any).data.inCall = false;
          aSock.emit('call:error', { callId: id, reason: 'token_failed' });
          await emitPresenceUpdateToFriends(io, link.a, false);
        }
        if (bSock) {
          try { bSock.leave(roomId); } catch {}
          try { activeCallBySocket.delete(bSock.id); } catch {}
          (bSock as any).data.busy = false;
          (bSock as any).data.roomId = undefined;
          (bSock as any).data.partnerSid = undefined;
          (bSock as any).data.inCall = false;
          bSock.emit('call:error', { callId: id, reason: 'token_failed' });
          await emitPresenceUpdateToFriends(io, link.b, false);
        }
        cleanupCall(id);
        ack?.({ ok: false, error: 'token_failed' });
        return;
      }

      // Отправляем call:accepted с LiveKit credentials
      if (aSock) {
        try {
          aSock.emit('call:accepted', {
            callId: id,
            from: bSock?.id,
            fromUserId: link.b,
            roomId,
            livekitToken: livekitTokenA,
            livekitRoomName,
            livekitUrl: getLiveKitUrl() || null,
          });
          rememberCallAcceptedDelivery(id, link.a, {
            callId: id,
            roomId,
            livekitRoomName,
            peerUserId: link.b,
          }, {
            source: 'call:accept',
            socketId: aSock.id,
          });
        } catch (e) {
          console.error('[call:accept] ❌ Error sending call:accepted to participant A:', e);
        }
      }
      if (bSock) {
        try {
          bSock.emit('call:accepted', {
            callId: id,
            from: aSock?.id,
            fromUserId: link.a,
            roomId,
            livekitToken: livekitTokenB,
            livekitRoomName,
            livekitUrl: getLiveKitUrl() || null,
          });
          rememberCallAcceptedDelivery(id, link.b, {
            callId: id,
            roomId,
            livekitRoomName,
            peerUserId: link.a,
          }, {
            source: 'call:accept',
            socketId: bSock.id,
          });
        } catch (e) {
          console.error('[call:accept] ❌ Error sending call:accepted to participant B:', e);
        }
      }

      // Важно для UX инициатора: presence-update не должен блокировать call:accepted.
      // Сначала переводим участников на экран видеозвонка, затем обновляем busy у друзей.
      try {
        await emitPresenceUpdateCallToFriends(io, link.a, link.b, true);
      } catch (e: any) {
        logger.warn('[call:accept] emitPresenceUpdateCallToFriends failed (post-accepted)', {
          callId: id,
          error: e?.message,
        });
      }

      // Сохраняем pending room для обоих участников, чтобы reconnect/reauth могли
      // восстановить call:accepted и подключение к LiveKit без повторного входящего.
      const pendingRoomForA: PendingAcceptedRoom = { callId: id, roomId, livekitRoomName, peerUserId: link.b };
      const pendingRoomForB: PendingAcceptedRoom = { callId: id, roomId, livekitRoomName, peerUserId: link.a };
      try {
        activeRoomByUserId.set(link.a, pendingRoomForA);
        activeRoomByUserId.set(link.b, pendingRoomForB);
        rememberCallAcceptedDelivery(id, link.a, pendingRoomForA);
        rememberCallAcceptedDelivery(id, link.b, pendingRoomForB);
        if (!aSock) logger.info('[call:accept] Caller offline, stored pending call for reauth', { userId: link.a, roomId, callId: id });
        await releaseRingingCallPersistence(id, { a: link.a, b: link.b });
      } catch {}
      // Всегда шлём FCM инициатору: при экране исходящего сокет может быть отключён или событие не доходит — FCM выведет приложение, по getAccepted получим call:accepted
      try {
        await sendCallAcceptedToCaller(link.a, id);
      } catch (e: any) {
        logger.warn('[call:accept] sendCallAcceptedToCaller failed', { callerUserId: link.a, error: e?.message });
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

      logger.debug('Direct call room established', {
        roomId,
        callId: id,
        aConnected: !!aSock,
        bConnected: !!bSock,
        acceptFlowLatencyMs: Date.now() - acceptFlowStartedAt,
      });
      ack?.({ ok: true });
    }
  });

  // Инициатор получил FCM call_accepted и вывел приложение — запрашивает payload call:accepted (сокет мог не доставить событие с нативного экрана исходящего)
  sock.on('call:getAccepted', async ({ callId: reqCallId }: { callId?: string }) => {
    const id = String(reqCallId || '');
    const userId = (sock as any)?.data?.userId;
    if (!userId) return;
    const pendingRoom = activeRoomByUserId.get(userId);
    if (!pendingRoom || pendingRoom.callId !== id) return;
    try {
      const emitted = await emitPendingCallAcceptedToSocket(io, sock, String(userId), pendingRoom, 'call:getAccepted');
      if (emitted) {
        logger.info('[call:getAccepted] Sent call:accepted to caller', { userId, callId: id });
        scheduleGlobalFriendPresenceEmit(io, userId);
      }
    } catch (e: any) {
      logger.warn('[call:getAccepted] Failed to send call:accepted', { userId, callId: id, error: e?.message });
    }
  });

  // Получатель подтверждает фактический показ входящего экрана (когда приложение живо и есть socket).
  sock.on('call:incoming_shown', async ({ callId }: { callId?: string }) => {
    try {
      const id = String(callId || '').trim();
      const me = String((sock as any)?.data?.userId || '');
      if (!id || !me) return;
      const link = await getCallLinkFromAnyStore(id);
      const telemetry = callDeliveryById.get(id);
      const expectedCallee = link?.b || telemetry?.calleeId;
      if (!expectedCallee || String(expectedCallee) !== me) return;
      const now = Date.now();
      const t = telemetry ?? {
        callerId: link?.a || '',
        calleeId: expectedCallee,
        createdAtMs: now,
        expiresAtMs: link?.expiresAtMs || now + CALL_RING_TIMEOUT_MS,
      };
      if (!t.incomingShownAtMs) {
        t.incomingShownAtMs = now;
        t.incomingShownBy = 'socket';
        callDeliveryById.set(id, t);
        markIncomingShownOrchestration(id, 'socket');
        const activeLink = callsById.get(id);
        if (activeLink?.retryPushTimer) {
          try { clearTimeout(activeLink.retryPushTimer); } catch {}
          activeLink.retryPushTimer = undefined;
        }
        const ageFromStartMs = now - t.createdAtMs;
        const ageFromPushMs = t.pushSentAtMs != null ? now - t.pushSentAtMs : undefined;
        logger.info('[call:incoming_shown] received from socket', {
          callId: id,
          caller: t.callerId,
          callee: t.calleeId,
          ageFromStartMs,
          ageFromPushMs,
        });
        pushLog('call_incoming_shown', { callId: id, via: 'socket', ageFromStartMs, ageFromPushMs });
      }
    } catch {}
  });

  sock.on('call:decline', async ({ callId }: { callId?: string }) => {
    const id = String(callId || '');
    const link = await getCallLinkFromAnyStore(id);
    if (!link) return;
    const shouldProcess = transitionCall(id, 'declined', {
      actionKey: `socket_decline:${id}:${String((sock as any)?.data?.userId || '')}`,
      source: 'socket_decline',
    });
    if (!shouldProcess) return;

    // Снимаем busy статус с обоих участников при отклонении
    clearDirectCallSessionForUser(io, link.a);
    clearDirectCallSessionForUser(io, link.b);
    await emitPresenceUpdateCallToFriends(io, link.a, link.b, false);

    try {
      const sortedU = [link.a, link.b].sort();
      dissolveSocketIoRoom(io, `room_${sortedU[0]}_${sortedU[1]}`);
    } catch {}

    try { io.to(`u:${link.a}`).emit('call:declined', { callId: id, from: link.b }); } catch {}
    logger.info('[call:decline] sending call_declined push to caller', { callId: id, caller: link.a, callee: link.b });
    try { await sendCallDeclinedToCaller(link.a, id); } catch (e: any) { logger.warn('[call:decline] sendCallDeclinedToCaller failed', { error: e?.message }); }
    // Отклонение получателем — не пропущенный вызов; call_ended получателю не шлём
    logger.info('[call:decline] call ended for both: caller notified (socket+FCM), callee closed', { callId: id, caller: link.a, callee: link.b });
    cleanupCall(id, 'declined');
  });

  sock.on('call:cancel', async ({ callId }: { callId?: string }) => {
    const id = String(callId || '');
    const link = await getCallLinkFromAnyStore(id);
    if (!link) return;
    const shouldProcess = transitionCall(id, 'canceled', {
      actionKey: `socket_cancel:${id}:${String((sock as any)?.data?.userId || '')}`,
      source: 'socket_cancel',
    });
    if (!shouldProcess) {
      handleCancelDeduped(id, link, 'socket_deduped');
      return;
    }

    // Снимаем busy статус с обоих участников при отмене
    clearDirectCallSessionForUser(io, link.a);
    clearDirectCallSessionForUser(io, link.b);
    await emitPresenceUpdateCallToFriends(io, link.a, link.b, false);

    try {
      const sortedU = [link.a, link.b].sort();
      dissolveSocketIoRoom(io, `room_${sortedU[0]}_${sortedU[1]}`);
    } catch {}

    logger.info('[call:cancel] processed (socket), clearing ring timer if any', {
      callId: id,
      hadTimer: !!callsById.get(id)?.timer,
    });

    // уведомим получателя и инициатора одинаковым событием call:cancel,
    // чтобы оба клиента синхронно закрыли UI входящего/исходящего звонка
    try { io.to(`u:${link.a}`).emit('call:cancel', { callId: id, from: link.a }); } catch {}
    try { io.to(`u:${link.b}`).emit('call:cancel', { callId: id, from: link.a }); } catch {}
    logger.info('[call:cancel] sending call_canceled push to callee', { callId: id, caller: link.a, callee: link.b });
    let fromNick: string | undefined;
    try {
      if (isMongoReady()) {
        const u = await User.findById(link.a).select('nick').lean();
        if (u && typeof (u as any).nick === 'string') fromNick = String((u as any).nick).trim() || undefined;
      }
    } catch {}
    // FCM data-only получателю: снимаем «входящий вызов», показываем «пропущенный вызов», счётчик на иконке
    try { await sendCallCanceledToRecipient(link.b, id, link.a, fromNick); } catch (e: any) { logger.warn('[call:cancel] sendCallCanceledToRecipient failed', { error: e?.message }); }
    if (!hasSocketForUser(io, link.b)) await saveMissedCall(link.b, link.a, fromNick || '');
    logger.info('[call:cancel] call ended for both: both notified (socket+FCM, callee got missed from native)', { callId: id, caller: link.a, callee: link.b });
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
        const partnerSocket = findSocketForUser(io, partnerUserId);
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
        const partnerSocket = findSocketForUser(io, partnerUserId);
        if (partnerSocket) {
          (partnerSocket as any).emit('partner:returned');
          logger.debug('Sent partner:returned to partner', { partnerUserId });
        }
      }
    } catch (e) {
      logger.error('Error handling partner:returned', { error: (e as any)?.message || String(e) });
    }
  });

  /* ---- disconnect (единый обработчик: сначала webrtc cleanup, затем unpair/очередь) ---- */
  sock.on('disconnect', async (reason: any) => {
    const userId = (sock as any)?.data?.userId;
    if (isShuttingDown()) {
      try {
        await onSocketDisconnectWebRTC(io, sock);
      } catch (e: any) {
        logger.warn('onSocketDisconnectWebRTC failed during shutdown', { socketId: sock.id, error: e?.message });
      }
      try {
        await unpair(sock.id);
      } catch {}
      try {
        await removeFromWaitingQueue(sock.id);
      } catch {}
      try {
        unbindUser(sock);
      } catch {}
      return;
    }
    try {
      await onSocketDisconnectWebRTC(io, sock);
    } catch (e: any) {
      logger.warn('onSocketDisconnectWebRTC failed', { socketId: sock.id, error: e?.message });
    }
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
    try {
      const uidStr = userId ? String(userId) : '';
      if (uidStr) {
        const appFg = (sock as any)?.data?.appForeground;
        const otherSocketsSameUser = getSocketsForUser(io, uidStr).filter((s) => s.id !== sock.id);
        if (otherSocketsSameUser.length === 0 && appFg !== false) {
          touchStickyForegroundOnline(uidStr);
          armStickyForegroundPresenceResolution(io, uidStr);
        }
      }
    } catch {}
    unbindUser(sock);
    try {
      const uidStr = userId ? String(userId) : '';
      if (uidStr) {
        cancelInAppOfflinePresenceEmit(uidStr);
        armInAppOfflinePresenceEmit(io, uidStr);
      }
    } catch {}
    schedulePresenceEmitAfterDisconnect(io, userId ? String(userId) : null);
    // Удаляем из очереди random
    await removeFromWaitingQueue(sock.id);
    // НЕ вызываем setRandomBusy(userId, false): busy снимается только при завершении звонка (call:end),
    // иначе при обрыве связи друзья увидят пользователя как «не занят» и смогут позвонить в активную комнату.

    // Очищаем дружеские комнаты при дисконнекте
    if (userId) {
      // Обновляем состояние всех комнат, где был этот пользователь
      sock.rooms.forEach((roomId) => {
        if (roomId.startsWith('room_')) {
          void updateFriendRoomState(io, roomId);
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

void (async () => {
  try {
    closeSocketIoRedisAdapter = await setupSocketIoRedisAdapter(io);
  } catch (e: any) {
    logger.warn('[socket.io:redis] unexpected setup error, continuing without adapter', {
      error: e?.message || String(e),
    });
    closeSocketIoRedisAdapter = async () => {};
  } finally {
    server.listen(PORT, HOST, () => printLanUrls(PORT));
  }
})();

const GRACEFUL_SHUTDOWN_EMIT_FLUSH_MS = 200;
const GRACEFUL_SHUTDOWN_FORCE_EXIT_MS = 85_000;
let gracefulShutdownStarted = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (gracefulShutdownStarted) return;
  gracefulShutdownStarted = true;
  logger.info(`${signal} received, shutting down gracefully...`);
  setShuttingDown(true);

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, GRACEFUL_SHUTDOWN_FORCE_EXIT_MS);

  try {
    stopQueueCleanup();
  } catch (e: any) {
    logger.warn('stopQueueCleanup failed', { error: e?.message });
  }
  try {
    io.emit('server:restarting', { ok: true, ts: Date.now() });
  } catch {}
  // Дать клиентам шанс получить server:restarting до обрыва TCP.
  await new Promise((r) => setTimeout(r, GRACEFUL_SHUTDOWN_EMIT_FLUSH_MS));

  // Socket.IO close() гасит Engine и вызывает httpServer.close() на том же server (см. socket.io dist/index.js).
  // Повторный server.close() даёт ERR_SERVER_NOT_RUNNING — логировали как server.close error.
  try {
    await io.close();
  } catch (e: any) {
    logger.warn('io.close failed', { error: e?.message });
  }
  try {
    if (closeSocketIoRedisAdapter) {
      await closeSocketIoRedisAdapter();
      closeSocketIoRedisAdapter = null;
    }
  } catch (e: any) {
    logger.warn('socket.io redis adapter close failed', { error: e?.message });
  }
  try {
    await mongoose.connection.close();
  } catch (e: any) {
    logger.warn('mongoose.close failed', { error: e?.message });
  }
  try {
    await queueStore.close();
  } catch (e: any) {
    logger.warn('queueStore.close failed', { error: e?.message });
  }
  try {
    await rateLimitStore.close();
  } catch (e: any) {
    logger.warn('rateLimit.close failed', { error: e?.message });
  }
  clearTimeout(forceExit);
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});
