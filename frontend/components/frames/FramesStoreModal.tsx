import React, { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Linking, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import Carousel from 'react-native-reanimated-carousel';
import { Extrapolation, interpolate } from 'react-native-reanimated';
import PngFireFrame from './PngFireFrame';
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
  kind: 'fire' | 'ring';
};

type ChatBackgroundItem = {
  key: string;
  label: string;
  blurb: string;
  source: number;
};

const PEARL_BORDER = 'rgba(238,229,244,0.9)';
const LEGENDARY_BACKGROUND = ['#0E1D24', '#0C171F', '#0A111B', '#0B1821'] as const;

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
    kind: 'fire',
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
  const avatarSize = item.kind === 'fire' ? Math.round(size * 0.78) : size - ringWidth * 2;

  if (item.kind === 'fire') {
    return (
      <View style={styles.cardShadow}>
        <PngFireFrame size={avatarSize} ringScale={1.24} calm>
          <ExpoImage
            source={SHOWCASE_AVATAR}
            style={{ width: avatarSize, height: avatarSize }}
            contentFit="cover"
            cachePolicy="memory-disk"
          />
        </PngFireFrame>
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
      style={({ pressed }) => [styles.ctaWrap, { width }, disabled && styles.ctaDisabled, pressed && !disabled && styles.ctaPressed]}
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
  const compact = windowHeight < (landscape ? 430 : 680);
  const pageHorizontalPadding = landscape ? 12 : 0;
  const sectionsGap = landscape ? 12 : 0;
  const safeContentWidth = Math.max(0, windowWidth - insets.left - insets.right - pageHorizontalPadding * 2);
  const sectionWidth = landscape ? Math.max(0, (safeContentWidth - sectionsGap) / 2) : safeContentWidth;

  const backgroundCardWidth = compact ? 128 : landscape ? 144 : 158;
  const backgroundCardHeight = Math.round(backgroundCardWidth * 0.61);
  const backgroundPageWidth = compact ? 76 : 88;
  const backgroundPageHeight = backgroundCardHeight + (compact ? 24 : 30);
  const frameSize = compact ? 84 : landscape ? 96 : 106;
  const framePageWidth = compact ? 54 : 62;
  const framePageHeight = frameSize + (compact ? 26 : 34);

  const maxCtaWidth =
    sectionWidth >= SEARCH_CTA_TABLET_MIN_WIDTH ? SEARCH_CTA_TABLET_MAX_WIDTH : SEARCH_CTA_MAX_WIDTH;
  const buttonWidth = Math.min(Math.max(180, sectionWidth - (compact ? 28 : 44)), maxCtaWidth);
  const buttonHeight = compact ? 40 : Platform.OS === 'ios' ? 46 : 44;

  const [activeBackgroundIndex, setActiveBackgroundIndex] = useState(0);
  const [activeFrameIndex, setActiveFrameIndex] = useState(0);
  const [paymentBusy, setPaymentBusy] = useState<CosmeticKind | null>(null);
  const [pendingPaymentId, setPendingPaymentId] = useState('');
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
        Alert.alert('Покупка готова', 'Выбранное оформление применено к вашему профилю.');
      } else if (result.status === 'canceled') {
        setPendingPaymentId('');
        setPaymentBusy(null);
        Alert.alert('Оплата отменена', 'Покупка не была завершена.');
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
      Alert.alert('Не удалось открыть оплату', 'Проверьте подключение и попробуйте ещё раз.');
    } finally {
      setPaymentBusy(null);
    }
  };

  const backgroundOwned = entitlements.purchasedBackgroundIds.includes(activeBackground.key);
  const frameOwned = entitlements.purchasedFrameIds.includes(activeFrame.key);
  const backgroundActive = entitlements.activeBackgroundId === activeBackground.key;
  const frameActive = entitlements.activeFrameId === activeFrame.key;

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
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
              paddingBottom: Math.max(insets.bottom, compact ? 2 : 8),
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

          <View style={[styles.sections, landscape && styles.sectionsLandscape, { gap: sectionsGap }]}>
            <View style={[styles.storeSection, landscape && styles.storeSectionLandscape]}>
              <View style={styles.sectionHeadingRow}>
                <MaterialCommunityIcons name="message-image-outline" size={compact ? 17 : 19} color={CROWN_GOLD} />
                <FitText style={[styles.sectionHeading, compact && styles.sectionHeadingCompact]} minimumFontScale={0.75}>
                  ФОНЫ ДЛЯ ЧАТА
                </FitText>
              </View>

              <View style={[styles.carouselWrap, { height: backgroundPageHeight }]}>
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

              <View style={[styles.selectionCopy, compact && styles.selectionCopyCompact]}>
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
                    : 'Купить фон · 299 ₽'}
                icon="image-outline"
                width={buttonWidth}
                height={buttonHeight}
                borderColor={PEARL_BORDER}
                surfaceColor="rgba(244,240,232,0.12)"
                contentColor="#F6F0E5"
                disabled={paymentBusy !== null}
                onPress={() => void openSharedCheckout('background')}
              />
            </View>

            <View style={[styles.storeSection, landscape && styles.storeSectionLandscape]}>
              <View style={styles.sectionHeadingRow}>
                <MaterialCommunityIcons name="account-star-outline" size={compact ? 17 : 19} color={CROWN_GOLD} />
                <FitText style={[styles.sectionHeading, compact && styles.sectionHeadingCompact]} minimumFontScale={0.75}>
                  РАМКИ ДЛЯ АВАТАРА
                </FitText>
              </View>

              <View style={[styles.carouselWrap, { height: framePageHeight }]}>
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

              <View style={[styles.selectionCopy, compact && styles.selectionCopyCompact]}>
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
                    : 'Купить рамку · 299 ₽'}
                icon="account-circle-outline"
                width={buttonWidth}
                height={buttonHeight}
                borderColor={activeFrame.colors[1]}
                surfaceColor={withAlpha(activeFrame.colors[0], 0.12)}
                contentColor={activeFrame.colors[0]}
                disabled={paymentBusy !== null}
                onPress={() => void openSharedCheckout('frame')}
              />
            </View>
          </View>

          <FitText style={[styles.sharedPaymentHint, compact && styles.sharedPaymentHintCompact]} minimumFontScale={0.72}>
            Обе кнопки открывают единую оплату Legendary
          </FitText>
        </View>
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
  chatBubble: { position: 'absolute', height: '13%', borderRadius: 999 },
  chatBubbleLeft: {
    width: '34%',
    left: '10%',
    bottom: '26%',
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  chatBubbleRight: {
    width: '42%',
    right: '9%',
    bottom: '9%',
    backgroundColor: 'rgba(107,232,209,0.72)',
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
  subtitle: {
    marginTop: 3,
    color: WELCOME_MUTED_TEXT,
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
  subtitleCompact: { marginTop: 1, fontSize: 10, lineHeight: 13 },
  ctaWrap: { overflow: 'visible', flexShrink: 0 },
  ctaDisabled: { opacity: 0.62 },
  ctaPressed: { opacity: 0.88, transform: [{ scale: 0.985 }] },
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
  sharedPaymentHint: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    paddingHorizontal: 18,
    paddingTop: 5,
  },
  sharedPaymentHintCompact: { fontSize: 9, lineHeight: 12, paddingTop: 2 },
});

export default FramesStoreModal;
