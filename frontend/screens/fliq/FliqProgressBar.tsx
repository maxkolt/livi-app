// Полоса прогресса ролика Fliq под карточкой. Элементы плеера YouTube выключены
// (controls=0), поэтому полоса своя — одинаковая у всех роликов и не поверх плеера.
import React, { useCallback, useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { UI_ACCENT } from '../home/constants';

/** Полоса чуть уже карточки — отступ от скруглённых углов. */
const SIDE_PAD = 6;

/**
 * Прогресс из тиков плеера (раз в секунду): между тиками полоса едет линейно до следующего,
 * на паузе встаёт, на новом круге ролика — в начало.
 */
export function useFliqProgress(playing: boolean) {
  const progress = useRef(new Animated.Value(0)).current;
  const onTick = useCallback(
    (cur: number, dur: number) => {
      if (!(dur > 0)) return;
      progress.stopAnimation();
      progress.setValue(Math.min(1, cur / dur));
      Animated.timing(progress, {
        toValue: Math.min(1, (cur + 1) / dur),
        duration: 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }).start();
    },
    [progress],
  );
  const reset = useCallback(() => {
    progress.stopAnimation();
    progress.setValue(0);
  }, [progress]);
  useEffect(() => {
    if (!playing) progress.stopAnimation();
  }, [playing, progress]);
  return { progress, onTick, reset };
}

export function FliqProgressBar({ progress, width }: { progress: Animated.Value; width: number }) {
  const trackW = Math.max(0, width - SIDE_PAD * 2);
  return (
    <View style={[styles.wrap, { width }]}>
      <View style={[styles.track, { width: trackW }]}>
        {/* scaleX от левого края: сдвиг на половину недостающей ширины. */}
        <Animated.View
          style={[
            styles.fill,
            {
              width: trackW,
              transform: [
                { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [-trackW / 2, 0] }) },
                { scaleX: progress },
              ],
            },
          ]}
        />
      </View>
    </View>
  );
}

/** Высота строки с полосой — зазор между карточкой и панелью. */
export const FLIQ_PROGRESS_ROW_H = 8;

const styles = StyleSheet.create({
  wrap: { height: FLIQ_PROGRESS_ROW_H, justifyContent: 'center', alignItems: 'center' },
  track: {
    height: 3,
    borderRadius: 1.5,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.10)',
  },
  fill: { height: 3, backgroundColor: UI_ACCENT },
});
