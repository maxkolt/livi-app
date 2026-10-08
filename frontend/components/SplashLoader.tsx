// components/SplashLoader.tsx
/**
 * Покрышка холодного старта: тот же фон сцены, что у окна MainActivity, поэтому
 * переход с системной заставки на неё не виден. Под ней «Поиск» рисуется целиком
 * (ник, аватар под линзой уже декодирован), и покрышка один раз гаснет.
 *
 * Без логотипа и без минимальной длительности: раньше логотип появлялся после
 * системной иконки, держался обязательные 3 с и исчезал рывком — два лишних
 * мигания и ~2 с ожидания.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { WelcomeStageBackground } from '../screens/home/WelcomeStageBackground';
import { HOME_NAV_BG } from '../screens/home/constants';

const FADE_MS = 220;
/** Что-то зависло (диск, декодер) — показываем экран как есть, не держим пустой фон. */
const HARD_STOP_MS = 4500;

interface SplashLoaderProps {
  /** Ник/аватар уже известны (с диска или с сервера). */
  dataLoaded: boolean;
  /** Аватар Поиска декодирован — после ухода покрышки не появится с задержкой. */
  hasAvatarReady?: boolean;
  onComplete?: () => void;
}

export default function SplashLoader({ dataLoaded, hasAvatarReady = true, onComplete }: SplashLoaderProps) {
  const opacity = useRef(new Animated.Value(1)).current;
  const finishingRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const finish = React.useCallback(() => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    Animated.timing(opacity, {
      toValue: 0,
      duration: FADE_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(() => onCompleteRef.current?.());
  }, [opacity]);

  useEffect(() => {
    if (dataLoaded && hasAvatarReady) finish();
  }, [dataLoaded, finish, hasAvatarReady]);

  useEffect(() => {
    const t = setTimeout(finish, HARD_STOP_MS);
    return () => clearTimeout(t);
  }, [finish]);

  return (
    // Тапы не проходят: под покрышкой уже живой «Поиск» (кнопка поиска собеседника).
    <Animated.View style={[styles.container, { backgroundColor: HOME_NAV_BG, opacity }]}>
      <WelcomeStageBackground palette="tealDeep" />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
  },
});
