// routes/friends.ts
import { Router } from 'express';
import User from '../models/User';
import { getFriendsPaginated, areFriendsCached } from '../utils/friendshipUtils';
import { getIoInstance } from '../utils/ioInstance';
import { getEffectiveBusy } from '../utils/effectiveBusy';
import { isUserVisibleOnline } from '../utils/visibleOnline';

const router = Router();

const isOid = (s?: string) => !!s && /^[a-f\d]{24}$/i.test(String(s || '').trim());

/** Проверка онлайн и занятости по сокетам (как в friends:fetch; callee до принятия не занят) */
function getOnlineAndBusyFromSockets() {
  const io = getIoInstance();
  if (!io) return { isOnline: () => false, isBusy: () => false };

  const isOnline = (uid: string) => isUserVisibleOnline(io, uid);
  const isBusy = (uid: string) => getEffectiveBusy(io, uid);
  return { isOnline, isBusy };
}

router.get('/friends', async (req, res) => {
  try {
    const userId = (req as any)?.userId as string | undefined;
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;

    // Используем оптимизированную функцию с пагинацией
    const result = await getFriendsPaginated(userId, page, limit);

    const { isOnline, isBusy } = getOnlineAndBusyFromSockets();

    const list = result.friends.map((friend) => {
      const friendId = String(friend._id);
      return {
        _id: friendId,
        nick: friend.nick || '',
        avatar: (friend as any).avatar || '',
        avatarVer: (friend as any).avatarVer || 0,
        avatarThumbB64: (friend as any).avatarThumbB64 || '', // мини сразу в список
        online: isOnline(friendId),
        isBusy: isBusy(friendId),
      };
    });

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

/**
 * POST /api/friends/add
 * Body: { to }
 * Mirrors socket "friends:add" behavior (creates pending request).
 */
router.post('/friends/add', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    const to = String(req.body?.to || '').trim();
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!isOid(to)) return res.status(400).json({ ok: false, error: 'invalid_to' });
    if (String(me) === String(to)) return res.status(400).json({ ok: false, error: 'self' });

    const alreadyFriends = await areFriendsCached(me, to);
    if (alreadyFriends) return res.json({ ok: true, status: 'already' });

    const toUserDoc = await User.findById(to).select('friendRequests').lean();
    const alreadyPending =
      Array.isArray((toUserDoc as any)?.friendRequests) &&
      (toUserDoc as any).friendRequests.some((x: any) => String(x) === String(me));
    if (alreadyPending) return res.json({ ok: true, status: 'pending' });

    await (User as any).updateOne({ _id: to }, { $addToSet: { friendRequests: me } });

    // Try to notify recipient via socket (best-effort)
    try {
      const io = (req as any).io as any | undefined;
      if (io) {
        let fromNick: string | undefined;
        try {
          const u = await User.findById(me).select('nick').lean();
          fromNick = (u as any)?.nick || undefined;
        } catch {}
        io.to(`u:${String(to)}`).emit('friend:request', { from: me, fromNick });
      }
    } catch {}

    return res.json({ ok: true, status: 'pending' });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /api/friends/respond
 * Body: { from, accept }
 * Mirrors socket "friends:respond" behavior.
 */
router.post('/friends/respond', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    const from = String(req.body?.from || '').trim();
    const accept = !!req.body?.accept;
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!isOid(from)) return res.status(400).json({ ok: false, error: 'invalid_from' });

    // Remove request from incoming list
    await (User as any).updateOne({ _id: me }, { $pull: { friendRequests: from } });

    if (accept) {
      await (User as any).updateOne({ _id: me }, { $addToSet: { friends: from } });
      await (User as any).updateOne({ _id: from }, { $addToSet: { friends: me } });

      // Send profile snapshots to both sides (best-effort)
      try {
        const io = (req as any).io as any | undefined;
        if (io) {
          const meProfile = await User.findById(me).select('nick avatar avatarVer avatarThumbB64').lean();
          if (meProfile) {
            io.to(`u:${String(from)}`).emit('friend:profile', {
              userId: me,
              nick: String((meProfile as any).nick || '').trim(),
              avatar: String((meProfile as any).avatar || ''),
              avatarVer: (meProfile as any).avatarVer || 0,
              avatarThumbB64: String((meProfile as any).avatarThumbB64 || ''),
            });
          }
          const fromProfile = await User.findById(from).select('nick avatar avatarVer avatarThumbB64').lean();
          if (fromProfile) {
            io.to(`u:${String(me)}`).emit('friend:profile', {
              userId: from,
              nick: String((fromProfile as any).nick || '').trim(),
              avatar: String((fromProfile as any).avatar || ''),
              avatarVer: (fromProfile as any).avatarVer || 0,
              avatarThumbB64: String((fromProfile as any).avatarThumbB64 || ''),
            });
          }
          io.to(`u:${String(me)}`).emit('friend:accepted', { userId: from });
          io.to(`u:${String(from)}`).emit('friend:accepted', { userId: me });
        }
      } catch {}

      return res.json({ ok: true, status: 'accepted' });
    }

    // declined
    try {
      const io = (req as any).io as any | undefined;
      if (io) {
        io.to(`u:${String(me)}`).emit('friend:declined', { userId: from });
        io.to(`u:${String(from)}`).emit('friend:declined', { userId: me });
      }
    } catch {}

    return res.json({ ok: true, status: 'declined' });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /api/friends/acceptInvite
 * Body: { inviterId }
 * Mirrors socket "friends:acceptInvite".
 */
router.post('/friends/acceptInvite', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    const inviterId = String(req.body?.inviterId || '').trim();
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!isOid(inviterId)) return res.status(400).json({ ok: false, error: 'invalid_inviter' });
    if (String(me) === String(inviterId)) return res.status(400).json({ ok: false, error: 'self' });

    const alreadyFriends = await areFriendsCached(me, inviterId);
    if (alreadyFriends) return res.json({ ok: true, status: 'already' });

    await (User as any).updateOne({ _id: me }, { $addToSet: { friends: inviterId } });
    await (User as any).updateOne({ _id: inviterId }, { $addToSet: { friends: me } });

    // remove pending requests if present
    await (User as any).updateOne({ _id: me }, { $pull: { friendRequests: inviterId } });
    await (User as any).updateOne({ _id: inviterId }, { $pull: { friendRequests: me } });

    // best-effort socket notifications
    try {
      const io = (req as any).io as any | undefined;
      if (io) {
        io.to(`u:${String(me)}`).emit('friend:accepted', { userId: inviterId });
        io.to(`u:${String(inviterId)}`).emit('friend:accepted', { userId: me });
      }
    } catch {}

    return res.json({ ok: true, status: 'accepted' });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /api/friends/remove
 * Body: { peerId }
 * Mirrors socket "friends:remove".
 */
router.post('/friends/remove', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    const peerId = String(req.body?.peerId || '').trim();
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!isOid(peerId)) return res.status(400).json({ ok: false, error: 'invalid_peer' });
    if (String(me) === String(peerId)) return res.status(400).json({ ok: false, error: 'self' });

    await (User as any).updateOne({ _id: me }, { $pull: { friends: peerId } });
    await (User as any).updateOne({ _id: peerId }, { $pull: { friends: me } });

    // best-effort socket notifications
    try {
      const io = (req as any).io as any | undefined;
      if (io) {
        io.to(`u:${String(me)}`).emit('friend:removed', { userId: peerId });
        io.to(`u:${String(peerId)}`).emit('friend:removed', { userId: me });
      }
    } catch {}

    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/friends/check/:userId', async (req, res) => {
  try {
    const me = (req as any)?.userId as string | undefined;
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
