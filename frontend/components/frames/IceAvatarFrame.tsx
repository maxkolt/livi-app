import React, { memo, useEffect, useMemo, useState } from 'react';
import { AppState, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Canvas, Fill, ImageShader, Shader, Skia } from '@shopify/react-native-skia';
import {
  useDerivedValue,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import { usePaneVisibleValue } from '../../utils/paneVisibility';
import { useSkiaFirstPaint } from '../../utils/skiaFirstPaint';
import { useBakedRing, type BakedRingSources } from './bakedRing';

const ICE_RING: BakedRingSources = {
  large: require('../../assets/frames/ice-ring-512.png'),
  small: require('../../assets/frames/ice-ring-256.png'),
};

/**
 * Живой лёд вокруг аватара.
 *
 * Ледяная корка — заранее запечённый в геометрию рамки рендер
 * (assets/frames/ice-ring-*.png): толщиной как огонь. Под ней по кругу течёт
 * вода, а сквозь лёд бегут каустики — светлые волнистые прожилки, как от солнца
 * на дне. Вода слегка преломляет лёд над собой. Как и у огня, центр
 * гарантированно прозрачный, и фотография остаётся обычным RN child.
 */
const ICE_SKSL = `
uniform shader uRing;
uniform float2 uResolution;
uniform float uTime;
uniform float uInnerRadius;
uniform float uOuterRadius;
uniform float uIntensity;

const float TAU = 6.2831853;
// Геометрия запечённой текстуры: фото до 0.415, полоса рамки 0.077 стороны.
const float BAKED_INNER = 0.415;
const float BAKED_BAND = 0.077;

// Волновое поле течения. По углу только целые частоты, поэтому на стыке
// atan (±π) нет шва. u — угол в оборотах, v — положение поперёк полосы.
float flowField(float u, float v, float time) {
  float a = u * TAU;
  float w1 = sin(a * 7.0 - time * 1.55 + sin(v * 5.0 + time * 0.62 + a * 2.0) * 1.7);
  float w2 = sin(a * 11.0 + v * 7.5 - time * 2.05 + sin(a * 3.0 - time * 0.83) * 1.2);
  float w3 = sin(a * 4.0 - v * 6.0 - time * 1.10 + sin(a * 5.0 + time * 0.47) * 0.9);
  return (w1 + w2 * 0.8 + w3 * 0.9) / 2.7;
}

// Каустика — тонкие яркие линии там, где поле проходит через ноль.
float causticLines(float f, float width) {
  return 1.0 - smoothstep(0.0, width, abs(f));
}

half4 main(float2 fragCoord) {
  float side = min(uResolution.x, uResolution.y);
  float2 p = (fragCoord - 0.5 * uResolution) / side;
  float radius = length(p);
  float angle = atan(p.y, p.x);
  float band = max(0.001, uOuterRadius - uInnerRadius);
  float aa = max(band * 0.153, 0.35 / side);
  float t = (radius - uInnerRadius) / band;
  float u = angle / TAU;
  float2 dir = p / max(radius, 0.0001);
  float2 tangent = float2(-dir.y, dir.x);

  // Перелив по кругу: широкие светлые волны обходят кольцо с разной скоростью.
  float surge = pow(0.5 + 0.5 * cos(angle - uTime * 0.85), 3.0);
  float surge2 = pow(0.5 + 0.5 * cos(angle * 2.0 + uTime * 0.53 + 1.7), 4.0) * 0.6;
  float flowLight = clamp(surge + surge2, 0.0, 1.0);

  float f1 = flowField(u, t, uTime);
  float f2 = flowField(u + 0.37, t * 1.35 + 2.1, uTime * 0.8 + 4.0);
  float caustic = max(causticLines(f1, 0.075), causticLines(f2, 0.06) * 0.8);
  caustic *= 0.55 + 0.45 * flowLight;

  // Вода преломляет лёд: выборка смещается вдоль течения.
  float2 refractUv = (dir * f1 * 0.045 + tangent * f2 * 0.060) * BAKED_BAND;
  float rho = BAKED_INNER + t * BAKED_BAND;
  float2 uv = 0.5 + p * (rho / max(radius, 0.0001)) + refractUv;
  half4 tex = uRing.eval(uv * side + 0.5 * (uResolution - side));
  float iceA = float(tex.a);
  float3 iceCol = iceA > 0.002 ? float3(tex.rgb) / iceA : float3(0.0);

  // Водяная жила у фото: внешний край — бегущая волна, не ровный круг.
  float waterEdge = 0.42 + 0.07 * sin(angle * 9.0 - uTime * 1.35) + 0.04 * sin(angle * 14.0 + uTime * 0.9);
  float waterA = smoothstep(-0.06, 0.05, t) * (1.0 - smoothstep(waterEdge - 0.14, waterEdge, t));
  waterA *= 0.78;

  float3 deep = float3(0.01, 0.20, 0.58);
  float3 aqua = float3(0.10, 0.74, 1.0);
  float3 foam = float3(0.86, 0.98, 1.0);
  float3 waterCol = mix(deep, aqua, clamp(0.30 + 0.45 * flowLight + 0.25 * (0.5 + 0.5 * f1), 0.0, 1.0));
  waterCol = mix(waterCol, foam, caustic * 0.75);

  // Свет воды проходит и сквозь лёд: каустики и бегущая волна светлят корку.
  // Корка остаётся насыщенно-голубой: светлеют только прожилки и гребень волны.
  iceCol = mix(iceCol, iceCol * 0.82 + aqua * 0.18, 0.35);
  iceCol *= 0.86 + 0.22 * flowLight;
  iceCol += foam * (caustic * 0.42 + flowLight * 0.10) * smoothstep(0.15, 0.75, iceA);

  // Светлая внутренняя кромка держит идеальный круг у фотографии.
  float innerRim = exp(-abs(radius - (uInnerRadius + aa * 1.15)) / max(aa * 0.8, band * 0.05));
  float rimA = innerRim * smoothstep(uInnerRadius - aa * 0.35, uInnerRadius + aa * 0.9, radius) * (0.55 + 0.45 * flowLight);

  float3 premul = iceCol * iceA + waterCol * waterA * (1.0 - iceA);
  float alpha = iceA + waterA * (1.0 - iceA);
  premul = premul * (1.0 - rimA) + foam * rimA;
  alpha = alpha + rimA * (1.0 - alpha);
  premul *= uIntensity;
  alpha *= uIntensity;

  // Гарантированно прозрачный центр — фото никогда не тонируется шейдером.
  if (radius < uInnerRadius - aa * 0.5) return half4(0.0);
  return half4(half3(clamp(premul, 0.0, alpha)), half(alpha));
}
`;

const PHOTO_EDGE_MIN_HOLE = 72;

type IceAvatarFrameProps = {
  /** Полный квадрат вместе с ледяной кромкой. */
  size: number;
  /** Диаметр фотографии в прозрачном центре. */
  photoSize: number;
  children?: React.ReactNode;
  active?: boolean;
  intensity?: number;
  style?: StyleProp<ViewStyle>;
  /** Первый кадр льда уже на экране (не просто смонтирован). */
  onReady?: () => void;
};

function IceAvatarFrameInner({
  size,
  photoSize,
  children,
  active = true,
  intensity = 1,
  style,
  onReady,
}: IceAvatarFrameProps) {
  const side = Math.max(1, Math.round(size));
  const hole = Math.max(1, Math.min(side, Math.round(photoSize)));
  const inset = (side - hole) / 2;
  const effect = useMemo(() => Skia.RuntimeEffect.Make(ICE_SKSL), []);
  const ring = useBakedRing(ICE_RING, side);
  const reduceMotion = useReducedMotion();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const elapsed = useSharedValue(0);
  const paneVisible = usePaneVisibleValue();
  const running = active && appActive && !reduceMotion;
  const { canvasRef, paintViewRef, requestPaintSignal } = useSkiaFirstPaint(onReady);
  const wantsReady = !!onReady;

  useEffect(() => {
    if (!wantsReady) return;
    if (effect) requestPaintSignal();
    else onReady?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effect, requestPaintSignal, wantsReady]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => sub.remove();
  }, []);

  const frame = useFrameCallback((info) => {
    'worklet';
    if (paneVisible && !paneVisible.value) return;
    const dt = info.timeSincePreviousFrame ?? 0;
    elapsed.value += Math.min(80, Math.max(0, dt)) / 1000;
  }, false);

  useEffect(() => {
    frame.setActive(running);
  }, [frame, running]);

  const uniforms = useDerivedValue(() => ({
    uResolution: [side, side],
    uTime: elapsed.value,
    uInnerRadius: hole / side / 2,
    uOuterRadius: 0.492,
    uIntensity: Math.max(0, Math.min(1.35, intensity)),
  }));

  return (
    <View style={[styles.root, style, { width: side, height: side }]}>
      <View
        style={[
          styles.photo,
          {
            left: inset,
            top: inset,
            width: hole,
            height: hole,
            borderRadius: hole / 2,
          },
        ]}
      >
        {children}
      </View>
      {effect ? (
        <View
          ref={paintViewRef}
          collapsable={false}
          style={StyleSheet.absoluteFillObject}
          pointerEvents="none"
        >
          <Canvas ref={canvasRef} style={StyleSheet.absoluteFillObject} pointerEvents="none">
            {ring ? (
              <Fill>
                <Shader source={effect} uniforms={uniforms}>
                  <ImageShader image={ring} fit="fill" rect={{ x: 0, y: 0, width: side, height: side }} />
                </Shader>
              </Fill>
            ) : null}
          </Canvas>
        </View>
      ) : (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFillObject,
            styles.fallback,
            { borderRadius: side / 2, borderWidth: Math.max(2, inset) },
          ]}
        />
      )}
      {hole >= PHOTO_EDGE_MIN_HOLE ? (
        <View
          pointerEvents="none"
          style={[
            styles.photoEdge,
            {
              left: inset,
              top: inset,
              width: hole,
              height: hole,
              borderRadius: hole / 2,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

export const IceAvatarFrame = memo(IceAvatarFrameInner);

const styles = StyleSheet.create({
  root: {
    position: 'relative',
    overflow: 'visible',
    backgroundColor: 'transparent',
  },
  photo: {
    position: 'absolute',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  photoEdge: {
    position: 'absolute',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(191,245,255,0.86)',
    zIndex: 4,
  },
  fallback: {
    borderColor: '#31C9FF',
    zIndex: 3,
  },
});
