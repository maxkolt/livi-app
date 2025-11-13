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

  useEffect(() => {
    const shaped = shapeLevel(level, threshold, curve, sensitivity);
  
    anims.forEach((av, i) => {
      let target: number;
  
      if (shaped <= 0) {
        // 🔇 Полная тишина → полоски стоят на месте
        target = 0;
      } else {
        // 🎤 Разговор → динамика с небольшим разбросом
        const noise = (Math.random() - 0.5) * 0.2; // ±0.1
        target = Math.min(1, shaped * factors[i] + noise);
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
  }, [level, threshold, curve, sensitivity, anims, factors, attackMs, releaseMs]);
  

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
