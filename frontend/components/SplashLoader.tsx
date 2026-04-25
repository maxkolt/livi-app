// components/SplashLoader.tsx
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  Animated,
  Easing,
  Dimensions,
  Image,
  Platform,
  Text,
  TouchableOpacity,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from '../theme/ThemeProvider';
import { useLang } from '../store/lang';
import { t } from '../utils/i18n';
import { getPrivacyPolicyUrl } from '../utils/privacyPolicyUrl';

const { width, height } = Dimensions.get('window');
const MIN_SPLASH_DURATION_MS = 3000;
const SPLASH_FADE_DURATION_MS = 620;

interface SplashLoaderProps {
  dataLoaded: boolean;
  onComplete?: () => void;
  // Устаревшие флаги полноты профиля. Оставлены для совместимости с текущими вызовами,
  // но больше не блокируют скрытие сплеша: новый пользователь может не иметь ни ника, ни аватара.
  hasNick?: boolean;
  hasAvatar?: boolean;
  /** На Android: true когда аватар разрешён (data: -> file:) или аватара нет. Не скрываем сплеш пока false — избегаем мерцания и ошибки Glide. */
  hasAvatarReady?: boolean;
  /** Режим оверлея: Home уже отрисован под сплешем, ждать минимум не нужно — только плавно скрыть сплеш. */
  overlayMode?: boolean;
}

export default function SplashLoader({ dataLoaded, onComplete, hasNick, hasAvatar, hasAvatarReady, overlayMode }: SplashLoaderProps) {
  const [showSplash, setShowSplash] = useState(true);
  const { theme } = useAppTheme();
  const lang = useLang((s) => s.lang);
  const insets = useSafeAreaInsets();
  const startedAtRef = useRef(Date.now());
  const finishScheduledRef = useRef(false);

  // Анимации для логотипа
  const logoScale = useRef(new Animated.Value(1)).current;
  const logoOpacity = useRef(new Animated.Value(1)).current;
  const logoTranslateY = useRef(new Animated.Value(0)).current;
  const logoRotate = useRef(new Animated.Value(0)).current;
  
  // Анимации для тени
  const shadowScale = useRef(new Animated.Value(1)).current;
  const shadowOpacity = useRef(new Animated.Value(0.3)).current;
  

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

  // Ждём сервер только до общего дедлайна 2.5с. Fade должен уложиться в это же окно.
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

  // Анимация 3D парения логотипа
  useEffect(() => {
    const logoFloat3D = Animated.loop(
      Animated.sequence([
        // Поднимается вверх с 3D эффектом
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
          Animated.timing(shadowScale, {
            toValue: 0.7,
            duration: 2000,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(shadowOpacity, {
            toValue: 0.05,
            duration: 2000,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
        // Опускается вниз с обратным эффектом
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
          Animated.timing(shadowScale, {
            toValue: 1.3,
            duration: 2000,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(shadowOpacity, {
            toValue: 0.25,
            duration: 2000,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
      ])
    );
    logoFloat3D.start();
  }, []);


  if (!showSplash) {
    return null;
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.middle}>
      {/* Логотип с тенью */}
      <View style={styles.logoContainer}>
        {/* Дополнительная мягкая тень для реалистичности */}
        <Animated.View
          style={[
            styles.logoShadowSoft,
            {
              transform: [
                { scale: shadowScale },
                { translateY: 15 },
              ],
              opacity: shadowOpacity,
            },
          ]}
        />
        
        {/* Основная тень под логотипом */}
        <Animated.View
          style={[
            styles.logoShadow,
            {
              transform: [
                { scale: shadowScale },
                { translateY: 8 },
              ],
              opacity: shadowOpacity,
            },
          ]}
        />
        
        {/* Основной логотип */}
        <Animated.View
          style={[
            styles.logoWrapper,
            {
              transform: [
                { scale: logoScale },
                { translateY: logoTranslateY },
                { rotate: logoRotate.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0deg', '5deg'],
                }) },
              ],
              opacity: logoOpacity,
            },
          ]}
        >
          <Image
            source={require('../assets/adaptive-icon.png')}
            style={styles.logo}
            resizeMode="contain"
          />
        </Animated.View>
      </View>
      </View>

      <TouchableOpacity
        onPress={() => Linking.openURL(getPrivacyPolicyUrl()).catch(() => {})}
        activeOpacity={0.65}
        style={[
          styles.privacyWrap,
          { paddingBottom: Math.max(insets.bottom, 10) + 8 },
        ]}
        accessibilityRole="link"
        accessibilityLabel={t('privacyPolicyLink', lang)}
      >
        <Text
          style={[styles.privacyText, { color: theme.colors.titan }]}
          numberOfLines={2}
        >
          {t('privacyPolicyLink', lang)}
        </Text>
      </TouchableOpacity>
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
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  privacyWrap: {
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  privacyText: {
    fontSize: 11,
    lineHeight: 15,
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
  logoWrapper: {
    justifyContent: 'center',
    alignItems: 'center',
    // iOS тень - реалистичная тень для парения
    ...(Platform.OS === 'ios' && {
      shadowColor: 'rgba(0, 0, 0, 0.4)',
      shadowOffset: {
        width: 0,
        height: 12,
      },
      shadowOpacity: 0.6,
      shadowRadius: 20,
    }),
    // Android тень - реалистичная тень для парения
    ...(Platform.OS === 'android' && {
      elevation: 20,
      shadowColor: 'rgba(0, 0, 0, 0.4)',
      shadowOffset: {
        width: 0,
        height: 12,
      },
      shadowOpacity: 0.6,
      shadowRadius: 20,
    }),
  },
  logoShadowSoft: {
    position: 'absolute',
    width: 200,
    height: 200,
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
    borderRadius: 30,
    top: 25,
    left: -25,
    // iOS тень - очень мягкая тень для реалистичности
    ...(Platform.OS === 'ios' && {
      shadowColor: 'rgba(0, 0, 0, 0.1)',
      shadowOffset: {
        width: 0,
        height: 12,
      },
      shadowOpacity: 0.2,
      shadowRadius: 25,
    }),
    // Android тень - очень мягкая тень для реалистичности
    ...(Platform.OS === 'android' && {
      elevation: 5,
      shadowColor: 'rgba(0, 0, 0, 0.1)',
      shadowOffset: {
        width: 0,
        height: 12,
      },
      shadowOpacity: 0.2,
      shadowRadius: 25,
    }),
  },
  logoShadow: {
    position: 'absolute',
    width: 180,
    height: 180,
    backgroundColor: 'rgba(0, 0, 0, 0.1)',
    borderRadius: 20,
    top: 15,
    left: -15,
    // iOS тень - мягкая тень под логотипом
    ...(Platform.OS === 'ios' && {
      shadowColor: 'rgba(0, 0, 0, 0.2)',
      shadowOffset: {
        width: 0,
        height: 8,
      },
      shadowOpacity: 0.3,
      shadowRadius: 15,
    }),
    // Android тень - мягкая тень под логотипом
    ...(Platform.OS === 'android' && {
      elevation: 8,
      shadowColor: 'rgba(0, 0, 0, 0.2)',
      shadowOffset: {
        width: 0,
        height: 8,
      },
      shadowOpacity: 0.3,
      shadowRadius: 15,
    }),
  },
  logo: {
    width: 150,
    height: 150,
    borderRadius: 12,
    backgroundColor: 'transparent',
    // Убираем тени с самого логотипа - они создают артефакты
    // Тень будет только от logoWrapper
  },
});







