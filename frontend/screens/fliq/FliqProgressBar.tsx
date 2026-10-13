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
/**
 * Полоса никогда не отпрыгивает назад на доли секунды — это выглядело как «сброс». Ушла вперёд
 * ролика (на старте он первую секунду проигрывает лишь ~0.45 с, на докачке подвисает) больше
 * AHEAD_HOLD_SEC — стоит и ждёт его; отстала больше BEHIND_JUMP_SEC — догоняет вперёд.
 * Назад — только при разрыве больше JUMP_BACK_SEC: перемотка, новый круг ролика.
 */
const AHEAD_HOLD_SEC = 0.15;
const BEHIND_JUMP_SEC = 0.3;
const JUMP_BACK_SEC = 1.5;
/** Поправка на путь сообщения из WebView — не больше этого (с): старое сообщение не уводит вперёд. */
const MAX_LAG_SEC = 0.5;

type FliqScrubber = {
  /** Длительность из тиков плеера; 0 — ещё не знаем, перематывать нечего. */
  duration: () => number;
  begin: () => void;
  move: (fraction: number) => void;
  end: () => void;
};

/**
 * Прогресс из времени плеера (тики 4 раза в секунду; старт, пауза и буферизация — сразу). Пока
 * ролик идёт, полоса — одна ровная анимация до конца ролика с его скоростью; тики её не дёргают,
 * пока она идёт вровень, а расхождения правят без шагов назад (AHEAD_HOLD_SEC и соседи). Новый
 * круг ролика — в начало. Пока палец на полосе, тики её не двигают.
 */
export function useFliqProgress(playing: boolean) {
  const progress = useRef(new Animated.Value(0)).current;
  const durationRef = useRef(0);
  const scrubbingRef = useRef(false);
  /**
   * Что показывает полоса: секунда ролика sec на момент at (Date.now()) и едет ли она.
   * Значение анимации с нативным драйвером из JS не прочитать — считаем сами.
   */
  const shownRef = useRef({ sec: 0, at: 0, running: false });
  const shownSec = useCallback(() => {
    const s = shownRef.current;
    return s.running ? s.sec + (Date.now() - s.at) / 1000 : s.sec;
  }, []);
  const hold = useCallback(
    (sec: number) => {
      shownRef.current = { sec, at: Date.now(), running: false };
      progress.stopAnimation();
      const dur = durationRef.current;
      progress.setValue(dur > 0 ? Math.min(1, sec / dur) : 0);
    },
    [progress],
  );
  /** Полоса едет от секунды from до конца ролика с его скоростью. */
  const run = useCallback(
    (from: number, dur: number) => {
      shownRef.current = { sec: from, at: Date.now(), running: true };
      progress.stopAnimation();
      progress.setValue(from / dur);
      Animated.timing(progress, {
        toValue: 1,
        duration: Math.max(0, (dur - from) * 1000),
        easing: Easing.linear,
        useNativeDriver: true,
      }).start();
    },
    [progress],
  );
  const stop = useCallback(() => {
    if (shownRef.current.running) hold(shownSec());
  }, [hold, shownSec]);
  const onTick = useCallback(
    (cur: number, dur: number, running = true, sentAt = 0) => {
      if (!(dur > 0)) return;
      durationRef.current = dur;
      if (scrubbingRef.current) return;
      const now = Date.now();
      const lag = sentAt > 0 ? Math.min(MAX_LAG_SEC, Math.max(0, (now - sentAt) / 1000)) : 0;
      const sec = Math.min(dur, Math.max(0, cur + (running ? lag : 0)));
      const shown = Math.min(dur, shownSec());
      const ahead = shown - sec;
      if (ahead >= JUMP_BACK_SEC) {
        // Перемотка назад или новый круг — встаём на время ролика.
        if (running) run(sec, dur);
        else hold(sec);
        return;
      }
      if (!running) {
        hold(ahead > 0 ? shown : sec);
        return;
      }
      if (ahead > AHEAD_HOLD_SEC) {
        // Ролик отстал (разгон, докачка) — полоса ждёт его на месте, а не прыгает назад.
        if (shownRef.current.running) hold(shown);
        return;
      }
      if (shownRef.current.running && ahead > -BEHIND_JUMP_SEC) return;
      run(Math.max(sec, shown), dur);
    },
    [hold, run, shownSec],
  );
  const reset = useCallback(() => hold(0), [hold]);
  /** Поставить полосу на секунду sec, не трогая её с места (ролик ещё не пошёл). */
  const preset = useCallback(
    (sec: number, dur: number) => {
      if (dur > 0) durationRef.current = dur;
      hold(sec);
    },
    [hold],
  );
  useEffect(() => {
    if (!playing) stop();
  }, [playing, stop]);
  const scrubber = useMemo<FliqScrubber>(
    () => ({
      duration: () => durationRef.current,
      begin: () => {
        scrubbingRef.current = true;
        stop();
      },
      move: (fraction) => hold(fraction * durationRef.current),
      end: () => {
        scrubbingRef.current = false;
      },
    }),
    [hold, stop],
  );
  return { progress, onTick, reset, preset, scrubber };
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
