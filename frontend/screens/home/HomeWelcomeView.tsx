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
import AdaptiveText from '../../components/AdaptiveText';
import * as Haptics from 'expo-haptics';
import { LIVI, WELCOME_HEADER_TITLE, WELCOME_MUTED_TEXT, isWelcomeTabletLayout } from './constants';
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
    'styles' | 'isDark' | 'layoutWidth' | 'menuChromeBg' | 'compact' | 'dense' | 'radarStage' | 'avatarAnchorRef'
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
  const avatarAnchorRef = useRef<View>(null);
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
  const viewWidth = measured.w > stageWidth * 0.6 ? measured.w : stageWidth;
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
  const viewHeight = measured.h > expectedPaneH * 0.6 ? measured.h : expectedPaneH;

  /** Один источник размеров текста: по ним и рисуем, и резервируем место под радаром. */
  const type = {
    headingFont: isTabletLayout ? 22 : splitStage ? 17 : 18,
    matchingFont: isTabletLayout ? 15 : splitStage ? 12 : 13,
    matchingLineH: isTabletLayout ? 22 : splitStage ? 17 : 19,
    matchingMaxWidth: isTabletLayout ? 420 : 292,
  };
  const headingLineH = Math.round(type.headingFont * 1.32);

  /** Радар ближе к online; CTA выше tab bar за счёт большего paddingBottom (auto). */
  const space = {
    bannerMarginTop: tightStage ? 4 : bannerCompact ? 6 : 8,
    radarPaddingTop: splitStage ? 0 : compactLayout ? 2 : 4,
    stageCopyMarginTop: splitStage ? 0 : -6,
    stageCopyPaddingBottom: 0,
    ctaMinGap: splitTight ? 6 : compactLayout || shortPhone ? 12 : 16,
    /** Больше = кнопка выше над навигацией. */
    ctaBottomPad: tightStage
      ? 20
      : isTabletLayout
        ? splitStage
          ? 28
          : 40
        : splitStage
          ? 22
          : compactLayout
            ? 20
            : shortPhone
              ? 22
              : 32,
    copyMarginBottom: 4,
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
  const stageW = stageBox.w > viewWidth * 0.6 ? stageBox.w : viewWidth;
  const stageH = stageBox.h > expectedStageH * 0.6 ? stageBox.h : expectedStageH;

  /**
   * Сцена настолько низкая (split-screen, совсем маленькие экраны), что радар с
   * текстом и кнопкой вместе не помещаются. Уступает подзаголовок: он поясняющий,
   * а радар и кнопка несут смысл экрана.
   */
  const hideSubtitle = stageH > 0 && (splitStage ? stageH < 130 : stageH < 340);
  const matchingLines = splitTight ? 2 : 3;

  /** Реальная высота текста с кнопкой под радаром — считаем из тех же размеров, что и рисуем. */
  const ctaHeight = welcomeSearchCtaHeight(isTabletLayout, splitTight);
  /** Правая колонка в строке шириной ровно с кнопку — баннер, текст и CTA в одну линию. */
  /**
   * Колонка занимает половину строки, но не шире максимума кнопки. Без привязки
   * к строке композиция плыла: на узком landscape колонка забирала 63% ширины и
   * радар оставался зажатым, на широком — 41%.
   */
  const ctaWidth = Math.min(
    welcomeSearchCtaWidth(stageWidth, isTabletLayout),
    Math.max(240, stageW * 0.5),
  );
  /** Остаток строки под радар (минус боковые отступы и зазор между колонками). */
  const radarSlotWidth = Math.max(120, stageW - ctaWidth - 18 - 32);
  const stageCopyReserve = splitStage
    ? 0
    : headingLineH * 2 +
      (hideSubtitle ? 0 : type.matchingLineH * matchingLines) +
      space.copyMarginBottom +
      space.ctaMinGap +
      space.ctaBottomPad +
      ctaHeight +
      8;

  /**
   * Жёсткий потолок по высоте: больше этого радар не влезет ни при каких условиях.
   * В стеке под ним ещё текст с кнопкой, в строке они сбоку — нужен только зазор.
   */
  // 0.78 вместо «минус пара пикселей»: радар не должен касаться баннера онлайн
  // сверху и таб-бара снизу — между ними нужен видимый воздух.
  const radarHeightLimit = splitStage ? stageH * 0.78 : stageH - stageCopyReserve;
  /** Желаемый размер по ширине — им управляет дизайн, а не теснота экрана. */
  const radarPreferred = splitStage
    ? Math.min(radarSlotWidth * 0.9, isTabletLayout ? 340 : 248)
    : Math.min(stageW * (compactLayout ? 0.84 : 0.88), isTabletLayout ? 380 : 328);
  /**
   * Потолок по высоте всегда сильнее желаемого размера: на низком экране радар
   * ужимается сам, вместо того чтобы выдавить текст с кнопкой за границу панели.
   * 96 — предел, ниже которого радар уже не читается как радар.
   */
  const radarSize = Math.round(Math.max(96, Math.min(radarPreferred, Math.max(96, radarHeightLimit))));

  // Базовый аватар для раскладки колец; визуально больше на ⅓ ширины 1-го кольца (перекрывает его).
  // В стеке размеры те же, что были до адаптива, — вертикальная раскладка не меняется.
  // Потолок 0.42 от радара нужен только для экранов, где сам радар ужался.
  const stackAvatarBase = isTabletLayout ? 136 : viewWidth < 400 ? 112 : 124;
  const welcomeAvatarBase = Math.round(
    splitStage
      ? Math.max(54, Math.min(128, radarSize * 0.487))
      : Math.min(stackAvatarBase, radarSize * 0.42),
  );
  const welcomeAvatarRadius = Math.round(welcomeAvatarBase / 2);
  /** Сжатие орбит к центру — одно значение и для геометрии колец, и для аватара. */
  const orbitScale = splitStage ? 0.72 : 1;
  const welcomeAvatarGeometry = (() => {
    const half = radarSize / 2;
    const avatarOuter = welcomeAvatarRadius + 2;
    const stepTotal = 0.56 + 0.86 + 1.18 + 1.14;
    const g = Math.max(half * 0.078, (half * 0.85 - avatarOuter) / stepTotal) * orbitScale;
    const firstRingWidth = g * 0.56;
    // Рамка начинается у края фотографии, проходит через служебный зазор 2 px
    // и перекрывает только внутреннюю часть первой орбиты.
    const frameOutset = 2 + firstRingWidth * 0.22;
    if (splitStage) {
      // Аватар доходит почти до первой орбиты: она становится уже, аватар крупнее,
      // остальные кольца остаются на своих радиусах.
      return {
        avatarSize: Math.round((avatarOuter + firstRingWidth - 1) * 2),
        frameOutset,
      };
    }
    return {
      avatarSize: Math.round(welcomeAvatarBase + (firstRingWidth * 2) / 3),
      frameOutset,
    };
  })();
  const welcomeAvatarSize = welcomeAvatarGeometry.avatarSize;
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
            paddingHorizontal: tightStage ? 14 : 20,
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
          { paddingTop: space.radarPaddingTop },
          revealStyle,
        ]}
      >
        <View style={splitStage ? welcomeStyles.radarSlot : null}>
        <View style={splitStage ? welcomeStyles.radarShift : null}>
        <WelcomeRadar
          size={radarSize}
          isDark={isDark}
          avatarRadius={welcomeAvatarRadius}
          orbitScale={orbitScale}
        >
          <HomeCenterProfile
            styles={styles}
            isDark={isDark}
            layoutWidth={viewWidth}
            compact={compactLayout}
            dense={splitStage}
            radarStage
            radarAvatarSize={welcomeAvatarSize}
            radarFramedAvatarSize={welcomeAvatarBase}
            radarFrameOutset={welcomeFrameOutset}
            menuChromeBg={menuChromeBg}
            {...centerProfile}
            avatarAnchorRef={avatarAnchorRef}
            onOpenAvatarModal={handleOpenAvatarModal}
          />
        </WelcomeRadar>
        </View>
        </View>

        <Animated.View
          style={[
            welcomeStyles.stageCopy,
            splitStage && welcomeStyles.stageCopyRow,
            splitStage ? { width: ctaWidth, maxWidth: ctaWidth } : null,
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

          <View style={[welcomeStyles.copyBlock, { marginBottom: space.copyMarginBottom }]}>
            <AdaptiveText
              style={[
                welcomeStyles.heading,
                { fontSize: type.headingFont, lineHeight: headingLineH },
              ]}
              numberOfLines={2}
            >
              {L('welcomeSearchHeading')}
            </AdaptiveText>
            {hideSubtitle ? null : (
              <AdaptiveText
                style={[
                  welcomeStyles.matching,
                  {
                    fontSize: type.matchingFont,
                    lineHeight: type.matchingLineH,
                    maxWidth: type.matchingMaxWidth,
                  },
                  !isDark && { color: LIVI.text2 },
                ]}
                numberOfLines={matchingLines}
              >
                {L('welcomeSearchMatching')}
              </AdaptiveText>
            )}
          </View>

          <View
            style={[
              welcomeStyles.ctaWrap,
              {
                marginTop: splitStage ? 0 : ('auto' as const),
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
    alignItems: 'center',
    justifyContent: 'flex-start',
    minHeight: 0,
    overflow: 'hidden',
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
  /** Подъём радара в строке. Запас по высоте ~26, так что за границу не уходит. */
  radarShift: {
    marginTop: -12,
  },
  copyBlock: {
    paddingHorizontal: 28,
    alignItems: 'center',
    flexShrink: 0,
  },
  heading: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: 0.08,
    marginBottom: 4,
  },
  matching: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 13,
    fontWeight: '400',
    textAlign: 'center',
    lineHeight: 19,
    maxWidth: 292,
    paddingHorizontal: 12,
  },
  ctaWrap: {
    alignSelf: 'stretch',
    alignItems: 'center',
    flexShrink: 0,
    zIndex: 1,
  },
});

export const HomeWelcomeView = React.memo(HomeWelcomeViewInner);
