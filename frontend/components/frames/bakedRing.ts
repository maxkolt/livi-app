import { useEffect, useState } from 'react';
import { Image, PixelRatio } from 'react-native';
import { Skia, type SkImage } from '@shopify/react-native-skia';

/**
 * Запечённые текстуры колец (scripts/bake-frame-ring.js) в двух размерах.
 * ImageShader внутри RuntimeEffect в Skia 2.2.4 сэмплирует без мипмапов, поэтому
 * текстура не должна быть намного крупнее канваса — иначе грани рябят.
 */
export type BakedRingSources = { large: number; small: number };

/** С этого размера канваса в физических пикселях берём 512-ю текстуру. */
const LARGE_RING_MIN_PX = 220;

/**
 * Одна декодированная текстура на всё приложение. С useImage каждый аватар в
 * списке декодировал PNG заново и первые кадры стоял без рамки.
 */
const decoded = new Map<number, SkImage>();
const decoding = new Map<number, Promise<SkImage | null>>();

function loadRing(source: number): Promise<SkImage | null> {
  let task = decoding.get(source);
  if (!task) {
    task = Skia.Data.fromURI(Image.resolveAssetSource(source).uri)
      .then((data) => Skia.Image.MakeImageFromEncoded(data))
      .then((image) => {
        if (image) decoded.set(source, image);
        return image;
      })
      .catch(() => null)
      .finally(() => {
        decoding.delete(source);
      });
    decoding.set(source, task);
  }
  return task;
}

export function useBakedRing(sources: BakedRingSources, sideDp: number): SkImage | null {
  const source = sideDp * PixelRatio.get() >= LARGE_RING_MIN_PX ? sources.large : sources.small;
  const [image, setImage] = useState<SkImage | null>(() => decoded.get(source) ?? null);

  useEffect(() => {
    const ready = decoded.get(source);
    if (ready) {
      setImage(ready);
      return;
    }
    let alive = true;
    void loadRing(source).then((loaded) => {
      if (alive && loaded) setImage(loaded);
    });
    return () => {
      alive = false;
    };
  }, [source]);

  // При смене размера держим прежнюю текстуру, пока не готова новая.
  return decoded.get(source) ?? image;
}
