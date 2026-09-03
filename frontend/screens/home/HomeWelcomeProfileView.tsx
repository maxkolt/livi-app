import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  BackHandler,
  useWindowDimensions,
} from 'react-native';
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
  SEARCH_CTA_TABLET_MIN_WIDTH,
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
  WelcomeProfileRowDivider,
  WelcomeProfileSection,
  WelcomeProfileLanguageRow,
  WELCOME_PROFILE_ROW_ICON,
} from './WelcomeProfileListUi';
import type { HomeStyles } from './styles';

const SUPPORT_EMAIL = '12345kolt@gmal.com';
const BOOSTY_URL = process.env.EXPO_PUBLIC_BOOSTY_URL || 'https://boosty.to/liviapp/donate';
const PATREON_URL = process.env.EXPO_PUBLIC_PATREON_URL || 'https://www.patreon.com/c/LiViApp';
const AVATAR_RING_WIDTH = 2.5;
const CAMERA_BTN_SIZE = 38;
/** Зазор между низом списка и кнопкой «Удалить профиль». */
const HUB_LIST_ABOVE_DELETE_GAP = 10;
/** Симметричные отступы вокруг кнопки «Удалить профиль». */
const HUB_DELETE_EDGE_GAP = 12;
/** Строк hub-профиля (dense) — см. WelcomeProfileListUi. */
const PROFILE_HUB_ROW_DENSE = 47;
const PROFILE_HUB_ROW_COUNT = 8;
const PROFILE_HUB_SECTION_COUNT = 3;
const EST_DELETE_FOOTER_H = 58;

type HubLayoutTokens = {
  avatarSize: number;
  avatarMarginBottom: number;
  avatarPaddingTop: number;
  listGap: number;
  listMarginTop: number;
  cameraBtnSize: number;
};

const HUB_LAYOUT_PHONE: HubLayoutTokens = {
  avatarSize: 122,
  avatarMarginBottom: 6,
  avatarPaddingTop: 4,
  listGap: 11,
  listMarginTop: 0,
  cameraBtnSize: CAMERA_BTN_SIZE,
};

const HUB_LAYOUT_PHONE_COMPACT: HubLayoutTokens = {
  avatarSize: 116,
  avatarMarginBottom: 4,
  avatarPaddingTop: 2,
  listGap: 10,
  listMarginTop: 0,
  cameraBtnSize: CAMERA_BTN_SIZE,
};

const HUB_LAYOUT_TABLET: HubLayoutTokens = {
  avatarSize: 128,
  avatarMarginBottom: 8,
  avatarPaddingTop: 6,
  listGap: 12,
  listMarginTop: 0,
  cameraBtnSize: CAMERA_BTN_SIZE,
};

function estimateProfileHubBodyHeight(tokens: HubLayoutTokens): number {
  const avatarBlock =
    tokens.avatarPaddingTop + tokens.avatarSize + tokens.avatarMarginBottom + AVATAR_RING_WIDTH * 2;
  const listBlock =
    tokens.listMarginTop +
    PROFILE_HUB_ROW_COUNT * PROFILE_HUB_ROW_DENSE +
    (PROFILE_HUB_SECTION_COUNT - 1) * tokens.listGap;
  return avatarBlock + listBlock + HUB_LIST_ABOVE_DELETE_GAP;
}

function estimateProfileHubContentBudget(
  windowHeight: number,
  topInset: number,
  bottomInset: number,
): number {
  return Math.max(
    0,
    windowHeight -
      topInset -
      estimateProfileHeaderHeight() -
      estimateTabBarHeight(bottomInset) -
      EST_DELETE_FOOTER_H,
  );
}

/** Два пресета по высоте экрана — без подстройки под ширину/модель. */
function resolveHubLayoutFromWindow(
  windowHeight: number,
  topInset: number,
  bottomInset: number,
  isTablet: boolean,
): HubLayoutTokens {
  if (isTablet) return HUB_LAYOUT_TABLET;
  const budget = estimateProfileHubContentBudget(windowHeight, topInset, bottomInset);
  if (estimateProfileHubBodyHeight(HUB_LAYOUT_PHONE) <= budget) {
    return HUB_LAYOUT_PHONE;
  }
  return HUB_LAYOUT_PHONE_COMPACT;
}

function estimateTabBarHeight(bottomInset: number) {
  return 54 + Math.max(bottomInset, Platform.OS === 'android' ? 6 : 2);
}

function estimateProfileHeaderHeight() {
  return Platform.OS === 'ios' ? 54 : 58;
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
  } = props;

  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isTablet = Math.min(windowWidth, windowHeight) >= SEARCH_CTA_TABLET_MIN_WIDTH;
  const [screen, setScreen] = useState<ProfileScreen>('hub');
  const [accountOpen, setAccountOpen] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);

  const hubLayout = useMemo(
    () => resolveHubLayoutFromWindow(windowHeight, insets.top, insets.bottom, isTablet),
    [windowHeight, insets.top, insets.bottom, isTablet],
  );

  /** Скролл только при открытом редактировании ника (клавиатура). */
  const needsHubScroll = accountOpen;

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

  const noop = useCallback(() => {}, []);

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
      return false;
    });

    return () => sub.remove();
  }, [
    wallpaperPickerTheme,
    screen,
    accountOpen,
    setWallpaperPickerTheme,
    goHub,
    closeAccountEdit,
  ]);

  const avatarSize = hubLayout.avatarSize;
  const cameraBtnSize = hubLayout.cameraBtnSize;

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
          <Text style={{ color: LIVI.titan, fontSize: avatarSize > 110 ? 34 : 28, fontWeight: '500' }}>{letter}</Text>
        </View>
      )}
    </View>
  );

  const closeWallpaperPicker = useCallback(() => {
    setWallpaperPickerTheme(null);
  }, [setWallpaperPickerTheme]);

  const headerWallpaper = (
    <View style={styles.headerCenter}>
      <Pressable
        style={({ pressed }) => [styles.headerBackBtn, styles.headerBack, pressed && styles.headerBackBtnPressed]}
        onPress={closeWallpaperPicker}
        accessibilityRole="button"
        accessibilityLabel={t('cancelAction', lang)}
      >
        <Ionicons name="chevron-back" size={22} color={LIVI.white} />
      </Pressable>
      <Text style={styles.titleCenter} numberOfLines={2}>
        {t('chatWallpaperMessages', lang)}
      </Text>
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
    <View style={styles.header}>
      <Text style={styles.title}>{t('tabSettings', lang)}</Text>
      <WelcomeCrownButton onPress={noop} />
    </View>
  );

  const headerSettings = (
    <View style={styles.headerCenter}>
      <Pressable
        style={({ pressed }) => [styles.headerBackBtn, styles.headerBack, pressed && styles.headerBackBtnPressed]}
        onPress={handleSubBack}
        accessibilityRole="button"
        accessibilityLabel={t('cancelAction', lang)}
      >
        <Ionicons name="chevron-back" size={22} color={LIVI.white} />
      </Pressable>
      <Text style={styles.titleCenter}>{subScreenTitle}</Text>
      <View style={styles.headerBackSpacer} />
    </View>
  );

  const hubLogoutButton = (
    <View style={styles.hubActions}>
      <Pressable
        style={({ pressed }) => [styles.logOutBtn, pressed && styles.hubBtnPressed]}
        onPress={() => onLogOutAccount?.()}
        disabled={busy || !onLogOutAccount}
        accessibilityRole="button"
      >
        <Text style={styles.logOutBtnText}>{t('welcomeDeleteProfile', lang)}</Text>
      </Pressable>
    </View>
  );

  const hubAvatarSection = (
    <View
      style={[
        styles.avatarBlock,
        {
          marginBottom: accountOpen ? hubLayout.avatarMarginBottom : 0,
          paddingTop: hubLayout.avatarPaddingTop,
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
        { gap: hubLayout.listGap },
        !accountOpen && styles.hubListStackLower,
        accountOpen && styles.hubListStackNickOpen,
      ]}
    >
      <WelcomeProfileSection dense>
        <WelcomeProfileRow
          dense
          expandable
          expanded={accountOpen}
          icon="person-outline"
          label={t('nickname', lang)}
          value={displayNick || t('enter_nick', lang)}
          largeValue
          onPress={openAccountEdit}
        />
        <WelcomeProfileRowDivider />
        <WelcomeProfileRow
          dense
          icon="globe-outline"
          label={t('chooseLanguage', lang)}
          value={langLabel}
          onPress={openLanguage}
        />
        <WelcomeProfileRowDivider />
        <WelcomeProfileRow
          dense
          icon="notifications-outline"
          label={t('welcomeNotifications', lang)}
          value={t('welcomeNotificationsHint', lang)}
          onPress={openNotificationsSettings}
        />
      </WelcomeProfileSection>

      <WelcomeProfileSection dense>
        <WelcomeProfileRow
          dense
          icon="lock-closed-outline"
          label={t('welcomePrivacy', lang)}
          onPress={openPrivacy}
        />
        <WelcomeProfileRowDivider />
        <WelcomeProfileRow
          dense
          icon="image-outline"
          label={t('chatWallpaper', lang)}
          onPress={openChatWallpaper}
        />
      </WelcomeProfileSection>

      <WelcomeProfileSection dense>
        <WelcomeProfileRow
          dense
          icon="help-circle-outline"
          label={t('profileHelp', lang)}
          onPress={openHelp}
        />
        <WelcomeProfileRowDivider />
        <WelcomeProfileRow
          dense
          icon="information-circle-outline"
          label={t('welcomeAboutApp', lang)}
          onPress={openAbout}
          badgeCount={updateAvailable ? 1 : 0}
        />
        <WelcomeProfileRowDivider />
        <WelcomeProfileRow
          dense
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
      <View style={styles.accountPanel}>
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
            <Text style={styles.accountSecondaryText}>{t('deleteNick', lang)}</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              handleSaveProfile();
              closeAccountEdit();
            }}
            disabled={busy}
            style={[styles.accountSave, savedToast && styles.accountSaveDone]}
          >
            <Text style={styles.accountSaveText}>{savedToast ? t('saved', lang) : t('save', lang)}</Text>
          </Pressable>
        </View>
      </View>
      {hubListStack}
    </View>
  ) : (
    <View style={styles.hubMainBalance}>
      <View style={styles.hubMainTop}>{hubAvatarSection}</View>
      {hubListStack}
    </View>
  );

  const aboutBody = (
    <View style={styles.subScreenBlockOffset}>
      <WelcomeProfileSection>
      <WelcomeProfileRow
        icon="phone-portrait-outline"
        label={t('welcomeAppVersion', lang)}
        value={getCurrentAppVersion()}
        showChevron={false}
      />
      {updateAvailable ? (
        <>
          <WelcomeProfileRowDivider />
          <WelcomeProfileRow
            icon="cloud-download-outline"
            label={t('updateDownloadNew', lang)}
            onPress={openUpdate}
            badgeCount={1}
          />
        </>
      ) : null}
    </WelcomeProfileSection>
    </View>
  );

  const languageBody = (
    <WelcomeProfileSection compact>
      {languages.map((lng, idx) => {
        const selected = normalizeLangCode(lang) === normalizeLangCode(lng.code);
        return (
          <React.Fragment key={lng.code}>
            {idx > 0 ? <WelcomeProfileRowDivider /> : null}
            <WelcomeProfileLanguageRow
              nativeName={lng.native}
              englishName={lng.name}
              selected={selected}
              rtl={lng.code === 'ar'}
              onPress={() => pickLang(lng.code)}
            />
          </React.Fragment>
        );
      })}
    </WelcomeProfileSection>
  );

  const helpBody = (
    <View style={styles.subScreenBlockOffset}>
      <WelcomeProfileSection>
      <View style={styles.helpCardInner}>
        <Text style={styles.helpMsg}>{t('profileHelpMessage', lang)}</Text>
        <Pressable
          onPress={() => copyEmail(SUPPORT_EMAIL)}
          style={({ pressed }) => [styles.helpEmailRow, pressed && styles.helpEmailRowPressed]}
          accessibilityRole="button"
        >
          <Text style={styles.helpEmailText}>{SUPPORT_EMAIL}</Text>
          <Text style={styles.helpEmailHint}>
            {copiedEmail === SUPPORT_EMAIL ? t('profileEmailCopied', lang) : t('profileCopyEmail', lang)}
          </Text>
        </Pressable>
      </View>
    </WelcomeProfileSection>
    </View>
  );

  const supportBody = (
    <View style={styles.subScreenBlockOffset}>
      <WelcomeProfileSection>
      <View style={styles.supportHero}>
        <View style={styles.supportHeroIcon}>
          <Ionicons name="heart-outline" size={22} color={WELCOME_BRAND_VI_FILL_GRADIENT[1]} />
        </View>
        <Text style={styles.supportHeroText}>{t('supportProjectSubtitle', lang)}</Text>
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
            <Text style={styles.supportTileTitle}>Boosty</Text>
            <Text style={styles.supportTileHint}>boosty.to</Text>
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
            <Text style={styles.supportTileTitle}>Patreon</Text>
            <Text style={styles.supportTileHint}>patreon.com</Text>
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
          <View style={styles.hubPane}>
            {needsHubScroll ? (
              <ScrollView
                style={styles.hubMainDock}
                contentContainerStyle={styles.hubMainDockScroll}
                scrollEnabled
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
            {hubLogoutButton}
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
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 7 : 11,
    paddingHorizontal: 12,
    paddingBottom: 8,
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
  titleCenter: {
    flex: 1,
    textAlign: 'center',
    color: WELCOME_HEADER_TITLE,
    fontSize: 17,
    fontWeight: '600',
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
    paddingBottom: HUB_LIST_ABOVE_DELETE_GAP,
  },
  hubMainTop: {
    flexShrink: 0,
    width: '100%',
  },
  hubMainDockScroll: {
    flexGrow: 0,
    paddingBottom: 0,
  },
  scrollContent: { paddingTop: 4 },
  avatarBlock: { alignItems: 'center', marginBottom: 8, marginTop: 0 },
  hubListStack: { gap: 12 },
  hubListStackLower: { marginTop: 12 },
  hubListStackNickOpen: { marginTop: 0 },
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
    padding: 10,
    borderRadius: 14,
    backgroundColor: 'rgba(22, 27, 34, 0.58)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.06)',
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
    fontSize: 15,
    marginBottom: 6,
  },
  helpEmailHint: {
    color: WELCOME_SEGMENT_ACTIVE,
    fontSize: 13,
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
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(59, 130, 246, 0.2)',
    marginBottom: 12,
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
    paddingTop: HUB_DELETE_EDGE_GAP,
    paddingBottom: HUB_DELETE_EDGE_GAP,
    flexShrink: 0,
    alignItems: 'center',
  },
  logOutBtn: {
    alignSelf: 'center',
    width: '88%',
    maxWidth: 340,
    paddingVertical: 11,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 90, 103, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255, 90, 103, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logOutBtnText: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 15,
    fontWeight: '600',
  },
  hubBtnPressed: {
    opacity: 0.88,
    transform: [{ scale: 0.99 }],
  },
});

export const HomeWelcomeProfileView = memo(HomeWelcomeProfileViewInner);
