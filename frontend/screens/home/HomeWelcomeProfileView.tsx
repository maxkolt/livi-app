import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  BackHandler,
  type LayoutChangeEvent,
} from 'react-native';
import { useHomeLayout } from './HomeLayoutContext';
import AdaptiveText from '../../components/AdaptiveText';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import * as Clipboard from 'expo-clipboard';
import AvatarImage from '../../components/AvatarImage';
import { TextInput as PaperInput } from 'react-native-paper';
import { getCurrentUserId } from '../../sockets/socket';
import { t, languages, type Lang } from '../../utils/i18n';
import { getPrivacyPolicyUrl } from '../../utils/privacyPolicyUrl';
import {
  getCurrentAppVersion,
  markUpdateBadgeShown,
  PLAY_STORE_UPDATE_URL,
} from '../../utils/updateCheck';
import type { ChatWallpaperTheme } from '../../utils/chatWallpaper';
import { ChatWallpaperPickerPanel } from './ChatWallpaperPickerPanel';
import { WelcomeCrownButton } from './WelcomeCrownButton';
import {
  LIVI,
  isWelcomeTabletLayout,
  WELCOME_BRAND_VI_STROKE_GRADIENT,
  WELCOME_BRAND_VI_FILL_GRADIENT,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_GLASS_BORDER,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
} from './constants';
import { WELCOME_SEGMENT_ACTIVE } from './FriendsListCore';
import { displayAvatarLetter, displayName } from './friendHelpers';
import {
  WelcomeProfileRow,
  WelcomeProfileSection,
  WelcomeProfileLanguageRow,
  WELCOME_PROFILE_ROW_ICON,
} from './WelcomeProfileListUi';
import type { HomeStyles } from './styles';

const SUPPORT_EMAIL = '12345kolt@gmal.com';
const SUPPORT_EMAIL_2 = 'kolt12max@mail.ru';
const BOOSTY_URL = process.env.EXPO_PUBLIC_BOOSTY_URL || 'https://boosty.to/liviapp/donate';
const PATREON_URL = process.env.EXPO_PUBLIC_PATREON_URL || 'https://www.patreon.com/c/LiViApp';
const AVATAR_RING_WIDTH = 2.5;
const CAMERA_BTN_SIZE = 38;
/** Строк в hub-профиле: 4 секции по 2 строки. */
const PROFILE_HUB_ROW_COUNT = 8;

/**
 * Раскладка hub-профиля считается как распределение высоты панели:
 * отступы вокруг аватара и над таб-баром фиксированы, а «лишнее» забирается
 * у списка — строки и промежутки между секциями ужимаются до своих минимумов.
 * Аватар при этом не трогается: его размер задан классом устройства.
 */
type HubMetrics = {
  avatarSize: number;
  cameraBtnSize: number;
  /** Шапка «Профиль» → аватар. */
  gapTop: number;
  /** Аватар → первая карточка. */
  gapUnderAvatar: number;
  /** Последняя карточка → «Удалить профиль». */
  gapAboveDelete: number;
  /** «Удалить профиль» → таб-бар. */
  gapBottom: number;
  deleteHeight: number;
  rowHeight: number;
  listGap: number;
  /** Даже на минимумах не помещается — отдаём скролл. */
  scroll: boolean;
};

type HubMetricsPreset = {
  avatarSize: number;
  cameraBtnSize: number;
  gapTop: number;
  gapUnderAvatar: number;
  gapAboveDelete: number;
  gapBottom: number;
  deleteHeight: number;
  rowMax: number;
  rowMin: number;
  gapMax: number;
  gapMin: number;
};

const HUB_PRESET_PHONE: HubMetricsPreset = {
  avatarSize: 120,
  cameraBtnSize: CAMERA_BTN_SIZE,
  gapTop: 14,
  gapUnderAvatar: 14,
  gapAboveDelete: 10,
  gapBottom: 14,
  deleteHeight: 40,
  rowMax: 48,
  rowMin: 40,
  gapMax: 12,
  gapMin: 6,
};

const HUB_PRESET_PHONE_LANDSCAPE: HubMetricsPreset = {
  avatarSize: 84,
  cameraBtnSize: 32,
  gapTop: 8,
  gapUnderAvatar: 10,
  gapAboveDelete: 6,
  gapBottom: 10,
  deleteHeight: 28,
  rowMax: 42,
  rowMin: 34,
  gapMax: 8,
  gapMin: 4,
};

const HUB_PRESET_TABLET: HubMetricsPreset = {
  avatarSize: 136,
  cameraBtnSize: 40,
  gapTop: 20,
  gapUnderAvatar: 20,
  gapAboveDelete: 12,
  gapBottom: 18,
  deleteHeight: 46,
  rowMax: 56,
  rowMin: 48,
  gapMax: 16,
  gapMin: 10,
};

const HUB_PRESET_TABLET_LANDSCAPE: HubMetricsPreset = {
  avatarSize: 112,
  cameraBtnSize: 38,
  gapTop: 12,
  gapUnderAvatar: 14,
  gapAboveDelete: 8,
  gapBottom: 14,
  deleteHeight: 42,
  rowMax: 54,
  rowMin: 44,
  gapMax: 14,
  gapMin: 8,
};

const PROFILE_HUB_SECTION_COUNT = 4;

/** Сколько рядов секций по вертикали: в две колонки их вдвое меньше. */
function hubSectionRows(twoColumns: boolean): number {
  return twoColumns ? PROFILE_HUB_SECTION_COUNT / 2 : PROFILE_HUB_SECTION_COUNT;
}

function hubRowsPerColumn(twoColumns: boolean): number {
  return twoColumns ? PROFILE_HUB_ROW_COUNT / 2 : PROFILE_HUB_ROW_COUNT;
}

function resolveHubPreset(isTablet: boolean, isLandscape: boolean): HubMetricsPreset {
  if (isTablet) return isLandscape ? HUB_PRESET_TABLET_LANDSCAPE : HUB_PRESET_TABLET;
  return isLandscape ? HUB_PRESET_PHONE_LANDSCAPE : HUB_PRESET_PHONE;
}

function resolveHubMetrics(
  paneHeight: number,
  isTablet: boolean,
  isLandscape: boolean,
  twoColumns: boolean,
): HubMetrics {
  const preset = resolveHubPreset(isTablet, isLandscape);
  const fixed =
    preset.gapTop +
    preset.avatarSize +
    AVATAR_RING_WIDTH * 2 +
    preset.gapUnderAvatar +
    preset.gapAboveDelete +
    preset.deleteHeight +
    preset.gapBottom;
  const rows = hubRowsPerColumn(twoColumns);
  const gaps = Math.max(0, hubSectionRows(twoColumns) - 1);
  const listBudget = Math.max(0, paneHeight - fixed);
  const maxTotal = rows * preset.rowMax + gaps * preset.gapMax;
  const minTotal = rows * preset.rowMin + gaps * preset.gapMin;

  if (!(paneHeight > 0) || listBudget >= maxTotal) {
    return { ...preset, rowHeight: preset.rowMax, listGap: preset.gapMax, scroll: false };
  }
  if (listBudget <= minTotal) {
    return { ...preset, rowHeight: preset.rowMin, listGap: preset.gapMin, scroll: true };
  }
  const t = (listBudget - minTotal) / (maxTotal - minTotal);
  return {
    ...preset,
    // Вниз, а не к ближайшему: округление вверх снова съело бы отступы.
    rowHeight: Math.floor(preset.rowMin + (preset.rowMax - preset.rowMin) * t),
    listGap: Math.floor(preset.gapMin + (preset.gapMax - preset.gapMin) * t),
    scroll: false,
  };
}

function estimateTabBarHeight(bottomInset: number, isTablet: boolean, isLandscape: boolean) {
  // Совпадает с minHeight строки таб-бара в HomeWelcomeTabBar.
  const base = isTablet ? 60 : isLandscape ? 46 : 52;
  return base + Math.max(bottomInset, Platform.OS === 'android' ? 6 : 2);
}

/** Считается из тех же констант, что и стиль header + размер короны. */
function estimateProfileHeaderHeight(isTablet: boolean, isLandscape: boolean) {
  const padTop = isTablet ? 14 : isLandscape ? 2 : Platform.OS === 'ios' ? 8 : 12;
  const padBottom = isTablet ? 10 : isLandscape ? 2 : 8;
  const titleFont = isTablet ? 30 : isLandscape ? 22 : 28;
  const crownSize = isLandscape && !isTablet ? 36 : isTablet ? 44 : 40;
  return Math.round(padTop + Math.max(titleFont * 1.25, crownSize) + padBottom);
}

/**
 * Высота панели для ПЕРВОГО кадра, пока не пришёл onLayout. Без неё первый рендер
 * считался по «места сколько угодно» и строки на следующем кадре схлопывались —
 * при первом заходе в профиль было видно, как контент ужимается.
 */
function estimateHubPaneHeight(
  windowHeight: number,
  topInset: number,
  bottomInset: number,
  isTablet: boolean,
  isLandscape: boolean,
): number {
  return Math.max(
    0,
    windowHeight -
      topInset -
      estimateProfileHeaderHeight(isTablet, isLandscape) -
      estimateTabBarHeight(bottomInset, isTablet, isLandscape),
  );
}

function normalizeLangCode(code?: string): string {
  if (!code) return '';
  const c = code.toLowerCase();
  if (c.startsWith('zh-tw')) return 'zh-tw';
  if (c.startsWith('zh')) return 'zh';
  return c;
}

function appendSupportUtm(url: string, params: Record<string, string>): string {
  try {
    const u = new URL(url);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  } catch {
    const hasQ = url.includes('?');
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return url + (hasQ ? '&' : '?') + qs;
  }
}

type ProfileScreen = 'hub' | 'about' | 'language' | 'help' | 'support';

export type HomeWelcomeProfileViewProps = {
  lang: Lang;
  isDark: boolean;
  styles: HomeStyles;
  menuChromeBg: string;
  savedNick: string;
  nick: string;
  setNick: (v: string) => void;
  onClearNick: () => void;
  avatarUri: string;
  myFullAvatarUri?: string;
  myAvatarVer?: number;
  openAvatarSheet?: () => void;
  handleSaveProfile: () => void;
  saving?: boolean;
  savedToast?: boolean;
  setSavedToast?: (show: boolean) => void;
  onSelectLang: (code: Lang) => void;
  incrCounter: (key: string) => Promise<number>;
  onSupportClick: () => void;
  onLogOutAccount?: () => void;
  wiping?: boolean;
  updateAvailable: boolean;
  wallpaperPickerTheme: ChatWallpaperTheme | null;
  setWallpaperPickerTheme: (theme: ChatWallpaperTheme | null) => void;
  /** Hub + Back → родитель (обычно Search), иначе false → системный фон. */
  onBackFromHub?: () => boolean;
  /** Keep-alive: Back только когда вкладка видна. */
  active?: boolean;
};

function HomeWelcomeProfileViewInner(props: HomeWelcomeProfileViewProps) {
  const {
    lang,
    isDark,
    styles: homeStyles,
    menuChromeBg,
    savedNick,
    nick,
    setNick,
    onClearNick,
    avatarUri,
    myFullAvatarUri,
    myAvatarVer = 0,
    openAvatarSheet,
    handleSaveProfile,
    saving,
    savedToast,
    setSavedToast,
    onSelectLang,
    incrCounter,
    onSupportClick,
    onLogOutAccount,
    wiping,
    updateAvailable,
    wallpaperPickerTheme,
    setWallpaperPickerTheme,
    onBackFromHub,
    active = true,
  } = props;

  const insets = useSafeAreaInsets();
  // Размер берём из safe-area frame: он приходит от нативного провайдера и
  // обновляется при повороте, в отличие от Dimensions.
  const { width: windowWidth, height: windowHeight } = useHomeLayout();
  const isLandscape =
    windowWidth > 0 && windowHeight > 0 && windowWidth / windowHeight > 1.05;
  const isTablet = isWelcomeTabletLayout(windowWidth, windowHeight);
  const compactLandscape = isLandscape && !isTablet;
  const [screen, setScreen] = useState<ProfileScreen>('hub');
  const [accountOpen, setAccountOpen] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);
  const [hubViewportHeight, setHubViewportHeight] = useState(0);

  /** В landscape одна колонка секций не помещается по высоте — раскладываем в две. */
  const twoColumnList = isLandscape;

  /**
   * Высоту берём из onLayout самой панели: она уже учитывает шапку, таб-бар и
   * системные insets, поэтому отступы не зависят от оценок.
   */
  const hubPaneHeight =
    hubViewportHeight > 0
      ? hubViewportHeight
      : estimateHubPaneHeight(windowHeight, insets.top, insets.bottom, isTablet, isLandscape);

  const hubMetrics = useMemo(
    () => resolveHubMetrics(hubPaneHeight, isTablet, isLandscape, twoColumnList),
    [hubPaneHeight, isTablet, isLandscape, twoColumnList],
  );

  /** Скролл при редактировании ника или когда даже минимальные строки не влезают. */
  const needsHubScroll = accountOpen || hubMetrics.scroll;

  const handleHubPaneLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    if (!(nextHeight > 0)) return;
    setHubViewportHeight((current) =>
      Math.abs(current - nextHeight) < 1 ? current : nextHeight,
    );
  }, []);

  const myUserId = getCurrentUserId();
  const displayNick = displayName(savedNick || nick);
  const letter = displayAvatarLetter(savedNick || nick);
  const busy = !!saving || !!wiping;

  useEffect(() => {
    if (!savedToast || busy || !setSavedToast) return;
    const tmo = setTimeout(() => setSavedToast(false), 1200);
    return () => clearTimeout(tmo);
  }, [savedToast, busy, setSavedToast]);

  const langLabel = (lang ?? 'ru').toUpperCase();

  const openAccountEdit = useCallback(() => {
    setAccountOpen((open) => {
      if (open) Keyboard.dismiss();
      return !open;
    });
  }, []);

  const closeAccountEdit = useCallback(() => {
    Keyboard.dismiss();
    setAccountOpen(false);
  }, []);

  const openAbout = useCallback(() => {
    setScreen('about');
  }, []);

  const goHub = useCallback(() => {
    setScreen('hub');
    setAccountOpen(false);
    setCopiedEmail(null);
  }, []);

  const openLanguage = useCallback(() => {
    setAccountOpen(false);
    setScreen('language');
  }, []);

  const handleSubBack = useCallback(() => {
    goHub();
  }, [goHub]);

  const subScreenTitle = useMemo(() => {
    if (screen === 'about') return t('welcomeAboutApp', lang);
    if (screen === 'help') return t('profileHelp', lang);
    if (screen === 'support') return t('supportProjectTitle', lang);
    return t('chooseLanguage', lang);
  }, [screen, lang]);

  const openNotificationsSettings = useCallback(() => {
    Linking.openSettings().catch(() => {});
  }, []);

  const openPrivacy = useCallback(() => {
    Linking.openURL(getPrivacyPolicyUrl()).catch(() => {});
  }, []);

  const openHelp = useCallback(() => {
    setAccountOpen(false);
    setScreen('help');
  }, []);

  const openChatWallpaper = useCallback(() => {
    setWallpaperPickerTheme('dark');
  }, [setWallpaperPickerTheme]);

  const openSupport = useCallback(() => {
    setAccountOpen(false);
    onSupportClick();
    setScreen('support');
  }, [onSupportClick]);

  const openBoosty = useCallback(async () => {
    const clicks = await incrCounter('support_boosty_clicks');
    const url = appendSupportUtm(BOOSTY_URL, {
      utm_source: 'livi_app',
      utm_medium: 'support',
      utm_campaign: 'donate',
      utm_content: 'boosty',
      utm_count: String(clicks),
    });
    Linking.openURL(url).catch(() => {});
  }, [incrCounter]);

  const openPatreon = useCallback(async () => {
    const clicks = await incrCounter('support_patreon_clicks');
    const url = appendSupportUtm(PATREON_URL, {
      utm_source: 'livi_app',
      utm_medium: 'support',
      utm_campaign: 'donate',
      utm_content: 'patreon',
      utm_count: String(clicks),
    });
    Linking.openURL(url).catch(() => {});
  }, [incrCounter]);

  const copyEmail = useCallback(async (email: string) => {
    try {
      await Clipboard.setStringAsync(email);
      setCopiedEmail(email);
    } catch {}
  }, []);

  const openUpdate = useCallback(() => {
    markUpdateBadgeShown();
    Linking.openURL(PLAY_STORE_UPDATE_URL).catch(() => {});
  }, []);

  const pickLang = useCallback(
    (code: Lang) => {
      onSelectLang(code);
    },
    [onSelectLang],
  );

  const handleApplyChatWallpaper = useCallback(async (wallpaperId: string) => {
    const { setChatWallpaperId } = await import('../../utils/chatWallpaper');
    await setChatWallpaperId('dark', wallpaperId);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!active) return;

    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (wallpaperPickerTheme) {
        setWallpaperPickerTheme(null);
        return true;
      }
      if (screen !== 'hub') {
        goHub();
        return true;
      }
      if (accountOpen) {
        closeAccountEdit();
        return true;
      }
      if (typeof onBackFromHub === 'function') {
        return onBackFromHub();
      }
      return false;
    });

    return () => sub.remove();
  }, [
    active,
    wallpaperPickerTheme,
    setWallpaperPickerTheme,
    screen,
    goHub,
    accountOpen,
    closeAccountEdit,
    onBackFromHub,
  ]);

  const avatarSize = hubMetrics.avatarSize;
  const cameraBtnSize = hubMetrics.cameraBtnSize;

  const avatarInner = (
    <View
      style={[
        homeStyles.centerAvatarWrap,
        {
          width: avatarSize,
          height: avatarSize,
          borderRadius: avatarSize / 2,
          backgroundColor: menuChromeBg,
        },
      ]}
    >
      {avatarUri && /^(file|content|ph|assets-library):\/\//i.test(avatarUri) ? (
        <ExpoImage source={{ uri: avatarUri }} style={homeStyles.centerAvatarImg} cachePolicy="memory-disk" />
      ) : myUserId && myAvatarVer > 0 ? (
        <AvatarImage
          userId={myUserId}
          avatarVer={myAvatarVer}
          uri={myFullAvatarUri || undefined}
          size={avatarSize}
          fallbackText={letter}
          containerStyle={homeStyles.centerAvatarImg}
          fallbackTextStyle={{ fontSize: avatarSize > 110 ? 34 : 28, fontWeight: '800' }}
        />
      ) : (
        <View style={[homeStyles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]}>
          <AdaptiveText style={{ color: LIVI.titan, fontSize: avatarSize > 110 ? 34 : 28, fontWeight: '500' }}>{letter}</AdaptiveText>
        </View>
      )}
    </View>
  );

  const closeWallpaperPicker = useCallback(() => {
    setWallpaperPickerTheme(null);
  }, [setWallpaperPickerTheme]);

  const headerWallpaper = (
    <View
      style={[
        styles.headerCenter,
        isTablet && styles.headerCenterTablet,
        compactLandscape && styles.headerCenterLandscape,
      ]}
    >
      <Pressable
        style={({ pressed }) => [styles.headerBackBtn, styles.headerBack, pressed && styles.headerBackBtnPressed]}
        onPress={closeWallpaperPicker}
        accessibilityRole="button"
        accessibilityLabel={t('cancelAction', lang)}
      >
        <Ionicons name="chevron-back" size={22} color={LIVI.white} />
      </Pressable>
      <AdaptiveText
        style={[
          styles.titleCenter,
          isTablet && styles.titleCenterTablet,
          compactLandscape && styles.titleCenterLandscape,
        ]}
        numberOfLines={2}
      >
        {t('chatWallpaperMessages', lang)}
      </AdaptiveText>
      <View style={styles.headerBackSpacer} />
    </View>
  );

  if (wallpaperPickerTheme) {
    return (
      <View style={styles.root}>
        <View style={styles.rootInner}>
          {headerWallpaper}
          <ChatWallpaperPickerPanel
            key="dark"
            theme="dark"
            lang={lang}
            welcomeLayout
            welcomeNavHeader
            onBack={closeWallpaperPicker}
            onApply={handleApplyChatWallpaper}
          />
        </View>
      </View>
    );
  }

  const headerHub = (
    <View
      style={[
        styles.header,
        isTablet && styles.headerTablet,
        compactLandscape && styles.headerLandscape,
      ]}
    >
      <AdaptiveText
        style={[
          styles.title,
          isTablet && styles.titleTablet,
          compactLandscape && styles.titleLandscape,
        ]}
      >
        {t('tabSettings', lang)}
      </AdaptiveText>
      <WelcomeCrownButton
        compact={compactLandscape}
        large={isTablet}
        myUserId={myUserId}
        myAvatarVer={myAvatarVer}
        avatarUri={avatarUri}
        nick={savedNick || nick}
      />
    </View>
  );

  const headerSettings = (
    <View
      style={[
        styles.headerCenter,
        isTablet && styles.headerCenterTablet,
        compactLandscape && styles.headerCenterLandscape,
      ]}
    >
      <Pressable
        style={({ pressed }) => [styles.headerBackBtn, styles.headerBack, pressed && styles.headerBackBtnPressed]}
        onPress={handleSubBack}
        accessibilityRole="button"
        accessibilityLabel={t('cancelAction', lang)}
      >
        <Ionicons name="chevron-back" size={22} color={LIVI.white} />
      </Pressable>
      <AdaptiveText
        style={[
          styles.titleCenter,
          isTablet && styles.titleCenterTablet,
          compactLandscape && styles.titleCenterLandscape,
        ]}
      >
        {subScreenTitle}
      </AdaptiveText>
      <View style={styles.headerBackSpacer} />
    </View>
  );

  const hubLogoutButton = (
    <View
      style={[
        styles.hubActions,
        { minHeight: hubMetrics.deleteHeight, paddingBottom: hubMetrics.gapBottom },
      ]}
    >
      <Pressable
        style={({ pressed }) => [
          styles.logOutBtn,
          isTablet && styles.logOutBtnTablet,
          compactLandscape && styles.logOutBtnLandscape,
          pressed && styles.hubBtnPressed,
        ]}
        onPress={() => onLogOutAccount?.()}
        disabled={busy || !onLogOutAccount}
        accessibilityRole="button"
      >
        <Ionicons name="trash-outline" size={22} color="#A63A48" />
        <AdaptiveText
          style={[
            styles.logOutBtnText,
            isTablet && styles.logOutBtnTextTablet,
            compactLandscape && styles.logOutBtnTextLandscape,
          ]}
        >
          {t('welcomeDeleteProfile', lang)}
        </AdaptiveText>
      </Pressable>
    </View>
  );

  const hubAvatarSection = (
    <View
      style={[
        styles.avatarBlock,
        {
          paddingTop: hubMetrics.gapTop,
          marginBottom: hubMetrics.gapUnderAvatar,
        },
      ]}
    >
      <View style={styles.avatarWrap}>
        <Pressable
          onPress={() => openAvatarSheet?.()}
          disabled={busy}
          style={[
            styles.avatarRing,
            {
              width: avatarSize + AVATAR_RING_WIDTH * 2,
              height: avatarSize + AVATAR_RING_WIDTH * 2,
              borderRadius: (avatarSize + AVATAR_RING_WIDTH * 2) / 2,
            },
          ]}
        >
          {avatarInner}
        </Pressable>
        <Pressable
          style={[
            styles.cameraBtn,
            {
              width: cameraBtnSize,
              height: cameraBtnSize,
              borderRadius: cameraBtnSize / 2,
            },
          ]}
          onPress={() => openAvatarSheet?.()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={t('takePhoto', lang)}
        >
          <Ionicons name="camera-outline" size={cameraBtnSize > 34 ? 20 : 18} color={LIVI.white} />
        </Pressable>
      </View>
    </View>
  );

  const hubListStack = (
    <View
      style={[
        styles.hubListStack,
        twoColumnList && styles.hubListStackTwoColumns,
        isTablet && styles.hubListStackTablet,
        twoColumnList
          ? { rowGap: hubMetrics.listGap }
          : { gap: hubMetrics.listGap },
        { marginBottom: hubMetrics.gapAboveDelete },
        accountOpen && styles.hubListStackNickOpen,
      ]}
    >
      <WelcomeProfileSection
        dense
        compact={compactLandscape}
        tablet={isTablet}
        twoColumns={twoColumnList}
      >
        <WelcomeProfileRow
          dense
          rowHeight={hubMetrics.rowHeight}
          compact={compactLandscape}
          tablet={isTablet}
          showDivider
          expandable
          expanded={accountOpen}
          icon="person-outline"
          label={t('nickname', lang)}
          value={displayNick || t('enter_nick', lang)}
          largeValue
          onPress={openAccountEdit}
        />
        <WelcomeProfileRow
          dense
          rowHeight={hubMetrics.rowHeight}
          compact={compactLandscape}
          tablet={isTablet}
          icon="globe-outline"
          label={t('chooseLanguage', lang)}
          value={langLabel}
          onPress={openLanguage}
        />
      </WelcomeProfileSection>

      <WelcomeProfileSection
        dense
        compact={compactLandscape}
        tablet={isTablet}
        twoColumns={twoColumnList}
      >
        <WelcomeProfileRow
          dense
          rowHeight={hubMetrics.rowHeight}
          compact={compactLandscape}
          tablet={isTablet}
          showDivider
          icon="notifications-outline"
          label={t('welcomeNotifications', lang)}
          value={t('welcomeNotificationsHint', lang)}
          onPress={openNotificationsSettings}
        />
        <WelcomeProfileRow
          dense
          rowHeight={hubMetrics.rowHeight}
          compact={compactLandscape}
          tablet={isTablet}
          icon="lock-closed-outline"
          label={t('welcomePrivacy', lang)}
          onPress={openPrivacy}
        />
      </WelcomeProfileSection>

      <WelcomeProfileSection
        dense
        compact={compactLandscape}
        tablet={isTablet}
        twoColumns={twoColumnList}
      >
        <WelcomeProfileRow
          dense
          rowHeight={hubMetrics.rowHeight}
          compact={compactLandscape}
          tablet={isTablet}
          showDivider
          icon="image-outline"
          label={t('chatWallpaper', lang)}
          onPress={openChatWallpaper}
        />
        <WelcomeProfileRow
          dense
          rowHeight={hubMetrics.rowHeight}
          compact={compactLandscape}
          tablet={isTablet}
          icon="help-circle-outline"
          label={t('profileHelp', lang)}
          onPress={openHelp}
        />
      </WelcomeProfileSection>

      <WelcomeProfileSection
        dense
        compact={compactLandscape}
        tablet={isTablet}
        twoColumns={twoColumnList}
      >
        <WelcomeProfileRow
          dense
          rowHeight={hubMetrics.rowHeight}
          compact={compactLandscape}
          tablet={isTablet}
          showDivider
          icon="information-circle-outline"
          label={t('welcomeAboutApp', lang)}
          onPress={openAbout}
          badgeCount={updateAvailable ? 1 : 0}
        />
        <WelcomeProfileRow
          dense
          rowHeight={hubMetrics.rowHeight}
          compact={compactLandscape}
          tablet={isTablet}
          icon="heart-outline"
          label={t('supportProjectTitle', lang)}
          onPress={openSupport}
        />
      </WelcomeProfileSection>
    </View>
  );

  const hubScrollBody = accountOpen ? (
    <View>
      {hubAvatarSection}
      <View
        style={[
          styles.accountPanel,
          isTablet && styles.accountPanelTablet,
          compactLandscape && styles.accountPanelLandscape,
        ]}
      >
        <PaperInput
          value={nick ?? ''}
          onChangeText={setNick}
          mode="outlined"
          dense
          theme={{ roundness: 12 }}
          outlineStyle={{ borderWidth: 0, borderRadius: 12 }}
          style={styles.nickInput}
          contentStyle={styles.nickInputContent}
          textColor={LIVI.white}
          placeholder={t('nickname', lang)}
          placeholderTextColor={WELCOME_MUTED_TEXT}
          autoCorrect={false}
          autoCapitalize="none"
          editable={!busy}
        />
        <View style={styles.accountActions}>
          <Pressable onPress={onClearNick} disabled={busy || !displayNick} style={styles.accountSecondary}>
            <AdaptiveText style={styles.accountSecondaryText}>{t('deleteNick', lang)}</AdaptiveText>
          </Pressable>
          <Pressable
            onPress={() => {
              handleSaveProfile();
              closeAccountEdit();
            }}
            disabled={busy}
            style={[styles.accountSave, savedToast && styles.accountSaveDone]}
          >
            <AdaptiveText style={styles.accountSaveText}>{savedToast ? t('saved', lang) : t('save', lang)}</AdaptiveText>
          </Pressable>
        </View>
      </View>
      {hubListStack}
      {hubLogoutButton}
    </View>
  ) : needsHubScroll ? (
    <View>
      {hubAvatarSection}
      {hubListStack}
      {hubLogoutButton}
    </View>
  ) : (
    <View style={styles.hubMainBalance}>
      <View style={styles.hubMainTop}>{hubAvatarSection}</View>
      {hubListStack}
      {hubLogoutButton}
    </View>
  );

  const aboutBody = (
    <View style={styles.subScreenBlockOffset}>
      <WelcomeProfileSection compact={compactLandscape} tablet={isTablet}>
        <WelcomeProfileRow
          compact={compactLandscape}
          tablet={isTablet}
          icon="phone-portrait-outline"
          label={t('welcomeAppVersion', lang)}
          value={getCurrentAppVersion()}
          showChevron={false}
          showDivider={!!updateAvailable}
        />
        {updateAvailable ? (
          <WelcomeProfileRow
            compact={compactLandscape}
            tablet={isTablet}
            icon="cloud-download-outline"
            label={t('updateDownloadNew', lang)}
            onPress={openUpdate}
            badgeCount={1}
          />
        ) : null}
      </WelcomeProfileSection>
    </View>
  );

  const languageBody = (
    <WelcomeProfileSection compact={!isTablet} tablet={isTablet}>
      {languages.map((lng) => {
        const selected = normalizeLangCode(lang) === normalizeLangCode(lng.code);
        return (
          <WelcomeProfileLanguageRow
            key={lng.code}
            nativeName={lng.native}
            englishName={lng.name}
            selected={selected}
            rtl={lng.code === 'ar'}
            onPress={() => pickLang(lng.code)}
            compact={!isTablet}
            tablet={isTablet}
          />
        );
      })}
    </WelcomeProfileSection>
  );

  const helpBody = (
    <View style={styles.subScreenBlockOffset}>
      <WelcomeProfileSection compact={compactLandscape} tablet={isTablet}>
      <View style={styles.helpCardInner}>
        <AdaptiveText style={styles.helpMsg}>{t('profileHelpMessage', lang)}</AdaptiveText>
        <Pressable
          onPress={() => copyEmail(SUPPORT_EMAIL)}
          style={({ pressed }) => [styles.helpEmailRow, pressed && styles.helpEmailRowPressed]}
          accessibilityRole="button"
        >
          <AdaptiveText style={styles.helpEmailText}>{SUPPORT_EMAIL}</AdaptiveText>
          <AdaptiveText style={styles.helpEmailHint}>
            {copiedEmail === SUPPORT_EMAIL ? t('profileEmailCopied', lang) : t('profileCopyEmail', lang)}
          </AdaptiveText>
        </Pressable>
        <Pressable
          onPress={() => copyEmail(SUPPORT_EMAIL_2)}
          style={({ pressed }) => [styles.helpEmailRow, pressed && styles.helpEmailRowPressed]}
          accessibilityRole="button"
        >
          <AdaptiveText style={styles.helpEmailText}>{SUPPORT_EMAIL_2}</AdaptiveText>
          <AdaptiveText style={styles.helpEmailHint}>
            {copiedEmail === SUPPORT_EMAIL_2 ? t('profileEmailCopied', lang) : t('profileCopyEmail', lang)}
          </AdaptiveText>
        </Pressable>
      </View>
    </WelcomeProfileSection>
    </View>
  );

  const supportBody = (
    <View style={styles.subScreenBlockOffset}>
      <WelcomeProfileSection compact={compactLandscape} tablet={isTablet}>
      <View style={styles.supportHero}>
        <View style={styles.supportHeroIcon}>
          <Ionicons name="heart-outline" size={34} color={WELCOME_BRAND_VI_FILL_GRADIENT[1]} />
        </View>
        <AdaptiveText style={styles.supportHeroText}>{t('supportProjectSubtitle', lang)}</AdaptiveText>
      </View>
      <View style={styles.supportTiles}>
        <Pressable
          onPress={() => {
            void openBoosty();
          }}
          style={({ pressed }) => [styles.supportTile, pressed && styles.supportTilePressed]}
          accessibilityRole="button"
        >
          <View style={styles.supportTileLogoWrap}>
            <ExpoImage
              source={require('../../assets/boosty-sign-logo.png')}
              style={styles.supportTileLogo}
              contentFit="contain"
              cachePolicy="memory-disk"
            />
          </View>
          <View style={styles.supportTileText}>
            <AdaptiveText style={styles.supportTileTitle}>Boosty</AdaptiveText>
            <AdaptiveText style={styles.supportTileHint}>boosty.to</AdaptiveText>
          </View>
          <Ionicons name="chevron-forward" size={20} color={WELCOME_PROFILE_ROW_ICON} />
        </Pressable>
        <Pressable
          onPress={() => {
            void openPatreon();
          }}
          style={({ pressed }) => [styles.supportTile, pressed && styles.supportTilePressed]}
          accessibilityRole="button"
        >
          <View style={styles.supportTileLogoWrap}>
            <ExpoImage
              source={require('../../assets/patreon-sign-logo.png')}
              style={styles.supportTileLogo}
              contentFit="contain"
              cachePolicy="memory-disk"
            />
          </View>
          <View style={styles.supportTileText}>
            <AdaptiveText style={styles.supportTileTitle}>Patreon</AdaptiveText>
            <AdaptiveText style={styles.supportTileHint}>patreon.com</AdaptiveText>
          </View>
          <Ionicons name="chevron-forward" size={20} color={WELCOME_PROFILE_ROW_ICON} />
        </Pressable>
      </View>
    </WelcomeProfileSection>
    </View>
  );

  const subScreenBody =
    screen === 'about'
      ? aboutBody
      : screen === 'help'
        ? helpBody
        : screen === 'support'
          ? supportBody
          : languageBody;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
    >
      <View style={styles.rootInner}>
        {screen === 'hub' ? headerHub : headerSettings}

        {screen === 'hub' ? (
          <View style={styles.hubPane} onLayout={handleHubPaneLayout}>
            {needsHubScroll ? (
              <ScrollView
                style={styles.hubMainDock}
                contentContainerStyle={styles.hubMainDockScroll}
                scrollEnabled
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                bounces={false}
                overScrollMode="never"
              >
                {hubScrollBody}
              </ScrollView>
            ) : (
              <View style={[styles.hubMainDock, styles.hubMainDockClip]}>{hubScrollBody}</View>
            )}
          </View>
        ) : (
          <View style={styles.subScreenPane}>
            <ScrollView
              style={styles.subScreenScroll}
              contentContainerStyle={[
                styles.scrollContent,
                {
                  paddingBottom:
                    screen === 'language' ? 14 : 24 + insets.bottom,
                },
              ]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              onScrollBeginDrag={() => {
                if (accountOpen) closeAccountEdit();
              }}
            >
              {subScreenBody}
            </ScrollView>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, overflow: 'hidden' },
  rootInner: { flex: 1, minHeight: 0, overflow: 'hidden' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: Platform.OS === 'ios' ? 8 : 12,
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  headerLandscape: {
    paddingTop: 2,
    paddingBottom: 2,
  },
  headerTablet: {
    paddingTop: 14,
    paddingHorizontal: 28,
    paddingBottom: 10,
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 7 : 11,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  headerCenterLandscape: {
    paddingTop: 2,
    paddingBottom: 2,
  },
  headerCenterTablet: {
    paddingTop: 12,
    paddingHorizontal: 24,
    paddingBottom: 10,
  },
  headerBack: { marginRight: 4 },
  headerBackSpacer: { width: 40 },
  headerBackBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerBackBtnPressed: { opacity: 0.72 },
  title: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 28,
    fontWeight: '500',
    letterSpacing: -0.3,
    flex: 1,
  },
  titleLandscape: {
    fontSize: 22,
  },
  titleTablet: {
    fontSize: 30,
  },
  titleCenter: {
    flex: 1,
    textAlign: 'center',
    color: WELCOME_HEADER_TITLE,
    fontSize: 17,
    fontWeight: '600',
  },
  titleCenterLandscape: {
    fontSize: 15,
  },
  titleCenterTablet: {
    fontSize: 19,
  },
  scroll: { flex: 1 },
  subScreenPane: {
    flex: 1,
    minHeight: 0,
    justifyContent: 'flex-start',
  },
  subScreenScroll: {
    flexGrow: 0,
    flexShrink: 1,
    alignSelf: 'stretch',
    maxHeight: '100%',
  },
  hubPane: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  hubMainDock: {
    flex: 1,
    minHeight: 0,
  },
  hubMainDockClip: {
    overflow: 'hidden',
  },
  hubMainBalance: {
    flex: 1,
    minHeight: 0,
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  hubMainTop: {
    flexShrink: 0,
    width: '100%',
  },
  hubMainDockScroll: {
    flexGrow: 1,
    paddingBottom: 0,
  },
  scrollContent: { paddingTop: 4 },
  avatarBlock: { alignItems: 'center', marginBottom: 0, marginTop: 0 },
  hubListStack: {
    flexShrink: 0,
    width: '100%',
  },
  hubListStackTablet: {
    width: '100%',
    maxWidth: 1000,
    alignSelf: 'center',
    paddingHorizontal: 32,
  },
  hubListStackTwoColumns: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: WELCOME_FRIENDS_LIST_INSET,
  },
  hubListStackNickOpen: { marginTop: 8 },
  avatarWrap: { position: 'relative' },
  avatarRing: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: AVATAR_RING_WIDTH,
    borderColor: WELCOME_BRAND_VI_STROKE_GRADIENT[2],
    overflow: 'hidden',
  },
  cameraBtn: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: CAMERA_BTN_SIZE,
    height: CAMERA_BTN_SIZE,
    borderRadius: CAMERA_BTN_SIZE / 2,
    backgroundColor: '#12161c',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  accountPanel: {
    marginHorizontal: WELCOME_FRIENDS_LIST_INSET,
    marginTop: 10,
    marginBottom: 4,
    paddingHorizontal: 0,
    paddingVertical: 4,
  },
  accountPanelLandscape: {
    marginTop: 4,
    marginBottom: 2,
    paddingVertical: 2,
  },
  accountPanelTablet: {
    width: '92%',
    maxWidth: 900,
    alignSelf: 'center',
    marginHorizontal: 0,
    marginTop: 14,
    marginBottom: 8,
  },
  nickInput: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    marginBottom: 8,
    borderRadius: 12,
    overflow: 'hidden',
    height: 40,
    justifyContent: 'center',
  },
  nickInputContent: {
    paddingVertical: 0,
    marginVertical: 0,
    fontSize: 14,
    lineHeight: 18,
  },
  accountActions: { flexDirection: 'row', gap: 8 },
  accountSecondary: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  accountSecondaryText: { color: WELCOME_MUTED_TEXT, fontSize: 13 },
  accountSave: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 999,
    backgroundColor: 'rgba(42, 88, 104, 0.55)',
  },
  accountSaveDone: { backgroundColor: 'rgba(51, 139, 73, 0.25)' },
  accountSaveText: { color: LIVI.white, fontSize: 13, fontWeight: '600' },
  helpCardInner: {
    paddingVertical: 16,
    paddingHorizontal: 14,
  },
  helpMsg: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 14,
    lineHeight: 20,
  },
  helpEmailRow: {
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
  },
  helpEmailRowPressed: {
    opacity: 0.92,
  },
  helpEmailText: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 12,
    marginBottom: 4,
  },
  helpEmailHint: {
    color: WELCOME_SEGMENT_ACTIVE,
    fontSize: 11,
  },
  subScreenBlockOffset: {
    marginTop: 12,
  },
  supportHero: {
    alignItems: 'center',
    paddingTop: 22,
    paddingBottom: 4,
    paddingHorizontal: 20,
  },
  supportHeroIcon: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(59, 130, 246, 0.2)',
    marginBottom: 14,
  },
  supportHeroText: {
    textAlign: 'center',
    color: WELCOME_MUTED_TEXT,
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '400',
  },
  supportTiles: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 16,
    gap: 10,
  },
  supportTile: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
    gap: 12,
  },
  supportTilePressed: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  supportTileLogoWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  supportTileLogo: {
    width: 24,
    height: 24,
  },
  supportTileText: {
    flex: 1,
    minWidth: 0,
  },
  supportTileTitle: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 15,
    fontWeight: '500',
  },
  supportTileHint: {
    marginTop: 2,
    color: WELCOME_PROFILE_ROW_ICON,
    fontSize: 12,
    fontWeight: '400',
  },
  hubActions: {
    marginHorizontal: WELCOME_FRIENDS_LIST_INSET,
    paddingTop: 0,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logOutBtn: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 0,
    paddingHorizontal: 16,
  },
  logOutBtnLandscape: {
    paddingHorizontal: 12,
  },
  logOutBtnTablet: {
    paddingHorizontal: 20,
  },
  logOutBtnText: {
    color: '#A63A48',
    fontSize: 14,
    fontWeight: '600',
  },
  logOutBtnTextLandscape: {
    fontSize: 12,
  },
  logOutBtnTextTablet: {
    fontSize: 15,
  },
  hubBtnPressed: {
    opacity: 0.72,
  },
});

export const HomeWelcomeProfileView = memo(HomeWelcomeProfileViewInner);
