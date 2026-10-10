import React, { memo, useEffect, useMemo, useState } from 'react';
import { AppState, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Canvas, Fill, Shader, Skia } from '@shopify/react-native-skia';
import {
  useDerivedValue,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import { useSkiaFirstPaint } from '../../utils/skiaFirstPaint';

/**
 * Процедурное пламя вокруг круглого аватара.
 *
 * Вся меняющаяся геометрия считается RuntimeEffect на GPU. React участвует
 * только при mount/AppState, а время между кадрами живёт на UI-потоке.
 * Центральный круг шейдер всегда оставляет прозрачным, поэтому фотография —
 * обычный RN child: она не копируется в текстуру и не перерисовывается.
 */
const FIRE_SKSL = `
uniform float2 uResolution;
uniform float uTime;
uniform float uInnerRadius;
uniform float uOuterRadius;
uniform float uIntensity;

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

float fbm(float2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; ++i) {
    sum += amp * valueNoise(p);
    p = float2(p.x * 1.73 - p.y * 1.12, p.x * 1.12 + p.y * 1.73) + 7.31;
    amp *= 0.5;
  }
  return sum;
}

half4 main(float2 fragCoord) {
  float side = min(uResolution.x, uResolution.y);
  float2 p = (fragCoord - 0.5 * uResolution) / side;
  float radius = length(p);
  float angle = atan(p.y, p.x);
  float band = max(0.001, uOuterRadius - uInnerRadius);
  // Сглаживание — доля полосы, а не фиксированные 1.35 dp: на мини-аватаре
  // (полоса ~3 dp) оно съедало пламя, и оставались два кольца — ободок у фото
  // и внешнее свечение. Так маленькая рамка — уменьшенная копия большой
  // (у 140 dp значение то же, что было).
  float aa = max(band * 0.153, 0.35 / side);
  // Оставляем внешний сектор рамки свободным для вылетающих искр.
  float flameBand = band * 0.78;

  // Два потока шума: крупный изгибает языки, мелкий рвёт их края.
  float2 drift = float2(uTime * 0.31, -uTime * 0.47);
  float coarse = fbm(p * 8.0 + drift);
  float fine = valueNoise(p * 25.0 + float2(-uTime * 0.8, uTime * 0.56));
  float curl = sin(angle * 7.0 - uTime * 1.75 + coarse * 5.2);
  float curl2 = sin(angle * 13.0 + uTime * 1.17 - coarse * 3.4);
  float tongue = pow(clamp(0.52 + 0.30 * curl + 0.18 * curl2, 0.0, 1.0), 2.15);
  float reach = clamp(0.34 + coarse * 0.33 + tongue * 0.50 + (fine - 0.5) * 0.14, 0.22, 1.0);
  float flameEdge = uInnerRadius + flameBand * reach;

  float innerMask = smoothstep(uInnerRadius - aa * 0.35, uInnerRadius + aa * 1.2, radius);
  float body = 1.0 - smoothstep(flameEdge - aa * 1.8, flameEdge + aa * 0.8, radius);
  float glow = 1.0 - smoothstep(flameEdge, flameEdge + band * 0.20 + aa, radius);
  float alpha = innerMask * max(body, glow * 0.28) * uIntensity;

  float along = clamp((radius - uInnerRadius) / max(aa, flameEdge - uInnerRadius), 0.0, 1.0);
  float flicker = 0.82 + 0.18 * sin(uTime * 8.0 + angle * 5.0 + fine * 6.28318);
  half3 ember = half3(0.92, 0.055, 0.004);
  half3 orange = half3(1.0, 0.27, 0.012);
  half3 gold = half3(1.0, 0.76, 0.08);
  half3 whiteHot = half3(1.0, 0.97, 0.70);
  half3 color = mix(orange, ember, half(along));
  color = mix(color, gold, half(pow(1.0 - along, 1.45)));
  color = mix(color, whiteHot, half(pow(1.0 - along, 4.2) * 0.88));
  color *= half(flicker);

  // Тонкий непрерывный раскалённый ободок не даёт пламени распасться на пятна.
  float rim = exp(-abs(radius - (uInnerRadius + aa * 1.5)) / max(aa, band * 0.075));
  alpha = max(alpha, rim * innerMask * 0.96 * uIntensity);
  color = mix(color, whiteHot, half(rim * 0.78));

  // Искры рождаются в новой случайной точке и выстреливают радиально наружу.
  // Это короткие вытянутые частицы, а не точки, вращающиеся по орбите.
  float sparks = 0.0;
  float sparkHeads = 0.0;
  for (int i = 0; i < 5; ++i) {
    float fi = float(i);
    float clock = uTime * (0.34 + hash11(fi + 3.7) * 0.24) + hash11(fi + 17.0) * 4.0;
    float burst = floor(clock);
    float phase = fract(clock);
    float seed = fi * 19.17 + burst * 7.31;
    float sparkAngle = 6.2831853 * hash11(seed + 31.0);
    float2 direction = float2(cos(sparkAngle), sin(sparkAngle));
    float2 tangent = float2(-direction.y, direction.x);
    float launchRadius = uInnerRadius + flameBand * (0.42 + hash11(seed + 9.0) * 0.28);
    float travel = band * phase * (0.72 + hash11(seed + 21.0) * 0.48);
    float sideKick = (hash11(seed + 41.0) - 0.5) * band * phase * phase * 0.24;
    float2 sparkPos = direction * (launchRadius + travel) + tangent * sideKick;

    float2 delta = p - sparkPos;
    float longitudinal = dot(delta, direction);
    float across = dot(delta, tangent);
    float streakLength = aa * (0.95 + hash11(seed + 47.0) * 1.45);
    // Отрезок [-streakLength, 0]: яркая головка и короткий хвост позади неё.
    float beyond = max(max(-longitudinal - streakLength, longitudinal), 0.0);
    float streakDistance = length(float2(across, beyond));
    float tailPosition = clamp(-longitudinal / max(aa, streakLength), 0.0, 1.0);
    float streakWidth = aa * (0.22 + hash11(seed + 53.0) * 0.16) * (1.0 - tailPosition * 0.48);
    float streak = 1.0 - smoothstep(streakWidth, streakWidth + aa * 0.82, streakDistance);
    float life = smoothstep(0.02, 0.10, phase) * (1.0 - smoothstep(0.56, 0.96, phase));
    sparks += streak * life * (1.0 - tailPosition * 0.74);
    float head = 1.0 - smoothstep(aa * 0.20, aa * 0.82, length(delta));
    sparkHeads += head * life;
  }
  sparks = clamp(sparks, 0.0, 1.0) * uIntensity;
  sparkHeads = clamp(sparkHeads, 0.0, 1.0) * uIntensity;
  half3 sparkOrange = half3(1.0, 0.34, 0.018);
  color = mix(color, sparkOrange, half(sparks));
  color = mix(color, whiteHot, half(sparkHeads * 0.72));
  alpha = max(alpha, sparks);
  alpha = max(alpha, sparkHeads);

  // Гарантированно прозрачный центр — фото никогда не тонируется шейдером.
  if (radius < uInnerRadius - aa * 0.5) return half4(0.0);
  return half4(color * half(alpha), half(alpha));
}
`;

/**
 * Ниже этого диаметра фото волосяной ободок не рисуем: он стоит в ~1.5 px от
 * раскалённого края пламени и на мини-аватаре читается как вторая рамка.
 */
const PHOTO_EDGE_MIN_HOLE = 72;

export function fireFrameOutset(avatarSize: number): number {
  // На мини-аватарах прежние 11.5% превращали огонь в тяжёлый ободок.
  // Вынос остаётся пропорциональным фото: 3 dp у 37 dp, 10 dp у 120 dp.
  return Math.max(2, Math.min(12, Math.round(Math.max(1, avatarSize) * 0.085)));
}

type FireAvatarFrameProps = {
  /** Полный квадрат вместе с языками пламени. */
  size: number;
  /** Диаметр фотографии в прозрачном центре. */
  photoSize: number;
  children?: React.ReactNode;
  active?: boolean;
  intensity?: number;
  style?: StyleProp<ViewStyle>;
  /** Первый кадр пламени уже на экране (не просто смонтирован). */
  onReady?: () => void;
};

function FireAvatarFrameInner({
  size,
  photoSize,
  children,
  active = true,
  intensity = 1,
  style,
  onReady,
}: FireAvatarFrameProps) {
  const side = Math.max(1, Math.round(size));
  const hole = Math.max(1, Math.min(side, Math.round(photoSize)));
  const inset = (side - hole) / 2;
  const effect = useMemo(() => Skia.RuntimeEffect.Make(FIRE_SKSL), []);
  const reduceMotion = useReducedMotion();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const elapsed = useSharedValue(0);
  const running = active && appActive && !reduceMotion;
  const { canvasRef, paintViewRef, requestPaintSignal } = useSkiaFirstPaint(onReady);
  const wantsReady = !!onReady;

  useEffect(() => {
    if (!wantsReady) return;
    // Без шейдера рисуется обычный View-ободок — он виден сразу.
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
    <View
      style={[
        styles.root,
        style,
        { width: side, height: side },
      ]}
    >
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
            <Fill>
              <Shader source={effect} uniforms={uniforms} />
            </Fill>
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

export const FireAvatarFrame = memo(FireAvatarFrameInner);

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
    borderColor: 'rgba(255,228,164,0.76)',
    zIndex: 4,
  },
  fallback: {
    borderColor: '#FF7A18',
    zIndex: 3,
  },
});
