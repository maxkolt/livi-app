import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Carousel from 'react-native-reanimated-carousel';
import { Extrapolation, interpolate } from 'react-native-reanimated';

/** Keep the original coverflow gesture and animation in both directions. */
export function StoreCarousel<T extends { key: string }>({
  data, index, pageWidth, height, viewportWidth, spacing, secondSpacing, thirdSpacing, tilt = 44,
  onSelect, renderItem, onReady,
}: {
  data: T[]; index: number; pageWidth: number; height: number; viewportWidth: number;
  onSelect: (index: number) => void;
  renderItem: (item: T, focused: boolean) => React.ReactElement;
  onReady: () => void;
  spacing: number; secondSpacing: number; thirdSpacing: number; tilt?: number;
}) {
  const start = useRef(index).current;
  const [page, setPage] = useState(start);
  const initialized = useRef(false);
  const raf = useRef<number | null>(null);
  const ready = useCallback(() => {
    if (initialized.current) return;
    initialized.current = true;
    raf.current = requestAnimationFrame(() => { raf.current = requestAnimationFrame(onReady); });
  }, [onReady]);
  useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current); }, []);
  const animation = useCallback((value: number) => {
    'worklet';
    const translateX = interpolate(value, [-3, -2, -1, 0, 1, 2, 3],
      [-thirdSpacing, -secondSpacing, -spacing, 0, spacing, secondSpacing, thirdSpacing], Extrapolation.CLAMP);
    const edgeTilt = tilt === 54 ? 58 : 54;
    const rotateY = interpolate(value, [-2, -1, 0, 1, 2], [edgeTilt, tilt, 0, -tilt, -edgeTilt], Extrapolation.CLAMP);
    const scale = interpolate(value, [-2, -1, 0, 1, 2], [0.74, 0.85, 1.08, 0.85, 0.74], Extrapolation.CLAMP);
    const opacity = interpolate(value, [-3, -2, -1, 0, 1, 2, 3], [0.18, 0.45, 0.78, 1, 0.78, 0.45, 0.18], Extrapolation.CLAMP);
    const zIndex = Math.round(interpolate(value, [-2, -1, 0, 1, 2], [2, 8, 30, 8, 2], Extrapolation.CLAMP));
    return { transform: [{ perspective: 1000 }, { translateX }, { rotateY: `${rotateY}deg` }, { scale }], opacity, zIndex };
  }, [spacing, secondSpacing, thirdSpacing, tilt]);
  return <View onLayout={ready} style={{ width: viewportWidth, height, overflow: 'visible' }}>
    <Carousel<T>
      width={pageWidth} height={height} data={data} defaultIndex={start} loop
      style={{ width: viewportWidth, justifyContent: 'center', overflow: 'visible' }}
      containerStyle={{ overflow: 'visible' }} customAnimation={animation}
      scrollAnimationDuration={420}
      onSnapToItem={next => { setPage(next); onSelect(next); }}
      renderItem={({ item, index: itemIndex }) => renderItem(item, itemIndex === page)}
    />
  </View>;
}
