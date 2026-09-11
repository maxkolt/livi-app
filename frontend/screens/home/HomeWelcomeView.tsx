import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { CHROME_PERIMETER_GLOW_LAYOUT_INSET, LIVI, SEARCH_CTA_TABLET_MIN_WIDTH, WELCOME_HEADER_TITLE, WELCOME_MUTED_TEXT } from './constants';
import { BrandTitleWithOutline } from './chrome';
import { HomeBrandConfetti, type BrandConfettiOrigin } from './HomeBrandConfetti';
import { HomeCenterProfile } from './HomeCenterProfile';
import { WelcomeCrownButton } from './WelcomeCrownButton';
import { WelcomeOnlineBanner, type WelcomeBannerPeer } from './WelcomeOnlineBanner';
import { WelcomeRadar } from './WelcomeRadar';
import { WelcomeSearchCta } from './WelcomeSearchCta';
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
  NoticeView: React.ReactNode;
  hasActiveCallForSearch: boolean;
  showCallSearchLockBadge: boolean;
  onStartSearch: () => void;
  onBlockedStartSearch: () => void;
  splashGone?: boolean;
};

function resolveIsLandscape(width: number, height: number) {
  return width > 0 && height > 0 && width / height > 1.05;
}

function resolveIsPhone(width: number, height: number) {
  const shortest = Math.min(width, height);
  return shortest > 0 && shortest < 600;
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
  NoticeView,
  hasActiveCallForSearch,
  showCallSearchLockBadge,
  onStartSearch,
  onBlockedStartSearch,
  splashGone = true,
}: HomeWelcomeViewProps) {
  const welcomeRootRef = useRef<View>(null);
  const avatarAnchorRef = useRef<View>(null);
  const welcomeBlockRef = useRef<View>(null);
  const copyAnchorRef = useRef<View>(null);
  const searchBtnAnchorRef = useRef<View>(null);
  const burstActiveRef = useRef(false);
  const [burst, setBurst] = useState<{ id: number; origin: BrandConfettiOrigin } | null>(null);
  const [shineNonce, setShineNonce] = useState(0);
  const reveal = useRef(new Animated.Value(welcomeRevealPlayedThisSession ? 1 : 0)).current;
  const [badgeGap, setBadgeGap] = useState<{ top: number; height: number } | null>(null);
  const [measured, setMeasured] = useState<{ w: number; h: number }>(() => ({
    w: layoutWidth,
    h: layoutHeight,
  }));

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

  useEffect(() => {
    setMeasured((prev) =>
      prev.w === layoutWidth && prev.h === layoutHeight ? prev : { w: layoutWidth, h: layoutHeight },
    );
  }, [layoutWidth, layoutHeight]);

  useEffect(() => {
    const onChange = ({ window }: { window: { width: number; height: number } }) => {
      setMeasured({ w: window.width, h: window.height });
    };
    const sub = Dimensions.addEventListener('change', onChange);
    return () => sub.remove();
  }, []);

  const onRootLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!(width > 0 && height > 0)) return;
    setMeasured((prev) =>
      Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1 ? prev : { w: width, h: height },
    );
  };

  const viewWidth = measured.w || layoutWidth;
  const viewHeight = measured.h || layoutHeight;
  const isTabletLayout = viewWidth >= SEARCH_CTA_TABLET_MIN_WIDTH;
  const isPhone = resolveIsPhone(viewWidth, viewHeight);
  const isLandscape = resolveIsLandscape(viewWidth, viewHeight);
  const shortPhone = isPhone && !isLandscape && viewHeight > 0 && viewHeight < 700;
  const phoneLandscape = isPhone && isLandscape;
  /** Только экстремально низкая высота (ландшафт телефона / SE crouch) — размеры контролов не трогаем. */
  const compactLayout = isPhone && !isLandscape && viewHeight < 520;

  /** Радар ближе к online; CTA выше tab bar за счёт большего paddingBottom (auto). */
  const space = {
    bannerMarginTop: phoneLandscape || compactLayout ? 6 : 8,
    radarPaddingTop: phoneLandscape ? 2 : compactLayout ? 2 : 4,
    stageCopyMarginTop: phoneLandscape ? -2 : -6,
    stageCopyPaddingBottom: 0,
    ctaMinGap: phoneLandscape ? 10 : compactLayout ? 12 : 16,
    /** Больше = кнопка выше над навигацией. */
    ctaBottomPad: phoneLandscape ? 14 : compactLayout ? 22 : 32,
    copyMarginBottom: 4,
  };

  const radarSize = phoneLandscape
    ? Math.min(viewWidth * 0.68, 248)
    : compactLayout
      ? Math.min(viewWidth * 0.84, 288)
      : Math.min(viewWidth * 0.88, isTabletLayout ? 340 : 328);

  // Базовый аватар для раскладки колец; визуально больше на ⅓ ширины 1-го кольца (перекрывает его).
  const welcomeAvatarBase = viewWidth < 400 ? 112 : 124;
  const welcomeAvatarRadius = Math.round(welcomeAvatarBase / 2);
  const welcomeAvatarSize = (() => {
    const half = radarSize / 2;
    const avatarOuter = welcomeAvatarRadius + 2;
    const stepTotal = 0.56 + 0.86 + 1.18 + 1.14;
    const g = Math.max(half * 0.078, (half * 0.85 - avatarOuter) / stepTotal);
    const firstRingWidth = g * 0.56;
    return Math.round(welcomeAvatarBase + (firstRingWidth * 2) / 3);
  })();

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
    const fallbackSize = phoneLandscape ? 56 : compactLayout ? 76 : 118;
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
  }, [compactLayout, fireBurst, phoneLandscape, viewHeight, viewWidth]);

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

  const handleBlockedSearchPress = useCallback(() => {
    cancelBurst();
    onBlockedStartSearch();
  }, [cancelBurst, onBlockedStartSearch]);

  const handleOpenAvatarModal = useCallback(
    (uri: string) => {
      cancelBurst();
      centerProfile.onOpenAvatarModal(uri);
    },
    [cancelBurst, centerProfile],
  );

  const syncBadgeGap = React.useCallback(() => {
    const block = welcomeBlockRef.current;
    const copyTop = copyAnchorRef.current;
    const button = searchBtnAnchorRef.current;
    if (!block || !copyTop || !button) return;
    block.measureInWindow((_bx, blockY) => {
      copyTop.measureInWindow((_cx, copyY, _cw, copyH) => {
        button.measureInWindow((_sx, btnY) => {
          const top = copyY + copyH - blockY;
          const frameTop = btnY - blockY;
          const height = frameTop - top;
          if (height > 0) {
            setBadgeGap((prev) =>
              prev && prev.top === top && prev.height === height ? prev : { top, height },
            );
          }
        });
      });
    });
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => syncBadgeGap());
    return () => cancelAnimationFrame(id);
  }, [
    syncBadgeGap,
    viewWidth,
    viewHeight,
    compactLayout,
    phoneLandscape,
    showCallSearchLockBadge,
    hasActiveCallForSearch,
    NoticeView,
  ]);

  const showCallLock = hasActiveCallForSearch && showCallSearchLockBadge;
  const callLockBadge = showCallLock ? (
    <View
      style={[
        styles.notice,
        {
          backgroundColor: isDark ? 'rgba(138,143,153,0.16)' : 'rgba(59,68,83,0.16)',
          borderColor: isDark ? 'rgba(138,143,153,0.36)' : 'rgba(59,68,83,0.34)',
        },
      ]}
    >
      <Text style={[styles.noticeText, { color: isDark ? 'rgba(240,241,243,0.92)' : 'rgba(47,55,66,0.9)' }]}>
        {L('finishCurrentCallFirst')}
      </Text>
    </View>
  ) : null;

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
          phoneLandscape && welcomeStyles.topBarLandscape,
          compactLayout && welcomeStyles.topBarCompact,
        ]}
      >
        <BrandTitleWithOutline
          isDark={isDark}
          onPress={onBrandPress}
          pressLocked={!!burst}
          shineNonce={shineNonce}
          fontSize={36}
          tailAuraFromIndex={2}
          letterGlow={false}
        />
        <WelcomeCrownButton />
      </View>

      <Animated.View style={revealStyle}>
        <WelcomeOnlineBanner
          lang={lang}
          onlineLabel={L('online')}
          onlineCount={onlineCount}
          peers={bannerPeers}
          compact={phoneLandscape || compactLayout || shortPhone}
          marginTop={space.bannerMarginTop}
        />
      </Animated.View>

      <Animated.View
        ref={welcomeBlockRef}
        collapsable={false}
        onLayout={syncBadgeGap}
        style={[
          welcomeStyles.radarFlex,
          { paddingTop: space.radarPaddingTop },
          revealStyle,
        ]}
      >
        <WelcomeRadar size={radarSize} isDark={isDark} avatarRadius={welcomeAvatarRadius}>
          <HomeCenterProfile
            styles={styles}
            isDark={isDark}
            layoutWidth={viewWidth}
            compact={compactLayout}
            dense={phoneLandscape}
            radarStage
            radarAvatarSize={welcomeAvatarSize}
            menuChromeBg={menuChromeBg}
            {...centerProfile}
            avatarAnchorRef={avatarAnchorRef}
            onOpenAvatarModal={handleOpenAvatarModal}
          />
        </WelcomeRadar>

        <Animated.View
          style={[
            welcomeStyles.stageCopy,
            {
              marginTop: space.stageCopyMarginTop,
              paddingBottom: space.stageCopyPaddingBottom,
            },
            revealStyle,
          ]}
        >
          <View
            ref={copyAnchorRef}
            collapsable={false}
            onLayout={syncBadgeGap}
            style={[welcomeStyles.copyBlock, { marginBottom: space.copyMarginBottom }]}
          >
            <Text
              style={[
                welcomeStyles.heading,
                phoneLandscape && welcomeStyles.headingCompact,
              ]}
              allowFontScaling={false}
              numberOfLines={2}
            >
              {L('welcomeSearchHeading')}
            </Text>
            <Text
              style={[
                welcomeStyles.matching,
                phoneLandscape && welcomeStyles.matchingCompact,
                !isDark && { color: LIVI.text2 },
              ]}
              allowFontScaling={false}
              numberOfLines={3}
            >
              {L('welcomeSearchMatching')}
            </Text>
          </View>

          <View
            style={[
              styles.noticeSlot,
              { minHeight: phoneLandscape ? 10 : 12, marginBottom: phoneLandscape ? 2 : 3 },
            ]}
            pointerEvents="none"
          />

          <View
            ref={searchBtnAnchorRef}
            collapsable={false}
            onLayout={syncBadgeGap}
            style={[
              welcomeStyles.ctaWrap,
              {
                marginTop: 'auto' as const,
                paddingTop: space.ctaMinGap,
                paddingBottom: space.ctaBottomPad,
              },
            ]}
          >
            <WelcomeSearchCta
              label={L('welcomeFindPartnerBtn')}
              onPress={handleStartSearchPress}
              disabled={hasActiveCallForSearch}
              onDisabledPress={handleBlockedSearchPress}
              compact={phoneLandscape}
              style={{
                marginBottom: 0,
              }}
            />
          </View>

          {badgeGap ? (
            <View
              pointerEvents="box-none"
              style={[
                welcomeStyles.badgeOverlay,
                { top: badgeGap.top - (phoneLandscape ? 28 : 48), height: badgeGap.height },
              ]}
            >
              {NoticeView}
              {callLockBadge}
            </View>
          ) : null}
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
    height: 54,
    paddingTop: Platform.OS === 'ios' ? 8 : 12,
    paddingHorizontal: 20,
    paddingBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topBarLandscape: {
    height: 48,
    paddingTop: 6,
  },
  topBarCompact: {
    height: 48,
    paddingTop: 8,
  },
  radarFlex: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    minHeight: 0,
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
  headingCompact: {
    fontSize: 17,
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
  matchingCompact: {
    fontSize: 12,
    lineHeight: 17,
  },
  ctaWrap: {
    alignSelf: 'stretch',
    alignItems: 'center',
    flexShrink: 0,
    zIndex: 1,
  },
  badgeOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    zIndex: 2,
    paddingHorizontal: CHROME_PERIMETER_GLOW_LAYOUT_INSET,
  },
});

export const HomeWelcomeView = React.memo(HomeWelcomeViewInner);
