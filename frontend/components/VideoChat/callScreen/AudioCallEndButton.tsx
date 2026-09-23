/**
 * Кнопка «Завершить» на аудио-экране звонка.
 *
 * Поведение при нажатии повторяет нативные Incoming/OutgoingCallActivity
 * (`installPressFeedback` + `btn_decline_round`), чтобы экран звонка на Android
 * не отличался от системного.
 *
 * ВНИМАНИЕ: на момент выноса из VideoCall.tsx компонент нигде не использовался —
 * он был объявлен и забыт. Сохранён как есть, чтобы не терять готовую вёрстку;
 * если он не нужен — файл можно удалить целиком.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { styles } from './videoCallStyles';

/** Как `installPressFeedback` + `btn_decline_round` на Incoming/OutgoingCallActivity. */
const AUDIO_CALL_DECLINE_ICON = '#C45A6E';
const AUDIO_CALL_DECLINE_ICON_PRESSED = '#E08A9A';

export function AudioCallEndButton({ onPress }: { onPress: () => void }) {
  const scale = useRef(new Animated.Value(1)).current;
  const alpha = useRef(new Animated.Value(1)).current;
  const [surfacePressed, setSurfacePressed] = useState(false);

  const runPressAnim = useCallback(
    (pressed: boolean) => {
      setSurfacePressed(pressed);
      Animated.parallel([
        Animated.timing(scale, {
          toValue: pressed ? 0.86 : 1,
          duration: pressed ? 90 : 140,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(alpha, {
          toValue: pressed ? 0.78 : 1,
          duration: pressed ? 90 : 140,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]).start();
    },
    [alpha, scale],
  );

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => runPressAnim(true)}
      onPressOut={() => runPressAnim(false)}
    >
      <Animated.View
        style={[
          styles.audioRoundBtn,
          styles.audioRoundBtnDanger,
          surfacePressed && styles.audioRoundBtnDangerPressed,
          { transform: [{ scale }], opacity: alpha },
        ]}
      >
        <MaterialIcons
          name="call-end"
          size={28}
          color={surfacePressed ? AUDIO_CALL_DECLINE_ICON_PRESSED : AUDIO_CALL_DECLINE_ICON}
        />
      </Animated.View>
    </Pressable>
  );
}
