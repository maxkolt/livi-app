import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { FireAvatarFrame, fireFrameOutset } from './FireAvatarFrame';
import { IceAvatarFrame } from './IceAvatarFrame';
import { DiamondAvatarFrame } from './DiamondAvatarFrame';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import Carousel from 'react-native-reanimated-carousel';
import { Extrapolation, interpolate } from 'react-native-reanimated';
import AdaptiveText from '../AdaptiveText';
import { t } from '../../utils/i18n';
import { useLang } from '../../store/lang';
import FitText from '../FitText';
import { FullScreenPortal } from '../FullScreenPortal';
import { useOrientationLayoutGuard } from '../../hooks/useOrientationLayoutGuard';
import { OrientationCoverModal } from '../OrientationCoverModal';
import {
  checkCosmeticPayment,
  createCosmeticPayment,
  loadCosmetics,
  setActiveCosmetic,
  useCosmetics,
  cosmeticBlurbKey,
  cosmeticNameKey,
  type CosmeticKind,
} from '../../utils/cosmetics';
import {
  CROWN_GOLD,
  SEARCH_CTA_MAX_WIDTH,
  SEARCH_CTA_TABLET_MAX_WIDTH,
  SEARCH_CTA_TABLET_MIN_WIDTH,
  WELCOME_HEADER_TITLE,
  HOME_NAV_BG,
  WELCOME_MUTED_TEXT,
  APP_TOP_CONTENT_GAP,
} from '../../screens/home/constants';
import { WelcomeStageBackground } from '../../screens/home/WelcomeStageBackground';
import { AppDialogModal } from '../AppDialog';

const SHOWCASE_AVATAR = require('../../assets/frames/showcase-avatar.jpg');
/** Под фото в рамке: пока кадр не декодирован, градиент рамки не виден сплошным кругом. */
const SHOWCASE_AVATAR_BG = '#0B1219';
/** Дольше не ждём картинок: витрина появляется, даже если кадр не пришёл. */
const STORE_READY_TIMEOUT_MS = 600;

type Props = {
  visible: boolean;
  onClose: () => void;
  myUserId?: string;
  myAvatarVer?: number;
  avatarUri?: string;
  nick?: string;
  /** Единая оплата для фонов чата и рамок аватара. */
  onUnlock?: () => void;
  /**
   * Собрать витрину заранее и держать скрытой: открытие только показывает готовое.
   * Первый монтаж (карусели, жесты, ворклеты) занимал JS ~350 мс после тапа (dev).
   */
  keepWarm?: boolean;
};

/** Название и описание — в i18n по ключу предмета (cosmeticNameKey / cosmeticBlurbKey). */
type FrameItem = {
  key: string;
  colors: readonly [string, string, ...string[]];
  kind: 'ring';
};

type ChatBackgroundItem = {
  key: string;
  source: number;
};

type PurchaseNotice = {
  kind: 'success' | 'canceled' | 'error';
  title: string;
  message: string;
};

const PEARL_BORDER = 'rgba(238,229,244,0.9)';
const CHAT_BUBBLE_IN = 'rgba(51, 59, 71, 0.98)';
const CHAT_BUBBLE_OUT = 'rgba(49, 70, 85, 0.99)';
const CHAT_BUBBLE_BORDER = 'rgba(255,255,255,0.12)';

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return `rgba(255,255,255,${alpha})`;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const CHAT_BACKGROUND_CATALOG: ChatBackgroundItem[] = [
  {
    key: 'aurora-chat',
    source: require('../../assets/chat-wallpapers/dark/doodles-cyan.jpeg'),
  },
  {
    key: 'deep-space',
    source: require('../../assets/chat-wallpapers/dark/cosmos.jpeg'),
  },
  {
    key: 'poetry',
    source: require('../../assets/chat-wallpapers/dark/pushkin.jpeg'),
  },
  {
    key: 'ocean-flow',
    source: require('../../assets/chat-wallpapers/dark/doodles-teal.jpeg'),
  },
  {
    key: 'graphite-chat',
    source: require('../../assets/chat-wallpapers/dark/letters.jpeg'),
  },
];

const FRAME_CATALOG: FrameItem[] = [
  {
    key: 'fire',
    colors: ['#FFC062', '#FF8A34', '#FF4D1C'],
    kind: 'ring',
  },
  {
    key: 'diamond',
    colors: ['#E8F6FF', '#9ED0FF', '#6AA9FF'],
    kind: 'ring',
  },
  {
    key: 'aurora',
    colors: ['#7CF5C8', '#5AA9FF', '#3B82F6'],
    kind: 'ring',
  },
  {
    key: 'palladium',
    colors: ['#F2F4F7', '#C5CCD6', '#8B93A0'],
    kind: 'ring',
  },
  {
    key: 'frost',
    colors: ['#D9F4FF', '#7EC8E8', '#4A9BC7'],
    kind: 'ring',
  },
  {
    key: 'jade',
    colors: ['#B8F0D0', '#3DCF8E', '#1B8F5A'],
    kind: 'ring',
  },
  {
    key: 'void',
    colors: ['#D4B5FF', '#7B5CFF', '#2A1B4A'],
    kind: 'ring',
  },
  {
    key: 'obsidian',
    colors: ['#6B7280', '#374151', '#111827'],
    kind: 'ring',
  },
];

function ChatBackgroundCard({
  item,
  width,
  height,
  onLoad,
}: {
  item: ChatBackgroundItem;
  width: number;
  height: number;
  onLoad?: () => void;
}) {
  return (
    <View style={styles.cardShadow}>
      <View style={[styles.backgroundCard, { width, height, borderRadius: Math.round(height * 0.16) }]}>
        <ExpoImage
          source={item.source}
          style={StyleSheet.absoluteFillObject}
          contentFit="cover"
          cachePolicy="memory-disk"
          onLoad={onLoad}
        />
        <LinearGradient
          colors={['rgba(0,0,0,0.02)', 'rgba(0,0,0,0.24)']}
          style={StyleSheet.absoluteFillObject}
        />
        <View style={[styles.chatBubble, styles.chatBubbleLeft]} />
        <View style={[styles.chatBubble, styles.chatBubbleRight]} />
      </View>
    </View>
  );
}

function FrameCoverCard({
  item,
  size,
  active,
  onLoad,
}: {
  item: FrameItem;
  size: number;
  active: boolean;
  onLoad?: () => void;
}) {
  const ringWidth = Math.max(2, Math.round(size * 0.025));
  const avatarSize = size - ringWidth * 2;

  if (item.key === 'fire' || item.key === 'frost' || item.key === 'diamond') {
    const liveOutset = fireFrameOutset(size);
    const liveAvatarSize = size - liveOutset * 2;
    const LiveFrame = item.key === 'fire'
      ? FireAvatarFrame
      : item.key === 'frost'
        ? IceAvatarFrame
        : DiamondAvatarFrame;
    return (
      <View style={styles.cardShadow}>
        <LiveFrame size={size} photoSize={liveAvatarSize} active={active}>
          <ExpoImage
            source={SHOWCASE_AVATAR}
            style={StyleSheet.absoluteFillObject}
            contentFit="cover"
            cachePolicy="memory-disk"
            onLoad={onLoad}
          />
        </LiveFrame>
      </View>
    );
  }

  return (
    <View style={styles.cardShadow}>
      <LinearGradient
        colors={item.colors as [string, string, ...string[]]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          padding: ringWidth,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ExpoImage
          source={SHOWCASE_AVATAR}
          style={{
            width: avatarSize,
            height: avatarSize,
            borderRadius: avatarSize / 2,
            backgroundColor: SHOWCASE_AVATAR_BG,
          }}
          contentFit="cover"
          cachePolicy="memory-disk"
          onLoad={onLoad}
        />
      </LinearGradient>
    </View>
  );
}

function PurchaseButton({
  label,
  icon,
  width,
  height,
  borderColor,
  surfaceColor,
  contentColor,
  disabled,
  onPress,
}: {
  label: string;
  icon: 'image-outline' | 'account-circle-outline';
  width: number;
  height: number;
  borderColor: string;
  surfaceColor: string;
  contentColor: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const radius = height / 2;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.ctaWrap,
        { width },
        disabled && styles.ctaDisabled,
        pressed && !disabled && styles.ctaPressed,
        pressed && !disabled && { transform: [{ scale: 0.985 }] },
      ]}
    >
      <View
        style={[
          styles.ctaInner,
          {
            width,
            height,
            borderRadius: radius,
            borderColor,
            backgroundColor: surfaceColor,
          },
        ]}
      >
        <MaterialCommunityIcons name={icon} size={19} color={contentColor} />
        <FitText style={[styles.ctaText, { color: contentColor }]} minimumFontScale={0.68} numberOfLines={1}>
          {label}
        </FitText>
      </View>
    </Pressable>
  );
}

/** Зазор кнопки рамки над системной панелью — как между блоками профиля. */
const STORE_BOTTOM_GAP_PHONE = 12;
const STORE_BOTTOM_GAP_TABLET = 16;
/** Строка заголовка секции («Фоны для чата», «Рамки для аватара»). */
const SECTION_HEADING_HEIGHT = 22;

type GapSpec = { grow: number; min: number; max?: number };

type StoreLayout = {
  /** Мелкие шрифты и однострочное описание. */
  compact: boolean;
  backgroundCardWidth: number;
  backgroundPageWidth: number;
  backgroundLabelSpace: number;
  frameSize: number;
  framePageWidth: number;
  frameLabelSpace: number;
  buttonHeight: number;
  /** Название + описание под каруселью — оценка для выбора ступени. */
  copyHeight: number;
  gaps: {
    top: GapSpec;
    heading: GapSpec;
    copy: GapSpec;
    button: GapSpec;
    section: GapSpec;
  };
};

function storeGaps(scale: number): StoreLayout['gaps'] {
  return {
    // Зазоры внутри секции ограничены — подписи и кнопки не отрываются от своих
    // каруселей. Весь остаток высоты делят верх и промежуток между секциями.
    top: { grow: 0.6, min: 4 },
    heading: { grow: 0.45, min: 6, max: Math.round(18 * scale) },
    copy: { grow: 0.4, min: 6, max: Math.round(16 * scale) },
    button: { grow: 0.5, min: 8, max: Math.round(22 * scale) },
    section: { grow: 1.2, min: 12 },
  };
}

function sectionNeed(layout: StoreLayout, kind: 'background' | 'frame'): number {
  const carousel = kind === 'background'
    ? Math.round(layout.backgroundCardWidth * 0.61) + layout.backgroundLabelSpace
    : layout.frameSize + layout.frameLabelSpace;
  const { heading, copy, button } = layout.gaps;
  return SECTION_HEADING_HEIGHT + carousel + layout.copyHeight + layout.buttonHeight
    + heading.min + copy.min + button.min;
}

function layoutNeed(layout: StoreLayout, landscape: boolean): number {
  const background = sectionNeed(layout, 'background');
  const frame = sectionNeed(layout, 'frame');
  return layout.gaps.top.min + (landscape
    ? Math.max(background, frame)
    : background + layout.gaps.section.min + frame);
}

/**
 * Ступень размеров витрины по высоте, которая реально остаётся между шапкой и
 * кнопкой: крупная → компактная → мини. На высоких экранах и планшетах крупная
 * ступень ещё и растёт, чтобы витрина не тонула в пустых зазорах.
 */
function pickStoreLayout(available: number, landscape: boolean, tablet: boolean): StoreLayout {
  const regular: StoreLayout = {
    compact: false,
    backgroundCardWidth: landscape ? 144 : 158,
    backgroundPageWidth: 88,
    backgroundLabelSpace: 30,
    frameSize: landscape ? 96 : 106,
    framePageWidth: 62,
    frameLabelSpace: 34,
    buttonHeight: Platform.OS === 'ios' ? 46 : 44,
    copyHeight: 60,
    gaps: storeGaps(1),
  };
  const regularNeed = layoutNeed(regular, landscape);
  if (available >= regularNeed) {
    // Рост начинается, когда запас больше ~120 dp; телефоны — до +15%, планшеты — до +50%.
    const scale = Math.min(tablet ? 1.5 : 1.15, Math.max(1, available / (regularNeed + 120)));
    if (scale <= 1.01) return regular;
    const grown: StoreLayout = {
      ...regular,
      backgroundCardWidth: Math.round(regular.backgroundCardWidth * scale),
      backgroundPageWidth: Math.round(regular.backgroundPageWidth * scale),
      frameSize: Math.round(regular.frameSize * scale),
      framePageWidth: Math.round(regular.framePageWidth * scale),
      buttonHeight: tablet ? 48 : regular.buttonHeight,
      // На планшете и зазоры внутри секций свободнее — иначе всё сбивается в кучу.
      gaps: storeGaps(scale * (tablet ? 1.6 : 1)),
    };
    return grown;
  }
  const compact: StoreLayout = {
    compact: true,
    backgroundCardWidth: 128,
    backgroundPageWidth: 76,
    backgroundLabelSpace: 24,
    frameSize: 84,
    framePageWidth: 54,
    frameLabelSpace: 26,
    buttonHeight: 40,
    copyHeight: 36,
    gaps: storeGaps(1),
  };
  if (available >= layoutNeed(compact, landscape)) return compact;
  return {
    ...compact,
    backgroundCardWidth: 108,
    backgroundPageWidth: 66,
    backgroundLabelSpace: 22,
    frameSize: 70,
    framePageWidth: 46,
    frameLabelSpace: 24,
    buttonHeight: 38,
  };
}

/** Гибкий зазор: делит свободную высоту по весу в пределах [min, max]. */
function FlexGap({ grow, min, max }: GapSpec) {
  return (
    <View
      pointerEvents="none"
      style={{ flexGrow: grow, flexShrink: 0, flexBasis: 0, minHeight: min, maxHeight: max }}
    />
  );
}

/** Витрина — полноэкранный слой в основном окне (см. FullScreenPortal), не RN-модалка. */
export function FramesStoreModal(props: Props) {
  const requestCloseRef = useRef(props.onClose);
  // Карусели рисуют карточки не в первом кадре, а фото в рамках приходят ещё позже —
  // при открытии рамки «дорисовывались» на глазах. Показываем витрину готовой.
  const [ready, setReady] = useState(false);
  /** Картинки уже загружались (витрина собрана заранее) — показываем без ожидания. */
  const loadedOnceRef = useRef(false);
  useEffect(() => {
    if (!props.visible) {
      setReady(false);
      return;
    }
    if (loadedOnceRef.current) return;
    const timer = setTimeout(() => setReady(true), STORE_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [props.visible]);
  const markReady = useCallback(() => {
    loadedOnceRef.current = true;
    setReady(true);
  }, []);
  return (
    <FullScreenPortal
      visible={props.visible}
      ready={ready || loadedOnceRef.current}
      keepMounted={props.keepWarm}
      onRequestClose={() => requestCloseRef.current()}
    >
      <FramesStoreContent {...props} requestCloseRef={requestCloseRef} onContentReady={markReady} />
    </FullScreenPortal>
  );
}

function FramesStoreContent({
  visible,
  keepWarm,
  onClose,
  onUnlock,
  requestCloseRef,
  onContentReady,
}: Props & {
  requestCloseRef: React.MutableRefObject<() => void>;
  /** Фон и рамка уже с картинками — можно показывать. */
  onContentReady?: () => void;
}) {
  const lang = useLang((state) => state.lang);
  const L = useCallback((key: string) => t(key, lang), [lang]);
  const liveInsets = useSafeAreaInsets();
  const frame = useSafeAreaFrame();
  const {
    size: rootSize,
    covering: orientationCovering,
    onLayout: onRootLayout,
  } = useOrientationLayoutGuard(frame, {
    // Карусели: ранний onLayout снимал шторку — держим фиксированно.
    fixedCoverMs: 1600,
    fallbackMs: 2400,
  });
  // keepWarm держит карусели смонтированными: при повороте закрытой витрины
  // смена размеров/insets роняла reanimated-carousel (forEach of null).
  // Пока закрыто — геометрия и insets заморожены.
  const frozenRef = useRef({
    width: frame.width,
    height: frame.height,
    insets: liveInsets,
  });
  const liveW = rootSize.width > 0 ? rootSize.width : frame.width;
  const liveH = rootSize.height > 0 ? rootSize.height : frame.height;
  if (visible && liveW > 0 && liveH > 0) {
    frozenRef.current = { width: liveW, height: liveH, insets: liveInsets };
  }
  const windowWidth = visible ? liveW : frozenRef.current.width;
  const windowHeight = visible ? liveH : frozenRef.current.height;
  const insets = visible ? liveInsets : frozenRef.current.insets;
  const landscape = windowWidth > windowHeight;
  const orientKey = landscape ? 'l' : 'p';
  const tablet = Math.min(windowWidth, windowHeight) >= 600;
  const headerCompact = windowHeight < (landscape ? 430 : 720);
  const pageHorizontalPadding = landscape ? 12 : 0;
  const sectionsGap = landscape ? 12 : 0;
  const safeContentWidth = Math.max(0, windowWidth - insets.left - insets.right - pageHorizontalPadding * 2);
  const portraitContentWidth = Math.min(safeContentWidth, 720);
  const sectionWidth = landscape
    ? Math.max(0, (safeContentWidth - sectionsGap) / 2)
    : portraitContentWidth;

  const pageTopGap = headerCompact ? 2 : Platform.OS === 'ios' ? 7 : 10;
  // Шапка чуть ближе к статус-бару, чем даёт pageTopGap.
  const contentLift = Math.min(pageTopGap, 8);
  const pagePaddingTop = insets.top + APP_TOP_CONTENT_GAP + pageTopGap - contentLift;
  // Кнопка рамки стоит над системной панелью с тем же зазором, что между
  // блоками профиля, — на любом устройстве. Остальное раскладывается выше неё.
  const bottomGap = tablet ? STORE_BOTTOM_GAP_TABLET : STORE_BOTTOM_GAP_PHONE;
  const pagePaddingBottom = insets.bottom + bottomGap;
  const contentHeight = Math.max(
    0,
    windowHeight - pagePaddingTop - (headerCompact ? 34 : 42) - pagePaddingBottom,
  );
  const layout = pickStoreLayout(contentHeight, landscape, tablet);
  const compact = layout.compact;
  const gaps = layout.gaps;

  const backgroundCardWidth = layout.backgroundCardWidth;
  const backgroundCardHeight = Math.round(backgroundCardWidth * 0.61);
  const backgroundPageWidth = layout.backgroundPageWidth;
  const backgroundPageHeight = backgroundCardHeight + layout.backgroundLabelSpace;
  const frameSize = layout.frameSize;
  const framePageWidth = layout.framePageWidth;
  const framePageHeight = frameSize + layout.frameLabelSpace;
  // В альбомной колонки стоят рядом — одинаковая высота каруселей выравнивает
  // заголовки и описания по одной линии.
  const backgroundCarouselBox = landscape ? Math.max(backgroundPageHeight, framePageHeight) : backgroundPageHeight;
  const frameCarouselBox = landscape ? Math.max(backgroundPageHeight, framePageHeight) : framePageHeight;

  const maxCtaWidth =
    sectionWidth >= SEARCH_CTA_TABLET_MIN_WIDTH ? SEARCH_CTA_TABLET_MAX_WIDTH : SEARCH_CTA_MAX_WIDTH;
  const buttonWidth = Math.min(Math.max(180, sectionWidth - (compact ? 28 : 44)), maxCtaWidth);
  const buttonHeight = layout.buttonHeight;

  const [activeBackgroundIndex, setActiveBackgroundIndex] = useState(0);
  const [activeFrameIndex, setActiveFrameIndex] = useState(0);
  const [paymentBusy, setPaymentBusy] = useState<CosmeticKind | null>(null);
  const [pendingPaymentId, setPendingPaymentId] = useState('');
  const [purchaseNotice, setPurchaseNotice] = useState<PurchaseNotice | null>(null);
  // Закрытое окно ещё исчезает — держим в нём прежний текст.
  const lastPurchaseNoticeRef = useRef<PurchaseNotice | null>(null);
  if (purchaseNotice) lastPurchaseNoticeRef.current = purchaseNotice;
  const shownNotice = purchaseNotice ?? lastPurchaseNoticeRef.current;
  const entitlements = useCosmetics();
  const activeBackground = CHAT_BACKGROUND_CATALOG[activeBackgroundIndex] ?? CHAT_BACKGROUND_CATALOG[0];
  const activeFrame = FRAME_CATALOG[activeFrameIndex] ?? FRAME_CATALOG[0];

  useEffect(() => {
    if (!visible) return;
    void loadCosmetics(true).catch(() => {});
  }, [visible]);

  const loadedRef = useRef({ background: false, frame: false, sent: false });
  useEffect(() => {
    if (!visible) loadedRef.current = { background: false, frame: false, sent: false };
  }, [visible]);
  const handleCardLoad = useCallback(
    (kind: 'background' | 'frame') => {
      const loaded = loadedRef.current;
      loaded[kind] = true;
      if (loaded.sent || !loaded.background || !loaded.frame) return;
      loaded.sent = true;
      // Соседние карточки берут тот же кадр из кэша — им нужен ещё кадр-другой.
      requestAnimationFrame(() => requestAnimationFrame(() => onContentReady?.()));
    },
    [onContentReady],
  );
  const handleBackgroundLoad = useCallback(() => handleCardLoad('background'), [handleCardLoad]);
  const handleFrameLoad = useCallback(() => handleCardLoad('frame'), [handleCardLoad]);

  const refreshPendingPayment = useCallback(async () => {
    if (!pendingPaymentId) return;
    try {
      const result = await checkCosmeticPayment(pendingPaymentId);
      if (result.status === 'succeeded') {
        setPendingPaymentId('');
        setPaymentBusy(null);
        onUnlock?.();
        setPurchaseNotice({
          kind: 'success',
          title: 'storePurchaseDoneTitle',
          message: 'storePurchaseDoneText',
        });
      } else if (result.status === 'canceled') {
        setPendingPaymentId('');
        setPaymentBusy(null);
        setPurchaseNotice({
          kind: 'canceled',
          title: 'storePaymentCanceledTitle',
          message: 'storePaymentCanceledText',
        });
      }
    } catch {
      setPaymentBusy(null);
    }
  }, [onUnlock, pendingPaymentId]);

  useEffect(() => {
    if (!visible || !pendingPaymentId) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshPendingPayment();
    });
    const timer = setInterval(() => void refreshPendingPayment(), 3000);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [pendingPaymentId, refreshPendingPayment, visible]);

  const backgroundCoverflowAnimation = useCallback(
    (value: number) => {
      'worklet';
      const translateX = interpolate(
        value,
        [-3, -2, -1, 0, 1, 2, 3],
        [
          -backgroundPageWidth * 2.15,
          -backgroundPageWidth * 1.35,
          -backgroundPageWidth * 0.58,
          0,
          backgroundPageWidth * 0.58,
          backgroundPageWidth * 1.35,
          backgroundPageWidth * 2.15,
        ],
        Extrapolation.CLAMP,
      );
      const rotateY = interpolate(value, [-2, -1, 0, 1, 2], [58, 54, 0, -54, -58], Extrapolation.CLAMP);
      const scale = interpolate(value, [-2, -1, 0, 1, 2], [0.74, 0.85, 1.08, 0.85, 0.74], Extrapolation.CLAMP);
      const opacity = interpolate(value, [-3, -2, -1, 0, 1, 2, 3], [0.18, 0.45, 0.78, 1, 0.78, 0.45, 0.18], Extrapolation.CLAMP);
      const zIndex = Math.round(interpolate(value, [-2, -1, 0, 1, 2], [2, 8, 30, 8, 2], Extrapolation.CLAMP));
      return {
        transform: [{ perspective: 1000 }, { translateX }, { rotateY: `${rotateY}deg` }, { scale }],
        opacity,
        zIndex,
      };
    },
    [backgroundPageWidth],
  );

  const frameCoverflowAnimation = useCallback(
    (value: number) => {
      'worklet';
      const translateX = interpolate(
        value,
        [-3, -2, -1, 0, 1, 2, 3],
        [
          -framePageWidth * 2.1,
          -framePageWidth * 1.35,
          -framePageWidth * 0.55,
          0,
          framePageWidth * 0.55,
          framePageWidth * 1.35,
          framePageWidth * 2.1,
        ],
        Extrapolation.CLAMP,
      );
      const rotateY = interpolate(value, [-2, -1, 0, 1, 2], [62, 58, 0, -58, -62], Extrapolation.CLAMP);
      const scale = interpolate(value, [-2, -1, 0, 1, 2], [0.72, 0.84, 1.1, 0.84, 0.72], Extrapolation.CLAMP);
      const opacity = interpolate(value, [-3, -2, -1, 0, 1, 2, 3], [0.2, 0.45, 0.75, 1, 0.75, 0.45, 0.2], Extrapolation.CLAMP);
      const zIndex = Math.round(interpolate(value, [-2, -1, 0, 1, 2], [2, 8, 30, 8, 2], Extrapolation.CLAMP));
      return {
        transform: [{ perspective: 1000 }, { translateX }, { rotateY: `${rotateY}deg` }, { scale }],
        opacity,
        zIndex,
      };
    },
    [framePageWidth],
  );

  if (!visible && !keepWarm) return null;

  const openSharedCheckout = async (kind: CosmeticKind) => {
    if (paymentBusy) return;
    const itemId = kind === 'background' ? activeBackground.key : activeFrame.key;
    const owned = kind === 'background'
      ? entitlements.purchasedBackgroundIds.includes(itemId)
      : entitlements.purchasedFrameIds.includes(itemId);
    const activeId = kind === 'background' ? entitlements.activeBackgroundId : entitlements.activeFrameId;
    setPaymentBusy(kind);
    try {
      if (owned) {
        await setActiveCosmetic(kind, activeId === itemId ? '' : itemId);
        return;
      }
      const payment = await createCosmeticPayment(kind, itemId);
      if (payment.alreadyOwned) {
        await setActiveCosmetic(kind, itemId);
        return;
      }
      if (!payment.paymentId || !payment.confirmationUrl) throw new Error('missing_confirmation');
      setPendingPaymentId(payment.paymentId);
      await Linking.openURL(payment.confirmationUrl);
    } catch {
      setPendingPaymentId('');
      setPurchaseNotice({
        kind: 'error',
        title: 'storePaymentOpenFailedTitle',
        message: 'storePaymentOpenFailedText',
      });
    } finally {
      setPaymentBusy(null);
    }
  };

  const backgroundOwned = entitlements.purchasedBackgroundIds.includes(activeBackground.key);
  const frameOwned = entitlements.purchasedFrameIds.includes(activeFrame.key);
  const backgroundActive = entitlements.activeBackgroundId === activeBackground.key;
  const frameActive = entitlements.activeFrameId === activeFrame.key;
  const closePurchaseNotice = () => setPurchaseNotice(null);
  const handleRequestClose = () => {
    if (purchaseNotice) closePurchaseNotice();
    else onClose();
  };
  // Системное «Назад» ловит обёртка снаружи — отдаём ей актуальный обработчик.
  requestCloseRef.current = handleRequestClose;

  // Секция — столбец «заголовок → карусель → описание → кнопка» с гибкими
  // зазорами между ними. Нижний край секции рамок — кнопка у системной панели.
  const backgroundSection = (
    <>
      <View style={styles.sectionHeadingRow}>
        <MaterialCommunityIcons name="message-image-outline" size={compact ? 17 : 19} color={CROWN_GOLD} />
        <FitText style={[styles.sectionHeading, compact && styles.sectionHeadingCompact]} minimumFontScale={0.75}>
          {L('storeChatBackgrounds')}
        </FitText>
      </View>
      <FlexGap {...gaps.heading} />
      <View style={[styles.carouselWrap, { height: backgroundCarouselBox }]}>
        <Carousel
          key={`bg-${orientKey}-${backgroundPageWidth}-${backgroundCardWidth}`}
          width={backgroundPageWidth}
          height={backgroundPageHeight}
          data={CHAT_BACKGROUND_CATALOG}
          // Смена ступени размеров или поворот пересоздают карусель — без этого
          // она вставала на первый фон, а описание оставалось от выбранного.
          defaultIndex={activeBackgroundIndex}
          loop
          style={{ width: sectionWidth, justifyContent: 'center', overflow: 'visible' }}
          containerStyle={{ overflow: 'visible' }}
          customAnimation={backgroundCoverflowAnimation}
          scrollAnimationDuration={420}
          onSnapToItem={setActiveBackgroundIndex}
          renderItem={({ item }) => (
            <View style={[styles.carouselItem, { width: backgroundPageWidth, height: backgroundPageHeight }]}>
              <ChatBackgroundCard
                item={item}
                width={backgroundCardWidth}
                height={backgroundCardHeight}
                onLoad={handleBackgroundLoad}
              />
              <FitText
                style={[styles.carouselLabel, item.key === activeBackground.key && styles.carouselLabelActive]}
                minimumFontScale={0.65}
                numberOfLines={1}
              >
                {L(cosmeticNameKey(item.key))}
              </FitText>
            </View>
          )}
        />
      </View>
      <FlexGap {...gaps.copy} />
      <View style={[styles.selectionCopy, compact && styles.selectionCopyCompact]}>
        <FitText style={[styles.itemTitle, compact && styles.itemTitleCompact]} minimumFontScale={0.75}>
          {L(cosmeticNameKey(activeBackground.key))}
        </FitText>
        <AdaptiveText style={[styles.subtitle, compact && styles.subtitleCompact]} numberOfLines={compact ? 1 : 2}>
          {L(cosmeticBlurbKey(activeBackground.key))}
        </AdaptiveText>
      </View>
      <FlexGap {...gaps.button} />
      <PurchaseButton
        label={paymentBusy === 'background'
          ? L('storeOpeningPayment')
          : backgroundOwned
            ? backgroundActive ? L('storeRemoveBackground') : L('storeApplyBackground')
            : L('storeBuyBackground').replace('{price}', '99 ₽')}
        icon="image-outline"
        width={buttonWidth}
        height={buttonHeight}
        borderColor={PEARL_BORDER}
        surfaceColor="rgba(244,240,232,0.12)"
        contentColor="#F6F0E5"
        disabled={paymentBusy !== null}
        onPress={() => void openSharedCheckout('background')}
      />
    </>
  );

  const frameSection = (
    <>
      <View style={styles.sectionHeadingRow}>
        <MaterialCommunityIcons name="account-star-outline" size={compact ? 17 : 19} color={CROWN_GOLD} />
        <FitText style={[styles.sectionHeading, compact && styles.sectionHeadingCompact]} minimumFontScale={0.75}>
          {L('storeAvatarFrames')}
        </FitText>
      </View>
      <FlexGap {...gaps.heading} />
      <View style={[styles.carouselWrap, { height: frameCarouselBox }]}>
        <Carousel
          key={`frame-${orientKey}-${framePageWidth}-${frameSize}`}
          width={framePageWidth}
          height={framePageHeight}
          data={FRAME_CATALOG}
          defaultIndex={activeFrameIndex}
          loop
          style={{ width: sectionWidth, justifyContent: 'center', overflow: 'visible' }}
          containerStyle={{ overflow: 'visible' }}
          customAnimation={frameCoverflowAnimation}
          scrollAnimationDuration={420}
          onSnapToItem={setActiveFrameIndex}
          renderItem={({ item }) => (
            <View style={[styles.carouselItem, { width: framePageWidth, height: framePageHeight }]}>
              <FrameCoverCard item={item} size={frameSize} active={visible} onLoad={handleFrameLoad} />
              <FitText
                style={[styles.carouselLabel, item.key === activeFrame.key && styles.carouselLabelActive]}
                minimumFontScale={0.65}
                numberOfLines={1}
              >
                {L(cosmeticNameKey(item.key))}
              </FitText>
            </View>
          )}
        />
      </View>
      <FlexGap {...gaps.copy} />
      <View style={[styles.selectionCopy, compact && styles.selectionCopyCompact]}>
        <FitText style={[styles.itemTitle, compact && styles.itemTitleCompact]} minimumFontScale={0.75}>
          {L(cosmeticNameKey(activeFrame.key))}
        </FitText>
        <AdaptiveText style={[styles.subtitle, compact && styles.subtitleCompact]} numberOfLines={compact ? 1 : 2}>
          {L(cosmeticBlurbKey(activeFrame.key))}
        </AdaptiveText>
      </View>
      <FlexGap {...gaps.button} />
      <PurchaseButton
        label={paymentBusy === 'frame'
          ? L('storeOpeningPayment')
          : frameOwned
            ? frameActive ? L('storeRemoveFrame') : L('storeApplyFrame')
            : L('storeBuyFrame').replace('{price}', '199 ₽')}
        icon="account-circle-outline"
        width={buttonWidth}
        height={buttonHeight}
        borderColor={activeFrame.colors[1]}
        surfaceColor={withAlpha(activeFrame.colors[0], 0.12)}
        contentColor={activeFrame.colors[0]}
        disabled={paymentBusy !== null}
        onPress={() => void openSharedCheckout('frame')}
      />
    </>
  );

  return (
      <View style={styles.root} onLayout={onRootLayout}>
        {/* Края темнее, чем у сплэша и экранов звонка. */}
        <WelcomeStageBackground palette="tealDeep" />
        <View
          key={`legendary-${orientKey}`}
          style={[
            styles.page,
            {
              paddingTop: pagePaddingTop,
              // Именно insets.bottom + зазор, а не max(): max() прижимал кнопку
              // вплотную к системной навигации, и на трёхкнопочной она визуально
              // сливалась с панелью. Зазор нужен поверх инсета, а не вместо него.
              paddingBottom: pagePaddingBottom,
              paddingLeft: insets.left + pageHorizontalPadding,
              paddingRight: insets.right + pageHorizontalPadding,
            },
          ]}
          pointerEvents={orientationCovering ? 'none' : 'auto'}
        >
          <View style={[styles.header, headerCompact && styles.headerCompact]}>
            <View style={styles.titleRow}>
              <MaterialCommunityIcons name="crown" size={headerCompact ? 22 : 26} color={CROWN_GOLD} />
              <FitText style={[styles.title, headerCompact && styles.titleCompact]} minimumFontScale={0.8}>
                LEGENDARY
              </FitText>
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              style={({ pressed }) => [styles.closeBtn, pressed && styles.closeBtnPressed]}
              accessibilityRole="button"
              accessibilityLabel={L('storeClose')}
            >
              <MaterialIcons name="close" size={22} color={CROWN_GOLD} />
            </Pressable>
          </View>

          <View
            style={[
              styles.lowerContent,
              {
                width: landscape ? '100%' : portraitContentWidth,
                alignSelf: 'center',
              },
            ]}
          >
            {landscape ? (
              <View style={[styles.sectionsLandscape, { gap: sectionsGap }]}>
                <View style={[styles.storeColumn, styles.storeColumnLandscape]}>
                  <FlexGap {...gaps.top} />
                  {backgroundSection}
                </View>
                <View style={[styles.storeColumn, styles.storeColumnLandscape]}>
                  <FlexGap {...gaps.top} />
                  {frameSection}
                </View>
              </View>
            ) : (
              <View style={styles.storeColumn}>
                <FlexGap {...gaps.top} />
                {backgroundSection}
                <FlexGap {...gaps.section} />
                {frameSection}
              </View>
            )}
          </View>
        </View>

        <AppDialogModal
          visible={!!purchaseNotice}
          onRequestClose={closePurchaseNotice}
          icon={
            shownNotice ? (
              <MaterialCommunityIcons
                name={shownNotice.kind === 'success'
                  ? 'check-circle-outline'
                  : shownNotice.kind === 'error'
                    ? 'alert-circle-outline'
                    : 'close-circle-outline'}
                size={22}
                color={shownNotice.kind === 'success'
                  ? CROWN_GOLD
                  : shownNotice.kind === 'error'
                    ? '#FF5A67'
                    : WELCOME_MUTED_TEXT}
              />
            ) : null
          }
          title={shownNotice ? L(shownNotice.title) : undefined}
          message={shownNotice ? L(shownNotice.message) : undefined}
          actions={
            shownNotice
              ? [{
                  label: shownNotice.kind === 'error' ? L('storeClose') : L('storeOk'),
                  onPress: closePurchaseNotice,
                  variant: shownNotice.kind === 'error'
                    ? 'danger'
                    : shownNotice.kind === 'canceled'
                      ? 'cancel'
                      : 'primary',
                }]
              : []
          }
        />
        {visible ? <OrientationCoverModal covering={orientationCovering} /> : null}
      </View>
  );
}

const styles = StyleSheet.create({
  // Новая сцена: бирюза карточек у краёв → серый «Поиска» в середине.
  root: { flex: 1, backgroundColor: HOME_NAV_BG },
  page: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    minHeight: 42,
  },
  headerCompact: { minHeight: 34 },
  titleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: {
    color: CROWN_GOLD,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 1.4,
    flexShrink: 1,
    minWidth: 0,
  },
  titleCompact: { fontSize: 14 },
  closeBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  closeBtnPressed: { opacity: 0.72 },
  lowerContent: { flex: 1, minHeight: 0 },
  sectionsLandscape: { flex: 1, minHeight: 0, flexDirection: 'row', alignItems: 'stretch' },
  // flex-end: если высоты всё же не хватит, контент уходит под шапку, а кнопка
  // покупки остаётся над системной панелью.
  storeColumn: {
    flex: 1,
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    overflow: 'visible',
  },
  storeColumnLandscape: { paddingHorizontal: 4 },
  sectionHeadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    minHeight: 22,
    paddingHorizontal: 12,
  },
  sectionHeading: {
    color: CROWN_GOLD,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
    textAlign: 'center',
  },
  sectionHeadingCompact: { fontSize: 11 },
  carouselWrap: { width: '100%', alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  carouselItem: { alignItems: 'center', justifyContent: 'center', gap: 7 },
  cardShadow: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 9 },
    shadowOpacity: 0.42,
    shadowRadius: 13,
    elevation: 9,
  },
  backgroundCard: { overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)' },
  chatBubble: {
    position: 'absolute',
    height: '13%',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: CHAT_BUBBLE_BORDER,
  },
  chatBubbleLeft: {
    width: '34%',
    left: '10%',
    bottom: '26%',
    backgroundColor: CHAT_BUBBLE_IN,
  },
  chatBubbleRight: {
    width: '42%',
    right: '9%',
    bottom: '9%',
    backgroundColor: CHAT_BUBBLE_OUT,
  },
  carouselLabel: {
    color: 'rgba(139,148,158,0.48)',
    fontSize: 11,
    fontWeight: '600',
    width: 118,
    textAlign: 'center',
  },
  carouselLabelActive: { color: WELCOME_HEADER_TITLE },
  selectionCopy: {
    minHeight: 48,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  selectionCopyCompact: { minHeight: 34, paddingHorizontal: 14 },
  itemTitle: { color: WELCOME_HEADER_TITLE, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  itemTitleCompact: { fontSize: 15 },
  // Высота под все строки (numberOfLines) заранее: однострочное описание не
  // поднимает кнопку под ним, меняются только сами строки.
  subtitle: {
    marginTop: 3,
    minHeight: 32,
    color: WELCOME_MUTED_TEXT,
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
  subtitleCompact: { marginTop: 1, minHeight: 13, fontSize: 10, lineHeight: 13 },
  ctaWrap: { overflow: 'visible', flexShrink: 0 },
  ctaDisabled: { opacity: 0.62 },
  ctaPressed: { opacity: 0.88 },
  ctaInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    minWidth: 0,
    borderWidth: 1.25,
  },
  ctaText: {
    fontSize: 15,
    fontWeight: '800',
    flexShrink: 1,
    minWidth: 0,
    textAlign: 'center',
  },
});

export default FramesStoreModal;
