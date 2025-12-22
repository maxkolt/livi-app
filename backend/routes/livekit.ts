// routes/livekit.ts
import { Router } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { logger } from '../utils/logger';

const router = Router();

const LIVEKIT_API_KEY = (process.env.LIVEKIT_API_KEY || process.env.LK_API_KEY || '').trim();
const LIVEKIT_API_SECRET = (process.env.LIVEKIT_API_SECRET || process.env.LK_API_SECRET || '').trim();

// Проверка конфигурации при загрузке модуля
if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  logger.error('[LiveKit] ⚠️ LIVEKIT_API_KEY or LIVEKIT_API_SECRET not configured!');
  logger.error('[LiveKit] Check environment variables: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LK_API_KEY, LK_API_SECRET');
} else {
  logger.info('[LiveKit] ✅ LiveKit API credentials loaded', { 
    hasApiKey: !!LIVEKIT_API_KEY, 
    hasApiSecret: !!LIVEKIT_API_SECRET,
    apiKeyLength: LIVEKIT_API_KEY.length,
    apiSecretLength: LIVEKIT_API_SECRET.length,
  });
}

export async function createToken({ identity, roomName }: { identity: string; roomName: string }): Promise<string> {
  const apiKey = LIVEKIT_API_KEY;
  const apiSecret = LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    const error = 'LIVEKIT_API_KEY or LIVEKIT_API_SECRET not configured';
    logger.error('[LiveKit] createToken failed:', error);
    throw new Error(error);
  }

  // Проверяем формат API ключа (обычно начинается с определенного префикса)
  if (apiKey.length < 10 || apiSecret.length < 10) {
    logger.warn('[LiveKit] API key or secret seems too short', { 
      apiKeyLength: apiKey.length, 
      apiSecretLength: apiSecret.length,
      apiKeyPrefix: apiKey.substring(0, 4) + '...',
    });
  }

  try {
    const at = new AccessToken(apiKey, apiSecret, {
      identity,
    });

    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

    const token = await at.toJwt();
    logger.info('[LiveKit] Token created successfully', { 
      identity, 
      roomName, 
      tokenLength: token.length,
      apiKeyPrefix: apiKey.substring(0, 8) + '...',
      hasToken: !!token,
    });
    return token;
  } catch (e: any) {
    logger.error('[LiveKit] Token creation error:', { 
      error: e?.message, 
      errorStack: e?.stack,
      identity, 
      roomName,
      apiKeyLength: apiKey.length,
      apiSecretLength: apiSecret.length,
    });
    throw e;
  }
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