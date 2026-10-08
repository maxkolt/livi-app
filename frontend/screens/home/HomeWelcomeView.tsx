import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { useHomeLayout, useHomeLayoutActivity } from './HomeLayoutContext';
import AdaptiveText from '../../components/AdaptiveText';
import { useNickDigitalFont } from './brandFont';
import { useStableSafeAreaInsets } from './useStableSafeAreaInsets';
import { GestureDetector } from 'react-native-gesture-handler';
import { useAnimatedRef } from 'react-native-reanimated';
import {
  isWelcomeTabletLayout,
  searchPhoneRadarPreferred,
  WELCOME_HEADER_TITLE,
  WELCOME_ONLINE_PLACEHOLDER_BG,
  welcomePhoneAvatarMetrics,
  welcomeRadarFirstRingWidth,
} from './constants';
import {
  AvatarDustOverlay,
  useAvatarDustController,
  useAvatarDustGesture,
  type AvatarDustSource,
} from './AvatarDust';
import { HomeCenterProfile, hasProfilePhoto } from './HomeCenterProfile';
import { WelcomeCrownButton } from './WelcomeCrownButton';
import { WelcomeOnlineBanner, type WelcomeBannerPeer } from './WelcomeOnlineBanner';
import { WelcomeRadar } from './WelcomeRadar';
import { RADAR_DRAWN_EXTENT, radarGeometry } from './welcomeRadarScene';
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
  /** Вкладка «Поиск» на экране — иначе радар не анимируется. */
  active?: boolean;
  /**
   * Нижний край блока «Онлайн» от верха вкладки — до него HomeScreen рисует верхнее стекло.
   * null — блок не наверху (две колонки в горизонтали), стекла нет.
   */
  onTopBlockBottom?: (bottom: number | null) => void;
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
  active = true,
  onTopBlockBottom,
}: HomeWelcomeViewProps) {
  // Animated ref: слой частиц меряет по нему аватар прямо на UI-потоке.
  const avatarAnchorRef = useAnimatedRef<View>();
  const avatarDust = useAvatarDustController();
  const [avatarDustSource, setAvatarDustSource] = useState<AvatarDustSource | null>(null);
  const frame = useHomeLayout();
  const notifyLayoutActivity = useHomeLayoutActivity();
  const insets = useStableSafeAreaInsets();
  const [measured, setMeasured] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  /** Фактическая область под радар/текст/CTA — всё, что осталось от панели под шапкой. */
  const [stageBox, setStageBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

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
  // В две колонки блок «Онлайн» не наверху — верхнего стекла нет.
  useEffect(() => {
    if (splitStage) onTopBlockBottom?.(null);
  }, [onTopBlockBottom, splitStage]);
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

  /** Одинаковый воздух сверху панели и снизу CTA до навбара. */
  const verticalEdgeGap = tightStage
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
            : 36;

  /** Баннер сверху, CTA снизу; радар центрируется в оставшемся зазоре. */
  const space = {
    // Наверху блок лежит на стекле от системной строки — к ней ближе, как шапка «Друзей».
    bannerMarginTop: splitStage ? verticalEdgeGap : isTabletLayout ? 14 : 10,
    radarPaddingTop: 0,
    stageCopyMarginTop: 0,
    stageCopyPaddingBottom: 0,
    ctaMinGap: splitTight ? 6 : compactLayout || shortPhone ? 12 : 16,
    /**
     * В вертикали кнопка поднята над навбаром сильнее верхнего отступа. В строке
     * (landscape) тоже чуть приподнята: вровень с низом радара она прилипала к
     * таб-бару.
     */
    ctaBottomPad: splitStage
      ? verticalEdgeGap + (tightStage ? 12 : 16)
      : verticalEdgeGap + (compactLayout || shortPhone ? 8 : 14),
  };

  /**
   * Высоту сцены берём из onLayout самого контейнера, а не из оценки «панель минус
   * шапка»: шапка меняется от языка, переносов и плотности, и любая оценка рано или
   * поздно расходится с реальностью. Оценка нужна только на первый кадр.
   */
  const estimatedChrome = splitStage
    ? 0
    : (bannerCompact ? 68 : 80) + space.bannerMarginTop;
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
  /**
   * Ник под радаром крупным «цифровым» шрифтом — только в вертикали. Его строка входит
   * в резерв под кнопкой: радар центрируется выше на половину её высоты и не наезжает.
   */
  const nickFont = useNickDigitalFont();
  const nickText = String(centerProfile.savedNick || '').trim();
  const nickFontSize = isTabletLayout ? 42 : compactLayout || shortPhone ? 28 : 34;
  const nickLineH = Math.round(nickFontSize * 1.25);
  const nickGap = isTabletLayout ? 16 : 10;
  const showNick = !!nickText && !splitStage && !tightStage;
  const nickBlockH = showNick ? nickGap + nickLineH : 0;
  const ctaPadTop = space.ctaMinGap + nickBlockH;
  /** Резерв под ник и CTA — радар центрируется между online и ними. */
  const stageCopyReserve = splitStage
    ? 0
    : ctaPadTop + space.ctaBottomPad + ctaHeight;

  /**
   * Рисунок радара занимает RADAR_DRAWN_EXTENT контейнера (дальше — пустое поле),
   * поэтому вписываем по рисунку: контейнер = нужный размер рисунка / extent.
   */
  const radarForDrawn = (drawnDiameter: number) => drawnDiameter / RADAR_DRAWN_EXTENT;
  /**
   * Жёсткий потолок по высоте: больше этого радар не влезет ни при каких условиях.
   * В стеке под ним ещё CTA. В строке рисунок идёт ровно от верха баннера до низа
   * кнопки соседней колонки — те же отступы verticalEdgeGap сверху и снизу.
   */
  const radarHeightLimit = splitStage
    ? radarForDrawn(stageH - verticalEdgeGap * 2)
    : stageH - stageCopyReserve;
  /** Желаемый размер по ширине — им управляет дизайн, а не теснота экрана. */
  const radarPreferred = splitStage
    ? Math.min(radarForDrawn(radarSlotWidth), isTabletLayout ? 480 : 360)
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
   * Портрет: кнопка ниже середины между низом ника (или рисунка радара) и таб-баром
   * (низ сцены) — 62% свободного места сверху. Радар не двигается, сдвигаем только кнопку.
   */
  const radarDashR = radarGeometry(radarSize, 0).rDash;
  const ctaShiftY = (() => {
    if (splitStage) return 0;
    const radarAreaH = stageH - stageCopyReserve;
    // Видимый край — пунктирное кольцо; RADAR_DRAWN_EXTENT шире (с прежним пустым полем).
    const contentBottom = radarAreaH / 2 + radarDashR + nickBlockH;
    const ctaTop = contentBottom + (stageH - contentBottom - ctaHeight) * 0.62;
    return Math.round(ctaTop - (radarAreaH + ctaPadTop));
  })();

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
      });
    } catch {}
    onStartSearch();
  }, [onStartSearch]);

  const handleOpenAvatarModal = useCallback(
    (uri: string) => centerProfile.onOpenAvatarModal(uri),
    [centerProfile],
  );

  /**
   * Без фото в центре только радар: ни кружка, ни буквы. Пока версия аватара
   * не проверена, место держим — иначе кольца прыгнут, когда фото придёт.
   */
  const showRadarAvatar =
    !centerProfile.avatarVerChecked ||
    hasProfilePhoto(centerProfile.avatarUri, centerProfile.myAvatarVer);
  useEffect(() => {
    // Профиль снят с радара и свой источник уже не сбросит.
    if (!showRadarAvatar) setAvatarDustSource(null);
  }, [showRadarAvatar]);

  // Жест радара пересоздаётся только при смене геометрии, а не на каждый рендер.
  const openAvatarRef = useRef(() => {});
  openAvatarRef.current = () => {
    if (!showRadarAvatar) return;
    handleOpenAvatarModal(centerProfile.myFullAvatarUri || centerProfile.avatarUri || '');
  };
  const handleAvatarTap = useCallback(() => openAvatarRef.current(), []);
  const radarGesture = useAvatarDustGesture(
    avatarDust,
    radarSize,
    avatarDustSource?.size ?? welcomeAvatarSize,
    handleAvatarTap,
  );

  return (
    <View style={welcomeStyles.root} onLayout={onRootLayout} collapsable={false}>
      {splitStage ? null : (
        <View
          onLayout={(e) => {
            const { y, height } = e.nativeEvent.layout;
            if (height > 0) onTopBlockBottom?.(y + height);
          }}
        >
          <WelcomeOnlineBanner
            lang={lang}
            onlineLabel={L('online')}
            onlineCount={onlineCount}
            peers={bannerPeers}
            compact={bannerCompact}
            dense={tightStage}
            marginTop={space.bannerMarginTop}
            sideMargin={isTabletLayout ? 20 : 12}
            trailingAction={
              <WelcomeCrownButton
                large={isTabletLayout}
                small={tightStage}
                surface={WELCOME_ONLINE_PLACEHOLDER_BG}
              />
            }
          />
        </View>
      )}

      <View
        collapsable={false}
        onLayout={onStageLayout}
        style={splitStage ? welcomeStyles.stageRow : welcomeStyles.radarFlex}
      >
        <View
          style={
            splitStage
              ? welcomeStyles.radarSlot
              : welcomeStyles.radarCenter
          }
        >
          <View>
            <GestureDetector gesture={radarGesture}>
            {/* collapsable: иначе Android выкидывает «пустой» view и жесту не к чему крепиться. */}
            <View collapsable={false}>
            <WelcomeRadar
              size={radarSize}
              avatarSize={showRadarAvatar ? welcomeAvatarSize : 0}
              active={active}
            >
              {showRadarAvatar ? (
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
              ) : null}
            </WelcomeRadar>
            </View>
            </GestureDetector>
            {showNick ? (
              <View
                pointerEvents="none"
                style={[
                  welcomeStyles.nickWrap,
                  { top: radarSize / 2 + radarDashR + nickGap },
                ]}
              >
                <AdaptiveText
                  style={[
                    welcomeStyles.nick,
                    {
                      fontFamily: nickFont.fontFamily,
                      fontWeight: nickFont.fontWeight,
                      fontSize: nickFontSize,
                      lineHeight: nickLineH,
                    },
                  ]}
                  numberOfLines={1}
                  minimumFontScale={0.5}
                >
                  {nickText}
                </AdaptiveText>
              </View>
            ) : null}
          </View>
        </View>

        <View
          style={[
            welcomeStyles.stageCopy,
            splitStage && welcomeStyles.stageCopyRow,
            splitStage ? { width: ctaWidth, maxWidth: ctaWidth } : welcomeStyles.stageCopyStack,
            {
              marginTop: space.stageCopyMarginTop,
              paddingBottom: space.stageCopyPaddingBottom,
            },
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
              marginTop={space.bannerMarginTop}
              sideMargin={0}
              trailingAction={
                <WelcomeCrownButton
                  large={isTabletLayout}
                  small={tightStage}
                  surface={WELCOME_ONLINE_PLACEHOLDER_BG}
                />
              }
            />
          ) : null}

          <View
            style={[
              welcomeStyles.ctaWrap,
              {
                paddingTop: ctaPadTop,
                paddingBottom: space.ctaBottomPad,
                transform: [{ translateY: ctaShiftY }],
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
        </View>
      </View>

      {/* Поверх всего экрана: рассыпавшийся аватар не обрезается о радар и блоки. */}
      <AvatarDustOverlay dust={avatarDust} source={avatarDustSource} avatarRef={avatarAnchorRef} />

    </View>
  );
}

const welcomeStyles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
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
  /** Ник под пунктирным кольцом радара: по центру, не шире радара. */
  nickWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  nick: {
    color: WELCOME_HEADER_TITLE,
    letterSpacing: 1.2,
    textAlign: 'center',
  },
  ctaWrap: {
    alignSelf: 'stretch',
    alignItems: 'center',
    flexShrink: 0,
    zIndex: 1,
  },
});

export const HomeWelcomeView = React.memo(HomeWelcomeViewInner);
