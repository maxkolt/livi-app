import React, { useEffect, useState } from 'react';
import {
  AppState,
  Image,
  Platform,
  StyleSheet,
  UIManager,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { requireNativeComponentOnce } from '../../utils/requireNativeComponentOnce';
import { useSafeAreaFrame } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { SEARCH_CTA_TABLET_MIN_WIDTH, WELCOME_STAGE_BG } from './constants';
import { NativeBlurBackdrop, type BackdropSources } from '../../components/BackdropBlur';

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
// Вместе с MID/EDGE в StageBackground.kt (Android рисует фон нативно).
const HOME_STAGE_EDGE_RGB = '15,30,45';
const HOME_STAGE_MID = '#0C1521';
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
 * Android: тот же профиль рисует натив (StageBackground.kt) — bitmap ровно в пиксели
 * экрана с blue-noise дизерингом. Градиент HWUI дизерит регулярной шахматкой Байера,
 * и на OLED (Galaxy S26 Ultra) фон с ней рябил. Сборка без менеджера — прежний градиент.
 */
const NativeStageBackground =
  Platform.OS === 'android' && UIManager.hasViewManagerConfig('LiviStageBackground')
    ? requireNativeComponentOnce<ViewProps>('LiviStageBackground')
    : null;

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
  if (NativeStageBackground) {
    // Тот же bitmap, что у фона окна, — при повороте и пробуждении шва нет.
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <NativeStageBackground style={StyleSheet.absoluteFill} />
      </View>
    );
  }
  return <GradientStageBackground />;
}

function GradientStageBackground() {
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
  /** Плотность матовой подложки под полупрозрачным градиентом. */
  matteOpacity?: number;
  /** Android 12+: стекло из этих источников на GPU вместо expo-blur (Dimezis). */
  backdrop?: BackdropSources | null;
};

const GLASS_BLUR_INTENSITY = Platform.OS === 'android' ? 12 : 20;
const GLASS_BLUR_REDUCTION = 4;
/** Тон tint="dark" у expo-blur на Android при той же intensity. */
const GLASS_DARK_TINT = `rgba(25, 25, 25, ${Math.trunc(255 * (GLASS_BLUR_INTENSITY / 100) * 0.69) / 255})`;
const GLASS_FADE_LOCATIONS = [0, 0.14, 0.38, 1] as const;

/** Chrome header/composer: bitmap для непрозрачного stage, градиент только для стекла. */
export function StageGradient({
  style,
  children,
  onLayout,
  translucent,
  mirror,
  matteOpacity = 0.08,
  backdrop,
}: StageGradientProps) {
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
    'rgba(11, 20, 31, 0.88)',
    'rgba(9, 15, 24, 0.76)',
    'rgba(8, 12, 19, 0.48)',
    'rgba(8, 11, 17, 0.10)',
  ] as const;
  const vStart = mirror ? { x: 0.5, y: 1 } : { x: 0.5, y: 0 };
  const vEnd = mirror ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };
  const matte = `rgba(8, 13, 22, ${matteOpacity})`;

  return (
    <View style={style} onLayout={onLayout}>
      {NativeBlurBackdrop && backdrop ? (
        <NativeBlurBackdrop
          pointerEvents="none"
          backgroundSources={backdrop.background}
          blurSources={backdrop.blur}
          blurRadius={GLASS_BLUR_INTENSITY / GLASS_BLUR_REDUCTION}
          overlayColor={GLASS_DARK_TINT}
          matteColor={matte}
          fadeColors={colors}
          fadeLocations={GLASS_FADE_LOCATIONS}
          mirror={!!mirror}
          style={[StyleSheet.absoluteFill, { zIndex: 0 }]}
        />
      ) : (
        <BlurView
          pointerEvents="none"
          intensity={GLASS_BLUR_INTENSITY}
          tint="dark"
          experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
          blurReductionFactor={GLASS_BLUR_REDUCTION}
          style={[StyleSheet.absoluteFill, { zIndex: 0 }]}
        />
      )}
      {/* Матовый tint лежит только в backdrop; интерактивный контент рисуется выше. */}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { zIndex: 1, backgroundColor: matte },
        ]}
      />
      <LinearGradient
        colors={[...colors]}
        // Плотный край остаётся у status/navigation bar, а к контенту
        // затемнение растворяется раньше и не утяжеляет шапку/композер.
        locations={[...GLASS_FADE_LOCATIONS]}
        start={vStart}
        end={vEnd}
        style={[StyleSheet.absoluteFill, { zIndex: 1 }]}
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
