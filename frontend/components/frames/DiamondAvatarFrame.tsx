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

const DIAMOND_RING: BakedRingSources = {
  large: require('../../assets/frames/diamond-ring-512.png'),
  small: require('../../assets/frames/diamond-ring-256.png'),
};

/**
 * Бриллиантовый обод из настоящего рендера кольца.
 *
 * Картинка заранее «запечена» в геометрию рамки (assets/frames/diamond-ring-*.png):
 * исходное кольцо ужато по радиусу до толщины огня и трижды повторено по кругу,
 * чтобы камни не сплющились. Шейдер только оживляет её светом: два источника
 * обходят кольцо, отдельные грани вспыхивают, в бликах проступает радужная
 * дисперсия, а на гранях коротко загораются звёздочки. Геометрия неподвижна.
 */
const DIAMOND_SKSL = `
uniform shader uRing;
uniform float2 uResolution;
uniform float uTime;
uniform float uInnerRadius;
uniform float uOuterRadius;
uniform float uIntensity;

// Геометрия запечённой текстуры: фото до 0.415, полоса рамки 0.077 стороны.
const float BAKED_INNER = 0.415;
const float BAKED_BAND = 0.077;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(float2 p) {
  float3 p3 = fract(float3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + float2(1.0, 0.0));
  float c = hash21(i + float2(0.0, 1.0));
  float d = hash21(i + float2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

half4 main(float2 fragCoord) {
  float side = min(uResolution.x, uResolution.y);
  float2 p = (fragCoord - 0.5 * uResolution) / side;
  float radius = length(p);
  float angle = atan(p.y, p.x);
  float band = max(0.001, uOuterRadius - uInnerRadius);
  float aa = max(band * 0.145, 0.35 / side);
  float t = (radius - uInnerRadius) / band;

  // Любая фактическая полоса переводится в полосу запечённой текстуры.
  float rho = BAKED_INNER + t * BAKED_BAND;
  float2 uv = 0.5 + p * (rho / max(radius, 0.0001));
  half4 tex = uRing.eval(uv * side + 0.5 * (uResolution - side));
  float alpha = float(tex.a);
  float3 col = alpha > 0.002 ? float3(tex.rgb) / alpha : float3(0.0);
  float lum = dot(col, float3(0.299, 0.587, 0.114));

  // Глубже тени и холоднее цвет граней — камень читается прозрачным
  // бриллиантом, а не хромом.
  col = pow(col, float3(1.22));
  col = mix(float3(dot(col, float3(0.299, 0.587, 0.114))), col, 1.35);
  col = clamp(col * float3(0.93, 0.98, 1.07), 0.0, 1.0);
  float facet = smoothstep(0.50, 0.94, lum);

  // Два источника света идут навстречу друг другу с разной скоростью.
  float keyLight = pow(max(0.0, cos(angle - uTime * 0.62)), 9.0);
  float fillLight = pow(max(0.0, cos(angle + uTime * 0.41 + 2.3)), 14.0) * 0.72;
  float sweep = keyLight + fillLight;

  // Мерцание граней: два шумовых поля плывут в разные стороны, и вспыхивают
  // только грани в точках их пересечения. Поле привязано к экрану, а не к
  // повторённой текстуре, поэтому три копии кольца мерцают по-разному.
  float n1 = valueNoise(p * 66.0 + float2(uTime * 0.57, uTime * 0.33));
  float n2 = valueNoise(p * 49.0 + float2(-uTime * 0.44, uTime * 0.61) + 13.7);
  float scint = pow(clamp(n1 * n2 * 2.7, 0.0, 1.0), 4.0);

  // Дисперсия: в освещённых гранях проступают спектральные цвета.
  float hue = fract(angle * 0.4775 + t * 1.3 + lum * 0.8 - uTime * 0.12);
  float3 spectrum = clamp(abs(fract(hue + float3(0.0, 0.6667, 0.3333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  float fireAmount = facet * (0.22 + 0.78 * max(sweep, scint)) * 0.5;
  col = mix(col, col * (0.55 + spectrum * 0.95), fireAmount);

  col *= 0.84 + 0.30 * clamp(sweep, 0.0, 1.0);
  col += float3(0.93, 0.97, 1.0) * facet * (sweep * 0.80 + scint * 1.35);

  // Звёздочки: короткая вспышка-крест в случайной точке камня.
  float stars = 0.0;
  for (int i = 0; i < 4; ++i) {
    float fi = float(i);
    float clock = uTime * (0.42 + hash11(fi + 2.3) * 0.22) + hash11(fi + 11.0) * 3.0;
    float burst = floor(clock);
    float phase = fract(clock);
    float seed = fi * 23.7 + burst * 5.13;
    float starAngle = 6.2831853 * hash11(seed + 1.0);
    float starRadius = uInnerRadius + band * (0.18 + hash11(seed + 2.0) * 0.40);
    float2 d = p - float2(cos(starAngle), sin(starAngle)) * starRadius;
    float life = sin(3.14159265 * phase);
    life = life * life * life;
    float rot = hash11(seed + 3.0) * 0.785;
    float cs = cos(rot);
    float sn = sin(rot);
    float2 q = float2(d.x * cs - d.y * sn, d.x * sn + d.y * cs);
    float arm = max(0.0001, band * (0.55 + hash11(seed + 4.0) * 0.35) * life);
    float width = aa * 0.24;
    float armX = exp(-abs(q.y) / width) * max(0.0, 1.0 - abs(q.x) / arm);
    float armY = exp(-abs(q.x) / width) * max(0.0, 1.0 - abs(q.y) / arm);
    float core = exp(-length(d) / (aa * 0.42));
    stars += (armX * armX + armY * armY + core) * life;
  }
  float starAlpha = clamp(stars, 0.0, 1.0) * uIntensity;

  alpha *= uIntensity;
  float3 premul = col * alpha * (1.0 - starAlpha) + float3(1.0, 0.99, 0.96) * starAlpha;
  float outAlpha = alpha + starAlpha * (1.0 - alpha);

  // Гарантированно прозрачный центр — фото никогда не тонируется шейдером.
  if (radius < uInnerRadius - aa * 0.5) return half4(0.0);
  return half4(half3(clamp(premul, 0.0, outAlpha)), half(outAlpha));
}
`;

const PHOTO_EDGE_MIN_HOLE = 72;

type DiamondAvatarFrameProps = {
  /** Полный квадрат вместе с огранёнными вершинами. */
  size: number;
  /** Диаметр фотографии в прозрачном центре. */
  photoSize: number;
  children?: React.ReactNode;
  active?: boolean;
  intensity?: number;
  style?: StyleProp<ViewStyle>;
  /** Первый кадр бриллианта уже на экране. */
  onReady?: () => void;
};

function DiamondAvatarFrameInner({
  size,
  photoSize,
  children,
  active = true,
  intensity = 1,
  style,
  onReady,
}: DiamondAvatarFrameProps) {
  const side = Math.max(1, Math.round(size));
  const hole = Math.max(1, Math.min(side, Math.round(photoSize)));
  const inset = (side - hole) / 2;
  const effect = useMemo(() => Skia.RuntimeEffect.Make(DIAMOND_SKSL), []);
  const ring = useBakedRing(DIAMOND_RING, side);
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

export const DiamondAvatarFrame = memo(DiamondAvatarFrameInner);

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
    borderColor: 'rgba(232,246,255,0.92)',
    zIndex: 4,
  },
  fallback: {
    borderColor: '#B9D9FF',
    zIndex: 3,
  },
});
