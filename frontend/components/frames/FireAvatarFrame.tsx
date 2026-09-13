import React, { forwardRef, useEffect, useImperativeHandle, useMemo } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, LinearGradient as SvgLinearGradient, RadialGradient, Stop } from 'react-native-svg';
import Reanimated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

/**
 * Огненная рамка аватара (код-эффект, без внешних ассетов).
 * mode:
 *  - 'full'  — витрина/профиль: дыхание яркости, бегущий блик, искры, «разжигание» по тапу.
 *  - 'list'  — списки/мелкий размер: только базовое кольцо + один медленный блик (почти статика).
 * Центр прозрачный (маска под аватар), эффект строго по ободу.
 */

const FIRE = {
  core: '#FFE7A6',
  hot: '#FFC062',
  mid: '#FF8A34',
  deep: '#FF4D1C',
  glow: '#FF6A1F',
};

export type FireFrameHandle = { ignite: () => void };

type Props = {
  /** Диаметр «дырки» под аватар. */
  size: number;
  mode?: 'full' | 'list';
  ringWidth?: number;
  children?: React.ReactNode;
  style?: ViewStyle;
};

const AView = Reanimated.View;

const FireAvatarFrame = forwardRef<FireFrameHandle, Props>(function FireAvatarFrame(
  { size, mode = 'full', ringWidth, children, style },
  ref,
) {
  const isFull = mode === 'full';
  // Тонкий обод: ~3–4% диаметра (раньше ~7.5% — выглядело «толстой шиной»).
  const ring = ringWidth ?? Math.max(2, Math.round(size * (isFull ? 0.038 : 0.032)));
  const box = size + ring * 2;
  const cx = box / 2;
  const rMid = size / 2 + ring / 2;
  const gradId = useMemo(() => `fg-${Math.random().toString(36).slice(2, 9)}`, []);
  const ringGradId = `${gradId}-ring`;
  const glowGradId = `${gradId}-glow`;

  const breath = useSharedValue(0);
  const sweep = useSharedValue(0);
  const ignite = useSharedValue(0);

  useEffect(() => {
    breath.value = withRepeat(
      withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    sweep.value = withRepeat(
      withTiming(1, { duration: isFull ? 2600 : 6000, easing: Easing.linear }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(breath);
      cancelAnimation(sweep);
      cancelAnimation(ignite);
    };
  }, [breath, sweep, ignite, isFull]);

  useImperativeHandle(ref, () => ({
    ignite: () => {
      ignite.value = withSequence(
        withTiming(1, { duration: 130, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 900, easing: Easing.in(Easing.quad) }),
      );
    },
  }));

  const glowStyle = useAnimatedStyle(() => {
    const base = 0.28 + breath.value * 0.28;
    const opacity = Math.min(1, base + ignite.value * 0.45);
    const scale = 1 + breath.value * 0.02 + ignite.value * 0.06;
    return { opacity, transform: [{ scale }] };
  });

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + ignite.value * 0.04 }],
  }));

  const sweepStyle = useAnimatedStyle(() => ({
    opacity: (isFull ? 0.85 : 0.45) * (0.55 + breath.value * 0.4),
    transform: [{ rotate: `${sweep.value * 360}deg` }],
  }));

  const embers = useMemo(
    () =>
      isFull
        ? [
            { angle: -80, delay: 0, dur: 1400 },
            { angle: 25, delay: 500, dur: 1700 },
            { angle: 150, delay: 950, dur: 1500 },
            { angle: 210, delay: 300, dur: 1900 },
          ]
        : [],
    [isFull],
  );

  return (
    <View style={[{ width: box, height: box, alignItems: 'center', justifyContent: 'center' }, style]}>
      {isFull && (
        <AView style={[StyleSheet.absoluteFill, glowStyle]} pointerEvents="none">
          <Svg width={box} height={box}>
            <Defs>
              <RadialGradient id={glowGradId} cx="50%" cy="50%" r="50%">
                <Stop offset="58%" stopColor={FIRE.glow} stopOpacity={0} />
                <Stop offset="86%" stopColor={FIRE.mid} stopOpacity={0.42} />
                <Stop offset="100%" stopColor={FIRE.deep} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Circle cx={cx} cy={cx} r={box / 2} fill={`url(#${glowGradId})`} />
          </Svg>
        </AView>
      )}

      <AView style={[StyleSheet.absoluteFill, ringStyle]} pointerEvents="none">
        <Svg width={box} height={box}>
          <Defs>
            <SvgLinearGradient id={ringGradId} x1="0%" y1="0%" x2="100%" y2="100%">
              <Stop offset="0%" stopColor={FIRE.core} />
              <Stop offset="42%" stopColor={FIRE.hot} />
              <Stop offset="72%" stopColor={FIRE.mid} />
              <Stop offset="100%" stopColor={FIRE.deep} />
            </SvgLinearGradient>
          </Defs>
          <Circle cx={cx} cy={cx} r={rMid} stroke={`url(#${ringGradId})`} strokeWidth={ring} fill="none" />
        </Svg>
      </AView>

      <AView style={[StyleSheet.absoluteFill, sweepStyle]} pointerEvents="none">
        <Svg width={box} height={box}>
          <Circle
            cx={cx}
            cy={cx}
            r={rMid}
            stroke={FIRE.core}
            strokeWidth={Math.max(1.5, ring * 0.85)}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${2 * Math.PI * rMid * 0.14} ${2 * Math.PI * rMid * 0.86}`}
          />
        </Svg>
      </AView>

      {embers.map((e, i) => (
        <Ember
          key={i}
          angle={e.angle}
          delay={e.delay}
          dur={e.dur}
          radius={rMid}
          center={cx}
          ignite={ignite}
        />
      ))}

      <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden' }}>
        {children}
      </View>
    </View>
  );
});

function Ember({
  angle,
  delay,
  dur,
  radius,
  center,
  ignite,
}: {
  angle: number;
  delay: number;
  dur: number;
  radius: number;
  center: number;
  ignite: Reanimated.SharedValue<number>;
}) {
  const p = useSharedValue(0);
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const emberSize = 4;

  useEffect(() => {
    p.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration: dur, easing: Easing.out(Easing.quad) }), -1, false),
    );
    return () => cancelAnimation(p);
  }, [p, delay, dur]);

  const style = useAnimatedStyle(() => {
    const travel = 3 + p.value * (8 + ignite.value * 8);
    const r = radius + travel;
    return {
      opacity: (1 - p.value) * (0.7 + ignite.value * 0.3),
      transform: [
        { translateX: dx * r },
        { translateY: dy * r },
        { scale: 0.45 + (1 - p.value) * 0.65 },
      ],
    };
  });

  return (
    <AView
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: center - emberSize / 2,
          top: center - emberSize / 2,
          width: emberSize,
          height: emberSize,
          borderRadius: emberSize / 2,
          backgroundColor: FIRE.core,
        },
        style,
      ]}
    />
  );
}

export default FireAvatarFrame;
export { FireAvatarFrame };
