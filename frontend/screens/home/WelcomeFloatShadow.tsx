import React from 'react';
import { Platform, StyleSheet, UIManager, View, requireNativeComponent, type ViewProps } from 'react-native';

/**
 * Мягкая тень «парящего» блока (онлайн-баннер, верхние сегменты вкладок, «Пригласить
 * друзей»). На iOS — нативная тень: WELCOME_FLOAT_SHADOW_IOS в стиль самого блока.
 * На Android elevation рисует жёсткую тень снизу, поэтому — свой слой вокруг блока:
 * <WelcomeFloatShadow radius={…} /> первым ребёнком блока без overflow: hidden.
 */
export const WELCOME_FLOAT_SHADOW_IOS = Platform.select({
  ios: {
    shadowColor: '#02080d',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.22,
    shadowRadius: 12,
  },
  default: null,
});

const LAYERS = [
  { inset: 8, color: 'rgba(2, 8, 13, 0.018)' },
  { inset: 5, color: 'rgba(2, 8, 13, 0.028)' },
  { inset: 2, color: 'rgba(2, 8, 13, 0.04)' },
] as const;
const DEFAULT_SPREAD = LAYERS[0].inset;

/**
 * Слои выше затемняют фон меньше чем на 1 уровень из 255, и после округления тень
 * выходила тремя резкими кольцами разного оттенка — на OLED рябило. Натив (FloatShadow.kt)
 * рисует тот же тон одним слоем с плавным спадом и blue-noise дизерингом альфы.
 * Сборка без менеджера — прежние слои.
 */
const NativeFloatShadow =
  Platform.OS === 'android' && UIManager.hasViewManagerConfig('LiviFloatShadow')
    ? requireNativeComponent<NativeFloatShadowProps>('LiviFloatShadow')
    : null;

type NativeFloatShadowProps = ViewProps & {
  radius: number;
  spread: number;
  dropOffset: number;
  dropOpacity: number;
  sideOpacity: number;
};

type WelcomeFloatShadowProps = {
  radius: number;
  /** Насколько тень выходит за блок, dp. */
  spread?: number;
  /** Нижний акцент: вторая тень, сдвинутая вниз на dropOffset dp (только натив). */
  dropOffset?: number;
  /** Плотность нижнего акцента относительно основной тени; 0 — без него. */
  dropOpacity?: number;
  /** Плотность акцента у боковых сторон относительно основной тени (только натив). */
  sideOpacity?: number;
};

export function WelcomeFloatShadow({
  radius,
  spread = DEFAULT_SPREAD,
  dropOffset = 0,
  dropOpacity = 0,
  sideOpacity = 0,
}: WelcomeFloatShadowProps) {
  if (Platform.OS !== 'android') return null;
  if (NativeFloatShadow) {
    return (
      <View
        pointerEvents="none"
        style={[styles.layer, { left: -spread, right: -spread, top: -spread, bottom: -spread - dropOffset }]}
      >
        <NativeFloatShadow
          radius={radius}
          spread={spread}
          dropOffset={dropOffset}
          dropOpacity={dropOpacity}
          sideOpacity={sideOpacity}
          style={StyleSheet.absoluteFill}
        />
      </View>
    );
  }
  const scale = spread / DEFAULT_SPREAD;
  return (
    <>
      {LAYERS.map(({ inset, color }) => (
        <View
          key={inset}
          pointerEvents="none"
          style={[
            styles.layer,
            {
              left: -inset * scale,
              right: -inset * scale,
              top: -inset * scale,
              bottom: -inset * scale,
              borderRadius: radius + inset * scale,
              backgroundColor: color,
            },
          ]}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
  },
});
