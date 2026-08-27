import React, { useEffect, useMemo } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Reanimated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

export type BrandConfettiOrigin = {
  x: number;
  y: number;
  size: number;
};

type PieceKind = 'tinsel' | 'spark' | 'flake' | 'streak';

type PieceSpec = {
  id: string;
  kind: PieceKind;
  w: number;
  h: number;
  color: string;
  ox: number;
  oy: number;
  vx: number;
  vy: number;
  g: number;
  life: number;
  rot0: number;
  spin: number;
  phase: number;
  flutterHz: number;
  flutterAmp: number;
  flipHz: number;
  opacity: number;
};

const COLORS_DARK = [
  '#14b8a6',
  '#2dd4bf',
  '#3b82f6',
  '#00b5ff',
  '#7dd3fc',
  '#FFF8F0',
  '#E8EEF7',
  '#AEB6C6',
];
const COLORS_LIGHT = [
  '#8f7ad8',
  '#9a7ad8',
  '#B0B5BF',
  '#FFF8F0',
  '#14b8a6',
  '#5b8def',
  '#e8def2',
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length) % list.length];
}

function buildPieces(seed: number, avatarSize: number, isDark: boolean): PieceSpec[] {
  const rand = mulberry32(seed || 1);
  const colors = isDark ? COLORS_DARK : COLORS_LIGHT;
  const count = Platform.OS === 'android' ? 46 : 62;
  const radius = Math.max(22, avatarSize * 0.46);
  const pieces: PieceSpec[] = [];

  for (let i = 0; i < count; i += 1) {
    const kindRoll = rand();
    const kind: PieceKind =
      kindRoll < 0.12 ? 'spark' : kindRoll < 0.22 ? 'streak' : kindRoll < 0.38 ? 'flake' : 'tinsel';
    const angle = rand() * Math.PI * 2;
    const radial = 0.25 + rand() * 0.75;
    const ox = Math.cos(angle) * radius * radial;
    const oy = Math.sin(angle) * radius * radial * 0.72;
    const burst = 160 + rand() * 380;
    const vx = Math.cos(angle) * burst * (0.3 + rand() * 0.75) + (rand() - 0.5) * 70;
    const up = kind === 'spark' || kind === 'streak' ? 320 : 210;
    const vy = Math.sin(angle) * burst * 0.2 - (up + rand() * 380);

    if (kind === 'tinsel') {
      pieces.push({
        id: `t-${i}`,
        kind,
        w: 2 + rand() * 2.4,
        h: 11 + rand() * 16,
        color: pick(rand, colors),
        ox,
        oy,
        vx,
        vy,
        g: 620 + rand() * 320,
        life: 2800 + rand() * 900,
        rot0: rand() * 360,
        spin: (rand() - 0.5) * 360,
        phase: rand() * Math.PI * 2,
        flutterHz: 4 + rand() * 5,
        flutterAmp: 14 + rand() * 22,
        flipHz: 5 + rand() * 7,
        opacity: 0.82 + rand() * 0.18,
      });
    } else if (kind === 'flake') {
      const s = 5 + rand() * 5;
      pieces.push({
        id: `f-${i}`,
        kind,
        w: s,
        h: s,
        color: pick(rand, colors),
        ox,
        oy,
        vx,
        vy,
        g: 540 + rand() * 260,
        life: 2600 + rand() * 800,
        rot0: 45,
        spin: (rand() - 0.5) * 200,
        phase: rand() * Math.PI * 2,
        flutterHz: 2.5 + rand() * 3.5,
        flutterAmp: 10 + rand() * 16,
        flipHz: 3 + rand() * 4,
        opacity: 0.78 + rand() * 0.22,
      });
    } else if (kind === 'streak') {
      pieces.push({
        id: `s-${i}`,
        kind,
        w: 1.6 + rand(),
        h: 12 + rand() * 18,
        color: pick(rand, colors),
        ox,
        oy,
        vx: vx * 1.25,
        vy: vy * 1.1,
        g: 280 + rand() * 140,
        life: 620 + rand() * 360,
        rot0: (Math.atan2(vy, vx) * 180) / Math.PI + 90,
        spin: (rand() - 0.5) * 40,
        phase: 0,
        flutterHz: 1,
        flutterAmp: 4,
        flipHz: 1,
        opacity: 0.9,
      });
    } else {
      const s = 3 + rand() * 3.2;
      pieces.push({
        id: `p-${i}`,
        kind,
        w: s,
        h: s,
        color: pick(rand, isDark ? ['#FFF8F0', '#7dd3fc', '#2dd4bf'] : ['#FFF8F0', '#8f7ad8', '#14b8a6']),
        ox,
        oy,
        vx: vx * 1.15,
        vy: vy * 1.02,
        g: 420 + rand() * 180,
        life: 780 + rand() * 520,
        rot0: 0,
        spin: 0,
        phase: 0,
        flutterHz: 2,
        flutterAmp: 6,
        flipHz: 1,
        opacity: 1,
      });
    }
  }

  return pieces;
}

function settleMs(pieces: PieceSpec[]) {
  // Частицы гаснут с ~76% life — перелив стартуем чуть раньше полного конца.
  const lives = pieces.map((p) => p.life).sort((a, b) => a - b);
  const idx = Math.min(lives.length - 1, Math.floor(lives.length * 0.88));
  return Math.round(lives[idx] * 0.8);
}

type PieceProps = {
  originX: number;
  originY: number;
  spec: PieceSpec;
};

const ConfettiPiece = React.memo(function ConfettiPiece({ originX, originY, spec }: PieceProps) {
  const progress = useSharedValue(0);
  const life = spec.life;
  const ox = spec.ox;
  const oy = spec.oy;
  const vx = spec.vx;
  const vy = spec.vy;
  const g = spec.g;
  const w = spec.w;
  const h = spec.h;
  const rot0 = spec.rot0;
  const spin = spec.spin;
  const phase = spec.phase;
  const flutterHz = spec.flutterHz;
  const flutterAmp = spec.flutterAmp;
  const flipHz = spec.flipHz;
  const baseOpacity = spec.opacity;
  const isTinsel = spec.kind === 'tinsel';

  useEffect(() => {
    progress.value = 0;
    progress.value = withTiming(1, {
      duration: life,
      easing: Easing.linear,
    });
    return () => {
      cancelAnimation(progress);
    };
  }, [life, progress]);

  const style = useAnimatedStyle(() => {
    const t = progress.value;
    const sec = t * (life / 1000);
    const flutter = Math.sin(phase + sec * flutterHz) * flutterAmp * Math.min(1, t * 1.6);
    const x = originX + ox + vx * sec + flutter;
    const y = originY + oy + vy * sec + 0.5 * g * sec * sec;
    const rot = rot0 + spin * sec;
    const flip = isTinsel
      ? Math.max(0.18, Math.abs(Math.cos(phase + sec * flipHz)))
      : 1;
    const fadeIn = Math.min(1, t / 0.05);
    const fadeOut = t > 0.76 ? Math.max(0, (1 - t) / 0.24) : 1;
    return {
      opacity: fadeIn * fadeOut * baseOpacity,
      transform: [
        { translateX: x - w / 2 },
        { translateY: y - h / 2 },
        { rotate: `${rot}deg` },
        { scaleX: flip },
      ],
    };
  });

  return (
    <Reanimated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: 0,
          top: 0,
          width: spec.w,
          height: spec.h,
          backgroundColor: spec.color,
          borderRadius:
            spec.kind === 'spark' ? spec.w / 2 : spec.kind === 'flake' ? 1.2 : spec.w * 0.45,
          borderWidth: spec.kind === 'tinsel' || spec.kind === 'flake' ? StyleSheet.hairlineWidth : 0,
          borderColor: 'rgba(255,255,255,0.42)',
        },
        style,
      ]}
    />
  );
});

type FlashProps = {
  originX: number;
  originY: number;
  avatarSize: number;
  isDark: boolean;
};

function BurstFlash({ originX, originY, avatarSize, isDark }: FlashProps) {
  const core = useSharedValue(0);
  const ringA = useSharedValue(0);
  const ringB = useSharedValue(0);

  useEffect(() => {
    core.value = 0;
    ringA.value = 0;
    ringB.value = 0;
    core.value = withTiming(1, { duration: 340, easing: Easing.out(Easing.cubic) });
    ringA.value = withTiming(1, { duration: 520, easing: Easing.out(Easing.cubic) });
    ringB.value = withDelay(80, withTiming(1, { duration: 680, easing: Easing.out(Easing.quad) }));
    return () => {
      cancelAnimation(core);
      cancelAnimation(ringA);
      cancelAnimation(ringB);
    };
  }, [core, ringA, ringB]);

  const coreSize = avatarSize * 0.72;
  const ringSize = avatarSize * 1.05;

  const coreStyle = useAnimatedStyle(() => ({
    opacity: interpolate(core.value, [0, 0.18, 1], [0.9, 0.55, 0]),
    transform: [{ scale: interpolate(core.value, [0, 1], [0.28, 1.18]) }],
  }));

  const ringAStyle = useAnimatedStyle(() => ({
    opacity: interpolate(ringA.value, [0, 0.12, 1], [0.7, 0.45, 0]),
    transform: [{ scale: interpolate(ringA.value, [0, 1], [0.55, 1.85]) }],
  }));

  const ringBStyle = useAnimatedStyle(() => ({
    opacity: interpolate(ringB.value, [0, 0.2, 1], [0, 0.4, 0]),
    transform: [{ scale: interpolate(ringB.value, [0, 1], [0.7, 2.25]) }],
  }));

  const coreColor = isDark ? 'rgba(255,248,240,0.92)' : 'rgba(255,255,255,0.88)';
  const ringColorA = isDark ? 'rgba(0,181,255,0.85)' : 'rgba(143,122,216,0.8)';
  const ringColorB = isDark ? 'rgba(20,184,166,0.7)' : 'rgba(255,248,240,0.75)';

  return (
    <>
      <Reanimated.View
        pointerEvents="none"
        style={[
          styles.flashCircle,
          {
            width: coreSize,
            height: coreSize,
            borderRadius: coreSize / 2,
            backgroundColor: coreColor,
            left: originX - coreSize / 2,
            top: originY - coreSize / 2,
          },
          coreStyle,
        ]}
      />
      <Reanimated.View
        pointerEvents="none"
        style={[
          styles.flashRing,
          {
            width: ringSize,
            height: ringSize,
            borderRadius: ringSize / 2,
            borderColor: ringColorA,
            left: originX - ringSize / 2,
            top: originY - ringSize / 2,
          },
          ringAStyle,
        ]}
      />
      <Reanimated.View
        pointerEvents="none"
        style={[
          styles.flashRing,
          {
            width: ringSize,
            height: ringSize,
            borderRadius: ringSize / 2,
            borderColor: ringColorB,
            left: originX - ringSize / 2,
            top: originY - ringSize / 2,
          },
          ringBStyle,
        ]}
      />
    </>
  );
}

export type HomeBrandConfettiProps = {
  burstId: number;
  origin: BrandConfettiOrigin;
  isDark: boolean;
  onComplete: (burstId: number) => void;
};

export const HomeBrandConfetti: React.FC<HomeBrandConfettiProps> = ({
  burstId,
  origin,
  isDark,
  onComplete,
}) => {
  const pieces = useMemo(
    () => buildPieces(burstId, origin.size, isDark),
    [burstId, origin.size, isDark],
  );

  useEffect(() => {
    const wait = settleMs(pieces);
    const timer = setTimeout(() => onComplete(burstId), wait);
    return () => clearTimeout(timer);
  }, [burstId, onComplete, pieces]);

  return (
    <View pointerEvents="none" style={styles.overlay}>
      <BurstFlash
        originX={origin.x}
        originY={origin.y}
        avatarSize={origin.size}
        isDark={isDark}
      />
      {pieces.map((spec) => (
        <ConfettiPiece
          key={spec.id}
          originX={origin.x}
          originY={origin.y}
          spec={spec}
        />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 40,
    elevation: 40,
  },
  flashCircle: {
    position: 'absolute',
  },
  flashRing: {
    position: 'absolute',
    backgroundColor: 'transparent',
    borderWidth: 2,
  },
});
