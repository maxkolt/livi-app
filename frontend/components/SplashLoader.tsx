// components/SplashLoader.tsx
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  Animated,
  Easing,
  Image,
  useWindowDimensions,
} from 'react-native';
import { useAppTheme } from '../theme/ThemeProvider';
import { WelcomeStageBackground } from '../screens/home/WelcomeStageBackground';
import { WELCOME_STAGE_BG } from '../screens/home/constants';

const MIN_SPLASH_DURATION_MS = 3000;
const SPLASH_FADE_DURATION_MS = 620;

interface SplashLoaderProps {
  dataLoaded: boolean;
  onComplete?: () => void;
  hasNick?: boolean;
  hasAvatar?: boolean;
  hasAvatarReady?: boolean;
  overlayMode?: boolean;
}

export default function SplashLoader({ dataLoaded, onComplete, overlayMode }: SplashLoaderProps) {
  const [showSplash, setShowSplash] = useState(true);
  const { theme, isDark } = useAppTheme();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const logoSize = Math.min(150, Math.max(96, Math.round(Math.min(windowHeight * 0.2, windowWidth * 0.36))));
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

    if (dataLoaded) {
      if (remainingTotalMs > SPLASH_FADE_DURATION_MS) {
        const fadeTimer = setTimeout(() => {
          finishSplash(SPLASH_FADE_DURATION_MS);
        }, remainingTotalMs - SPLASH_FADE_DURATION_MS);
        return () => clearTimeout(fadeTimer);
      }

      finishSplash(remainingTotalMs);
      return;
    }

    const hardStopTimer = setTimeout(() => {
      finishSplash(0);
    }, remainingTotalMs);
    return () => clearTimeout(hardStopTimer);
  }, [dataLoaded, finishSplash, overlayMode]);

  useEffect(() => {
    const logoFloat3D = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(logoTranslateY, {
            toValue: -15,
            duration: 2000,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(logoScale, {
            toValue: 1.08,
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

  // Фон сплэша — welcome stage gradient; иконка сразу на прежнем тоне (#151F33).
  return (
    <View style={[styles.container, { backgroundColor: isDark ? WELCOME_STAGE_BG : (theme.colors.background as string) }]}>
      <WelcomeStageBackground
        isDark={!!isDark}
        lightColor={(theme.colors.background as string) || WELCOME_STAGE_BG}
      />
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
                    rotate: logoRotate.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0deg', '5deg'],
                    }),
                  },
                ],
                opacity: logoOpacity,
              },
            ]}
          >
            <Image
              source={require('../assets/adaptive-icon.png')}
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
