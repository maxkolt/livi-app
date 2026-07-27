import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
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
    'styles' | 'isDark' | 'layoutWidth' | 'menuChromeBg'
  >;
  NoticeView: React.ReactNode;
  hasActiveCallForSearch: boolean;
  showCallSearchLockBadge: boolean;
  showUpdateBadge: boolean;
  onHideUpdateBadge: () => void;
  onStartSearch: () => void;
  onBlockedStartSearch: () => void;
};

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

  // На планшетах отрицательный inset ореола упирается в край и срезает правую рамку —
  // чуть отодвигаем кнопку влево, на телефонах оставляем как было.
  const isTabletLayout = layoutWidth >= SEARCH_CTA_TABLET_MIN_WIDTH;
  const compactLayout = layoutHeight < 520;
  // Один физический пиксель на любом density — одинаково по всему периметру.
  const updateBadgeBorderW = StyleSheet.hairlineWidth;
  const updateBadgeOuterRadius = 12;
  const updateBadgeInnerRadius = Math.max(0, updateBadgeOuterRadius - updateBadgeBorderW);
  const menuBtnMarginRight = isTabletLayout
    ? -CHROME_PERIMETER_GLOW_LAYOUT_INSET + 10
    : -CHROME_PERIMETER_GLOW_LAYOUT_INSET;

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
          // Верх рамки кнопки = верх ореола + inset.
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
    layoutWidth,
    layoutHeight,
    compactLayout,
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

  return (
    <>
      <View
        style={[
          styles.topBar,
          { backgroundColor: 'transparent' },
          compactLayout && { height: 64 },
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
        layoutWidth={layoutWidth}
        compact={compactLayout}
        menuChromeBg={menuChromeBg}
        {...centerProfile}
      />

      <View
        ref={welcomeBlockRef}
        collapsable={false}
        onLayout={syncBadgeGap}
        style={[
          styles.welcomeBlock,
          Platform.OS === 'android' && { marginTop: compactLayout ? 8 : 50 },
        ]}
      >
        <View style={styles.welcomeTextBlock}>
          <Text
            style={[
              styles.title,
              {
                color: isDark ? LIVI.text : LIVI.textThemeWhite,
                ...(compactLayout && { fontSize: 21, lineHeight: 24 }),
              },
            ]}
            allowFontScaling={false}
            maxFontSizeMultiplier={1}
            numberOfLines={compactLayout ? 1 : 2}
          >
            {L('welcomeTitle')}
          </Text>
          <View
            ref={subtitleAnchorRef}
            collapsable={false}
            onLayout={syncBadgeGap}
            style={{
              width: Math.min(Math.max(0, layoutWidth - 36), 400),
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
                  ...(compactLayout && { fontSize: 13, lineHeight: 16 }),
                },
              ]}
              numberOfLines={compactLayout ? 1 : 2}
              allowFontScaling={false}
              maxFontSizeMultiplier={1}
            >
              {L('welcomeSubtitle')}
            </Text>
          </View>
        </View>
        {/* Резерв места как раньше — чтобы аватар и тексты остались на прежних позициях. */}
        <View style={styles.noticeSlot} pointerEvents="none" />
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
          style={{ marginBottom: compactLayout ? 8 : 30 }}
            backgroundColor={themeBackground}
            disabled={hasActiveCallForSearch}
            onDisabledPress={onBlockedStartSearch}
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
              gap: 10,
              zIndex: 2,
            }}
          >
            {NoticeView}
            {hasActiveCallForSearch && showCallSearchLockBadge && (
              <View
                style={[
                  styles.notice,
                  {
                    backgroundColor: isDark ? 'rgba(138,143,153,0.16)' : 'rgba(59,68,83,0.16)',
                    borderColor: isDark ? 'rgba(138,143,153,0.36)' : 'rgba(59,68,83,0.34)',
                  },
                ]}
              >
                <Text
                  style={[
                    styles.noticeText,
                    { color: isDark ? 'rgba(240,241,243,0.92)' : 'rgba(47,55,66,0.9)' },
                  ]}
                >
                  Сначала завершите текущий звонок
                </Text>
              </View>
            )}
            {showUpdateBadge && (
              <View
                style={{
                  borderRadius: updateBadgeOuterRadius,
                  overflow: 'hidden',
                  alignSelf: 'center',
                  maxWidth: Math.min(320, layoutWidth - 40),
                  // Как у AnimatedGradientBorder: hairline помогает не терять край при clip.
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
                      paddingVertical: Platform.OS === 'ios' ? 10 : 8,
                      paddingHorizontal: 20,
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
                      fontSize: 12,
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
            )}
          </View>
        ) : null}
      </View>
    </>
  );
}

export const HomeWelcomeView = React.memo(HomeWelcomeViewInner);
