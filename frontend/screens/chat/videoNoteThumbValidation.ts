import { AlphaType, ColorType, Skia } from '@shopify/react-native-skia';

/** Reject the nearly uniform green decoder frame, while keeping textured green scenes. */
export function isSolidGreenVideoNoteThumb(pixels: Uint8Array, width: number, height: number): boolean {
  const grid = 16;
  let green = 0;
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (let row = 0; row < grid; row++) {
    const y = Math.round(row * (height - 1) / (grid - 1));
    for (let col = 0; col < grid; col++) {
      const x = Math.round(col * (width - 1) / (grid - 1));
      const i = (y * width + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      if (pixels[i + 3] >= 240 && r <= 48 && b <= 48 && g >= 64 &&
          g > 2 * r && g > 2 * b) {
        green++;
        for (let channel = 0; channel < 3; channel++) {
          min[channel] = Math.min(min[channel], pixels[i + channel]);
          max[channel] = Math.max(max[channel], pixels[i + channel]);
        }
      }
    }
  }
  return green >= grid * grid * 0.99 && max.every((v, i) => v - min[i] <= 16);
}

/** Inspect the final JPEG, including any corruption introduced during image conversion. */
export async function isVideoNoteThumbUsable(uri: string): Promise<boolean> {
  const data = await Skia.Data.fromURI(uri);
  let image: ReturnType<typeof Skia.Image.MakeImageFromEncoded> = null;
  try {
    image = Skia.Image.MakeImageFromEncoded(data);
    if (!image) return false;
    const width = image.width();
    const height = image.height();
    // These are generated at max 360x360; don't read an unexpectedly large allocation.
    if (width <= 0 || height <= 0 || width > 512 || height > 512) return false;
    const pixels = image.readPixels(0, 0, {
      width, height, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul,
    });
    if (!(pixels instanceof Uint8Array) || pixels.length !== width * height * 4) return false;
    return !isSolidGreenVideoNoteThumb(pixels, width, height);
  } finally {
    try { image?.dispose(); } catch {}
    try { data.dispose(); } catch {}
  }
}
