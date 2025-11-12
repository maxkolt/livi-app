// backend/routes/upload.ts
import { Router } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();

// Создаем директорию для uploads если её нет
const uploadsDir = path.join(__dirname, '../public/uploads/media');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// POST /api/upload/media
router.post('/upload/media', async (req, res) => {
  try {
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

    // Определяем расширение файла по MIME типу
    let extension = 'bin';
    if (mimeType.startsWith('image/')) {
      const ext = mimeType.split('/')[1];
      extension = ext === 'jpeg' ? 'jpg' : ext;
    } else if (mimeType.startsWith('video/')) {
      const ext = mimeType.split('/')[1];
      extension = ext === 'quicktime' ? 'mov' : ext;
    }

    // Генерируем уникальное имя файла
    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${extension}`;
    const filePath = path.join(uploadsDir, fileName);

    // Сохраняем файл
    const buffer = Buffer.from(base64Data, 'base64');
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

export default router;

