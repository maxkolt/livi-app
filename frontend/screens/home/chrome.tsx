import React, {  } from 'react';
import {
  Animated,
  Platform,
  StyleProp,
  View,
  ViewStyle,
} from 'react-native';
import {
  CHROME_PERIMETER_GLOW_LAYERS,
  CHROME_PERIMETER_GLOW_SPREAD,
} from './constants';

/* ================= Animated gradient border (кнопка «Начать поиск», меню) ================= */



function chromePerimeterGlowFill(
  layer: number,
  layerCount: number,
  isDark: boolean,
  intensity = 1
): string {
  const falloff = (layerCount - layer + 1) / layerCount;
  if (isDark) {
    const alpha = (0.012 + falloff * 0.042) * intensity;
    return `rgba(0, 0, 0, ${alpha})`;
  }
  const alpha = (0.005 + falloff * 0.018) * intensity;
  return `rgba(16, 20, 28, ${alpha})`;
}

type ChromePerimeterGlowProps = {
  isDark: boolean;
  width: number;
  height: number;
  borderRadius: number;
  outerStyle?: StyleProp<ViewStyle>;
  glowLayers?: number;
  glowSpread?: number;
  glowIntensity?: number;
  children: React.ReactNode;
};

export const ChromePerimeterGlow: React.FC<ChromePerimeterGlowProps> = ({
  isDark,
  width,
  height,
  borderRadius,
  outerStyle,
  glowLayers: glowLayerCount = CHROME_PERIMETER_GLOW_LAYERS,
  glowSpread = CHROME_PERIMETER_GLOW_SPREAD,
  glowIntensity = 1,
  children,
}) => {
  const maxGlowSpread = glowLayerCount * glowSpread;
  const glowLayers = Array.from(
    { length: glowLayerCount },
    (_, idx) => glowLayerCount - idx
  );

  return (
    <Animated.View
      style={[
        {
          width: width + maxGlowSpread * 2,
          height: height + maxGlowSpread * 2,
        },
        outerStyle,
      ]}
    >
      {glowLayers.map((layer) => {
        const spread = layer * glowSpread;
        return (
          <View
            key={`chrome-glow-${layer}`}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: maxGlowSpread - spread,
              top: maxGlowSpread - spread,
              width: width + spread * 2,
              height: height + spread * 2,
              borderRadius: borderRadius + spread * 0.55,
              backgroundColor: chromePerimeterGlowFill(
                layer,
                glowLayerCount,
                isDark,
                glowIntensity
              ),
            }}
          />
        );
      })}
      <View
        style={{
          position: 'absolute',
          left: maxGlowSpread,
          top: maxGlowSpread,
          ...(Platform.OS === 'ios'
            ? {
                shadowColor: isDark ? '#000000' : '#141820',
                shadowOffset: { width: 0, height: 0 },
                shadowOpacity: (isDark ? 0.12 : 0.045) * glowIntensity,
                shadowRadius: 16,
              }
            : null),
        }}
      >
        {children}
      </View>
    </Animated.View>
  );
};

