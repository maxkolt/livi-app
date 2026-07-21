import { useCallback, useRef, useState } from 'react';
import { Animated } from 'react-native';

export function useRandomChatToast() {
  const [toastText, setToastText] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  /** true — тосты про нарушения правил / модерацию (шрифт 400); иначе обычный стиль */
  const [toastModerationStyle, setToastModerationStyle] = useState(false);
  const toastOpacity = useRef(new Animated.Value(0)).current;

  // Функция показа toast уведомлений (moderationStyle — нарушения правил / бан / предупреждение партнёру)
  const showToast = useCallback((text: string, ms = 1700, moderationStyle = false) => {
    if (!text || text.toLowerCase() === 'self') return; // скрываем отладочный тост
    setToastModerationStyle(!!moderationStyle);
    setToastText(text);
    setToastVisible(true);
    Animated.timing(toastOpacity, { toValue: 1, duration: 160, useNativeDriver: true }).start(() => {
      const t = setTimeout(() => {
        Animated.timing(toastOpacity, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => {
          setToastVisible(false);
          setToastText('');
          setToastModerationStyle(false);
        });
        clearTimeout(t);
      }, ms);
    });
  }, [toastOpacity]);

  return { toastVisible, toastText, toastModerationStyle, toastOpacity, showToast };
}
