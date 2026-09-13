import React, { forwardRef, useImperativeHandle } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { Image as ExpoImage } from 'expo-image';

const FIRE_RING = require('../../assets/frames/fire-ring-alpha.png');

export type PngFireFrameHandle = { ignite: () => void };

type Props = {
  /** Диаметр аватара внутри. */
  size: number;
  /** Во сколько раз кольцо больше аватара (языки снаружи). */
  ringScale?: number;
  children?: React.ReactNode;
  style?: ViewStyle;
  /** В карусели — без эффекта (оставлено для совместимости). */
  calm?: boolean;
};

/**
 * PNG-огненная рамка: статично, подогнанная под аватар.
 */
const PngFireFrame = forwardRef<PngFireFrameHandle, Props>(function PngFireFrame(
  { size, ringScale = 1.24, children, style },
  ref,
) {
  const ringSize = Math.round(size * ringScale);
  const box = Math.max(size, ringSize);

  useImperativeHandle(ref, () => ({
    ignite: () => {},
  }));

  return (
    <View style={[{ width: box, height: box, alignItems: 'center', justifyContent: 'center' }, style]}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: 'hidden',
          zIndex: 1,
        }}
      >
        {children}
      </View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: ringSize,
          height: ringSize,
          zIndex: 2,
        }}
      >
        <ExpoImage
          source={FIRE_RING}
          style={StyleSheet.absoluteFillObject}
          contentFit="contain"
          cachePolicy="memory-disk"
        />
      </View>
    </View>
  );
});

export default PngFireFrame;
export { PngFireFrame };
