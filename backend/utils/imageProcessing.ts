import sharp from 'sharp';

export function getContentTypeFromExtension(filename: string): string {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.avif')) return 'image/avif';
  return 'image/jpeg';
}

export async function validateImage(buffer: Buffer): Promise<{ valid: boolean; error?: string }> {
  try {
    if (!buffer || !Buffer.isBuffer(buffer)) return { valid: false, error: 'empty_buffer' };
    if (buffer.length > 10 * 1024 * 1024) return { valid: false, error: 'file_too_large' };
    const meta = await sharp(buffer).metadata();
    if (!meta || !meta.width || !meta.height) return { valid: false, error: 'bad_image' };
    if (meta.width > 4096 || meta.height > 4096) return { valid: false, error: 'too_large_resolution' };
    return { valid: true };
  } catch (e: any) {
    return { valid: false, error: e?.message || 'invalid_image' };
  }
}

export async function processAvatarImage(buffer: Buffer, contentType?: string) {
  // Нормализуем исходник и поворот EXIF
  const base = sharp(buffer, { failOn: 'none' }).rotate();

  // В качестве каноничного формата используем JPEG
  const original = await base.jpeg({ quality: 90 }).toBuffer();
  const large = await base.resize(512, 512, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
  const medium = await base.resize(256, 256, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
  const thumbnail = await base.resize(128, 128, { fit: 'cover' }).jpeg({ quality: 60 }).toBuffer();

  return {
    original: { imageData: original, size: original.length, contentType: 'image/jpeg' },
    large: { imageData: large, size: large.length, contentType: 'image/jpeg' },
    medium: { imageData: medium, size: medium.length, contentType: 'image/jpeg' },
    thumbnail: { imageData: thumbnail, size: thumbnail.length, contentType: 'image/jpeg' },
  };
}


