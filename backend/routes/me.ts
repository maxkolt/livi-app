// backend/routes/me.ts
import { Router } from 'express';
import UserModel from '../models/User';
import Install from '../models/Install';
import mongoose from 'mongoose';
import type { Server as IOServer } from 'socket.io';
import { sendPushToUser, upsertExpoPushToken } from '../utils/push';
import { getPushLog, pushLog } from '../utils/pushLogBuffer';
import { logger } from '../utils/logger';
import { auditNickChange } from '../utils/profileNickAudit';
import { checkRateLimit } from '../utils/rateLimit';

const router = Router();

// Проверка существования пользователя
router.get('/exists/:userId', async (req, res) => {
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
const debugLog = (...args: any[]) => {
  if (isDebug) {}
};

const isHttp = (s?: string) =>
  typeof s === 'string' && /^https?:\/\//i.test(String(s).trim());

/**
 * ВАЖНО:
 * В index.ts ДО подключения роутов прокинь io:
 *   app.use((req, _res, next) => { (req as any).io = io; next(); });
 * И не забудь json-парсер:
 *   app.use(express.json({ limit: '10mb' }));
 */
router.patch('/me', async (req, res) => {
  try {
    const userId =
      ((req as any)?.auth?.userId as string | undefined) ||
      ((req as any)?.userId as string | undefined);

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

    const io = (req as any).io as IOServer | undefined;

    const { nick, avatar } = (req.body || {}) as {
      nick?: string;
      avatar?: string | null; // '' | null => очистить
    };

    // ---- готовим апдейт ----
    const safe: any = {};

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
      .select('nick avatar avatarVer friends')
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
          avatar: (current as any).avatar || '',
          friends: current.friends || [],
        },
      });
    }

    // проверяем, что значения действительно изменились
    const hasChanges = Object.keys($set).some(key => {
      const newValue = $set[key];
      const currentValue = (current as any)[key];
      return newValue !== currentValue;
    });

    if (!hasChanges) {
      return res.json({
        ok: true,
        user: {
          id: String(current._id),
          nick: current.nick || '',
          avatar: (current as any).avatar || '',
          friends: current.friends || [],
        },
      });
    }

    if (typeof nick === 'string') {
      const nextN = nick.trim();
      const prevN = String((current as any).nick ?? '');
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
      .select('nick avatar avatarVer avatarThumbB64 friends')
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
          avatar: (me as any).avatar || '',
          avatarVer: (me as any).avatarVer || 0,
          avatarThumbB64: (me as any).avatarThumbB64 || '',
        };
        const friends = Array.isArray(me.friends) ? me.friends.map(String) : [];
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
        avatar: (me as any).avatar || '',
        avatarVer: (me as any).avatarVer || 0,
        avatarThumbB64: (me as any).avatarThumbB64 || '',
        friends: me.friends || [],
      },
    });
  } catch (e: any) {
    console.error('PATCH /api/me ERROR:', e?.message || e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * Регистрация Expo Push Token для устройства.
 * Ожидаем заголовки:
 * - x-user-id (или userId в query/по installId — как в глобальном middleware)
 * - x-install-id (желательно)
 */
router.post('/push-token', async (req, res) => {
  try {
    const installId = String(req.header('x-install-id') || '');
    if (!installId) {
      return res.status(401).json({ ok: false, error: 'no_installId' });
    }

    // Защита от спама: лимит щедрый, т.к. приложение перерегистрирует токен при каждом запуске и при реконнекте сокета
    const rl = checkRateLimit(`push_token:${installId}`, 60, 60 * 60_000);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec || 3600));
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
    const inst = await Install.findOne({ installId }).select('user').lean();
    const userId = inst?.user ? String((inst as any).user) : '';
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const claimed = String(req.header('x-user-id') || '').trim();
    if (claimed && claimed !== userId) {
      logger.warn('[push] x-user-id mismatch for installId', { installId, claimedUserId: claimed, userId });
      // do not allow registering a token for a different user
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const { token, platform, fcmToken } = (req.body || {}) as { token?: string; platform?: 'ios' | 'android'; fcmToken?: string };

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ ok: false, error: 'token_required' });
    }
    if (platform !== 'ios' && platform !== 'android') {
      return res.status(400).json({ ok: false, error: 'platform_required' });
    }

    const fcm = typeof fcmToken === 'string' && fcmToken.length > 0 ? fcmToken : undefined;
    await upsertExpoPushToken({ userId, installId, platform, token, fcmToken: fcm });
    pushLog('token_registered', {
      userId: String(userId),
      platform,
      hasFcmToken: !!fcm,
    });
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

/**
 * DEBUG: отправить тестовый push текущему пользователю.
 * Полезно чтобы проверить, что токен зарегистрирован и пуши доходят в фоне/убитом приложении.
 */
router.post('/push-test', async (req, res) => {
  try {
    const userId =
      ((req as any)?.auth?.userId as string | undefined) ||
      ((req as any)?.userId as string | undefined);

    if (!userId) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const kind = (String((req.body as any)?.kind || 'message') as 'message' | 'call');
    const title = String(
      (req.body as any)?.title || (kind === 'call' ? 'Входящий звонок' : 'Тестовое сообщение')
    );
    const body = String((req.body as any)?.body || (kind === 'call' ? 'Кто-то звонит' : 'Это тестовый push'));

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
  } catch (e: any) {
    logger.warn('[push] push-test failed', e as any);
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

/**
 * DEBUG: последние события пуша (sendCallPushToRecipient, FCM/Expo, token registered).
 * Для отладки входящего звонка: после теста вызови GET /api/debug/push-log и проверь, был ли "call push sent via FCM" или "sending via Expo".
 */
router.get('/debug/push-log', (_req, res) => {
  try {
    return res.json({ ok: true, entries: getPushLog() });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

export default router;
