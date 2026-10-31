// backend/sockets/avatar.ts
import { Server, Socket } from 'socket.io';
import User from '../models/User';
import { buildAvatarDataUris } from '../utils/avatars';
import { getFriendIds } from '../utils/friendshipUtils';

type AvatarAck<T extends object = object> = (result: ({ ok: true } & T) | { ok: false; error: string }) => void;

export function bindAvatarSockets(io: Server, socket: Socket) {
  // Загрузка аватара
  socket.on('user.uploadAvatar', async ({ base64 }: { base64: string }, cb?: AvatarAck<{ avatarVer: number }>) => {
    const userId = (socket).data?.userId as string | undefined;

    if (!userId) {
      console.warn('[avatar] uploadAvatar: unauthorized, socket.data:', (socket).data);
      return cb?.({ ok: false, error: 'unauthorized' });
    }

    try {
      const raw = String(base64 || '').trim();
      if (!raw) {
        return cb?.({ ok: false, error: 'empty_image' });
      }
      const { fullB64, thumbB64 } = await buildAvatarDataUris(base64);
      if (!fullB64 || !thumbB64) {
        return cb?.({ ok: false, error: 'empty_image' });
      }

      const updated = await User.findByIdAndUpdate(
        userId,
        { 
          $set: { 
            // Marker used by profile:update to avoid wiping base64 avatars on avatar === ''
            avatar: 'data:image',
            avatarB64: fullB64, 
            avatarThumbB64: thumbB64 
          }, 
          $inc: { avatarVer: 1 } 
        },
        { new: true, select: '_id avatarVer avatarThumbB64 avatarB64' }
      ).lean();

      if (!updated) {
        return cb?.({ ok: false, error: 'user_not_found' });
      }

      // Себе — полный аватар и версия
      socket.emit('user.avatar', {
        userId,
        avatarVer: updated.avatarVer || 0,
        avatarB64: updated.avatarB64 || '',
      });

      // Друзьям — только мини и версия (для списка)
      const payload = {
        userId,
        avatarVer: updated.avatarVer || 0,
        avatarThumbB64: updated.avatarThumbB64 || '',
      };

      const friends = await getFriendIds(userId);
      friends.forEach((fid) => {
        try {
          io.to(`u:${String(fid)}`).emit('user.avatarUpdated', payload);
        } catch (e) {
          console.warn(`[avatar] failed to notify friend ${fid}:`, e);
        }
      });

      cb?.({ ok: true, avatarVer: updated.avatarVer || 0 });
    } catch (e) {
      console.error('[avatar] upload error:', (e as { message?: unknown } | null)?.message || e);
      cb?.({ ok: false, error: String((e as { message?: unknown } | null)?.message || e) });
    }
  });

  // Удалить аватар
  socket.on('user.deleteAvatar', async (_: unknown, cb?: AvatarAck) => {
    const userId = (socket).data?.userId as string | undefined;

    if (!userId) {
      console.warn('[avatar] deleteAvatar: unauthorized, socket.data:', (socket).data);
      return cb?.({ ok: false, error: 'unauthorized' });
    }

    try {
      const updated = await User.findByIdAndUpdate(
        userId,
        { 
          $set: { 
            avatar: '',
            avatarB64: '', 
            avatarThumbB64: '' 
          }, 
          $inc: { avatarVer: 1 } 
        },
        { new: true, select: '_id avatarVer' }
      ).lean();

      if (!updated) {
        return cb?.({ ok: false, error: 'user_not_found' });
      }

      // Себе — пустой аватар
      socket.emit('user.avatar', { 
        userId, 
        avatarVer: updated.avatarVer || 0, 
        avatarB64: '' 
      });

      // Друзьям — пустая миниатюра
      const payload = { 
        userId, 
        avatarVer: updated.avatarVer || 0, 
        avatarThumbB64: '' 
      };

      const friends = await getFriendIds(userId);
      friends.forEach((fid) => {
        try {
          io.to(`u:${String(fid)}`).emit('user.avatarUpdated', payload);
        } catch (e) {
          console.warn(`[avatar] failed to notify friend ${fid}:`, e);
        }
      });

      cb?.({ ok: true });
    } catch (e) {
      console.error('[avatar] delete error:', (e as { message?: unknown } | null)?.message || e);
      cb?.({ ok: false, error: String((e as { message?: unknown } | null)?.message || e) });
    }
  });

  // Получить полный аватар друга (на экране профиля/клика)
  socket.on('user.getAvatar', async ({ userId: otherId }: { userId: string }, cb?: AvatarAck<{ userId: string; avatarVer: number; avatarB64: string }>) => {
    
    try {
      if (!otherId) {
        return cb?.({ ok: false, error: 'no_userId' });
      }

      const doc = await User.findById(otherId)
        .select('_id avatarVer avatarB64')
        .lean();

      if (!doc) {
        return cb?.({ ok: false, error: 'not_found' });
      }

      cb?.({ 
        ok: true, 
        userId: String(doc._id), 
        avatarVer: doc.avatarVer || 0, 
        avatarB64: doc.avatarB64 || '' 
      });
    } catch (e) {
      console.error('[avatar] get error:', (e as { message?: unknown } | null)?.message || e);
      cb?.({ ok: false, error: String((e as { message?: unknown } | null)?.message || e) });
    }
  });
}

