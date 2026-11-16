import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

/** Native scrolling keeps the first frame stable; duplicate end sections allow looping. */
export function StoreCarousel<T extends { key: string }>({
  data, index, pageWidth, height, viewportWidth, spacing, secondSpacing, onSelect, renderItem, onReady,
}: {
  data: T[]; index: number; pageWidth: number; height: number; viewportWidth: number;
  onSelect: (index: number) => void;
  renderItem: (item: T, focused: boolean) => React.ReactElement;
  onReady: () => void;
  spacing: number; secondSpacing: number;
}) {
  const start = useRef(data.length + index).current;
  const list = useRef<Animated.FlatList<number>>(null);
  const offset = useRef(new Animated.Value(start * pageWidth)).current;
  const [page, setPage] = useState(start);
  const items = useMemo(() => Array.from({ length: data.length * 3 }, (_, i) => i), [data.length]);
  const initialized = useRef(false);
  const selected = useRef(start);
  const raf = useRef<number | null>(null);
  const snap = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.max(0, Math.min(items.length - 1, Math.round(event.nativeEvent.contentOffset.x / pageWidth)));
    const logical = next % data.length;
    onSelect(logical);
    const centered = data.length + logical;
    if (next < data.length || next >= data.length * 2) {
      offset.setValue(centered * pageWidth);
      list.current?.scrollToOffset({ offset: centered * pageWidth, animated: false });
      selected.current = centered; setPage(centered);
    } else { selected.current = next; setPage(next); }
  }, [data.length, items.length, offset, onSelect, pageWidth]);
  const scrolling = useMemo(() => Animated.event([{ nativeEvent: { contentOffset: { x: offset } } }], {
    useNativeDriver: true,
    listener: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
      if (selected.current !== next) { selected.current = next; setPage(next); }
    },
  }), [offset, pageWidth]);
  const ready = useCallback(() => {
    if (initialized.current) return;
    initialized.current = true;
    offset.setValue(start * pageWidth);
    list.current?.scrollToOffset({ offset: start * pageWidth, animated: false });
    raf.current = requestAnimationFrame(() => { raf.current = requestAnimationFrame(onReady); });
  }, [offset, onReady, pageWidth, start]);
  React.useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current); }, []);
  return <View style={{ width: viewportWidth, height, overflow: 'visible' }}>
    <Animated.FlatList<number>
      ref={list} data={items} horizontal
      style={{ overflow: 'visible' }}
      contentContainerStyle={{ paddingHorizontal: Math.max(0, (viewportWidth - pageWidth) / 2) }}
      keyExtractor={i => `${data[i % data.length].key}-${i}`}
      initialScrollIndex={start}
      initialNumToRender={9} maxToRenderPerBatch={9} windowSize={3}
      getItemLayout={(_, i) => ({ length: pageWidth, offset: i * pageWidth, index: i })}
      snapToInterval={pageWidth} decelerationRate="fast" disableIntervalMomentum
      showsHorizontalScrollIndicator={false} bounces={false}
      removeClippedSubviews={false} scrollEventThrottle={16}
      onScroll={scrolling} onMomentumScrollEnd={snap}
      onScrollEndDrag={event => {
        // A tap/short drag may not produce momentum.
        if (Math.abs(event.nativeEvent.contentOffset.x / pageWidth - Math.round(event.nativeEvent.contentOffset.x / pageWidth)) < 0.01) snap(event);
      }}
      onContentSizeChange={ready}
      renderItem={({ index: i }) => {
        const item = data[i % data.length];
        const center = i * pageWidth;
        const inputRange = [center - 2 * pageWidth, center - pageWidth, center, center + pageWidth, center + 2 * pageWidth];
        return <View style={{ width: pageWidth, height, zIndex: 30 - Math.min(25, Math.abs(i - page) * 8), overflow: 'visible' }}>
          <Animated.View style={[StyleSheet.absoluteFill, {
            alignItems: 'center', justifyContent: 'center',
            opacity: offset.interpolate({ inputRange, outputRange: [0.45, 0.78, 1, 0.78, 0.45], extrapolate: 'clamp' }),
            transform: [
              { perspective: 1000 },
              { translateX: offset.interpolate({ inputRange, outputRange: [secondSpacing - 2 * pageWidth, spacing - pageWidth, 0, pageWidth - spacing, 2 * pageWidth - secondSpacing], extrapolate: 'clamp' }) },
              { rotateY: offset.interpolate({ inputRange, outputRange: ['-54deg', '-44deg', '0deg', '44deg', '54deg'], extrapolate: 'clamp' }) },
              { scale: offset.interpolate({ inputRange, outputRange: [0.74, 0.85, 1.08, 0.85, 0.74], extrapolate: 'clamp' }) },
            ],
          }]}>{renderItem(item, i === page)}</Animated.View>
        </View>;
      }}
    />
  </View>;
}
