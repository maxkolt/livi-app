// backend/routes/me.ts
import { Router } from 'express';
import UserModel from '../models/User';
import type { Server as IOServer } from 'socket.io';

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

export default router;
