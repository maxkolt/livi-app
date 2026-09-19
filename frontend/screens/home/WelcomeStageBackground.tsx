import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Image,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaFrame } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { SEARCH_CTA_TABLET_MIN_WIDTH, WELCOME_STAGE_BG } from './constants';

const STAGE_BG = require('../../assets/welcome-stage-bg.png');

/** Тон снят с welcome-stage-bg.png — градиент читается как та же сцена без «шва». */
const STAGE_GRADIENT_COLORS = ['#0E1D24', '#0C171F', '#0A111B', '#0B1821'] as const;
const STAGE_GRADIENT_LOCATIONS = [0, 0.16, 0.38, 1] as const;
/**
 * Виден только в момент поворота, когда слой градиента скрыт. Взят из середины
 * самого градиента: раньше здесь была почти чёрная WELCOME_STAGE_BG, и подмена
 * читалась как вспышка «плоского синего».
 */
export const STAGE_TRANSITION_BG = '#0C1720';

/**
 * Счётчик пробуждений. Нативный слой LinearGradient после сна переиспользуется
 * со старой геометрией: в горизонтали именно он служит фоном, и экран приходил
 * разделённым по вертикали на два тона. Пересоздаём слой при возврате в active —
 * под ним лежит сплошной WELCOME_STAGE_BG, поэтому смена кадра незаметна.
 */
function useResumeEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let last = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      const wasHidden = /inactive|background/.test(last);
      last = next;
      if (next === 'active' && wasHidden) setEpoch((v) => v + 1);
    });
    return () => sub.remove();
  }, []);
  return epoch;
}

function resolveIsWide(width: number, height: number): boolean {
  return (
    width > 0 &&
    height > 0 &&
    (width / height > 1.05 || Math.min(width, height) >= SEARCH_CTA_TABLET_MIN_WIDTH)
  );
}

/**
 * Full-bleed stage.
 * Phone portrait: dithered bitmap + cover (как на макете).
 * Tablet / landscape: только градиент — портретный PNG на широком экране даёт
 * вертикальный «шов» (две колонки тона).
 *
 * Под картинкой всегда лежит нативный вертикальный градиент того же тона, а не
 * плоская заливка: в широкой раскладке именно он и остаётся фоном, поэтому при
 * повороте градиент не «исчезает», а просто перестаёт перекрываться битмапом.
 * Сама картинка не размонтируется, а гасится по opacity, и ориентацию берём из
 * собственного onLayout, а не из frame: frame приходит на кадр позже, и за этот
 * кадр портретный PNG успевал растянуться в landscape-коробку.
 */
export function WelcomeStageBackground() {
  const frame = useSafeAreaFrame();
  const resumeEpoch = useResumeEpoch();
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const isWide = resolveIsWide(box.w || frame.width, box.h || frame.height);
  const bitmapOpacity = useRef(new Animated.Value(isWide ? 0 : 1)).current;

  /**
   * Показ битмапа отложен, скрытие — мгновенное.
   *
   * При пробуждении система на ~400мс отдаёт портретные размеры, хотя окно
   * остаётся горизонтальным (замерено: frame 755×360 → 360×800 → 755×360).
   * За это время успевал включиться портретный PNG и оставлял на экране
   * вертикальный стык. С задержкой этот всплеск проходит мимо: к моменту
   * срабатывания таймера размеры уже вернулись, и показ отменяется.
   */
  useEffect(() => {
    if (isWide) {
      bitmapOpacity.stopAnimation();
      bitmapOpacity.setValue(0);
      return;
    }
    const timer = setTimeout(() => {
      Animated.timing(bitmapOpacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }, 500);
    return () => clearTimeout(timer);
  }, [bitmapOpacity, isWide]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!(width > 0 && height > 0)) return;
    setBox((prev) =>
      Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1 ? prev : { w: width, h: height },
    );
  };

  return (
    <View
      style={[StyleSheet.absoluteFill, { backgroundColor: WELCOME_STAGE_BG }]}
      onLayout={onLayout}
      pointerEvents="none"
    >
      <LinearGradient
        key={`stage-gradient-${resumeEpoch}`}
        colors={STAGE_GRADIENT_COLORS}
        locations={STAGE_GRADIENT_LOCATIONS}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Animated.Image
        source={STAGE_BG}
        style={[StyleSheet.absoluteFill, { opacity: bitmapOpacity }]}
        resizeMode="cover"
        fadeDuration={0}
      />
    </View>
  );
}

type StageGradientProps = {
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  onLayout?: (e: LayoutChangeEvent) => void;
  /** Полупрозрачный слой поверх обоев чата — картинка слегка просвечивает. */
  translucent?: boolean;
  /** Зеркально по вертикали (нижний chrome чата). */
  mirror?: boolean;
};

/** Chrome header/composer: bitmap для непрозрачного stage, градиент только для стекла. */
export function StageGradient({ style, children, onLayout, translucent, mirror }: StageGradientProps) {
  const frame = useSafeAreaFrame();
  const resumeEpoch = useResumeEpoch();
  // Ориентацию считаем от окна, но подтверждаем собственным layout — иначе при
  // повороте картинка на кадр остаётся в старой ветке и мелькает обрезанной.
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const isWide = resolveIsWide(box.w || frame.width, box.h || frame.height);

  const handleLayout = (e: LayoutChangeEvent) => {
    onLayout?.(e);
    const { width, height } = e.nativeEvent.layout;
    if (!(width > 0 && height > 0)) return;
    setBox((prev) =>
      Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1 ? prev : { w: width, h: height },
    );
  };

  if (!translucent) {
    return (
      <View
        style={[style, { backgroundColor: WELCOME_STAGE_BG }]}
        onLayout={handleLayout}
      >
        <LinearGradient
          key={`chrome-gradient-${resumeEpoch}`}
          colors={STAGE_GRADIENT_COLORS}
          locations={STAGE_GRADIENT_LOCATIONS}
          start={mirror ? { x: 0.5, y: 1 } : { x: 0.5, y: 0 }}
          end={mirror ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {isWide ? null : (
          <Image
            source={STAGE_BG}
            style={[StyleSheet.absoluteFill, mirror ? styles.mirror : null]}
            resizeMode="cover"
            fadeDuration={0}
          />
        )}
        {children}
      </View>
    );
  }

  const colors = [
    'rgba(14, 28, 34, 0.72)',
    'rgba(10, 12, 20, 0.66)',
    'rgba(11, 17, 24, 0.68)',
    'rgba(12, 21, 32, 0.74)',
  ] as const;
  const vStart = mirror ? { x: 0.5, y: 1 } : { x: 0.5, y: 0 };
  const vEnd = mirror ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };

  return (
    <View style={style} onLayout={onLayout}>
      <LinearGradient
        colors={[...colors]}
        locations={[0, 0.32, 0.68, 1]}
        start={vStart}
        end={vEnd}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  mirror: {
    transform: [{ scaleY: -1 }],
  },
});
