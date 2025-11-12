// backend/routes/app-settings.ts
import { Router } from 'express';

const r = Router();

// Cloudinary больше не используется, аватары хранятся в MongoDB

// Stream key тоже может быть в публичной переменной (для фронта) или в серверной
const streamApiKey =
  process.env.EXPO_PUBLIC_STREAM_KEY ||
  process.env.STREAM_API_KEY ||
  '';

r.get('/app-settings', (_req, res) => {
  res.json({
    ok: true,
    // оставляем как было, чтобы ничего не сломать
    streamApiKey,
    // Cloudinary больше не используется, аватары хранятся в MongoDB
  });
});

export default r;
