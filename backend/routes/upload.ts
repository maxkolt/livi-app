// backend/routes/upload.ts
import express, { Router } from 'express';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import multer from 'multer';
import Install from '../models/Install';
import { checkRateLimit } from '../utils/rateLimit';

const router = Router();
const MAX_MULTIPART_BYTES = 100 * 1024 * 1024;
const MAX_BASE64_BINARY_BYTES = 10 * 1024 * 1024;
const BASE64_JSON_LIMIT = '14mb';
const ALLOWED_MEDIA_MIME_TYPES = new Set([
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

function extensionForMimeType(mimeType: string): string {
  if (mimeType.startsWith('image/')) {
    const ext = mimeType.split('/')[1];
    return ext === 'jpeg' ? 'jpg' : ext;
  }
  if (mimeType.startsWith('video/')) {
    const ext = mimeType.split('/')[1];
    return ext === 'quicktime' ? 'mov' : ext;
  }
  if (mimeType.startsWith('audio/')) {
    const ext = mimeType.split('/')[1];
    if (ext === 'mp4' || ext === 'm4a') return 'm4a';
    if (ext === 'mpeg') return 'mp3';
    if (ext === 'x-wav') return 'wav';
    return ext;
  }
  return 'bin';
}

function createUploadFileName(mimeType: string): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${extensionForMimeType(mimeType)}`;
}

async function authenticateUpload(req: express.Request, res: express.Response, rateLimitKey: string, maxRequests: number): Promise<string | null> {
  // SECURITY: require installId-based auth (do not accept x-user-id alone).
  const installId = String(req.header('x-install-id') || '').trim();
  if (!installId) {
    res.status(401).json({ ok: false, error: 'no_installId' });
    return null;
  }

  const rl = await checkRateLimit(`${rateLimitKey}:${installId}`, maxRequests, 60_000, {
    sensitive: true,
  });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfterSec || 60));
    res.status(429).json({ ok: false, error: 'rate_limited' });
    return null;
  }

  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({ ok: false, error: 'database_unavailable' });
    return null;
  }
  const inst = await Install.findOne({ installId }).select('user').lean();
  const authedUserId = inst?.user ? String((inst as any).user) : '';
  if (!authedUserId) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return null;
  }
  return authedUserId;
}

function requireUploadAuth(rateLimitKey: string, maxRequests: number): express.RequestHandler {
  return async (req, res, next) => {
    try {
      const authedUserId = await authenticateUpload(req, res, rateLimitKey, maxRequests);
      if (!authedUserId) return;
      (req as any).uploadUserId = authedUserId;
      next();
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || 'Upload failed' });
    }
  };
}

// POST /api/upload/media
// Legacy base64 JSON fallback. Keep this intentionally small; use multipart for large media.
router.post('/upload/media', requireUploadAuth('upload_media', 25), express.json({ limit: BASE64_JSON_LIMIT }), async (req, res) => {
  try {
    const authedUserId = String((req as any).uploadUserId || '');

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

    if (!ALLOWED_MEDIA_MIME_TYPES.has(mimeType)) {
      return res.status(400).json({ ok: false, error: 'unsupported_mime' });
    }

    const fileName = createUploadFileName(mimeType);
    const filePath = path.join(uploadsDir, fileName);

    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length <= 0) {
      return res.status(400).json({ ok: false, error: 'empty_file' });
    }
    if (buffer.length > MAX_BASE64_BINARY_BYTES) {
      return res.status(413).json({ ok: false, error: 'file_too_large' });
    }
    await fs.promises.writeFile(filePath, buffer);

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
const multipartStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => cb(null, createUploadFileName(String(file.mimetype || ''))),
});
const upload = multer({
  storage: multipartStorage,
  limits: { fileSize: MAX_MULTIPART_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mimeType = String(file.mimetype || '');
    if (!ALLOWED_MEDIA_MIME_TYPES.has(mimeType)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'unsupported_mime'));
    }
    cb(null, true);
  },
});

router.post('/upload/media/multipart', async (req, res) => {
  try {
    const authedUserId = await authenticateUpload(req, res, 'upload_media_mp', 60);
    if (!authedUserId) return;

    upload.single('file')(req, res, async (error: any) => {
      if (error) {
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ ok: false, error: 'file_too_large' });
        }
        if (error instanceof multer.MulterError && error.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ ok: false, error: 'unsupported_mime' });
        }
        return res.status(400).json({ ok: false, error: error?.message || 'upload_failed' });
      }

      const file = (req as any).file as { path: string; filename: string; mimetype: string; size: number } | undefined;
      if (!file?.path || !file?.filename || !file.size) {
        return res.status(400).json({ ok: false, error: 'missing_file' });
      }

      const url = `/uploads/media/${file.filename}`;
      return res.json({ ok: true, url });
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || 'Upload failed' });
  }
});

export default router;

