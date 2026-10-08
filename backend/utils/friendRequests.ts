// backend/utils/friendRequests.ts
import mongoose from 'mongoose';
import User from '../models/User';
import { areFriendsCached } from './friendshipUtils';

/**
 * Входящие заявки в друзья — для страницы «Заявки» в приложении.
 *
 * Источник один — User.friendRequests: туда попадает заявка из случайного чата
 * (friends:add) и пригласивший, когда открыта его ссылка (markInviteFriendRequest).
 * Заявка лежит, пока её не приняли или не отклонили, — обрыв связи, выход из
 * приложения или закрытое окно её не теряют.
 */

const isOid = (s?: string) => !!s && mongoose.Types.ObjectId.isValid(String(s));

export type IncomingFriendRequest = {
  _id: string;
  nick: string;
  avatar: string;
  avatarVer: number;
  avatarThumbB64?: string;
  online: boolean;
};

/**
 * Новые сверху. Заявки от тех, кто уже в друзьях или удалил аккаунт, отбрасываются
 * и заодно вычищаются из friendRequests.
 */
export async function listIncomingFriendRequests(
  me: string,
  opts: { includeAvatarThumbs: boolean; isOnline: (uid: string) => boolean },
): Promise<IncomingFriendRequest[]> {
  const meDoc = await User.findById(me).select('friendRequests').lean();
  const raw: unknown[] = Array.isArray((meDoc as any)?.friendRequests) ? (meDoc as any).friendRequests : [];
  const ids = Array.from(new Set(raw.map((x) => String(x)).filter((id) => isOid(id) && id !== String(me))));
  if (ids.length === 0) return [];

  const users = await User.find({ _id: { $in: ids } })
    .select('nick avatar avatarVer avatarThumbB64')
    .lean();
  const byId = new Map(users.map((u: any) => [String(u._id), u]));
  const friendFlags = await Promise.all(ids.map((id) => areFriendsCached(me, id).catch(() => false)));

  const stale: string[] = [];
  const list: IncomingFriendRequest[] = [];
  // $addToSet дописывает в конец — последние заявки в конце массива.
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    const user = byId.get(id) as any;
    if (!user || friendFlags[i]) {
      stale.push(id);
      continue;
    }
    list.push({
      _id: id,
      nick: String(user.nick ?? '').trim(),
      avatar: /^https?:\/\//i.test(String(user.avatar || '')) ? String(user.avatar) : '',
      avatarVer: Number(user.avatarVer || 0),
      ...(opts.includeAvatarThumbs ? { avatarThumbB64: String(user.avatarThumbB64 || '') } : {}),
      online: opts.isOnline(id),
    });
  }

  if (stale.length > 0) {
    await (User as any).updateOne({ _id: me }, { $pull: { friendRequests: { $in: stale } } });
  }
  return list;
}

/**
 * Открыта ссылка-приглашение: пригласивший ждёт ответа так же, как заявка из
 * случайного чата. Не друзья и не сам себе — иначе ничего не делаем.
 */
export async function markInviteFriendRequest(me: string, inviterId: string): Promise<void> {
  if (!isOid(me) || !isOid(inviterId) || String(me) === String(inviterId)) return;
  if (await areFriendsCached(me, inviterId)) return;
  await (User as any).updateOne({ _id: me }, { $addToSet: { friendRequests: inviterId } });
}
