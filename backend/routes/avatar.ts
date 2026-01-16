import { Router } from 'express';
import mongoose from 'mongoose';
import User from '../models/User';
import Install from '../models/Install';
import { buildAvatarDataUris } from '../utils/avatars';

const router = Router();

const isOid = (s?: string) => !!s && /^[a-f\d]{24}$/i.test(String(s || '').trim());

async function resolveAuthedUserId(req: any): Promise<{ userId?: string; error?: string }> {
  const headerUserId = String(req.header('x-user-id') || '').trim();
  const installId = String(req.header('x-install-id') || '').trim();

  // Prefer installId when present (prevents spoofing x-user-id).
  if (installId) {
    if (mongoose.connection.readyState !== 1) {
      return { error: 'database_unavailable' };
    }
    const inst = await Install.findOne({ installId }).select('user').lean();
    const fromInstall = inst?.user ? String((inst as any).user) : '';
    if (!isOid(fromInstall)) return { error: 'unauthorized' };
    if (headerUserId && isOid(headerUserId) && headerUserId !== fromInstall) {
      return { error: 'unauthorized' };
    }
    return { userId: fromInstall };
  }

  if (isOid(headerUserId)) return { userId: headerUserId };

  const fallback = String(req.userId || '').trim();
  if (isOid(fallback)) return { userId: fallback };
  return { error: 'unauthorized' };
}

function parseDataUriToBuffer(dataUriOrB64: string): { buf: Buffer; mime: string } | null {
  const raw = String(dataUriOrB64 || '').trim();
  if (!raw) return null;
  const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (m) {
    return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
  }
  // fallback: assume base64 jpeg
  return { mime: 'image/jpeg', buf: Buffer.from(raw, 'base64') };
}

// POST /api/upload/avatar/dataUri
router.post('/upload/avatar/dataUri', async (req, res) => {
  try {
    const { userId, error } = await resolveAuthedUserId(req);
    if (!userId) return res.status(error === 'database_unavailable' ? 503 : 401).json({ ok: false, error: error || 'unauthorized' });

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false, error: 'database_unavailable' });
    }

    const dataUri = String(req.body?.dataUri || '').trim();
    if (!dataUri) return res.status(400).json({ ok: false, error: 'missing_dataUri' });

    const { fullB64, thumbB64 } = await buildAvatarDataUris(dataUri);
    if (!fullB64 || !thumbB64) return res.status(400).json({ ok: false, error: 'empty_image' });

    const updated = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          // Marker to prevent profile:update from "deleting" base64 avatars when avatar === ''
          avatar: 'data:image',
          avatarB64: fullB64,
          avatarThumbB64: thumbB64,
        },
        $inc: { avatarVer: 1 },
      },
      { new: true, select: '_id nick avatarVer avatarB64 avatarThumbB64 friends' }
    ).lean();

    if (!updated) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const io = (req as any).io as any | undefined;
    const payloadMe = { userId: String(updated._id), avatarVer: updated.avatarVer || 0, avatarB64: updated.avatarB64 || '' };
    const payloadFriends = { userId: String(updated._id), avatarVer: updated.avatarVer || 0, avatarThumbB64: updated.avatarThumbB64 || '' };
    const payloadFriendProfile = {
      userId: String(updated._id),
      nick: String((updated as any).nick || '').trim(),
      avatar: (updated as any).avatar || 'data:image',
      avatarVer: updated.avatarVer || 0,
      avatarThumbB64: updated.avatarThumbB64 || '',
    };

    try {
      if (io) {
        io.to(`u:${String(updated._id)}`).emit('user.avatar', payloadMe);
        const friends = Array.isArray(updated.friends) ? updated.friends : [];
        friends.forEach((fid: any) => {
          io.to(`u:${String(fid)}`).emit('user.avatarUpdated', payloadFriends);
          io.to(`u:${String(fid)}`).emit('friend:profile', payloadFriendProfile);
        });
      }
    } catch {}

    return res.json({ ok: true, avatar: (updated as any).avatar || 'data:image', avatarVer: updated.avatarVer || 0 });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/avatar/:userId?thumb=1
router.get('/avatar/:userId', async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!isOid(userId)) return res.status(400).end();
    if (mongoose.connection.readyState !== 1) return res.status(503).end();

    const thumb = String(req.query.thumb || '') === '1';
    const doc = await User.findById(userId).select('_id avatarVer avatarB64 avatarThumbB64').lean();
    if (!doc) return res.status(404).end();

    const ver = (doc as any).avatarVer || 0;
    const data = thumb ? (doc as any).avatarThumbB64 : (doc as any).avatarB64;
    if (!data) return res.status(404).end();

    const parsed = parseDataUriToBuffer(String(data));
    if (!parsed || !parsed.buf?.length) return res.status(404).end();

    const etag = `"avatar-${userId}-${ver}-${thumb ? 't' : 'f'}"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', parsed.mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);
    return res.status(200).send(parsed.buf);
  } catch {
    return res.status(500).end();
  }
});

// DELETE /api/avatar/:userId
router.delete('/avatar/:userId', async (req, res) => {
  try {
    const targetId = String(req.params.userId || '').trim();
    if (!isOid(targetId)) return res.status(400).json({ ok: false, error: 'invalid_userId' });

    const { userId, error } = await resolveAuthedUserId(req);
    if (!userId) return res.status(error === 'database_unavailable' ? 503 : 401).json({ ok: false, error: error || 'unauthorized' });
    if (userId !== targetId) return res.status(403).json({ ok: false, error: 'forbidden' });

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false, error: 'database_unavailable' });
    }

    const updated = await User.findByIdAndUpdate(
      userId,
      {
        $set: { avatar: '', avatarB64: '', avatarThumbB64: '' },
        $inc: { avatarVer: 1 },
      },
      { new: true, select: '_id nick avatarVer friends' }
    ).lean();

    if (!updated) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const io = (req as any).io as any | undefined;
    const payloadMe = { userId: String(updated._id), avatarVer: updated.avatarVer || 0, avatarB64: '' };
    const payloadFriends = { userId: String(updated._id), avatarVer: updated.avatarVer || 0, avatarThumbB64: '' };
    const payloadFriendProfile = {
      userId: String(updated._id),
      nick: String((updated as any).nick || '').trim(),
      avatar: '',
      avatarVer: updated.avatarVer || 0,
      avatarThumbB64: '',
    };

    try {
      if (io) {
        io.to(`u:${String(updated._id)}`).emit('user.avatar', payloadMe);
        const friends = Array.isArray(updated.friends) ? updated.friends : [];
        friends.forEach((fid: any) => {
          io.to(`u:${String(fid)}`).emit('user.avatarUpdated', payloadFriends);
          io.to(`u:${String(fid)}`).emit('friend:profile', payloadFriendProfile);
        });
      }
    } catch {}

    return res.json({ ok: true, avatar: '', avatarVer: updated.avatarVer || 0 });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;

