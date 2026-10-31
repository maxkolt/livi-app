import type { ErrorDetails } from '../utils/runtimeTypes';
import { Router } from 'express';
import mongoose from 'mongoose';
import User from '../models/User';

const isOid = (s?: string) => !!s && mongoose.Types.ObjectId.isValid(String(s));

// Stream Chat убран - больше не используется

export default function createChatRouter() {
  const router = Router();

  // GET /chat/token?userId=...
  router.get('/token', async (req, res) => {
    try {
      const userId = String(req.query.userId || '');
      if (!isOid(userId)) {
        return res.status(400).json({ ok: false, error: 'bad_userId' });
      }

      // Stream Chat токен убран - больше не используется
      return res.json({ ok: true, token: 'stream_disabled' });
    } catch (e: unknown) {
      console.error('[chat/token] error:', e);
      return res.status(500).json({ ok: false, error: 'token_failed' });
    }
  });

  // POST /chat/ensure-dm { meId, peerId }
  router.post('/ensure-dm', async (req, res) => {
    try {
      const { meId, peerId } = req.body || {};

      if (!isOid(meId) || !isOid(peerId) || String(meId) === String(peerId)) {
        return res.status(400).json({ ok: false, error: 'bad_ids' });
      }

      const [me, peer] = await Promise.all([
        (User).findById(meId, { nick: 1, avatarUrl: 1 }).lean(),
        (User).findById(peerId, { nick: 1, avatarUrl: 1 }).lean(),
      ]);

      if (!me) return res.status(404).json({ ok: false, error: 'me_not_found' });
      if (!peer) return res.status(404).json({ ok: false, error: 'peer_not_found' });

      // Stream Chat синхронизация убрана - больше не используется

      // Stream Chat канал убран - больше не используется

      // Stream Chat обновление канала убрано - больше не используется

      return res.json({ ok: true });
    } catch (e: unknown) {
      console.error('[chat/ensure-dm] error:', (e as ErrorDetails)?.message || e);
      console.error('[chat/ensure-dm] stack:', e);
      return res.status(500).json({ ok: false, error: 'ensure_dm_failed' });
    }
  });
  

  return router;
}
