import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { useHomeLayout, useHomeLayoutActivity } from './HomeLayoutContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureDetector } from 'react-native-gesture-handler';
import { useAnimatedRef } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import {
  isWelcomeTabletLayout,
  searchPhoneRadarPreferred,
  welcomePhoneAvatarMetrics,
  welcomeRadarFirstRingWidth,
} from './constants';
import {
  AvatarDustOverlay,
  useAvatarDustController,
  useAvatarDustGesture,
  type AvatarDustSource,
} from './AvatarDust';
import { BrandTitleWithOutline } from './chrome';
import { HomeBrandConfetti, type BrandConfettiOrigin } from './HomeBrandConfetti';
import { HomeCenterProfile } from './HomeCenterProfile';
import { WelcomeCrownButton } from './WelcomeCrownButton';
import { WelcomeOnlineBanner, type WelcomeBannerPeer } from './WelcomeOnlineBanner';
import { WelcomeRadar } from './WelcomeRadar';
import { WelcomeSearchCta, welcomeSearchCtaHeight, welcomeSearchCtaWidth } from './WelcomeSearchCta';
import type { Lang } from '../../utils/i18n';
import { logger } from '../../utils/logger';
import type { HomeStyles } from './styles';

export type HomeWelcomeViewProps = {
  styles: HomeStyles;
  isDark: boolean;
  themeBackground: string;
  layoutWidth: number;
  layoutHeight: number;
  L: (key: string) => string;
  lang: Lang;
  menuChromeBg: string;
  onlineCount: number | null;
  bannerPeers: WelcomeBannerPeer[];
  centerProfile: Omit<
    React.ComponentProps<typeof HomeCenterProfile>,
    | 'styles'
    | 'isDark'
    | 'layoutWidth'
    | 'menuChromeBg'
    | 'compact'
    | 'dense'
    | 'radarStage'
    | 'avatarAnchorRef'
    | 'avatarDust'
    | 'onAvatarDustSource'
  >;
  hasActiveCallForSearch: boolean;
  onStartSearch: () => void;
  splashGone?: boolean;
};

function resolveIsLandscape(width: number, height: number) {
  return width > 0 && height > 0 && width / height > 1.05;
}

function resolveIsPhone(width: number, height: number) {
  const shortest = Math.min(width, height);
  return shortest > 0 && shortest < 600;
}

/**
 * Ниже этой высоты вертикальный стек (радар + текст + CTA) уже не помещается,
 * и сцена раскладывается в две колонки: радар слева, текст и кнопка справа.
 * Порог по высоте, а не по классу устройства — так одинаково работает телефон
 * в landscape и невысокий планшет.
 */
const STAGE_STACK_MIN_HEIGHT = 620;

function resolveIsSplitStage(width: number, height: number) {
  if (!resolveIsLandscape(width, height) || !(height > 0)) return false;
  // Телефон в landscape: вертикальный стек просто не влезает по высоте.
  if (height < STAGE_STACK_MIN_HEIGHT) return true;
  // Планшет в landscape: по высоте стек влезает, но ширины столько, что узкая
  // колонка по центру теряется, а баннер онлайн растягивается на весь экран.
  // Две колонки тут нужны по композиции, а не от тесноты.
  return isWelcomeTabletLayout(width, height);
}

let brandEntryShinePlayedThisSession = false;
let welcomeRevealPlayedThisSession = false;
/**
 * Размер аватара Поиска для текущей геометрии окна — переживает remount после
 * splash (иначе снова onLoad и мигание), но пересчитывается при повороте,
 * раскрытии Fold, split-screen и смене масштаба экрана.
 */
let lockedWelcomeSearchAvatar: { key: string; size: number; base: number } | null = null;

function HomeWelcomeViewInner({
  styles,
  isDark,
  layoutWidth,
  layoutHeight,
  L,
  lang,
  menuChromeBg,
  onlineCount,
  bannerPeers,
  centerProfile,
  hasActiveCallForSearch,
  onStartSearch,
  splashGone = true,
}: HomeWelcomeViewProps) {
  const welcomeRootRef = useRef<View>(null);
  // Animated ref: слой частиц меряет по нему аватар прямо на UI-потоке.
  const avatarAnchorRef = useAnimatedRef<View>();
  const avatarDust = useAvatarDustController();
  const [avatarDustSource, setAvatarDustSource] = useState<AvatarDustSource | null>(null);
  const burstActiveRef = useRef(false);
  const [burst, setBurst] = useState<{ id: number; origin: BrandConfettiOrigin } | null>(null);
  const [shineNonce, setShineNonce] = useState(0);
  const reveal = useRef(new Animated.Value(welcomeRevealPlayedThisSession ? 1 : 0)).current;
  const frame = useHomeLayout();
  const notifyLayoutActivity = useHomeLayoutActivity();
  const insets = useSafeAreaInsets();
  const [measured, setMeasured] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  /** Фактическая область под радар/текст/CTA — всё, что осталось от панели под шапкой. */
  const [stageBox, setStageBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    if (!splashGone) return;
    if (welcomeRevealPlayedThisSession) {
      reveal.setValue(1);
      return;
    }
    Animated.timing(reveal, {
      toValue: 1,
      duration: 560,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      welcomeRevealPlayedThisSession = true;
    });
  }, [reveal, splashGone]);

  useEffect(() => {
    if (!splashGone || brandEntryShinePlayedThisSession) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled || brandEntryShinePlayedThisSession) return;
      brandEntryShinePlayedThisSession = true;
      setShineNonce((nonce) => nonce + 1);
    }, 320);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [splashGone]);

  const onStageLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!(width > 0 && height > 0)) return;
    notifyLayoutActivity();
    setStageBox((prev) =>
      Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1 ? prev : { w: width, h: height },
    );
  }, [notifyLayoutActivity]);

  const onRootLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!(width > 0 && height > 0)) return;
    setMeasured((prev) =>
      Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1 ? prev : { w: width, h: height },
    );
  };

  /**
   * Ориентация и класс устройства — от safe-area frame: он приходит из нативного
   * провайдера и обновляется при повороте. Собственная измеренная область панели
   * (measured) короче окна на tab bar и используется только для «влезает / не влезает».
   */
  const stageWidth = frame.width || layoutWidth;
  const stageHeight = frame.height || layoutHeight;
  /**
   * Замер принимаем, только если он соответствует текущему окну — и снизу, и сверху.
   * Сразу после поворота onLayout ещё отдаёт размеры прежней ориентации: портретная
   * высота в landscape проходила нижнюю границу, радар считался почти вдвое выше
   * реального, и аватар закрывал кольца.
   */
  const fitsExpected = (value: number, expected: number, max: number) =>
    value > expected * 0.6 && value <= expected * max;
  const viewWidth = fitsExpected(measured.w, stageWidth, 1.05) ? measured.w : stageWidth;
  const isTabletLayout = isWelcomeTabletLayout(stageWidth, stageHeight);
  const isPhone = resolveIsPhone(stageWidth, stageHeight);
  const isLandscape = resolveIsLandscape(stageWidth, stageHeight);
  const splitStage = resolveIsSplitStage(stageWidth, stageHeight);
  const shortPhone = isPhone && !isLandscape && stageHeight > 0 && stageHeight < 700;
  /** Только экстремально низкая высота (ландшафт телефона / SE crouch) — размеры контролов не трогаем. */
  const compactLayout = isPhone && !isLandscape && stageHeight < 520;
  /** Телефон в landscape: на верхний блок остаётся совсем мало высоты. */
  const tightStage = splitStage && stageHeight > 0 && stageHeight < 420;
  /**
   * Две колонки от тесноты, а не от ширины. На планшете раскладка та же, но
   * ужимать под неё шрифты и отступы не надо — там высоты хватает с запасом.
   */
  const splitTight = splitStage && !isTabletLayout;

  /** Верхний блок ужимается вместе с экраном: иначе он съедает треть высоты в landscape. */
  const topBarHeight = tightStage ? 42 : splitStage ? 52 : compactLayout ? 48 : 54;
  const topBarPadTop = tightStage ? 4 : splitStage ? 6 : Platform.OS === 'ios' ? 8 : 12;
  const brandFontSize = tightStage ? 26 : isTabletLayout ? 40 : splitStage ? 30 : 36;
  const bannerCompact = splitTight || compactLayout || shortPhone;

  /**
   * Высота панели на первый кадр, пока не пришёл onLayout: окно минус верхний
   * inset и таб-бар. Без этого первый рендер считал, что места целое окно, и на
   * следующем кадре контент заметно ужимался.
   */
  const estimatedTabBar =
    (isTabletLayout ? 60 : splitStage ? 46 : 52) +
    Math.max(insets.bottom, Platform.OS === 'android' ? 6 : 2);
  const expectedPaneH = Math.max(160, stageHeight - insets.top - estimatedTabBar);
  const viewHeight = fitsExpected(measured.h, expectedPaneH, 1.3) ? measured.h : expectedPaneH;

  /** Баннер сверху, CTA снизу; радар центрируется в оставшемся зазоре. */
  const space = {
    bannerMarginTop: tightStage ? 12 : bannerCompact ? 14 : 16,
    radarPaddingTop: 0,
    stageCopyMarginTop: 0,
    stageCopyPaddingBottom: 0,
    ctaMinGap: splitTight ? 6 : compactLayout || shortPhone ? 12 : 16,
    /** Больше = кнопка выше над навигацией. */
    ctaBottomPad: tightStage
      ? 24
      : isTabletLayout
        ? splitStage
          ? 32
          : 44
        : splitStage
          ? 26
          : compactLayout
            ? 24
            : shortPhone
              ? 26
              : 36,
  };

  /**
   * Высоту сцены берём из onLayout самого контейнера, а не из оценки «панель минус
   * шапка»: шапка меняется от языка, переносов и плотности, и любая оценка рано или
   * поздно расходится с реальностью. Оценка нужна только на первый кадр.
   */
  const estimatedChrome =
    topBarHeight +
    (splitStage ? 0 : (bannerCompact ? 62 : 70) + space.bannerMarginTop);
  /**
   * Замер сцены принимаем только если он правдоподобен. При засыпании и повороте
   * onLayout отдаёт промежуточные значения (ловил кадр 726×95 при реальных 239),
   * и такой замер застревал в состоянии — радар оставался сжатым навсегда.
   */
  const expectedStageH = Math.max(150, viewHeight - estimatedChrome);
  const stageW = fitsExpected(stageBox.w, viewWidth, 1.05) ? stageBox.w : viewWidth;
  const stageH = fitsExpected(stageBox.h, expectedStageH, 1.5) ? stageBox.h : expectedStageH;
  /** Все замеры либо ещё не пришли (первый кадр по оценке), либо уже от текущего окна. */
  const geometryFresh =
    (!(measured.w > 0) || viewWidth === measured.w) &&
    (!(measured.h > 0) || viewHeight === measured.h) &&
    (!(stageBox.w > 0) || stageW === stageBox.w) &&
    (!(stageBox.h > 0) || stageH === stageBox.h);

  /**
   * Сцена настолько низкая (split-screen, совсем маленькие экраны), что радар с
   * кнопкой вместе не помещаются — радар ужимается по stageCopyReserve.
   */

  /** Реальная высота кнопки под радаром — считаем из тех же размеров, что и рисуем. */
  const ctaHeight = welcomeSearchCtaHeight(isTabletLayout, splitTight);
  /**
   * Колонка занимает половину строки, но не шире максимума кнопки. Без привязки
   * к строке композиция плыла: на узком landscape колонка забирала 63% ширины и
   * радар оставался зажатым, на широком — 41%.
   */
  const ctaWidth = Math.min(
    welcomeSearchCtaWidth(stageWidth, isTabletLayout, stageHeight),
    Math.max(240, stageW * 0.5),
  );
  /** Остаток строки под радар (минус боковые отступы и зазор между колонками). */
  const radarSlotWidth = Math.max(120, stageW - ctaWidth - 18 - 32);
  /** Резерв только под CTA — радар центрируется между online и кнопкой. */
  const stageCopyReserve = splitStage
    ? 0
    : space.ctaMinGap + space.ctaBottomPad + ctaHeight;

  /**
   * Жёсткий потолок по высоте: больше этого радар не влезет ни при каких условиях.
   * В стеке под ним ещё CTA, в строке кнопка сбоку — нужен только зазор.
   */
  // У рисунка есть внутреннее свободное поле за внешней орбитой, поэтому в
  // landscape контейнер может быть немного больше колонки без обрезки колец.
  const radarHeightLimit = splitStage ? stageH * 1.1 : stageH - stageCopyReserve;
  /** Желаемый размер по ширине — им управляет дизайн, а не теснота экрана. */
  const radarPreferred = splitStage
    ? Math.min(radarSlotWidth * 1.1, isTabletLayout ? 480 : 360)
    : isTabletLayout
      ? Math.min(stageW * 0.62, 560)
      : searchPhoneRadarPreferred(stageW, compactLayout);
  /**
   * Потолок по высоте всегда сильнее желаемого размера: на низком экране радар
   * ужимается сам, вместо того чтобы выдавить текст с кнопкой за границу панели.
   * 96 — предел, ниже которого радар уже не читается как радар.
   */
  const radarSize = Math.round(Math.max(96, Math.min(radarPreferred, Math.max(96, radarHeightLimit))));

  /**
   * Телефон: аватар в любой ориентации — как на Поиске в вертикали (тот же
   * эталон берёт Профиль). Радар в landscape меньше, и под аватар подстраиваются
   * только кольца, а не наоборот.
   * Планшет: аватар растёт вместе с радаром, но не больше 0.42 его диаметра.
   */
  const welcomeAvatarGeometry = (() => {
    if (!isTabletLayout) {
      const phone = welcomePhoneAvatarMetrics(Math.min(stageWidth, stageHeight));
      return { base: phone.base, avatarSize: phone.outer, frameOutset: phone.frameOutset };
    }
    const base = Math.round(Math.min(136 * Math.max(1, radarSize / 380), radarSize * 0.42));
    const firstRingWidth = welcomeRadarFirstRingWidth(radarSize, base);
    return {
      base,
      avatarSize: Math.round(base + (firstRingWidth * 2) / 3),
      frameOutset: 2 + firstRingWidth * 0.22,
    };
  })();
  const welcomeAvatarBase = welcomeAvatarGeometry.base;
  const welcomeAvatarRadius = Math.round(welcomeAvatarBase / 2);
  const welcomeAvatarSizeRaw = welcomeAvatarGeometry.avatarSize;
  // Module-level: ref сбрасывался при remount после splash → снова 114 и onLoad.
  const avatarLockKey = `${Math.round(stageWidth)}x${Math.round(stageHeight)}`;
  // Промежуточный кадр поворота не закрепляем — иначе неверный размер держится до перезапуска.
  if (welcomeAvatarSizeRaw > 0 && geometryFresh && lockedWelcomeSearchAvatar?.key !== avatarLockKey) {
    lockedWelcomeSearchAvatar = { key: avatarLockKey, size: welcomeAvatarSizeRaw, base: welcomeAvatarBase };
  }
  const avatarLock =
    geometryFresh && lockedWelcomeSearchAvatar?.key === avatarLockKey ? lockedWelcomeSearchAvatar : null;
  const welcomeAvatarSize = avatarLock ? avatarLock.size : welcomeAvatarSizeRaw;
  /** Аватар с рамкой (radarFramedAvatarSize) держим так же, иначе у него мигание осталось бы. */
  const welcomeFramedAvatarSize = avatarLock ? avatarLock.base : welcomeAvatarBase;
  const welcomeFrameOutset = welcomeAvatarGeometry.frameOutset;

  const cancelBurst = useCallback(() => {
    if (!burstActiveRef.current) return;
    burstActiveRef.current = false;
    setBurst(null);
  }, []);

  const finishBurst = useCallback((burstId: number) => {
    if (!burstActiveRef.current) return;
    setBurst((current) => (current?.id === burstId ? null : current));
    burstActiveRef.current = false;
    setShineNonce((nonce) => nonce + 1);
  }, []);

  const fireBurst = useCallback((origin: BrandConfettiOrigin) => {
    burstActiveRef.current = true;
    setBurst({ id: Date.now(), origin });
    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {
      /* optional */
    }
  }, []);

  const onBrandPress = useCallback(() => {
    if (burstActiveRef.current) return;
    burstActiveRef.current = true;
    const fallbackSize = splitStage ? 56 : compactLayout ? 76 : 118;
    const fallback = () => {
      if (!burstActiveRef.current) return;
      fireBurst({
        x: viewWidth / 2,
        y: Math.max(110, viewHeight * 0.26),
        size: fallbackSize,
      });
    };
    const root = welcomeRootRef.current;
    const avatar = avatarAnchorRef.current;
    if (!root || !avatar) {
      fallback();
      return;
    }
    root.measureInWindow((rx, ry) => {
      avatar.measureInWindow((ax, ay, aw, ah) => {
        if (!burstActiveRef.current) return;
        if (!(aw > 8 && ah > 8)) {
          fallback();
          return;
        }
        fireBurst({
          x: ax - rx + aw / 2,
          y: ay - ry + ah / 2,
          size: Math.max(aw, ah),
        });
      });
    });
  }, [compactLayout, fireBurst, splitStage, viewHeight, viewWidth]);

  const handleStartSearchPress = useCallback(() => {
    const now = Date.now();
    try {
      const g = global as any;
      const t0 = Number(g.__searchNavT0 || now);
      const steps = Array.isArray(g.__searchNavSteps) ? g.__searchNavSteps : [];
      steps.push({ step: 'welcome.handleStartSearchPress', at: now, elapsedMs: now - t0 });
      g.__searchNavSteps = steps;
      logger.info('[search-nav] welcome.handleStartSearchPress', {
        elapsedMs: now - t0,
        hadBurst: !!burstActiveRef.current,
      });
    } catch {}
    cancelBurst();
    onStartSearch();
  }, [cancelBurst, onStartSearch]);

  const handleOpenAvatarModal = useCallback(
    (uri: string) => {
      cancelBurst();
      centerProfile.onOpenAvatarModal(uri);
    },
    [cancelBurst, centerProfile],
  );

  // Жест радара пересоздаётся только при смене геометрии, а не на каждый рендер.
  const openAvatarRef = useRef(() => {});
  openAvatarRef.current = () =>
    handleOpenAvatarModal(centerProfile.myFullAvatarUri || centerProfile.avatarUri || '');
  const handleAvatarTap = useCallback(() => openAvatarRef.current(), []);
  const radarGesture = useAvatarDustGesture(
    avatarDust,
    radarSize,
    avatarDustSource?.size ?? welcomeAvatarSize,
    handleAvatarTap,
  );

  const revealStyle = {
    opacity: reveal,
    transform: [
      {
        translateY: reveal.interpolate({
          inputRange: [0, 1],
          outputRange: [12, 0],
        }),
      },
    ],
  };

  return (
    <View ref={welcomeRootRef} style={welcomeStyles.root} onLayout={onRootLayout} collapsable={false}>
      <View
        style={[
          welcomeStyles.topBar,
          {
            minHeight: topBarHeight,
            paddingTop: topBarPadTop,
            paddingBottom: tightStage ? 2 : 6,
            // Search header: bring the brand and crown slightly inward as a pair.
            paddingHorizontal: tightStage ? 18 : 26,
          },
        ]}
      >
        <BrandTitleWithOutline
          isDark={isDark}
          onPress={onBrandPress}
          pressLocked={!!burst}
          shineNonce={shineNonce}
          fontSize={brandFontSize}
          tailAuraFromIndex={2}
          letterGlow={false}
        />
        <WelcomeCrownButton large={isTabletLayout} small={tightStage} />
      </View>

      {splitStage ? null : (
        <Animated.View style={revealStyle}>
          <WelcomeOnlineBanner
            lang={lang}
            onlineLabel={L('online')}
            onlineCount={onlineCount}
            peers={bannerPeers}
            compact={bannerCompact}
            dense={tightStage}
            marginTop={space.bannerMarginTop}
          />
        </Animated.View>
      )}

      <Animated.View
        collapsable={false}
        onLayout={onStageLayout}
        style={[
          splitStage ? welcomeStyles.stageRow : welcomeStyles.radarFlex,
          revealStyle,
        ]}
      >
        <View
          style={
            splitStage
              ? welcomeStyles.radarSlot
              : welcomeStyles.radarCenter
          }
        >
          <View style={splitStage ? welcomeStyles.radarShift : null}>
            <GestureDetector gesture={radarGesture}>
            {/* collapsable: иначе Android выкидывает «пустой» view и жесту не к чему крепиться. */}
            <View collapsable={false}>
            <WelcomeRadar
              size={radarSize}
              isDark={isDark}
              avatarRadius={welcomeAvatarRadius}
            >
              <HomeCenterProfile
                styles={styles}
                isDark={isDark}
                layoutWidth={viewWidth}
                compact={compactLayout}
                dense={splitStage}
                radarStage
                radarAvatarSize={welcomeAvatarSize}
                radarFramedAvatarSize={welcomeFramedAvatarSize}
                radarFrameOutset={welcomeFrameOutset}
                menuChromeBg={menuChromeBg}
                {...centerProfile}
                avatarAnchorRef={avatarAnchorRef}
                onOpenAvatarModal={handleOpenAvatarModal}
                avatarDust={avatarDust}
                onAvatarDustSource={setAvatarDustSource}
              />
            </WelcomeRadar>
            </View>
            </GestureDetector>
          </View>
        </View>

        <Animated.View
          style={[
            welcomeStyles.stageCopy,
            splitStage && welcomeStyles.stageCopyRow,
            splitStage ? { width: ctaWidth, maxWidth: ctaWidth } : welcomeStyles.stageCopyStack,
            {
              marginTop: space.stageCopyMarginTop,
              paddingBottom: space.stageCopyPaddingBottom,
            },
            revealStyle,
          ]}
        >
          {splitStage ? (
            <WelcomeOnlineBanner
              lang={lang}
              onlineLabel={L('online')}
              onlineCount={onlineCount}
              peers={bannerPeers}
              compact={bannerCompact}
              dense={tightStage}
              marginTop={0}
              sideMargin={0}
            />
          ) : null}

          <View
            style={[
              welcomeStyles.ctaWrap,
              {
                paddingTop: space.ctaMinGap,
                paddingBottom: space.ctaBottomPad,
              },
            ]}
          >
            <WelcomeSearchCta
              label={L('welcomeFindPartnerBtn')}
              onPress={handleStartSearchPress}
              disabled={hasActiveCallForSearch}
              compact={splitTight}
              maxWidth={splitStage ? ctaWidth : undefined}
              style={{
                marginBottom: 0,
              }}
            />
          </View>
        </Animated.View>
      </Animated.View>

      {/* Поверх всего экрана: рассыпавшийся аватар не обрезается о радар и блоки. */}
      <AvatarDustOverlay dust={avatarDust} source={avatarDustSource} avatarRef={avatarAnchorRef} />

      {burst ? (
        <HomeBrandConfetti
          key={burst.id}
          burstId={burst.id}
          origin={burst.origin}
          isDark={isDark}
          onComplete={finishBurst}
        />
      ) : null}
    </View>
  );
}

const welcomeStyles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  radarFlex: {
    flex: 1,
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  },
  /** Центр аватара строго между online и кнопкой «Найти…». */
  radarCenter: {
    flex: 1,
    minHeight: 0,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Короткая landscape: радар слева, текст и CTA справа — без скролла. */
  stageRow: {
    flex: 1,
    minHeight: 0,
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'center',
    paddingHorizontal: 16,
    gap: 18,
    overflow: 'hidden',
  },
  stageCopy: {
    width: '100%',
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    alignItems: 'center',
    position: 'relative',
  },
  /** Портрет: CTA не растягивается — иначе съедает центр радара. */
  stageCopyStack: {
    flexGrow: 0,
    flexShrink: 0,
    width: '100%',
  },
  stageCopyRow: {
    flexGrow: 0,
    flexShrink: 0,
    justifyContent: 'space-between',
  },
  /** Радар занимает весь остаток строки: прижат влево, чуть опущен. */
  radarSlot: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Увеличенный радар слегка поднимаем относительно центра landscape-колонки. */
  radarShift: {
    marginTop: -8,
  },
  ctaWrap: {
    alignSelf: 'stretch',
    alignItems: 'center',
    flexShrink: 0,
    zIndex: 1,
  },
});

export const HomeWelcomeView = React.memo(HomeWelcomeViewInner);
