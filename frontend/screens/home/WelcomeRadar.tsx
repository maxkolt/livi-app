import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Mask, RadialGradient, Stop } from 'react-native-svg';
import { AURA_GLOW, AURA_GRADIENT } from './constants';

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
 * Две волны с одной скоростью. Вторая стартует, когда первая на середине пути
 * (delay = duration / 2) — так не обгоняют друг друга.
 */
const RIPPLE_DURATION_MS = 7200;
const RIPPLE_SPECS = [
  { durationMs: RIPPLE_DURATION_MS, startDelayMs: 0 },
  { durationMs: RIPPLE_DURATION_MS, startDelayMs: RIPPLE_DURATION_MS / 2 },
] as const;

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

/** Час на циферблате → угол для SVG (0° = 3h, по часовой). */
function clockHourToDeg(hour: number): number {
  return hour * 30 - 90;
}

/**
 * По одной точке на орбите r1…r4 — стартовые позиции как на макете: 11h, 8h, 5h, 2h.
 *
 * Периоды намеренно взаимно непериодичные (простые числа секунд): кратные периоды
 * через круг-другой снова сходятся в исходный узор, и движение начинает читаться
 * как заведённый механизм. С 37/43/53/61 точки не повторяют взаимное расположение
 * часами, и вращение выглядит хаотичным.
 *
 * dir — направление: соседние орбиты крутятся встречно, так заметнее, что кольца
 * независимы друг от друга, а не вращается вся картинка целиком.
 */
/**
 * Направление жёстко закреплено за орбитой и чередуется от центра наружу:
 * 1-я против часовой, 2-я по, 3-я против, 4-я по. Встречное движение соседей
 * читается как независимые кольца, а не как поворот всей картинки целиком,
 * поэтому разыгрывать его случайно нельзя — иногда выпадали бы две соседние
 * орбиты в одну сторону, и эффект пропадал.
 */
const DOT_SPECS: ReadonlyArray<{ ring: number; hour: number; r: number; dir: 1 | -1 }> = [
  { ring: 0, hour: 11, r: 2.7, dir: -1 },
  { ring: 1, hour: 8, r: 2.7, dir: 1 },
  { ring: 2, hour: 5, r: 2.7, dir: -1 },
  { ring: 3, hour: 2, r: 2.7, dir: 1 },
];

/** Самый быстрый оборот. Быстрее точки читаются как индикатор загрузки. */
const ORBIT_FASTEST_SECONDS = 37;
/** Самый медленный — движение едва заметно боковым зрением. */
const ORBIT_SLOWEST_SECONDS = 150;
/** Минимальный разрыв между самой быстрой и самой медленной орбитой. */
const ORBIT_MIN_SPREAD_SECONDS = 55;
/** Минимальный разрыв между любыми двумя соседними по скорости орбитами. */
const ORBIT_MIN_GAP_SECONDS = 14;

/**
 * Периоды вращения: каждая орбита получает свой, независимо от остальных.
 *
 * Раньше здесь были жёсткие множители от общей базы — соотношение скоростей
 * всегда оставалось одним и тем же, менялся только общий темп. Это выглядело
 * упорядоченно, а не хаотично.
 *
 * Разброс проверяется и при необходимости переразыгрывается: случайные числа
 * иногда сбиваются в кучу, и тогда все четыре точки идут почти одинаково — а это
 * читается как один вращающийся слой вместо четырёх независимых.
 *
 * Значения дробные намеренно. Кратные периоды через круг-другой снова сходятся
 * в исходный узор, и движение начинает выглядеть как заведённый механизм.
 */
function orbitSpinSeconds(count: number): number[] {
  const span = ORBIT_SLOWEST_SECONDS - ORBIT_FASTEST_SECONDS;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const seconds = Array.from(
      { length: count },
      () => ORBIT_FASTEST_SECONDS + Math.random() * span,
    );
    const sorted = [...seconds].sort((a, b) => a - b);
    const spreadOk = sorted[sorted.length - 1] - sorted[0] >= ORBIT_MIN_SPREAD_SECONDS;
    // Общего разброса мало: две орбиты могут выпасть почти одинаковыми внутри
    // него, и тогда их точки идут парой — выглядит как сбой, а не как хаос.
    const gapsOk = sorted.every((v, i) => i === 0 || v - sorted[i - 1] >= ORBIT_MIN_GAP_SECONDS);
    if (spreadOk && gapsOk) return seconds;
  }
  // Крайний случай: раскладываем равномерно по диапазону — так разрывы заведомо
  // одинаковые и максимально возможные — и перемешиваем по орбитам.
  const fallback = Array.from(
    { length: count },
    (_, i) => ORBIT_FASTEST_SECONDS + (span * i) / Math.max(1, count - 1),
  );
  for (let i = fallback.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [fallback[i], fallback[j]] = [fallback[j], fallback[i]];
  }
  return fallback;
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
   * циклу — 205 → 209 → 213 → 215. Точки при этом дёргались.
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

  /** Скорости разыгрываются один раз на монтирование. */
  const spinConfig = useRef(orbitSpinSeconds(DOT_SPECS.length)).current;

  /**
   * По значению на орбиту. Количество орбит фиксировано, так что ref с массивом
   * создаётся один раз и переживает перерисовки от layout/размера — иначе каждый
   * ресайз сбрасывал бы точки в стартовые позиции.
   */
  const spins = useRef(DOT_SPECS.map(() => new Animated.Value(0))).current;
  const ripples = useRef(RIPPLE_SPECS.map(() => new Animated.Value(0))).current;
  /**
   * Interpolate один раз: на каждом рендере новый узел + Animated.loop(0→1)
   * давали скачок точек (сброс угла / отвал native driver).
   */
  const spinRotates = useRef(
    spins.map((spin, i) => {
      const startDeg = clockHourToDeg(DOT_SPECS[i].hour);
      const dir = DOT_SPECS[i].dir;
      return spin.interpolate({
        inputRange: [0, 1],
        outputRange: [`${startDeg}deg`, `${startDeg + 360 * dir}deg`],
        extrapolate: 'extend',
      });
    }),
  ).current;
  /** Доли радиусов орбит — масштабируются с size без прыжков. */
  const stableDotFracsRef = useRef<number[] | null>(null);
  if (!stableDotFracsRef.current && half > 0) {
    stableDotFracsRef.current = ringRadii.map((r) => r / half);
  }
  const dotFracs = stableDotFracsRef.current;

  useEffect(() => {
    // loop 0→1 безопасен при стабильном interpolate (кэш выше).
    // Раньше duration на 1e5 оборотов переполнял int32 и приложение зависало.
    const loops = spins.map((value, i) => {
      value.setValue(0);
      return Animated.loop(
        Animated.timing(value, {
          toValue: 1,
          duration: Math.round(spinConfig[i] * 1000),
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      );
    });
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [spins, spinConfig]);

  useEffect(() => {
    let stopped = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const runners = ripples.map((value, i) => {
      const spec = RIPPLE_SPECS[i];
      const tick = () => {
        if (stopped) return;
        value.setValue(0);
        Animated.timing(value, {
          toValue: 1,
          duration: spec.durationMs,
          easing: Easing.linear,
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (finished && !stopped) tick();
        });
      };
      timers.push(setTimeout(tick, spec.startDelayMs));
      return () => value.stopAnimation();
    });
    return () => {
      stopped = true;
      timers.forEach(clearTimeout);
      runners.forEach((stop) => stop());
    };
  }, [ripples]);

  const rippleStartScale = Math.max(0.22, Math.min(0.55, (avatarOuter * 2) / s));

  const uid = Math.round(s);
  const haloGradId = `radarCenterHalo-${uid}`;
  const outerSoftGradId = `radarOuterSoft-${uid}`;

  const stableDots = useMemo(() => {
    if (!dotFracs) return [];
    return DOT_SPECS.map((spec, i) => ({
      key: i,
      orbitR: (dotFracs[spec.ring] ?? dotFracs[0]) * half,
      r: spec.r,
    }));
  }, [dotFracs, half]);

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

      {/*
        Точки вынесены из SVG в отдельные слои: вращение идёт через transform на
        нативном драйвере, без пересчёта координат в JS на каждый кадр.
      */}
      {stableDots.map((d) => {
        const glowR = d.r + 3;
        return (
          <Animated.View
            key={d.key}
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { transform: [{ rotate: spinRotates[d.key] }] }]}
          >
            <View
              style={{
                position: 'absolute',
                left: cx + d.orbitR - glowR,
                top: cy - glowR,
                width: glowR * 2,
                height: glowR * 2,
                borderRadius: glowR,
                backgroundColor: AURA_GLOW,
                opacity: 0.16,
              }}
            />
            <View
              style={{
                position: 'absolute',
                left: cx + d.orbitR - d.r,
                top: cy - d.r,
                width: d.r * 2,
                height: d.r * 2,
                borderRadius: d.r,
                backgroundColor: AURA_GRADIENT[2],
                opacity: 0.88,
              }}
            />
          </Animated.View>
        );
      })}

      {/* Рябь: разные периоды + мягкий край линии (несколько слоёв). */}
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
