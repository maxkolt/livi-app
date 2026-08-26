import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Icon } from 'react-native-paper';
import { logger } from '../../utils/logger';
import {
  ANDROID_MENU_HIT_SLOP,
  CHROME_PERIMETER_GLOW_LAYOUT_INSET,
  LIVI,
  MENU_BTN_RADIUS,
  MENU_BTN_SIZE,
  SEARCH_CTA_TABLET_MIN_WIDTH,
} from './constants';
import { AnimatedBorderButton, AnimatedGradientBorder, BrandTitleWithOutline } from './chrome';
import { HomeCenterProfile } from './HomeCenterProfile';
import type { HomeStyles } from './styles';

export type HomeWelcomeViewProps = {
  styles: HomeStyles;
  isDark: boolean;
  themeBackground: string;
  layoutWidth: number;
  layoutHeight: number;
  L: (key: string) => string;
  menuBtnInnerBg: string;
  menuChromeBg: string;
  onOpenMenu: () => void;
  unreadByUser: Record<string, number>;
  missedByUser: Record<string, number>;
  centerProfile: Omit<
    React.ComponentProps<typeof HomeCenterProfile>,
    'styles' | 'isDark' | 'layoutWidth' | 'menuChromeBg' | 'compact' | 'dense'
  >;
  NoticeView: React.ReactNode;
  hasActiveCallForSearch: boolean;
  showCallSearchLockBadge: boolean;
  onStartSearch: () => void;
  onBlockedStartSearch: () => void;
};

function resolveIsLandscape(width: number, height: number) {
  return width > 0 && height > 0 && width / height > 1.05;
}

/** Телефон vs планшет: по короткой стороне (в landscape ширина телефона часто ≥ 600). */
function resolveIsPhone(width: number, height: number) {
  const shortest = Math.min(width, height);
  return shortest > 0 && shortest < 600;
}

function HomeWelcomeViewInner({
  styles,
  isDark,
  themeBackground,
  layoutWidth,
  layoutHeight,
  L,
  menuBtnInnerBg,
  menuChromeBg,
  onOpenMenu,
  unreadByUser,
  missedByUser,
  centerProfile,
  NoticeView,
  hasActiveCallForSearch,
  showCallSearchLockBadge,
  onStartSearch,
  onBlockedStartSearch,
}: HomeWelcomeViewProps) {
  const menuIdleBlur = isDark ? 15 : 20;
  const menuPressedBlur = isDark ? 25 : 40;
  const menuIdleTitan = isDark ? 0.25 : 0.14;
  const menuPressedTitan = isDark ? 0.4 : 0.5;
  const [menuBlurIntensity, setMenuBlurIntensity] = useState(menuIdleBlur);
  const menuTitanOpacity = useRef(new Animated.Value(menuIdleTitan)).current;
  const welcomeBlockRef = useRef<View>(null);
  const subtitleAnchorRef = useRef<View>(null);
  const searchBtnAnchorRef = useRef<View>(null);
  const [badgeGap, setBadgeGap] = useState<{ top: number; height: number } | null>(null);
  const [measured, setMeasured] = useState<{ w: number; h: number }>(() => ({
    w: layoutWidth,
    h: layoutHeight,
  }));

  useEffect(() => {
    setMeasured((prev) =>
      prev.w === layoutWidth && prev.h === layoutHeight
        ? prev
        : { w: layoutWidth, h: layoutHeight },
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
      Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1
        ? prev
        : { w: width, h: height },
    );
  };

  const viewWidth = measured.w || layoutWidth;
  const viewHeight = measured.h || layoutHeight;

  const isTabletLayout = viewWidth >= SEARCH_CTA_TABLET_MIN_WIDTH;
  const isPhone = resolveIsPhone(viewWidth, viewHeight);
  const isLandscape = resolveIsLandscape(viewWidth, viewHeight);
  // Только телефоны в landscape: та же вертикальная структура, но плотнее.
  const phoneLandscape = isPhone && isLandscape;
  // Короткий portrait на телефоне (как раньше). Планшеты не трогаем.
  const compactLayout = isPhone && !isLandscape && viewHeight < 520;

  const menuBtnMarginRight = isTabletLayout
    ? -CHROME_PERIMETER_GLOW_LAYOUT_INSET + 10
    : -CHROME_PERIMETER_GLOW_LAYOUT_INSET;

  const showCallLock = hasActiveCallForSearch && showCallSearchLockBadge;
  // Ширина строк приветствия: почти на весь экран, чтобы subtitle не обрезался.
  const welcomeTextWidth = Math.max(0, viewWidth - 28);
  const welcomeTitleFontSize = phoneLandscape
    ? 18
    : compactLayout
      ? 21
      : Platform.OS === 'android'
        ? 26
        : 28;
  const welcomeSubtitleFontSize = phoneLandscape
    ? 12
    : compactLayout
      ? 13
      : Platform.OS === 'android'
        ? 14
        : 16;

  useEffect(() => {
    setMenuBlurIntensity(menuIdleBlur);
    menuTitanOpacity.setValue(menuIdleTitan);
  }, [menuIdleBlur, menuIdleTitan, menuTitanOpacity]);

  const syncBadgeGap = React.useCallback(() => {
    const block = welcomeBlockRef.current;
    const subtitle = subtitleAnchorRef.current;
    const button = searchBtnAnchorRef.current;
    if (!block || !subtitle || !button) return;
    block.measureInWindow((_bx, blockY) => {
      subtitle.measureInWindow((_sx, subY, _sw, subH) => {
        button.measureInWindow((_cx, btnY) => {
          const top = subY + subH - blockY;
          const frameTop = btnY + CHROME_PERIMETER_GLOW_LAYOUT_INSET - blockY;
          const height = frameTop - top;
          if (!(height > 0)) return;
          setBadgeGap((prev) =>
            prev && prev.top === top && prev.height === height ? prev : { top, height },
          );
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
    logger.debug('[HomeScreen] Showing menu dot notification', {
      hasUnread: unreadValues.length > 0,
      hasMissed: missedValues.length > 0,
      unreadCount: unreadValues.length,
      missedCount: missedValues.length,
      totalMissedKeys: Object.keys(missedByUser).length,
      missedByUser,
    });
  }

  const callLockBadge = showCallLock ? (
    <View
      style={[
        styles.notice,
        {
          backgroundColor: isDark ? 'rgba(138,143,153,0.16)' : 'rgba(59,68,83,0.16)',
          borderColor: isDark ? 'rgba(138,143,153,0.36)' : 'rgba(59,68,83,0.34)',
          ...(phoneLandscape
            ? { paddingVertical: 4, paddingHorizontal: 8, maxWidth: '90%' as const }
            : null),
        },
      ]}
    >
      <Text
        style={[
          styles.noticeText,
          {
            color: isDark ? 'rgba(240,241,243,0.92)' : 'rgba(47,55,66,0.9)',
            ...(phoneLandscape ? { fontSize: 11 } : null),
          },
        ]}
      >
        Сначала завершите текущий звонок
      </Text>
    </View>
  ) : null;

  return (
    <View style={{ flex: 1, minHeight: 0 }} onLayout={onRootLayout} collapsable={false}>
      <View
        style={[
          styles.topBar,
          { backgroundColor: 'transparent' },
          phoneLandscape ? { height: 48 } : compactLayout ? { height: 64 } : null,
        ]}
      >
        <BrandTitleWithOutline isDark={isDark} />

        <View
          style={{
            position: 'relative',
            flexShrink: 0,
            marginRight: menuBtnMarginRight,
          }}
        >
          <AnimatedGradientBorder
            isDark={isDark}
            width={MENU_BTN_SIZE}
            height={MENU_BTN_SIZE}
            borderRadius={MENU_BTN_RADIUS}
            perimeterGlow
          >
            <Pressable
              hitSlop={
                Platform.OS === 'android'
                  ? ANDROID_MENU_HIT_SLOP
                  : { top: 8, bottom: 8, left: 8, right: 8 }
              }
              android_ripple={{
                color: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)',
                borderless: false,
              }}
              style={[
                styles.menuBtnInner,
                {
                  backgroundColor: menuBtnInnerBg,
                  position: 'relative',
                  ...(Platform.OS === 'android' ? { elevation: 0 } : {}),
                },
              ]}
              onPressIn={() => {
                if (Platform.OS === 'ios') {
                  setMenuBlurIntensity(menuPressedBlur);
                }
                Animated.timing(menuTitanOpacity, {
                  toValue: menuPressedTitan,
                  duration: 150,
                  useNativeDriver: true,
                }).start();
              }}
              onPressOut={() => {
                if (Platform.OS === 'ios') {
                  setMenuBlurIntensity(menuIdleBlur);
                }
                Animated.timing(menuTitanOpacity, {
                  toValue: menuIdleTitan,
                  duration: 200,
                  useNativeDriver: true,
                }).start();
              }}
              onPress={onOpenMenu}
            >
              <BlurView
                pointerEvents="none"
                intensity={menuBlurIntensity}
                tint={isDark ? 'dark' : 'light'}
                style={[StyleSheet.absoluteFillObject, { borderRadius: MENU_BTN_RADIUS }]}
              />
              <Animated.View
                pointerEvents="none"
                style={[
                  StyleSheet.absoluteFillObject,
                  {
                    borderRadius: MENU_BTN_RADIUS,
                    backgroundColor: isDark ? '#8A8F99' : '#3B4453',
                    opacity: menuTitanOpacity,
                  },
                ]}
              />
              <View style={styles.menuBtnIconWrap} pointerEvents="none">
                <Icon
                  source="menu"
                  size={Platform.OS === 'ios' ? 28 : 24}
                  color={isDark ? LIVI.text : LIVI.textThemeWhite}
                />
              </View>
            </Pressable>
          </AnimatedGradientBorder>
          {shouldShowMenuDot ? (
            <View
              style={[
                styles.menuDot,
                {
                  top: CHROME_PERIMETER_GLOW_LAYOUT_INSET - 2,
                  right: 2 + CHROME_PERIMETER_GLOW_LAYOUT_INSET,
                },
              ]}
            />
          ) : null}
        </View>
      </View>

      <HomeCenterProfile
        styles={styles}
        isDark={isDark}
        layoutWidth={viewWidth}
        compact={compactLayout}
        dense={phoneLandscape}
        menuChromeBg={menuChromeBg}
        {...centerProfile}
      />

      <View
        ref={welcomeBlockRef}
        collapsable={false}
        onLayout={syncBadgeGap}
        style={[
          styles.welcomeBlock,
          { overflow: 'visible' },
          Platform.OS === 'android' && {
            marginTop: phoneLandscape ? 4 : compactLayout ? 8 : 50,
          },
        ]}
      >
        <View
          style={[
            styles.welcomeTextBlock,
            phoneLandscape && { marginTop: 4, flex: 0, gap: 2 },
          ]}
        >
          <View
            style={{
              width: welcomeTextWidth,
              alignSelf: 'center',
            }}
          >
            <Text
              style={[
                styles.title,
                {
                  color: isDark ? LIVI.text : LIVI.textThemeWhite,
                  width: welcomeTextWidth,
                  fontSize: welcomeTitleFontSize,
                  lineHeight: welcomeTitleFontSize + 4,
                },
              ]}
              allowFontScaling={false}
              maxFontSizeMultiplier={1}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.55}
            >
              {L('welcomeTitle')}
            </Text>
          </View>
          <View
            ref={subtitleAnchorRef}
            collapsable={false}
            onLayout={syncBadgeGap}
            style={{
              width: welcomeTextWidth,
              alignSelf: 'center',
              marginTop: phoneLandscape ? 0 : 2,
            }}
          >
            <Text
              style={[
                styles.subtitle,
                {
                  color: isDark ? LIVI.text2 : LIVI.textThemeWhite,
                  width: welcomeTextWidth,
                  fontSize: welcomeSubtitleFontSize,
                  lineHeight: welcomeSubtitleFontSize + 3,
                  marginTop: 0,
                  ...(Platform.OS === 'android' && { includeFontPadding: false }),
                },
              ]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.55}
              allowFontScaling={false}
              maxFontSizeMultiplier={1}
            >
              {L('welcomeSubtitle')}
            </Text>
          </View>
        </View>
        {/* Резерв под бейджи («вызов отменён» и т.п.) между подписью и кнопкой. */}
        <View
          style={[
            styles.noticeSlot,
            phoneLandscape && { minHeight: 40, marginBottom: 8 },
            // Планшет landscape: меньше резерв, иначе CTA упирается вниз и теряется нижняя рамка.
            isTabletLayout &&
              isLandscape &&
              !phoneLandscape && { minHeight: 48, marginBottom: 12 },
          ]}
          pointerEvents="none"
        />
        <View
          ref={searchBtnAnchorRef}
          collapsable={false}
          onLayout={syncBadgeGap}
          style={{
            alignSelf: 'stretch',
            alignItems: 'center',
            ...(isTabletLayout ? { overflow: 'visible' as const } : null),
          }}
        >
          <AnimatedBorderButton
            isDark={isDark}
            onPress={onStartSearch}
            label={L('startSearchBtn')}
            style={{
              // Планшет: запас снизу, чтобы glow/SafeArea не срезали нижнюю линию рамки.
              marginBottom: phoneLandscape
                ? 4
                : compactLayout
                  ? 8
                  : isTabletLayout
                    ? 30 + CHROME_PERIMETER_GLOW_LAYOUT_INSET
                    : 30,
              ...(isTabletLayout ? { overflow: 'visible' as const } : null),
            }}
            backgroundColor={themeBackground}
            disabled={hasActiveCallForSearch}
            onDisabledPress={onBlockedStartSearch}
            compact={phoneLandscape}
          />
        </View>
        {badgeGap ? (
          <View
            pointerEvents="box-none"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: badgeGap.top,
              height: badgeGap.height,
              justifyContent: 'center',
              alignItems: 'center',
              gap: phoneLandscape ? 6 : 10,
              zIndex: 2,
            }}
          >
            {NoticeView}
            {callLockBadge}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export const HomeWelcomeView = React.memo(HomeWelcomeViewInner);
