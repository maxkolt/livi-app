// components/SplashLoader.tsx
import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useSafeAreaFrame } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { WelcomeStageBackground } from '../screens/home/WelcomeStageBackground';
import { HOME_NAV_BG } from '../screens/home/constants';

const SPLASH_FADE_DURATION_MS = 620;
/** Аварийный предел только на случай ошибки: готовый Search закрывает splash немедленно. */
const MAX_SPLASH_DURATION_MS = 9000;
const BREATH_MS = 2000;
const SPLASH_ICON = require('../assets/splash-icon.png');

interface SplashLoaderProps {
  onComplete?: () => void;
  hasNick?: boolean;
  hasAvatar?: boolean;
  hasContentReady?: boolean;
  overlayMode?: boolean;
}

export default function SplashLoader({
  hasContentReady = true,
  onComplete,
  overlayMode,
}: SplashLoaderProps) {
  const [showSplash, setShowSplash] = useState(true);
  const { height: windowHeight, width: windowWidth } = useSafeAreaFrame();
  // Чуть крупнее исходных 168; нативный Android 12 icon — отдельно меньше (круг).
  const logoSize = Math.min(214, Math.max(136, Math.round(Math.min(windowHeight * 0.28, windowWidth * 0.50))));
  const startedAtRef = useRef(Date.now());
  const finishScheduledRef = useRef(false);

  // 0 → 1 → 0 на UI-потоке (withRepeat reverse): без стыков sequence, как у RN Animated.loop.
  const breath = useSharedValue(0);
  const logoOpacity = useSharedValue(1);

  const finishSplash = React.useCallback(
    (durationMs: number) => {
      if (finishScheduledRef.current) return;
      finishScheduledRef.current = true;
      cancelAnimation(breath);
      const duration = Math.max(0, durationMs);
      const done = () => {
        setShowSplash(false);
        onComplete?.();
      };
      if (duration === 0) {
        logoOpacity.value = 0;
        done();
        return;
      }
      logoOpacity.value = withTiming(0, { duration, easing: Easing.out(Easing.cubic) }, (finished) => {
        if (finished) runOnJS(done)();
      });
    },
    [breath, logoOpacity, onComplete],
  );

  useEffect(() => {
    if (overlayMode) {
      finishSplash(SPLASH_FADE_DURATION_MS);
      return;
    }

    const now = Date.now();
    const elapsedMs = now - startedAtRef.current;
    if (hasContentReady) {
      finishSplash(0);
      return;
    }

    // Не держим экран бесконечно при ошибке диска/сети. Fliq здесь намеренно
    // не учитывается: он прогревается в фоне и не задерживает видимый Search.
    const remainingHardStopMs = Math.max(0, MAX_SPLASH_DURATION_MS - elapsedMs);
    const hardStopTimer = setTimeout(() => {
      finishSplash(0);
    }, remainingHardStopMs);
    return () => clearTimeout(hardStopTimer);
  }, [finishSplash, hasContentReady, overlayMode]);

  useEffect(() => {
    breath.value = withRepeat(
      withTiming(1, { duration: BREATH_MS, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    return () => cancelAnimation(breath);
  }, [breath]);

  const logoStyle = useAnimatedStyle(() => {
    const t = breath.value;
    return {
      opacity: logoOpacity.value,
      transform: [
        { scale: 1 + 0.06 * t },
        { translateY: -12 * t },
        // Отрицательный угол: правый край (объектив) поднимается вверх.
        { rotate: `${-9 * t}deg` },
      ],
    };
  });

  if (!showSplash) {
    return null;
  }

  // Фон сплэша — welcome stage gradient; логотип камеры на полупрозрачном стекле.
  return (
    <View style={[styles.container, { backgroundColor: HOME_NAV_BG }]}>
      {/* Сцена Legendary: приглушённая бирюза у краёв → серый, как у окна MainActivity. */}
      <WelcomeStageBackground palette="tealDeep" />
      <View style={styles.middle}>
        <View style={styles.logoContainer}>
          <Animated.View style={[styles.logoWrapper, logoStyle]}>
            <ExpoImage
              source={SPLASH_ICON}
              style={[styles.logo, { width: logoSize, height: logoSize }]}
              contentFit="contain"
              // Не disk: в релизе ассет приходит как res:/<id>, expo-image не добавляет
              // к ключу версию приложения — после обновления Glide отдавал старую иконку.
              cachePolicy="memory"
              priority="high"
              recyclingKey="splash-camera"
            />
          </Animated.View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
  },
  middle: {
    flex: 1,
    flexShrink: 1,
    minHeight: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 1,
  },
  logoWrapper: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  logo: {
    width: 196,
    height: 196,
    borderRadius: 12,
    backgroundColor: 'transparent',
  },
});
