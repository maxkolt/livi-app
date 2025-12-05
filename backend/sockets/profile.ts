// backend/sockets/profile.ts
import { Server, Socket } from 'socket.io';
import User from '../models/User';

type Ack = (resp: { ok: boolean; error?: string; profile?: { nick?: string; avatarUrl?: string; avatarVer?: number; avatarB64?: string; avatarThumbB64?: string } }) => void;

const isHttps = (s?: string) => !!s && /^https:\/\//i.test(String(s).trim());

export function registerProfileSockets(io: Server, socket: Socket) {
  // GET my profile
  socket.on('profile:me', async (_: any, ack?: Ack) => {
    try {
      const userId = socket.data.userId as string | undefined;
      if (!userId) return ack?.({ ok: true, profile: {} }); // гость
      const u = await User.findById(userId).select('nick avatar avatarVer avatarB64 avatarThumbB64').lean();
      ack?.({ ok: true, profile: u ? { 
        nick: u.nick, 
        avatarUrl: u.avatar,
        avatarVer: (u as any).avatarVer || 0,
        avatarB64: (u as any).avatarB64 || '',
        avatarThumbB64: (u as any).avatarThumbB64 || ''
      } as { nick?: string; avatarUrl?: string; avatarVer?: number; avatarB64?: string; avatarThumbB64?: string } : undefined });
    } catch (e: any) {
      ack?.({ ok: true, profile: undefined }); // НЕ возвращаем ошибку, возвращаем undefined для профиля
    }
  });

  // UPDATE profile (nick, avatar)
  socket.on('profile:update', async (patch: { nick?: string; avatar?: string }, ack?: Ack) => {
    try {
      const userId = socket.data.userId as string | undefined;

      if (!userId) {
        console.error('[profile:update] ❌ Unauthorized - no userId in socket.data');
        return ack?.({ ok: false, error: 'Unauthorized' });
      }

      const update: Record<string, any> = {};
      if (typeof patch?.nick === 'string') {
        update.nick = patch.nick.trim().slice(0, 64);
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'avatar')) {
        const raw = (patch?.avatar ?? '').toString().trim();
        if (raw === '') {
          update.avatar = '';
        } else if (isHttps(raw)) {
          update.avatar = raw;
        } else {
          console.error('[profile:update] ❌ Invalid avatar URL (must be HTTPS):', raw);
          return ack?.({ ok: false, error: 'avatar must be HTTPS' });
        }
      }

      if (!Object.keys(update).length) {
        console.warn('[profile:update] ⚠️ No valid fields to update');
        return ack?.({ ok: false, error: 'No valid fields' });
      }

      const user = await User.findByIdAndUpdate(userId, { $set: update }, { new: true })
        .select('nick avatar')
        .lean();

      if (!user) {
        console.error('[profile:update] ❌ User not found:', userId);
        return ack?.({ ok: false, error: 'User not found' });
      }

      // сообщаем клиенту(ам) про обновление (по желанию можно эмитить в комнату пользователя)
      socket.emit('profile:updated', user);

      return ack?.({ ok: true, profile: { nick: user.nick, avatarUrl: user.avatar } });
    } catch (e: any) {
      console.error('[profile:update] ❌ Error:', e?.message || e);
      return ack?.({ ok: false, error: e?.message || 'Server error' });
    }
  });
}

