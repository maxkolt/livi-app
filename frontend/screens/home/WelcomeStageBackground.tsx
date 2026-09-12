import React from 'react';
import { Image, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { WELCOME_STAGE_BG, WELCOME_STAGE_GRADIENT } from './constants';

const STAGE_BG = require('../../assets/welcome-stage-bg.png');

type WelcomeStageBackgroundProps = {
  isDark: boolean;
  /** Fallback when light theme. */
  lightColor: string;
};

/**
 * Full-bleed stage: dithered bitmap (не XML/LinearGradient).
 * На Android GPU-градиенты в тёмных тонах дают banding.
 */
export function WelcomeStageBackground({ isDark, lightColor }: WelcomeStageBackgroundProps) {
  if (!isDark) {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: lightColor }]} pointerEvents="none" />
    );
  }

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: WELCOME_STAGE_BG }]} pointerEvents="none">
      <Image source={STAGE_BG} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={0} />
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
  /** Множитель альфы градиента (1 = как задано в colors ниже). Меньше — прозрачнее. По умолчанию не меняет поведение. */
  opacity?: number;
};

/** Множитель альфы для "стеклянной" шапки/композера чата — сильнее просвечивают обои переписки. */
export const CHAT_GLASS_OPACITY = 0.85;

function scaleRgbaAlpha(rgba: string, multiplier: number): string {
  if (multiplier === 1) return rgba;
  const match = /^rgba\(([^)]+)\)$/.exec(rgba);
  if (!match) return rgba;
  const parts = match[1].split(',').map((s) => s.trim());
  if (parts.length !== 4) return rgba;
  const alpha = Math.max(0, Math.min(1, parseFloat(parts[3]) * multiplier));
  return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha.toFixed(3)})`;
}

/** Chrome header/composer: bitmap для непрозрачного stage, градиент только для стекла. */
export function StageGradient({ style, children, onLayout, translucent, mirror, opacity = 1 }: StageGradientProps) {
  if (!translucent) {
    return (
      <View style={style} onLayout={onLayout}>
        <Image
          source={STAGE_BG}
          style={[StyleSheet.absoluteFill, mirror ? styles.mirror : null]}
          resizeMode="cover"
          fadeDuration={0}
        />
        {children}
      </View>
    );
  }

  const baseColors = [
    'rgba(14, 28, 34, 0.72)',
    'rgba(10, 12, 20, 0.66)',
    'rgba(11, 17, 24, 0.68)',
    'rgba(12, 21, 32, 0.74)',
  ] as const;
  const colors = (
    opacity === 1 ? baseColors : baseColors.map((c) => scaleRgbaAlpha(c, opacity))
  ) as unknown as readonly [string, string, string, string];
  const vStart = mirror ? { x: 0.5, y: 1 } : { x: 0.5, y: 0 };
  const vEnd = mirror ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };

  return (
    <View style={style} onLayout={onLayout}>
      <LinearGradient
        colors={colors}
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
