// backend/sockets/friends.ts
import { Server } from 'socket.io';
import type { AuthedSocket } from './types';
import mongoose from 'mongoose';
import User from '../models/User';
import {
  areFriendsCached,
  clearFriendshipCache,
  ensureFriendshipEdges,
  getFriendsPaginated,
  type FriendListProfile,
  removeFriendshipEdges,
} from '../utils/friendshipUtils';
import { logger } from '../utils/logger';
import { getEffectiveBusy } from '../utils/effectiveBusy';
import { isFriendGloballyVisibleOnline } from '../utils/friendOnlinePresence';
import { emitToUser } from '../utils/emitToUser';
import { listIncomingFriendRequests } from '../utils/friendRequests';

type FriendAck<T extends object = object> = (result: ({ ok: true } & T) | { ok: false; error: string }) => void;
type FriendsPayload = {
  list: Array<Omit<FriendListProfile, '_id'> & { _id: string; online: boolean; isBusy: boolean }>;
  pagination: { page: number; limit: number; total: number; hasMore: boolean };
};
type FriendStatus = { status: 'already' | 'pending' | 'accepted' | 'declined' };

const isOid = (s?: string) => !!s && mongoose.Types.ObjectId.isValid(String(s));

export default function registerFriendSockets(io: Server) {
  /** Онлайн для списка друзей — та же семантика, что у глобального presence_update. */
  const isOnline = (uid: string) => isFriendGloballyVisibleOnline(io, uid);

  io.on('connection', (sock: AuthedSocket) => {
    const meId = () => String((sock).data?.userId || '');

    /** ===== Список друзей ===== */
    sock.on('friends:fetch', async (params: { page?: number; limit?: number; includeAvatarThumbs?: boolean } = {}, ack?: FriendAck<FriendsPayload>) => {
      const { page = 1, limit = 50 } = params || {};
      const includeAvatarThumbs = params?.includeAvatarThumbs !== false;
      try {
        const me = meId();
        if (!isOid(me)) {
          logger.warn('Unauthorized friends fetch', { userId: me });
          return ack?.({ ok: false, error: 'unauthorized' });
        }

        // Используем оптимизированную функцию с пагинацией
        const result = await getFriendsPaginated(me, page, limit);
        logger.debug('Friends fetched', { userId: me, friendsCount: result.friends.length, total: result.total });

        // Добавляем информацию об онлайн статусе и занятости (callee до принятия не показывается занятым)
        const list = result.friends.map((friend) => {
          const friendId = String(friend._id);
          const isFriendBusy = getEffectiveBusy(io, friendId);
          
          return {
            _id: friendId,
            nick: friend.nick || '',
            avatar: (friend).avatar || '',
            avatarVer: (friend).avatarVer || 0,
            ...(includeAvatarThumbs ? { avatarThumbB64: (friend).avatarThumbB64 || '' } : {}),
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
      } catch (e) {
        logger.error('Friends fetch error:', e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });

    /** ===== Входящие заявки (страница «Заявки» в приложении) ===== */
    sock.on('friends:requests', async (params: { includeAvatarThumbs?: boolean } = {}, ack?: FriendAck<{ list: Awaited<ReturnType<typeof listIncomingFriendRequests>> }>) => {
      try {
        const me = meId();
        if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
        const list = await listIncomingFriendRequests(me, {
          includeAvatarThumbs: params?.includeAvatarThumbs !== false,
          isOnline,
        });
        return ack?.({ ok: true, list });
      } catch (e) {
        logger.error('Friend requests fetch error:', e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });

    /** ===== Добавление в друзья (теперь через заявку) ===== */
    sock.on('friends:add', async ({ to }: { to: string }, ack?: FriendAck<FriendStatus>) => {
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
        const alreadyPending = Array.isArray((toUserDoc)?.friendRequests)
          && (toUserDoc).friendRequests.some((x) => String(x) === String(me));
        if (alreadyPending) return ack?.({ ok: true, status: 'pending' });

        // Кладем заявку к получателю
        await (User).updateOne(
          { _id: to },
          { $addToSet: { friendRequests: me } }
        );

        // Шлем событие получателю
        let fromNick: string | undefined;
        try {
          const u = await User.findById(me).select('nick').lean();
          const n = String((u)?.nick ?? '').trim();
          fromNick = n || undefined;
        } catch {}
        emitToUser(io, to, 'friend:request', { from: me, fromNick });

        return ack?.({ ok: true, status: 'pending' });
      } catch (e) {
        logger.error('Friends add error:', e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });
    /** ===== Принятие invite link (сразу добавляет в друзья) ===== */
    sock.on('friends:acceptInvite', async ({ inviterId }: { inviterId: string }, ack?: FriendAck<FriendStatus>) => {
      try {
        const me = meId();
        if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
        if (!isOid(inviterId)) return ack?.({ ok: false, error: 'invalid_inviter' });
        if (String(me) === String(inviterId)) return ack?.({ ok: false, error: 'self' });

        // Проверяем, уже ли друзья
        const alreadyFriends = await areFriendsCached(me, inviterId);
        if (alreadyFriends) return ack?.({ ok: true, status: 'already' });

        // Сразу добавляем дружбу в отдельную коллекцию связей (без заявки)
        await ensureFriendshipEdges(me, inviterId);
        clearFriendshipCache(me);
        clearFriendshipCache(inviterId);

        // Удаляем заявку, если она была
        await (User).updateOne({ _id: me }, { $pull: { friendRequests: inviterId } });
        await (User).updateOne({ _id: inviterId }, { $pull: { friendRequests: me } });

        // Отправляем актуальную информацию о профиле друг другу
        try {
          const meProfile = await User.findById(me).select('nick avatar avatarVer avatarThumbB64').lean();
          if (meProfile) {
            const mePayload = {
              userId: me,
              nick: String((meProfile).nick || '').trim(),
              avatar: String((meProfile).avatar || ''),
              avatarVer: (meProfile).avatarVer || 0,
              avatarThumbB64: String((meProfile).avatarThumbB64 || ''),
            };
            emitToUser(io, inviterId, 'friend:profile', mePayload);
          }

          const inviterProfile = await User.findById(inviterId).select('nick avatar avatarVer avatarThumbB64').lean();
          if (inviterProfile) {
            const inviterPayload = {
              userId: inviterId,
              nick: String((inviterProfile).nick || '').trim(),
              avatar: String((inviterProfile).avatar || ''),
              avatarVer: (inviterProfile).avatarVer || 0,
              avatarThumbB64: String((inviterProfile).avatarThumbB64 || ''),
            };
            emitToUser(io, me, 'friend:profile', inviterPayload);
          }
        } catch (profileError) {
          logger.warn('Failed to send profile on invite accept:', profileError);
        }

        // Уведомления
        emitToUser(io, me, 'friend:accepted', { userId: inviterId });
        emitToUser(io, inviterId, 'friend:accepted', { userId: me });

        return ack?.({ ok: true, status: 'accepted' });
      } catch (e) {
        logger.error('Friends accept invite error:', e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });

    /** ===== Ответ на заявку ===== */
    sock.on('friends:respond', async ({ from, accept, requestId }: { from: string; accept: boolean; requestId?: string }, ack?: FriendAck<FriendStatus>) => {
      try {
        const me = meId();
        if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
        if (!isOid(from)) return ack?.({ ok: false, error: 'invalid_from' });

        // Удаляем заявку из списка входящих
        await (User).updateOne({ _id: me }, { $pull: { friendRequests: from } });

        if (accept) {
          // Добавляем дружбу в отдельную коллекцию связей
          await ensureFriendshipEdges(me, from);
          clearFriendshipCache(me); clearFriendshipCache(from);

          // Отправляем актуальную информацию о профиле друг другу
          try {
            // Получаем профиль "me" для отправки "from"
            const meProfile = await User.findById(me).select('nick avatar avatarVer avatarThumbB64').lean();
            if (meProfile) {
              const mePayload = {
                userId: me,
                nick: String((meProfile).nick || '').trim(),
                avatar: String((meProfile).avatar || ''),
                avatarVer: (meProfile).avatarVer || 0,
                avatarThumbB64: String((meProfile).avatarThumbB64 || ''),
              };
              // Отправляем профиль "me" пользователю "from"
              emitToUser(io, from, 'friend:profile', mePayload);
            }

            // Получаем профиль "from" для отправки "me"
            const fromProfile = await User.findById(from).select('nick avatar avatarVer avatarThumbB64').lean();
            if (fromProfile) {
              const fromPayload = {
                userId: from,
                nick: String((fromProfile).nick || '').trim(),
                avatar: String((fromProfile).avatar || ''),
                avatarVer: (fromProfile).avatarVer || 0,
                avatarThumbB64: String((fromProfile).avatarThumbB64 || ''),
              };
              // Отправляем профиль "from" пользователю "me"
              emitToUser(io, me, 'friend:profile', fromPayload);
            }
          } catch (profileError) {
            logger.warn('Failed to send profile on friend accept:', profileError);
            // Не прерываем процесс, если не удалось отправить профиль
          }
        }

        // Уведомления
        emitToUser(io, me, accept ? 'friend:accepted' : 'friend:declined', { userId: from });
        emitToUser(io, from, accept ? 'friend:accepted' : 'friend:declined', { userId: me });

        return ack?.({ ok: true, status: accept ? 'accepted' : 'declined' });
      } catch (e) {
        logger.error('Friends respond error:', e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });

    /** ===== Удаление друга ===== */
    sock.on('friends:remove', async ({ peerId }: { peerId: string }, ack?: FriendAck) => {
      try {
        const me = meId();
        if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
        if (!isOid(peerId)) return ack?.({ ok: false, error: 'invalid_peer' });
        if (String(me) === String(peerId)) return ack?.({ ok: false, error: 'self' });

        // Удаляем дружбу в отдельной коллекции и чистим legacy-массивы.
        await removeFriendshipEdges(me, peerId);
        await (User).updateOne(
          { _id: me },
          { $pull: { friends: peerId } }
        );
        await (User).updateOne(
          { _id: peerId },
          { $pull: { friends: me } }
        );

        // Очищаем кэш дружбы
        clearFriendshipCache(me);
        clearFriendshipCache(peerId);

        // Уведомляем обе стороны
        emitToUser(io, me, 'friend_removed', { userId: String(peerId) });
        emitToUser(io, peerId, 'friend_removed', { userId: String(me) });

        return ack?.({ ok: true });
      } catch (e) {
        logger.error('Friends remove error:', e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });

    /** ===== Проверка дружбы ===== */
    sock.on('friends:check', async ({ userId }: { userId: string }, ack?: FriendAck<{ areFriends: boolean }>) => {
      try {
        const me = meId();
        if (!isOid(me)) return ack?.({ ok: false, error: 'unauthorized' });
        if (!isOid(userId)) return ack?.({ ok: false, error: 'invalid_user' });

        const areFriendsResult = await areFriendsCached(me, userId);
        return ack?.({ ok: true, areFriends: areFriendsResult });
      } catch (e) {
        logger.error('Friends check error:', e);
        return ack?.({ ok: false, error: 'server_error' });
      }
    });
  });
}
