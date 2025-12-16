// routes/livekit.ts
import { Router } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { logger } from '../utils/logger';

const router = Router();

const LIVEKIT_API_KEY = (process.env.LIVEKIT_API_KEY || process.env.LK_API_KEY || '').trim();
const LIVEKIT_API_SECRET = (process.env.LIVEKIT_API_SECRET || process.env.LK_API_SECRET || '').trim();

export async function createToken({ identity, roomName }: { identity: string; roomName: string }): Promise<string> {
  const apiKey = LIVEKIT_API_KEY;
  const apiSecret = LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error('LIVEKIT_API_KEY or LIVEKIT_API_SECRET not configured');
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
  });

  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

  return await at.toJwt();
}

router.post('/livekit/token', async (req, res) => {
  try {
    const { userId, roomName } = req.body;

    if (!userId || !roomName) {
      return res.status(400).json({ ok: false, error: 'missing_userId_or_roomName' });
    }

    const token = await createToken({ identity: userId, roomName });

    res.json({ ok: true, token });
  } catch (e: any) {
    logger.error('LiveKit token creation failed:', e);
    res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

export default router;


