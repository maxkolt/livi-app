import sharp from 'sharp';

// вход: либо data-uri, либо сырое base64 (jpeg/png/webp)
// выход: два data-uri jpeg: full (<=512px) и thumb (<=96px)
export async function buildAvatarDataUris(base64Input: string) {
  const buf = base64Input.startsWith('data:')
    ? Buffer.from(base64Input.split(',')[1], 'base64')
    : Buffer.from(base64Input, 'base64');

  const full = await sharp(buf).rotate().resize({ width: 512, height: 512, fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
  const thumb = await sharp(buf).rotate().resize({ width: 96, height: 96, fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();

  const fullB64 = `data:image/jpeg;base64,${full.toString('base64')}`;
  const thumbB64 = `data:image/jpeg;base64,${thumb.toString('base64')}`;
  return { fullB64, thumbB64 };
}

