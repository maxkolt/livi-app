// «Эмбиент» ленты Fliq, как в YouTube: свет от ролика на фоне вокруг карточки.
// Кадры встроенного плеера недоступны (чужой iframe), поэтому цвета берём из превью ролика.
//
// Два слоя одного размытого превью:
// - ореол — плотный, по размеру карточки чуть шире неё: свет растекается от краёв ролика;
// - тон фона — на весь экран, слабый: общий фон вкладки окрашивается настроением ролика.
// Размытие с режимом decal гаснет к прозрачному само, без градиентов, поэтому свет переходит
// в фон приложения мягко. При смене ролика свет перетекает к новому (крест-растворение).
import React, { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Blur,
  Canvas,
  ColorMatrix,
  Group,
  Image as SkiaImage,
  Paint,
  Skia,
  type SkImage,
} from '@shopify/react-native-skia';
import { useDerivedValue, useSharedValue, withTiming, Easing } from 'react-native-reanimated';

/** Насыщенность света: превью часто блёклые, свет должен читаться цветом. */
function saturate(s: number, k: number): number[] {
  const lr = 0.2126;
  const lg = 0.7152;
  const lb = 0.0722;
  return [
    (lr * (1 - s) + s) * k, lg * (1 - s) * k, lb * (1 - s) * k, 0, 0,
    lr * (1 - s) * k, (lg * (1 - s) + s) * k, lb * (1 - s) * k, 0, 0,
    lr * (1 - s) * k, lg * (1 - s) * k, (lb * (1 - s) + s) * k, 0, 0,
    0, 0, 0, 1, 0,
  ];
}
const HALO_MATRIX = saturate(1.45, 0.92);
const WASH_MATRIX = saturate(1.3, 0.8);

const FADE_MS = 520;

/** Декодированные превью: один и тот же ролик листают туда-обратно. */
const imageCache = new Map<string, SkImage>();
const IMAGE_CACHE_MAX = 12;

async function loadImage(url: string): Promise<SkImage | null> {
  const hit = imageCache.get(url);
  if (hit) return hit;
  try {
    const data = await Skia.Data.fromURI(url);
    const img = Skia.Image.MakeImageFromEncoded(data);
    if (!img) return null;
    imageCache.set(url, img);
    if (imageCache.size > IMAGE_CACHE_MAX) {
      const oldest = imageCache.keys().next().value;
      if (oldest) imageCache.delete(oldest);
    }
    return img;
  } catch {
    return null;
  }
}

export type FliqAmbientRect = { x: number; y: number; width: number; height: number };

type Props = {
  /** Превью ролика на экране; null — света нет. */
  url: string | null;
  /** Где стоит карточка ролика (в координатах слоя). */
  card: FliqAmbientRect;
  width: number;
  height: number;
};

export const FliqAmbient = memo(function FliqAmbient({ url, card, width, height }: Props) {
  const [front, setFront] = useState<SkImage | null>(null);
  const [back, setBack] = useState<SkImage | null>(null);
  const frontRef = useRef<SkImage | null>(null);
  const progress = useSharedValue(1);
  const frontOpacity = useDerivedValue(() => progress.value);
  const backOpacity = useDerivedValue(() => 1 - progress.value);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    void loadImage(url).then((img) => {
      if (!alive || !img || img === frontRef.current) return;
      setBack(frontRef.current);
      frontRef.current = img;
      setFront(img);
      progress.value = 0;
      progress.value = withTiming(1, { duration: FADE_MS, easing: Easing.out(Easing.quad) });
    });
    return () => {
      alive = false;
    };
  }, [url, progress]);

  if (width <= 0 || height <= 0 || (!front && !back)) return null;

  // Ореол чуть шире карточки: у края ролика свет ~на половине, дальше гаснет.
  const halo = { x: card.x - 14, y: card.y - 10, width: card.width + 28, height: card.height + 20 };
  const draw = (img: SkImage, rect: FliqAmbientRect, opacity: typeof frontOpacity) => (
    <SkiaImage image={img} x={rect.x} y={rect.y} width={rect.width} height={rect.height} fit="cover" opacity={opacity} />
  );
  const screen = { x: -40, y: -40, width: width + 80, height: height + 80 };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Canvas style={StyleSheet.absoluteFill}>
        {/* Тон фона: всё окно, очень мягко. */}
        <Group
          opacity={0.2}
          layer={
            <Paint>
              <Blur blur={70} mode="decal" />
              <ColorMatrix matrix={WASH_MATRIX} />
            </Paint>
          }
        >
          {back ? draw(back, screen, backOpacity) : null}
          {front ? draw(front, screen, frontOpacity) : null}
        </Group>
        {/* Ореол вокруг карточки. */}
        <Group
          opacity={0.72}
          layer={
            <Paint>
              <Blur blur={46} mode="decal" />
              <ColorMatrix matrix={HALO_MATRIX} />
            </Paint>
          }
        >
          {back ? draw(back, halo, backOpacity) : null}
          {front ? draw(front, halo, frontOpacity) : null}
        </Group>
      </Canvas>
    </View>
  );
});
