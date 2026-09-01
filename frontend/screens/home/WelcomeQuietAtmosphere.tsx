import React, { useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

type WelcomeQuietAtmosphereProps = {
  isDark: boolean;
  /** Must match theme.colors.background so edges never form a foreign rim. */
  baseColor: string;
  /** Ignored — kept for call-site compatibility; size comes from onLayout. */
  width?: number;
  height?: number;
};

/**
 * Quiet premium stage.
 * Dark: soft teal/blue bloom.
 * Light: stronger violet/pearl depth so the redesign is actually readable on #B6CBD8.
 * Never translate/scale full-bleed layers (that reveals the flat theme bg as an edge frame).
 */
export function WelcomeQuietAtmosphere({ isDark, baseColor }: WelcomeQuietAtmosphereProps) {
  const [size, setSize] = useState({ w: 0, h: 0 });

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const w = Math.ceil(width);
    const h = Math.ceil(height);
    setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
  };

  const palette = useMemo(() => {
    if (isDark) {
      return {
        glowA: '#14b8a6',
        glowB: '#3b82f6',
        glowC: '#00b5ff',
        washTop: '#0A0C14',
        washMid: '#0E1018',
        washBot: '#0A0C14',
        mainOrb0: 0.14,
        mainOrb1: 0.08,
        sideOrb: 0.06,
        bloom: 0.1,
        floor: 0.35,
        floorColor: '#0A0C14',
      };
    }
    return {
      glowA: '#715BA8',
      glowB: '#8f7ad8',
      glowC: '#FFF8F0',
      washTop: '#C9D8E4',
      washMid: '#B6CBD8',
      washBot: '#9BB0C0',
      mainOrb0: 0.42,
      mainOrb1: 0.28,
      sideOrb: 0.32,
      bloom: 0.38,
      floor: 0.4,
      floorColor: '#8AA0B2',
    };
  }, [baseColor, isDark]);

  const uid = isDark ? 'd' : 'l';

  const pad = 2;
  const w = size.w + pad * 2;
  const h = size.h + pad * 2;
  const ready = size.w > 0 && size.h > 0;

  return (
    <View
      pointerEvents="none"
      onLayout={onLayout}
      collapsable={false}
      style={[StyleSheet.absoluteFill, { overflow: 'hidden', backgroundColor: baseColor }]}
    >
      {ready ? (
        <View
          style={{
            position: 'absolute',
            left: -pad,
            top: -pad,
            width: w,
            height: h,
          }}
        >
          <Svg width={w} height={h}>
            <Defs>
              <SvgLinearGradient id={`qWash-${uid}`} x1="0%" y1="0%" x2="0%" y2="100%">
                <Stop offset="0%" stopColor={palette.washTop} stopOpacity={1} />
                <Stop offset="45%" stopColor={palette.washMid} stopOpacity={1} />
                <Stop offset="100%" stopColor={palette.washBot} stopOpacity={1} />
              </SvgLinearGradient>
            </Defs>
            <Rect x={0} y={0} width={w} height={h} fill={`url(#qWash-${uid})`} />
          </Svg>

          <View style={StyleSheet.absoluteFill}>
            <Svg width={w} height={h}>
              <Defs>
                <RadialGradient id={`qMain-${uid}`} cx="50%" cy="32%" r="60%">
                  <Stop offset="0%" stopColor={palette.glowA} stopOpacity={palette.mainOrb0} />
                  <Stop offset="40%" stopColor={palette.glowB} stopOpacity={palette.mainOrb1} />
                  <Stop offset="100%" stopColor={palette.washMid} stopOpacity={0} />
                </RadialGradient>
                <RadialGradient id={`qBloom-${uid}`} cx="50%" cy="34%" r="34%">
                  <Stop offset="0%" stopColor={palette.glowC} stopOpacity={palette.bloom} />
                  <Stop offset="100%" stopColor={palette.washMid} stopOpacity={0} />
                </RadialGradient>
                <RadialGradient id={`qFloor-${uid}`} cx="50%" cy="100%" r="62%">
                  <Stop offset="0%" stopColor={palette.floorColor} stopOpacity={palette.floor} />
                  <Stop offset="100%" stopColor={palette.washBot} stopOpacity={0} />
                </RadialGradient>
                <RadialGradient id={`qLeft-${uid}`} cx="8%" cy="68%" r="46%">
                  <Stop offset="0%" stopColor={palette.glowC} stopOpacity={palette.sideOrb} />
                  <Stop offset="100%" stopColor={palette.washMid} stopOpacity={0} />
                </RadialGradient>
                <RadialGradient id={`qRight-${uid}`} cx="92%" cy="58%" r="44%">
                  <Stop offset="0%" stopColor={palette.glowB} stopOpacity={palette.sideOrb} />
                  <Stop offset="100%" stopColor={palette.washMid} stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Rect x={0} y={0} width={w} height={h} fill={`url(#qMain-${uid})`} />
              <Rect x={0} y={0} width={w} height={h} fill={`url(#qBloom-${uid})`} />
              <Rect x={0} y={0} width={w} height={h} fill={`url(#qFloor-${uid})`} />
              <Rect x={0} y={0} width={w} height={h} fill={`url(#qLeft-${uid})`} />
              <Rect x={0} y={0} width={w} height={h} fill={`url(#qRight-${uid})`} />
            </Svg>
          </View>
        </View>
      ) : null}
    </View>
  );
}
