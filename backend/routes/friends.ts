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

export default router;
