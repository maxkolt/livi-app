// Полноэкранный просмотр сохранённых Fliq: только ролик, вертикальный свайп и закрытие.
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  FlatList,
  Pressable,
  StyleSheet,
  View,
  type ViewToken,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Portal } from 'react-native-paper';
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Lang } from '../../utils/i18n';
import { useOverlayBackHandler } from '../../components/AppOverlay';
import { HOME_NAV_BG, UI_ACCENT, UI_INACTIVE, UI_RIM, UI_SURFACE_RAISED, WELCOME_HEADER_TITLE } from '../home/constants';
import { FliqYoutubePlayer, type FliqPlayMode } from './FliqPlayer';
import { fliqT } from './fliqI18n';
import { youtubeThumbUrl } from './fliqLinks';
import type { SavedFliqItem } from './fliqSaved';
import { useFliqSound } from './fliqSound';

type Props = {
  items: SavedFliqItem[];
  initialIndex: number;
  lang: Lang;
  onClose: () => void;
};

export function FliqSavedViewer({ items, initialIndex, lang, onClose }: Props) {
  const { width, height } = useSafeAreaFrame();
  const insets = useSafeAreaInsets();
  const muted = useFliqSound((s) => s.muted);
  const setMuted = useFliqSound((s) => s.setMuted);
  const hydrateSound = useFliqSound((s) => s.hydrate);
  const safeInitialIndex = Math.max(0, Math.min(initialIndex, Math.max(0, items.length - 1)));
  const [activeIndex, setActiveIndex] = useState(safeInitialIndex);
  const activeIndexRef = useRef(safeInitialIndex);
  const [heldId, setHeldId] = useState<string | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [bufferedIds, setBufferedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');

  useOverlayBackHandler(true, onClose);

  useEffect(() => {
    void hydrateSound();
  }, [hydrateSound]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => sub.remove();
  }, []);

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems.find((entry) => entry.isViewable && typeof entry.index === 'number');
    if (first?.index == null) return;
    if (first.index === activeIndexRef.current) return;
    activeIndexRef.current = first.index;
    setActiveIndex(first.index);
    setHeldId(null);
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  const availableH = Math.max(0, height - insets.top - insets.bottom);
  const cardW = Math.max(0, Math.min(width, Math.floor((availableH * 9) / 16)));
  const cardH = Math.floor((cardW * 16) / 9);
  const cardTop = Math.max(0, (height - cardH) / 2);
  const activeId = items[activeIndex]?.id;
  const onStarted = useCallback((id: string) => setStartedId(id), []);
  const onBuffered = useCallback((id: string) => {
    setBufferedIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: SavedFliqItem; index: number }) => {
      const offset = index - activeIndex;
      const mode: FliqPlayMode =
        !appActive || offset !== 0 ? 'pause' : heldId === item.id ? 'hold' : 'play';
      const nextId = items[activeIndex + 1]?.id;
      const mayPrebuffer = appActive && !!activeId && startedId === activeId;
      return (
        <SavedViewerSlide
          item={item}
          lang={lang}
          height={height}
          cardW={cardW}
          cardH={cardH}
          mountPlayer={offset === 0 || offset === 1 || (startedId === activeId && offset >= -1 && offset <= 2)}
          mode={mode}
          muted={muted}
          prebuffer={mayPrebuffer && (offset === 1 || (offset === 2 && !!nextId && bufferedIds.has(nextId)))}
          onMuteChange={setMuted}
          onUserPause={() => setHeldId(item.id)}
          onUserPlay={() => setHeldId((current) => (current === item.id ? null : current))}
          onStarted={onStarted}
          onBuffered={onBuffered}
        />
      );
    },
    [
      activeId,
      activeIndex,
      appActive,
      bufferedIds,
      cardH,
      cardW,
      height,
      heldId,
      items,
      muted,
      onBuffered,
      onStarted,
      setMuted,
      startedId,
    ],
  );

  if (!items.length || width <= 0 || height <= 0) return null;

  return (
    <Portal>
      <View style={styles.root}>
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          extraData={renderItem}
          initialScrollIndex={safeInitialIndex}
          getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
          pagingEnabled
          snapToInterval={height}
          snapToAlignment="start"
          disableIntervalMomentum
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          initialNumToRender={3}
          maxToRenderPerBatch={4}
          windowSize={7}
          removeClippedSubviews={false}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          onScrollToIndexFailed={() => {}}
        />
        <Pressable
          onPress={onClose}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={fliqT('close', lang)}
          style={({ pressed }) => [
            styles.closeBtn,
            { top: Math.max(insets.top + 10, cardTop + 10), right: insets.right + 14 },
            pressed && styles.closePressed,
          ]}
        >
          <Ionicons name="close" size={23} color={WELCOME_HEADER_TITLE} />
        </Pressable>
      </View>
    </Portal>
  );
}

const SavedViewerSlide = memo(function SavedViewerSlide({
  item,
  lang,
  height,
  cardW,
  cardH,
  mountPlayer,
  mode,
  muted,
  prebuffer,
  onMuteChange,
  onUserPause,
  onUserPlay,
  onStarted,
  onBuffered,
}: {
  item: SavedFliqItem;
  lang: Lang;
  height: number;
  cardW: number;
  cardH: number;
  mountPlayer: boolean;
  mode: FliqPlayMode;
  muted: boolean;
  prebuffer: boolean;
  onMuteChange: (muted: boolean) => void;
  onUserPause: () => void;
  onUserPlay: () => void;
  onStarted: (id: string) => void;
  onBuffered: (id: string) => void;
}) {
  const [firstFrame, setFirstFrame] = useState(false);
  const coverOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (mountPlayer) return;
    setFirstFrame(false);
    coverOpacity.setValue(1);
  }, [coverOpacity, mountPlayer]);

  const revealPlayer = useCallback(() => {
    if (firstFrame) return;
    setFirstFrame(true);
    onStarted(item.id);
    Animated.timing(coverOpacity, { toValue: 0, duration: 100, useNativeDriver: true }).start();
  }, [coverOpacity, firstFrame, item.id, onStarted]);

  const handleBuffered = useCallback(() => onBuffered(item.id), [item.id, onBuffered]);

  useEffect(() => {
    if (mode === 'play' && firstFrame) onStarted(item.id);
  }, [firstFrame, item.id, mode, onStarted]);

  return (
    <View style={[styles.page, { height }]}>
      <View style={[styles.video, { width: cardW, height: cardH }]}>
        <ExpoImage
          source={{ uri: youtubeThumbUrl(item.id) }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={`saved-viewer-${item.id}`}
        />
        {mountPlayer ? (
          <FliqYoutubePlayer
            videoId={item.id}
            mode={mode}
            muted={muted}
            prebuffer={prebuffer}
            onBuffered={handleBuffered}
            onFirstFrame={revealPlayer}
            onMuteChange={onMuteChange}
            onUserPause={onUserPause}
            onUserPlay={onUserPlay}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: coverOpacity }]}>
          <ExpoImage
            source={{ uri: youtubeThumbUrl(item.id) }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy="memory-disk"
            recyclingKey={`saved-viewer-cover-${item.id}`}
          />
          {mode === 'play' && !firstFrame ? (
            <View style={styles.loading}>
              <ActivityIndicator color="rgba(255,255,255,0.86)" />
            </View>
          ) : null}
        </Animated.View>
        <Pressable
          onPress={() => onMuteChange(!muted)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={fliqT(muted ? 'soundOn' : 'soundOff', lang)}
          style={({ pressed }) => [styles.soundBtn, pressed && styles.soundPressed]}
        >
          <Ionicons
            name={muted ? 'volume-mute-outline' : 'volume-high-outline'}
            size={23}
            color={muted ? UI_ACCENT : UI_INACTIVE}
          />
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, backgroundColor: HOME_NAV_BG },
  page: { alignItems: 'center', justifyContent: 'center', backgroundColor: HOME_NAV_BG },
  video: { overflow: 'hidden', backgroundColor: '#000' },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  soundBtn: {
    position: 'absolute',
    zIndex: 4,
    left: 28,
    bottom: 8,
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI_SURFACE_RAISED,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_RIM,
  },
  soundPressed: { opacity: 0.76, transform: [{ scale: 0.96 }] },
  closeBtn: {
    position: 'absolute',
    zIndex: 5,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(36, 43, 52, 0.88)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_RIM,
  },
  closePressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
});
