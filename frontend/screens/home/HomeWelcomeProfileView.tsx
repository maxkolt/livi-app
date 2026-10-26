import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Animated,
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
import { usePaneReveal } from '../../utils/paneVisibility';
import AdaptiveText from '../../components/AdaptiveText';
import { useStableSafeAreaInsets } from './useStableSafeAreaInsets';
import { FontAwesome, Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import * as Clipboard from 'expo-clipboard';
import AvatarImage, { activeFrameOutset } from '../../components/AvatarImage';
import { AvatarGlyph } from '../../components/AvatarGlyph';
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
import { useUserActiveFrame } from '../../utils/cosmetics';
import { PurchasesManagementPanel } from './PurchasesManagementPanel';
import {
  LIVI,
  isWelcomeTabletLayout,
  searchPhoneScale,
  welcomePhoneAvatarMetrics,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_GLASS_BORDER,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
  UI_ACCENT,
  UI_ACCENT_SOFT,
  UI_SURFACE,
} from './constants';
import { WELCOME_SEGMENT_ACTIVE } from './FriendsListCore';
import { displayAvatarLetter, displayName } from './friendHelpers';
import { hasProfilePhoto } from './HomeCenterProfile';
import {
  WelcomeProfileRow,
  WelcomeProfileSection,
  WelcomeProfileLanguageRow,
  WELCOME_PROFILE_ROW_ICON,
  WELCOME_PROFILE_ROW_LABEL_FONT_SIZE,
  WELCOME_PROFILE_ROW_LABEL_FONT_SIZE_COMPACT,
  WELCOME_PROFILE_ROW_LABEL_FONT_SIZE_TABLET,
} from './WelcomeProfileListUi';
import type { HomeStyles } from './styles';
import { GLASS_DOCK_TOP_PAD } from './WelcomeGlassHeader';
import { APP_INPUT_MAX_FONT_SIZE_MULTIPLIER } from '../../utils/accessibilityTypography';
import {
  isCallKeepAliveSupported,
  useCallKeepAliveState,
  type CallKeepAliveStatus,
} from '../../utils/callKeepAlive';

const SUPPORT_EMAIL = '12345kolt@gmail.com';
const SUPPORT_EMAIL_2 = 'kolt12max@mail.ru';
const SUPPORT_TELEGRAM_URL = 'https://t.me/livi_app';
const CAMERA_BTN_SIZE = 32;
/** Урна на аватаре чуть внутрь от угла — ближе к самому кругу, а не в пустом углу. */
const CAMERA_BTN_INSET = 7;
/** Красный «удалить» строки «Удалить профиль». */
const WELCOME_DELETE_ICON = '#A63A48';
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
  rowMax: number;
  rowMin: number;
  gapMax: number;
  gapMin: number;
};

const HUB_PRESET_PHONE: HubMetricsPreset = {
  avatarSize: 108,
  cameraBtnSize: CAMERA_BTN_SIZE,
  gapTop: 24,
  gapUnderAvatar: 14,
  rowMax: 48,
  rowMin: 40,
  gapMax: 12,
  gapMin: 6,
};

const HUB_PRESET_PHONE_LANDSCAPE: HubMetricsPreset = {
  // Аватар и кнопка камеры — как в вертикали (avatarSize заменяет phoneAvatarSize()).
  avatarSize: 108,
  cameraBtnSize: CAMERA_BTN_SIZE,
  // Не отрицательный: шапки в landscape нет, и аватар уходил под строку состояния.
  gapTop: 2,
  // Минимумы ниже, чем в вертикали: аватар тут того же размера, и при строках 30 dp
  // «Удалить профиль» не влезал на 5–10 dp — список уходил в скролл. Строки ужимаются
  // ровно настолько, насколько нужно, скролл — только для совсем низких экранов.
  gapUnderAvatar: 8,
  rowMax: 42,
  rowMin: 26,
  gapMax: 8,
  gapMin: 4,
};

const HUB_PRESET_TABLET: HubMetricsPreset = {
  avatarSize: 132,
  cameraBtnSize: 34,
  // Прирост аватара (+8) съеден из отступов — карточки на месте.
  gapTop: 22,
  gapUnderAvatar: 16,
  rowMax: 56,
  rowMin: 48,
  gapMax: 16,
  gapMin: 10,
};

const HUB_PRESET_TABLET_LANDSCAPE: HubMetricsPreset = {
  avatarSize: 110,
  cameraBtnSize: CAMERA_BTN_SIZE,
  gapTop: 11,
  gapUnderAvatar: 11,
  rowMax: 54,
  rowMin: 44,
  gapMax: 14,
  gapMin: 8,
};

const PROFILE_HUB_SECTION_COUNT = 4;

/** Ниже этого отступ «шапка → аватар» не ужимаем, даже если строкам тесно. */
const HUB_GAP_TOP_MIN = 6;

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

/**
 * Аватар профиля чуть меньше радара на Поиске — в обеих ориентациях один диаметр
 * фото. Купленная рамка рисуется снаружи и не меняет раскладку экрана.
 * Визуально чуть крупнее прежних 0.9; прирост компенсируется отступами (см. ниже).
 */
const PROFILE_AVATAR_SCALE = 0.96;
/** Прежний эталон слота — от него считаем, сколько px отнять у gapTop / gapUnderAvatar. */
const PROFILE_AVATAR_SLOT_SCALE = 0.9;
/** Сдвиг аватара вниз: +gapTop / −gapUnderAvatar — карточки не двигаются. */
const PROFILE_AVATAR_NUDGE_DOWN = 6;

function phoneAvatarSize(shortSide: number): number {
  return Math.round(welcomePhoneAvatarMetrics(shortSide).outer * PROFILE_AVATAR_SCALE);
}

function phoneAvatarSlotSize(shortSide: number): number {
  return Math.round(welcomePhoneAvatarMetrics(shortSide).outer * PROFILE_AVATAR_SLOT_SCALE);
}

/** Предел масштаба строк: дальше экран уже не телефон, а «лопата». */
const PHONE_HUB_MAX_SCALE = 1.25;

/**
 * На широком телефоне строки и отступы растут вместе с аватаром — как на Поиске.
 * Минимумы не трогаем: они нужны, чтобы на низком экране список ужимался.
 */
function scaleHubPreset(preset: HubMetricsPreset, k: number): HubMetricsPreset {
  if (!(k > 1)) return preset;
  const r = (v: number) => Math.round(v * k);
  return {
    ...preset,
    gapTop: r(preset.gapTop),
    gapUnderAvatar: r(preset.gapUnderAvatar),
    rowMax: r(preset.rowMax),
    gapMax: r(preset.gapMax),
  };
}

function resolveHubMetrics(
  paneHeight: number,
  /** Короткая сторона окна — ширина телефона в вертикали, от поворота не зависит. */
  shortSide: number,
  isTablet: boolean,
  isLandscape: boolean,
  twoColumns: boolean,
  frameId: string,
): HubMetrics {
  const basePreset = resolveHubPreset(isTablet, isLandscape);
  const preset = (() => {
    const nudgeDown = (p: HubMetricsPreset): HubMetricsPreset => {
      // Берём только то, что реально есть снизу — иначе сумма отступов вырастет и сдвинет список.
      const take = Math.min(PROFILE_AVATAR_NUDGE_DOWN, Math.max(0, p.gapUnderAvatar - 4));
      return { ...p, gapTop: p.gapTop + take, gapUnderAvatar: p.gapUnderAvatar - take };
    };
    if (isTablet) return nudgeDown(basePreset);
    const visual = phoneAvatarSize(shortSide);
    const grow = Math.max(0, visual - phoneAvatarSlotSize(shortSide));
    // Крупнее аватар без сдвига карточек: прирост диаметра уходит в отступы вокруг него.
    // Пол gapTop — не выше текущего (в landscape он уже 2 < HUB_GAP_TOP_MIN).
    const gapTopFloor = Math.min(basePreset.gapTop, HUB_GAP_TOP_MIN);
    const phoneBase: HubMetricsPreset = nudgeDown({
      ...basePreset,
      avatarSize: visual,
      gapTop: Math.max(gapTopFloor, basePreset.gapTop - Math.ceil(grow / 2)),
      gapUnderAvatar: Math.max(4, basePreset.gapUnderAvatar - Math.floor(grow / 2)),
    });
    if (isLandscape) return phoneBase;
    return scaleHubPreset(phoneBase, Math.min(PHONE_HUB_MAX_SCALE, searchPhoneScale(shortSide)));
  })();
  // Кольцо купленной рамки входит в высоту блока аватара (avatarRing = фото + вынос × 2).
  const frameOutset = frameId ? activeFrameOutset(preset.avatarSize, frameId) : 0;
  const fixedNoTop =
    preset.avatarSize +
    frameOutset * 2 +
    preset.gapUnderAvatar +
    // Стекло навбара выше панели на GLASS_DOCK_TOP_PAD — иначе оно съедает нижний зазор.
    GLASS_DOCK_TOP_PAD;
  // «Удалить профиль» — такая же строка высотой rowHeight. Раньше на неё закладывали
  // фиксированные 20–40 dp при реальных 40–48, и в landscape она уезжала под таб-бар.
  const rows = hubRowsPerColumn(twoColumns) + 1;
  // Промежутки между рядами секций, перед «Удалить профиль» и такой же — до навбара.
  const gaps = hubSectionRows(twoColumns) + 1;
  const maxTotal = rows * preset.rowMax + gaps * preset.gapMax;
  const minTotal = rows * preset.rowMin + gaps * preset.gapMin;
  if (!(paneHeight > 0)) {
    return { ...preset, rowHeight: preset.rowMax, listGap: preset.gapMax, scroll: false };
  }
  // Не хватает места — сперва поднимаем контент (ужимаем отступ над аватаром),
  // и только потом сжимаем строки: зазор до навбара должен оставаться как между блоками.
  const gapTopFloor = Math.min(preset.gapTop, HUB_GAP_TOP_MIN);
  const shortage = Math.max(0, fixedNoTop + preset.gapTop + maxTotal - paneHeight);
  const gapTop = Math.max(gapTopFloor, preset.gapTop - shortage);
  const listBudget = Math.max(0, paneHeight - fixedNoTop - gapTop);

  if (listBudget >= maxTotal) {
    return { ...preset, gapTop, rowHeight: preset.rowMax, listGap: preset.gapMax, scroll: false };
  }
  if (listBudget <= minTotal) {
    return { ...preset, gapTop, rowHeight: preset.rowMin, listGap: preset.gapMin, scroll: true };
  }
  const t = (listBudget - minTotal) / (maxTotal - minTotal);
  // Вниз, а не к ближайшему: округление вверх снова съело бы отступы.
  const rowHeight = Math.floor(preset.rowMin + (preset.rowMax - preset.rowMin) * t);
  // Остаток от округления строк — в промежутки, иначе он копился под «Удалить профиль»
  // и зазор до навбара выходил больше, чем между карточками.
  const listGap = Math.min(
    preset.gapMax,
    Math.max(preset.gapMin, Math.floor(((listBudget - rows * rowHeight) / gaps) * 10) / 10),
  );
  return { ...preset, gapTop, rowHeight, listGap, scroll: false };
}

function estimateTabBarHeight(bottomInset: number, isTablet: boolean, isLandscape: boolean) {
  // Совпадает с minHeight строки таб-бара в HomeWelcomeTabBar.
  const base = isTablet ? 60 : isLandscape ? 40 : 52;
  const floatGap = isLandscape && !isTablet ? 6 : isTablet ? 12 : 16;
  return base + Math.max(bottomInset, Platform.OS === 'android' ? 6 : 2) + floatGap;
}

/** Небольшая шапка без короны — контент не прилипает к верху. */
function estimateProfileHeaderHeight(isTablet: boolean, isLandscape: boolean) {
  if (isLandscape && !isTablet) return 4;
  if (isTablet) return isLandscape ? 8 : 12;
  return Platform.OS === 'ios' ? 10 : 12;
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


const RELIABILITY_STATUS_KEY: Record<CallKeepAliveStatus, string> = {
  off: 'callReliabilityStatusOff',
  connecting: 'callReliabilityStatusConnecting',
  connected: 'callReliabilityStatusConnected',
  waiting_network: 'callReliabilityStatusWaitingNetwork',
  no_account: 'callReliabilityStatusNoAccount',
};

/** Точка состояния: акцент — соединение есть, приглушённый янтарь — ждём, серый — выключено. */
const RELIABILITY_STATUS_COLOR: Record<CallKeepAliveStatus, string> = {
  off: WELCOME_PROFILE_ROW_ICON,
  connecting: '#B99A5E',
  connected: UI_ACCENT,
  waiting_network: '#B99A5E',
  no_account: WELCOME_PROFILE_ROW_ICON,
};

const RELIABILITY_HOW_ITEMS: Array<{ key: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { key: 'callReliabilityHowPrimary', icon: 'notifications-outline' },
  { key: 'callReliabilityHowReconnect', icon: 'swap-horizontal-outline' },
  { key: 'callReliabilityHowNoDuplicates', icon: 'checkmark-done-outline' },
];

const SWITCH_WIDTH = 46;
const SWITCH_HEIGHT = 28;
const SWITCH_THUMB = 22;
const SWITCH_TRAVEL = SWITCH_WIDTH - SWITCH_THUMB - 6;

/** Переключатель в палитре приложения: мягкий акцент вместо яркой заливки. */
function ReliabilitySwitch({ value }: { value: boolean }) {
  const progress = React.useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: value ? 1 : 0,
      duration: 160,
      useNativeDriver: true,
    }).start();
  }, [progress, value]);
  return (
    <View style={[styles.switchTrack, value && styles.switchTrackOn]}>
      <Animated.View
        style={[
          styles.switchThumb,
          value && styles.switchThumbOn,
          { transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, SWITCH_TRAVEL] }) }] },
        ]}
      />
    </View>
  );
}

type ProfileScreen = 'hub' | 'about' | 'language' | 'help' | 'callReliability' | 'purchases';

type HomeWelcomeProfileViewProps = {
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
  /** Урна на аватаре: спросить и удалить фото. */
  onDeleteAvatar?: () => void;
  handleSaveProfile: () => void;
  saving?: boolean;
  savedToast?: boolean;
  setSavedToast?: (show: boolean) => void;
  onSelectLang: (code: Lang) => void;
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
    onDeleteAvatar,
    handleSaveProfile,
    saving,
    savedToast,
    setSavedToast,
    onSelectLang,
    onLogOutAccount,
    wiping,
    updateAvailable,
    onBackFromHub,
    active = true,
  } = props;

  const insets = useStableSafeAreaInsets();
  // Скрытая вкладка строит хаб по частям: аватар, список, выход (см. usePaneReveal).
  const hubStage = usePaneReveal(3);
  // Размер берём из safe-area frame: он приходит от нативного провайдера и
  // обновляется при повороте, в отличие от Dimensions.
  const { width: windowWidth, height: windowHeight } = useHomeLayout();
  const isLandscape =
    windowWidth > 0 && windowHeight > 0 && windowWidth / windowHeight > 1.05;
  const isTablet = isWelcomeTabletLayout(windowWidth, windowHeight);
  const compactLandscape = isLandscape && !isTablet;
  const [screen, setScreen] = useState<ProfileScreen>('hub');
  const callKeepAlive = useCallKeepAliveState(active);
  const [accountOpen, setAccountOpen] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);
  const hubOrientationKey = isLandscape ? 'landscape' : 'portrait';
  // Замер панели — отдельно на портрет/landscape: иначе после поворота ещё
  // кадр живёт высота прошлой ориентации, блоки прыгают, а огненная рамка
  // пересоздаётся и появляется позже аватара.
  const [hubViewportByOrientation, setHubViewportByOrientation] = useState<{
    portrait?: number;
    landscape?: number;
  }>({});

  /** В landscape одна колонка секций не помещается по высоте — раскладываем в две. */
  const twoColumnList = isLandscape;

  /**
   * Высоту берём из onLayout самой панели: она уже учитывает шапку, таб-бар и
   * системные insets, поэтому отступы не зависят от оценок.
   */
  const expectedHubPaneHeight = estimateHubPaneHeight(
    windowHeight,
    insets.top,
    insets.bottom,
    isTablet,
    isLandscape,
  );
  const measuredHubPaneHeight = hubViewportByOrientation[hubOrientationKey] ?? 0;
  /** Промежуточный замер при повороте/пробуждении отбрасываем — иначе он застревает. */
  const hubPaneHeight =
    measuredHubPaneHeight > expectedHubPaneHeight * 0.6
      ? measuredHubPaneHeight
      : expectedHubPaneHeight;

  const myUserId = getCurrentUserId();
  const activeFrameId = useUserActiveFrame(myUserId);

  const hubMetrics = useMemo(
    () =>
      resolveHubMetrics(
        hubPaneHeight,
        Math.min(windowWidth, windowHeight),
        isTablet,
        isLandscape,
        twoColumnList,
        activeFrameId,
      ),
    [hubPaneHeight, windowWidth, windowHeight, isTablet, isLandscape, twoColumnList, activeFrameId],
  );

  /** Скролл при редактировании ника или когда даже минимальные строки не влезают. */
  const needsHubScroll = accountOpen || hubMetrics.scroll;
  /**
   * В landscape аватар скроллится вместе со списком, но дойдя до верха прилипает
   * и дальше рисуется поверх карточек — так он виден всегда и не уезжает под
   * верхний блок. При редактировании ника раскладка другая: панель ввода идёт
   * следом за аватаром и должна ехать вместе с ним.
   */
  const stickyAvatarOnScroll = isLandscape && !accountOpen;

  const handleHubPaneLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextHeight = event.nativeEvent.layout.height;
      if (!(nextHeight > 0)) return;
      setHubViewportByOrientation((prev) => {
        const current = prev[hubOrientationKey];
        if (current != null && Math.abs(current - nextHeight) < 1) return prev;
        return { ...prev, [hubOrientationKey]: nextHeight };
      });
    },
    [hubOrientationKey],
  );

  const hasActiveFrame = !!activeFrameId;
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
    if (screen === 'callReliability') return t('callReliabilityTitle', lang);
    if (screen === 'purchases') return t('purchasesManagement', lang);
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

  const openTelegram = useCallback(() => {
    Linking.openURL(SUPPORT_TELEGRAM_URL).catch(() => {});
  }, []);

  const openPurchases = useCallback(() => {
    setScreen('purchases');
  }, []);

  const openCallReliability = useCallback(() => {
    setAccountOpen(false);
    setScreen('callReliability');
  }, []);

  const reliabilityState = callKeepAlive.state;
  const reliabilityEnabled = !!reliabilityState?.enabled;
  const setReliabilityEnabled = callKeepAlive.setEnabled;
  const toggleReliability = useCallback(() => {
    void setReliabilityEnabled(!reliabilityEnabled);
  }, [setReliabilityEnabled, reliabilityEnabled]);

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

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!active) return;

    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
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
    screen,
    goHub,
    accountOpen,
    closeAccountEdit,
    onBackFromHub,
  ]);

  const avatarSize = hubMetrics.avatarSize;
  const avatarFrameOutset = activeFrameId ? activeFrameOutset(avatarSize, activeFrameId) : 0;
  const avatarFrameSize = Math.round(avatarSize) + avatarFrameOutset * 2;
  // Layout всегда равен диаметру фото. Огонь/металл выступают наружу визуально.
  const avatarContainerSize = avatarSize;
  const cameraBtnSize = hubMetrics.cameraBtnSize;
  const hasLocalAvatarPreview = avatarUri && /^(file|content|ph|assets-library):\/\//i.test(avatarUri);
  /** Урну показываем, только когда есть что удалять. */
  const hasAvatarPhoto = !!hasLocalAvatarPreview || hasProfilePhoto(avatarUri, myAvatarVer);
  // Только что выбранное фото идёт мимо AvatarImage.
  const localPreviewPhoto = !(myUserId && hasActiveFrame) && hasLocalAvatarPreview ? avatarUri : '';

  const avatarInner = (
    <View
      style={[
        homeStyles.centerAvatarWrap,
        {
          width: avatarContainerSize,
          height: avatarContainerSize,
          borderRadius: avatarContainerSize / 2,
          backgroundColor: menuChromeBg,
          overflow: activeFrameId ? 'visible' : 'hidden',
        },
      ]}
    >
      {myUserId && hasActiveFrame ? (
        <AvatarImage
          key="avatar-framed"
          userId={myUserId}
          avatarVer={myAvatarVer}
          uri={hasLocalAvatarPreview ? avatarUri : myFullAvatarUri || undefined}
          size={avatarSize}
          frameSize={avatarFrameSize}
          frameId={activeFrameId}
          fallbackText={letter}
          containerStyle={homeStyles.centerAvatarImg}
          fallbackTextStyle={{ fontSize: avatarSize > 110 ? 34 : 28, fontWeight: '800' }}
        />
      ) : hasLocalAvatarPreview ? (
        localPreviewPhoto ? (
          <ExpoImage source={{ uri: localPreviewPhoto }} style={homeStyles.centerAvatarImg} cachePolicy="memory-disk" />
        ) : null
      ) : myUserId && myAvatarVer > 0 ? (
        <AvatarImage
          key="avatar-plain"
          userId={myUserId}
          avatarVer={myAvatarVer}
          uri={myFullAvatarUri || undefined}
          size={avatarContainerSize}
          frameId={activeFrameId || null}
          fallbackText={letter}
          containerStyle={homeStyles.centerAvatarImg}
          fallbackTextStyle={{ fontSize: avatarSize > 110 ? 34 : 28, fontWeight: '800' }}
        />
      ) : (
        <View style={[homeStyles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]}>
          <AvatarGlyph style={{ color: LIVI.titan, fontSize: avatarSize > 110 ? 34 : 28, fontWeight: '500' }}>{letter}</AvatarGlyph>
        </View>
      )}
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
        numberOfLines={1}
      >
        {subScreenTitle}
      </AdaptiveText>
      <View style={styles.headerBackSpacer} />
    </View>
  );

  const hubLogoutButton = hubStage < 3 ? null : (
    <View
      style={[
        styles.hubActions,
        { paddingBottom: hubMetrics.listGap + GLASS_DOCK_TOP_PAD },
      ]}
    >
      <WelcomeProfileSection
        dense
        compact={compactLandscape}
        tablet={isTablet}
      >
        <Pressable
          style={({ pressed }) => [
            styles.logOutRow,
            isTablet && styles.logOutRowTablet,
            compactLandscape && styles.logOutRowLandscape,
            isLandscape && styles.logOutRowCentered,
            // Как у строк списка: высоту задаёт rowHeight, без своих вертикальных отступов —
            // иначе строка выходила выше расчётной и низом уезжала под таб-бар.
            hubMetrics.rowHeight != null
              ? { minHeight: hubMetrics.rowHeight, paddingVertical: 0 }
              : null,
            pressed && styles.logOutRowPressed,
          ]}
          onPress={() => onLogOutAccount?.()}
          disabled={busy || !onLogOutAccount}
          accessibilityRole="button"
        >
          <Ionicons
            name="trash-outline"
            size={isTablet ? 22 : compactLandscape ? 18 : 20}
            color={WELCOME_DELETE_ICON}
          />
          <AdaptiveText
            style={[
              styles.logOutBtnText,
              isTablet && styles.logOutBtnTextTablet,
              compactLandscape && styles.logOutBtnTextLandscape,
            ]}
            numberOfLines={1}
            fit={false}
          >
            {t('welcomeDeleteProfile', lang)}
          </AdaptiveText>
        </Pressable>
      </WelcomeProfileSection>
    </View>
  );

  const hubAvatarBody = (
      <View style={styles.avatarWrap}>
        <Pressable
          onPress={() => openAvatarSheet?.()}
          disabled={busy}
          style={[
            styles.avatarRing,
            {
              width: avatarFrameSize,
              height: avatarFrameSize,
              borderRadius: avatarFrameSize / 2,
            },
          ]}
        >
          {avatarInner}
        </Pressable>
        {hasAvatarPhoto && onDeleteAvatar ? (
          <Pressable
            style={[
              styles.cameraBtn,
              {
                width: cameraBtnSize,
                height: cameraBtnSize,
                borderRadius: cameraBtnSize / 2,
              },
            ]}
            onPress={onDeleteAvatar}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={t('deleteAvatarTitle', lang)}
          >
            <Ionicons name="trash-outline" size={Math.round(cameraBtnSize / 2)} color={WELCOME_PROFILE_ROW_ICON} />
          </Pressable>
        ) : null}
      </View>
  );

  const hubAvatarSection = hubStage < 1 ? null : (
    <View
      style={[
        styles.avatarBlock,
        {
          marginTop: hubMetrics.gapTop,
          marginBottom: hubMetrics.gapUnderAvatar,
        },
      ]}
    >
      {hubAvatarBody}
    </View>
  );

  // Липкая шапка не переносит отрицательный верхний отступ: RN складывает из него
  // немонотонный inputRange (-1, 0, gapTop, gapTop+1) и роняет экран. Поэтому у
  // sticky-варианта отступ нулевой, а сдвиг переезжает на сам ScrollView.
  const hubAvatarSectionSticky = hubStage < 1 ? null : (
    <View
      style={[
        styles.avatarBlock,
        { marginTop: 0, marginBottom: hubMetrics.gapUnderAvatar },
      ]}
    >
      {hubAvatarBody}
    </View>
  );

  const hubListStack = hubStage < 2 ? null : (
    <View
      style={[
        styles.hubListStack,
        twoColumnList && styles.hubListStackTwoColumns,
        isTablet && styles.hubListStackTablet,
        twoColumnList
          ? { rowGap: hubMetrics.listGap }
          : { gap: hubMetrics.listGap },
        { marginBottom: hubMetrics.listGap },
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
          icon="bag-handle-outline"
          label={t('purchasesManagement', lang)}
          onPress={openPurchases}
        />
        <WelcomeProfileRow
          dense
          rowHeight={hubMetrics.rowHeight}
          compact={compactLandscape}
          tablet={isTablet}
          icon="shield-checkmark-outline"
          label={t('callReliabilityTitle', lang)}
          value={
            isCallKeepAliveSupported && reliabilityState
              ? t(reliabilityEnabled ? 'callReliabilityOn' : 'callReliabilityOff', lang)
              : undefined
          }
          onPress={openCallReliability}
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
          icon="help-circle-outline"
          label={t('profileHelp', lang)}
          onPress={openHelp}
        />
      </WelcomeProfileSection>
    </View>
  );

  /** Панель ввода ника — отдельно, чтобы в landscape скроллить её без аватара. */
  const hubAccountPanel = (
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
          maxFontSizeMultiplier={APP_INPUT_MAX_FONT_SIZE_MULTIPLIER}
          autoCorrect={false}
          autoCapitalize="none"
          editable={!busy}
        />
        <View style={styles.accountActions}>
          <Pressable onPress={onClearNick} disabled={busy || !displayNick} style={styles.accountSecondary}>
            <AdaptiveText style={styles.accountSecondaryText} numberOfLines={1}>
              {t('deleteNick', lang)}
            </AdaptiveText>
          </Pressable>
          <Pressable
            onPress={() => {
              handleSaveProfile();
              closeAccountEdit();
            }}
            disabled={busy}
            style={[styles.accountSave, savedToast && styles.accountSaveDone]}
          >
            <AdaptiveText style={styles.accountSaveText} numberOfLines={1}>
              {savedToast ? t('saved', lang) : t('save', lang)}
            </AdaptiveText>
          </Pressable>
        </View>
      </View>
  );

  // Одна структура при любом состоянии: открытие ника меняло обёртки (View → ScrollView),
  // аватар монтировался заново и мигал, пока картинка не загрузится снова.
  const hubBalanced = !needsHubScroll;
  const hubScrollBody = (
    <View style={hubBalanced ? styles.hubMainBalance : null}>
      <View style={hubBalanced ? styles.hubMainTop : null}>{hubAvatarSection}</View>
      {hubBalanced ? <View style={styles.hubMainSpacer} /> : null}
      {accountOpen ? hubAccountPanel : null}
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
        <View style={styles.helpTelegramDivider}>
          <Pressable
            onPress={openTelegram}
            style={({ pressed }) => [styles.helpTelegramRow, pressed && styles.helpEmailRowPressed]}
            accessibilityRole="link"
            accessibilityLabel={t('profileOpenTelegram', lang)}
          >
            <AdaptiveText style={styles.helpTelegramText}>{t('profileOpenTelegram', lang)}</AdaptiveText>
            <FontAwesome name="telegram" size={20} color="#229ED9" />
          </Pressable>
        </View>
      </View>
    </WelcomeProfileSection>
    </View>
  );

  const reliabilityStatus: CallKeepAliveStatus = reliabilityState?.status ?? 'off';
  const reliabilityStatusText = t(RELIABILITY_STATUS_KEY[reliabilityStatus], lang);
  const reliabilityStatusColor = RELIABILITY_STATUS_COLOR[reliabilityStatus];

  const callReliabilityBody = (
    <View style={[styles.subScreenBlockOffset, compactLandscape && styles.reliabilityWrapLandscape]}>
      <WelcomeProfileSection compact={compactLandscape} tablet={isTablet}>
        <View style={[styles.featureHero, compactLandscape && styles.featureHeroLandscape]}>
          <View style={[styles.featureHeroIcon, compactLandscape && styles.featureHeroIconLandscape]}>
            <Ionicons name="shield-checkmark-outline" size={compactLandscape ? 24 : 30} color={UI_ACCENT} />
          </View>
          <AdaptiveText style={styles.featureHeroText}>{t('callReliabilityIntro', lang)}</AdaptiveText>
        </View>
      </WelcomeProfileSection>

      {isCallKeepAliveSupported ? (
        <WelcomeProfileSection compact={compactLandscape} tablet={isTablet}>
          <Pressable
            onPress={toggleReliability}
            disabled={!reliabilityState}
            style={({ pressed }) => [styles.toggleRow, pressed && styles.toggleRowPressed]}
            accessibilityRole="switch"
            accessibilityState={{ checked: reliabilityEnabled, disabled: !reliabilityState }}
            accessibilityLabel={t('callReliabilityToggle', lang)}
          >
            <View style={styles.toggleText}>
              <AdaptiveText style={styles.toggleLabel}>{t('callReliabilityToggle', lang)}</AdaptiveText>
              <AdaptiveText style={styles.toggleHint}>{t('callReliabilityToggleHint', lang)}</AdaptiveText>
            </View>
            <ReliabilitySwitch value={reliabilityEnabled} />
          </Pressable>
          <View style={styles.cardDivider} />
          <View style={styles.statusRow}>
            <AdaptiveText style={styles.statusLabel} numberOfLines={1}>
              {t('callReliabilityStatus', lang)}
            </AdaptiveText>
            <View style={styles.statusValueWrap}>
              <View style={[styles.statusDot, { backgroundColor: reliabilityStatusColor }]} />
              <AdaptiveText style={styles.statusValue} numberOfLines={1}>
                {reliabilityStatusText}
              </AdaptiveText>
            </View>
          </View>
          {reliabilityEnabled && reliabilityState && !reliabilityState.notificationsEnabled ? (
            <>
              <View style={styles.cardDivider} />
              <Pressable
                onPress={openNotificationsSettings}
                style={({ pressed }) => [styles.statusRow, pressed && styles.toggleRowPressed]}
                accessibilityRole="button"
              >
                <AdaptiveText style={styles.statusWarn} numberOfLines={2}>
                  {t('callReliabilityNotificationsOff', lang)}
                </AdaptiveText>
                <View style={styles.statusValueWrap}>
                  <AdaptiveText style={styles.statusLink} numberOfLines={1}>
                    {t('callReliabilityOpenSettings', lang)}
                  </AdaptiveText>
                  <Ionicons name="chevron-forward" size={18} color={WELCOME_PROFILE_ROW_ICON} />
                </View>
              </Pressable>
            </>
          ) : null}
        </WelcomeProfileSection>
      ) : null}

      <WelcomeProfileSection title={t('callReliabilityHowTitle', lang)} compact={compactLandscape} tablet={isTablet}>
        <View style={styles.noteList}>
          {RELIABILITY_HOW_ITEMS.map((item) => (
            <View key={item.key} style={styles.noteRow}>
              <Ionicons name={item.icon} size={18} color={UI_ACCENT} style={styles.noteIcon} />
              <AdaptiveText style={styles.noteText}>{t(item.key, lang)}</AdaptiveText>
            </View>
          ))}
        </View>
      </WelcomeProfileSection>

      {isCallKeepAliveSupported ? (
        <WelcomeProfileSection title={t('callReliabilityCostTitle', lang)} compact={compactLandscape} tablet={isTablet}>
          <View style={styles.noteList}>
            <View style={styles.noteRow}>
              <Ionicons name="battery-half-outline" size={18} color={WELCOME_PROFILE_ROW_ICON} style={styles.noteIcon} />
              <AdaptiveText style={styles.noteText}>{t('callReliabilityCost', lang)}</AdaptiveText>
            </View>
          </View>
        </WelcomeProfileSection>
      ) : null}

      <WelcomeProfileSection title={t('callReliabilityVpnTipTitle', lang)} compact={compactLandscape} tablet={isTablet}>
        <View style={styles.noteList}>
          <View style={styles.noteRow}>
            <Ionicons name="key-outline" size={18} color={WELCOME_PROFILE_ROW_ICON} style={styles.noteIcon} />
            <View style={styles.noteBody}>
              <AdaptiveText style={styles.noteText}>{t('callReliabilityVpnTip', lang)}</AdaptiveText>
              {reliabilityState?.vpnActive ? (
                <View style={styles.vpnNowRow}>
                  <View style={[styles.statusDot, { backgroundColor: UI_ACCENT }]} />
                  <AdaptiveText style={styles.vpnNowText}>{t('callReliabilityVpnNow', lang)}</AdaptiveText>
                </View>
              ) : null}
            </View>
          </View>
        </View>
      </WelcomeProfileSection>
    </View>
  );

  const subScreenBody =
    screen === 'about'
      ? aboutBody
      : screen === 'help'
        ? helpBody
        : screen === 'callReliability'
          ? callReliabilityBody
          : screen === 'purchases'
            ? <PurchasesManagementPanel />
            : languageBody;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
    >
      <View style={styles.rootInner}>
        {screen === 'hub' ? null : headerSettings}

        {screen === 'hub' ? (
          <View
            style={[
              styles.hubPane,
              // Аватар поднят отрицательным отступом и заходит в шапку —
              // обрезка панели его срезает. Снимаем во всей горизонтали:
              // и на хабе, и при скролле, и при редактировании ника.
              isLandscape && styles.hubPaneOverflowVisible,
            ]}
            onLayout={handleHubPaneLayout}
          >
            {accountOpen && isLandscape ? (
              /* Ввод ника: аватар остаётся на своём месте, прокручивается только
                 панель со списком — иначе открытие поля сдвигало аватар. */
              <View style={styles.hubMainDock}>
                {hubAvatarSection}
                <ScrollView
                  style={styles.hubScrollBelowAvatar}
                  contentContainerStyle={styles.hubMainDockScroll}
                  scrollEnabled
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                  bounces={false}
                  overScrollMode="never"
                >
                  {hubAccountPanel}
                  {hubListStack}
                  {hubLogoutButton}
                </ScrollView>
              </View>
            ) : needsHubScroll && stickyAvatarOnScroll ? (
              <ScrollView
                style={[styles.hubMainDock, { marginTop: hubMetrics.gapTop }]}
                contentContainerStyle={styles.hubMainDockScroll}
                // Аватар — липкий заголовок: прокручивается, у верха фиксируется
                // и остаётся поверх карточек, которые уезжают под него.
                stickyHeaderIndices={[0]}
                scrollEnabled
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                bounces={false}
                overScrollMode="never"
              >
                {hubAvatarSectionSticky}
                {hubListStack}
                {hubLogoutButton}
              </ScrollView>
            ) : !isLandscape ? (
              // Без скролла flexGrow контейнера растягивает hubMainBalance на всю высоту.
              <ScrollView
                style={styles.hubMainDock}
                contentContainerStyle={styles.hubMainDockScroll}
                scrollEnabled={needsHubScroll}
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                bounces={false}
                overScrollMode="never"
              >
                {hubScrollBody}
              </ScrollView>
            ) : (
              <View style={styles.hubMainDock}>{hubScrollBody}</View>
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
    paddingTop: 0,
    paddingBottom: 0,
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
  /**
   * Landscape без скролла: обрезку снимаем, чтобы аватар мог заходить в шапку.
   * Высоты посчитаны так, что содержимое гарантированно помещается.
   */
  hubPaneOverflowVisible: {
    overflow: 'visible',
  },
  hubMainDock: {
    flex: 1,
    minHeight: 0,
  },
  hubMainBalance: {
    flex: 1,
    minHeight: 0,
    // Низ прижат: зазор «Удалить профиль» → навбар всегда равен listGap,
    // излишек высоты уходит в hubMainSpacer под аватаром.
    justifyContent: 'flex-end',
  },
  hubMainTop: {
    flexShrink: 0,
    width: '100%',
  },
  hubMainSpacer: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
  },
  hubMainDockScroll: {
    flexGrow: 1,
    paddingBottom: 0,
  },
  hubScrollBelowAvatar: {
    flex: 1,
    minHeight: 0,
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
    overflow: 'visible',
  },
  cameraBtn: {
    position: 'absolute',
    right: CAMERA_BTN_INSET,
    bottom: CAMERA_BTN_INSET,
    width: CAMERA_BTN_SIZE,
    height: CAMERA_BTN_SIZE,
    borderRadius: CAMERA_BTN_SIZE / 2,
    backgroundColor: 'rgba(0, 0, 0, 0.52)',
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
  // Панель ника лежит прямо на сцене: без сплошной подложки кнопки терялись на картинке.
  accountSecondary: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 999,
    backgroundColor: UI_SURFACE,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  accountSecondaryText: { color: WELCOME_MUTED_TEXT, fontSize: 13 },
  accountSave: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 999,
    // Приглушённый тон акцента на слейте — чуть темнее прежних 24% акцента поверх сцены.
    backgroundColor: '#344A5A',
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
  helpTelegramRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(34, 158, 217, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(34, 158, 217, 0.36)',
  },
  helpTelegramDivider: {
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
  },
  helpTelegramText: {
    flex: 1,
    color: WELCOME_HEADER_TITLE,
    fontSize: 14,
    fontWeight: '600',
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
  /** «Надёжные звонки» в горизонтали не тянутся на всю ширину, а стоят по центру. */
  reliabilityWrapLandscape: {
    width: '100%',
    maxWidth: 680,
    alignSelf: 'center',
  },
  featureHero: {
    alignItems: 'center',
    paddingTop: 20,
    paddingBottom: 18,
    paddingHorizontal: 18,
  },
  featureHeroLandscape: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 12,
    paddingBottom: 12,
    paddingHorizontal: 14,
    gap: 14,
  },
  featureHeroIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI_ACCENT_SOFT,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(98, 176, 216, 0.24)',
    marginBottom: 12,
  },
  featureHeroIconLandscape: {
    width: 44,
    height: 44,
    borderRadius: 22,
    marginBottom: 0,
  },
  featureHeroText: {
    flexShrink: 1,
    textAlign: 'center',
    color: WELCOME_MUTED_TEXT,
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '400',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap: 12,
  },
  toggleRowPressed: {
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  toggleText: {
    flex: 1,
    minWidth: 0,
  },
  toggleLabel: {
    color: WELCOME_HEADER_TITLE,
    fontSize: WELCOME_PROFILE_ROW_LABEL_FONT_SIZE,
    fontWeight: '500',
  },
  toggleHint: {
    marginTop: 3,
    color: WELCOME_PROFILE_ROW_ICON,
    fontSize: 12,
    lineHeight: 16,
  },
  switchTrack: {
    width: SWITCH_WIDTH,
    height: SWITCH_HEIGHT,
    borderRadius: SWITCH_HEIGHT / 2,
    padding: 3,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
    justifyContent: 'center',
  },
  switchTrackOn: {
    backgroundColor: 'rgba(98, 176, 216, 0.32)',
    borderColor: 'rgba(98, 176, 216, 0.45)',
  },
  switchThumb: {
    width: SWITCH_THUMB,
    height: SWITCH_THUMB,
    borderRadius: SWITCH_THUMB / 2,
    backgroundColor: '#AEB5BF',
  },
  switchThumbOn: {
    backgroundColor: UI_ACCENT,
  },
  cardDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: WELCOME_GLASS_BORDER,
    marginHorizontal: 14,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    paddingHorizontal: 14,
    gap: 12,
  },
  statusLabel: {
    color: WELCOME_HEADER_TITLE,
    fontSize: WELCOME_PROFILE_ROW_LABEL_FONT_SIZE,
    fontWeight: '400',
    flexShrink: 1,
  },
  statusValueWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flexShrink: 0,
    maxWidth: '62%',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusValue: {
    color: WELCOME_PROFILE_ROW_ICON,
    fontSize: 13,
    flexShrink: 1,
  },
  statusWarn: {
    flex: 1,
    color: WELCOME_HEADER_TITLE,
    fontSize: 13,
    lineHeight: 18,
  },
  statusLink: {
    color: UI_ACCENT,
    fontSize: 13,
  },
  noteList: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
  },
  noteIcon: {
    marginTop: 1,
  },
  noteBody: {
    flex: 1,
    minWidth: 0,
  },
  noteText: {
    flex: 1,
    color: WELCOME_MUTED_TEXT,
    fontSize: 13,
    lineHeight: 19,
  },
  vpnNowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 8,
  },
  vpnNowText: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 12,
  },
  hubActions: {
    marginHorizontal: 0,
    paddingTop: 0,
    flexShrink: 0,
  },
  logOutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    minHeight: 48,
  },
  logOutRowLandscape: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    minHeight: 40,
  },
  /** Горизонталь: строка на всю ширину под двумя колонками — содержимое по центру. */
  logOutRowCentered: {
    justifyContent: 'center',
  },
  logOutRowTablet: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    minHeight: 54,
  },
  logOutRowPressed: {
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  logOutBtnText: {
    color: WELCOME_DELETE_ICON,
    fontSize: WELCOME_PROFILE_ROW_LABEL_FONT_SIZE,
    fontWeight: '400',
    flexShrink: 1,
  },
  logOutBtnTextLandscape: {
    fontSize: WELCOME_PROFILE_ROW_LABEL_FONT_SIZE_COMPACT,
  },
  logOutBtnTextTablet: {
    fontSize: WELCOME_PROFILE_ROW_LABEL_FONT_SIZE_TABLET,
  },
});

export const HomeWelcomeProfileView = memo(HomeWelcomeProfileViewInner);
