import React, { useEffect, useState } from 'react';
import {
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
 * Full-bleed stage — один и тот же слой в любой ориентации и на любом экране.
 *
 * Картинка по сути вертикальный градиент (светлее сверху и снизу, темнее в
 * середине), поэтому её растягиваем на весь экран, а не обрезаем: в горизонтали
 * сохраняется тот же переход тона сверху вниз. Раньше в широкой раскладке PNG
 * подменялся градиентом-имитацией, и при повороте менялся сам фон, а не только
 * контент. Тот же PNG стоит нативным фоном окна (window_stage_background.xml):
 * полосы, которые RN после поворота ещё не перерисовал, выглядят так же.
 */
export function WelcomeStageBackground() {
  return (
    <View
      style={[StyleSheet.absoluteFill, { backgroundColor: WELCOME_STAGE_BG }]}
      pointerEvents="none"
    >
      <Image
        source={STAGE_BG}
        style={styles.stageImage}
        resizeMode="stretch"
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

  // Рассеивание на весь блок: у края экрана плотнее, к ленте — всё меньше.
  // Бирюза чуть приглушена. Прозрачность снижена (блоки плотнее).
  const colors = [
    'rgba(11, 22, 28, 1)',
    'rgba(9, 15, 21, 0.97)',
    'rgba(8, 12, 18, 0.88)',
    'rgba(8, 11, 16, 0.50)',
  ] as const;
  const vStart = mirror ? { x: 0.5, y: 1 } : { x: 0.5, y: 0 };
  const vEnd = mirror ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };

  return (
    <View style={style} onLayout={onLayout}>
      <LinearGradient
        colors={[...colors]}
        locations={[0, 0.34, 0.68, 1]}
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
  /**
   * Image.android.js подставляет в стиль width/height из require (540×1200), и
   * они сильнее absoluteFill: картинка была коробкой 540×1200dp в левом верхнем
   * углу — в горизонтали обрывалась на 540dp вертикальным «швом».
   */
  stageImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  mirror: {
    transform: [{ scaleY: -1 }],
  },
});
