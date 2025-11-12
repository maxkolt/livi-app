// backend/sockets/avatar.ts
import { Server, Socket } from 'socket.io';
import User from '../models/User';
import { buildAvatarDataUris } from '../utils/avatars';

export function bindAvatarSockets(io: Server, socket: Socket) {
  // Загрузка аватара
  socket.on('user.uploadAvatar', async ({ base64 }: { base64: string }, cb?: Function) => {
    const userId = (socket as any).data?.userId as string | undefined;

    if (!userId) {
      console.warn('[avatar] uploadAvatar: unauthorized, socket.data:', (socket as any).data);
      return cb?.({ ok: false, error: 'unauthorized' });
    }

    try {
      const { fullB64, thumbB64 } = await buildAvatarDataUris(base64);

      const updated = await User.findByIdAndUpdate(
        userId,
        { 
          $set: { 
            avatarB64: fullB64, 
            avatarThumbB64: thumbB64 
          }, 
          $inc: { avatarVer: 1 } 
        },
        { new: true, select: '_id avatarVer avatarThumbB64 avatarB64 friends' }
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

      const friends = Array.isArray(updated.friends) ? updated.friends : [];
      friends.forEach((fid: any) => {
        try {
          io.to(`u:${String(fid)}`).emit('user.avatarUpdated', payload);
        } catch (e) {
          console.warn(`[avatar] failed to notify friend ${fid}:`, e);
        }
      });

      cb?.({ ok: true, avatarVer: updated.avatarVer || 0 });
    } catch (e: any) {
      console.error('[avatar] upload error:', e?.message || e);
      cb?.({ ok: false, error: String(e?.message || e) });
    }
  });

  // Удалить аватар
  socket.on('user.deleteAvatar', async (_: any, cb?: Function) => {
    const userId = (socket as any).data?.userId as string | undefined;

    if (!userId) {
      console.warn('[avatar] deleteAvatar: unauthorized, socket.data:', (socket as any).data);
      return cb?.({ ok: false, error: 'unauthorized' });
    }

    try {
      const updated = await User.findByIdAndUpdate(
        userId,
        { 
          $set: { 
            avatarB64: '', 
            avatarThumbB64: '' 
          }, 
          $inc: { avatarVer: 1 } 
        },
        { new: true, select: '_id avatarVer friends' }
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

      const friends = Array.isArray(updated.friends) ? updated.friends : [];
      friends.forEach((fid: any) => {
        try {
          io.to(`u:${String(fid)}`).emit('user.avatarUpdated', payload);
        } catch (e) {
          console.warn(`[avatar] failed to notify friend ${fid}:`, e);
        }
      });

      cb?.({ ok: true });
    } catch (e: any) {
      console.error('[avatar] delete error:', e?.message || e);
      cb?.({ ok: false, error: String(e?.message || e) });
    }
  });

  // Получить полный аватар друга (на экране профиля/клика)
  socket.on('user.getAvatar', async ({ userId: otherId }: { userId: string }, cb?: Function) => {
    const requesterId = (socket as any).data?.userId as string | undefined;
    
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
    } catch (e: any) {
      console.error('[avatar] get error:', e?.message || e);
      cb?.({ ok: false, error: String(e?.message || e) });
    }
  });
}

