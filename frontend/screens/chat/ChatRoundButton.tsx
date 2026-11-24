/** Круглая кнопка chrome чата — одна и та же в композере и в шапке. */

import React from "react";
import { Animated, Pressable, StyleSheet, type Insets } from "react-native";
import { HOME_NAV_BG } from "../home/constants";

export const CHAT_ROUND_BUTTON_SIZE = 36;

/**
 * Сплошная заливка кругов: не просвечивает поверх динамического glass-фона.
 * Тёмная тема — основной фон (HOME_NAV_BG), круги утоплены в бирюзовое стекло.
 */
export function chatRoundButtonColors(isDark: boolean) {
  return {
    idle: isDark ? HOME_NAV_BG : "#D9DDE3",
    pressed: isDark ? "#323A46" : "#C9CED6",
  };
}

export function ChatRoundButton({
  onPress,
  disabled = false,
  hitSlop,
  accessibilityLabel,
  testID,
  backgroundColor,
  pressedBackgroundColor,
  marginRight = 0,
  children,
}: {
  onPress: () => void;
  disabled?: boolean;
  hitSlop?: number | Insets;
  accessibilityLabel: string;
  testID?: string;
  backgroundColor: string;
  pressedBackgroundColor: string;
  marginRight?: number;
  children: React.ReactNode;
}) {
  // 0 — покой, 1 — нажата. Сжатие и плотный оттенок идут нативным драйвером:
  // кнопка отпускается сразу, даже пока JS собирает открываемую панель.
  const press = React.useRef(new Animated.Value(0)).current;
  const frameIdRef = React.useRef<number | null>(null);
  const disabledRef = React.useRef(disabled);
  disabledRef.current = disabled;
  const animatePress = React.useCallback(
    (toValue: number) => {
      Animated.spring(press, {
        toValue,
        speed: 42,
        bounciness: 0,
        useNativeDriver: true,
      }).start();
    },
    [press],
  );
  const handlePress = React.useCallback(() => {
    if (disabled) return;
    animatePress(0);
    // Тяжёлый ре-рендер — со следующего кадра, когда отпускание уже ушло в нативный поток.
    if (frameIdRef.current !== null) cancelAnimationFrame(frameIdRef.current);
    frameIdRef.current = requestAnimationFrame(() => {
      frameIdRef.current = null;
      if (!disabledRef.current) onPress();
    });
  }, [animatePress, onPress, disabled]);
  React.useEffect(() => {
    if (disabled) {
      press.stopAnimation();
      press.setValue(0);
    }
    return () => {
      press.stopAnimation();
      if (frameIdRef.current !== null) cancelAnimationFrame(frameIdRef.current);
      frameIdRef.current = null;
    };
  }, [disabled, press]);

  const radius = CHAT_ROUND_BUTTON_SIZE / 2;
  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPressIn={() => animatePress(1)}
      onPressOut={() => animatePress(0)}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={{
        width: CHAT_ROUND_BUTTON_SIZE,
        height: CHAT_ROUND_BUTTON_SIZE,
        borderRadius: radius,
        marginRight,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={{
          flex: 1,
          borderRadius: radius,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor,
          transform: [
            { scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.91] }) },
          ],
        }}
      >
        <Animated.View
          pointerEvents="none"
          style={{
            ...StyleSheet.absoluteFillObject,
            borderRadius: radius,
            backgroundColor: pressedBackgroundColor,
            opacity: press,
          }}
        />
        {children}
      </Animated.View>
    </Pressable>
  );
}
