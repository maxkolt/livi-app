// Вкладка Fliq: вертикальная лента коротких роликов (YouTube Shorts) — свайп вверх/вниз.
//
// Скорость: плееры есть у текущего ролика, предыдущего и двух следующих; ближайший следующий
// заранее скачивает несколько секунд, затем готовится второй — последовательно, без деления
// канала. Первая страница ленты грузится ещё до открытия вкладки (warmFliqFeed).
// Пока плеер не дал первый кадр, поверх виден кадр-превью.
//
// Листается только сам ролик: рамка карточки, полоса прогресса и кнопки LiVi (звук, YouTube,
// сохранить, переслать) стоят на месте, ролики сменяют друг друга внутри рамки. Кнопки — ровным
// рядом под роликом, не поверх плеера: правила YouTube API запрещают перекрывать встроенный плеер.
// Полоса прогресса появляется, когда ролик на экране пошёл, и прячется, пока следующий грузится.
//
// Пауза: ушли с вкладки — ролик встаёт и продолжает при возврате; если паузу поставил сам
// человек — при возврате ролик так и стоит на том же месте.
//
// Фон — «эмбиент» (FliqAmbient): свет от ролика вокруг карточки и тон всего экрана.
import React, { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Linking,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewToken,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Defs, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import type { Lang } from '../../utils/i18n';
import {
  HOME_BLUR_LIST_SOURCE,
  UI_ACCENT,
  UI_GLASS_CONTROL,
  UI_INACTIVE,
  UI_RIM,
  UI_SURFACE,
  UI_SURFACE_RAISED,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
  isWelcomeTabletLayout,
} from '../home/constants';
import { WelcomeTabTitle } from '../home/WelcomeTabTitle';
import { GLASS_HEADER_BTN } from '../home/WelcomeGlassHeader';
import {
  WELCOME_CHROME_BTN_SHADOW,
  WELCOME_CHROME_BTN_SHADOW_IOS,
  WelcomeFloatShadow,
} from '../home/WelcomeFloatShadow';
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
import { FliqAmbient, prefetchFliqAmbient } from './FliqAmbient';
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
/** Свет вокруг рамки перетекает к въезжающему ролику, когда тот занял эту долю рамки. */
const AMBIENT_SWITCH_AT = 0.2;
/** Animated.attachNativeEvent — есть в RN (AnimatedImplementation), но не в его типах. */
const attachNativeEvent = (
  Animated as unknown as {
    attachNativeEvent: (view: unknown, eventName: string, argMapping: unknown[]) => { detach: () => void };
  }
).attachNativeEvent;
/** Низкий landscape: круглые кнопки в ряду под карточкой и высота этого ряда. */
const WIDE_BTN = 36;
const WIDE_PANEL_H = 48;
type WatchStat = { maxSec: number; durSec: number; loops: number };

/** Фирменный YouTube с мягким линзовым объёмом. */
const FliqYoutubeIcon = memo(function FliqYoutubeIcon({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
      <Defs>
        <RadialGradient id="youtubeLens" cx="38%" cy="30%" rx="78%" ry="90%">
          <Stop offset="0" stopColor="#E06476" />
          <Stop offset="0.38" stopColor="#C83D55" />
          <Stop offset="0.78" stopColor="#A92F43" />
          <Stop offset="1" stopColor="#772331" />
        </RadialGradient>
      </Defs>
      <Rect x="1" y="4" width="22" height="16" rx="5" fill="url(#youtubeLens)" />
      <Path d="M9.7 8.55 16.1 12l-6.4 3.45Z" fill="#FFFFFF" />
    </Svg>
  );
});

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
  /** От низа вкладки до середины блока навбара: оттуда начинается лента под ним. */
  navMidFromBottom: number;
  /** Системная строка сверху: вкладка (и свет от ролика) начинается от края экрана. */
  topInset: number;
};

export function FliqFeedView({
  active,
  prewarm = false,
  onPrewarmSettled,
  lang,
  bottomInset,
  navMidFromBottom,
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
  /**
   * Ролик, от которого свет вокруг рамки, — по самой ленте: въезжающий, как только занял
   * AMBIENT_SWITCH_AT рамки, а не когда стал активным (60%, плюс загрузка превью).
   */
  const [ambientLead, setAmbientLead] = useState<number | null>(null);
  const lastScrollYRef = useRef(0);
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
  /**
   * Прокрутка ленты на нативном драйвере — по ней едет её продолжение под навбаром. Событие
   * цепляется к ленте один раз: через onScroll у Animated.FlatList оно отцеплялось и цеплялось
   * заново на каждой перерисовке ленты (а она перерисовывается посреди свайпа).
   */
  const scrollY = useRef(new Animated.Value(0)).current;
  const scrollLinkRef = useRef<{ detach: () => void } | null>(null);
  const setListRef = useCallback(
    (list: FlatList<FliqItem> | null) => {
      listRef.current = list;
      scrollLinkRef.current?.detach();
      scrollLinkRef.current = null;
      const scroller = list?.getNativeScrollRef();
      if (!scroller) return;
      // Новая лента начинает с нуля — и её продолжение тоже.
      scrollY.setValue(0);
      scrollLinkRef.current = attachNativeEvent(scroller, 'onScroll', [
        { nativeEvent: { contentOffset: { y: scrollY } } },
      ]);
    },
    [scrollY],
  );
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
    lastScrollYRef.current = 0;
    setAmbientLead(null);
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

  const playbackOn = active && !savedOpen && !topicsOpen && !shareUrl;
  const playbackOnRef = useRef(playbackOn);
  playbackOnRef.current = playbackOn;

  const activeItem = status === 'ready' ? items[activeIndex] : undefined;
  const activeId = activeItem?.id;
  const isActiveId = useCallback((id: string) => id === itemsRef.current[activeIndexRef.current]?.id, []);
  // Полоса одна — под рамкой, у ролика на экране; тики остальных плееров её не трогают.
  const {
    progress,
    onTick,
    reset: resetProgress,
    preset: presetProgress,
    scrubber,
  } = useFliqProgress(playbackOn && !!activeId && heldId !== activeId);
  /** Перемотка — плееру ролика на экране: смонтированные плееры кладут сюда свою перемотку. */
  const seekersRef = useRef(new Map<string, (sec: number, final: boolean) => void>());
  const seekActive = useCallback((sec: number, final: boolean) => {
    const id = itemsRef.current[activeIndexRef.current]?.id;
    if (id) seekersRef.current.get(id)?.(sec, final);
  }, []);

  const onProgress = useCallback(
    (id: string, cur: number, dur: number, running: boolean, sentAt: number) => {
      const w = watchRef.current.get(id) || { maxSec: 0, durSec: 0, loops: 0 };
      w.maxSec = Math.max(w.maxSec, cur);
      if (dur > 0) w.durSec = dur;
      watchRef.current.set(id, w);
      positionRef.current.set(id, cur);
      if (isActiveId(id)) onTick(cur, dur, running, sentAt);
    },
    [isActiveId, onTick],
  );
  const onLoop = useCallback(
    (id: string) => {
      const w = watchRef.current.get(id) || { maxSec: 0, durSec: 0, loops: 0 };
      w.loops += 1;
      w.maxSec = 0;
      watchRef.current.set(id, w);
      if (isActiveId(id)) resetProgress();
    },
    [isActiveId, resetProgress],
  );
  // Новый ролик на экране — полоса с его места (вернулись к уже начатому — с той же секунды).
  useEffect(() => {
    const pos = activeId ? positionRef.current.get(activeId) || 0 : 0;
    const dur = activeId ? itemsRef.current.find((it) => it.id === activeId)?.durationSec || 0 : 0;
    if (pos > 0 && dur > 0) presetProgress(pos, dur);
    else resetProgress();
  }, [activeId, presetProgress, resetProgress]);

  const goNext = useCallback((fromIndex: number) => {
    if (fromIndex !== activeIndexRef.current) return;
    const next = fromIndex + 1;
    if (next >= itemsRef.current.length) return;
    listRef.current?.scrollToIndex({ index: next, animated: true });
  }, []);
  /** Ролик на экране доиграл, а человек не перелистнул — лента листает сама. */
  const onEnded = useCallback(
    (id: string, index: number) => {
      // Вернётся к нему — пойдёт с начала, а не с последней секунды.
      positionRef.current.set(id, 0);
      if (playbackOnRef.current) goNext(index);
    },
    [goNext],
  );

  const onPlayError = useCallback(
    (id: string, index: number, code: number) => {
      if (!SKIP_ERROR_CODES.has(code)) return;
      reportFliqUnplayable(id, code);
      setTimeout(() => goNext(index), 700);
    },
    [goNext],
  );

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
  /** Ближайший уже тянет поток — следующий за ним можно будить, не дожидаясь полного запаса. */
  const markChainReady = useCallback((id: string) => {
    setBufferedIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }, []);
  const onBuffered = useCallback((id: string) => {
    markChainReady(id);
    if (prewarmingRef.current && itemsRef.current[0]?.id === id) {
      settlePrewarm('buffered');
    }
  }, [markChainReady, settlePrewarm]);
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

  // Полоса появляется, когда ролик на экране пошёл: пока он грузится или листаем — её нет.
  const barShown = !!activeId && startedId === activeId;
  const barOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(barOpacity, {
      toValue: barShown ? 1 : 0,
      duration: barShown ? 220 : 120,
      useNativeDriver: true,
    }).start();
  }, [barOpacity, barShown]);

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
  const [measuredRoot, setRootSize] = useState({ width: 0, height: 0 });
  const onRootLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setRootSize((prev) => (Math.abs(prev.width - w) < 1 && Math.abs(prev.height - h) < 1 ? prev : { width: w, height: h }));
  }, []);
  // Скрытая вкладка при повороте не пересобирает ленту и плееры (WebView, декодер) —
  // это держало JS секундами. Новые размеры применяются, когда вкладку открывают.
  const layoutRef = useRef({ rootSize: measuredRoot, viewportH, bottomInset, navMidFromBottom, topInset });
  if (active || prewarming || !(layoutRef.current.rootSize.width > 0 && layoutRef.current.viewportH > 0)) {
    const l = layoutRef.current;
    if (
      l.rootSize !== measuredRoot ||
      l.viewportH !== viewportH ||
      l.bottomInset !== bottomInset ||
      l.navMidFromBottom !== navMidFromBottom ||
      l.topInset !== topInset
    ) {
      layoutRef.current = { rootSize: measuredRoot, viewportH, bottomInset, navMidFromBottom, topInset };
    }
  }
  const {
    rootSize,
    viewportH: shownViewportH,
    bottomInset: shownBottomInset,
    navMidFromBottom: shownNavMid,
    topInset: shownTopInset,
  } = layoutRef.current;

  // Низкий landscape: шапки нет, карточка на всю ширину и высоту (ролик по центру, по бокам —
  // размытый кадр), под ней полоса времени и ряд кнопок; «сохранённые / темы» — слева в том же ряду.
  // Из замера самой вкладки, а не окна: при повороте окно меняется раньше, чем приходит
  // onLayout, и раскладка собиралась из размеров двух разных ориентаций.
  const wide =
    rootSize.width > 0 && rootSize.height > 0 ? !tablet && rootSize.width / rootSize.height > 1.05 : compact;
  const showHeader = !wide || savedOpen;
  // Видимая часть над стеклом навбара: карточка, полоса и кнопки — по её центру.
  const pageH = Math.max(0, shownViewportH - shownBottomInset);
  const sideInset = tablet ? 24 : 14;
  const panelH = wide ? WIDE_PANEL_H : tablet ? 72 : 64;
  // Ширина самой вкладки: окно в landscape шире на системную панель навигации.
  const paneW = rootSize.width > 0 ? rootSize.width : width;
  // Карточка — в целых физических пикселях. Высота карточки — шаг ленты, а Android берёт шаг
  // в целых пикселях с отбрасыванием дроби: на A35 (2.8125 px/dp) дробная высота с каждым
  // роликом сдвигала ленту, и сверху вылезала полоска предыдущего ролика.
  const px = PixelRatio.get();
  const cardMaxHpx = Math.floor(Math.max(0, pageH - panelH - FLIQ_PROGRESS_ROW_H - (wide ? 4 : 8)) * px);
  const cardWpx = Math.max(0, Math.min(Math.floor((paneW - sideInset * 2) * px), Math.floor((cardMaxHpx * 9) / 16)));
  const cardHpx = wide ? cardMaxHpx : Math.floor((cardWpx * 16) / 9);
  const cardW = cardWpx / px;
  const cardH = cardHpx / px;
  // Поворот меняет высоту карточки (шаг ленты), а смещение ленты остаётся старым — ролик
  // съезжал между страницами. Возвращаем ленту ровно на текущий ролик.
  useEffect(() => {
    if (cardH > 0) listRef.current?.scrollToOffset({ offset: activeIndexRef.current * cardH, animated: false });
  }, [cardH]);
  // Края карточки — вровень с навбаром снизу.
  const boxW = wide ? Math.max(cardW, Math.floor((paneW - WELCOME_FRIENDS_LIST_INSET * 2) * px) / px) : cardW;
  // Как кнопка поиска на «Друзья»: 36 / 32 landscape / 44 tablet.
  const btnSize = tablet ? 44 : compact ? 32 : GLASS_HEADER_BTN;
  const btnIconSize = tablet ? 24 : compact ? 19 : 20;
  const headerH = showHeader ? (tablet ? 56 : compact ? 40 : 48) : 0;
  // Кнопки шапки чуть ближе к центру, чем края карточки.
  const headerInset = sideInset + (tablet ? 14 : 10);
  // Карточка ролика в покое — там, откуда идёт свет (страница: карточка, полоса прогресса, панель — по центру).
  const ambientX = (rootSize.width - boxW) / 2;
  const ambientY = shownTopInset + headerH + Math.max(0, (pageH - cardH - FLIQ_PROGRESS_ROW_H - panelH) / 2);
  const wideRowTop = ambientY + cardH + FLIQ_PROGRESS_ROW_H + (panelH - WIDE_BTN) / 2;
  const ambientCard = useMemo(
    () => ({ x: ambientX, y: ambientY, width: boxW, height: cardH }),
    [ambientX, ambientY, boxW, cardH],
  );
  const ambientItem = items[ambientLead ?? activeIndex] ?? items[activeIndex];
  const ambientUrl = !savedOpen && status === 'ready' && ambientItem ? youtubeThumbUrl(ambientItem.id) : null;
  // Превью для света — заранее у соседей: при перелистывании свет не ждёт загрузки.
  useEffect(() => {
    if (status !== 'ready') return;
    prefetchFliqAmbient(
      [activeIndex, activeIndex + 1, activeIndex - 1, activeIndex + 2]
        .map((i) => items[i])
        .filter((it): it is FliqItem => !!it)
        .map((it) => youtubeThumbUrl(it.id)),
    );
  }, [activeIndex, items, status]);
  // Свет — от ролика, который въезжает в рамку по ходу ленты (пальцем или сама): вперёд —
  // следующий, как только он занял AMBIENT_SWITCH_AT рамки; назад — так же предыдущий. Вернули
  // ленту — свет вернётся. Лента и так шлёт прокрутку в JS (виртуализация), обработчик лёгкий:
  // состояние меняется, только когда меняется ролик.
  const onListScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!(cardH > 0)) return;
      const y = e.nativeEvent.contentOffset.y;
      const dy = y - lastScrollYRef.current;
      lastScrollYRef.current = y;
      if (dy === 0) return;
      const pos = y / cardH;
      const idx = dy > 0 ? Math.floor(pos + 1 - AMBIENT_SWITCH_AT) : Math.ceil(pos - 1 + AMBIENT_SWITCH_AT);
      const lead = Math.min(itemsRef.current.length - 1, Math.max(0, idx));
      setAmbientLead((prev) => (prev === lead ? prev : lead));
    },
    [cardH],
  );
  // Окно ленты под навбаром: верх следующего ролика — на середине блока навбара (сам блок
  // непрозрачный — видно часть ролика под ним), до низа вкладки. В portrait: в landscape стекла
  // под карточкой нет.
  const deckTop =
    !wide && !savedOpen && status === 'ready' && cardH > 0 ? shownTopInset + headerH + shownViewportH - shownNavMid : 0;

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
          cardW={cardW}
          cardH={cardH}
          wide={wide}
          boxW={boxW}
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
          // Последний загруженный ролик крутится по кругу, пока догружается лента.
          loop={index >= items.length - 1}
          onEnded={onEnded}
          onPlayError={onPlayError}
          onSkip={goNext}
          seekers={seekersRef}
          onMuteChange={onMuteChange}
          onUserPause={onUserPause}
          onUserPlay={onUserPlay}
          onStarted={onStarted}
          onPrimed={markChainReady}
          onBuffered={onBuffered}
        />
      );
    },
    [
      items,
      markChainReady,
      bufferedIds,
      neighborsOn,
      prewarming,
      startedId,
      onStarted,
      onBuffered,
      lang,
      cardW,
      cardH,
      wide,
      boxW,
      keepPlayers,
      activeIndex,
      playbackOn,
      heldId,
      muted,
      onProgress,
      onLoop,
      onEnded,
      onPlayError,
      goNext,
      onMuteChange,
      onUserPause,
      onUserPlay,
    ],
  );

  const savedButton = (size: number) => (
    <Pressable
      onPress={() => setSavedOpen(true)}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={fliqT('savedA11y', lang)}
      style={({ pressed }) => [
        styles.headerBtn,
        { width: size, height: size, borderRadius: size / 2 },
        WELCOME_CHROME_BTN_SHADOW_IOS,
        pressed && styles.headerBtnPressed,
      ]}
    >
      <WelcomeFloatShadow radius={size / 2} {...WELCOME_CHROME_BTN_SHADOW} />
      <Ionicons name="bookmark-outline" size={btnIconSize} color={WELCOME_HEADER_TITLE} />
      {savedHydrated && savedItems.length > 0 ? (
        <View style={styles.savedBadge}>
          <Text style={styles.savedBadgeText}>{savedItems.length > 99 ? '99+' : savedItems.length}</Text>
        </View>
      ) : null}
    </Pressable>
  );
  const topicsButton = (size: number) => (
    <Pressable
      onPress={() => setTopicsOpen(true)}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={fliqT('topicsA11y', lang)}
      style={({ pressed }) => [
        styles.headerBtn,
        { width: size, height: size, borderRadius: size / 2 },
        WELCOME_CHROME_BTN_SHADOW_IOS,
        pressed && styles.headerBtnPressed,
      ]}
    >
      <WelcomeFloatShadow radius={size / 2} {...WELCOME_CHROME_BTN_SHADOW} />
      <Ionicons name="options-outline" size={btnIconSize} color={WELCOME_HEADER_TITLE} />
    </Pressable>
  );

  return (
    // Вся вкладка — источник нижнего стекла: свет от ролика и уходящая под навбар карточка
    // видны под ним размытыми.
    <BlurListSource sourceId={HOME_BLUR_LIST_SOURCE.fliq} style={styles.root}>
      <View style={StyleSheet.absoluteFill} onLayout={onRootLayout} pointerEvents="none">
        <FliqAmbient url={ambientUrl} card={ambientCard} width={rootSize.width} height={rootSize.height} />
      </View>
      {deckTop > 0 && rootSize.height > deckTop ? (
        <FliqUnderDeck
          items={items}
          activeIndex={activeIndex}
          scrollY={scrollY}
          cardH={cardH}
          left={ambientX}
          top={deckTop}
          width={boxW}
          height={rootSize.height - deckTop}
        />
      ) : null}
      <View style={{ height: topInset }} />
      {showHeader ? (
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
                styles.headerBtn,
                { width: btnSize, height: btnSize, borderRadius: btnSize / 2 },
                WELCOME_CHROME_BTN_SHADOW_IOS,
                pressed && styles.headerBtnPressed,
              ]}
            >
              <WelcomeFloatShadow radius={btnSize / 2} {...WELCOME_CHROME_BTN_SHADOW} />
              <Ionicons name="chevron-back" size={btnIconSize} color={WELCOME_HEADER_TITLE} />
            </Pressable>
          ) : (
            <>
              {/* «Сохранённые» — у левого края, на месте кнопки «назад» из списка сохранённых. */}
              {savedButton(btnSize)}
              <View style={styles.headerSpacer} />
              {topicsButton(btnSize)}
            </>
          )}
        </View>
      ) : null}

      <View style={styles.pager} onLayout={onListLayout}>
        {savedOpen ? (
          <FliqSavedView lang={lang} width={width} bottomInset={bottomInset} tablet={tablet} />
        ) : status === 'ready' && pageH > 0 && cardH > 0 ? (
          // Карточка, полоса и кнопки — на тех же местах, где раньше стояла страница ленты в покое.
          <View style={[styles.stage, { height: pageH }]}>
            <View style={[styles.frame, { width: boxW, height: cardH }]}>
              <FlatList
                ref={setListRef}
                data={items}
                keyExtractor={(it) => it.id}
                renderItem={renderItem}
                extraData={renderItem}
                style={StyleSheet.absoluteFill}
                // Шаг — ровно cardHpx: натив отбрасывает дробь, полпикселя запаса от ошибки округления.
                snapToInterval={(cardHpx + 0.5) / px}
                snapToAlignment="start"
                disableIntervalMomentum
                decelerationRate="fast"
                showsVerticalScrollIndicator={false}
                getItemLayout={(_, index) => ({ length: cardH, offset: cardH * index, index })}
                onViewableItemsChanged={onViewableItemsChanged}
                viewabilityConfig={viewabilityConfig}
                initialNumToRender={3}
                maxToRenderPerBatch={3}
                windowSize={5}
                removeClippedSubviews={false}
                onScrollToIndexFailed={() => {}}
                scrollEventThrottle={16}
                onScroll={onListScroll}
              />
              {/* Обводка поверх ленты: рамкой у самой карточки она сжимала ленту на два волоска,
                  и шаг ленты расходился с её высотой. */}
              <View pointerEvents="none" style={styles.frameRim} />
            </View>
            <Animated.View pointerEvents={barShown ? 'auto' : 'none'} style={{ opacity: barOpacity }}>
              <FliqProgressBar
                progress={progress}
                width={boxW}
                scrubber={scrubber}
                onSeek={seekActive}
                style={styles.progressLow}
              />
            </Animated.View>
            {activeItem ? (
              <FliqActionPanel
                item={activeItem}
                lang={lang}
                cardW={cardW}
                boxW={boxW}
                panelH={panelH}
                wide={wide}
                muted={muted}
                saved={savedIds.has(activeItem.id)}
                onToggleMute={setMuted}
                onToggleSaved={toggleSaved}
                onShare={onShare}
              />
            ) : (
              <View style={{ height: panelH }} />
            )}
          </View>
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

      {wide && !savedOpen && status === 'ready' && cardW > 0 ? (
        <View style={[styles.wideRow, { left: ambientX, top: wideRowTop }]}>
          {savedButton(WIDE_BTN)}
          {topicsButton(WIDE_BTN)}
        </View>
      ) : null}

      <FliqTopicsDialog visible={topicsOpen} lang={lang} initial={topics} onDone={onTopicsDone} />
      <FliqShareSheet url={shareUrl} onClose={() => setShareUrl(null)} />
    </BlurListSource>
  );
}

/**
 * Продолжение ленты под стеклом навбара — как раньше, когда страница уходила под него целиком,
 * но рамка и кнопки стоят на месте. Лента за кнопками будто проходит насквозь: что уходит из
 * этого окна вверх, ровно тогда выходит снизу рамки, и наоборот. Ролик i здесь — на высоту
 * карточки выше, чем в ленте, со сдвигом окна от низа рамки: (i − 1)·cardH − прокрутка. Под
 * стеклом всё размыто — хватает превью вместо плеера.
 */
const FliqUnderDeck = memo(function FliqUnderDeck({
  items,
  activeIndex,
  scrollY,
  cardH,
  left,
  top,
  width,
  height,
}: {
  items: FliqItem[];
  activeIndex: number;
  scrollY: Animated.Value;
  cardH: number;
  left: number;
  top: number;
  width: number;
  height: number;
}) {
  const translateY = useMemo(() => Animated.add(Animated.multiply(scrollY, -1), -cardH), [scrollY, cardH]);
  const stripStyle = useMemo(() => ({ ...StyleSheet.absoluteFillObject, transform: [{ translateY }] }), [translateY]);
  // Видно не больше двух роликов: окно ниже карточки. С запасом на перелистывание в обе стороны.
  const from = Math.max(0, activeIndex - 1);
  const to = Math.min(items.length - 1, activeIndex + 2);
  if (to < from) return null;
  return (
    <View pointerEvents="none" style={[styles.underDeck, { left, top, width, height }]}>
      {/* У Animated.View — один ребёнок и неизменный style: массив детей входит в ключ его узла,
          и на каждой перерисовке RN пересоздавал узел, сбрасывая сдвиг к нулю
          (restoreDefaultValues), — превью прыгало и мерцало. */}
      <Animated.View style={stripStyle}>
        <View style={{ position: 'absolute', left: 0, top: from * cardH, width, height: (to - from + 1) * cardH }}>
          {items.slice(from, to + 1).map((it, k) => (
            <View key={it.id} style={[styles.underDeckCard, { top: k * cardH, width, height: cardH }]}>
              <ExpoImage
                source={{ uri: youtubeThumbUrl(it.id) }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                cachePolicy="memory-disk"
                recyclingKey={`deck-${it.id}`}
              />
              <View style={styles.frameRim} />
            </View>
          ))}
        </View>
      </Animated.View>
    </View>
  );
});

type FliqSlideProps = {
  item: FliqItem;
  index: number;
  lang: Lang;
  cardW: number;
  cardH: number;
  /** Низкий landscape: карточка шире ролика, по бокам размытый кадр. */
  wide: boolean;
  /** Ширина карточки (в portrait равна cardW — ширине самого ролика). */
  boxW: number;
  mountPlayer: boolean;
  mode: FliqPlayMode;
  prebuffer: boolean;
  prebufferMs?: number;
  muted: boolean;
  startSec: number;
  onProgress: (id: string, cur: number, dur: number, running: boolean, sentAt: number) => void;
  onLoop: (id: string) => void;
  /** Доиграл до конца и есть следующий ролик (loop выключен). */
  onEnded: (id: string, index: number) => void;
  loop: boolean;
  onPlayError: (id: string, index: number, code: number) => void;
  onSkip: (index: number) => void;
  /** Перемотка полосой под рамкой: плеер кладёт сюда свою, пока смонтирован. */
  seekers: MutableRefObject<Map<string, (sec: number, final: boolean) => void>>;
  onMuteChange: (index: number, muted: boolean) => void;
  onUserPause: (id: string, index: number) => void;
  onUserPlay: (id: string) => void;
  onStarted: (id: string) => void;
  onPrimed: (id: string) => void;
  onBuffered: (id: string) => void;
};

/** Страница ленты — только сам ролик: рамка, полоса и кнопки стоят вокруг на месте. */
const FliqSlide = memo(function FliqSlide({
  item,
  index,
  lang,
  cardW,
  cardH,
  wide,
  boxW,
  mountPlayer,
  mode,
  prebuffer,
  prebufferMs,
  muted,
  startSec,
  onProgress,
  onLoop,
  onEnded,
  loop,
  onPlayError,
  onSkip,
  seekers,
  onMuteChange,
  onUserPause,
  onUserPlay,
  onStarted,
  onPrimed,
  onBuffered,
}: FliqSlideProps) {
  const [firstFrame, setFirstFrame] = useState(false);
  const [stalled, setStalled] = useState(false);
  /** Скрытый ролик уже скачал начало: на экране показываем его кадр, без спиннера. */
  const [primed, setPrimed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const coverOpacity = useRef(new Animated.Value(1)).current;
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
    setPrimed(false);
    setStalled(false);
    coverOpacity.setValue(1);
  }, [mountPlayer, retryKey, coverOpacity]);

  // Плеер пересоздаётся при повороте — до его первого кадра снова видно превью.
  const wideRef = useRef(wide);
  useEffect(() => {
    if (wideRef.current === wide) return;
    wideRef.current = wide;
    setFirstFrame(false);
    setPrimed(false);
    coverOpacity.setValue(1);
  }, [wide, coverOpacity]);

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
    setPrimed(true);
  }, [item.id, onBuffered]);
  const handlePrimed = useCallback(() => onPrimed(item.id), [item.id, onPrimed]);
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
  const seek = useCallback((sec: number, final: boolean) => playerRef.current?.seek(sec, final), []);
  useEffect(() => {
    if (!mountPlayer) return;
    const map = seekers.current;
    map.set(item.id, seek);
    return () => {
      if (map.get(item.id) === seek) map.delete(item.id);
    };
  }, [mountPlayer, item.id, seek, seekers]);
  const handleProgress = useCallback(
    (c: number, d: number, running: boolean, sentAt: number) => onProgress(item.id, c, d, running, sentAt),
    [item.id, onProgress],
  );
  const handleLoop = useCallback(() => onLoop(item.id), [item.id, onLoop]);
  const handleEnded = useCallback(() => onEnded(item.id, index), [item.id, index, onEnded]);
  // Первый кадр плеер сообщает один раз: вернулись к уже начатому ролику — он снова «пошёл»,
  // и полоса под рамкой появляется сразу, а не только у новых роликов.
  useEffect(() => {
    if (playing && firstFrame) onStarted(item.id);
  }, [playing, firstFrame, item.id, onStarted]);
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
    setPrimed(false);
    coverOpacity.setValue(1);
    setRetryKey((k) => k + 1);
  }, [coverOpacity]);

  // Подгруженный ролик уже стоит на первом кадре: при свайпе его сразу видно.
  // firstFrame не ставим сами — если воспроизведение не пойдёт, останется «не загружается».
  const warmOnScreen = playing && primed;
  useEffect(() => {
    if (!warmOnScreen) return;
    coverOpacity.setValue(0);
    onStarted(item.id);
  }, [coverOpacity, item.id, onStarted, warmOnScreen]);

  return (
    <View style={[{ width: boxW, height: cardH }, wide && styles.cardWide]}>
      {wide ? (
        <>
          <ExpoImage
            source={{ uri: youtubeThumbUrl(item.id) }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy="memory-disk"
            blurRadius={28}
            recyclingKey={`bg-${item.id}`}
          />
          <View style={styles.wideDim} />
        </>
      ) : null}
      <View style={wide ? { width: cardW, height: cardH } : StyleSheet.absoluteFill}>
        <ExpoImage
          source={{ uri: youtubeThumbUrl(item.id) }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={item.id}
        />
        {mountPlayer ? (
          <FliqYoutubePlayer
            // Поворот — новый плеер под новый размер: WebView, растянутый на ходу,
            // замораживал картинку (звук и полоса шли дальше). Продолжит с той же секунды.
            key={`${retryKey}-${wide ? 'w' : 'p'}`}
            ref={playerRef}
            videoId={item.id}
            mode={mode}
            startSec={startSec}
            muted={muted}
            prebuffer={prebuffer}
            prebufferMs={prebufferMs}
            widthDp={cardW}
            onReady={handleReady}
            onPrimed={handlePrimed}
            onBuffered={handleBuffered}
            onFirstFrame={handleFirstFrame}
            onProgress={handleProgress}
            onLoop={handleLoop}
            loop={loop}
            onEnded={handleEnded}
            onMuteChange={handleMuteChange}
            onUserPause={handleUserPause}
            onUserPlay={handleUserPlay}
            onError={handleError}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        {/* Превью поверх плеера только до первого кадра; у уже подгруженного ролика его нет.
            Число и Animated-значение — на разных View: если у одного View сменить значение
            нативного драйвера на число, RN сбрасывает opacity в 1 (restoreDefaultValues),
            а React разницы 0 → 0 не видит — после «пауза → плей» превью вставало поверх
            идущего ролика. */}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: warmOnScreen ? 0 : 1 }]}>
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: coverOpacity }]}>
            <ExpoImage
              source={{ uri: youtubeThumbUrl(item.id) }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={`cover-${item.id}`}
            />
            {playing && !firstFrame && !primed && !stalled ? (
              <View style={styles.center}>
                <ActivityIndicator color="rgba(255,255,255,0.85)" />
              </View>
            ) : null}
          </Animated.View>
        </View>
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
    </View>
  );
});

type FliqActionPanelProps = {
  item: FliqItem;
  lang: Lang;
  cardW: number;
  boxW: number;
  panelH: number;
  wide: boolean;
  muted: boolean;
  saved: boolean;
  onToggleMute: (muted: boolean) => void;
  onToggleSaved: (item: FliqItem) => void;
  onShare: (item: FliqItem) => void;
};

/** Ряд кнопок под рамкой — один на ленту, у ролика на экране; при листании стоит на месте. */
const FliqActionPanel = memo(function FliqActionPanel({
  item,
  lang,
  cardW,
  boxW,
  panelH,
  wide,
  muted,
  saved,
  onToggleMute,
  onToggleSaved,
  onShare,
}: FliqActionPanelProps) {
  const titleFont = useDigitalMediumFont();
  const actionGap = wide ? 10 : cardW < 220 ? 4 : 8;
  // «Переслать» остаётся широкой кнопкой, три круглых действия занимают место слева.
  // В landscape ряд шире ролика — размеры фиксированные, ряд прижат вправо.
  const shareWidth = wide ? 116 : Math.min(116, Math.max(1, Math.floor(cardW * (cardW < 180 ? 0.46 : 0.4))));
  const actionSize = wide ? WIDE_BTN : Math.min(40, Math.max(1, Math.floor((cardW - shareWidth - actionGap * 3) / 3)));
  const actionIconSize = Math.max(1, Math.min(19, actionSize - 6));
  const youtubeIconSize = Math.max(1, Math.min(actionSize - 4, Math.round(actionIconSize * 1.15)));
  const shareHeight = Math.min(40, actionSize);
  const shareCompact = shareWidth < 82;
  return (
    <View style={[styles.panel, { width: boxW, height: panelH, gap: actionGap }, wide && styles.panelWide]}>
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
        <FliqYoutubeIcon size={youtubeIconSize} />
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
  wideRow: { position: 'absolute', flexDirection: 'row', gap: 10 },
  headerBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI_GLASS_CONTROL,
    borderWidth: 0,
  },
  headerBtnPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.96 }],
  },
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
  /** Карточка, полоса и кнопки по центру видимой части над стеклом навбара. */
  stage: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardWide: { alignItems: 'center' },
  wideDim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(12, 15, 20, 0.35)' },
  panelWide: { justifyContent: 'flex-end' },
  frame: {
    borderRadius: CARD_RADIUS,
    overflow: 'hidden',
    backgroundColor: UI_SURFACE,
  },
  frameRim: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: CARD_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_RIM,
  },
  underDeck: {
    position: 'absolute',
    overflow: 'hidden',
  },
  underDeckCard: {
    position: 'absolute',
    left: 0,
    borderRadius: CARD_RADIUS,
    overflow: 'hidden',
    backgroundColor: UI_SURFACE,
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
