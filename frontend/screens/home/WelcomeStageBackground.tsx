import React from 'react';
import { Image, StyleSheet, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
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
  style?: ViewStyle;
  children?: React.ReactNode;
  onLayout?: (e: LayoutChangeEvent) => void;
  /** Полупрозрачный слой поверх обоев чата — картинка слегка просвечивает. */
  translucent?: boolean;
  /** Зеркально по вертикали (нижний chrome чата). */
  mirror?: boolean;
};

/** Chrome header/composer: bitmap для непрозрачного stage, градиент только для стекла. */
export function StageGradient({ style, children, onLayout, translucent, mirror }: StageGradientProps) {
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

  const colors = [
    'rgba(14, 28, 34, 0.72)',
    'rgba(10, 12, 20, 0.66)',
    'rgba(11, 17, 24, 0.68)',
    'rgba(12, 21, 32, 0.74)',
  ] as const;
  const vStart = mirror ? { x: 0.5, y: 1 } : { x: 0.5, y: 0 };
  const vEnd = mirror ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };

  return (
    <View style={style} onLayout={onLayout}>
      <LinearGradient
        colors={[...colors]}
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
