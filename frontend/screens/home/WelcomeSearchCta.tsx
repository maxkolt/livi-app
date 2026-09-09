import React, { useCallback, useRef } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  SEARCH_CTA_MAX_WIDTH,
  SEARCH_CTA_TABLET_MAX_WIDTH,
  SEARCH_CTA_TABLET_MIN_WIDTH,
  WELCOME_HEADER_TITLE,
} from './constants';
import { logger } from '../../utils/logger';

const BORDER_W = 1.35;
/** Темнее/приглушённее aura — только рамка CTA, без смены глобального градиента. */
const CTA_BORDER_GRADIENT = ['#0b7f74', '#255db8', '#007fbc'] as const;

type WelcomeSearchCtaProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  onDisabledPress?: () => void;
  compact?: boolean;
  style?: ViewStyle;
};

export function WelcomeSearchCta({
  label,
  onPress,
  disabled = false,
  onDisabledPress,
  compact = false,
  style,
}: WelcomeSearchCtaProps) {
  const { width: windowWidth } = useWindowDimensions();
  const sideInset = 44;
  const maxCtaWidth =
    windowWidth >= SEARCH_CTA_TABLET_MIN_WIDTH ? SEARCH_CTA_TABLET_MAX_WIDTH : SEARCH_CTA_MAX_WIDTH;
  const buttonWidth = Math.min(Math.max(0, windowWidth - sideInset * 2), maxCtaWidth);
  const buttonHeight = compact ? (Platform.OS === 'ios' ? 52 : 48) : Platform.OS === 'ios' ? 58 : 54;
  const borderRadius = buttonHeight / 2;
  const innerRadius = Math.max(0, borderRadius - BORDER_W);
  const blockedFlash = useRef(new Animated.Value(0)).current;
  const blockedShake = useRef(new Animated.Value(0)).current;
  const pressScale = useRef(new Animated.Value(1)).current;
  const pressDepth = useRef(new Animated.Value(0)).current;
  const pressArmed = useRef(false);

  const triggerBlocked = useCallback(() => {
    blockedFlash.setValue(0);
    blockedShake.setValue(0);
    Animated.sequence([
      Animated.parallel([
        Animated.timing(blockedFlash, { toValue: 1, duration: 120, useNativeDriver: true }),
        Animated.sequence([
          Animated.timing(blockedShake, { toValue: 3, duration: 55, useNativeDriver: true }),
          Animated.timing(blockedShake, { toValue: -3, duration: 60, useNativeDriver: true }),
          Animated.timing(blockedShake, { toValue: 0, duration: 55, useNativeDriver: true }),
        ]),
      ]),
      Animated.timing(blockedFlash, { toValue: 0, duration: 240, useNativeDriver: true }),
    ]).start();
    onDisabledPress?.();
  }, [blockedFlash, blockedShake, onDisabledPress]);

  const animatePressIn = useCallback(() => {
    Animated.parallel([
      Animated.spring(pressScale, {
        toValue: 0.965,
        friction: 6,
        tension: 220,
        useNativeDriver: true,
      }),
      Animated.timing(pressDepth, {
        toValue: 1,
        duration: 90,
        useNativeDriver: true,
      }),
    ]).start();
  }, [pressDepth, pressScale]);

  const animatePressOut = useCallback(() => {
    Animated.parallel([
      Animated.spring(pressScale, {
        toValue: 1,
        friction: 5,
        tension: 160,
        useNativeDriver: true,
      }),
      Animated.timing(pressDepth, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [pressDepth, pressScale]);

  const firePress = useCallback(() => {
    if (disabled) {
      triggerBlocked();
      return;
    }
    if (pressArmed.current) return;
    pressArmed.current = true;
    const t0 = Date.now();
    try {
      const g = global as any;
      g.__searchNavT0 = t0;
      g.__searchNavSteps = [{ step: 'cta.firePress', at: t0, elapsedMs: 0 }];
      // Только первый focus/onStateChange после CTA — иначе поздние remount/focus шумят (200–1100ms).
      g.__searchNavFocusLogged = false;
      g.__searchNavStateChangeLogged = false;
    } catch {}
    logger.info('[search-nav] cta.firePress', { t0 });
    onPress();
  }, [disabled, onPress, triggerBlocked]);

  const handlePressIn = useCallback(() => {
    if (!disabled) animatePressIn();
    firePress();
  }, [animatePressIn, disabled, firePress]);

  const handlePressOut = useCallback(() => {
    animatePressOut();
    // Не сбрасывать armed синхронно в pressOut: иначе onPress после onPressIn
    // снова вызовет navigate и перезапустит переход.
    setTimeout(() => {
      pressArmed.current = false;
    }, 0);
  }, [animatePressOut]);

  const depthOpacity = pressDepth.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.18],
  });
  const sheenOpacity = pressDepth.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.14],
  });

  return (
    <Animated.View
      style={[
        {
          width: buttonWidth,
          transform: [{ translateX: blockedShake }, { scale: pressScale }],
        },
        style,
      ]}
    >
      <Pressable
        onPress={firePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={false}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        style={[styles.shadow, disabled ? { opacity: 0.45 } : null]}
      >
        <LinearGradient
          colors={[CTA_BORDER_GRADIENT[0], CTA_BORDER_GRADIENT[1], CTA_BORDER_GRADIENT[2]]}
          start={{ x: 0, y: 0.35 }}
          end={{ x: 1, y: 0.65 }}
          style={[
            styles.borderShell,
            {
              borderRadius,
              padding: BORDER_W,
              width: buttonWidth,
              height: buttonHeight,
            },
          ]}
        >
          <View
            style={[
              styles.inner,
              {
                height: buttonHeight - BORDER_W * 2,
                borderRadius: innerRadius,
                backgroundColor: 'rgba(5, 7, 13, 0.68)',
              },
            ]}
          >
            <MaterialCommunityIcons
              name="lightning-bolt"
              size={compact ? 20 : 22}
              color={WELCOME_HEADER_TITLE}
            />
            <Text style={[styles.label, compact && styles.labelCompact]} allowFontScaling={false}>
              {label}
            </Text>
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFillObject,
                {
                  borderRadius: innerRadius,
                  backgroundColor: '#000',
                  opacity: depthOpacity,
                },
              ]}
            />
            <Animated.View
              pointerEvents="none"
              style={[
                styles.sheen,
                {
                  borderRadius: innerRadius,
                  opacity: sheenOpacity,
                },
              ]}
            />
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFillObject,
                {
                  borderRadius: innerRadius,
                  backgroundColor: 'rgba(255,90,103,0.4)',
                  opacity: blockedFlash,
                },
              ]}
            />
          </View>
        </LinearGradient>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  shadow: {
    shadowColor: CTA_BORDER_GRADIENT[1],
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 14,
    elevation: 6,
    overflow: 'visible',
  },
  borderShell: {
    overflow: 'hidden',
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 24,
    overflow: 'hidden',
  },
  sheen: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.55)',
    // верхняя «бликовая» полоса при нажатии
    height: '45%',
  },
  label: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 17,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
  labelCompact: {
    fontSize: 15,
  },
});
