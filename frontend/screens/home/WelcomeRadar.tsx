import React, { useEffect, useMemo, useState } from 'react';
import { AppState, PixelRatio, StyleSheet, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Canvas, Picture, type SkPicture } from '@shopify/react-native-skia';
import {
  runOnUI,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import { logger } from '../../utils/logger';
import { useDeviceTilt } from './useDeviceTilt';
import {
  buildRadarScene,
  drawRadarFrame,
  getEmptyRadarPicture,
  prepareRadarPayload,
  radarGeometry,
  type RadarPayload,
  type RadarScene,
} from './welcomeRadarScene';

type WelcomeRadarProps = {
  size: number;
  /** Видимый диаметр аватара в центре — от него начинается шкала и луч. */
  avatarSize?: number;
  /** false — вкладка «Поиск» скрыта: луч стоит, кадры не считаются. */
  active?: boolean;
  children: React.ReactNode;
};

/** Не чаще ~60 перерисовок в секунду. */
const MIN_REDRAW_MS = 14;

function useAppActive(): boolean {
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setAppActive(next === 'active'));
    return () => sub.remove();
  }, []);
  return appActive;
}

export function WelcomeRadar({ size, avatarSize, active = true, children }: WelcomeRadarProps) {
  /**
   * Размер целиком задаёт родитель. Своего onLayout здесь нет намеренно.
   *
   * Раньше радар измерял себя сам и принимал любое положительное значение. При
   * возврате из фона RN отдаёт промежуточные замеры, каждый чуть больше
   * предыдущего; они закреплялись, и радиусы орбит ползли вверх от цикла к
   * циклу — 205 → 209 → 213 → 215.
   */
  const s = size;
  const geometry = useMemo(() => radarGeometry(s, avatarSize ?? s * 0.38), [s, avatarSize]);

  const scene = useSharedValue<RadarScene | null>(null);
  const picture = useSharedValue<SkPicture>(getEmptyRadarPicture());

  const isFocused = useIsFocused();
  const appActive = useAppActive();
  const reduceMotion = useReducedMotion();
  const running = active && isFocused && appActive && !reduceMotion;
  // Параллакс только у радара и только пока он анимируется: датчик не работает зря.
  const tilt = useDeviceTilt(running);

  useEffect(() => {
    let payload: RadarPayload | null = null;
    try {
      payload = prepareRadarPayload(geometry, PixelRatio.get());
    } catch (e) {
      logger.warn('[welcome-radar] static layer failed', { error: String((e as Error)?.message ?? e) });
    }
    if (!payload) return;
    runOnUI((p: RadarPayload) => {
      'worklet';
      // Время сохраняем: после поворота луч продолжает с того же места.
      const S = buildRadarScene(p, scene.value?.t ?? 0);
      scene.value = S;
      picture.value = drawRadarFrame(S);
    })(payload);
  }, [geometry, picture, scene]);

  useEffect(
    () => () => {
      runOnUI(() => {
        'worklet';
        scene.value = null;
      })();
    },
    [scene],
  );

  const frame = useFrameCallback((info) => {
    'worklet';
    const S = scene.value;
    if (!S) return;
    const dt = info.timeSincePreviousFrame;
    // Первый кадр после паузы — без скачка.
    const ms = dt == null ? 0 : Math.min(dt, 100);
    S.t += ms / 1000;
    // Луч медленный — 60 кадров хватает с запасом, на 120 Гц рисуем через кадр.
    S.sinceDrawMs += ms;
    if (S.sinceDrawMs < MIN_REDRAW_MS) return;
    S.sinceDrawMs = 0;
    S.tiltX = tilt.x.value;
    S.tiltY = tilt.y.value;
    picture.value = drawRadarFrame(S);
  }, false);

  useEffect(() => {
    frame.setActive(running);
  }, [frame, running]);

  return (
    <View style={[styles.wrap, { width: s, height: s }]}>
      <Canvas style={StyleSheet.absoluteFill} colorSpace="srgb" pointerEvents="none">
        <Picture picture={picture} />
      </Canvas>
      <View style={styles.center}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
