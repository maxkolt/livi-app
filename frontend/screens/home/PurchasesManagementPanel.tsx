import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import AdaptiveText from '../../components/AdaptiveText';
import { setActiveCosmetic, useCosmetics, type CosmeticKind } from '../../utils/cosmetics';
import { LIVI, WELCOME_GLASS_BORDER, WELCOME_GLASS_SURFACE, WELCOME_MUTED_TEXT } from './constants';

const SHOWCASE_AVATAR = require('../../assets/frames/showcase-avatar.jpg');

const FRAME_LABELS: Record<string, string> = {
  fire: 'Огонь',
  diamond: 'Бриллиант',
  aurora: 'Аврора',
  palladium: 'Палладий',
  frost: 'Лёд',
  jade: 'Нефрит',
  void: 'Опал',
  obsidian: 'Обсидиан',
};

const FRAME_COLORS: Record<string, readonly [string, string, ...string[]]> = {
  fire: ['#FFC062', '#FF8A34', '#FF4D1C'],
  diamond: ['#E8F6FF', '#9ED0FF', '#6AA9FF'],
  aurora: ['#7CF5C8', '#5AA9FF', '#3B82F6'],
  palladium: ['#F2F4F7', '#C5CCD6', '#8B93A0'],
  frost: ['#D9F4FF', '#7EC8E8', '#4A9BC7'],
  jade: ['#B8F0D0', '#3DCF8E', '#1B8F5A'],
  void: ['#D4B5FF', '#7B5CFF', '#2A1B4A'],
  obsidian: ['#6B7280', '#374151', '#111827'],
};

const BACKGROUND_LABELS: Record<string, string> = {
  'aurora-chat': 'Неон',
  'deep-space': 'Космос',
  poetry: 'Пушкин',
  'ocean-flow': 'Бирюза',
  'graphite-chat': 'Письма',
};

const BACKGROUND_IMAGES: Record<string, number> = {
  'aurora-chat': require('../../assets/chat-wallpapers/dark/doodles-cyan.jpeg'),
  'deep-space': require('../../assets/chat-wallpapers/dark/cosmos.jpeg'),
  poetry: require('../../assets/chat-wallpapers/dark/pushkin.jpeg'),
  'ocean-flow': require('../../assets/chat-wallpapers/dark/doodles-teal.jpeg'),
  'graphite-chat': require('../../assets/chat-wallpapers/dark/letters.jpeg'),
};

function FramePreview({ itemId }: { itemId: string }) {
  const colors = FRAME_COLORS[itemId];
  if (!colors) return <View style={styles.emptyFrame} />;
  return (
    <LinearGradient
      colors={colors as [string, string, ...string[]]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.frameSwatch}
    >
      <ExpoImage source={SHOWCASE_AVATAR} style={styles.frameAvatar} contentFit="cover" cachePolicy="memory-disk" />
    </LinearGradient>
  );
}

function BackgroundPreview({ itemId }: { itemId: string }) {
  const source = BACKGROUND_IMAGES[itemId];
  if (!source) return <View style={styles.emptyBackground} />;
  return (
    <View style={styles.backgroundSwatch}>
      <ExpoImage source={source} style={StyleSheet.absoluteFillObject} contentFit="cover" cachePolicy="memory-disk" />
      <View style={styles.backgroundPreviewBorder} pointerEvents="none" />
    </View>
  );
}

function EmptyPurchase({ kind }: { kind: CosmeticKind }) {
  return (
    <View style={styles.emptyRow}>
      <View style={kind === 'frame' ? styles.emptyFrame : styles.emptyBackground} />
      <View style={styles.copy}>
        <AdaptiveText style={styles.emptyTitle}>
          {kind === 'frame' ? 'Рамок пока нет' : 'Фонов пока нет'}
        </AdaptiveText>
        <AdaptiveText style={styles.emptyHint}>Купленные варианты появятся здесь.</AdaptiveText>
      </View>
    </View>
  );
}

export function PurchasesManagementPanel() {
  const cosmetics = useCosmetics();
  const [busyKey, setBusyKey] = useState('');

  const toggle = async (kind: CosmeticKind, itemId: string, active: boolean) => {
    const key = `${kind}:${itemId}`;
    if (busyKey) return;
    setBusyKey(key);
    try {
      await setActiveCosmetic(kind, active ? '' : itemId);
    } finally {
      setBusyKey('');
    }
  };

  const renderItem = (kind: CosmeticKind, itemId: string) => {
    const active = kind === 'frame' ? cosmetics.activeFrameId === itemId : cosmetics.activeBackgroundId === itemId;
    return (
      <View key={`${kind}:${itemId}`} style={styles.itemRow}>
        {kind === 'frame' ? <FramePreview itemId={itemId} /> : <BackgroundPreview itemId={itemId} />}
        <AdaptiveText style={styles.itemLabel} numberOfLines={1}>
          {kind === 'frame' ? FRAME_LABELS[itemId] || itemId : BACKGROUND_LABELS[itemId] || itemId}
        </AdaptiveText>
        <Pressable
          onPress={() => void toggle(kind, itemId, active)}
          disabled={!!busyKey}
          style={({ pressed }) => [styles.action, active && styles.actionActive, pressed && styles.actionPressed]}
        >
          <AdaptiveText style={[styles.actionText, active && styles.actionTextActive]}>
            {busyKey === `${kind}:${itemId}` ? '…' : active ? 'Снять' : 'Применить'}
          </AdaptiveText>
        </Pressable>
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.section}>
        <AdaptiveText style={styles.sectionTitle}>РАМКИ АВАТАРА</AdaptiveText>
        <View style={styles.card}>
          {cosmetics.purchasedFrameIds.length
            ? cosmetics.purchasedFrameIds.map((id) => renderItem('frame', id))
            : <EmptyPurchase kind="frame" />}
        </View>
      </View>
      <View style={styles.section}>
        <AdaptiveText style={styles.sectionTitle}>ФОНЫ ЧАТА</AdaptiveText>
        <View style={styles.card}>
          {cosmetics.purchasedBackgroundIds.length
            ? cosmetics.purchasedBackgroundIds.map((id) => renderItem('background', id))
            : <EmptyPurchase kind="background" />}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 24, gap: 18 },
  section: { gap: 8 },
  sectionTitle: { color: WELCOME_MUTED_TEXT, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginLeft: 4 },
  card: {
    borderRadius: 16,
    backgroundColor: WELCOME_GLASS_SURFACE,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
    overflow: 'hidden',
  },
  emptyRow: { minHeight: 76, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 12 },
  emptyFrame: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: 'rgba(180,186,196,0.42)',
    backgroundColor: 'rgba(180,186,196,0.08)',
  },
  emptyBackground: {
    width: 52,
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(180,186,196,0.38)',
    backgroundColor: 'rgba(180,186,196,0.08)',
  },
  copy: { flex: 1, minWidth: 0 },
  emptyTitle: { color: LIVI.text, fontSize: 14, fontWeight: '600' },
  emptyHint: { marginTop: 2, color: WELCOME_MUTED_TEXT, fontSize: 12 },
  itemRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 12 },
  framePreviewBox: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  frameSwatch: {
    width: 42,
    height: 42,
    borderRadius: 21,
    padding: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frameAvatar: { width: 37, height: 37, borderRadius: 18.5 },
  backgroundSwatch: {
    width: 54,
    height: 38,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#111923',
  },
  backgroundPreviewBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(238,229,244,0.72)',
  },
  itemLabel: { flex: 1, minWidth: 0, color: LIVI.text, fontSize: 14, fontWeight: '600' },
  action: {
    minWidth: 86,
    minHeight: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: 'rgba(238,229,244,0.55)',
    backgroundColor: 'rgba(238,229,244,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  actionActive: { borderColor: 'rgba(176,186,200,0.38)', backgroundColor: 'rgba(176,186,200,0.06)' },
  actionPressed: { opacity: 0.72 },
  actionText: { color: '#EDE6F1', fontSize: 12, fontWeight: '700' },
  actionTextActive: { color: WELCOME_MUTED_TEXT },
});
