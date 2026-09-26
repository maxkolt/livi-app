import React, { useCallback, useRef } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { useHomeLayout } from './HomeLayoutContext';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  AURA_GRADIENT,
  SEARCH_CTA_MAX_WIDTH,
  SEARCH_CTA_TABLET_MAX_WIDTH,
  isWelcomeTabletLayout,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
} from './constants';
import FitText from '../../components/FitText';
import { logger } from '../../utils/logger';

const BORDER_W = 1;
/** Цвет волн/точек радара — приглушённо. */
const CTA_WAVE = AURA_GRADIENT[2];
const CTA_BORDER = 'rgba(0, 181, 255, 0.36)';
/** Фон в тон волны, лёгкий. */
const CTA_FILL = 'rgba(0, 181, 255, 0.08)';
/** Мягкое кольцо вокруг рамки. */
const CTA_BORDER_SOFT = 'rgba(0, 181, 255, 0.12)';

/**
 * Высота CTA. Вынесена отдельно, чтобы раскладка Search могла заранее
 * зарезервировать под кнопку ровно столько же, сколько она реально займёт.
 */
export function welcomeSearchCtaWidth(windowWidth: number, tabletLayout: boolean): number {
  const sideInset = 44;
  const maxCtaWidth = tabletLayout ? SEARCH_CTA_TABLET_MAX_WIDTH : SEARCH_CTA_MAX_WIDTH;
  return Math.min(Math.max(0, windowWidth - sideInset * 2), maxCtaWidth);
}

export function welcomeSearchCtaHeight(tabletLayout: boolean, compact: boolean): number {
  if (tabletLayout) return 54;
  if (compact) return Platform.OS === 'ios' ? 46 : 42;
  return Platform.OS === 'ios' ? 50 : 46;
}

type WelcomeSearchCtaProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  onDisabledPress?: () => void;
  compact?: boolean;
  /** Жёсткий потолок ширины: в две колонки кнопка равна ширине своей колонки. */
  maxWidth?: number;
  style?: ViewStyle;
};

export function WelcomeSearchCta({
  label,
  onPress,
  disabled = false,
  onDisabledPress,
  compact = false,
  maxWidth,
  style,
}: WelcomeSearchCtaProps) {
  // Размер берём из safe-area frame: он приходит от нативного провайдера и
  // обновляется при повороте, в отличие от Dimensions.
  const { width: windowWidth, height: windowHeight } = useHomeLayout();
  const tabletLayout = isWelcomeTabletLayout(windowWidth, windowHeight);
  const buttonWidth = Math.min(
    welcomeSearchCtaWidth(windowWidth, tabletLayout),
    maxWidth && maxWidth > 0 ? maxWidth : Number.POSITIVE_INFINITY,
  );
  const buttonHeight = welcomeSearchCtaHeight(tabletLayout, compact);
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
      // CTA is a foreground navigation action just like a chat/call row tap.
      // Let Home's delayed resume/badge work yield so the RandomChat screen can paint first.
      g.__homeRowActionAtRef = g.__homeRowActionAtRef || { current: 0 };
      g.__homeRowActionAtRef.current = t0;
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
        <View
          style={{
            width: buttonWidth,
            height: buttonHeight,
            borderRadius,
            overflow: 'visible',
          }}
        >
          {/* Мягкое свечение рамки (размытый край). */}
          <View
            pointerEvents="none"
            style={[
              styles.borderGlow,
              {
                borderRadius,
                shadowColor: CTA_WAVE,
              },
            ]}
          />
          <View
            style={[
              styles.borderShell,
              {
                borderRadius,
                width: buttonWidth,
                height: buttonHeight,
                borderWidth: BORDER_W,
                borderColor: CTA_BORDER,
                backgroundColor: CTA_FILL,
              },
            ]}
          >
            <View
              style={[
                styles.inner,
                {
                  height: buttonHeight - BORDER_W * 2,
                  borderRadius: innerRadius,
                },
              ]}
            >
              <MaterialCommunityIcons
                name="lightning-bolt"
                size={tabletLayout ? 24 : compact ? 20 : 22}
                color={WELCOME_MUTED_TEXT}
              />
              <FitText
                style={[
                  styles.label,
                  tabletLayout && styles.labelTablet,
                  compact && styles.labelCompact,
                ]}
                minimumFontScale={0.7}
              >
                {label}
              </FitText>
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
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  shadow: {
    shadowColor: CTA_WAVE,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 3,
    overflow: 'visible',
  },
  borderGlow: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 2,
    borderColor: CTA_BORDER_SOFT,
    // лёгкий bloom по периметру
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.32,
    shadowRadius: 5,
    elevation: 0,
  },
  borderShell: {
    overflow: 'hidden',
    justifyContent: 'center',
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
    overflow: 'hidden',
    minWidth: 0,
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
    fontWeight: '400',
    letterSpacing: 0.2,
    flexShrink: 1,
    minWidth: 0,
    textAlign: 'center',
  },
  labelCompact: {
    fontSize: 15,
  },
  labelTablet: {
    fontSize: 17,
  },
});
