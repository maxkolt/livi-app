import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';

/**
 * Мягкая тень «парящего» блока (онлайн-баннер, верхние сегменты вкладок, «Пригласить
 * друзей»). На iOS — нативная тень: WELCOME_FLOAT_SHADOW_IOS в стиль самого блока.
 * На Android elevation рисует жёсткую тень снизу, поэтому — три полупрозрачных слоя
 * вокруг: <WelcomeFloatShadow radius={…} /> первым ребёнком блока без overflow: hidden.
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

export function WelcomeFloatShadow({ radius }: { radius: number }) {
  if (Platform.OS !== 'android') return null;
  return (
    <>
      {LAYERS.map(({ inset, color }) => (
        <View
          key={inset}
          pointerEvents="none"
          style={[
            styles.layer,
            {
              left: -inset,
              right: -inset,
              top: -inset,
              bottom: -inset,
              borderRadius: radius + inset,
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
