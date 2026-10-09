// Полоса прогресса ролика Fliq под карточкой. Элементы плеера YouTube выключены
// (controls=0), поэтому полоса своя — одинаковая у всех роликов и не поверх плеера.
// Её можно тянуть пальцем или нажать в нужное место — ролик перематывается.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { UI_ACCENT } from '../home/constants';

/** Полоса чуть уже карточки — отступ от скруглённых углов. */
const SIDE_PAD = 6;
/** Пока палец едет, плеер перематываем не чаще этого — WebView не забиваем командами. */
const LIVE_SEEK_MS = 180;
/** Кружок на конце заполнения, пока тянут. */
const THUMB = 12;

export type FliqScrubber = {
  /** Длительность из тиков плеера; 0 — ещё не знаем, перематывать нечего. */
  duration: () => number;
  begin: () => void;
  move: (fraction: number) => void;
  end: () => void;
};

/**
 * Прогресс из тиков плеера (раз в секунду): между тиками полоса едет линейно до следующего,
 * на паузе встаёт, на новом круге ролика — в начало. Пока палец на полосе, тики её не двигают.
 */
export function useFliqProgress(playing: boolean) {
  const progress = useRef(new Animated.Value(0)).current;
  const durationRef = useRef(0);
  const scrubbingRef = useRef(false);
  const onTick = useCallback(
    (cur: number, dur: number) => {
      if (!(dur > 0)) return;
      durationRef.current = dur;
      if (scrubbingRef.current) return;
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
  const scrubber = useMemo<FliqScrubber>(
    () => ({
      duration: () => durationRef.current,
      begin: () => {
        scrubbingRef.current = true;
        progress.stopAnimation();
      },
      move: (fraction) => progress.setValue(fraction),
      end: () => {
        scrubbingRef.current = false;
      },
    }),
    [progress],
  );
  return { progress, onTick, reset, scrubber };
}

type Props = {
  progress: Animated.Value;
  width: number;
  scrubber?: FliqScrubber;
  onSeek?: (sec: number, final: boolean) => void;
  style?: StyleProp<ViewStyle>;
};

export function FliqProgressBar({ progress, width, scrubber, onSeek, style }: Props) {
  const trackW = Math.max(0, width - SIDE_PAD * 2);
  const [scrubbing, setScrubbing] = useState(false);
  const live = useRef({ trackW, scrubber, onSeek, lastSeekAt: 0, fraction: 0 });
  live.current.trackW = trackW;
  live.current.scrubber = scrubber;
  live.current.onSeek = onSeek;

  const gesture = useMemo(() => {
    /** x — от левого края строки полосы (она шире дорожки на SIDE_PAD с каждой стороны). */
    const seekAt = (x: number, final: boolean) => {
      const l = live.current;
      const dur = l.scrubber?.duration() ?? 0;
      if (!(dur > 0) || !(l.trackW > 0)) return;
      const fraction = Math.min(1, Math.max(0, (x - SIDE_PAD) / l.trackW));
      l.fraction = fraction;
      l.scrubber?.move(fraction);
      const now = Date.now();
      if (!final && now - l.lastSeekAt < LIVE_SEEK_MS) return;
      l.lastSeekAt = now;
      l.onSeek?.(fraction * dur, final);
    };
    const begin = () => {
      live.current.lastSeekAt = 0;
      live.current.scrubber?.begin();
    };
    const finish = () => {
      live.current.scrubber?.end();
      setScrubbing(false);
    };
    // Вертикальное движение отдаёт касание ленте — свайп к следующему ролику с полосы работает.
    const pan = Gesture.Pan()
      .runOnJS(true)
      .activeOffsetX([-6, 6])
      .failOffsetY([-12, 12])
      .onStart((e) => {
        setScrubbing(true);
        begin();
        seekAt(e.x, false);
      })
      .onUpdate((e) => seekAt(e.x, false))
      // Отпустил (или жест прервали) — последняя позиция с докачкой: после перемотки
      // без докачки плеер иначе встал бы на конце запаса.
      .onEnd(() => {
        const l = live.current;
        const dur = l.scrubber?.duration() ?? 0;
        if (dur > 0) l.onSeek?.(l.fraction * dur, true);
      })
      .onFinalize(finish);
    const tap = Gesture.Tap()
      .runOnJS(true)
      // Иначе быстрый свайп ленты, начатый на полосе, на отпускании ещё и перематывал бы.
      .maxDistance(10)
      .onEnd((e, success) => {
        if (!success) return;
        begin();
        seekAt(e.x, true);
        live.current.scrubber?.end();
      });
    return Gesture.Exclusive(pan, tap);
  }, []);

  return (
    <View style={[styles.wrap, { width }, style]}>
      <View pointerEvents="none" style={[styles.track, { width: trackW }, scrubbing && styles.trackActive]}>
        {/* scaleX от левого края: сдвиг на половину недостающей ширины. */}
        <Animated.View
          style={[
            styles.fill,
            scrubbing && styles.fillActive,
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
      {scrubbing ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.thumb,
            {
              left: SIDE_PAD - THUMB / 2,
              transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, trackW] }) }],
            },
          ]}
        />
      ) : null}
      {/* Зона касания выше и ниже тонкой полосы — по ней легко попасть пальцем. */}
      {scrubber && onSeek ? (
        <GestureDetector gesture={gesture}>
          <View collapsable={false} style={styles.touch} />
        </GestureDetector>
      ) : null}
    </View>
  );
}

/** Высота строки с полосой: полоса посередине, с отступом от ролика и от панели. */
export const FLIQ_PROGRESS_ROW_H = 16;

const styles = StyleSheet.create({
  wrap: { height: FLIQ_PROGRESS_ROW_H, justifyContent: 'center', alignItems: 'center' },
  track: {
    height: 3,
    borderRadius: 1.5,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.10)',
  },
  trackActive: { height: 5, borderRadius: 2.5, backgroundColor: 'rgba(255, 255, 255, 0.16)' },
  fill: { height: 3, backgroundColor: UI_ACCENT },
  fillActive: { height: 5 },
  thumb: {
    position: 'absolute',
    top: (FLIQ_PROGRESS_ROW_H - THUMB) / 2,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: UI_ACCENT,
  },
  touch: { position: 'absolute', left: 0, right: 0, top: -10, bottom: -4 },
});
