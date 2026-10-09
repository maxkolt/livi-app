/**
 * Подсказка над кнопкой записи, пока её держат (как в Telegram): замок и стрелка вверх —
 * потяни, и запись пойдёт без пальца. Капсула едет вверх вслед за пальцем.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { UI_RIM, UI_SURFACE_RAISED, WELCOME_HEADER_TITLE } from '../home/constants';

export function RecordLockHint({
  visible,
  lockDrag,
  right,
  bottom,
}: {
  visible: boolean;
  /** 0..1 — насколько палец дотянул до замка. */
  lockDrag: Animated.Value;
  right: number;
  bottom: number;
}) {
  const bob = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { toValue: 1, duration: 520, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: 520, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [visible, bob]);

  if (!visible) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.pill,
        {
          right,
          bottom,
          transform: [{ translateY: lockDrag.interpolate({ inputRange: [0, 1], outputRange: [0, -28] }) }],
        },
      ]}
    >
      <Ionicons name="lock-closed-outline" size={18} color={WELCOME_HEADER_TITLE} />
      <Animated.View
        style={{
          transform: [{ translateY: bob.interpolate({ inputRange: [0, 1], outputRange: [3, -3] }) }],
          opacity: lockDrag.interpolate({ inputRange: [0, 1], outputRange: [0.85, 0.2] }),
        }}
      >
        <Ionicons name="chevron-up" size={18} color={WELCOME_HEADER_TITLE} />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    width: 40,
    paddingVertical: 10,
    borderRadius: 20,
    alignItems: 'center',
    gap: 6,
    backgroundColor: UI_SURFACE_RAISED,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_RIM,
    zIndex: 25,
    elevation: 25,
  },
});
