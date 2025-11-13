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
} from 'react-native';
import { BlurView } from 'expo-blur';
import { useAppTheme } from '../theme/ThemeProvider';

const { width, height } = Dimensions.get('window');

interface SplashLoaderProps {
  dataLoaded: boolean;
  onComplete?: () => void;
  // Опциональные проверки реальных данных
  hasNick?: boolean;
  hasAvatar?: boolean;
}

export default function SplashLoader({ dataLoaded, onComplete, hasNick, hasAvatar }: SplashLoaderProps) {
  const [showSplash, setShowSplash] = useState(true);
  const [minTimeElapsed, setMinTimeElapsed] = useState(false);
  const { theme } = useAppTheme();

  // Анимации для логотипа
  const logoScale = useRef(new Animated.Value(1)).current;
  const logoOpacity = useRef(new Animated.Value(1)).current;
  const logoTranslateY = useRef(new Animated.Value(0)).current;
  const logoRotate = useRef(new Animated.Value(0)).current;
  
  // Анимации для тени
  const shadowScale = useRef(new Animated.Value(1)).current;
  const shadowOpacity = useRef(new Animated.Value(0.3)).current;
  

  // Минимальное время показа - 5 секунд
  useEffect(() => {
    const timer = setTimeout(() => {
      setMinTimeElapsed(true);
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  // Скрываем заглушку когда прошло минимум времени И данные загружены
  // Если переданы hasNick/hasAvatar - проверяем что данные реально есть
  useEffect(() => {
    // Если переданы проверки данных, используем их - хотя бы одно должно быть true
    const dataReady = (hasNick !== undefined || hasAvatar !== undefined)
      ? ((hasNick === true) || (hasAvatar === true)) // хотя бы одно должно быть true
      : true; // если проверки не переданы, используем старую логику
    
    if (minTimeElapsed && dataLoaded && dataReady) {
      // Плавное исчезновение
      Animated.timing(logoOpacity, {
        toValue: 0,
        duration: 500,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        setShowSplash(false);
        onComplete?.();
      });
    }
  }, [minTimeElapsed, dataLoaded, hasNick, hasAvatar]);

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
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
  },
  logoContainer: {
    justifyContent: 'center',
    alignItems: 'center',
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







