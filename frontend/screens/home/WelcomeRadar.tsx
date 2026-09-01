import React, { useMemo } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Defs, Mask, RadialGradient, Stop } from 'react-native-svg';
import { AURA_GLOW, AURA_GRADIENT } from './constants';

type WelcomeRadarProps = {
  size: number;
  isDark: boolean;
  avatarRadius?: number;
  children: React.ReactNode;
};

const PEARL = '#FFF8F0';

/** Бирюза + синий + cyan + жемчуг — один тон для орбит. */
function mixOrbitBandColor(): string {
  const parts = [
    { hex: AURA_GRADIENT[0], w: 0.34 },
    { hex: AURA_GRADIENT[1], w: 0.32 },
    { hex: AURA_GRADIENT[2], w: 0.21 },
    { hex: PEARL, w: 0.13 },
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  for (const { hex, w } of parts) {
    const n = parseInt(hex.slice(1), 16);
    r += ((n >> 16) & 255) * w;
    g += ((n >> 8) & 255) * w;
    b += (n & 255) * w;
  }
  const h = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

const ORBIT_BAND_COLOR = mixOrbitBandColor();
/** 1-я орбита ярче, дальше слабее. */
const BAND_OPACITIES = [0.22, 0.15, 0.1, 0.04] as const;

/** 4 орбиты: зазор 1→2 < 2→3 < 3→4 (растущие «диаметры» между кольцами). */
function computeRingRadii(half: number, avatarR: number): number[] {
  const avatarOuter = avatarR + 2;
  const maxOuter = half * 0.9;
  const step0 = 0.72;
  const step12 = 1.08;
  const step23 = 1.32;
  const step34 = 1.14;
  const total = step0 + step12 + step23 + step34;
  const g = Math.max(half * 0.078, (maxOuter - avatarOuter) / total);
  const r1 = avatarOuter + g * step0;
  const r2 = r1 + g * step12;
  const r3 = r2 + g * step23;
  const r4 = r3 + g * step34;
  return [r1, r2, r3, r4];
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + Math.cos(rad) * r, y: cy + Math.sin(rad) * r };
}

/** Час на циферблате → угол для SVG (0° = 3h, по часовой). */
function clockHourToDeg(hour: number): number {
  return hour * 30 - 90;
}

/**
 * По одной точке на орбите r1…r4 — как на скрине: 10h, 8h, 6h, 2h.
 */
const DOT_SPECS: ReadonlyArray<{ ring: number; hour: number; r: number }> = [
  { ring: 0, hour: 11, r: 3.2 },
  { ring: 1, hour: 8, r: 3.2 },
  { ring: 2, hour: 5, r: 3.2 },
  { ring: 3, hour: 2, r: 3.2 },
];

function buildCenterHaloStops(avatarOuter: number, haloR: number): Array<{ offset: number; color: string; opacity: number }> {
  const avatarT = Math.min(0.98, avatarOuter / haloR);
  return [
    { offset: 0, color: ORBIT_BAND_COLOR, opacity: 0 },
    { offset: avatarT * 0.92, color: ORBIT_BAND_COLOR, opacity: 0.05 },
    { offset: avatarT, color: ORBIT_BAND_COLOR, opacity: 0.08 },
    { offset: Math.min(1, avatarT + 0.06), color: ORBIT_BAND_COLOR, opacity: 0.02 },
    { offset: 1, color: ORBIT_BAND_COLOR, opacity: 0 },
  ];
}

type OrbitBand = { id: string; innerR: number; outerR: number; opacity: number };

function buildOrbitBands(avatarOuter: number, ringRadii: number[]): OrbitBand[] {
  const bounds = [avatarOuter, ...ringRadii];
  return ringRadii.map((outerR, i) => ({
    id: `band-${i}`,
    innerR: bounds[i] ?? avatarOuter,
    outerR,
    opacity: BAND_OPACITIES[i] ?? BAND_OPACITIES[3],
  }));
}

export function WelcomeRadar({ size, avatarRadius, children }: WelcomeRadarProps) {
  const [layoutSize, setLayoutSize] = React.useState(size);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setLayoutSize(w);
  };

  const s = layoutSize || size;
  const cx = s / 2;
  const cy = s / 2;
  const half = s / 2;

  const avatarR = avatarRadius ?? half * 0.38;
  const avatarOuter = avatarR + 2;
  const ringRadii = useMemo(() => computeRingRadii(half, avatarR), [avatarR, half]);
  const haloR = ringRadii[0] ?? avatarOuter + half * 0.08;

  const orbitBands = useMemo(
    () => buildOrbitBands(avatarOuter, ringRadii),
    [avatarOuter, ringRadii],
  );

  const haloStops = useMemo(
    () => buildCenterHaloStops(avatarOuter, haloR),
    [avatarOuter, haloR],
  );

  const dots = useMemo(() => {
    return DOT_SPECS.map((spec, i) => {
      const orbit = ringRadii[spec.ring] ?? ringRadii[0];
      const pt = polar(cx, cy, orbit, clockHourToDeg(spec.hour));
      return { key: i, ...pt, r: spec.r };
    });
  }, [cx, cy, ringRadii]);

  const uid = Math.round(s);
  const haloGradId = `radarCenterHalo-${uid}`;

  return (
    <View style={[styles.wrap, { width: s, height: s }]} onLayout={onLayout}>
      <Svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} pointerEvents="none">
        <Defs>
          <RadialGradient id={haloGradId} cx="50%" cy="50%" r="50%">
            {haloStops.map((stop, i) => (
              <Stop
                key={`${stop.offset}-${i}`}
                offset={`${(stop.offset * 100).toFixed(1)}%`}
                stopColor={stop.color}
                stopOpacity={stop.opacity}
              />
            ))}
          </RadialGradient>
          {orbitBands.map((band) => (
            <Mask key={band.id} id={`${band.id}-${uid}`}>
              <Circle cx={cx} cy={cy} r={band.outerR} fill="white" />
              <Circle cx={cx} cy={cy} r={band.innerR} fill="black" />
            </Mask>
          ))}
        </Defs>
        <Circle cx={cx} cy={cy} r={haloR} fill={`url(#${haloGradId})`} />
        {orbitBands.map((band) => (
          <Circle
            key={band.id}
            cx={cx}
            cy={cy}
            r={band.outerR}
            fill={ORBIT_BAND_COLOR}
            fillOpacity={band.opacity}
            mask={`url(#${band.id}-${uid})`}
          />
        ))}
        {dots.map((d) => (
          <React.Fragment key={d.key}>
            <Circle cx={d.x} cy={d.y} r={d.r + 3} fill={AURA_GLOW} fillOpacity={0.16} />
            <Circle cx={d.x} cy={d.y} r={d.r} fill={AURA_GRADIENT[2]} fillOpacity={0.88} />
          </React.Fragment>
        ))}
      </Svg>
      <View style={styles.center}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
