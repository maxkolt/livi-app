// routes/friends.ts
import { Router } from 'express';
import User from '../models/User';
import { getFriendsPaginated, areFriendsCached } from '../utils/friendshipUtils';

const router = Router();

router.get('/friends', async (req, res) => {
  try {
    const userId = (req as any)?.auth?.userId as string | undefined;
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;

    // Используем оптимизированную функцию с пагинацией
    const result = await getFriendsPaginated(userId, page, limit);

    const list = result.friends.map((friend) => ({
      _id: String(friend._id),
      nick: friend.nick || '',
      avatar: (friend as any).avatar || '',
      avatarVer: (friend as any).avatarVer || 0,
      avatarThumbB64: (friend as any).avatarThumbB64 || '', // мини сразу в список
      online: false, // TODO: добавить проверку онлайн статуса
    }));

    res.json({ 
      ok: true, 
      list,
      pagination: {
        page,
        limit,
        total: result.total,
        hasMore: result.hasMore
      }
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/friends/check/:userId', async (req, res) => {
  try {
    const me = (req as any)?.auth?.userId as string | undefined;
    const targetUserId = req.params.userId;
    
    if (!me) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!targetUserId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

    const areFriends = await areFriendsCached(me, targetUserId);
    
    res.json({ ok: true, areFriends });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Endpoint для обработки реферальных ссылок
router.get('/invite/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const me = (req as any)?.userId as string | undefined; // Текущий пользователь (если авторизован)
    
    console.log('[friends] /api/invite/:code called', { code, me, url: req.url, path: req.path });
    
    // Проверяем валидность кода (должен быть ObjectId)
    if (!code || !/^[a-f\d]{24}$/i.test(code)) {
      console.log('[friends] Invalid code format:', code);
      return res.status(400).json({ ok: false, error: 'invalid_code' });
    }

    // Ищем пользователя по коду
    const inviter = await User.findById(code).select('nick avatar avatarVer avatarThumbB64').lean();
    
    if (!inviter) {
      return res.status(404).json({ ok: false, error: 'user_not_found' });
    }

    // Если пользователь авторизован, проверяем статус дружбы
    let areFriends = false;
    let hasPendingRequest = false;
    
    if (me && me !== code) {
      // Проверяем, не являются ли они уже друзьями
      areFriends = await areFriendsCached(me, code);
      
      // Проверяем, есть ли уже заявка в друзья
      if (!areFriends) {
        const meUser = await User.findById(me).select('friendRequests').lean();
        if (meUser && Array.isArray((meUser as any).friendRequests)) {
          hasPendingRequest = (meUser as any).friendRequests.some((id: any) => String(id) === code);
        }
      }
    }

    const response = {
      ok: true,
      inviter: {
        id: String(inviter._id),
        nick: inviter.nick || '',
        avatar: (inviter as any).avatar || '',
        avatarVer: (inviter as any).avatarVer || 0,
        avatarThumbB64: (inviter as any).avatarThumbB64 || '',
      },
      areFriends,
      hasPendingRequest,
      canAdd: me && me !== code && !areFriends && !hasPendingRequest,
    };
    
    console.log('[friends] /api/invite/:code success', { code, hasInviter: !!inviter, areFriends, hasPendingRequest });
    res.json(response);
  } catch (e: any) {
    console.error('[friends] /api/invite/:code error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
