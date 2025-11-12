// backend/sockets/friends.ts
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import User from '../models/User';
import { areFriendsCached, getFriendsPaginated, clearFriendshipCache } from '../utils/friendshipUtils';
import { logger } from '../utils/logger';

const isOid = (s?: string) => !!s && mongoose.Types.ObjectId.isValid(String(s));

/** Наружу отдаем только https/https URL (защита от старых file://, content:// и т.п.) */
const normalizeAvatar = (s?: string) => {
  const url = String(s || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
};

export default function registerFriendSockets(io: Server) {
  /** Проверка онлайн-статуса по всем подключенным сокетам */
  const isOnline = (uid: string) => {
    for (const s of io.sockets.sockets.values()) {
      if (String((s as any).data?.userId) === String(uid)) return true;
    }
    return false;
  };

  io.on('connection', (sock) => {
    const meId = () => String((sock as any).data?.userId || '');

    /** ===== Список друзей ===== */
    sock.on('friends:fetch', async (params: any = {}, ack?: Function) => {
      const { page = 1, limit = 50 } = params || {};
      try {
        const me = meId();
        if (!isOid(me)) {
          logger.warn('Unauthorized friends fetch', { userId: me });
          return ack?.({ ok: false, error: 'unauthorized' });
        }

        // Используем оптимизированную функцию с пагинацией
        const result = await getFriendsPaginated(me, page, limit);
        logger.debug('Friends fetched', { userId: me, friendsCount: result.friends.length, total: result.total });

        // Добавляем информацию об онлайн статусе и занятости
        const list = result.friends.map((friend) => {
          const friendId = String(friend._id);
          // Проверяем занятость через socket.data.busy
          let isFriendBusy = false;
          for (const s of io.sockets.sockets.values()) {
            if (String((s as any).data?.userId) === friendId) {
              isFriendBusy = (s as any).data?.busy || false;
              break;
            }
          }
          
          return {
            _id: friendId,
            nick: friend.nick || '',
            avatar: (friend as any).avatar || '',
            avatarVer: (friend as any).avatarVer || 0,
            avatarThumbB64: (friend as any).avatarThumbB64 || '', // мини сразу в список
            online: isOnline(friendId),
            isBusy: isFriendBusy,
          };
        });

        return ack?.({ 
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
        logger.error('Friends fetch error:', e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });

    /** ===== Добавление в друзья (теперь через заявку) ===== */
    sock.on('friends:add', async ({ to }: { to: string }, ack?: Function) => {
      try {
        const me = meId();
        if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
        if (!isOid(to)) return ack?.({ ok: false, error: 'invalid_to' });
        if (String(me) === String(to)) return ack?.({ ok: false, error: 'self' });

        // Проверяем, уже ли друзья
        const alreadyFriends = await areFriendsCached(me, to);
        if (alreadyFriends) return ack?.({ ok: true, status: 'already' });

        // Проверяем, не отправляли ли уже заявку ранее
        const toUserDoc = await User.findById(to).select('friendRequests').lean();
        const alreadyPending = Array.isArray((toUserDoc as any)?.friendRequests)
          && (toUserDoc as any).friendRequests.some((x: any) => String(x) === String(me));
        if (alreadyPending) return ack?.({ ok: true, status: 'pending' });

        // Кладем заявку к получателю
        await (User as any).updateOne(
          { _id: to },
          { $addToSet: { friendRequests: me } }
        );

        // Шлем событие получателю
        let fromNick: string | undefined;
        try { const u = await User.findById(me).select('nick').lean(); fromNick = (u as any)?.nick || undefined; } catch {}
        for (const s of io.sockets.sockets.values()) {
          const uid = String((s as any).data?.userId || '');
          if (uid === String(to)) {
            (s as any).emit('friend:request', { from: me, fromNick });
          }
        }

        return ack?.({ ok: true, status: 'pending' });
      } catch (e: any) {
        logger.error('Friends add error:', e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });
    /** ===== Ответ на заявку ===== */
    sock.on('friends:respond', async ({ from, accept, requestId }: { from: string; accept: boolean; requestId?: string }, ack?: Function) => {
      try {
        const me = meId();
        if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
        if (!isOid(from)) return ack?.({ ok: false, error: 'invalid_from' });

        // Удаляем заявку из списка входящих
        await (User as any).updateOne({ _id: me }, { $pull: { friendRequests: from } });

        if (accept) {
          // Добавляем дружбу в обе стороны
          await (User as any).updateOne({ _id: me },  { $addToSet: { friends: from } });
          await (User as any).updateOne({ _id: from }, { $addToSet: { friends: me } });
          clearFriendshipCache(me); clearFriendshipCache(from);
        }

        // Уведомления
        for (const s of io.sockets.sockets.values()) {
          const uid = String((s as any).data?.userId || '');
          if (uid === String(me)) {
            (s as any).emit(accept ? 'friend:accepted' : 'friend:declined', { userId: from });
          }
          if (uid === String(from)) {
            (s as any).emit(accept ? 'friend:accepted' : 'friend:declined', { userId: me });
          }
        }

        return ack?.({ ok: true, status: accept ? 'accepted' : 'declined' });
      } catch (e: any) {
        logger.error('Friends respond error:', e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });

    /** ===== Удаление друга ===== */
    sock.on('friends:remove', async ({ peerId }: { peerId: string }, ack?: Function) => {
      try {
        const me = meId();
        if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
        if (!isOid(peerId)) return ack?.({ ok: false, error: 'invalid_peer' });
        if (String(me) === String(peerId)) return ack?.({ ok: false, error: 'self' });

        // Удаляем дружбу в обе стороны
        await (User as any).updateOne(
          { _id: me },
          { $pull: { friends: peerId } }
        );
        await (User as any).updateOne(
          { _id: peerId },
          { $pull: { friends: me } }
        );

        // Очищаем кэш дружбы
        clearFriendshipCache(me);
        clearFriendshipCache(peerId);

        // Уведомляем обе стороны
        for (const s of io.sockets.sockets.values()) {
          const uid = String((s as any).data?.userId || '');
          if (uid === String(me)) (s as any).emit('friend_removed', { userId: String(peerId) });
          if (uid === String(peerId)) (s as any).emit('friend_removed', { userId: String(me) });
        }

        return ack?.({ ok: true });
      } catch (e: any) {
        logger.error('Friends remove error:', e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });

    /** ===== Проверка дружбы ===== */
    sock.on('friends:check', async ({ userId }: { userId: string }, ack?: Function) => {
      try {
        const me = meId();
        if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
        if (!isOid(userId)) return ack?.({ ok: false, error: 'invalid_user' });

        const areFriendsResult = await areFriendsCached(me, userId);
        return ack?.({ ok: true, areFriends: areFriendsResult });
      } catch (e: any) {
        logger.error('Friends check error:', e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });
  });
}
