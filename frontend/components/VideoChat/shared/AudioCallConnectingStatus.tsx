import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';

type Props = {
  label: string;
};

const BAR_COUNT = 4;
const BAR_HEIGHTS = [5, 8, 11, 14];

/**
 * Soft connecting / reconnecting status for audio-only call header:
 * light pulsing label + smoothly rising signal bars on one baseline.
 */
export function AudioCallConnectingStatus({ label }: Props) {
  const pulse = useRef(new Animated.Value(0)).current;
  const barOpacities = useRef(
    Array.from({ length: BAR_COUNT }, () => new Animated.Value(0.22)),
  ).current;

  useEffect(() => {
    const pulseAnim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    pulseAnim.start();

    const barLoops = barOpacities.map((opacity, index) => {
      const delay = index * 220;
      const anim = Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(opacity, {
            toValue: 0.95,
            duration: 700,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 0.2,
            duration: 700,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.delay((BAR_COUNT - 1 - index) * 220),
        ]),
      );
      anim.start();
      return anim;
    });

    return () => {
      pulseAnim.stop();
      pulse.setValue(0);
      barLoops.forEach((anim) => anim.stop());
      barOpacities.forEach((v) => v.setValue(0.22));
    };
  }, [pulse, barOpacities]);

  const opacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.62, 1],
  });

  return (
    <Animated.View style={[styles.wrap, { opacity }]} accessibilityRole="text">
      <View style={styles.row}>
        <Text
          style={styles.label}
          numberOfLines={1}
          {...(Platform.OS === 'android' ? { includeFontPadding: false } : {})}
        >
          {label}
        </Text>
        <View style={styles.signal} accessibilityElementsHidden>
          {BAR_HEIGHTS.map((height, index) => (
            <Animated.View
              key={index}
              style={[
                styles.bar,
                { height, opacity: barOpacities[index] },
              ]}
            />
          ))}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 8,
    minHeight: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 18,
    color: 'rgba(255,255,255,0.78)',
    letterSpacing: 0.15,
    textAlign: 'center',
  },
  signal: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 14,
    gap: 2,
    marginBottom: 2,
  },
  bar: {
    width: 2,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
});
