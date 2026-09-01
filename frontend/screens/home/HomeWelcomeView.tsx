import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { logger } from '../../utils/logger';
import { CHROME_PERIMETER_GLOW_LAYOUT_INSET, LIVI, SEARCH_CTA_TABLET_MIN_WIDTH, WELCOME_MUTED_TEXT } from './constants';
import { BrandTitleWithOutline } from './chrome';
import { HomeBrandConfetti, type BrandConfettiOrigin } from './HomeBrandConfetti';
import { HomeCenterProfile } from './HomeCenterProfile';
import { WelcomeCrownButton } from './WelcomeCrownButton';
import { WelcomeOnlineBanner, type WelcomeBannerPeer } from './WelcomeOnlineBanner';
import { WelcomeRadar } from './WelcomeRadar';
import { WelcomeSearchCta } from './WelcomeSearchCta';
import type { Lang } from '../../utils/i18n';
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
  onOpenProfile: () => void;
  /** Долгое нажатие на корону — меню (друзья и т.д.), пока нет tab bar. */
  onOpenMenu: () => void;
  onlineCount: number | null;
  bannerPeers: WelcomeBannerPeer[];
  unreadByUser: Record<string, number>;
  missedByUser: Record<string, number>;
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

function HomeWelcomeViewInner({
  styles,
  isDark,
  layoutWidth,
  layoutHeight,
  L,
  lang,
  menuChromeBg,
  onOpenProfile,
  onOpenMenu,
  onlineCount,
  bannerPeers,
  unreadByUser,
  missedByUser,
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
  const reveal = useRef(new Animated.Value(0)).current;
  const [badgeGap, setBadgeGap] = useState<{ top: number; height: number } | null>(null);
  const [measured, setMeasured] = useState<{ w: number; h: number }>(() => ({
    w: layoutWidth,
    h: layoutHeight,
  }));

  useEffect(() => {
    if (!splashGone) return;
    Animated.timing(reveal, {
      toValue: 1,
      duration: 560,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
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
  const phoneLandscape = isPhone && isLandscape;
  const compactLayout = isPhone && !isLandscape && viewHeight < 520;

  const radarSize = phoneLandscape
    ? Math.min(viewWidth * 0.68, 248)
    : compactLayout
      ? Math.min(viewWidth * 0.84, 288)
      : Math.min(viewWidth * 0.88, 328);

  const welcomeAvatarRadius = Math.round((viewWidth < 400 ? 112 : 124) / 2);

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

  const handleOpenProfile = useCallback(() => {
    cancelBurst();
    onOpenProfile();
  }, [cancelBurst, onOpenProfile]);

  const handleOpenMenuLongPress = useCallback(() => {
    cancelBurst();
    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      /* optional */
    }
    onOpenMenu();
  }, [cancelBurst, onOpenMenu]);

  const handleStartSearchPress = useCallback(() => {
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

  const unreadValues = Object.values(unreadByUser).filter((n) => typeof n === 'number' && n > 0);
  const missedValues = Object.values(missedByUser).filter((n) => typeof n === 'number' && n > 0);
  const shouldShowMenuDot = unreadValues.length > 0 || missedValues.length > 0;
  if (shouldShowMenuDot) {
    logger.debug('[HomeScreen] welcome menu dot', {
      unread: unreadValues.length,
      missed: missedValues.length,
    });
  }

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
        <WelcomeCrownButton
          onPress={handleOpenProfile}
          onLongPress={handleOpenMenuLongPress}
          showBadge={shouldShowMenuDot}
        />
      </View>

      <Animated.View style={revealStyle}>
        <WelcomeOnlineBanner
          lang={lang}
          onlineLabel={L('online')}
          onlineCount={onlineCount}
          peers={bannerPeers}
          compact={phoneLandscape || compactLayout}
        />
      </Animated.View>

      <Animated.View
        ref={welcomeBlockRef}
        collapsable={false}
        onLayout={syncBadgeGap}
        style={[
          welcomeStyles.radarFlex,
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
            menuChromeBg={menuChromeBg}
            {...centerProfile}
            avatarAnchorRef={avatarAnchorRef}
            onOpenAvatarModal={handleOpenAvatarModal}
          />
        </WelcomeRadar>

        <Animated.View style={[welcomeStyles.stageCopy, revealStyle]}>
          <View ref={copyAnchorRef} collapsable={false} onLayout={syncBadgeGap} style={welcomeStyles.copyBlock}>
            <Text
              style={[
                welcomeStyles.heading,
                phoneLandscape && welcomeStyles.headingCompact,
                !isDark && { color: LIVI.textThemeWhite },
              ]}
              allowFontScaling={false}
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

          <View ref={searchBtnAnchorRef} collapsable={false} onLayout={syncBadgeGap} style={welcomeStyles.ctaWrap}>
            <WelcomeSearchCta
              label={L('welcomeFindPartnerBtn')}
              onPress={handleStartSearchPress}
              disabled={hasActiveCallForSearch}
              onDisabledPress={handleBlockedSearchPress}
              compact={phoneLandscape}
              style={{
                marginBottom: phoneLandscape ? 4 : 8,
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
  },
  topBar: {
    height: 54,
    paddingTop: 12,
    paddingHorizontal: 20,
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
    paddingTop: 4,
    marginTop: -8,
  },
  stageCopy: {
    width: '100%',
    alignItems: 'center',
    marginTop: 4,
    paddingBottom: 8,
    position: 'relative',
  },
  copyBlock: {
    paddingHorizontal: 28,
    alignItems: 'center',
    marginBottom: 6,
  },
  heading: {
    color: LIVI.white,
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
    marginTop: 30,
    paddingBottom: 4,
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
