import React from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { t, type Lang } from '../utils/i18n';

export type BuiltInStickerAnimation = 'none' | 'bounce' | 'pulse' | 'wiggle';

export type BuiltInSticker = {
  id: string;
  packId: string;
  packName: string;
  emoji: string;
  label: string;
  accent: string;
  animation: BuiltInStickerAnimation;
};

export const BUILT_IN_STICKER_PACKS: Array<{
  id: string;
  name: string;
  icon: string;
  stickers: BuiltInSticker[];
}> = [
  {
    id: 'moodies',
    name: 'Moodies',
    icon: '😊',
    stickers: [
      { id: 'moodies-happy', packId: 'moodies', packName: 'Moodies', emoji: '😊', label: 'Happy', accent: '#FFD166', animation: 'bounce' },
      { id: 'moodies-love', packId: 'moodies', packName: 'Moodies', emoji: '😍', label: 'Love', accent: '#FF6B8A', animation: 'pulse' },
      { id: 'moodies-wow', packId: 'moodies', packName: 'Moodies', emoji: '😮', label: 'Wow', accent: '#8ECAE6', animation: 'none' },
      { id: 'moodies-laugh', packId: 'moodies', packName: 'Moodies', emoji: '😂', label: 'Laugh', accent: '#F4A261', animation: 'wiggle' },
      { id: 'moodies-sleep', packId: 'moodies', packName: 'Moodies', emoji: '😴', label: 'Sleepy', accent: '#A8DADC', animation: 'none' },
      { id: 'moodies-fire', packId: 'moodies', packName: 'Moodies', emoji: '🔥', label: 'Fire', accent: '#F77F00', animation: 'pulse' },
    ],
  },
  {
    id: 'tiny-pals',
    name: 'Tiny Pals',
    icon: '🐾',
    stickers: [
      { id: 'tiny-pals-cat', packId: 'tiny-pals', packName: 'Tiny Pals', emoji: '🐱', label: 'Cat', accent: '#BDE0FE', animation: 'wiggle' },
      { id: 'tiny-pals-dog', packId: 'tiny-pals', packName: 'Tiny Pals', emoji: '🐶', label: 'Dog', accent: '#FFC8A2', animation: 'bounce' },
      { id: 'tiny-pals-panda', packId: 'tiny-pals', packName: 'Tiny Pals', emoji: '🐼', label: 'Panda', accent: '#D8E2DC', animation: 'none' },
      { id: 'tiny-pals-fox', packId: 'tiny-pals', packName: 'Tiny Pals', emoji: '🦊', label: 'Fox', accent: '#FFB703', animation: 'pulse' },
      { id: 'tiny-pals-frog', packId: 'tiny-pals', packName: 'Tiny Pals', emoji: '🐸', label: 'Frog', accent: '#95D5B2', animation: 'bounce' },
      { id: 'tiny-pals-unicorn', packId: 'tiny-pals', packName: 'Tiny Pals', emoji: '🦄', label: 'Unicorn', accent: '#CDB4DB', animation: 'wiggle' },
    ],
  },
];

const STICKERS_BY_ID = BUILT_IN_STICKER_PACKS.reduce<Record<string, BuiltInSticker>>((acc, pack) => {
  for (const sticker of pack.stickers) acc[sticker.id] = sticker;
  return acc;
}, {});

export function getBuiltInSticker(stickerId?: string): BuiltInSticker | undefined {
  const id = String(stickerId || '').trim();
  return id ? STICKERS_BY_ID[id] : undefined;
}

export function getStickerFallbackText(sticker?: Partial<BuiltInSticker> | null, langCode?: string): string {
  const lang = (langCode || 'ru') as Lang;
  const label = String(sticker?.label || (sticker as any)?.stickerLabel || '').trim();
  if (label) return t('chatStickerFallbackNamed', lang).replace('{label}', label);
  return t('chatStickerFallback', lang);
}

/**
 * Свой ритм для каждого стикера, выведенный из его id.
 *
 * Нужен только чтобы прилёт не выглядел залпом, когда на экране сразу несколько
 * стикеров. Хеш от id даёт устойчивый разброс задержки: один и тот же стикер
 * всегда прилетает одинаково, но не в такт соседям.
 */
function stickerRhythm(id: string): { duration: number; delay: number; overshoot: number } {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return {
    duration: 520 + (h % 270),
    delay: (h >>> 8) % 380,
    overshoot: 1.1 + ((h >>> 16) % 7) / 100,
  };
}

export function StickerView({
  stickerId,
  sticker,
  size = 96,
  animated = true,
  isDark = true,
}: {
  stickerId?: string;
  sticker?: BuiltInSticker;
  size?: number;
  animated?: boolean;
  isDark?: boolean;
}) {
  const resolved = sticker || getBuiltInSticker(stickerId);
  const progress = React.useRef(new Animated.Value(0)).current;
  /** Прилёт: 0 — ещё нет, 1 — на месте. */
  const enter = React.useRef(new Animated.Value(animated ? 0 : 1)).current;
  const rhythm = stickerRhythm(resolved?.id || 'x');

  React.useEffect(() => {
    if (!animated || !resolved) {
      enter.setValue(1);
      progress.stopAnimation();
      progress.setValue(0);
      return;
    }

    // Стикер должен прилетать, а не просто оказываться на экране: момент
    // появления — половина ощущения от стикера.
    const entrance = Animated.spring(enter, {
      toValue: 1,
      damping: 11,
      stiffness: 190,
      mass: 0.7,
      useNativeDriver: true,
    });

    const run = Animated.sequence([Animated.delay(rhythm.delay), entrance]);
    run.start();
    return () => {
      run.stop();
      progress.stopAnimation();
    };
  }, [animated, enter, progress, rhythm.delay, resolved?.id]);

  if (!resolved) {
    return (
      <View style={[styles.sticker, { width: size, height: size, borderRadius: size * 0.28, backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)' }]}>
        <Text style={{ fontSize: Math.round(size * 0.42) }}>?</Text>
      </View>
    );
  }

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, resolved.animation === 'bounce' ? -size * 0.09 : 0],
  });
  const idleScale = progress.interpolate({
    inputRange: [0, 1],
    // Амплитуда пульса своя у каждого стикера — иначе одинаковые эмодзи
    // выглядят как один повторённый элемент.
    outputRange: [1, resolved.animation === 'pulse' ? rhythm.overshoot : 1],
  });
  const rotate = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', resolved.animation === 'wiggle' ? '8deg' : '0deg'],
  });
  const haloOpacity = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.28, resolved.animation === 'pulse' ? 0.5 : 0.34],
  });

  // Прилёт домножается на дыхание: одна общая шкала вместо двух подряд в
  // transform, чтобы порядок применения не зависел от платформы.
  const enterScale = enter.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });
  const scale = Animated.multiply(enterScale, idleScale);
  const enterOpacity = enter.interpolate({ inputRange: [0, 0.55, 1], outputRange: [0, 1, 1] });

  return (
    <Animated.View
      style={[
        styles.sticker,
        {
          width: size,
          height: size,
          opacity: enterOpacity,
          transform: [{ translateY }, { scale }, { rotate }],
        },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          styles.halo,
          {
            borderRadius: size * 0.3,
            backgroundColor: resolved.accent,
            opacity: haloOpacity,
          },
        ]}
      />
      <View
        style={[
          styles.card,
          {
            borderRadius: size * 0.28,
            borderColor: isDark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.10)',
            backgroundColor: isDark ? 'rgba(20,24,30,0.92)' : 'rgba(255,255,255,0.92)',
          },
        ]}
      >
        <Text style={{ fontSize: Math.round(size * 0.46), lineHeight: Math.round(size * 0.56) }}>{resolved.emoji}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sticker: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    ...StyleSheet.absoluteFillObject,
    transform: [{ rotate: '-8deg' }],
  },
  card: {
    width: '82%',
    height: '82%',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
});
