import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Path,
  Stop,
} from 'react-native-svg';

type WelcomeSearchArrowsProps = {
  isDark: boolean;
  dense?: boolean;
  compact?: boolean;
};

const ARROW_COUNT = 5;

/**
 * Elegant downward cue toward «Начать поиск».
 * One soft wave travels top → bottom and fully clears before the next pass.
 */
export function WelcomeSearchArrows({
  isDark,
  dense = false,
  compact = false,
}: WelcomeSearchArrowsProps) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: dense ? 4200 : 5600,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
        // Hold while everything is gone — no flash at the top.
        Animated.delay(dense ? 900 : 1400),
        Animated.timing(progress, {
          toValue: 0,
          duration: 1,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => {
      loop.stop();
      progress.stopAnimation();
    };
  }, [dense, progress]);

  const palette = useMemo(() => {
    if (isDark) {
      return { a: '#14b8a6', b: '#3b82f6', c: '#00b5ff' };
    }
    return { a: '#715BA8', b: '#8f7ad8', c: '#5B7C99' };
  }, [isDark]);

  const baseW = dense ? 40 : compact ? 50 : 58;
  const baseH = dense ? 22 : compact ? 28 : 34;
  const uid = isDark ? 'd' : 'l';

  return (
    <View
      pointerEvents="none"
      style={styles.wrap}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={styles.stack}>
        {Array.from({ length: ARROW_COUNT }, (_, i) => {
          const t = ARROW_COUNT <= 1 ? 0 : i / (ARROW_COUNT - 1);
          const size = 1 - t * 0.52;
          const w = baseW * size;
          const h = baseH * size;

          // Peak centers spaced along 0..0.82 so progress=1 is fully empty.
          const peak = 0.08 + t * 0.74;
          const half = 0.09;
          const opacity = progress.interpolate({
            inputRange: [
              Math.max(0, peak - half * 1.6),
              peak - half * 0.35,
              peak,
              peak + half,
              Math.min(1, peak + half * 1.8),
            ],
            outputRange: [0, 0.55, 1, 0.35, 0],
            extrapolate: 'clamp',
          });
          const driftY = progress.interpolate({
            inputRange: [
              Math.max(0, peak - half * 1.6),
              peak,
              Math.min(1, peak + half * 1.8),
            ],
            outputRange: [-4, 6, 12],
            extrapolate: 'clamp',
          });
          const scale = progress.interpolate({
            inputRange: [
              Math.max(0, peak - half),
              peak,
              Math.min(1, peak + half * 1.4),
            ],
            outputRange: [0.86, 1, 0.9],
            extrapolate: 'clamp',
          });

          return (
            <Animated.View
              key={`cue-${i}`}
              style={[
                styles.arrowSlot,
                {
                  opacity,
                  transform: [{ translateY: driftY }, { scale }],
                },
              ]}
            >
              <Svg width={w} height={h} viewBox="0 0 64 36">
                <Defs>
                  <SvgLinearGradient
                    id={`cueGrad-${uid}-${i}`}
                    x1="0%"
                    y1="0%"
                    x2="100%"
                    y2="100%"
                  >
                    <Stop offset="0%" stopColor={palette.a} stopOpacity={0.95} />
                    <Stop offset="55%" stopColor={palette.b} stopOpacity={1} />
                    <Stop offset="100%" stopColor={palette.c} stopOpacity={0.9} />
                  </SvgLinearGradient>
                  <SvgLinearGradient
                    id={`cueFill-${uid}-${i}`}
                    x1="50%"
                    y1="0%"
                    x2="50%"
                    y2="100%"
                  >
                    <Stop offset="0%" stopColor={palette.b} stopOpacity={0.35} />
                    <Stop offset="100%" stopColor={palette.c} stopOpacity={0.05} />
                  </SvgLinearGradient>
                </Defs>
                {/* Soft kite body */}
                <Path
                  d="M32 8
                     C26 12, 18 16, 10 14
                     C20 20, 26 26, 32 30
                     C38 26, 44 20, 54 14
                     C46 16, 38 12, 32 8 Z"
                  fill={`url(#cueFill-${uid}-${i})`}
                />
                {/* Fine elegant stroke */}
                <Path
                  d="M12 13
                     C22 18, 27 24, 32 29
                     C37 24, 42 18, 52 13"
                  fill="none"
                  stroke={`url(#cueGrad-${uid}-${i})`}
                  strokeWidth={2.2 - t * 0.7}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {/* Tiny tip accent */}
                <Path
                  d="M32 29 L32 33"
                  fill="none"
                  stroke={`url(#cueGrad-${uid}-${i})`}
                  strokeWidth={1.6 - t * 0.5}
                  strokeLinecap="round"
                  opacity={0.7}
                />
              </Svg>
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    width: '100%',
    flex: 1,
    marginBottom: -28,
  },
  stack: {
    flex: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    paddingBottom: 2,
  },
  arrowSlot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
