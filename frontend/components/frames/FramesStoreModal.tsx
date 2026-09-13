import React, { useCallback, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import Carousel from 'react-native-reanimated-carousel';
import { Extrapolation, interpolate } from 'react-native-reanimated';
import PngFireFrame, { type PngFireFrameHandle } from './PngFireFrame';
import AdaptiveText from '../AdaptiveText';
import FitText from '../FitText';
import { WelcomeStageBackground } from '../../screens/home/WelcomeStageBackground';
import {
  CROWN_GOLD,
  SEARCH_CTA_MAX_WIDTH,
  SEARCH_CTA_TABLET_MAX_WIDTH,
  SEARCH_CTA_TABLET_MIN_WIDTH,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
} from '../../screens/home/constants';

/** Демо-аватар витрины рамок (Pinterest pin 48273027253923425). */
const SHOWCASE_AVATAR = require('../../assets/frames/showcase-avatar.jpg');

type Props = {
  visible: boolean;
  onClose: () => void;
  myUserId?: string;
  myAvatarVer?: number;
  avatarUri?: string;
  nick?: string;
  /** Реальная покупка (IAP). Если не передан — показываем «скоро». */
  onUnlock?: () => void;
};

type FrameItem = {
  key: string;
  label: string;
  blurb: string;
  colors: readonly [string, string, ...string[]];
  locked: boolean;
  kind: 'fire' | 'ring';
};

const FIRE_CTA = ['#FFC062', '#FF8A34', '#FF4D1C'] as const;
const CTA_BORDER_W = 1;

const FRAME_CATALOG: FrameItem[] = [
  {
    key: 'fire',
    label: 'Огонь',
    blurb: 'Живая рамка вокруг аватара. Тебя видно первым в списках, звонках и профиле — статус, который замечают.',
    colors: ['#FFC062', '#FF8A34', '#FF4D1C'],
    locked: false,
    kind: 'fire',
  },
  {
    key: 'diamond',
    label: 'Бриллиант',
    blurb: 'Холодные блики по ободу, как у грани камня. Скоро в коллекции Aura.',
    colors: ['#E8F6FF', '#9ED0FF', '#6AA9FF'],
    locked: true,
    kind: 'ring',
  },
  {
    key: 'aurora',
    label: 'Аврора',
    blurb: 'Перелив teal→blue в духе LiVi. Скоро откроется в сезонной линейке.',
    colors: ['#7CF5C8', '#5AA9FF', '#3B82F6'],
    locked: true,
    kind: 'ring',
  },
  {
    key: 'palladium',
    label: 'Палладий',
    blurb: 'Тихий металл с медленным бликом. Скоро в магазине рамок.',
    colors: ['#F2F4F7', '#C5CCD6', '#8B93A0'],
    locked: true,
    kind: 'ring',
  },
  {
    key: 'frost',
    label: 'Лёд',
    blurb: 'Кристальная кромка с холодным свечением. Готовим к релизу.',
    colors: ['#D9F4FF', '#7EC8E8', '#4A9BC7'],
    locked: true,
    kind: 'ring',
  },
  {
    key: 'jade',
    label: 'Нефрит',
    blurb: 'Глубокий зелёный обод с мягким дыханием. Скоро.',
    colors: ['#B8F0D0', '#3DCF8E', '#1B8F5A'],
    locked: true,
    kind: 'ring',
  },
  {
    key: 'void',
    label: 'Опал',
    blurb: 'Тёмный обод с радужным отблеском. Легендарка в подготовке.',
    colors: ['#D4B5FF', '#7B5CFF', '#2A1B4A'],
    locked: true,
    kind: 'ring',
  },
  {
    key: 'obsidian',
    label: 'Обсидиан',
    blurb: 'Матовый чёрный контур с тонкой искрой. Скоро в коллекции.',
    colors: ['#6B7280', '#374151', '#111827'],
    locked: true,
    kind: 'ring',
  },
];

const COVER_SIZE = 120;
/** Узкий шаг — обложки перекрываются, как в классическом Cover Flow. */
const PAGE_W = 68;
const PAGE_H = 168;
/** Толщина обода на карточках Cover Flow (px с каждой стороны). */
const COVER_RING = 3;
const SHOWCASE_RING = 3;

function CoverFlowCard({
  colors,
  locked,
  kind,
}: {
  colors: readonly string[];
  locked: boolean;
  kind: 'fire' | 'ring';
}) {
  const avatarSize = Math.round(COVER_SIZE * 0.78);

  if (kind === 'fire') {
    return (
      <View style={styles.coverShadow}>
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

  const inner = COVER_SIZE - COVER_RING * 2;
  return (
    <View style={styles.coverShadow}>
      <LinearGradient
        colors={colors as [string, string, ...string[]]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[
          styles.coverShell,
          { width: COVER_SIZE, height: COVER_SIZE, borderRadius: COVER_SIZE / 2, padding: COVER_RING },
        ]}
      >
        <View style={{ width: inner, height: inner, borderRadius: inner / 2, overflow: 'hidden' }}>
          <ExpoImage
            source={SHOWCASE_AVATAR}
            style={StyleSheet.absoluteFillObject}
            contentFit="cover"
            cachePolicy="memory-disk"
          />
          {locked ? (
            <View style={styles.coverLock}>
              <MaterialIcons name="lock" size={22} color="#FFF" />
            </View>
          ) : null}
        </View>
      </LinearGradient>
    </View>
  );
}

export function FramesStoreModal({ visible, onClose, onUnlock }: Props) {
  const fireRef = useRef<PngFireFrameHandle>(null);
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const sideInset = 44;
  const maxCtaWidth =
    windowWidth >= SEARCH_CTA_TABLET_MIN_WIDTH ? SEARCH_CTA_TABLET_MAX_WIDTH : SEARCH_CTA_MAX_WIDTH;
  const buttonWidth = Math.min(Math.max(0, windowWidth - sideInset * 2), maxCtaWidth);
  const buttonHeight = Platform.OS === 'ios' ? 52 : 48;
  const buttonRadius = buttonHeight / 2;
  const innerRadius = Math.max(0, buttonRadius - CTA_BORDER_W);

  const [activeBase, setActiveBase] = useState(0);
  const activeFrame = FRAME_CATALOG[activeBase] ?? FRAME_CATALOG[0];

  const coverflowAnimation = useCallback((value: number) => {
    'worklet';
    // Cover Flow без translateZ (Android: Invalid transform translateZ).
    const translateX = interpolate(
      value,
      [-3, -2, -1, 0, 1, 2, 3],
      [-PAGE_W * 2.1, -PAGE_W * 1.35, -PAGE_W * 0.55, 0, PAGE_W * 0.55, PAGE_W * 1.35, PAGE_W * 2.1],
      Extrapolation.CLAMP,
    );
    const rotateY = interpolate(
      value,
      [-2, -1, 0, 1, 2],
      [62, 58, 0, -58, -62],
      Extrapolation.CLAMP,
    );
    const scale = interpolate(value, [-2, -1, 0, 1, 2], [0.72, 0.84, 1.14, 0.84, 0.72], Extrapolation.CLAMP);
    const opacity = interpolate(value, [-3, -2, -1, 0, 1, 2, 3], [0.2, 0.45, 0.75, 1, 0.75, 0.45, 0.2], Extrapolation.CLAMP);
    const zIndex = Math.round(
      interpolate(value, [-3, -2, -1, 0, 1, 2, 3], [1, 3, 8, 30, 8, 3, 1], Extrapolation.CLAMP),
    );

    return {
      transform: [{ perspective: 1000 }, { translateX }, { rotateY: `${rotateY}deg` }, { scale }],
      opacity,
      zIndex,
    };
  }, []);

  // Не монтируем анимации, пока витрина закрыта (нет фоновых reanimated-циклов).
  if (!visible) return null;

  const handleUnlock = () => {
    if (activeFrame.locked) {
      Alert.alert(activeFrame.label, 'Эта рамка скоро появится в коллекции.');
      return;
    }
    if (onUnlock) {
      onUnlock();
      return;
    }
    Alert.alert('Огонь', 'Покупка рамок скоро будет доступна. Следи за обновлениями 🔥');
  };

  const showcaseSize = 132;

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <WelcomeStageBackground />
        <View
          style={[
            styles.page,
            {
              paddingTop: insets.top + (Platform.OS === 'ios' ? 8 : 12),
              paddingBottom: Math.max(insets.bottom - 10, 0),
            },
          ]}
        >
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <MaterialCommunityIcons name="crown" size={26} color={CROWN_GOLD} />
              <FitText style={styles.title} minimumFontScale={0.8}>
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

          <View style={styles.body}>
            <Pressable
              onPress={() => {
                if (activeFrame.kind === 'fire') fireRef.current?.ignite();
              }}
              style={styles.showcase}
            >
              {activeFrame.kind === 'fire' ? (
                <PngFireFrame key="fire-showcase" ref={fireRef} size={showcaseSize} ringScale={1.24}>
                  <ExpoImage
                    source={SHOWCASE_AVATAR}
                    style={styles.showcaseAvatar}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                  />
                </PngFireFrame>
              ) : (
                <LinearGradient
                  colors={activeFrame.colors as [string, string, ...string[]]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={[
                    styles.staticRing,
                    {
                      width: showcaseSize + SHOWCASE_RING * 2,
                      height: showcaseSize + SHOWCASE_RING * 2,
                      borderRadius: (showcaseSize + SHOWCASE_RING * 2) / 2,
                      padding: SHOWCASE_RING,
                    },
                  ]}
                >
                  <ExpoImage
                    source={SHOWCASE_AVATAR}
                    style={styles.showcaseAvatar}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                  />
                  {activeFrame.locked ? (
                    <View style={styles.showcaseLock}>
                      <MaterialIcons name="lock" size={22} color="#FFF" />
                    </View>
                  ) : null}
                </LinearGradient>
              )}
            </Pressable>

            <FitText style={styles.frameTitle} minimumFontScale={0.75}>
              {activeFrame.label}
            </FitText>
            <AdaptiveText style={styles.subtitle} numberOfLines={3}>
              {activeFrame.blurb}
            </AdaptiveText>

            <View style={styles.carouselWrap}>
              <Carousel
                width={PAGE_W}
                height={PAGE_H}
                data={FRAME_CATALOG}
                loop
                style={{ width: windowWidth, justifyContent: 'center', overflow: 'visible' }}
                containerStyle={{ overflow: 'visible' }}
                customAnimation={coverflowAnimation}
                scrollAnimationDuration={420}
                onSnapToItem={setActiveBase}
                renderItem={({ item }) => (
                  <View style={styles.carouselItem}>
                    <CoverFlowCard colors={item.colors} locked={item.locked} kind={item.kind} />
                    <FitText
                      style={[
                        styles.carouselLabel,
                        item.key === activeFrame.key && styles.carouselLabelActive,
                      ]}
                      minimumFontScale={0.7}
                    >
                      {item.label}
                    </FitText>
                  </View>
                )}
              />
            </View>
          </View>

          <View style={styles.footer}>
            <Pressable
              onPress={handleUnlock}
              style={({ pressed }) => [
                styles.ctaWrap,
                { width: buttonWidth },
                pressed && { opacity: 0.9 },
              ]}
            >
              <LinearGradient
                colors={activeFrame.locked ? (['#9AA3AF', '#6B7280', '#4B5563'] as const) : FIRE_CTA}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={[
                  styles.ctaBorder,
                  {
                    width: buttonWidth,
                    height: buttonHeight,
                    borderRadius: buttonRadius,
                    padding: CTA_BORDER_W,
                  },
                ]}
              >
                <View
                  style={[
                    styles.ctaInner,
                    {
                      height: buttonHeight - CTA_BORDER_W * 2,
                      borderRadius: innerRadius,
                      backgroundColor: activeFrame.locked
                        ? 'rgba(20, 22, 28, 0.82)'
                        : 'rgba(28, 8, 2, 0.82)',
                    },
                  ]}
                >
                  <MaterialCommunityIcons
                    name={activeFrame.locked ? 'lock' : 'fire'}
                    size={22}
                    color={activeFrame.locked ? '#C5CCD6' : '#FFC062'}
                  />
                  <FitText
                    style={[styles.ctaText, activeFrame.locked && styles.ctaTextLocked]}
                    minimumFontScale={0.7}
                  >
                    {activeFrame.locked ? 'Скоро в коллекции' : 'Разблокировать · 299 ₽'}
                  </FitText>
                </View>
              </LinearGradient>
            </Pressable>
            <FitText style={styles.limited} minimumFontScale={0.75}>
              {activeFrame.locked ? 'Следи за обновлениями' : 'Ограниченная серия · навсегда твоя'}
            </FitText>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 8,
    minHeight: 40,
  },
  titleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    color: CROWN_GOLD,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 1.4,
    flexShrink: 1,
    minWidth: 0,
  },
  closeBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 2,
    marginTop: 12,
  },
  closeBtnPressed: { opacity: 0.72 },
  body: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 20,
    minHeight: 0,
  },
  showcase: { marginTop: 8, alignItems: 'center', justifyContent: 'center' },
  showcaseAvatar: {
    width: 132,
    height: 132,
    borderRadius: 66,
  },
  staticRing: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  showcaseLock: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 66,
  },
  frameTitle: {
    marginTop: 12,
    color: WELCOME_HEADER_TITLE,
    fontSize: 24,
    fontWeight: '800',
    maxWidth: '92%',
  },
  subtitle: {
    marginTop: 6,
    color: WELCOME_MUTED_TEXT,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    paddingHorizontal: 26,
  },
  carouselWrap: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    minHeight: PAGE_H + 8,
    marginTop: 10,
    overflow: 'visible',
  },
  carouselItem: {
    width: PAGE_W,
    height: PAGE_H,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  coverShadow: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.45,
    shadowRadius: 14,
    elevation: 10,
  },
  coverShell: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverLock: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  carouselLabel: {
    color: 'rgba(139,148,158,0.45)',
    fontSize: 12,
    fontWeight: '600',
    maxWidth: COVER_SIZE,
    textAlign: 'center',
  },
  carouselLabelActive: {
    color: WELCOME_HEADER_TITLE,
  },
  footer: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 4,
    marginBottom: -2,
  },
  ctaWrap: {
    overflow: 'visible',
  },
  ctaBorder: {
    overflow: 'hidden',
  },
  ctaInner: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    paddingHorizontal: 20,
    minWidth: 0,
  },
  ctaText: {
    color: '#FFE0B8',
    fontSize: 17,
    fontWeight: '800',
    flexShrink: 1,
    minWidth: 0,
    textAlign: 'center',
  },
  ctaTextLocked: { color: '#D1D5DB', fontWeight: '700' },
  limited: {
    marginTop: 6,
    color: WELCOME_MUTED_TEXT,
    fontSize: 12,
    maxWidth: '92%',
    textAlign: 'center',
  },
});

export default FramesStoreModal;
