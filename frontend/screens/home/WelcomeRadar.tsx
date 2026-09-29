import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Mask, RadialGradient, Stop } from 'react-native-svg';
import { AURA_GRADIENT } from './constants';

type WelcomeRadarProps = {
  size: number;
  isDark: boolean;
  avatarRadius?: number;
  /**
   * Сжатие орбит к центру (1 = как на макете). Меньше единицы — кольца уже и
   * ближе к аватару, вокруг остаётся воздух. Нужно в landscape, где радар
   * маленький и полосы читаются толстыми, а внешнее кольцо подходит под блоки.
   */
  orbitScale?: number;
  children: React.ReactNode;
};

const PEARL = '#FFF8F0';

/** Бирюза + синий + cyan + жемчуг — один тон для орбит. */
function mixOrbitBandColor(): string {
  const parts = [
    { hex: AURA_GRADIENT[0], w: 0.34 },
    { hex: AURA_GRADIENT[1], w: 0.32 },
    { hex: AURA_GRADIENT[2], w: 0.21 },
    { hex: PEARL, w: 0.13 },
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  for (const { hex, w } of parts) {
    const n = parseInt(hex.slice(1), 16);
    r += ((n >> 16) & 255) * w;
    g += ((n >> 8) & 255) * w;
    b += (n & 255) * w;
  }
  const h = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

const ORBIT_BAND_COLOR = mixOrbitBandColor();
/** 1-я орбита чуть ярче остальных, но без кричащей насыщенности у аватара. */
const BAND_OPACITIES = [0.155, 0.12, 0.08, 0.04] as const;

/**
 * Две волны с одной скоростью, вторая всегда отстаёт ровно на полпериода.
 * Обе считаются из одного нативного цикла. Раньше каждая волна перезапускала
 * себя из JS после окончания: задержки копились, волны сползали друг к другу и
 * на экране было то одна, то две, а прерванная анимация (finished=false)
 * обрывала цепочку — одна волна пропадала насовсем.
 */
const RIPPLE_DURATION_MS = 7200;
/** Сдвиг фазы каждой волны в долях периода. */
const RIPPLE_PHASES = [0, 0.5] as const;

/** Слои одной волны — сильнее размытый край линии. */
const RIPPLE_SOFT_LAYERS = [
  { borderWidth: 14, opacityMul: 0.07, scalePad: 1.028 },
  { borderWidth: 9, opacityMul: 0.12, scalePad: 1.018 },
  { borderWidth: 5.5, opacityMul: 0.2, scalePad: 1.01 },
  { borderWidth: 3.2, opacityMul: 0.34, scalePad: 1.004 },
  { borderWidth: 1.4, opacityMul: 0.55, scalePad: 1 },
] as const;

/** 4 орбиты: ближе к аватару; 2-е уже, 3/4 чуть к центру; g от «полной» суммы шагов. */
function computeRingRadii(half: number, avatarR: number, orbitScale: number): number[] {
  const avatarOuter = avatarR + 2;
  const maxOuter = half * 0.85;
  const step0 = 0.56;
  const step12 = 0.86;
  /** 3-й обод чуть ближе к аватару (δ компенсируем в step34*, g/r1/r2/r4 без изменений). */
  const step23 = 1.04;
  /** База для g (чтобы 1–3 не расползлись). */
  const step34ForG = 1.28;
  /** Фактический шаг 4-го — чуть ближе к центру. */
  const step34 = 1.02;
  const total = step0 + step12 + step23 + step34ForG;
  // orbitScale применяется и к «полу»: иначе минимальный шаг не даёт сжать кольца.
  const g = Math.max(half * 0.078, (maxOuter - avatarOuter) / total) * orbitScale;
  const r1 = avatarOuter + g * step0;
  const r2 = r1 + g * step12;
  const r3 = r2 + g * step23;
  const r4 = r3 + g * step34;
  return [r1, r2, r3, r4];
}

function buildCenterHaloStops(avatarOuter: number, haloR: number): Array<{ offset: number; color: string; opacity: number }> {
  const avatarT = Math.min(0.98, avatarOuter / haloR);
  return [
    { offset: 0, color: ORBIT_BAND_COLOR, opacity: 0 },
    { offset: avatarT * 0.92, color: ORBIT_BAND_COLOR, opacity: 0.05 },
    { offset: avatarT, color: ORBIT_BAND_COLOR, opacity: 0.08 },
    { offset: Math.min(1, avatarT + 0.06), color: ORBIT_BAND_COLOR, opacity: 0.02 },
    { offset: 1, color: ORBIT_BAND_COLOR, opacity: 0 },
  ];
}

type OrbitBand = { id: string; innerR: number; outerR: number; opacity: number };

function buildOrbitBands(avatarOuter: number, ringRadii: number[]): OrbitBand[] {
  const bounds = [avatarOuter, ...ringRadii];
  return ringRadii.map((outerR, i) => ({
    id: `band-${i}`,
    innerR: bounds[i] ?? avatarOuter,
    outerR,
    opacity: BAND_OPACITIES[i] ?? BAND_OPACITIES[3],
  }));
}

export function WelcomeRadar({ size, avatarRadius, orbitScale = 1, children }: WelcomeRadarProps) {
  /**
   * Размер целиком задаёт родитель. Своего onLayout здесь нет намеренно.
   *
   * Раньше радар измерял себя сам и принимал любое положительное значение. При
   * возврате из фона RN отдаёт промежуточные замеры, каждый чуть больше
   * предыдущего; они закреплялись, и радиусы орбит ползли вверх от цикла к
   * циклу — 205 → 209 → 213 → 215.
   */
  const s = size;
  const cx = s / 2;
  const cy = s / 2;
  const half = s / 2;

  const avatarR = avatarRadius ?? half * 0.38;
  const avatarOuter = avatarR + 2;
  const ringRadii = useMemo(
    () => computeRingRadii(half, avatarR, orbitScale),
    [avatarR, half, orbitScale],
  );
  const haloR = ringRadii[0] ?? avatarOuter + half * 0.08;

  const orbitBands = useMemo(
    () => buildOrbitBands(avatarOuter, ringRadii),
    [avatarOuter, ringRadii],
  );

  const lastBand = orbitBands[orbitBands.length - 1];
  const outerSoftPad = Math.max(3, half * 0.028);
  const outerSoftR = (lastBand?.outerR ?? half * 0.85) + outerSoftPad;

  const haloStops = useMemo(
    () => buildCenterHaloStops(avatarOuter, haloR),
    [avatarOuter, haloR],
  );

  const outerSoftStops = useMemo(() => {
    if (!lastBand) return [];
    const den = outerSoftR;
    const innerT = lastBand.innerR / den;
    const midT = (lastBand.innerR + (lastBand.outerR - lastBand.innerR) * 0.38) / den;
    const rimT = lastBand.outerR / den;
    const softT = Math.min(0.995, (lastBand.outerR + outerSoftPad * 0.48) / den);
    const op = lastBand.opacity;
    return [
      { offset: 0, opacity: 0 },
      { offset: Math.max(0, innerT - 0.002), opacity: 0 },
      { offset: innerT, opacity: op },
      { offset: midT, opacity: op },
      { offset: rimT * 0.975, opacity: op },
      { offset: rimT, opacity: op * 0.48 },
      { offset: softT, opacity: op * 0.15 },
      { offset: 1, opacity: 0 },
    ];
  }, [lastBand, outerSoftPad, outerSoftR]);

  const rippleClock = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // С нативным драйвером loop крутится целиком на UI-потоке, без JS между кругами.
    const loop = Animated.loop(
      Animated.timing(rippleClock, {
        toValue: 1,
        duration: RIPPLE_DURATION_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [rippleClock]);

  /** Прогресс каждой волны 0→1: общий цикл, сдвинутый на фазу по кругу. */
  const ripples = useMemo(
    () =>
      RIPPLE_PHASES.map((phase) =>
        phase === 0
          ? rippleClock.interpolate({ inputRange: [0, 1], outputRange: [0, 1] })
          : rippleClock.interpolate({
              inputRange: [0, 1 - phase, 1 - phase + 0.0001, 1],
              outputRange: [phase, 1, 0, phase],
            }),
      ),
    [rippleClock],
  );

  const rippleStartScale = Math.max(0.22, Math.min(0.55, (avatarOuter * 2) / s));

  const uid = Math.round(s);
  const haloGradId = `radarCenterHalo-${uid}`;
  const outerSoftGradId = `radarOuterSoft-${uid}`;

  return (
    <View style={[styles.wrap, { width: s, height: s }]}>
      <Svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} pointerEvents="none">
        <Defs>
          <RadialGradient id={haloGradId} cx="50%" cy="50%" r="50%">
            {haloStops.map((stop, i) => (
              <Stop
                key={`${stop.offset}-${i}`}
                offset={`${(stop.offset * 100).toFixed(1)}%`}
                stopColor={stop.color}
                stopOpacity={stop.opacity}
              />
            ))}
          </RadialGradient>
          <RadialGradient id={outerSoftGradId} cx="50%" cy="50%" r="50%">
            {outerSoftStops.map((stop, i) => (
              <Stop
                key={`os-${i}`}
                offset={`${(stop.offset * 100).toFixed(1)}%`}
                stopColor={ORBIT_BAND_COLOR}
                stopOpacity={stop.opacity}
              />
            ))}
          </RadialGradient>
          {orbitBands.slice(0, -1).map((band) => (
            <Mask key={band.id} id={`${band.id}-${uid}`}>
              <Circle cx={cx} cy={cy} r={band.outerR} fill="white" />
              <Circle cx={cx} cy={cy} r={band.innerR} fill="black" />
            </Mask>
          ))}
        </Defs>
        <Circle cx={cx} cy={cy} r={haloR} fill={`url(#${haloGradId})`} />
        {orbitBands.slice(0, -1).map((band) => (
          <Circle
            key={band.id}
            cx={cx}
            cy={cy}
            r={band.outerR}
            fill={ORBIT_BAND_COLOR}
            fillOpacity={band.opacity}
            mask={`url(#${band.id}-${uid})`}
          />
        ))}
        {lastBand ? (
          <Circle cx={cx} cy={cy} r={outerSoftR} fill={`url(#${outerSoftGradId})`} />
        ) : null}
      </Svg>

      {/* Рябь: две волны через полпериода + мягкий край линии (несколько слоёв). */}
      {ripples.map((value, i) => {
        const scale = value.interpolate({
          inputRange: [0, 1],
          outputRange: [rippleStartScale, 0.98],
        });
        const baseOpacity = value.interpolate({
          // Сразу видна у аватара — как только первая дошла до середины.
          inputRange: [0, 0.06, 0.7, 1],
          outputRange: [0.22, 0.28, 0.1, 0],
        });
        return (
          <Animated.View
            key={`ripple-${i}`}
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { opacity: baseOpacity, transform: [{ scale }] },
            ]}
          >
            {RIPPLE_SOFT_LAYERS.map((layer, li) => (
              <View
                key={`ripple-${i}-l${li}`}
                style={[
                  styles.ripple,
                  {
                    width: s,
                    height: s,
                    borderRadius: s / 2,
                    borderWidth: layer.borderWidth,
                    borderColor: AURA_GRADIENT[2],
                    opacity: layer.opacityMul,
                    transform: [{ scale: layer.scalePad }],
                  },
                ]}
              />
            ))}
          </Animated.View>
        );
      })}

      <View style={styles.center}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ripple: {
    position: 'absolute',
    left: 0,
    top: 0,
    backgroundColor: 'transparent',
  },
});
