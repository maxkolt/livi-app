import type { NavigationPerfGlobals } from '../../utils/navigationPerf';
import type { HomeUiGlobals } from './types';
import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  Easing,
  cancelAnimation,
  runOnJS,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { BlurMask, Canvas, Circle, Group, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import { useHomeLayout } from './HomeLayoutContext';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  UI_ACCENT,
  UI_ACCENT_LIGHT,
  SEARCH_CTA_MAX_WIDTH,
  SEARCH_CTA_TABLET_MAX_WIDTH,
  isWelcomeTabletLayout,
  searchPhoneScale,
  WELCOME_HEADER_TITLE,
} from './constants';
import FitText from '../../components/FitText';
import { useDigitalRegularFont } from './brandFont';
import { logger } from '../../utils/logger';
import { logNavigationPerf, navigationPerfNow, nextNavigationPerfId } from '../../utils/navigationPerf';

const BORDER_W = 1;
/**
 * Главная кнопка экрана — в акценте радара, но без сплошной заливки: лёгкий
 * голубой тон, чёткая рамка, иконка акцентом. Тень намеренно нейтрально-тёмная.
 */
const CTA_WAVE = UI_ACCENT;
const CTA_FILL = 'rgba(98, 176, 216, 0.13)';
const CTA_BORDER = 'rgba(98, 176, 216, 0.58)';
/** Мягкое кольцо вокруг рамки. */
const CTA_BORDER_SOFT = 'rgba(98, 176, 216, 0.14)';
/**
 * Отклик на тап — «ток по нейронам», только по рамке: от левого края по верхней и нижней кромке
 * бегут два импульса (ледяное ядро, голубое свечение), за ними гаснет след, по пути вспыхивают
 * «синапсы» на кромке, справа импульсы сходятся вспышкой. Касание ловит Gesture Handler в нативе,
 * анимация — на UI-потоке (Reanimated + Skia): эффект стартует сразу, даже если JS занят.
 * Эффект проходит целиком, и переход в чат UI-поток запускает в его конце: сборка экрана чата
 * тяжёлая и на время останавливает UI-поток — посреди эффекта импульс бы замер.
 */
const CURRENT_MS = 500;
/** Гасим свечение до навигации: скрытый Home может заморозить UI-анимацию. */
const CURRENT_FADE_MS = 110;
/** Длина светящегося импульса — доля полупути рамки. */
const CURRENT_TAIL = 0.16;
/** Поле под свечение вокруг рамки. */
const CURRENT_PAD = 10;
const CURRENT_CORE = '#EAF6FC';
/** «Синапсы» на кромке: доли полупути, где точки вспыхивают по ходу импульса. */
const SYNAPSES = [0.24, 0.46, 0.68, 0.88];
const ACTIVATE_ACTIONS = [{ name: 'activate' as const }];

/** Верхняя и нижняя половины рамки — от левой точки к правой, по середине линии рамки. */
function currentPaths(width: number, height: number): SkPath[] {
  const inset = BORDER_W / 2;
  const x0 = CURRENT_PAD + inset;
  const x1 = CURRENT_PAD + width - inset;
  const y0 = CURRENT_PAD + inset;
  const y1 = CURRENT_PAD + height - inset;
  const d = y1 - y0;
  const cy = (y0 + y1) / 2;
  const left = Skia.XYWHRect(x0, y0, d, d);
  const right = Skia.XYWHRect(x1 - d, y0, d, d);
  const upper = Skia.Path.Make();
  upper.moveTo(x0, cy);
  upper.arcToOval(left, 180, 90, false);
  upper.lineTo(x1 - d / 2, y0);
  upper.arcToOval(right, 270, 90, false);
  const lower = Skia.Path.Make();
  lower.moveTo(x0, cy);
  lower.arcToOval(left, 180, -90, false);
  lower.lineTo(x1 - d / 2, y1);
  lower.arcToOval(right, 90, -90, false);
  return [upper, lower];
}

function synapsePoints(path: SkPath): { x: number; y: number; at: number }[] {
  const contour = Skia.ContourMeasureIter(path, false, 1).next();
  if (!contour) return [];
  const length = contour.length();
  return SYNAPSES.map((at) => {
    const [pos] = contour.getPosTan(length * at);
    return { x: pos.x, y: pos.y, at };
  });
}

function Synapse({ x, y, at, head, glow }: { x: number; y: number; at: number; head: SharedValue<number>; glow: SharedValue<number> }) {
  // Вспыхивает, когда импульс проходит точку, и гаснет за ним.
  const opacity = useDerivedValue(() => {
    const k = (head.value - at) / 0.08;
    return Math.exp(-k * k) * glow.value;
  });
  return (
    <Group opacity={opacity}>
      <Circle cx={x} cy={y} r={3.4} color={UI_ACCENT}>
        <BlurMask blur={3} style="normal" />
      </Circle>
      <Circle cx={x} cy={y} r={1.3} color={CURRENT_CORE} />
    </Group>
  );
}

const CtaCurrent = memo(function CtaCurrent({
  width,
  height,
  head,
  glow,
}: {
  width: number;
  height: number;
  head: SharedValue<number>;
  glow: SharedValue<number>;
}) {
  const paths = useMemo(() => currentPaths(width, height), [width, height]);
  const synapses = useMemo(() => paths.flatMap(synapsePoints), [paths]);
  const tail = useDerivedValue(() => Math.max(0, head.value - CURRENT_TAIL));
  const trailOpacity = useDerivedValue(() => 0.5 * glow.value);
  const meet = useDerivedValue(() => Math.max(0, (head.value - 0.82) / 0.18) * glow.value);
  return (
    <Canvas
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: -CURRENT_PAD,
        top: -CURRENT_PAD,
        width: width + CURRENT_PAD * 2,
        height: height + CURRENT_PAD * 2,
      }}
    >
      {paths.map((path, i) => (
        <Group key={i}>
          {/* След: пройденная часть рамки светится и гаснет. */}
          <Path path={path} start={0} end={head} style="stroke" strokeWidth={1.2} strokeCap="round" color={UI_ACCENT_LIGHT} opacity={trailOpacity} />
          {/* Импульс: свечение и яркое ядро. */}
          <Path path={path} start={tail} end={head} style="stroke" strokeWidth={3.6} strokeCap="round" color={UI_ACCENT} opacity={glow}>
            <BlurMask blur={4} style="normal" />
          </Path>
          <Path path={path} start={tail} end={head} style="stroke" strokeWidth={1.6} strokeCap="round" color={CURRENT_CORE} opacity={glow} />
        </Group>
      ))}
      {synapses.map((s, i) => (
        <Synapse key={i} x={s.x} y={s.y} at={s.at} head={head} glow={glow} />
      ))}
      {/* Импульсы сходятся справа. */}
      <Circle cx={CURRENT_PAD + width - BORDER_W / 2} cy={CURRENT_PAD + height / 2} r={5} color={UI_ACCENT_LIGHT} opacity={meet}>
        <BlurMask blur={5} style="normal" />
      </Circle>
    </Canvas>
  );
});

/**
 * Высота CTA. Вынесена отдельно, чтобы раскладка Search могла заранее
 * зарезервировать под кнопку ровно столько же, сколько она реально займёт.
 */
export function welcomeSearchCtaWidth(windowWidth: number, tabletLayout: boolean, windowHeight = 0): number {
  const sideInset = 44;
  // Широкий телефон — кнопка растёт вместе с радаром. По короткой стороне,
  // чтобы в landscape колонка кнопки не менялась.
  const shortSide = windowHeight > 0 ? Math.min(windowWidth, windowHeight) : windowWidth;
  const maxCtaWidth = tabletLayout
    ? SEARCH_CTA_TABLET_MAX_WIDTH
    : Math.round(SEARCH_CTA_MAX_WIDTH * searchPhoneScale(shortSide));
  return Math.min(Math.max(0, windowWidth - sideInset * 2), maxCtaWidth);
}

export function welcomeSearchCtaHeight(tabletLayout: boolean, compact: boolean): number {
  if (tabletLayout) return 50;
  if (compact) return Platform.OS === 'ios' ? 43 : 40;
  return Platform.OS === 'ios' ? 47 : 43;
}

type WelcomeSearchCtaProps = {
  label: string;
  /** Starts mounting the destination while the UI-thread tap effect is still running. */
  onPressPrepare?: () => void;
  onPress: () => void;
  disabled?: boolean;
  onDisabledPress?: () => void;
  compact?: boolean;
  /** Жёсткий потолок ширины: в две колонки кнопка равна ширине своей колонки. */
  maxWidth?: number;
  style?: ViewStyle;
};

export function WelcomeSearchCta({
  label,
  onPressPrepare,
  onPress,
  disabled = false,
  onDisabledPress,
  compact = false,
  maxWidth,
  style,
}: WelcomeSearchCtaProps) {
  // «Цифровой» Exo 2, как ник и подписи навбара; размер прежний.
  const labelFont = useDigitalRegularFont();
  // Размер берём из safe-area frame: он приходит от нативного провайдера и
  // обновляется при повороте, в отличие от Dimensions.
  const { width: windowWidth, height: windowHeight } = useHomeLayout();
  const tabletLayout = isWelcomeTabletLayout(windowWidth, windowHeight);
  const buttonMaxWidth = Math.min(
    welcomeSearchCtaWidth(windowWidth, tabletLayout, windowHeight),
    maxWidth && maxWidth > 0 ? maxWidth : Number.POSITIVE_INFINITY,
  );
  const buttonHeight = welcomeSearchCtaHeight(tabletLayout, compact);
  const borderRadius = buttonHeight / 2;
  const innerRadius = Math.max(0, borderRadius - BORDER_W);
  const blockedFlash = useRef(new Animated.Value(0)).current;
  const blockedShake = useRef(new Animated.Value(0)).current;
  const pressArmed = useRef(false);
  /** Импульс по рамке: 0 → 1 за CURRENT_MS; glow — общая яркость эффекта, гаснет после. */
  const head = useSharedValue(0);
  const glow = useSharedValue(0);
  /** UI-thread guard: между концом эффекта и обработкой runOnJS нельзя запустить второй navigate. */
  const effectInFlight = useSharedValue(false);
  const [shellW, setShellW] = useState(0);
  const onShellLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setShellW((prev) => (prev === w ? prev : w));
  }, []);

  const triggerBlocked = useCallback(() => {
    blockedFlash.setValue(0);
    blockedShake.setValue(0);
    Animated.sequence([
      Animated.parallel([
        Animated.timing(blockedFlash, { toValue: 1, duration: 120, useNativeDriver: true }),
        Animated.sequence([
          Animated.timing(blockedShake, { toValue: 3, duration: 55, useNativeDriver: true }),
          Animated.timing(blockedShake, { toValue: -3, duration: 60, useNativeDriver: true }),
          Animated.timing(blockedShake, { toValue: 0, duration: 55, useNativeDriver: true }),
        ]),
      ]),
      Animated.timing(blockedFlash, { toValue: 0, duration: 240, useNativeDriver: true }),
    ]).start();
    onDisabledPress?.();
  }, [blockedFlash, blockedShake, onDisabledPress]);

  const firePress = useCallback(() => {
    if (disabled) {
      triggerBlocked();
      return;
    }
    if (pressArmed.current) return;
    pressArmed.current = true;
    const t0 = Date.now();
    try {
      const g = global as NavigationPerfGlobals & HomeUiGlobals;
      // CTA is a foreground navigation action just like a chat/call row tap.
      // Let Home's delayed resume/badge work yield so the RandomChat screen can paint first.
      g.__homeRowActionAtRef = g.__homeRowActionAtRef || { current: 0 };
      g.__homeRowActionAtRef.current = t0;
      g.__searchNavT0 = t0;
      g.__searchNavSteps = [{ step: 'cta.firePress', at: t0, elapsedMs: 0 }];
      // Только первый focus/onStateChange после CTA — иначе поздние remount/focus шумят (200–1100ms).
      g.__searchNavFocusLogged = false;
      g.__searchNavStateChangeLogged = false;
      const trace = g.__searchPerfTrace;
      if (trace) {
        logNavigationPerf('random.navigateRequested', {
          id: trace.id,
          touchElapsedMs: Math.round((navigationPerfNow() - trace.startedAt) * 10) / 10,
        });
      }
    } catch {}
    logger.info('[search-nav] cta.firePress', { t0 });
    onPress();
  }, [disabled, onPress, triggerBlocked]);

  const releasePress = useCallback(() => {
    pressArmed.current = false;
    effectInFlight.value = false;
  }, [effectInFlight]);

  // Переход — с UI-потока по ходу эффекта; задержку от касания пишем в лог.
  const touchAtRef = useRef(0);
  const prepareFromEffect = useCallback(() => {
    touchAtRef.current = Date.now();
    try {
      const g = global as NavigationPerfGlobals & HomeUiGlobals;
      const trace = {
        id: nextNavigationPerfId('random'),
        startedAt: navigationPerfNow(),
        wallStartedAt: touchAtRef.current,
      };
      g.__searchPerfTrace = trace;
      logNavigationPerf('random.touch', { id: trace.id });
    } catch {}
    onPressPrepare?.();
  }, [onPressPrepare]);
  const navigateFromEffect = useCallback(() => {
    try {
      const trace = (global as NavigationPerfGlobals & HomeUiGlobals).__searchPerfTrace;
      if (trace) {
        logNavigationPerf('random.effectComplete', {
          id: trace.id,
          elapsedMs: Math.round((navigationPerfNow() - trace.startedAt) * 10) / 10,
        });
      }
    } catch {}
    logger.info('[search-nav] cta.effectNavigate', { sinceTouchMs: Date.now() - touchAtRef.current });
    pressArmed.current = false;
    firePress();
    setTimeout(releasePress, 600);
  }, [firePress, releasePress]);

  // Касание — в нативе (Gesture Handler): импульс стартует на UI-потоке на самом касании, переход
  // в чат — с него же (как раньше onPressIn), не дожидаясь, пока отпустят палец.
  const tap = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(60000)
        .shouldCancelWhenOutside(false)
        .onBegin(() => {
          if (disabled) {
            runOnJS(triggerBlocked)();
            return;
          }
          // Эффект или его navigate уже идут — второй тап не открывает чат дважды.
          if (effectInFlight.value) return;
          effectInFlight.value = true;
          // Mount RandomChat behind the current screen during the 500 ms impulse.
          // The final navigate then promotes an already prepared native screen.
          runOnJS(prepareFromEffect)();
          cancelAnimation(head);
          cancelAnimation(glow);
          head.value = 0;
          glow.value = 1;
          // На последних кадрах свечение уже гаснет. Затухание после navigate
          // могло заморозиться вместе со скрытым Home и остаться в конечной точке.
          head.value = withTiming(1, { duration: CURRENT_MS, easing: Easing.inOut(Easing.cubic) }, (finished) => {
            if (!finished) return;
            // Сброс до runOnJS: даже если JS или навигация задержатся, кнопка уже в покое.
            glow.value = 0;
            head.value = 0;
            runOnJS(navigateFromEffect)();
          });
          glow.value = withDelay(
            CURRENT_MS - CURRENT_FADE_MS,
            withTiming(0, { duration: CURRENT_FADE_MS, easing: Easing.out(Easing.quad) }),
          );
        }),
    [disabled, effectInFlight, glow, head, navigateFromEffect, prepareFromEffect, triggerBlocked],
  );

  // TalkBack: двойной тап по кнопке — то же нажатие.
  const onAccessibilityAction = useCallback(
    (e: AccessibilityActionEvent) => {
      if (e.nativeEvent.actionName !== 'activate') return;
      firePress();
      setTimeout(releasePress, 600);
    },
    [firePress, releasePress],
  );

  return (
    <Animated.View
      style={[
        {
          maxWidth: buttonMaxWidth,
          alignSelf: 'center',
          transform: [{ translateX: blockedShake }],
        },
        style,
      ]}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      accessibilityActions={ACTIVATE_ACTIONS}
      onAccessibilityAction={onAccessibilityAction}
    >
      <GestureDetector gesture={tap}>
      <View collapsable={false} style={[styles.shadow, disabled ? { opacity: 0.45 } : null]}>
        <View
          style={{
            maxWidth: buttonMaxWidth,
            height: buttonHeight,
            borderRadius,
            overflow: 'visible',
          }}
        >
          {/* Мягкое свечение рамки (размытый край). */}
          <View
            pointerEvents="none"
            style={[
              styles.borderGlow,
              {
                borderRadius,
                shadowColor: CTA_WAVE,
              },
            ]}
          />
          <View
            onLayout={onShellLayout}
            style={[
              styles.borderShell,
              {
                borderRadius,
                maxWidth: buttonMaxWidth,
                height: buttonHeight,
                borderWidth: BORDER_W,
                borderColor: CTA_BORDER,
                backgroundColor: CTA_FILL,
              },
            ]}
          >
            <View
              style={[
                styles.inner,
                {
                  height: buttonHeight - BORDER_W * 2,
                  borderRadius: innerRadius,
                },
              ]}
            >
              <MaterialCommunityIcons
                name="lightning-bolt"
                size={tabletLayout ? 24 : compact ? 20 : 22}
                color={UI_ACCENT}
              />
              <FitText
                style={[
                  styles.label,
                  tabletLayout && styles.labelTablet,
                  compact && styles.labelCompact,
                  labelFont,
                ]}
                minimumFontScale={0.7}
              >
                {label}
              </FitText>
              <Animated.View
                pointerEvents="none"
                style={[
                  StyleSheet.absoluteFillObject,
                  {
                    borderRadius: innerRadius,
                    backgroundColor: 'rgba(255,90,103,0.4)',
                    opacity: blockedFlash,
                  },
                ]}
              />
            </View>
          </View>
          {shellW > 0 ? <CtaCurrent width={shellW} height={buttonHeight} head={head} glow={glow} /> : null}
        </View>
      </View>
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  shadow: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.42,
    shadowRadius: 14,
    elevation: 10,
    overflow: 'visible',
  },
  borderGlow: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 2,
    borderColor: CTA_BORDER_SOFT,
    // лёгкий bloom по периметру
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.32,
    shadowRadius: 5,
    elevation: 0,
  },
  borderShell: {
    overflow: 'hidden',
    justifyContent: 'center',
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    overflow: 'hidden',
    minWidth: 0,
  },

  label: {
    // Тот же цвет, что у надписи «Онлайн» в верхней панели.
    color: WELCOME_HEADER_TITLE,
    fontSize: 16,
    fontWeight: '400',
    letterSpacing: 0.2,
    flexShrink: 1,
    minWidth: 0,
    textAlign: 'center',
  },
  labelCompact: {
    fontSize: 14,
  },
  labelTablet: {
    fontSize: 16,
  },
});
