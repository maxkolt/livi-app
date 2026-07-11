import React, { useCallback, useRef, useState } from 'react';
import { Animated, Text } from 'react-native';
import { useAppTheme } from '../../../theme/ThemeProvider';
import { uiAccent } from '../../../theme/uiAccent';
import { LIVI } from '../constants';
import { styles } from '../styles';

export type NoticeKind = 'info' | 'success' | 'error';

export function useLiviNotice() {
  const [notice, setNotice] = useState<{ text: string; kind: NoticeKind } | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isDark } = useAppTheme();
  const accent = uiAccent(isDark);

  const hide = useCallback(() => {
    Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => setNotice(null));
  }, [opacity]);

  const show = useCallback((text: string, kind: NoticeKind = 'info', ms = 3000) => {
    if (!text) return;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setNotice({ text, kind });
    Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }).start(() => {
      if (ms > 0) timerRef.current = setTimeout(hide, ms);
    });
  }, [hide, opacity]);

  const noticeSurface =
    notice?.kind === 'success'
      ? { backgroundColor: 'rgba(34, 197, 94, 0.22)', borderColor: 'rgba(22, 163, 74, 0.9)' }
      : notice?.kind === 'error'
        ? { backgroundColor: 'rgba(255, 90, 103, 0.2)', borderColor: 'rgba(200, 50, 65, 0.85)' }
        : {
            borderColor: accent.solid,
            backgroundColor: isDark ? accent.solid15 : accent.solid28,
          };
  const view = notice ? (
    <Animated.View
      style={[
        styles.notice,
        {
          opacity,
          ...noticeSurface,
        },
      ]}
    >
      <Text style={[styles.noticeText, { color: isDark ? LIVI.text2 : LIVI.textThemeWhite }]}>{notice.text}</Text>
    </Animated.View>
  ) : null;

  return { showNotice: show, hideNotice: hide, NoticeView: view };
}
