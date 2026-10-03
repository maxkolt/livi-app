import React, { useEffect, useState } from 'react';
import {
  AppState,
  Image,
  StyleSheet,
  View,
  useWindowDimensions,
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
 * Home: бирюза у верхнего и нижнего края, к середине экрана растворяется в
 * нейтральном HOME_STAGE_MID. Спад по косинусу — без излома ни у края, ни в
 * середине; опорных точек много, иначе линейная интерполяция между редкими stops
 * даёт полосы.
 *
 * Тон краёв — один цвет с плавной альфой поверх сплошной середины, а не
 * смешанные rgb: цвет stop'а округляется до 8 бит, и у середины, где разница
 * в 1–2 единицы, округлённые stops давали ступеньки. Альфа даёт шаг в ~0.04
 * единицы тона — переход сплошной.
 */
const HOME_STAGE_EDGE_RGB = '12,25,37';
const HOME_STAGE_MID = '#0A111B';
const HOME_STAGE_FADE_STEPS = 16;

function buildHomeStageGradient() {
  const colors: string[] = [];
  const locations: number[] = [];
  const total = HOME_STAGE_FADE_STEPS * 2;
  for (let i = 0; i <= total; i += 1) {
    const pos = i / total;
    // 1 у края экрана, 0 в середине.
    const edge = Math.abs(pos - 0.5) * 2;
    const k = (1 - Math.cos(Math.PI * edge)) / 2;
    colors.push(`rgba(${HOME_STAGE_EDGE_RGB},${k.toFixed(4)})`);
    locations.push(pos);
  }
  return {
    colors: colors as unknown as readonly [string, string, ...string[]],
    locations: locations as unknown as readonly [number, number, ...number[]],
  };
}

const {
  colors: HOME_STAGE_GRADIENT_COLORS,
  locations: HOME_STAGE_GRADIENT_LOCATIONS,
} = buildHomeStageGradient();

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
 * Кодовый градиент не зависит от кэша bitmap и одинаково растягивается в любой
 * ориентации. Базовый цвет под ним совпадает с нативным фоном окна, поэтому при
 * повороте или пробуждении не возникает светлого шва.
 */
export function WelcomeStageBackground() {
  const resumeEpoch = useResumeEpoch();
  // Как и после сна, после поворота нативный слой может остаться со старой геометрией.
  const { width, height } = useWindowDimensions();
  return (
    <View
      style={[StyleSheet.absoluteFill, { backgroundColor: WELCOME_STAGE_BG }]}
      pointerEvents="none"
    >
      <View style={[StyleSheet.absoluteFill, { backgroundColor: HOME_STAGE_MID }]} />
      <LinearGradient
        key={`stage-gradient-${resumeEpoch}-${Math.round(width)}x${Math.round(height)}`}
        colors={HOME_STAGE_GRADIENT_COLORS}
        locations={HOME_STAGE_GRADIENT_LOCATIONS}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
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
  // Бирюза разбавлена синим — в тон краёв основного фона (HOME_STAGE_EDGE_RGB).
  const colors = [
    'rgba(11, 20, 31, 1)',
    'rgba(9, 15, 24, 0.97)',
    'rgba(8, 12, 19, 0.88)',
    'rgba(8, 11, 17, 0.50)',
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
  mirror: {
    transform: [{ scaleY: -1 }],
  },
});
