// backend/routes/upload.ts
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import multer from 'multer';
import Install from '../models/Install';
import { checkRateLimit } from '../utils/rateLimit';

const router = Router();

// IMPORTANT: save uploads into the same PUBLIC_DIR that the server serves from.
// In production, backend runs from dist/ but serves static files from backend/public.
// If we write into dist/public, the files become unreachable => 404 on /uploads/media/...
function resolvePublicDir(): string {
  const candidates = [
    // When compiled: __dirname = backend/dist/routes -> ../../public = backend/public (correct)
    // When dev:      __dirname = backend/routes      -> ../../public = backend/public (correct)
    path.resolve(__dirname, '..', '..', 'public'),
    // Fallbacks
    path.resolve(__dirname, '..', 'public'),
    path.join(__dirname, 'public'),
    path.resolve(__dirname, '..', '..', '..', 'public'),
  ];
  const hasKnownFiles = (dir: string) => {
    try {
      return (
        fs.existsSync(path.join(dir, '.well-known', 'assetlinks.json')) ||
        fs.existsSync(path.join(dir, 'invite.html')) ||
        fs.existsSync(path.join(dir, 'uploads'))
      );
    } catch {
      return false;
    }
  };
  return (
    candidates.find((d) => fs.existsSync(d) && hasKnownFiles(d)) ??
    candidates.find((d) => fs.existsSync(d)) ??
    candidates[0]!
  );
}

// Создаем директорию для uploads если её нет
const uploadsDir = path.join(resolvePublicDir(), 'uploads', 'media');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// POST /api/upload/media
router.post('/upload/media', async (req, res) => {
  try {
    // SECURITY: require installId-based auth (do not accept x-user-id alone).
    const installId = String(req.header('x-install-id') || '').trim();
    if (!installId) {
      return res.status(401).json({ ok: false, error: 'no_installId' });
    }

    // Basic abuse protection
    const rl = checkRateLimit(`upload_media:${installId}`, 25, 60_000);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec || 60));
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
    const inst = await Install.findOne({ installId }).select('user').lean();
    const authedUserId = inst?.user ? String((inst as any).user) : '';
    if (!authedUserId) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const { dataUri, type, from, to } = req.body;

    if (!dataUri || typeof dataUri !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing dataUri' });
    }

    if (!dataUri.startsWith('data:')) {
      return res.status(400).json({ ok: false, error: 'Invalid dataUri format' });
    }

    // Извлекаем MIME тип и base64 данные
    const matches = dataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ ok: false, error: 'Invalid dataUri format' });
    }

    const mimeType = matches[1];
    const base64Data = matches[2];

    // Optional: validate 'from' matches authenticated user
    if (from && String(from).trim() && String(from).trim() !== authedUserId) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // Restrict allowed content types (reduce abuse surface)
    const allowed = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'video/mp4',
      'video/quicktime',
      'video/webm',
      // audio (voice messages)
      'audio/mp4',    // m4a (common)
      'audio/m4a',    // some clients report this
      'audio/aac',
      'audio/mpeg',   // mp3
      'audio/ogg',
      'audio/webm',
      'audio/wav',
      'audio/x-wav',
    ]);
    if (!allowed.has(mimeType)) {
      return res.status(400).json({ ok: false, error: 'unsupported_mime' });
    }

    // Определяем расширение файла по MIME типу
    let extension = 'bin';
    if (mimeType.startsWith('image/')) {
      const ext = mimeType.split('/')[1];
      extension = ext === 'jpeg' ? 'jpg' : ext;
    } else if (mimeType.startsWith('video/')) {
      const ext = mimeType.split('/')[1];
      extension = ext === 'quicktime' ? 'mov' : ext;
    } else if (mimeType.startsWith('audio/')) {
      const ext = mimeType.split('/')[1];
      // Normalize common audio extensions
      if (ext === 'mp4' || ext === 'm4a') extension = 'm4a';
      else if (ext === 'mpeg') extension = 'mp3';
      else if (ext === 'x-wav') extension = 'wav';
      else extension = ext;
    }

    // Генерируем уникальное имя файла
    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${extension}`;
    const filePath = path.join(uploadsDir, fileName);

    // Сохраняем файл
    const buffer = Buffer.from(base64Data, 'base64');

    // Basic size limit: 100MB (matches client expectation; protects server disk/CPU)
    const maxBytes = 100 * 1024 * 1024;
    if (buffer.length <= 0) {
      return res.status(400).json({ ok: false, error: 'empty_file' });
    }
    if (buffer.length > maxBytes) {
      return res.status(413).json({ ok: false, error: 'file_too_large' });
    }
    fs.writeFileSync(filePath, buffer);

    // Возвращаем публичный URL
    const url = `/uploads/media/${fileName}`;

    console.log(`📤 Media uploaded: ${fileName} (${mimeType}, ${Math.round(buffer.length / 1024)}KB)`);

    return res.json({ ok: true, url });
  } catch (error: any) {
    console.error('📤 Upload error:', error);
    return res.status(500).json({ ok: false, error: error?.message || 'Upload failed' });
  }
});

// POST /api/upload/media/multipart
// Field: file
const MAX_BYTES = 100 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

router.post('/upload/media/multipart', upload.single('file'), async (req, res) => {
  try {
    // SECURITY: require installId-based auth (do not accept x-user-id alone).
    const installId = String(req.header('x-install-id') || '').trim();
    if (!installId) {
      return res.status(401).json({ ok: false, error: 'no_installId' });
    }

    // Basic abuse protection
    const rl = checkRateLimit(`upload_media_mp:${installId}`, 60, 60_000);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec || 60));
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
    const inst = await Install.findOne({ installId }).select('user').lean();
    const authedUserId = inst?.user ? String((inst as any).user) : '';
    if (!authedUserId) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const file = (req as any).file as { buffer: Buffer; mimetype: string; originalname: string } | undefined;
    if (!file?.buffer?.length) {
      return res.status(400).json({ ok: false, error: 'missing_file' });
    }

    const allowed = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'video/mp4',
      'video/quicktime',
      'video/webm',
      // audio (voice messages)
      'audio/mp4',
      'audio/m4a',
      'audio/aac',
      'audio/mpeg',
      'audio/ogg',
      'audio/webm',
      'audio/wav',
      'audio/x-wav',
    ]);
    if (!allowed.has(String(file.mimetype || ''))) {
      return res.status(400).json({ ok: false, error: 'unsupported_mime' });
    }

    let extension = 'bin';
    if (file.mimetype.startsWith('image/')) {
      const ext = file.mimetype.split('/')[1];
      extension = ext === 'jpeg' ? 'jpg' : ext;
    } else if (file.mimetype.startsWith('video/')) {
      const ext = file.mimetype.split('/')[1];
      extension = ext === 'quicktime' ? 'mov' : ext;
    } else if (file.mimetype.startsWith('audio/')) {
      const ext = file.mimetype.split('/')[1];
      if (ext === 'mp4' || ext === 'm4a') extension = 'm4a';
      else if (ext === 'mpeg') extension = 'mp3';
      else if (ext === 'x-wav') extension = 'wav';
      else extension = ext;
    }

    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${extension}`;
    const filePath = path.join(uploadsDir, fileName);

    if (file.buffer.length > MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'file_too_large' });
    }

    fs.writeFileSync(filePath, file.buffer);
    const url = `/uploads/media/${fileName}`;
    return res.json({ ok: true, url });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || 'Upload failed' });
  }
});

export default router;

