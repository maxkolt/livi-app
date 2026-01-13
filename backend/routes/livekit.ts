// routes/livekit.ts
import { Router } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { logger } from '../utils/logger';

const router = Router();

const LIVEKIT_API_KEY = (process.env.LIVEKIT_API_KEY || process.env.LK_API_KEY || '').trim();
const LIVEKIT_API_SECRET = (process.env.LIVEKIT_API_SECRET || process.env.LK_API_SECRET || '').trim();
// КРИТИЧНО: В продакшене LIVEKIT_URL должен быть wss://домен, не ws://IP:порт
// Например: LIVEKIT_URL=wss://livekit.твойдомен.com
const LIVEKIT_URL = (process.env.LIVEKIT_URL || process.env.LK_URL || '').trim();

// Валидация LiveKit URL
if (LIVEKIT_URL) {
  const isValidUrl = /^wss?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(LIVEKIT_URL);
  const isIP = /^wss?:\/\/\d+\.\d+\.\d+\.\d+/.test(LIVEKIT_URL);
  
  if (isIP) {
    logger.warn('[LiveKit] ⚠️ LIVEKIT_URL uses IP address instead of domain:', LIVEKIT_URL);
    logger.warn('[LiveKit] For production, use domain with WSS (e.g., wss://livekit.твойдомен.com)');
  } else if (!isValidUrl) {
    logger.warn('[LiveKit] ⚠️ LIVEKIT_URL format may be invalid:', LIVEKIT_URL);
  } else if (!LIVEKIT_URL.startsWith('wss://')) {
    logger.warn('[LiveKit] ⚠️ LIVEKIT_URL should use WSS (secure) for production:', LIVEKIT_URL);
  }
} else {
  logger.error('[LiveKit] ⚠️ LIVEKIT_URL not configured!');
  logger.error('[LiveKit] Set LIVEKIT_URL environment variable (e.g., wss://livekit.твойдомен.com)');
}

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

export const getLiveKitUrl = () => LIVEKIT_URL;

export async function createToken({ identity, roomName }: { identity: string; roomName: string }): Promise<string> {
  const apiKey = LIVEKIT_API_KEY;
  const apiSecret = LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    const error = 'LIVEKIT_API_KEY or LIVEKIT_API_SECRET not configured';
    logger.error('[LiveKit] createToken failed:', error);
    throw new Error(error);
  }

  try {
    const at = new AccessToken(apiKey, apiSecret, {
      identity,
    });

    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

    const token = await at.toJwt();
    logger.debug('[LiveKit] Token created successfully', { identity, roomName, tokenLength: token.length });
    return token;
  } catch (e: any) {
    logger.error('[LiveKit] Token creation error:', { error: e?.message, identity, roomName });
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

    res.json({ ok: true, token, url: LIVEKIT_URL });
  } catch (e: any) {
    logger.error('LiveKit token creation failed:', e);
    res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

export default router;