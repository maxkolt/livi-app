import sharp from 'sharp';

/**
 * Принимает base64 (с data-uri или без) и возвращает:
 * - fullB64: data:image/jpeg;base64,...
 * - thumbB64: data:image/jpeg;base64,...
 */
export async function buildAvatarDataUris(inputBase64: string): Promise<{ fullB64: string; thumbB64: string }> {
  const raw = String(inputBase64 || '').trim();
  if (!raw) return { fullB64: '', thumbB64: '' };

  const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  const b64 = m ? m[2] : raw;
  const buf = Buffer.from(b64, 'base64');

  // Full: max 512x512, jpg
  const full = await sharp(buf)
    .rotate()
    .resize(512, 512, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toBuffer();

  // Thumb: max 128x128, jpg
  const thumb = await sharp(buf)
    .rotate()
    .resize(128, 128, { fit: 'cover' })
    .jpeg({ quality: 70 })
    .toBuffer();

  return {
    fullB64: `data:image/jpeg;base64,${full.toString('base64')}`,
    thumbB64: `data:image/jpeg;base64,${thumb.toString('base64')}`,
  };
}

