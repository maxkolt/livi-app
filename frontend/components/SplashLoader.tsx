// components/SplashLoader.tsx
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  Animated,
  Easing,
  Image,
} from 'react-native';
import { useSafeAreaFrame } from 'react-native-safe-area-context';
import { WelcomeStageBackground } from '../screens/home/WelcomeStageBackground';
import { WELCOME_STAGE_BG } from '../screens/home/constants';

const MIN_SPLASH_DURATION_MS = 3000;
const SPLASH_FADE_DURATION_MS = 620;
/** Даём аватару resolve+prefetch; раньше 5с hard-stop часто обгонял готовность. */
const MAX_SPLASH_DURATION_MS = 9000;

interface SplashLoaderProps {
  dataLoaded: boolean;
  onComplete?: () => void;
  hasNick?: boolean;
  hasAvatar?: boolean;
  hasAvatarReady?: boolean;
  overlayMode?: boolean;
}

export default function SplashLoader({
  dataLoaded,
  hasAvatarReady = true,
  onComplete,
  overlayMode,
}: SplashLoaderProps) {
  const [showSplash, setShowSplash] = useState(true);
  const { height: windowHeight, width: windowWidth } = useSafeAreaFrame();
  const logoSize = Math.min(168, Math.max(112, Math.round(Math.min(windowHeight * 0.22, windowWidth * 0.40))));
  const startedAtRef = useRef(Date.now());
  const finishScheduledRef = useRef(false);

  const logoScale = useRef(new Animated.Value(1)).current;
  const logoOpacity = useRef(new Animated.Value(1)).current;
  const logoTranslateY = useRef(new Animated.Value(0)).current;
  const logoRotate = useRef(new Animated.Value(0)).current;

  const finishSplash = React.useCallback((durationMs: number) => {
    if (finishScheduledRef.current) return;
    finishScheduledRef.current = true;
    const duration = Math.max(0, durationMs);
    if (duration === 0) {
      logoOpacity.setValue(0);
      setShowSplash(false);
      onComplete?.();
      return;
    }
    Animated.timing(logoOpacity, {
      toValue: 0,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      setShowSplash(false);
      onComplete?.();
    });
  }, [logoOpacity, onComplete]);

  useEffect(() => {
    if (overlayMode) {
      finishSplash(SPLASH_FADE_DURATION_MS);
      return;
    }

    const now = Date.now();
    const elapsedMs = now - startedAtRef.current;
    const remainingTotalMs = Math.max(0, MIN_SPLASH_DURATION_MS - elapsedMs);

    if (dataLoaded && hasAvatarReady) {
      if (remainingTotalMs > SPLASH_FADE_DURATION_MS) {
        const fadeTimer = setTimeout(() => {
          finishSplash(SPLASH_FADE_DURATION_MS);
        }, remainingTotalMs - SPLASH_FADE_DURATION_MS);
        return () => clearTimeout(fadeTimer);
      }

      finishSplash(remainingTotalMs);
      return;
    }

    // Не держим экран бесконечно при ошибке диска/кэша, но даём аватару
    // закончить data: → file: преобразование до ухода заставки.
    const remainingHardStopMs = Math.max(
      0,
      MAX_SPLASH_DURATION_MS - elapsedMs,
    );
    const hardStopTimer = setTimeout(() => {
      finishSplash(0);
    }, remainingHardStopMs);
    return () => clearTimeout(hardStopTimer);
  }, [dataLoaded, finishSplash, hasAvatarReady, overlayMode]);

  useEffect(() => {
    // «Дыхание»: камера чуть поднимается, объектив (справа) приподнимается вверх под углом.
    const logoFloat3D = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(logoTranslateY, {
            toValue: -12,
            duration: 2000,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(logoScale, {
            toValue: 1.06,
            duration: 2000,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(logoRotate, {
            toValue: 1,
            duration: 2000,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(logoTranslateY, {
            toValue: 0,
            duration: 2000,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(logoScale, {
            toValue: 1,
            duration: 2000,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(logoRotate, {
            toValue: 0,
            duration: 2000,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
      ]),
    );
    logoFloat3D.start();
    return () => logoFloat3D.stop();
  }, [logoRotate, logoScale, logoTranslateY]);

  if (!showSplash) {
    return null;
  }

  // Фон сплэша — welcome stage gradient; логотип камеры на полупрозрачном стекле.
  return (
    <View style={[styles.container, { backgroundColor: WELCOME_STAGE_BG }]}>
      <WelcomeStageBackground />
      <View style={styles.middle}>
        <View style={styles.logoContainer}>
          <Animated.View
            style={[
              styles.logoWrapper,
              {
                transform: [
                  { scale: logoScale },
                  { translateY: logoTranslateY },
                  {
                    // Отрицательный угол: правый край (объектив) поднимается вверх
                    rotate: logoRotate.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0deg', '-9deg'],
                    }),
                  },
                ],
                opacity: logoOpacity,
              },
            ]}
          >
            <Image
              source={require('../assets/splash-icon.png')}
              style={[styles.logo, { width: logoSize, height: logoSize }]}
              resizeMode="contain"
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
    width: 150,
    height: 150,
    borderRadius: 12,
    backgroundColor: 'transparent',
  },
});
