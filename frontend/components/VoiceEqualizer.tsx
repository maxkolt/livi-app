import React, { useEffect, useMemo } from "react";
import { View, Animated, Easing, StyleSheet } from "react-native";

// expo-linear-gradient -> react-native-linear-gradient -> fallback
const LinearGradient: any = (() => {
  try {
    return require("expo-linear-gradient").LinearGradient;
  } catch {
    try {
      return require("react-native-linear-gradient").default;
    } catch {
      return ({ style }: any) => (
        <View style={[{ backgroundColor: "#2EE6FF" }, style]} />
      );
    }
  }
})();

type Props = {
  level: number; // micLevel (0..1)
  frequencyLevels?: number[]; // optional FFT bands (0..1)
  bandCurve?: number; // gamma for bands
  mode?: 'spectrum' | 'waveform';
  threshold?: number;
  sensitivity?: number;
  curve?: number;
  attackMs?: number;
  releaseMs?: number;

  bars?: number;
  width?: number;
  height?: number;
  gap?: number;
  minLine?: number;
  colors?: [string, string, string];
};

// Преобразование уровня громкости (учёт кривой и чувствительности)
function shapeLevel(
  level: number,
  threshold: number,
  curve: number,
  sensitivity: number
) {
  if (level <= threshold) return 0;
  const x = Math.max(0, level - threshold) / (1 - threshold);
  const curved = Math.pow(x, Math.max(0.2, Math.min(curve, 2)));
  const boosted = curved * Math.max(0.5, Math.min(sensitivity, 4));
  return Math.max(0, Math.min(1, boosted));
}

const VoiceEqualizer: React.FC<Props> = ({
  level,
  frequencyLevels,
  bandCurve = 0.7,
  mode = 'waveform',
  threshold = 0.03,
  sensitivity = 1.6,
  curve = 0.55,
  attackMs = 85,
  releaseMs = 220,

  bars = 19,
  width = 200,
  height = 40,
  gap = 6,
  minLine = 4,
  colors = ["#F4FFFF", "#2EE6FF", "#F4FFFF"],
}) => {
  // Анимируемая высота каждой полосы
  const anims = useMemo(
    () => Array.from({ length: bars }, () => new Animated.Value(0)),
    [bars]
  );

  // Уникальный коэффициент для каждой полосы
  const factors = useMemo(
    () => Array.from({ length: bars }, () => 0.7 + Math.random() * 0.6),
    [bars]
  );

  const wavePhaseRef = React.useRef(0);

  useEffect(() => {
    // Если есть реальные FFT-полосы — используем их, иначе fallback на общий level + псевдочастотную волну
    const hasBands = Array.isArray(frequencyLevels) && frequencyLevels.length > 0;

    const resampleBands = (bands: number[], targetLen: number) => {
      if (bands.length === targetLen) return bands.slice();
      if (bands.length === 1) return new Array(targetLen).fill(bands[0] ?? 0);
      const out: number[] = [];
      for (let i = 0; i < targetLen; i++) {
        const t = (i / (targetLen - 1)) * (bands.length - 1);
        const a = Math.floor(t);
        const b = Math.min(bands.length - 1, a + 1);
        const w = t - a;
        const v = (bands[a] ?? 0) * (1 - w) + (bands[b] ?? 0) * w;
        out.push(Math.max(0, Math.min(1, v)));
      }
      return out;
    };

    const shapedLevel = shapeLevel(level, threshold, curve, sensitivity);
    const bands = hasBands ? resampleBands(frequencyLevels as number[], bars) : null;

    // Для waveform-режима вычисляем "тон/яркость" из спектра, чтобы волна двигалась естественнее
    let centroid = 0.5;
    let peakIdx = Math.floor(bars / 2);
    if (hasBands && bands) {
      let sum = 0;
      let wsum = 0;
      let maxV = -1;
      for (let i = 0; i < bars; i++) {
        const v = Math.max(0, Math.min(1, bands[i] ?? 0));
        sum += v;
        wsum += v * i;
        if (v > maxV) {
          maxV = v;
          peakIdx = i;
        }
      }
      centroid = sum > 0 ? wsum / sum / Math.max(1, bars - 1) : 0.5;
    }
    // скорость волны зависит от "яркости" (centroid) и силы сигнала
    const waveSpeed = (0.10 + 0.35 * centroid) * (0.6 + 0.6 * shapedLevel);
    wavePhaseRef.current += waveSpeed;
  
    anims.forEach((av, i) => {
      let target: number;
  
      if (mode === 'waveform' && (hasBands || shapedLevel > 0)) {
        // Voice waveform: стабильная "волна" речи (как на примере), без рандома.
        // Полосы симметричны относительно центра и имеют разный рисунок (тон/тембр влияет на форму).
        const mid = (bars - 1) / 2;
        const x = mid > 0 ? (i - mid) / mid : 0; // -1..1
        const ax = Math.abs(x);

        // базовая огибающая: громкость управляет общей высотой
        const env = shapedLevel;

        // форма "облака" (в середине чуть выше, края ниже) — как у speech visualizers
        const body = Math.pow(1 - Math.min(1, ax), 0.55);

        // рябь по волне: тон/пик спектра влияет на "частоту" ряби
        const rippleCount = 2.2 + 3.2 * centroid + (peakIdx / Math.max(1, bars - 1)) * 1.2;
        const ripple = 0.62 + 0.38 * Math.sin(wavePhaseRef.current + ax * Math.PI * rippleCount);

        // итог: без шума, но соседние полосы разные
        target = Math.min(1, Math.max(0, env * (0.25 + 0.75 * body) * ripple));
      } else if (hasBands) {
        // Спектр: каждая полоска = свой диапазон (для режима spectrum)
        const raw = bands?.[i] ?? 0;
        target = Math.min(1, Math.max(0, Math.pow(raw, Math.max(0.35, Math.min(1.4, bandCurve)))));
      } else if (shapedLevel <= 0) {
        // 🔇 Полная тишина → полоски стоят на месте
        target = 0;
      } else {
        // 🎤 Разговор → динамика с частотным распределением
        // Каждая полоска реагирует на разные частоты на основе реального уровня звука
        // Используем синусоидальную функцию для создания волнового эффекта ТОЛЬКО когда есть реальный звук
        // КРИТИЧНО: Не создаем движение без реального звука (shaped уже проверен > 0)
        const frequency = (i / bars) * Math.PI * 2; // Разные частоты для каждой полоски
        const time = Date.now() / 1000; // Текущее время в секундах
        const wave = Math.sin(frequency * time * 2) * 0.3 + 0.7; // Волна от 0.4 до 1.0
        
        // Комбинируем базовый уровень с волной и небольшим случайным шумом
        // Шум уменьшен, чтобы не создавать хаотичное движение
        const noise = (Math.random() - 0.5) * 0.1; // ±0.05 (уменьшено с 0.15)
        const frequencyFactor = wave * factors[i];
        target = Math.min(1, shapedLevel * frequencyFactor + noise);
      }
  
      const current = (av as any)?._value ?? 0;
      const goingUp = target > current;
      const duration = (goingUp ? attackMs : releaseMs) + (i % 5) * 14;
  
      Animated.timing(av, {
        toValue: Math.max(0, target),
        duration,
        easing: goingUp
          ? Easing.out(Easing.cubic)
          : Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
  }, [level, frequencyLevels, bandCurve, mode, threshold, curve, sensitivity, anims, factors, attackMs, releaseMs, bars]);
  

  // Геометрия
  const safeWidth = Math.max(1, width);
  const barW = Math.max(1, (safeWidth - gap * (bars - 1)) / bars);
  const baseScale = Math.min(1, Math.max(minLine / height, 0.04)); // минимальная высота

  return (
    <View
      pointerEvents="none"
      style={[
        styles.container,
        {
          width: safeWidth,
          height,
          marginLeft: -safeWidth / 2,
          marginTop: -height / 2,
        },
      ]}
    >
      {anims.map((av, i) => {
        const scaleY = av.interpolate({
          inputRange: [0, 1],
          outputRange: [baseScale, 1],
          extrapolate: "clamp",
        });

        return (
          <View
            key={i}
            style={{
              width: barW,
              height,
              marginRight: i === bars - 1 ? 0 : gap,
              overflow: "hidden",
              alignItems: "stretch",
              justifyContent: "center",
              borderRadius: 3,
            }}
          >
            <Animated.View
              style={{
                ...StyleSheet.absoluteFillObject,
                transform: [{ scaleY }],
                borderRadius: 3,
                overflow: "hidden",
              }}
            >
              <LinearGradient
                colors={colors}
                locations={[0, 0.5, 1]}
                start={{ x: 0.5, y: 0 }}
                end={{ x: 0.5, y: 1 }}
                style={{ flex: 1 }}
              />
            </Animated.View>
          </View>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: "50%",
    left: "50%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 5, // чтобы полосы были над соседними блоками
  },
});

export default VoiceEqualizer;
