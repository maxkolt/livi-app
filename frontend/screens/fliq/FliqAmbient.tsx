// «Эмбиент» ленты Fliq, как в YouTube: свет от ролика на фоне вокруг карточки.
// Кадры встроенного плеера недоступны (чужой iframe), поэтому цвета берём из превью ролика.
//
// Два слоя одного размытого превью:
// - ореол — плотный, по размеру карточки чуть шире неё: свет растекается от краёв ролика;
// - тон фона — на весь экран, слабый: общий фон вкладки окрашивается настроением ролика.
// Размытие с режимом decal гаснет к прозрачному само, без градиентов, поэтому свет переходит
// в фон приложения мягко. При смене ролика свет перетекает к новому (крест-растворение).
import { PaneLiveContext, usePaneResources } from '../../utils/paneVisibility';
import React, { memo, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Blur,
  Canvas,
  ColorMatrix,
  Group,
  Image as SkiaImage,
  Paint,
  type SkImage,
} from '@shopify/react-native-skia';
import { cancelAnimation, runOnJS, useDerivedValue, useSharedValue, withTiming, Easing } from 'react-native-reanimated';
import { fliqAmbientImages } from './fliqAmbientImages';
export { prefetchFliqAmbient } from './fliqAmbientImages';

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

/** Перетекание света к новому ролику — быстрое: свет меняется вместе с роликом, а не после. */
const FADE_MS = 300;

type FliqAmbientRect = { x: number; y: number; width: number; height: number };

type Props = {
  /** Превью ролика на экране; null — света нет. */
  url: string | null;
  /** Где стоит карточка ролика (в координатах слоя). */
  card: FliqAmbientRect;
  width: number;
  height: number;
};

export const FliqAmbient = memo(function FliqAmbient({ url, card, width, height }: Props) {
  const resources = usePaneResources();
  const live = useContext(PaneLiveContext);
  // Unmount the image-owning subtree, including state, when the pane sleeps.
  if (!resources || !live || !url || width <= 0 || height <= 0) return null;
  return <ActiveFliqAmbient url={url} card={card} width={width} height={height} />;
});

function ActiveFliqAmbient({ url, card, width, height }: Props) {
  const [front, setFront] = useState<SkImage | null>(null);
  const [back, setBack] = useState<SkImage | null>(null);
  const frontRef = useRef<SkImage | null>(null);
  const progress = useSharedValue(1);
  const frontOpacity = useDerivedValue(() => progress.value);
  const backOpacity = useDerivedValue(() => 1 - progress.value);
  const transition = useRef(0);
  const finishTransition = useCallback((id: number) => {
    if (transition.current === id) setBack(null);
  }, []);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    const cancelLoad = fliqAmbientImages.request(url, (img) => {
      if (!alive) return;
      if (!img) {
        transition.current++;
        cancelAnimation(progress);
        frontRef.current = null;
        setFront(null);
        setBack(null);
        return;
      }
      if (img === frontRef.current) return;
      setBack(frontRef.current);
      frontRef.current = img;
      setFront(img);
      const id = ++transition.current;
      progress.value = 0;
      progress.value = withTiming(1, { duration: FADE_MS, easing: Easing.out(Easing.quad) }, (finished) => {
        if (finished) runOnJS(finishTransition)(id);
      });
    });
    return () => {
      alive = false;
      cancelLoad();
    };
  }, [url, progress, finishTransition]);

  useEffect(() => () => {
    transition.current++;
    cancelAnimation(progress);
    frontRef.current = null;
  }, [progress]);

  if (!front && !back) return null;

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
}
