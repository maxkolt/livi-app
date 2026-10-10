// Вкладка Fliq: вертикальная лента коротких роликов (YouTube Shorts) — свайп вверх/вниз.
//
// Скорость: плееры есть у текущего ролика, предыдущего и двух следующих; ближайший следующий
// заранее скачивает несколько секунд, затем готовится второй — последовательно, без деления
// канала. Первая страница ленты грузится ещё до открытия вкладки (warmFliqFeed).
// Пока плеер не дал первый кадр, поверх виден кадр-превью.
//
// Лента идёт под нижнее стекло навбара, как списки других вкладок: следующий ролик виден
// под ним размытым. Кнопки LiVi (звук, YouTube, сохранить, переслать) — ровным рядом под роликом,
// не поверх плеера: правила YouTube API запрещают перекрывать встроенный плеер.
//
// Пауза: ушли с вкладки — ролик встаёт и продолжает при возврате; если паузу поставил сам
// человек — при возврате ролик так и стоит на том же месте.
//
// Фон — «эмбиент» (FliqAmbient): свет от ролика вокруг карточки и тон всего экрана.
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type ViewToken,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import type { Lang } from '../../utils/i18n';
import {
  HOME_BLUR_LIST_SOURCE,
  UI_ACCENT,
  UI_INACTIVE,
  UI_RIM,
  UI_SURFACE,
  UI_SURFACE_RAISED,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
  isWelcomeTabletLayout,
} from '../home/constants';
import { WelcomeTabTitle } from '../home/WelcomeTabTitle';
import { GLASS_HEADER_BTN } from '../home/WelcomeGlassHeader';
import { useHomeLayout } from '../home/HomeLayoutContext';
import { useDigitalMediumFont } from '../home/brandFont';
import { BlurListSource } from '../../components/BackdropBlur';
import { useOverlayBackHandler } from '../../components/AppOverlay';
import { logger } from '../../utils/logger';
import { FliqYoutubePlayer, type FliqPlayMode, type FliqYoutubePlayerHandle } from './FliqPlayer';
import {
  fetchFliqFeed,
  flushFliqEvents,
  queueFliqEvent,
  reportFliqUnplayable,
  takeWarmFliqFeed,
  type FliqItem,
} from './fliqApi';
import { youtubeShareUrl, youtubeThumbUrl } from './fliqLinks';
import { useFliqTopics, type FliqTopic } from './fliqTopics';
import { useFliqSound } from './fliqSound';
import { fliqT } from './fliqI18n';
import { FliqShareSheet } from './FliqShareSheet';
import { FliqTopicsDialog } from './FliqTopicsDialog';
import { FliqAmbient } from './FliqAmbient';
import { FLIQ_PROGRESS_ROW_H, FliqProgressBar, useFliqProgress } from './FliqProgressBar';
import { FliqSavedView } from './FliqSavedView';
import { useFliqSaved } from './fliqSaved';

/** Подождать первый кадр, прежде чем показать «Видео не загружается». */
const STALL_MS = 10_000;
/** Сколько держать плееры после ухода с вкладки (вернулся быстро — ролик на месте). */
const KEEP_PLAYERS_MS = 30_000;
/** Человек сам остановил ролик — кадр держим дольше, чтобы вернуться ровно к нему. */
const KEEP_HELD_PLAYERS_MS = 10 * 60_000;
/** Ошибки IFrame API, после которых ролик пропускаем сами. */
const SKIP_ERROR_CODES = new Set([2, 5, 100, 101, 150]);
const PAGE_SIZE = 10;
const CARD_RADIUS = 22;

type WatchStat = { maxSec: number; durSec: number; loops: number };

type FliqFeedViewProps = {
  /** Вкладка видна, приложение на экране и нет звонка — только тогда ролик играет. */
  active: boolean;
  /** До первого открытия тихо подготовить WebView и медиабуфер первого ролика. */
  prewarm?: boolean;
  /** Прогрев завершён или неприменим (нет onboarding/роликов/сети). */
  onPrewarmSettled?: () => void;
  lang: Lang;
  /** Высота нижнего стекла с навбаром: лента уходит под него, ролик стоит над ним. */
  bottomInset: number;
  /** Системная строка сверху: вкладка (и свет от ролика) начинается от края экрана. */
  topInset: number;
};

export function FliqFeedView({
  active,
  prewarm = false,
  onPrewarmSettled,
  lang,
  bottomInset,
  topInset,
}: FliqFeedViewProps) {
  const { width, height } = useHomeLayout();
  const tablet = isWelcomeTabletLayout(width, height);
  const compact = !tablet && width > 0 && height > 0 && width / height > 1.05;

  const topics = useFliqTopics((s) => s.topics);
  const onboarded = useFliqTopics((s) => s.onboarded);
  const topicsHydrated = useFliqTopics((s) => s.hydrated);
  const hydrateTopics = useFliqTopics((s) => s.hydrate);
  const setTopics = useFliqTopics((s) => s.setTopics);
  const muted = useFliqSound((s) => s.muted);
  const setMuted = useFliqSound((s) => s.setMuted);
  const hydrateSound = useFliqSound((s) => s.hydrate);
  const savedItems = useFliqSaved((s) => s.items);
  const savedHydrated = useFliqSaved((s) => s.hydrated);
  const hydrateSaved = useFliqSaved((s) => s.hydrate);
  const toggleSaved = useFliqSaved((s) => s.toggle);

  const [items, setItems] = useState<FliqItem[]>([]);
  const itemsRef = useRef<FliqItem[]>([]);
  itemsRef.current = items;
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error' | 'empty'>('idle');
  const [activeIndex, setActiveIndex] = useState(0);
  const activeIndexRef = useRef(0);
  const [viewportH, setViewportH] = useState(0);
  const [topicsOpen, setTopicsOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  // prewarming одноразовый: после первого реального входа обычные правила паузы/выгрузки
  // снова действуют и скрытая вкладка не держит WebView бесконечно.
  const [prewarming, setPrewarming] = useState(prewarm && !active);
  const prewarmingRef = useRef(prewarming);
  prewarmingRef.current = prewarming;
  const prewarmSettledRef = useRef(false);
  const settlePrewarm = useCallback((reason: string) => {
    if (prewarmSettledRef.current) return;
    prewarmSettledRef.current = true;
    logger.info('[fliq] cold prewarm settled', { reason });
    onPrewarmSettled?.();
  }, [onPrewarmSettled]);
  const [keepPlayers, setKeepPlayers] = useState(active || prewarming);
  /** Ролик, который человек сам поставил на паузу (сбрасывается при свайпе). */
  const [heldId, setHeldId] = useState<string | null>(null);
  /** Ролик на экране уже показал первый кадр — можно подгружать следующий, не отнимая у него сеть. */
  const [startedId, setStartedId] = useState<string | null>(null);
  const startedIdRef = useRef(startedId);
  startedIdRef.current = startedId;
  /** Готовые скрытые ролики: второй следующий запускаем только после ближайшего, без конкуренции за сеть. */
  const [bufferedIds, setBufferedIds] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Ближайший следующий создаётся сразу, остальные соседи — когда текущий уже заиграл
   * (или через 4 с, чтобы не зависнуть при плохом ответе первого ролика).
   */
  const [neighborsOn, setNeighborsOn] = useState(false);
  const listRef = useRef<FlatList<FliqItem>>(null);
  const loadingRef = useRef(false);
  /** Сервер больше ничего не отдал — не долбим его догрузкой до смены тем. */
  const exhaustedAtRef = useRef(0);
  const watchRef = useRef(new Map<string, WatchStat>());
  /** Где остановились в каждом ролике: выгруженный плеер начнёт с этого места. */
  const positionRef = useRef(new Map<string, number>());

  useEffect(() => {
    void hydrateTopics();
    void hydrateSound();
    void hydrateSaved();
  }, [hydrateTopics, hydrateSound, hydrateSaved]);

  useOverlayBackHandler(active && savedOpen, () => setSavedOpen(false));

  useEffect(() => {
    if (active && prewarming) setPrewarming(false);
  }, [active, prewarming]);

  useEffect(() => {
    if (!prewarming) return;
    // Сеть/YouTube не должны навсегда удержать cold splash.
    const timer = setTimeout(() => settlePrewarm('deadline'), 13_500);
    return () => clearTimeout(timer);
  }, [prewarming, settlePrewarm]);

  useEffect(() => {
    if (!prewarming || !topicsHydrated) return;
    if (!onboarded) settlePrewarm('topics_required');
  }, [onboarded, prewarming, settlePrewarm, topicsHydrated]);

  useEffect(() => {
    if (!prewarming) return;
    if (status === 'error' || status === 'empty') settlePrewarm(status);
  }, [prewarming, settlePrewarm, status]);

  // Ушли на другую вкладку посреди ролика — по возвращении он стоит на паузе там же,
  // как после своей паузы: дальше по нажатию. Ещё не заигравший ролик просто запустится.
  useEffect(() => {
    if (active) return;
    const id = itemsRef.current[activeIndexRef.current]?.id;
    if (id && id === startedIdRef.current) setHeldId(id);
  }, [active]);

  useEffect(() => {
    if (active || prewarming) {
      setKeepPlayers(true);
      return;
    }
    void flushFliqEvents();
    const timer = setTimeout(() => setKeepPlayers(false), heldId ? KEEP_HELD_PLAYERS_MS : KEEP_PLAYERS_MS);
    return () => clearTimeout(timer);
  }, [active, heldId, prewarming]);

  const applyFirstPage = useCallback((first: FliqItem[]) => {
    watchRef.current.clear();
    positionRef.current.clear();
    activeIndexRef.current = 0;
    setActiveIndex(0);
    setHeldId(null);
    setStartedId(null);
    setBufferedIds(new Set());
    setNeighborsOn(false);
    setItems(first);
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    setStatus(first.length ? 'ready' : 'empty');
  }, []);

  const load = useCallback(
    async (reset: boolean) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      const t0 = Date.now();
      if (reset) {
        const warm = await takeWarmFliqFeed(lang, topics);
        if (warm?.length) {
          loadingRef.current = false;
          logger.info('[fliq] feed page from warm cache', { count: warm.length, ms: Date.now() - t0 });
          applyFirstPage(warm);
          return;
        }
        setStatus('loading');
      }
      const res = await fetchFliqFeed({
        lang,
        topics,
        exclude: reset ? [] : itemsRef.current.map((it) => it.id),
        limit: PAGE_SIZE,
      });
      loadingRef.current = false;
      logger.info('[fliq] feed page', { reset, ok: res.ok, count: res.items.length, error: res.error, ms: Date.now() - t0 });
      if (!res.ok) {
        if (reset || !itemsRef.current.length) setStatus('error');
        return;
      }
      if (!res.items.length) exhaustedAtRef.current = Date.now();
      if (reset) {
        applyFirstPage(res.items);
        return;
      }
      setItems((prev) => {
        const have = new Set(prev.map((it) => it.id));
        return prev.concat(res.items.filter((it) => !have.has(it.id)));
      });
    },
    [lang, topics, applyFirstPage],
  );

  // Ленту не грузим, пока вкладку ни разу не открыли.
  const [opened, setOpened] = useState(active || prewarming);
  useEffect(() => {
    if (active || prewarming) setOpened(true);
  }, [active, prewarming]);

  // Первое открытие: сперва темы, потом лента. Смена тем или языка — лента заново.
  useEffect(() => {
    if (!topicsHydrated || !opened) return;
    if (!onboarded) {
      setTopicsOpen(true);
      return;
    }
    exhaustedAtRef.current = 0;
    void load(true);
  }, [topicsHydrated, opened, onboarded, load]);

  // Догрузка, когда до конца ленты осталось несколько роликов.
  useEffect(() => {
    if (status !== 'ready') return;
    if (items.length - activeIndex > 4) return;
    if (exhaustedAtRef.current && Date.now() - exhaustedAtRef.current < 60_000) return;
    void load(false);
  }, [activeIndex, items.length, status, load]);

  const finalizeWatch = useCallback((id: string | undefined, shared = false) => {
    if (!id) return;
    const w = watchRef.current.get(id);
    watchRef.current.delete(id);
    const item = itemsRef.current.find((it) => it.id === id);
    const durSec = w?.durSec || item?.durationSec || 0;
    const watchedSec = (w?.loops || 0) * durSec + (w?.maxSec || 0);
    queueFliqEvent({ id, watchedMs: Math.round(watchedSec * 1000), durationMs: Math.round(durSec * 1000), shared });
  }, []);

  useEffect(
    () => () => {
      finalizeWatch(itemsRef.current[activeIndexRef.current]?.id);
      void flushFliqEvents();
    },
    [finalizeWatch],
  );

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems.find((v) => v.isViewable && typeof v.index === 'number');
    if (!first || first.index == null || first.index === activeIndexRef.current) return;
    const prevId = itemsRef.current[activeIndexRef.current]?.id;
    activeIndexRef.current = first.index;
    setActiveIndex(first.index);
    // Перелистнули — своя пауза больше не держит: вернулся к ролику — он играет.
    setHeldId(null);
    finalizeWatch(prevId);
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  const onProgress = useCallback((id: string, cur: number, dur: number) => {
    const w = watchRef.current.get(id) || { maxSec: 0, durSec: 0, loops: 0 };
    w.maxSec = Math.max(w.maxSec, cur);
    if (dur > 0) w.durSec = dur;
    watchRef.current.set(id, w);
    positionRef.current.set(id, cur);
  }, []);
  const onLoop = useCallback((id: string) => {
    const w = watchRef.current.get(id) || { maxSec: 0, durSec: 0, loops: 0 };
    w.loops += 1;
    w.maxSec = 0;
    watchRef.current.set(id, w);
  }, []);

  const goNext = useCallback((fromIndex: number) => {
    if (fromIndex !== activeIndexRef.current) return;
    const next = fromIndex + 1;
    if (next >= itemsRef.current.length) return;
    listRef.current?.scrollToIndex({ index: next, animated: true });
  }, []);

  const onPlayError = useCallback(
    (id: string, index: number, code: number) => {
      if (!SKIP_ERROR_CODES.has(code)) return;
      reportFliqUnplayable(id, code);
      setTimeout(() => goNext(index), 700);
    },
    [goNext],
  );

  const playbackOn = active && !savedOpen && !topicsOpen && !shareUrl;
  const playbackOnRef = useRef(playbackOn);
  playbackOnRef.current = playbackOn;

  /** Звук и пауза из самого плеера считаются, только если это ролик на экране. */
  const isOnScreen = useCallback(
    (index: number) => index === activeIndexRef.current && playbackOnRef.current,
    [],
  );
  const onMuteChange = useCallback(
    (index: number, m: boolean) => {
      if (isOnScreen(index)) setMuted(m);
    },
    [isOnScreen, setMuted],
  );
  const onUserPause = useCallback(
    (id: string, index: number) => {
      logger.info('[fliq] user pause', { id, onScreen: isOnScreen(index) });
      if (isOnScreen(index)) setHeldId(id);
    },
    [isOnScreen],
  );
  const onUserPlay = useCallback((id: string) => {
    setHeldId((prev) => (prev === id ? null : prev));
  }, []);
  const onStarted = useCallback((id: string) => {
    setStartedId(id);
    setNeighborsOn(true);
  }, []);
  const onBuffered = useCallback((id: string) => {
    setBufferedIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
    if (prewarmingRef.current && itemsRef.current[0]?.id === id) {
      settlePrewarm('buffered');
    }
  }, [settlePrewarm]);
  useEffect(() => {
    if (neighborsOn || status !== 'ready' || !active) return;
    const timer = setTimeout(() => setNeighborsOn(true), 4000);
    return () => clearTimeout(timer);
  }, [neighborsOn, status, active]);

  const onShare = useCallback((item: FliqItem) => {
    // Пересылка — сильный сигнал интереса к теме.
    queueFliqEvent({ id: item.id, watchedMs: 0, durationMs: item.durationSec * 1000, shared: true });
    setShareUrl(youtubeShareUrl(item.id));
  }, []);

  const savedIds = useMemo(() => new Set(savedItems.map((item) => item.id)), [savedItems]);

  const onTopicsDone = useCallback(
    (next: FliqTopic[]) => {
      setTopicsOpen(false);
      const same = next.length === topics.length && next.every((t) => topics.includes(t));
      if (same && onboarded) return;
      finalizeWatch(itemsRef.current[activeIndexRef.current]?.id);
      setTopics(next);
    },
    [finalizeWatch, onboarded, setTopics, topics],
  );

  const onListLayout = useCallback((e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (h > 0) setViewportH((prev) => (Math.abs(prev - h) < 1 ? prev : h));
  }, []);
  const [rootSize, setRootSize] = useState({ width: 0, height: 0 });
  const onRootLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setRootSize((prev) => (Math.abs(prev.width - w) < 1 && Math.abs(prev.height - h) < 1 ? prev : { width: w, height: h }));
  }, []);

  // Страница — видимая часть над стеклом навбара; под стеклом виден верх следующей.
  const pageH = Math.max(0, viewportH - bottomInset);
  const sideInset = tablet ? 24 : 14;
  const panelH = tablet ? 72 : 64;
  const cardMaxH = Math.max(0, pageH - panelH - FLIQ_PROGRESS_ROW_H - 8);
  const cardW = Math.max(0, Math.min(width - sideInset * 2, Math.floor((cardMaxH * 9) / 16)));
  const cardH = Math.floor((cardW * 16) / 9);
  const btnSize = tablet ? 44 : compact ? 32 : GLASS_HEADER_BTN;
  const headerH = tablet ? 56 : compact ? 40 : 48;
  // Кнопки шапки чуть ближе к центру, чем края карточки.
  const headerInset = sideInset + (tablet ? 14 : 10);
  // Карточка ролика в покое — там, откуда идёт свет (страница: карточка, полоса прогресса, панель — по центру).
  const ambientX = (rootSize.width - cardW) / 2;
  const ambientY = topInset + headerH + Math.max(0, (pageH - cardH - FLIQ_PROGRESS_ROW_H - panelH) / 2);
  const ambientCard = useMemo(
    () => ({ x: ambientX, y: ambientY, width: cardW, height: cardH }),
    [ambientX, ambientY, cardW, cardH],
  );
  const ambientUrl = !savedOpen && status === 'ready' && items[activeIndex] ? youtubeThumbUrl(items[activeIndex].id) : null;

  const renderItem = useCallback(
    ({ item, index }: { item: FliqItem; index: number }) => {
      const offset = index - activeIndex;
      const mode: FliqPlayMode =
        !playbackOn || offset !== 0 ? 'pause' : heldId === item.id ? 'hold' : 'play';
      const activeId = items[activeIndex]?.id;
      const nextId = items[activeIndex + 1]?.id;
      const mayPrebuffer = playbackOn && !!activeId && startedId === activeId;
      const prewarmCurrent = prewarming && offset === 0 && startedId == null;
      return (
        <FliqSlide
          item={item}
          index={index}
          lang={lang}
          pageH={pageH}
          cardW={cardW}
          cardH={cardH}
          panelH={panelH}
          // Ближайший WebView/API поднимается сразу; медиапоток пойдёт лишь после первого
          // кадра текущего. Предыдущий и второй следующий подключаются следом.
          mountPlayer={
            keepPlayers &&
            (prewarming
              ? offset === 0
              : offset === 0 || offset === 1 || (neighborsOn && offset >= -1 && offset <= 2))
          }
          mode={mode}
          prebuffer={
            prewarmCurrent ||
            (mayPrebuffer && (offset === 1 || (offset === 2 && !!nextId && bufferedIds.has(nextId))))
          }
          // Для первого входа достаточно секунды реального потока: WebView/API — основная
          // задержка, а короткий медиазапас уже убирает ожидание кадра после тапа.
          prebufferMs={prewarmCurrent ? 1200 : undefined}
          muted={muted}
          // Важно только при создании плеера: ролик на экране продолжает с места, где стоял.
          startSec={offset === 0 ? positionRef.current.get(item.id) || 0 : 0}
          onProgress={onProgress}
          onLoop={onLoop}
          onPlayError={onPlayError}
          onSkip={goNext}
          onShare={onShare}
          saved={savedIds.has(item.id)}
          onToggleSaved={toggleSaved}
          onMuteChange={onMuteChange}
          onToggleMute={setMuted}
          onUserPause={onUserPause}
          onUserPlay={onUserPlay}
          onStarted={onStarted}
          onBuffered={onBuffered}
        />
      );
    },
    [
      items,
      bufferedIds,
      neighborsOn,
      prewarming,
      startedId,
      onStarted,
      onBuffered,
      lang,
      pageH,
      cardW,
      cardH,
      panelH,
      keepPlayers,
      activeIndex,
      playbackOn,
      heldId,
      muted,
      onProgress,
      onLoop,
      onPlayError,
      goNext,
      onShare,
      savedIds,
      toggleSaved,
      onMuteChange,
      setMuted,
      onUserPause,
      onUserPlay,
    ],
  );

  return (
    // Вся вкладка — источник нижнего стекла: свет от ролика и уходящая под навбар карточка
    // видны под ним размытыми.
    <BlurListSource sourceId={HOME_BLUR_LIST_SOURCE.fliq} style={styles.root}>
      <View style={StyleSheet.absoluteFill} onLayout={onRootLayout} pointerEvents="none">
        <FliqAmbient url={ambientUrl} card={ambientCard} width={rootSize.width} height={rootSize.height} />
      </View>
      <View style={{ height: topInset }} />
      <View style={[styles.header, { height: headerH, paddingHorizontal: headerInset }]}>
        <WelcomeTabTitle
          label={savedOpen ? fliqT('savedTitle', lang) : 'Fliq'}
          tablet={tablet}
          compact={compact}
          sideInset={headerInset + btnSize}
        />
        {savedOpen ? (
          <Pressable
            onPress={() => setSavedOpen(false)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={fliqT('backToFeed', lang)}
            style={({ pressed }) => [
              styles.headerBackBtn,
              { width: btnSize, height: btnSize, borderRadius: btnSize / 2 },
              pressed && styles.headerBtnPressed,
            ]}
          >
            <Ionicons name="chevron-back" size={tablet ? 24 : 21} color={WELCOME_HEADER_TITLE} />
          </Pressable>
        ) : (
          <>
            {/* «Сохранённые» — у левого края, на месте кнопки «назад» из списка сохранённых. */}
            <Pressable
              onPress={() => setSavedOpen(true)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={fliqT('savedA11y', lang)}
              style={({ pressed }) => [
                styles.headerBtn,
                { width: btnSize, height: btnSize, borderRadius: btnSize / 2 },
                pressed && styles.headerBtnPressed,
              ]}
            >
              <Ionicons name="bookmark-outline" size={tablet ? 21 : 19} color={WELCOME_HEADER_TITLE} />
              {savedHydrated && savedItems.length > 0 ? (
                <View style={styles.savedBadge}>
                  <Text style={styles.savedBadgeText}>{savedItems.length > 99 ? '99+' : savedItems.length}</Text>
                </View>
              ) : null}
            </Pressable>
            <View style={styles.headerSpacer} />
            <Pressable
              onPress={() => setTopicsOpen(true)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={fliqT('topicsA11y', lang)}
              style={({ pressed }) => [
                styles.headerBtn,
                { width: btnSize, height: btnSize, borderRadius: btnSize / 2 },
                pressed && styles.headerBtnPressed,
              ]}
            >
              <Ionicons name="options-outline" size={tablet ? 22 : 19} color={WELCOME_HEADER_TITLE} />
            </Pressable>
          </>
        )}
      </View>

      <View style={styles.pager} onLayout={onListLayout}>
        {savedOpen ? (
          <FliqSavedView lang={lang} width={width} bottomInset={bottomInset} tablet={tablet} />
        ) : status === 'ready' && pageH > 0 ? (
            <FlatList
              ref={listRef}
              data={items}
              keyExtractor={(it) => it.id}
              renderItem={renderItem}
              extraData={renderItem}
              // Страница короче окна (низ под стеклом), поэтому шаг задаём сами, а не pagingEnabled.
              snapToInterval={pageH}
              snapToAlignment="start"
              disableIntervalMomentum
              decelerationRate="fast"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: bottomInset }}
              getItemLayout={(_, index) => ({ length: pageH, offset: pageH * index, index })}
              onViewableItemsChanged={onViewableItemsChanged}
              viewabilityConfig={viewabilityConfig}
              initialNumToRender={3}
              maxToRenderPerBatch={3}
              windowSize={5}
              removeClippedSubviews={false}
              onScrollToIndexFailed={() => {}}
            />
        ) : (
          <View style={[styles.pager, { paddingBottom: bottomInset }]}>
            {status === 'error' || status === 'empty' ? (
              <View style={styles.center}>
                <FliqMessage
                  icon={status === 'error' ? 'cloud-offline-outline' : 'film-outline'}
                  title={fliqT(status === 'error' ? 'loadFailed' : 'empty', lang)}
                  hint={status === 'error' ? fliqT('stalledHint', lang) : fliqT('emptyHint', lang)}
                  actionLabel={fliqT('retry', lang)}
                  onAction={() => void load(true)}
                />
              </View>
            ) : status === 'loading' ? (
              <View style={styles.center}>
                <ActivityIndicator color={UI_ACCENT} />
              </View>
            ) : null}
          </View>
        )}
      </View>

      <FliqTopicsDialog visible={topicsOpen} lang={lang} initial={topics} onDone={onTopicsDone} />
      <FliqShareSheet url={shareUrl} onClose={() => setShareUrl(null)} />
    </BlurListSource>
  );
}

type FliqSlideProps = {
  item: FliqItem;
  index: number;
  lang: Lang;
  pageH: number;
  cardW: number;
  cardH: number;
  panelH: number;
  mountPlayer: boolean;
  mode: FliqPlayMode;
  prebuffer: boolean;
  prebufferMs?: number;
  muted: boolean;
  startSec: number;
  onProgress: (id: string, cur: number, dur: number) => void;
  onLoop: (id: string) => void;
  onPlayError: (id: string, index: number, code: number) => void;
  onSkip: (index: number) => void;
  onShare: (item: FliqItem) => void;
  saved: boolean;
  onToggleSaved: (item: FliqItem) => void;
  onMuteChange: (index: number, muted: boolean) => void;
  onToggleMute: (muted: boolean) => void;
  onUserPause: (id: string, index: number) => void;
  onUserPlay: (id: string) => void;
  onStarted: (id: string) => void;
  onBuffered: (id: string) => void;
};

const FliqSlide = memo(function FliqSlide({
  item,
  index,
  lang,
  pageH,
  cardW,
  cardH,
  panelH,
  mountPlayer,
  mode,
  prebuffer,
  prebufferMs,
  muted,
  startSec,
  onProgress,
  onLoop,
  onPlayError,
  onSkip,
  onShare,
  saved,
  onToggleSaved,
  onMuteChange,
  onToggleMute,
  onUserPause,
  onUserPlay,
  onStarted,
  onBuffered,
}: FliqSlideProps) {
  const [firstFrame, setFirstFrame] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const coverOpacity = useRef(new Animated.Value(1)).current;
  const titleFont = useDigitalMediumFont();
  // Замеры: от появления плеера до готовности, подгрузки и первого кадра.
  const timingRef = useRef({ mountAt: 0, readyMs: 0, bufferedMs: 0, playAt: 0 });
  const playing = mode === 'play';

  useEffect(() => {
    if (mountPlayer) {
      timingRef.current = { mountAt: Date.now(), readyMs: 0, bufferedMs: 0, playAt: 0 };
      return;
    }
    // Плеер выгрузили — при следующем показе снова ждём первый кадр под превью.
    setFirstFrame(false);
    setStalled(false);
    coverOpacity.setValue(1);
  }, [mountPlayer, retryKey, coverOpacity]);

  useEffect(() => {
    if (playing && !timingRef.current.playAt) timingRef.current.playAt = Date.now();
  }, [playing]);

  useEffect(() => {
    if (!playing || firstFrame || stalled) return;
    const timer = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(timer);
  }, [playing, firstFrame, stalled, retryKey]);

  const handleReady = useCallback(() => {
    timingRef.current.readyMs = Date.now() - timingRef.current.mountAt;
    logger.info('[fliq] player ready', { id: item.id, readyMs: timingRef.current.readyMs });
  }, [item.id]);
  const handleBuffered = useCallback(() => {
    timingRef.current.bufferedMs = Date.now() - timingRef.current.mountAt;
    logger.info('[fliq] player buffered', {
      id: item.id,
      readyMs: timingRef.current.readyMs,
      bufferedMs: timingRef.current.bufferedMs,
    });
    onBuffered(item.id);
  }, [item.id, onBuffered]);
  const handleFirstFrame = useCallback(() => {
    const t = timingRef.current;
    logger.info('[fliq] first frame', {
      id: item.id,
      readyMs: t.readyMs,
      bufferedMs: t.bufferedMs,
      // От команды «играть» (свайп / открытие вкладки) до картинки — то, что видит человек.
      startMs: t.playAt ? Date.now() - t.playAt : null,
      sinceMountMs: Date.now() - t.mountAt,
    });
    setFirstFrame(true);
    setStalled(false);
    onStarted(item.id);
    Animated.timing(coverOpacity, { toValue: 0, duration: 100, useNativeDriver: true }).start();
  }, [coverOpacity, item.id, onStarted]);
  const playerRef = useRef<FliqYoutubePlayerHandle>(null);
  const { progress, onTick, reset: resetProgress, scrubber } = useFliqProgress(playing);
  const seek = useCallback((sec: number, final: boolean) => playerRef.current?.seek(sec, final), []);
  const handleProgress = useCallback(
    (c: number, d: number) => {
      onProgress(item.id, c, d);
      onTick(c, d);
    },
    [item.id, onProgress, onTick],
  );
  const handleLoop = useCallback(() => {
    resetProgress();
    onLoop(item.id);
  }, [item.id, onLoop, resetProgress]);
  useEffect(() => {
    if (!mountPlayer) resetProgress();
  }, [mountPlayer, resetProgress]);
  const handleMuteChange = useCallback((m: boolean) => onMuteChange(index, m), [index, onMuteChange]);
  const handleUserPause = useCallback(() => onUserPause(item.id, index), [item.id, index, onUserPause]);
  const handleUserPlay = useCallback(() => onUserPlay(item.id), [item.id, onUserPlay]);
  const handleError = useCallback(
    (code: number) => {
      // Не загрузился сам плеер (нет сети, упал процесс WebView) — предложить повтор.
      if (code === -1 || code === -2) setStalled(true);
      else onPlayError(item.id, index, code);
    },
    [item.id, index, onPlayError],
  );
  const retry = useCallback(() => {
    setStalled(false);
    setFirstFrame(false);
    coverOpacity.setValue(1);
    setRetryKey((k) => k + 1);
  }, [coverOpacity]);

  const actionGap = cardW < 220 ? 4 : 8;
  // «Переслать» остаётся широкой кнопкой, три круглых действия занимают место слева.
  // На низком landscape все размеры сжимаются и ряд не выходит за ширину видео.
  const shareWidth = Math.min(116, Math.max(1, Math.floor(cardW * (cardW < 180 ? 0.46 : 0.4))));
  const actionSize = Math.min(40, Math.max(1, Math.floor((cardW - shareWidth - actionGap * 3) / 3)));
  const actionIconSize = Math.max(1, Math.min(19, actionSize - 6));
  const shareHeight = Math.min(40, actionSize);
  const shareCompact = shareWidth < 82;
  return (
    <View style={[styles.slide, { height: pageH }]}>
      <View style={[styles.card, { width: cardW, height: cardH }]}>
        <ExpoImage
          source={{ uri: youtubeThumbUrl(item.id) }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={item.id}
        />
        {mountPlayer ? (
          <FliqYoutubePlayer
            key={retryKey}
            ref={playerRef}
            videoId={item.id}
            mode={mode}
            startSec={startSec}
            muted={muted}
            prebuffer={prebuffer}
            prebufferMs={prebufferMs}
            onReady={handleReady}
            onBuffered={handleBuffered}
            onFirstFrame={handleFirstFrame}
            onProgress={handleProgress}
            onLoop={handleLoop}
            onMuteChange={handleMuteChange}
            onUserPause={handleUserPause}
            onUserPlay={handleUserPlay}
            onError={handleError}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        {/* Превью поверх плеера только до первого кадра; касания проходят в плеер. */}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: coverOpacity }]}>
          <ExpoImage
            source={{ uri: youtubeThumbUrl(item.id) }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy="memory-disk"
            recyclingKey={`cover-${item.id}`}
          />
          {playing && !firstFrame && !stalled ? (
            <View style={styles.center}>
              <ActivityIndicator color="rgba(255,255,255,0.85)" />
            </View>
          ) : null}
        </Animated.View>
        {stalled && !firstFrame ? (
          <View style={styles.stalledShade}>
            <FliqMessage
              icon="cloud-offline-outline"
              title={fliqT('stalled', lang)}
              hint={fliqT('stalledHint', lang)}
              actionLabel={fliqT('retry', lang)}
              onAction={retry}
              secondaryLabel={fliqT('next', lang)}
              onSecondary={() => onSkip(index)}
            />
          </View>
        ) : null}
      </View>

      <FliqProgressBar
        progress={progress}
        width={cardW}
        scrubber={scrubber}
        onSeek={mountPlayer ? seek : undefined}
        style={styles.progressLow}
      />

      <View style={[styles.panel, { width: cardW, height: panelH, gap: actionGap }]}>
        <Pressable
          onPress={() => onToggleMute(!muted)}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={fliqT(muted ? 'soundOn' : 'soundOff', lang)}
          style={({ pressed }) => [
            styles.roundBtn,
            { width: actionSize, height: actionSize, borderRadius: actionSize / 2 },
            pressed && styles.roundBtnPressed,
          ]}
        >
          <Ionicons
            name={muted ? 'volume-mute-outline' : 'volume-high-outline'}
            size={actionIconSize}
            color={muted ? UI_ACCENT : UI_INACTIVE}
          />
        </Pressable>
        <Pressable
          onPress={() => Linking.openURL(`https://www.youtube.com/shorts/${item.id}`).catch(() => {})}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={fliqT('openIn', lang, { app: 'YouTube' })}
          style={({ pressed }) => [
            styles.roundBtn,
            { width: actionSize, height: actionSize, borderRadius: actionSize / 2 },
            pressed && styles.roundBtnPressed,
          ]}
        >
          <Ionicons name="logo-youtube" size={actionIconSize} color={UI_INACTIVE} />
        </Pressable>
        <Pressable
          onPress={() => onToggleSaved(item)}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityState={{ selected: saved }}
          accessibilityLabel={fliqT(saved ? 'removeSaved' : 'save', lang)}
          style={({ pressed }) => [
            styles.roundBtn,
            saved && styles.savedBtn,
            { width: actionSize, height: actionSize, borderRadius: actionSize / 2 },
            pressed && styles.roundBtnPressed,
          ]}
        >
          <Ionicons
            name={saved ? 'bookmark' : 'bookmark-outline'}
            size={actionIconSize}
            color={saved ? UI_ACCENT : UI_INACTIVE}
          />
        </Pressable>
        <Pressable
          onPress={() => onShare(item)}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={fliqT('share', lang)}
          style={({ pressed }) => [
            styles.shareBtn,
            {
              width: shareWidth,
              height: shareHeight,
              borderRadius: shareHeight / 2,
              paddingHorizontal: shareCompact ? 4 : 14,
              gap: shareCompact ? 3 : 7,
            },
            pressed && styles.shareBtnPressed,
          ]}
        >
          <Ionicons name="paper-plane-outline" size={Math.max(1, Math.min(17, shareHeight - 7))} color={UI_ACCENT} />
          <Text
            style={[styles.shareLabel, titleFont, shareCompact && styles.shareLabelCompact]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.5}
          >
            {fliqT('share', lang)}
          </Text>
        </Pressable>
      </View>
    </View>
  );
});

function FliqMessage({
  icon,
  title,
  hint,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  hint?: string;
  actionLabel: string;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <View style={styles.message}>
      <Ionicons name={icon} size={34} color={UI_INACTIVE} />
      <Text style={styles.messageTitle}>{title}</Text>
      {hint ? <Text style={styles.messageHint}>{hint}</Text> : null}
      <View style={styles.messageActions}>
        {secondaryLabel && onSecondary ? (
          <Pressable onPress={onSecondary} style={({ pressed }) => [styles.msgBtn, pressed && styles.roundBtnPressed]}>
            <Text style={styles.msgBtnLabel}>{secondaryLabel}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onAction} style={({ pressed }) => [styles.msgBtn, styles.msgBtnPrimary, pressed && styles.shareBtnPressed]}>
          <Text style={styles.msgBtnLabel}>{actionLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** «Переслать» — как «Найти собеседника»: лёгкий тон акцента и чёткая рамка, без яркой заливки. */
const SHARE_FILL = 'rgba(98, 176, 216, 0.16)';
const SHARE_PRESSED_FILL = 'rgba(98, 176, 216, 0.26)';
const SHARE_BORDER = 'rgba(98, 176, 216, 0.58)';

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerSpacer: { flex: 1 },
  headerBackBtn: { alignItems: 'center', justifyContent: 'center' },
  headerBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI_SURFACE_RAISED,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_RIM,
  },
  headerBtnPressed: { opacity: 0.7 },
  savedBadge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI_ACCENT,
    borderWidth: 1.5,
    borderColor: UI_SURFACE,
  },
  savedBadgeText: { color: '#17232B', fontSize: 9, lineHeight: 11, fontWeight: '800' },
  pager: { flex: 1, minHeight: 0 },
  // Полоса ближе к кнопкам, чем к ролику: видно, что она отдельно от видео.
  progressLow: { transform: [{ translateY: 4 }] },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  slide: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    borderRadius: CARD_RADIUS,
    overflow: 'hidden',
    backgroundColor: UI_SURFACE,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_RIM,
  },
  stalledShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(20, 24, 31, 0.78)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  roundBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI_SURFACE_RAISED,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_RIM,
  },
  roundBtnPressed: { opacity: 0.7 },
  savedBtn: { backgroundColor: 'rgba(98, 176, 216, 0.14)', borderColor: 'rgba(98, 176, 216, 0.52)' },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: SHARE_FILL,
    borderWidth: 1,
    borderColor: SHARE_BORDER,
  },
  shareBtnPressed: { backgroundColor: SHARE_PRESSED_FILL, transform: [{ scale: 0.97 }] },
  shareLabel: { flexShrink: 1, minWidth: 0, color: WELCOME_HEADER_TITLE, fontSize: 14 },
  shareLabelCompact: { fontSize: 11 },
  message: { alignItems: 'center', paddingHorizontal: 28, gap: 8 },
  messageTitle: { color: WELCOME_HEADER_TITLE, fontSize: 16, textAlign: 'center', marginTop: 4 },
  messageHint: { color: WELCOME_MUTED_TEXT, fontSize: 13, textAlign: 'center' },
  messageActions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  msgBtn: {
    height: 38,
    borderRadius: 19,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI_SURFACE_RAISED,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_RIM,
  },
  msgBtnPrimary: { backgroundColor: SHARE_FILL, borderWidth: 1, borderColor: SHARE_BORDER },
  msgBtnLabel: { color: WELCOME_HEADER_TITLE, fontSize: 14 },
});
