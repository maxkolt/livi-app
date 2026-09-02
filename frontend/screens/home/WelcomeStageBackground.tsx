import React from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import {
  WELCOME_STAGE_AURA_WASH,
  WELCOME_STAGE_BG,
  WELCOME_STAGE_BOTTOM_WASH,
  WELCOME_STAGE_GRADIENT,
} from './constants';

type WelcomeStageBackgroundProps = {
  isDark: boolean;
  /** Fallback when light theme. */
  lightColor: string;
};

/**
 * Full-bleed welcome background — 2× LinearGradient (без SVG), aura-тона, минимум banding.
 */
export function WelcomeStageBackground({ isDark, lightColor }: WelcomeStageBackgroundProps) {
  if (!isDark) {
    return (
      <LinearGradient
        colors={[lightColor, lightColor]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
    );
  }

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: WELCOME_STAGE_BG }]} pointerEvents="none">
      <LinearGradient
        colors={[...WELCOME_STAGE_GRADIENT]}
        locations={[0, 0.32, 0.68, 1]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={[...WELCOME_STAGE_AURA_WASH]}
        locations={[0, 0.42, 1]}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.85, y: 0.62 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={[...WELCOME_STAGE_BOTTOM_WASH]}
        locations={[0.5, 0.82, 1]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
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

/** Same stage + aura wash as welcome — paints header/composer chrome. */
export function StageGradient({ style, children, onLayout, translucent, mirror }: StageGradientProps) {
  const colors = translucent
    ? ([
        'rgba(16, 24, 34, 0.72)',
        'rgba(10, 12, 20, 0.66)',
        'rgba(11, 17, 24, 0.68)',
        'rgba(17, 24, 34, 0.74)',
      ] as const)
    : WELCOME_STAGE_GRADIENT;
  // На коротких chrome-полосах wash мягче и прозрачнее — без кричащего цвета.
  const auraColors = translucent
    ? ([
        'rgba(20, 184, 166, 0.045)',
        'rgba(59, 130, 246, 0.03)',
        'rgba(0, 181, 255, 0.02)',
      ] as const)
    : WELCOME_STAGE_AURA_WASH;
  const washColors = translucent
    ? ([
        'rgba(20, 184, 166, 0.012)',
        'rgba(59, 130, 246, 0.025)',
        'rgba(0, 181, 255, 0.035)',
      ] as const)
    : WELCOME_STAGE_BOTTOM_WASH;
  const auraLocations = translucent ? ([0, 0.55, 1] as const) : ([0, 0.42, 1] as const);
  const washLocations = translucent ? ([0, 0.5, 1] as const) : ([0.5, 0.82, 1] as const);

  const vStart = mirror ? { x: 0.5, y: 1 } : { x: 0.5, y: 0 };
  const vEnd = mirror ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };
  const auraStart = mirror ? { x: 0.85, y: 1 } : { x: 0.15, y: 0 };
  const auraEnd = mirror ? { x: 0.15, y: 0.38 } : { x: 0.85, y: 0.62 };

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
      <LinearGradient
        colors={[...auraColors]}
        locations={[...auraLocations]}
        start={auraStart}
        end={auraEnd}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <LinearGradient
        colors={[...washColors]}
        locations={[...washLocations]}
        start={vStart}
        end={vEnd}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {children}
    </View>
  );
}
