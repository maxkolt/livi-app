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
import { HOME_NAV_BG, SEARCH_CTA_TABLET_MIN_WIDTH, WELCOME_GLASS_RIM, WELCOME_STAGE_BG } from './constants';
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

/**
 * Новая сцена (StagePalette.TEAL в StageBackground.kt): тон блоков (UI_SURFACE) у краёв →
 * серый «Поиска» (HOME_NAV_BG) в середине. Сплэш, экраны звонка, витрина Legendary.
 * Имя «teal» осталось с бирюзовой версии.
 */
const TEAL_STAGE_EDGE_RGB = '46,53,64';
/** Витрина Legendary: края приглушены почти до середины (StagePalette.TEAL_DEEP). */
const TEAL_DEEP_STAGE_EDGE_RGB = '40,46,56';

export type StagePaletteName = 'classic' | 'teal' | 'tealDeep';

/** reach — доля пути от края до середины, занятая переходом (как StagePalette.reach). */
function buildHomeStageGradient(edgeRgb: string, reach = 1) {
  const colors: string[] = [];
  const locations: number[] = [];
  const total = HOME_STAGE_FADE_STEPS * 2;
  for (let i = 0; i <= total; i += 1) {
    const pos = i / total;
    // 1 у края экрана, 0 к доле reach пути до середины.
    const fromEdge = Math.abs(pos - 0.5) * 2;
    const edge = Math.min(1, Math.max(0, (fromEdge - (1 - reach)) / reach));
    const k = (1 - Math.cos(Math.PI * edge)) / 2;
    colors.push(`rgba(${edgeRgb},${k.toFixed(4)})`);
    locations.push(pos);
  }
  return {
    colors: colors as unknown as readonly [string, string, ...string[]],
    locations: locations as unknown as readonly [number, number, ...number[]],
  };
}

const STAGE_PALETTES = {
  classic: { mid: HOME_STAGE_MID, base: WELCOME_STAGE_BG, ...buildHomeStageGradient(HOME_STAGE_EDGE_RGB) },
  teal: { mid: HOME_NAV_BG, base: HOME_NAV_BG, ...buildHomeStageGradient(TEAL_STAGE_EDGE_RGB) },
  tealDeep: { mid: HOME_NAV_BG, base: HOME_NAV_BG, ...buildHomeStageGradient(TEAL_DEEP_STAGE_EDGE_RGB, 0.7) },
} as const;

/**
 * Android: тот же профиль рисует натив (StageBackground.kt) — bitmap ровно в пиксели
 * экрана с blue-noise дизерингом. Градиент HWUI дизерит регулярной шахматкой Байера,
 * и на OLED (Galaxy S26 Ultra) фон с ней рябил. Сборка без менеджера — прежний градиент.
 */
const NativeStageBackground =
  Platform.OS === 'android' && UIManager.hasViewManagerConfig('LiviStageBackground')
    ? requireNativeComponentOnce<ViewProps & { palette?: StagePaletteName }>('LiviStageBackground')
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
export function WelcomeStageBackground({ palette = 'classic' }: { palette?: StagePaletteName } = {}) {
  if (NativeStageBackground) {
    // Тот же bitmap, что у фона окна, — при повороте и пробуждении шва нет.
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <NativeStageBackground style={StyleSheet.absoluteFill} palette={palette} />
      </View>
    );
  }
  return <GradientStageBackground palette={palette} />;
}

function GradientStageBackground({ palette }: { palette: StagePaletteName }) {
  const stage = STAGE_PALETTES[palette];
  const resumeEpoch = useResumeEpoch();
  // Как и после сна, после поворота нативный слой может остаться со старой геометрией.
  const { width, height } = useWindowDimensions();
  return (
    <View
      style={[StyleSheet.absoluteFill, { backgroundColor: stage.base }]}
      pointerEvents="none"
    >
      <View style={[StyleSheet.absoluteFill, { backgroundColor: stage.mid }]} />
      <LinearGradient
        key={`stage-gradient-${resumeEpoch}-${Math.round(width)}x${Math.round(height)}`}
        colors={stage.colors}
        locations={stage.locations}
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
  /** Блок продолжает chrome над собой (панель эмодзи под композером): без кромки сверху. */
  joinTop?: boolean;
  /** Плотнее к краю экрана; false — край у другого блока (под композером открыта панель). */
  edgeFade?: boolean;
  /** Кромка со всех сторон: блок не у края экрана (плавающий навбар). */
  fullRim?: boolean;
};

const GLASS_BLUR_INTENSITY = Platform.OS === 'android' ? 12 : 20;
const GLASS_BLUR_REDUCTION = 4;
/** Тон tint="dark" у expo-blur на Android при той же intensity. */
const GLASS_DARK_TINT = `rgba(25, 25, 25, ${Math.trunc(255 * (GLASS_BLUR_INTENSITY / 100) * 0.69) / 255})`;
const GLASS_FADE_LOCATIONS = [0, 0.14, 0.38, 1] as const;
/**
 * Стекло шапки и композера чата в тонах вкладок главной: серо-синяя глазурь, на
 * размытом фоне HOME_NAV_BG выходит тоном блоков (UI_SURFACE). У края экрана — чуть
 * плотнее и темнее, к ленте ровная глазурь, сквозь которую видны размытые облака.
 */
const GLASS_TINT_RGB = '62, 72, 86';
const GLASS_EDGE_COLORS = [
  'rgba(26, 31, 39, 0.5)',
  'rgba(26, 31, 39, 0.32)',
  'rgba(26, 31, 39, 0.1)',
  'rgba(26, 31, 39, 0)',
] as const;
const NO_EDGE_FADE: readonly string[] = [];
const RADIUS_KEYS = [
  'borderRadius',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
] as const;

/** Chrome header/composer: bitmap для непрозрачного stage, градиент только для стекла. */
export function StageGradient({
  style,
  children,
  onLayout,
  translucent,
  mirror,
  matteOpacity = 0.38,
  backdrop,
  joinTop,
  edgeFade = true,
  fullRim,
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

  const vStart = mirror ? { x: 0.5, y: 1 } : { x: 0.5, y: 0 };
  const vEnd = mirror ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };
  const matte = `rgba(${GLASS_TINT_RGB}, ${matteOpacity})`;
  // Кромка — по скруглениям самого блока; у края экрана (над шапкой, под композером) её нет.
  const flat = StyleSheet.flatten(style) || {};
  const rimStyle: ViewStyle = {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_RIM,
    ...(fullRim ? null : mirror ? { borderBottomWidth: 0 } : { borderTopWidth: 0 }),
    ...(joinTop ? { borderTopWidth: 0 } : null),
  };
  for (const key of RADIUS_KEYS) {
    if (flat[key] != null) rimStyle[key] = flat[key] as number;
  }

  return (
    <View style={style} onLayout={onLayout}>
      {NativeBlurBackdrop && backdrop ? (
        // Натив сам кладёт matte, градиент края и tint поверх размытой ленты.
        <NativeBlurBackdrop
          pointerEvents="none"
          backgroundSources={backdrop.background}
          blurSources={backdrop.blur}
          blurRadius={GLASS_BLUR_INTENSITY / GLASS_BLUR_REDUCTION}
          overlayColor={GLASS_DARK_TINT}
          matteColor={matte}
          fadeColors={edgeFade ? GLASS_EDGE_COLORS : NO_EDGE_FADE}
          fadeLocations={GLASS_FADE_LOCATIONS}
          mirror={!!mirror}
          style={[StyleSheet.absoluteFill, { zIndex: 0 }]}
        />
      ) : (
        <>
          <BlurView
            pointerEvents="none"
            intensity={GLASS_BLUR_INTENSITY}
            tint="dark"
            experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
            blurReductionFactor={GLASS_BLUR_REDUCTION}
            style={[StyleSheet.absoluteFill, { zIndex: 0 }]}
          />
          {/* Матовый tint лежит только в backdrop; интерактивный контент рисуется выше. */}
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { zIndex: 1, backgroundColor: matte },
            ]}
          />
          {edgeFade ? (
          <LinearGradient
            colors={[...GLASS_EDGE_COLORS]}
            // Плотный край остаётся у status/navigation bar, а к контенту
            // затемнение растворяется раньше и не утяжеляет шапку/композер.
            locations={[...GLASS_FADE_LOCATIONS]}
            start={vStart}
            end={vEnd}
            style={[StyleSheet.absoluteFill, { zIndex: 1 }]}
            pointerEvents="none"
          />
          ) : null}
        </>
      )}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: 1 }, rimStyle]} />
      {children}
    </View>
  );
}

/** Стекло доступно: Android 12+ (нативное, без перерисовки окна на CPU) и iOS. */
export const GLASS_AVAILABLE = Platform.OS === 'ios' || !!NativeBlurBackdrop;

/**
 * Стеклянная подложка блока (меню сообщения, реакции, листы, капсула звонка): absoluteFill
 * первым ребёнком блока, скругление — через style. Сам блок при этом прозрачный и без рамки:
 * кромку рисует стекло. Где стекла нет — null, блок остаётся со своей непрозрачной заливкой.
 */
export function GlassFill({
  backdrop,
  style,
  matteOpacity = 0.5,
}: {
  backdrop: BackdropSources | null;
  style?: StyleProp<ViewStyle>;
  matteOpacity?: number;
}) {
  if (!GLASS_AVAILABLE) return null;
  return (
    <StageGradient
      translucent
      matteOpacity={matteOpacity}
      backdrop={backdrop}
      edgeFade={false}
      fullRim
      style={[StyleSheet.absoluteFill, { overflow: 'hidden' }, style]}
    />
  );
}

const NO_SOURCES: readonly string[] = [];

/**
 * Фон под модалкой: экран под ней размыт тем же стеклом, что листы чата, и притемнён `dim`.
 * Android 12+ — нативное стекло по источникам; iOS — системное размытие; без стекла
 * (или источник недоступен, например видео в звонке) — только затемнение, как раньше.
 */
export function BlurredDim({ blurSources, dim }: { blurSources: readonly string[]; dim: string }) {
  if (NativeBlurBackdrop) {
    return (
      <NativeBlurBackdrop
        pointerEvents="none"
        backgroundSources={NO_SOURCES}
        blurSources={blurSources}
        blurRadius={GLASS_BLUR_INTENSITY / GLASS_BLUR_REDUCTION}
        overlayColor={dim}
        matteColor="transparent"
        fadeColors={NO_EDGE_FADE}
        fadeLocations={GLASS_FADE_LOCATIONS}
        style={StyleSheet.absoluteFill}
      />
    );
  }
  if (Platform.OS === 'ios') {
    return (
      <>
        <BlurView pointerEvents="none" intensity={GLASS_BLUR_INTENSITY} tint="dark" style={StyleSheet.absoluteFill} />
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: dim }]} />
      </>
    );
  }
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: dim }]} />;
}

const styles = StyleSheet.create({
  mirror: {
    transform: [{ scaleY: -1 }],
  },
});
