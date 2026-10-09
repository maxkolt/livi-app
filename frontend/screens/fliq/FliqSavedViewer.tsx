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
import { HOME_NAV_BG, UI_ACCENT, UI_INACTIVE, WELCOME_HEADER_TITLE } from '../home/constants';
import { FliqYoutubePlayer, type FliqPlayMode, type FliqYoutubePlayerHandle } from './FliqPlayer';
import { FliqProgressBar, useFliqProgress } from './FliqProgressBar';
import { fliqT } from './fliqI18n';
import { youtubeThumbUrl } from './fliqLinks';
import type { SavedFliqItem } from './fliqSaved';
import { useFliqSound } from './fliqSound';

/** Блок над роликом — в нём крестик. */
const TOP_BLOCK_H = 36;
/** Блок под роликом — звук слева и полоса времени. */
const CONTROLS_H = 26;
/** Отступ иконок блоков от края ролика. */
const CONTROLS_PAD = 8;
const ICON_BOX = 32;

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

  // Ролик по центру экрана, но так, чтобы над ним поместился блок с крестиком, а под ним —
  // звук и полоса времени: на низком экране ролик для этого чуть меньше.
  const availableH = Math.max(0, height - insets.top - insets.bottom - TOP_BLOCK_H - CONTROLS_H);
  const cardW = Math.max(0, Math.min(width, Math.floor((availableH * 9) / 16)));
  const cardH = Math.floor((cardW * 16) / 9);
  const cardTop = Math.min(
    Math.max((height - cardH) / 2, insets.top + TOP_BLOCK_H),
    height - insets.bottom - CONTROLS_H - cardH,
  );
  const cardBottom = cardTop + cardH;
  const controlsTop = cardBottom + (height - insets.bottom - cardBottom - CONTROLS_H) / 2;
  const closeTop = insets.top + (cardTop - insets.top - ICON_BOX) / 2;
  const sideGap = Math.max(0, (width - cardW) / 2);
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
          cardTop={cardTop}
          controlsTop={controlsTop}
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
      cardTop,
      cardW,
      controlsTop,
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
            { top: closeTop, right: Math.max(insets.right, sideGap) + CONTROLS_PAD },
            pressed && styles.iconPressed,
          ]}
        >
          <Ionicons name="close" size={27} color={WELCOME_HEADER_TITLE} />
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
  cardTop,
  controlsTop,
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
  cardTop: number;
  controlsTop: number;
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
  const playerRef = useRef<FliqYoutubePlayerHandle>(null);
  const { progress, onTick, reset: resetProgress, scrubber } = useFliqProgress(mode === 'play');
  const seek = useCallback((sec: number, final: boolean) => playerRef.current?.seek(sec, final), []);
  useEffect(() => {
    if (!mountPlayer) resetProgress();
  }, [mountPlayer, resetProgress]);

  useEffect(() => {
    if (mode === 'play' && firstFrame) onStarted(item.id);
  }, [firstFrame, item.id, mode, onStarted]);

  return (
    <View style={[styles.page, { height, paddingTop: cardTop }]}>
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
            ref={playerRef}
            videoId={item.id}
            mode={mode}
            muted={muted}
            prebuffer={prebuffer}
            onBuffered={handleBuffered}
            onFirstFrame={revealPlayer}
            onProgress={onTick}
            onLoop={resetProgress}
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
      </View>
      <View style={[styles.controlsRow, { top: controlsTop }]}>
        <View style={[styles.controls, { width: cardW }]}>
          <Pressable
            onPress={() => onMuteChange(!muted)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={fliqT(muted ? 'soundOn' : 'soundOff', lang)}
            style={({ pressed }) => [styles.soundBtn, pressed && styles.iconPressed]}
          >
            <Ionicons
              name={muted ? 'volume-mute-outline' : 'volume-high-outline'}
              size={21}
              color={muted ? UI_ACCENT : UI_INACTIVE}
            />
          </Pressable>
          <FliqProgressBar
            progress={progress}
            width={Math.max(0, cardW - CONTROLS_PAD * 2 - ICON_BOX)}
            scrubber={scrubber}
            onSeek={mountPlayer ? seek : undefined}
          />
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, backgroundColor: HOME_NAV_BG },
  page: { alignItems: 'center', backgroundColor: HOME_NAV_BG },
  video: { overflow: 'hidden', backgroundColor: '#000' },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  controlsRow: { position: 'absolute', zIndex: 4, left: 0, right: 0, alignItems: 'center' },
  controls: {
    height: CONTROLS_H,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: CONTROLS_PAD,
  },
  soundBtn: { width: ICON_BOX, height: ICON_BOX, alignItems: 'center', justifyContent: 'center' },
  closeBtn: {
    position: 'absolute',
    zIndex: 5,
    width: ICON_BOX,
    height: ICON_BOX,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconPressed: { opacity: 0.6 },
});
