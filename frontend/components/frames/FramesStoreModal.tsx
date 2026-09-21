import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import Carousel from 'react-native-reanimated-carousel';
import { Extrapolation, interpolate } from 'react-native-reanimated';
import AdaptiveText from '../AdaptiveText';
import FitText from '../FitText';
import {
  checkCosmeticPayment,
  createCosmeticPayment,
  loadCosmetics,
  setActiveCosmetic,
  useCosmetics,
  type CosmeticKind,
} from '../../utils/cosmetics';
import {
  CROWN_GOLD,
  SEARCH_CTA_MAX_WIDTH,
  SEARCH_CTA_TABLET_MAX_WIDTH,
  SEARCH_CTA_TABLET_MIN_WIDTH,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
} from '../../screens/home/constants';
import {
  WelcomeOverlayCard,
  WelcomeOverlayDim,
  WelcomeOverlayPill,
} from '../../screens/home/WelcomeOverlayChrome';

const SHOWCASE_AVATAR = require('../../assets/frames/showcase-avatar.jpg');

type Props = {
  visible: boolean;
  onClose: () => void;
  myUserId?: string;
  myAvatarVer?: number;
  avatarUri?: string;
  nick?: string;
  /** Единая оплата для фонов чата и рамок аватара. */
  onUnlock?: () => void;
};

type FrameItem = {
  key: string;
  label: string;
  blurb: string;
  colors: readonly [string, string, ...string[]];
  kind: 'ring';
};

type ChatBackgroundItem = {
  key: string;
  label: string;
  blurb: string;
  source: number;
};

type PurchaseNotice = {
  kind: 'success' | 'canceled' | 'error';
  title: string;
  message: string;
};

const PEARL_BORDER = 'rgba(238,229,244,0.9)';
const LEGENDARY_BACKGROUND = ['#0E1D24', '#0C171F', '#0A111B', '#0B1821'] as const;
const CHAT_BUBBLE_IN = 'rgba(26, 32, 42, 0.98)';
const CHAT_BUBBLE_OUT = 'rgba(14, 20, 32, 0.99)';
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
    label: 'Неон',
    blurb: 'Глубокий синий узор для спокойных ночных разговоров.',
    source: require('../../assets/chat-wallpapers/dark/doodles-cyan.jpeg'),
  },
  {
    key: 'deep-space',
    label: 'Космос',
    blurb: 'Глубокий синий фон со звёздами и лёгким свечением.',
    source: require('../../assets/chat-wallpapers/dark/cosmos.jpeg'),
  },
  {
    key: 'poetry',
    label: 'Пушкин',
    blurb: 'Литературный фон с характером для тёплых личных диалогов.',
    source: require('../../assets/chat-wallpapers/dark/pushkin.jpeg'),
  },
  {
    key: 'ocean-flow',
    label: 'Бирюза',
    blurb: 'Прохладный узор и чистые оттенки бирюзы для каждого диалога.',
    source: require('../../assets/chat-wallpapers/dark/doodles-teal.jpeg'),
  },
  {
    key: 'graphite-chat',
    label: 'Письма',
    blurb: 'Сдержанный тёмный фон с рукописными деталями и ясным контрастом.',
    source: require('../../assets/chat-wallpapers/dark/letters.jpeg'),
  },
];

const FRAME_CATALOG: FrameItem[] = [
  {
    key: 'fire',
    label: 'Огонь',
    blurb: 'Живая рамка вокруг аватара. Тебя видно первым в списках, звонках и профиле.',
    colors: ['#FFC062', '#FF8A34', '#FF4D1C'],
    kind: 'ring',
  },
  {
    key: 'diamond',
    label: 'Бриллиант',
    blurb: 'Холодные блики по ободу, вдохновлённые сиянием граней камня.',
    colors: ['#E8F6FF', '#9ED0FF', '#6AA9FF'],
    kind: 'ring',
  },
  {
    key: 'aurora',
    label: 'Аврора',
    blurb: 'Перелив бирюзового и синего в узнаваемом стиле LiVi.',
    colors: ['#7CF5C8', '#5AA9FF', '#3B82F6'],
    kind: 'ring',
  },
  {
    key: 'palladium',
    label: 'Палладий',
    blurb: 'Спокойный металлический обод с мягким световым бликом.',
    colors: ['#F2F4F7', '#C5CCD6', '#8B93A0'],
    kind: 'ring',
  },
  {
    key: 'frost',
    label: 'Лёд',
    blurb: 'Кристальная кромка с холодным голубым свечением.',
    colors: ['#D9F4FF', '#7EC8E8', '#4A9BC7'],
    kind: 'ring',
  },
  {
    key: 'jade',
    label: 'Нефрит',
    blurb: 'Глубокий зелёный обод с мягким внутренним сиянием.',
    colors: ['#B8F0D0', '#3DCF8E', '#1B8F5A'],
    kind: 'ring',
  },
  {
    key: 'void',
    label: 'Опал',
    blurb: 'Тёмный обод с редким фиолетовым и радужным отблеском.',
    colors: ['#D4B5FF', '#7B5CFF', '#2A1B4A'],
    kind: 'ring',
  },
  {
    key: 'obsidian',
    label: 'Обсидиан',
    blurb: 'Матовый чёрный контур с тонкой серебряной искрой.',
    colors: ['#6B7280', '#374151', '#111827'],
    kind: 'ring',
  },
];

function ChatBackgroundCard({ item, width, height }: { item: ChatBackgroundItem; width: number; height: number }) {
  return (
    <View style={styles.cardShadow}>
      <View style={[styles.backgroundCard, { width, height, borderRadius: Math.round(height * 0.16) }]}>
        <ExpoImage
          source={item.source}
          style={StyleSheet.absoluteFillObject}
          contentFit="cover"
          cachePolicy="memory-disk"
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

function FrameCoverCard({ item, size }: { item: FrameItem; size: number }) {
  const ringWidth = Math.max(2, Math.round(size * 0.025));
  const avatarSize = size - ringWidth * 2;


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
          style={{ width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 }}
          contentFit="cover"
          cachePolicy="memory-disk"
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
  compact,
  topMargin,
  verticalOffset = 0,
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
  compact?: boolean;
  topMargin?: number;
  verticalOffset?: number;
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
        compact && styles.ctaWrapCompact,
        { width, ...(topMargin !== undefined ? { marginTop: topMargin } : null) },
        disabled && styles.ctaDisabled,
        pressed && !disabled && styles.ctaPressed,
        { transform: [{ translateY: verticalOffset }, ...(pressed && !disabled ? [{ scale: 0.985 }] : [])] },
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

export function FramesStoreModal({ visible, onClose, onUnlock }: Props) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useSafeAreaFrame();
  const landscape = windowWidth > windowHeight;
  const compact = windowHeight < (landscape ? 430 : 720);
  const pageHorizontalPadding = landscape ? 12 : 0;
  const sectionsGap = landscape ? 12 : 0;
  const safeContentWidth = Math.max(0, windowWidth - insets.left - insets.right - pageHorizontalPadding * 2);
  const portraitContentWidth = Math.min(safeContentWidth, 720);
  const sectionWidth = landscape
    ? Math.max(0, (safeContentWidth - sectionsGap) / 2)
    : portraitContentWidth;

  const backgroundCardWidth = compact ? 128 : landscape ? 144 : 158;
  const backgroundCardHeight = Math.round(backgroundCardWidth * 0.61);
  const backgroundPageWidth = compact ? 76 : 88;
  const backgroundPageHeight = backgroundCardHeight + (compact ? 24 : 30);
  const frameSize = compact ? 84 : landscape ? 96 : 106;
  const framePageWidth = compact ? 54 : 62;
  const framePageHeight = frameSize + (compact ? 26 : 34);
  const backgroundHeadingOffset = landscape ? 0 : compact ? -16 : -25;
  const backgroundContentOffset = landscape ? 0 : compact ? -5 : -8;
  const backgroundCarouselOffset = backgroundContentOffset + (landscape ? 0 : compact ? -8 : -11);
  const frameHeadingTopOffset = landscape ? 0 : compact ? 6 : 12;
  const frameCarouselTopOffset = landscape ? 0 : compact ? 12 : 21;
  const frameDescriptionTopOffset = landscape ? 0 : compact ? 30 : 47;

  const maxCtaWidth =
    sectionWidth >= SEARCH_CTA_TABLET_MIN_WIDTH ? SEARCH_CTA_TABLET_MAX_WIDTH : SEARCH_CTA_MAX_WIDTH;
  const buttonWidth = Math.min(Math.max(180, sectionWidth - (compact ? 28 : 44)), maxCtaWidth);
  const buttonHeight = compact ? 40 : Platform.OS === 'ios' ? 46 : 44;
  const contentTopOffset = landscape ? 0 : compact ? 16 : 28;

  const [activeBackgroundIndex, setActiveBackgroundIndex] = useState(0);
  const [activeFrameIndex, setActiveFrameIndex] = useState(0);
  const [paymentBusy, setPaymentBusy] = useState<CosmeticKind | null>(null);
  const [pendingPaymentId, setPendingPaymentId] = useState('');
  const [purchaseNotice, setPurchaseNotice] = useState<PurchaseNotice | null>(null);
  const entitlements = useCosmetics();
  const activeBackground = CHAT_BACKGROUND_CATALOG[activeBackgroundIndex] ?? CHAT_BACKGROUND_CATALOG[0];
  const activeFrame = FRAME_CATALOG[activeFrameIndex] ?? FRAME_CATALOG[0];

  useEffect(() => {
    if (!visible) return;
    void loadCosmetics(true).catch(() => {});
  }, [visible]);

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
          title: 'Покупка готова',
          message: 'Выбранное оформление применено к вашему профилю.',
        });
      } else if (result.status === 'canceled') {
        setPendingPaymentId('');
        setPaymentBusy(null);
        setPurchaseNotice({
          kind: 'canceled',
          title: 'Оплата отменена',
          message: 'Покупка не была завершена. Вы можете попробовать ещё раз.',
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

  if (!visible) return null;

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
        title: 'Не удалось открыть оплату',
        message: 'Проверьте подключение и попробуйте ещё раз.',
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

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={handleRequestClose} statusBarTranslucent>
      <View style={styles.root}>
        <LinearGradient
          key={`legendary-background-${landscape ? 'landscape' : 'portrait'}-${Math.round(windowWidth)}x${Math.round(windowHeight)}`}
          colors={[...LEGENDARY_BACKGROUND]}
          locations={[0, 0.16, 0.38, 1]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFillObject}
          pointerEvents="none"
        />
        <View
          style={[
            styles.page,
            {
              paddingTop: insets.top + (compact ? 2 : Platform.OS === 'ios' ? 7 : 10),
              // Именно insets.bottom + зазор, а не max(): max() прижимал кнопку
              // вплотную к системной навигации, и на трёхкнопочной она визуально
              // сливалась с панелью. Зазор нужен поверх инсета, а не вместо него.
              paddingBottom: insets.bottom + (compact ? 10 : 16),
              paddingLeft: insets.left + pageHorizontalPadding,
              paddingRight: insets.right + pageHorizontalPadding,
            },
          ]}
        >
          <View style={[styles.header, compact && styles.headerCompact]}>
            <View style={styles.titleRow}>
              <MaterialCommunityIcons name="crown" size={compact ? 22 : 26} color={CROWN_GOLD} />
              <FitText style={[styles.title, compact && styles.titleCompact]} minimumFontScale={0.8}>
                LEGENDARY
              </FitText>
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              style={({ pressed }) => [styles.closeBtn, pressed && styles.closeBtnPressed]}
              accessibilityRole="button"
              accessibilityLabel="Закрыть"
            >
              <MaterialIcons name="close" size={22} color={CROWN_GOLD} />
            </Pressable>
          </View>

          <View
            style={[
              styles.lowerContent,
              {
                paddingTop: contentTopOffset,
                width: landscape ? '100%' : portraitContentWidth,
                alignSelf: 'center',
              },
            ]}
          >
            <View style={[styles.sections, landscape && styles.sectionsLandscape, { gap: sectionsGap }]}>
              <View style={[styles.storeSection, landscape && styles.storeSectionLandscape]}>
              <View
                style={[
                  styles.sectionHeadingRow,
                  { transform: [{ translateY: backgroundHeadingOffset }] },
                ]}
              >
                <MaterialCommunityIcons name="message-image-outline" size={compact ? 17 : 19} color={CROWN_GOLD} />
                <FitText style={[styles.sectionHeading, compact && styles.sectionHeadingCompact]} minimumFontScale={0.75}>
                  ФОНЫ ДЛЯ ЧАТА
                </FitText>
              </View>

              <View
                style={[
                  styles.carouselWrap,
                  { height: backgroundPageHeight, transform: [{ translateY: backgroundCarouselOffset }] },
                ]}
              >
                <Carousel
                  width={backgroundPageWidth}
                  height={backgroundPageHeight}
                  data={CHAT_BACKGROUND_CATALOG}
                  loop
                  style={{ width: sectionWidth, justifyContent: 'center', overflow: 'visible' }}
                  containerStyle={{ overflow: 'visible' }}
                  customAnimation={backgroundCoverflowAnimation}
                  scrollAnimationDuration={420}
                  onSnapToItem={setActiveBackgroundIndex}
                  renderItem={({ item }) => (
                    <View style={[styles.carouselItem, { width: backgroundPageWidth, height: backgroundPageHeight }]}>
                      <ChatBackgroundCard item={item} width={backgroundCardWidth} height={backgroundCardHeight} />
                      <FitText
                        style={[styles.carouselLabel, item.key === activeBackground.key && styles.carouselLabelActive]}
                        minimumFontScale={0.65}
                        numberOfLines={1}
                      >
                        {item.label}
                      </FitText>
                    </View>
                  )}
                />
              </View>

              <View
                style={[
                  styles.selectionCopy,
                  compact && styles.selectionCopyCompact,
                  { transform: [{ translateY: backgroundContentOffset }] },
                ]}
              >
                <FitText style={[styles.itemTitle, compact && styles.itemTitleCompact]} minimumFontScale={0.75}>
                  {activeBackground.label}
                </FitText>
                <AdaptiveText style={[styles.subtitle, compact && styles.subtitleCompact]} numberOfLines={compact ? 1 : 2}>
                  {activeBackground.blurb}
                </AdaptiveText>
              </View>

              <PurchaseButton
                label={paymentBusy === 'background'
                  ? 'Открываем оплату…'
                  : backgroundOwned
                    ? backgroundActive ? 'Снять фон' : 'Применить фон'
                    : 'Купить фон · 99 ₽'}
                icon="image-outline"
                width={buttonWidth}
                height={buttonHeight}
                borderColor={PEARL_BORDER}
                surfaceColor="rgba(244,240,232,0.12)"
                contentColor="#F6F0E5"
                compact={compact}
                topMargin={compact ? 2 : 5}
                verticalOffset={backgroundContentOffset}
                disabled={paymentBusy !== null}
                onPress={() => void openSharedCheckout('background')}
              />
              </View>

              <View style={[styles.storeSection, landscape && styles.storeSectionLandscape]}>
              <View
                style={[
                  styles.sectionHeadingRow,
                  { transform: [{ translateY: frameHeadingTopOffset }] },
                ]}
              >
                <MaterialCommunityIcons name="account-star-outline" size={compact ? 17 : 19} color={CROWN_GOLD} />
                <FitText style={[styles.sectionHeading, compact && styles.sectionHeadingCompact]} minimumFontScale={0.75}>
                  РАМКИ ДЛЯ АВАТАРА
                </FitText>
              </View>

              <View
                style={[
                  styles.carouselWrap,
                  { height: framePageHeight, transform: [{ translateY: frameCarouselTopOffset }] },
                ]}
              >
                <Carousel
                  width={framePageWidth}
                  height={framePageHeight}
                  data={FRAME_CATALOG}
                  loop
                  style={{ width: sectionWidth, justifyContent: 'center', overflow: 'visible' }}
                  containerStyle={{ overflow: 'visible' }}
                  customAnimation={frameCoverflowAnimation}
                  scrollAnimationDuration={420}
                  onSnapToItem={setActiveFrameIndex}
                  renderItem={({ item }) => (
                    <View style={[styles.carouselItem, { width: framePageWidth, height: framePageHeight }]}>
                      <FrameCoverCard item={item} size={frameSize} />
                      <FitText
                        style={[styles.carouselLabel, item.key === activeFrame.key && styles.carouselLabelActive]}
                        minimumFontScale={0.65}
                        numberOfLines={1}
                      >
                        {item.label}
                      </FitText>
                    </View>
                  )}
                />
              </View>

              <View
                style={[
                  styles.selectionCopy,
                  compact && styles.selectionCopyCompact,
                  { transform: [{ translateY: frameDescriptionTopOffset }] },
                ]}
              >
                <FitText style={[styles.itemTitle, compact && styles.itemTitleCompact]} minimumFontScale={0.75}>
                  {activeFrame.label}
                </FitText>
                <AdaptiveText style={[styles.subtitle, compact && styles.subtitleCompact]} numberOfLines={compact ? 1 : 2}>
                  {activeFrame.blurb}
                </AdaptiveText>
              </View>

              <PurchaseButton
                label={paymentBusy === 'frame'
                  ? 'Открываем оплату…'
                  : frameOwned
                    ? frameActive ? 'Снять рамку' : 'Применить рамку'
                    : 'Купить рамку · 199 ₽'}
                icon="account-circle-outline"
                width={buttonWidth}
                height={buttonHeight}
                borderColor={activeFrame.colors[1]}
                surfaceColor={withAlpha(activeFrame.colors[0], 0.12)}
                contentColor={activeFrame.colors[0]}
                compact={compact}
                topMargin={landscape ? (compact ? 8 : 16) : compact ? 35 : 61}
                disabled={paymentBusy !== null}
                onPress={() => void openSharedCheckout('frame')}
              />
              </View>
            </View>
          </View>
        </View>

        {purchaseNotice ? (
          <View style={styles.purchaseNoticeLayer} accessibilityViewIsModal>
            <WelcomeOverlayDim strong={purchaseNotice.kind === 'error'} />
            <Pressable
              style={StyleSheet.absoluteFillObject}
              onPress={closePurchaseNotice}
              accessibilityRole="button"
              accessibilityLabel="Закрыть"
            />
            <WelcomeOverlayCard style={styles.purchaseNoticeCard} opaque>
              <View style={styles.purchaseNoticeHeader}>
                <LinearGradient
                  colors={purchaseNotice.kind === 'success'
                    ? ['rgba(218,178,92,0.30)', 'rgba(46,196,182,0.12)']
                    : purchaseNotice.kind === 'error'
                      ? ['rgba(255,90,103,0.26)', 'rgba(255,90,103,0.08)']
                      : ['rgba(188,196,208,0.18)', 'rgba(188,196,208,0.06)']}
                  style={[
                    styles.purchaseNoticeIcon,
                    purchaseNotice.kind === 'success'
                      ? styles.purchaseNoticeIconSuccess
                      : purchaseNotice.kind === 'error'
                        ? styles.purchaseNoticeIconError
                        : styles.purchaseNoticeIconCanceled,
                  ]}
                >
                  <MaterialCommunityIcons
                    name={purchaseNotice.kind === 'success'
                      ? 'check-circle-outline'
                      : purchaseNotice.kind === 'error'
                        ? 'alert-circle-outline'
                        : 'close-circle-outline'}
                    size={27}
                    color={purchaseNotice.kind === 'success'
                      ? CROWN_GOLD
                      : purchaseNotice.kind === 'error'
                        ? '#FF5A67'
                        : WELCOME_MUTED_TEXT}
                  />
                </LinearGradient>
                <FitText style={styles.purchaseNoticeTitle} minimumFontScale={0.78} numberOfLines={2}>
                  {purchaseNotice.title}
                </FitText>
              </View>

              <AdaptiveText style={styles.purchaseNoticeMessage}>
                {purchaseNotice.message}
              </AdaptiveText>

              <View style={styles.purchaseNoticeDivider} />
              <WelcomeOverlayPill
                label={purchaseNotice.kind === 'error' ? 'Закрыть' : 'Хорошо'}
                onPress={closePurchaseNotice}
                variant={purchaseNotice.kind === 'error'
                  ? 'danger'
                  : purchaseNotice.kind === 'canceled'
                    ? 'secondary'
                    : 'primary'}
              />
            </WelcomeOverlayCard>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0C1720' },
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
  purchaseNoticeLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  purchaseNoticeCard: {
    zIndex: 1,
    width: '100%',
    maxWidth: 380,
    padding: 20,
    borderColor: 'rgba(238,229,244,0.16)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.5,
    shadowRadius: 24,
    elevation: 18,
  },
  purchaseNoticeHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  purchaseNoticeIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  purchaseNoticeIconSuccess: { borderColor: 'rgba(218,178,92,0.50)' },
  purchaseNoticeIconError: { borderColor: 'rgba(255,90,103,0.56)' },
  purchaseNoticeIconCanceled: { borderColor: 'rgba(188,196,208,0.28)' },
  purchaseNoticeTitle: {
    flex: 1,
    minWidth: 0,
    color: WELCOME_HEADER_TITLE,
    fontSize: 19,
    lineHeight: 24,
    fontWeight: '800',
  },
  purchaseNoticeMessage: {
    marginTop: 14,
    color: WELCOME_MUTED_TEXT,
    fontSize: 14,
    lineHeight: 20,
  },
  purchaseNoticeDivider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 16,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  sections: { flex: 1, minHeight: 0 },
  sectionsLandscape: { flexDirection: 'row', alignItems: 'stretch' },
  storeSection: {
    flex: 1,
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'space-evenly',
    overflow: 'visible',
  },
  storeSectionLandscape: { paddingHorizontal: 4 },
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
    marginTop: 12,
    minHeight: 48,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  selectionCopyCompact: { marginTop: 6, minHeight: 34, paddingHorizontal: 14 },
  itemTitle: { color: WELCOME_HEADER_TITLE, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  itemTitleCompact: { fontSize: 15 },
  subtitle: {
    marginTop: 3,
    color: WELCOME_MUTED_TEXT,
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
  subtitleCompact: { marginTop: 1, fontSize: 10, lineHeight: 13 },
  ctaWrap: { overflow: 'visible', flexShrink: 0, marginTop: 16 },
  ctaWrapCompact: { marginTop: 8 },
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
