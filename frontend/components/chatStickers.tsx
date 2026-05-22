import React from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

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
  const label = String(sticker?.label || (sticker as any)?.stickerLabel || '').trim();
  if (label) return langCode === 'ru' ? `[Стикер: ${label}]` : `[Sticker: ${label}]`;
  return langCode === 'ru' ? '[Стикер]' : '[Sticker]';
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

  React.useEffect(() => {
    if (!animated || !resolved || resolved.animation === 'none') {
      progress.stopAnimation();
      progress.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, { toValue: 1, duration: 620, useNativeDriver: true }),
        Animated.timing(progress, { toValue: 0, duration: 620, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animated, progress, resolved?.id, resolved?.animation]);

  if (!resolved) {
    return (
      <View style={[styles.sticker, { width: size, height: size, borderRadius: size * 0.28, backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)' }]}>
        <Text style={{ fontSize: Math.round(size * 0.42) }}>?</Text>
      </View>
    );
  }

  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [0, resolved.animation === 'bounce' ? -8 : 0] });
  const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [1, resolved.animation === 'pulse' ? 1.1 : 1] });
  const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', resolved.animation === 'wiggle' ? '8deg' : '0deg'] });
  const haloOpacity = progress.interpolate({ inputRange: [0, 1], outputRange: [0.28, resolved.animation === 'pulse' ? 0.5 : 0.34] });

  return (
    <Animated.View
      style={[
        styles.sticker,
        {
          width: size,
          height: size,
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
