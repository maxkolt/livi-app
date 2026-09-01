import React from 'react';
import { StyleSheet, View } from 'react-native';
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
