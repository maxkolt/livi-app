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
  hitSlop,
  accessibilityLabel,
  backgroundColor,
  pressedBackgroundColor,
  marginRight = 0,
  children,
}: {
  onPress: () => void;
  hitSlop?: number | Insets;
  accessibilityLabel: string;
  backgroundColor: string;
  pressedBackgroundColor: string;
  marginRight?: number;
  children: React.ReactNode;
}) {
  // 0 — покой, 1 — нажата. Сжатие и плотный оттенок идут нативным драйвером:
  // кнопка отпускается сразу, даже пока JS собирает открываемую панель.
  const press = React.useRef(new Animated.Value(0)).current;
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
    animatePress(0);
    // Тяжёлый ре-рендер — со следующего кадра, когда отпускание уже ушло в нативный поток.
    requestAnimationFrame(() => onPress());
  }, [animatePress, onPress]);

  const radius = CHAT_ROUND_BUTTON_SIZE / 2;
  return (
    <Pressable
      onPress={handlePress}
      onPressIn={() => animatePress(1)}
      onPressOut={() => animatePress(0)}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={{
        width: CHAT_ROUND_BUTTON_SIZE,
        height: CHAT_ROUND_BUTTON_SIZE,
        borderRadius: radius,
        marginRight,
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
