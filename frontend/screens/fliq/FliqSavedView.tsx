// Коллекция сохранённых роликов Fliq: компактная сетка, просмотр и удаление.
import React, { memo, useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import type { Lang } from '../../utils/i18n';
import {
  UI_ACCENT,
  UI_RIM,
  UI_SURFACE,
  UI_SURFACE_RAISED,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
} from '../home/constants';
import { useDigitalMediumFont } from '../home/brandFont';
import { youtubeThumbUrl } from './fliqLinks';
import { fliqT } from './fliqI18n';
import { useFliqSaved, type SavedFliqItem } from './fliqSaved';
import { FliqSavedViewer } from './FliqSavedViewer';

type Props = {
  lang: Lang;
  width: number;
  bottomInset: number;
  tablet: boolean;
};

function cleanTitle(title: string): string {
  return String(title || '')
    .replace(/#[^\s#]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function FliqSavedView({ lang, width, bottomInset, tablet }: Props) {
  const items = useFliqSaved((s) => s.items);
  const hydrated = useFliqSaved((s) => s.hydrated);
  const remove = useFliqSaved((s) => s.remove);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const columns = tablet ? 3 : 2;
  const sideInset = tablet ? 24 : 14;
  const gap = tablet ? 14 : 10;
  const cardW = Math.max(0, Math.floor((width - sideInset * 2 - gap * (columns - 1)) / columns));

  const renderItem = useCallback(
    ({ item }: { item: SavedFliqItem }) => (
      <SavedCard
        item={item}
        lang={lang}
        width={cardW}
        onOpen={() => setViewerIndex(items.findIndex((saved) => saved.id === item.id))}
        onRemove={remove}
      />
    ),
    [cardW, items, lang, remove],
  );

  if (!hydrated) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={UI_ACCENT} />
      </View>
    );
  }

  if (!items.length) {
    return (
      <View style={styles.empty}>
        <View style={styles.emptyIcon}>
          <Ionicons name="bookmark-outline" size={30} color={UI_ACCENT} />
        </View>
        <Text style={styles.emptyTitle}>{fliqT('savedEmpty', lang)}</Text>
        <Text style={styles.emptyHint}>{fliqT('savedEmptyHint', lang)}</Text>
      </View>
    );
  }

  return (
    <>
      <FlatList
        key={`saved-${columns}`}
        data={items}
        numColumns={columns}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        columnWrapperStyle={{ gap }}
        contentContainerStyle={{ paddingHorizontal: sideInset, paddingTop: 10, paddingBottom: bottomInset + 18, gap }}
        initialNumToRender={8}
        windowSize={7}
      />
      {viewerIndex != null && viewerIndex >= 0 ? (
        <FliqSavedViewer items={items} initialIndex={viewerIndex} lang={lang} onClose={() => setViewerIndex(null)} />
      ) : null}
    </>
  );
}

const SavedCard = memo(function SavedCard({
  item,
  lang,
  width,
  onOpen,
  onRemove,
}: {
  item: SavedFliqItem;
  lang: Lang;
  width: number;
  onOpen: () => void;
  onRemove: (id: string) => void;
}) {
  const titleFont = useDigitalMediumFont();
  const title = cleanTitle(item.title);
  return (
    <View style={[styles.card, { width }]}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={fliqT('playSaved', lang)}
        style={({ pressed }) => [styles.preview, { height: Math.round((width * 16) / 9) }, pressed && styles.pressed]}
      >
        <ExpoImage
          source={{ uri: youtubeThumbUrl(item.id) }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={`saved-${item.id}`}
        />
        <View style={styles.previewShade} />
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(7,10,15,0)', 'rgba(7,10,15,0.88)']}
          locations={[0, 1]}
          style={styles.captionGradient}
        />
        <View style={styles.playIcon}>
          <Ionicons name="play" size={20} color={WELCOME_HEADER_TITLE} style={styles.playGlyph} />
        </View>
        {title || item.author ? (
          <View style={styles.caption} pointerEvents="none">
            {title ? (
              <Text style={[styles.cardTitle, titleFont]} numberOfLines={2}>
                {title}
              </Text>
            ) : null}
            {item.author ? <Text style={styles.cardAuthor} numberOfLines={1}>{item.author}</Text> : null}
          </View>
        ) : null}
      </Pressable>
      <Pressable
        onPress={() => onRemove(item.id)}
        hitSlop={7}
        accessibilityRole="button"
        accessibilityLabel={fliqT('removeSaved', lang)}
        style={({ pressed }) => [styles.removeBtn, pressed && styles.removePressed]}
      >
        <Ionicons name="trash-outline" size={17} color="#FF7A83" />
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, paddingBottom: 48 },
  emptyIcon: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(98, 176, 216, 0.13)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(98, 176, 216, 0.42)',
    marginBottom: 16,
  },
  emptyTitle: { color: WELCOME_HEADER_TITLE, fontSize: 17, textAlign: 'center' },
  emptyHint: { color: WELCOME_MUTED_TEXT, fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 7 },
  card: {
    borderRadius: 20,
    overflow: 'visible',
    backgroundColor: UI_SURFACE,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_RIM,
  },
  preview: { borderRadius: 20, overflow: 'hidden', backgroundColor: UI_SURFACE },
  pressed: { opacity: 0.82, transform: [{ scale: 0.985 }] },
  previewShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(7, 10, 15, 0.12)' },
  captionGradient: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 118 },
  playIcon: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 42,
    height: 42,
    marginLeft: -21,
    marginTop: -21,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(36, 43, 52, 0.82)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  playGlyph: { marginLeft: 2 },
  caption: { position: 'absolute', left: 10, right: 10, bottom: 10, paddingTop: 28 },
  cardTitle: { color: '#F4F5F7', fontSize: 13, lineHeight: 17 },
  cardAuthor: { color: 'rgba(244,245,247,0.68)', fontSize: 11, marginTop: 3 },
  removeBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(36, 43, 52, 0.90)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  removePressed: { backgroundColor: UI_SURFACE_RAISED, transform: [{ scale: 0.92 }] },
});
