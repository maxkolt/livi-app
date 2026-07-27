import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Icon } from 'react-native-paper';
import { logger } from '../../utils/logger';
import { markUpdateBadgeShown, PLAY_STORE_UPDATE_URL } from '../../utils/updateCheck';
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
  showUpdateBadge: boolean;
  onHideUpdateBadge: () => void;
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
  showUpdateBadge,
  onHideUpdateBadge,
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

  const updateBadgeBorderW = StyleSheet.hairlineWidth;
  const updateBadgeOuterRadius = 12;
  const updateBadgeInnerRadius = Math.max(0, updateBadgeOuterRadius - updateBadgeBorderW);
  const menuBtnMarginRight = isTabletLayout
    ? -CHROME_PERIMETER_GLOW_LAYOUT_INSET + 10
    : -CHROME_PERIMETER_GLOW_LAYOUT_INSET;

  const showCallLock = hasActiveCallForSearch && showCallSearchLockBadge;

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
    showUpdateBadge,
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

  const updateBadge = showUpdateBadge ? (
    <View
      style={{
        borderRadius: updateBadgeOuterRadius,
        overflow: 'hidden',
        alignSelf: 'center',
        maxWidth: Math.min(320, viewWidth - 40),
        ...(Platform.OS === 'android'
          ? {
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: isDark
                ? 'rgba(45, 212, 191, 0.4)'
                : 'rgba(139, 130, 200, 0.4)',
            }
          : null),
      }}
    >
      <LinearGradient
        colors={
          isDark
            ? ['#2dd4bf', '#60a5fa', '#38bdf8', '#FFF8F0', '#2dd4bf']
            : ['#8B82C8', '#9A8FC9', '#A8A0B8', '#ADA9B0']
        }
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />
      <Pressable
        style={({ pressed }) => [
          {
            margin: updateBadgeBorderW,
            borderRadius: updateBadgeInnerRadius,
            alignItems: 'center',
            justifyContent: 'center',
            alignSelf: 'stretch',
            backgroundColor: themeBackground,
            paddingVertical: phoneLandscape ? 6 : Platform.OS === 'ios' ? 10 : 8,
            paddingHorizontal: phoneLandscape ? 14 : 20,
            zIndex: 1,
          },
          pressed && {
            backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
          },
        ]}
        onPress={() => {
          onHideUpdateBadge();
          markUpdateBadgeShown();
          Linking.openURL(PLAY_STORE_UPDATE_URL);
        }}
        android_ripple={{
          color: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
          borderless: false,
        }}
      >
        <Text
          style={{
            color: isDark ? LIVI.text : '#2F3742',
            fontSize: phoneLandscape ? 11 : 12,
            fontWeight: '500',
            textAlign: 'center',
            ...(Platform.OS === 'android' && { includeFontPadding: false }),
          }}
          numberOfLines={1}
          ellipsizeMode="tail"
          allowFontScaling={false}
        >
          {L('updateBtn')}
        </Text>
      </Pressable>
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
                if (Platform.OS !== 'ios') return;
                setMenuBlurIntensity(menuPressedBlur);
                Animated.timing(menuTitanOpacity, {
                  toValue: menuPressedTitan,
                  duration: 150,
                  useNativeDriver: true,
                }).start();
              }}
              onPressOut={() => {
                if (Platform.OS !== 'ios') return;
                setMenuBlurIntensity(menuIdleBlur);
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
          <Text
            style={[
              styles.title,
              {
                color: isDark ? LIVI.text : LIVI.textThemeWhite,
                ...(phoneLandscape
                  ? { fontSize: 18, lineHeight: 20 }
                  : compactLayout
                    ? { fontSize: 21, lineHeight: 24 }
                    : null),
              },
            ]}
            allowFontScaling={false}
            maxFontSizeMultiplier={1}
            numberOfLines={phoneLandscape || compactLayout ? 1 : 2}
          >
            {L('welcomeTitle')}
          </Text>
          <View
            ref={subtitleAnchorRef}
            collapsable={false}
            onLayout={syncBadgeGap}
            style={{
              width: Math.min(Math.max(0, viewWidth - 36), phoneLandscape ? 520 : 400),
              alignSelf: 'center',
              paddingHorizontal: 2,
            }}
          >
            <Text
              style={[
                styles.subtitle,
                {
                  color: isDark ? LIVI.text2 : LIVI.textThemeWhite,
                  width: '100%',
                  ...(Platform.OS === 'android' && { includeFontPadding: false }),
                  ...(phoneLandscape
                    ? { fontSize: 12, lineHeight: 14, marginTop: 0 }
                    : compactLayout
                      ? { fontSize: 13, lineHeight: 16 }
                      : null),
                },
              ]}
              numberOfLines={phoneLandscape || compactLayout ? 1 : 2}
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
          ]}
          pointerEvents="none"
        />
        <View
          ref={searchBtnAnchorRef}
          collapsable={false}
          onLayout={syncBadgeGap}
          style={{ alignSelf: 'stretch', alignItems: 'center' }}
        >
          <AnimatedBorderButton
            isDark={isDark}
            onPress={onStartSearch}
            label={L('startSearchBtn')}
            style={{ marginBottom: phoneLandscape ? 4 : compactLayout ? 8 : 30 }}
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
            {updateBadge}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export const HomeWelcomeView = React.memo(HomeWelcomeViewInner);
