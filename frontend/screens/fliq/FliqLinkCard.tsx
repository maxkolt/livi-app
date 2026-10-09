// Карточка ролика в сообщении чата (YouTube / TikTok / Instagram): превью, название,
// источник. Тап — плеер поверх приложения (FliqViewerHost), долгое нажатие — меню сообщения.
import React, { memo, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { MESSAGE_LONG_PRESS_MS } from '../../constants/uiTokens';
import { UI_INACTIVE, WELCOME_HEADER_TITLE } from '../home/constants';
import { fetchFliqMeta, fliqSourceLabel, peekFliqMeta, type FliqLink, type FliqMeta } from './fliqLinks';
import { openFliqViewer } from './FliqViewerHost';

export const FLIQ_CARD_WIDTH = 210;
const THUMB_H = 262;

const SOURCE_ICON = {
  youtube: 'logo-youtube',
  tiktok: 'logo-tiktok',
  instagram: 'film-outline',
} as const;

export const FliqLinkCard = memo(function FliqLinkCard({
  link,
  onLongPress,
}: {
  link: FliqLink;
  onLongPress?: () => void;
}) {
  const [meta, setMeta] = useState<FliqMeta | undefined>(() => peekFliqMeta(link));
  const linkRef = useRef(link);
  linkRef.current = link;
  useEffect(() => {
    const cached = peekFliqMeta(linkRef.current);
    if (cached) {
      setMeta(cached);
      return;
    }
    let alive = true;
    void fetchFliqMeta(linkRef.current).then((m) => {
      if (alive) setMeta(m);
    });
    return () => {
      alive = false;
    };
  }, [link.url]);

  const label = fliqSourceLabel(link.source);
  return (
    <Pressable
      onPress={() => openFliqViewer(link)}
      onLongPress={onLongPress}
      delayLongPress={MESSAGE_LONG_PRESS_MS}
      accessibilityRole="button"
      accessibilityLabel={meta?.title ? `${label}: ${meta.title}` : label}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.thumb}>
        {meta?.thumb ? (
          <ExpoImage
            source={{ uri: meta.thumb }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={120}
          />
        ) : (
          <View style={styles.placeholder}>
            <Ionicons name={SOURCE_ICON[link.source]} size={40} color="rgba(255,255,255,0.28)" />
          </View>
        )}
        <View style={styles.playWrap} pointerEvents="none">
          <View style={styles.play}>
            <Ionicons name="play" size={24} color="#fff" style={styles.playIcon} />
          </View>
        </View>
        <View style={styles.badge} pointerEvents="none">
          <Ionicons name={SOURCE_ICON[link.source]} size={12} color="#fff" />
          <Text style={styles.badgeText}>{label}</Text>
        </View>
      </View>
      {meta?.title || meta?.author ? (
        <View style={styles.meta}>
          {meta?.title ? (
            <Text style={styles.title} numberOfLines={2}>
              {meta.title}
            </Text>
          ) : null}
          {meta?.author ? (
            <Text style={styles.author} numberOfLines={1}>
              {meta.author}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: {
    width: FLIQ_CARD_WIDTH,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.18)',
    marginBottom: 6,
  },
  pressed: { opacity: 0.85 },
  thumb: { width: FLIQ_CARD_WIDTH, height: THUMB_H, backgroundColor: '#1B2028' },
  placeholder: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  playWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  play: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20, 24, 31, 0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  playIcon: { marginLeft: 3 },
  badge: {
    position: 'absolute',
    left: 8,
    top: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(20, 24, 31, 0.6)',
  },
  badgeText: { color: '#fff', fontSize: 11 },
  meta: { paddingHorizontal: 10, paddingTop: 7, paddingBottom: 9, gap: 2 },
  title: { color: WELCOME_HEADER_TITLE, fontSize: 14, lineHeight: 18 },
  author: { color: UI_INACTIVE, fontSize: 12, lineHeight: 16 },
});
