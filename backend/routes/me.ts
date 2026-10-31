// backend/routes/me.ts
import { Router, type Request } from 'express';
import UserModel from '../models/User';
import mongoose from 'mongoose';
import type { Server as IOServer } from 'socket.io';
import { sendPushToUser, upsertExpoPushToken } from '../utils/push';
import { getPushLog, pushLog } from '../utils/pushLogBuffer';
import { logger } from '../utils/logger';
import { auditNickChange } from '../utils/profileNickAudit';
import { checkRateLimit } from '../utils/rateLimit';
import { getFriendIds } from '../utils/friendshipUtils';

type ProfileRequest = Request<Record<string, string>, unknown, Record<string, unknown>> & {
  userId?: string;
  auth?: { userId?: string };
  io?: IOServer;
};
type ProfilePatch = { nick?: string; avatar?: string };

const router = Router();

// Проверка существования пользователя
router.get('/exists/:userId', async (req: ProfileRequest, res) => {
  try {
    const { userId } = req.params;
    // Убираем избыточное логирование - функция вызывается слишком часто
    // console.log('[user-exists] Checking user existence:', userId);
    
    if (!userId) {
      return res.status(400).json({ ok: false, error: 'userId required' });
    }
    
    const user = await UserModel.findById(userId).select('_id nick').lean();
    
    if (user) {
      // Убираем избыточное логирование
      // console.log('[user-exists] User found:', userId);
      return res.json({
        ok: true,
        exists: true,
        user: {
          id: String(user._id),
          nick: user.nick || ''
        }
      });
    } else {
      // Убираем избыточное логирование
      // console.log('[user-exists] User not found:', userId);
      return res.json({
        ok: true,
        exists: false
      });
    }
  } catch (e) {
    console.error('[user-exists] Error:', e);
    return res.status(500).json({
      ok: false,
      error: 'Failed to check user existence'
    });
  }
});

// Условное логирование для отладки
const isDebug = process.env.NODE_ENV === 'development' || process.env.DEBUG_LOGS === 'true';
const debugLog = (...args: unknown[]) => {
  if (isDebug) {}
};

const isHttp = (s?: string) =>
  typeof s === 'string' && /^https?:\/\//i.test(String(s).trim());

/**
 * ВАЖНО:
 * В index.ts ДО подключения роутов middleware должен записать экземпляр io в req.io.
 * И не забудь json-парсер:
 *   app.use(express.json({ limit: '10mb' }));
 */
router.patch('/me', async (req: ProfileRequest, res) => {
  try {
    const userId =
      ((req)?.auth?.userId as string | undefined) ||
      ((req)?.userId as string | undefined);

    debugLog('PATCH /api/me START →', {
      userId,
      headers: {
        'x-user-id': req.headers['x-user-id'],
        origin: req.headers.origin,
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
      },
      timestamp: new Date().toISOString(),
      bodyKeys: Object.keys(req.body || {}),
      bodyPreview: Object.fromEntries(
        Object.entries(req.body || {}).map(([k, v]) => [
          k,
          typeof v === 'string' ? v.slice(0, 120) : v,
        ])
      ),
    });

    if (!userId) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const io = (req).io as IOServer | undefined;

    const { nick, avatar } = (req.body || {}) as {
      nick?: string;
      avatar?: string | null; // '' | null => очистить
    };

    // ---- готовим апдейт ----
    const safe: ProfilePatch = {};

    if (typeof nick === 'string') {
      safe.nick = nick.trim();
    }

    // avatar:
    // - undefined — не трогаем
    // - '' или null — очищаем (ставим '')
    // - http(s) — сохраняем
    // - file://, ph://, content://, data: — игнорируем
    if (avatar !== undefined) {
      const raw = (avatar ?? '').trim();
      
      debugLog('PATCH /api/me avatar check:', {
        received: avatar,
        raw,
        isEmpty: raw === '' || avatar === null,
        isHttp: isHttp(raw),
      });

      if (raw === '' || avatar === null) {
        safe.avatar = '';
      } else if (isHttp(raw)) {
        safe.avatar = raw;
      } else {
        debugLog('PATCH /api/me: ignore non-http avatar →', raw);
      }
    }

    const $set = safe;

    debugLog('PATCH /api/me → mongoose update $set =', $set);

    // получаем текущие данные пользователя для проверки изменений
    const current = await UserModel.findById(userId)
      .select('nick avatar avatarVer')
      .lean();
    if (!current) {
      return res.status(404).json({ ok: false, error: 'user_not_found' });
    }

    // если нечего апдейтить — вернём текущего пользователя
    if (Object.keys($set).length === 0) {
      return res.json({
        ok: true,
        user: {
          id: String(current._id),
          nick: current.nick || '',
          avatar: (current).avatar || '',
          friends: await getFriendIds(userId),
        },
      });
    }

    // проверяем, что значения действительно изменились
    const hasChanges = (Object.keys($set) as Array<keyof ProfilePatch>).some(key => {
      const newValue = $set[key];
      const currentValue = (current)[key];
      return newValue !== currentValue;
    });

    if (!hasChanges) {
      return res.json({
        ok: true,
        user: {
          id: String(current._id),
          nick: current.nick || '',
          avatar: (current).avatar || '',
          friends: await getFriendIds(userId),
        },
      });
    }

    if (typeof nick === 'string') {
      const nextN = nick.trim();
      const prevN = String((current).nick ?? '');
      if (nextN !== prevN) {
        const xf = req.headers['x-forwarded-for'];
        const clientIp =
          typeof xf === 'string' && xf.trim()
            ? xf.split(',')[0].trim()
            : req.socket.remoteAddress;
        auditNickChange({
          source: 'http.PATCH /api/me',
          userId,
          prevNick: prevN,
          nextNick: nextN,
          userAgent: req.get('user-agent') || undefined,
          clientIp: clientIp || undefined,
        });
      }
    }

    // апдейтим и читаем обновлённого
    const me = await UserModel.findByIdAndUpdate(
      userId,
      { $set },
      { new: true, runValidators: true }
    )
      .select('nick avatar avatarVer avatarThumbB64')
      .lean();


    if (!me) {
      return res.json({ ok: true, user: { id: String(userId), nick: '', avatar: '', avatarVer: 0, friends: [] } });
    }

    // Stream sync убран - больше не используется

    // ---- оповещаем друзей ----
    try {
      if (io) {
        const payload = {
          userId: String(userId),
          nick: me.nick || '',
          avatar: (me).avatar || '',
          avatarVer: (me).avatarVer || 0,
          avatarThumbB64: (me).avatarThumbB64 || '',
        };
        const friends = await getFriendIds(userId);
        for (const fid of friends) {
          io.to(`u:${fid}`).emit('friend:profile', payload);
        }
      }
    } catch (e) {
      console.warn('friends notify error:', e);
    }

    return res.json({
      ok: true,
      user: {
        id: String(userId),
        nick: me.nick || '',
        avatar: (me).avatar || '',
        avatarVer: (me).avatarVer || 0,
        avatarThumbB64: (me).avatarThumbB64 || '',
        friends: await getFriendIds(userId),
      },
    });
  } catch (e) {
    console.error('PATCH /api/me ERROR:', (e as { message?: unknown } | null)?.message || e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * Регистрация push-токенов для устройства.
 * Ожидаем заголовки:
 * - x-user-id (или userId в query/по installId — как в глобальном middleware)
 * - x-install-id (желательно)
 */
router.post('/push-token', async (req: ProfileRequest, res) => {
  try {
    const installId = String(req.header('x-install-id') || '');
    if (!installId) {
      return res.status(401).json({ ok: false, error: 'no_installId' });
    }

    // Защита от спама: лимит щедрый, т.к. приложение перерегистрирует токен при каждом запуске и при реконнекте сокета
    const rl = await checkRateLimit(`push_token:${installId}`, 60, 60 * 60_000, {
      sensitive: true,
    });
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec || 3600));
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
    // Пользователя уже определил общий middleware (installId + секрет установки).
    const userId = String((req).userId || '');
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const claimed = String(req.header('x-user-id') || '').trim();
    if (claimed && claimed !== userId) {
      logger.warn('[push] x-user-id mismatch for installId', { installId, claimedUserId: claimed, userId });
      // do not allow registering a token for a different user
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const { token, platform, fcmToken, voipToken, lang } = (req.body || {}) as {
      token?: string;
      platform?: 'ios' | 'android';
      fcmToken?: string;
      voipToken?: string;
      /** Язык UI устройства — для серверных текстов push. */
      lang?: string;
    };

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ ok: false, error: 'token_required' });
    }
    if (platform !== 'ios' && platform !== 'android') {
      return res.status(400).json({ ok: false, error: 'platform_required' });
    }

    const fcm = typeof fcmToken === 'string' && fcmToken.length > 0 ? fcmToken : undefined;
    const voip = typeof voipToken === 'string' && voipToken.length > 0 ? voipToken : undefined;
    await upsertExpoPushToken({
      userId,
      installId,
      platform,
      token,
      fcmToken: fcm,
      voipToken: voip,
      lang: typeof lang === 'string' ? lang : undefined,
    });
    pushLog('token_registered', {
      userId: String(userId),
      platform,
      hasFcmToken: !!fcm,
      hasVoipToken: !!voip,
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e as { message?: unknown } | null)?.message || 'server_error' });
  }
});

/**
 * DEBUG: отправить тестовый push текущему пользователю.
 * Полезно чтобы проверить, что токен зарегистрирован и пуши доходят в фоне/убитом приложении.
 */
router.post('/push-test', async (req: ProfileRequest, res) => {
  try {
    const userId =
      ((req)?.auth?.userId as string | undefined) ||
      ((req)?.userId as string | undefined);

    if (!userId) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const kind = (String((req.body)?.kind || 'message') as 'message' | 'call');
    const title = String(
      (req.body)?.title || (kind === 'call' ? 'Входящий звонок' : 'Тестовое сообщение')
    );
    const body = String((req.body)?.body || (kind === 'call' ? 'Кто-то звонит' : 'Это тестовый push'));

    await sendPushToUser(String(userId), {
      kind,
      title,
      body,
      channelId: kind === 'call' ? 'calls' : 'messages',
      ...(kind === 'call' ? { categoryId: 'incoming_call' } : {}),
      data:
        kind === 'call'
          ? { type: 'call', from: String(userId), fromNick: 'Тест', callId: `test_${Date.now()}`, categoryId: 'incoming_call' }
          : { type: 'message', from: String(userId), fromNick: '', messageId: `test_${Date.now()}` },
    });

    return res.json({ ok: true });
  } catch (e) {
    logger.warn('[push] push-test failed', e);
    return res.status(500).json({ ok: false, error: (e as { message?: unknown } | null)?.message || 'server_error' });
  }
});

/**
 * DEBUG: последние события пуша (sendCallPushToRecipient, FCM/Expo, token registered).
 * Для отладки входящего звонка: после теста вызови GET /api/debug/push-log и проверь, был ли "call push sent via FCM" или "sending via Expo".
 */
router.get('/debug/push-log', (_req, res) => {
  try {
    return res.json({ ok: true, entries: getPushLog() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e as { message?: unknown } | null)?.message || 'server_error' });
  }
});

export default router;
