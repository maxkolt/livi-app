// backend/routes/app-settings.ts
import { Router, Request } from 'express';
import mongoose from 'mongoose';
import AppConfig from '../models/AppConfig';

const r = Router();

// Cloudinary больше не используется, аватары хранятся в MongoDB

// Stream key тоже может быть в публичной переменной (для фронта) или в серверной
const streamApiKey =
  process.env.EXPO_PUBLIC_STREAM_KEY ||
  process.env.STREAM_API_KEY ||
  '';

// Fallback из env (если в БД ещё не задано или БД недоступна)
const latestAppVersionEnv = (process.env.APP_LATEST_VERSION || process.env.LATEST_APP_VERSION || '').trim();

const APP_CONFIG_KEY_LATEST_VERSION = 'latestAppVersion';

// Секрет для автоматического обновления версии из CI (задай APP_UPDATE_SECRET в env).
const APP_UPDATE_SECRET = (process.env.APP_UPDATE_SECRET || process.env.ADMIN_SECRET || '').trim();

/** Проверка секрета из заголовка X-Admin-Key или Authorization: Bearer <token> */
function isAuthorized(req: Request): boolean {
  if (!APP_UPDATE_SECRET) return false;
  const key = (req.headers['x-admin-key'] as string)?.trim();
  if (key && key === APP_UPDATE_SECRET) return true;
  const auth = (req.headers.authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token === APP_UPDATE_SECRET) return true;
  }
  return false;
}

/** GET /api/app-settings — отдаёт настройки; latestAppVersion берётся из БД, при отсутствии — из env */
r.get('/app-settings', async (_req, res) => {
  let latestAppVersion = latestAppVersionEnv;
  if (mongoose.connection.readyState === 1) {
    try {
      const doc = await AppConfig.findOne({ key: APP_CONFIG_KEY_LATEST_VERSION }).lean();
      const fromDb = (doc as any)?.value;
      if (fromDb && typeof fromDb === 'string' && fromDb.trim()) {
        latestAppVersion = fromDb.trim();
      }
    } catch {
      // оставляем env
    }
  }
  res.json({
    ok: true,
    streamApiKey,
    ...(latestAppVersion ? { latestAppVersion } : {}),
  });
});

/** POST /api/app-settings/latest-version — установить latestAppVersion (для CI). Тело: { "latestAppVersion": "1.0.53" }. Заголовок: X-Admin-Key: <APP_UPDATE_SECRET> или Authorization: Bearer <APP_UPDATE_SECRET> */
r.post('/app-settings/latest-version', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const version = (req.body?.latestAppVersion ?? '').toString().trim();
  if (!version) {
    return res.status(400).json({ ok: false, error: 'missing latestAppVersion' });
  }
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ ok: false, error: 'database_unavailable' });
  }
  try {
    await AppConfig.findOneAndUpdate(
      { key: APP_CONFIG_KEY_LATEST_VERSION },
      { $set: { key: APP_CONFIG_KEY_LATEST_VERSION, value: version } },
      { upsert: true, new: true }
    );
    return res.json({ ok: true, latestAppVersion: version });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'update_failed' });
  }
});

export default r;
