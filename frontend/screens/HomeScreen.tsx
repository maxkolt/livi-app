// screens/HomeScreen.tsx
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  BackHandler,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  Pressable,
  View,
  Dimensions,
  useWindowDimensions,
  Platform,
  ActionSheetIOS,
  Animated,
  StyleProp,
  ViewStyle,
  AppState,
  NativeModules,
  ActivityIndicator,
  Linking,
  Share,
  Vibration,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import { syncMyStreamProfile } from '../chat/cometchat';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import SplashLoader from '../components/SplashLoader';
import { Swipeable, PinchGestureHandler, State } from 'react-native-gesture-handler';
import { List, Surface, Portal } from 'react-native-paper';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { getAvatarImageProps, forceImageRefresh } from '../utils/imageOptimization';
import { useResolvedImageUri } from '../hooks/useResolvedImageUri';
import AvatarImage from '../components/AvatarImage';
import AsyncStorage from '@react-native-async-storage/async-storage';


import {
  toAvatarThumb,
  normalizeLocalImageUri,
} from '../utils/uploadAvatar';

import LanguagePicker from '../components/LanguagePicker';
import { clearPendingInviteCode } from '../utils/inviteLink';
import { useAppTheme } from '../theme/ThemeProvider';
import { uiAccent } from '../theme/uiAccent';
import { t } from '../utils/i18n';
import type { Lang } from '../utils/i18n';
import { useLang } from '../store/lang';

import { getInstallId, resetInstallId } from '../utils/installId';
import { logger } from '../utils/logger';
import { trimNick } from '../utils/userDisplayName';
import { usePiP } from '../src/pip/PiPContext';
import { onCallTimeout as onCallTimeoutEvent, onCallIncoming as onCallIncomingEvent, onCallDeclined as onCallDeclinedEvent } from '../sockets/socket';
import { onRequestCloseIncoming, emitCloseIncoming, onCloseOutgoingCall, onCallCancelledOnHome, onCallEndedOnHome, onCloseHomeModals, shouldSkipHomeUiSettle } from '../utils/globalEvents';
import { displayOutgoingCallImmediate, notifyOutgoingCallId, reportEndCallToCallKeep, closeOutgoingCallActivity, bringMainActivityToFront, OUTGOING_CALL_TIMEOUT_MS, clearOutgoingDeclineHandled, isOutgoingDeclineHandled, setupCallKeep, isCallKeepAvailable, setCallMediaHint } from '../utils/callKeep';
import { syncAppBadgeFromMissedCount, dismissMessageNotificationsOnly, getMissedCountByUserFromNative } from '../utils/pushNotifications';
import SettingsTab from '../components/SettingsTab';
import {
  LIVI,
  styles,
  HomeFriendsTab,
  HomeMoreTab,
  HomeWelcomeView,
  HomeMenuOverlay,
  displayName,
  displayAvatarLetter,
  badgeMapsEqual,
  mergeMissedFromSources,
  buildFriendBadgesSignature,
  isDirectCallSessionLive,
  useLiviNotice,
  useLiviConfirm,
  useHomeMenu,
  useHomeUpdatePromo,
  useHomeBadges,
  useHomeFriends,
} from './home';
import type { NoticeKind } from './home';
import type { Friend, HomeRouteParams } from './home/types';
import {
  DRAFT_KEY,
  FRIENDS_CACHE_KEY_LEGACY,
  FRIENDS_CACHE_PREFIX,
  INSTALL_ID_KEY,
  MISSED_CALLS_KEY,
  PROFILE_KEY,
  UNREAD_BY_USER_KEY,
  USER_ID_KEY,
} from './home/constants';
import ChatStyleBackButton from '../components/ChatStyleBackButton';
import { loadProfileFromStorage, saveProfileToStorage, clearAllAvatarCaches } from '../utils/profileStorage';
// УБРАНО: forceClearUserDataOnly не используется - вместо этого используется hardLocalReset() и clearAllUserData() из socket.ts
import { warmAvatar, putThumb, putFull, getFull, clearAvatarCacheFor } from '../utils/avatarCache';
import {
  disposeDirectCallAudioPrewarm,
  prefetchDirectCallIce,
} from '../utils/directCallConnectPrewarm';
import * as FileSystem from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

import socket, {
  onFriendAccepted,
  onFriendRequest,
  onPresenceUpdate,
  inviteFriend,
  onConnected,
  onCurrentUserId,
  onFriendRemoved,
  removeFriend,
  updateProfile,
  onFriendProfile,
  PRESENCE_OFFLINE_DEBOUNCE_MS,
  emitAck,
  attachIdentity,
  getCurrentUserId,
  setCurrentUserId,
  clearCurrentUserId,
  checkUserExists,
  clearAllUserData,
  createUser,
  isCreateUserInProgress,
  getMyUserId,
  API_BASE,
  startCall,
  forceEndDirectCallWithPeer,
  warmCallSignaling,
  cancelCall,
  ensureSocketConnected,
  SOCKET_CONNECT_WAIT_MS,
  getMyProfile,
  onCallAccepted,
  onCallDeclined,
  onCallCanceled,
  onCallTimeout,
  onCallRoomFull,
  onDisconnected,
  isReconnecting,
  waitForCreateUserCompletion,
  refreshUserIdFromInstall,
  checkInviteLink,
  requestFriend,
  acceptInvite,
  setOutgoingCallScreenVisible,
  onIncomingCallScreenChange,
  getIncomingCallScreenState,
  emitPresenceUpdateIfChanged,
  setActiveVideoCall,
} from '../sockets/socket';
import { primeAndroidCallContextForLeaveHint } from '../utils/activeCallNotification';
import { clearHomeTransientRouteParams } from '../utils/appNavigationGuard';





/* ================= draft / reset (shared keys via ./home/constants) ================= */

/* draft storage */
async function saveDraftProfile(d: { nick?: string; avatar?: string }) {
  try {
    const prev = JSON.parse((await AsyncStorage.getItem(DRAFT_KEY)) || '{}');
    const newDraft = { ...prev, ...d };
    await AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(newDraft));
  } catch {}
}
async function loadDraftProfile(): Promise<{ nick?: string; avatar?: string }> {
  try {
    const raw = await AsyncStorage.getItem(DRAFT_KEY);
    const result = raw ? JSON.parse(raw) : {};
    return result;
  } catch { return {}; }
}

/* ===== Жёсткий локальный сброс - single place ===== */
async function hardLocalReset() {
  try {
    // 1. Очищаем все ключи AsyncStorage
    const keysToRemove = [
      DRAFT_KEY,              // profile_draft_v1
      PROFILE_KEY,            // livi.profile.v1
      INSTALL_ID_KEY,         // livi.installId
      USER_ID_KEY,            // userId
      MISSED_CALLS_KEY,       // missed_calls_by_user_v1
      UNREAD_BY_USER_KEY,
      FRIENDS_CACHE_KEY_LEGACY,
    ];

    // Удаляем основные ключи
    await AsyncStorage.multiRemove(keysToRemove);

    // 2. Очищаем все чаты, статусы и identity-scoped friends cache
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const chatKeys = allKeys.filter(k => 
        k.startsWith('chat_messages_') || 
        k.startsWith('chat_statuses_') ||
        k.startsWith(`${FRIENDS_CACHE_PREFIX}:`)
      );
      if (chatKeys.length > 0) {
        await AsyncStorage.multiRemove(chatKeys);
      }
    } catch (e) {
      logger.warn('Failed to remove chat keys:', e);
    }

    // 3. Очищаем кэш аватаров
    try {
      await clearAllAvatarCaches();
    } catch (e) {
      logger.warn('Failed to clear avatar caches:', e);
    }

    // 4. Очищаем кэш изображений Expo
    try {
      const { Image } = await import('expo-image');
      if (Image?.clearMemoryCache) {
        await Image.clearMemoryCache();
      }
      if (Image?.clearDiskCache) {
        await Image.clearDiskCache();
      }
    } catch (e) {
      logger.warn('Failed to clear Expo Image cache:', e);
    }

    // 5. Очищаем кэш аватаров через новую систему
    try {
      const { clearAvatarCache } = await import('../utils/avatarCache');
      await clearAvatarCache();
    } catch (e) {
      logger.warn('Failed to clear avatar cache:', e);
    }

    return true;
  } catch (e) {
    logger.error('Hard local reset error:', e);
    return false;
  }
}

/* wait socket connect */
const waitSocketConnected = (timeoutMs: number = 1200) =>
  new Promise<void>((resolve) => {
    try {
      if ((socket as any)?.connected) return resolve();
      let done = false;
      const on = () => {
        if (done) return;
        done = true;
        try { socket.off('connect', on); } catch {}
        resolve();
      };
      try { socket.on('connect', on); } catch {}
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (done) return;
          done = true;
          try { socket.off('connect', on); } catch {}
          resolve();
        }, timeoutMs);
      }
    } catch {
      resolve();
    }
  });

/* ================= component ================= */
type Props = { navigation: any };


/** При возврате на Home (например из VideoCall по Back → PiP) экран монтируется заново и state сбрасывается — без этого флага снова показывался бы SplashLoader. Запоминаем, что контент уже показывали в этой сессии. */
let homeScreenAlreadyBooted = false;

export function markHomeScreenBootedForSession() {
  homeScreenAlreadyBooted = true;
}

export default function HomeScreen({ navigation, route }: Props & { route?: { params?: HomeRouteParams } }) {
  const { width: layoutWidth, height: layoutHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const pip = usePiP();
  const { preference, setPreference, theme, isDark } = useAppTheme();
  const accent = React.useMemo(() => uiAccent(isDark), [isDark]);
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === 'active');
  const [resolvedUserId, setResolvedUserId] = useState<string>('');
  const [installId, setInstallId] = useState<string>('');

  const { menuOpen, setMenuOpen, tab, setTab, tabRef, menuOverlayOpacity, menuOverlayTranslateY, closeMenu } = useHomeMenu();
  const [wallpaperPickerTheme, setWallpaperPickerTheme] = useState<'light' | 'dark' | null>(null);
  // После первого открытия вкладки остаются в дереве (скрыты оверлеем) — без скачка «пусто → друзья».
  const [menuEverOpened, setMenuEverOpened] = useState(false);
  useEffect(() => {
    if (menuOpen) setMenuEverOpened(true);
  }, [menuOpen]);
  const menuTabsMounted = menuOpen || menuEverOpened;

  // Пикер фона — внутренний экран More; сбрасываем при закрытии меню / смене вкладки.
  useEffect(() => {
    if (!menuOpen) setWallpaperPickerTheme(null);
  }, [menuOpen]);
  useEffect(() => {
    if (tab !== 'more') setWallpaperPickerTheme(null);
  }, [tab]);
  const {
    updateAvailable,
    updateSpinAnim,
    suppressUpdateBadgeForCallNotice,
  } = useHomeUpdatePromo(tab);

  const {
    friends,
    setFriends,
    initialized,
    setInitialized,
    refreshing,
    setRefreshing,
    friendsRef,
    loadFriends,
    loadFriendsFnRef,
    friendLastOnlineTrueAtRef,
  } = useHomeFriends({ resolvedUserId, installId, menuOpen, tab, appIsActive });

  const {
    unreadByUser,
    setUnreadByUser,
    missedByUser,
    setMissedByUser,
    setMissedLoaded,
    refreshUnreadCountsForFriends,
  } = useHomeBadges({ friends, friendsRef });

  const pendingPresenceOfflineTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Закрытие свайпа строки при нажатии «Видеозвонок», чтобы не видеть кнопку удаления друга до появления нативного экрана
  const openSwipeableRef = useRef<React.ElementRef<typeof Swipeable> | null>(null);
  const swipeableRefsMap = useRef<Record<string, React.ElementRef<typeof Swipeable>>>({});
  const [swipeActionsHiddenForCall, setSwipeActionsHiddenForCall] = useState<string | null>(null);

  // Единый фон для "титановой" кнопки меню и кружка аватара (в светлой теме),
  // чтобы элементы выглядели консистентно.
  const MENU_CHROME_BG = isDark
    ? 'rgba(138, 143, 153, 0.15)' // титановый для тёмной темы
    : Platform.OS === 'android'
      ? 'rgba(59, 68, 83, 0.10)' // чуть легче на Android
      : 'rgba(59, 68, 83, 0.15)'; // iOS

  // Внутри кнопки меню: тот же фон, что у кнопки «Начать поиск» (theme.colors.background).
  const MENU_BTN_INNER_BG = theme.colors.background as string;

  // На Android обработка выхода на корне (Back → системный PiP) централизована в App.tsx,
  // чтобы избежать конфликтов порядка BackHandler'ов (и неожиданного системного PiP на VideoCall).

  /* profile state */
  const [saving, setSaving] = useState(false);
  // Синхронный guard от двойного тапа "Сохранить" (state обновляется не мгновенно)
  const savingRef = useRef(false);
  const [savedToast, setSavedToast] = useState(false);
  const [wiping, setWiping] = useState(false);

  // Синхронная загрузка профиля при инициализации. При повторном монтировании (возврат из звонка/PiP) не показываем сплэш — оба true, профиль подставится в отдельном effect.
  const [profileLoaded, setProfileLoaded] = useState(homeScreenAlreadyBooted);
  const [dataLoaded, setDataLoaded] = useState(homeScreenAlreadyBooted);
  // Сплеш поверх уже отрисованного Home: при уходе сплеша видна страница приветствия с актуальными данными
  const [splashDismissed, setSplashDismissed] = useState(homeScreenAlreadyBooted);
  const [nick, setNick] = useState('');
  // На медленных девайсах (Android 8.1/старые модели) setState может "догонять" ввод,
  // и при нажатии "Сохранить" в тот же момент на сервер может уйти только первая буква.
  // Держим актуальный ник в ref и обновляем его синхронно в onChangeText.
  const nickLiveRef = useRef<string>('');
  // Флаг "пользователь начал вводить ник вручную в этом UI".
  // Нужен, чтобы при hard reset после удаления аккаунта:
  // - НЕ восстанавливать старый ник из предыдущего состояния
  // - но сохранить введённые пользователем символы, если reset пришёл во время ввода
  const nickInputDirtyRef = useRef(false);
  const [avatarUri, setAvatarUri] = useState<string>('');      // может быть file:// для локального превью
  const [myFullAvatarUri, setMyFullAvatarUri] = useState<string>(''); // полный аватар (data URI)
  const [avatarRefreshKey, setAvatarRefreshKey] = useState(0); // для принудительного обновления на Android
  const [videoCallEndedTick, setVideoCallEndedTick] = useState(0); // при завершении звонка вызываем setVideoCallEndedTick → ре-рендер списка друзей, снимаются бейдж «Занят» и disabled
  const lastVideoCallPartnerRef = useRef<string | null>(null);
  const lastOutgoingPeerIdRef = useRef<string | null>(null);
  const [resolvedAvatarUri, resolvedAvatarReady] = useResolvedImageUri(avatarUri || ''); // на Android data: -> file: для Glide
  const [, myFullAvatarResolvedReady] = useResolvedImageUri(myFullAvatarUri || ''); // кешированный аватар (data:) -> file: для Glide на Android
  const [savedNick, setSavedNick] = useState<string>('');      // сохранённый ник
  
  // Отладочная версия setSavedNick с логированием
  const setSavedNickDebug = useCallback((value: string) => {
    setSavedNick(value);
  }, []);
  const savedNickRef = useRef<string>('');
  const avatarUriRef = useRef<string>('');
  useEffect(() => {
    savedNickRef.current = savedNick;
  }, [savedNick]);
  useEffect(() => {
    avatarUriRef.current = avatarUri;
  }, [avatarUri]);
  const [savedAvatarUrl, setSavedAvatarUrl] = useState<string>(''); // ТОЛЬКО https или ''
  const [myAvatarVer, setMyAvatarVer] = useState<number>(0);   // версия моего аватара
  const [avatarVerChecked, setAvatarVerChecked] = useState(false); // true после первой проверки кэша (убирает мелькание буквы при переходе на Home после звонка)
  const [profileKey, setProfileKey] = useState(0);

  // Make currentUserId reactive for this screen (module state changes don't trigger re-render).
  useEffect(() => {
    const off = onCurrentUserId((id) => {
      setResolvedUserId(String(id || ''));
    });
    return () => { try { off?.(); } catch {} };
  }, []);

  // Restore cached avatar version ASAP so avatar can render offline / on slow mobile networks.
  // После первой проверки ставим avatarVerChecked=true, чтобы не показывать букву до загрузки (мелькание при переходе на Home после звонка).
  useEffect(() => {
    let cancelled = false;
    const uid = String(resolvedUserId || '').trim();
    if (!uid) {
      setAvatarVerChecked(true);
      return;
    }
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(`avatarVer_${uid}`);
        const v = raw ? Number(raw) || 0 : 0;
        if (!cancelled && v > 0) {
          setMyAvatarVer((prev) => (prev && prev > v ? prev : v));
        }
      } catch {}
      if (!cancelled) setAvatarVerChecked(true);
    })();
    return () => { cancelled = true; };
  }, [resolvedUserId]);

  // Всегда синхронизируем ref со state (на случай, если nick меняется НЕ через SettingsTab onChangeText,
  // например после загрузки профиля с сервера).
  useEffect(() => {
    nickLiveRef.current = nick;
  }, [nick]);

  /* модалка аватара на странице приветствия: полный экран, блюр/затемнение, круг 3×, pinch-to-zoom */
  const [avatarModalVisible, setAvatarModalVisible] = useState(false);
  const [modalAvatarUri, setModalAvatarUri] = useState<string>('');
  const avatarModalPinchScale = useRef(new Animated.Value(1)).current;
  const avatarModalBaseScale = useRef(new Animated.Value(1)).current;
  const avatarModalLastScale = useRef(1);
  const avatarModalScaleNumber = useRef(1);

  useEffect(() => {
    if (!avatarModalVisible) return;
    setModalAvatarUri(myFullAvatarUri || avatarUri || '');
    const uid = resolvedUserId || getCurrentUserId();
    const ver = myAvatarVer || 0;
    if (uid && ver > 0) {
      getFull(uid, ver).then((fullUri) => {
        if (fullUri) setModalAvatarUri(fullUri);
      }).catch(() => {});
    }
    avatarModalPinchScale.setValue(1);
    avatarModalBaseScale.setValue(1);
    avatarModalLastScale.current = 1;
    avatarModalScaleNumber.current = 1;
  }, [avatarModalVisible, myFullAvatarUri, avatarUri, myAvatarVer, resolvedUserId, avatarModalPinchScale, avatarModalBaseScale]);

  // На Android в модалке data: URI нужно показывать через разрешённый file: (иначе Glide/ExpoImage не покажут)
  const [modalAvatarResolvedUri] = useResolvedImageUri(avatarModalVisible ? modalAvatarUri : '');
  const modalAvatarDisplayUri = (Platform.OS === 'android' && /^data:/i.test(modalAvatarUri)) ? modalAvatarResolvedUri : modalAvatarUri;

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!avatarModalVisible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setAvatarModalVisible(false);
      return true;
    });
    return () => sub.remove();
  }, [avatarModalVisible]);

  const avatarModalSize = (() => {
    const { width: sw, height: sh } = Dimensions.get('window');
    const base = Platform.OS === 'ios' ? 136 : 120;
    return Math.min(base * 3, Math.floor(0.9 * Math.min(sw, sh)));
  })();
  const avatarModalScale = Animated.multiply(avatarModalBaseScale, avatarModalPinchScale);
  const clampAvatarModal = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));
  const onAvatarModalPinchEvent = Animated.event([{ nativeEvent: { scale: avatarModalPinchScale } }], { useNativeDriver: false });
  const onAvatarModalPinchStateChange = useCallback((e: any) => {
    if (e.nativeEvent.oldState === State.ACTIVE) {
      const next = clampAvatarModal(avatarModalLastScale.current * e.nativeEvent.scale, 1, 6);
      avatarModalLastScale.current = next;
      avatarModalScaleNumber.current = next;
      avatarModalBaseScale.setValue(next);
      avatarModalPinchScale.setValue(1);
    }
  }, [avatarModalBaseScale, avatarModalPinchScale]);

  const prevAvatarRef = useRef<string>('');

  const pendingAttachRef = useRef<{ nick?: string; avatar?: string } | null>(null);
  const { askConfirm, ConfirmView } = useLiviConfirm();
  
  /* УДАЛЕНО: устаревшие статусы "Занято" - теперь используется friend.isBusy */

  /* ===== Защита от дублирования вызовов ===== */
  const ensureIdentityRef = useRef<Promise<any> | null>(null);
  const attachIdentityRef = useRef<Promise<any> | null>(null);
  const lastChatOpenRef = useRef<{ peerId: string; at: number } | null>(null);
  const recentlyEndedCallFriendIdsRef = useRef<Map<string, number>>(new Map());
  const RECENT_CALL_END_UNLOCK_MS = 5000;

  /* ===== Сброс всего React state ===== */
  const resetAllState = useCallback(async () => {
    setFriends([]);
    setNick('');
    nickLiveRef.current = '';
    nickInputDirtyRef.current = false;
    setSavedNickDebug('');
    setAvatarUri('');
    setSavedAvatarUrl('');
    setMyAvatarVer(0);
    setMyFullAvatarUri('');
    setUnreadByUser({});
    setProfileKey(k => k + 1);
    setAvatarRefreshKey(k => k + 1);

    try {
      const uid = getCurrentUserId();
      if (uid) {
        await AsyncStorage.removeItem(`avatarVer_${uid}`);
      }
    } catch (e) {
      logger.warn('Failed to remove avatar version:', e);
    }

    clearCurrentUserId();
  }, []);
  


  /* language */
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  const [langPickerVisible, setLangPickerVisible] = useState(false);
  const L = useCallback((key: string) => t(key, lang), [lang]);

  // ===== Notice (toast) =====
  // ВАЖНО: держим showNotice выше по файлу, потому что он используется в колбэках ниже.
  const { showNotice: baseShowNotice, NoticeView } = useLiviNotice();
  const showNotice = useCallback((text: string, kind: NoticeKind = 'info', ms = 3000) => {
    const normalized = (text ?? '').trim().toLowerCase();
    if (normalized === t('saved', lang).toLowerCase() || normalized === `${t('saved', lang).toLowerCase()}!`) {
      setSavedToast(true);
      return;
    }
    baseShowNotice(text, kind, ms);
  }, [baseShowNotice, setSavedToast, lang]);
  
  // ===== Donate modal =====
  const [donateVisible, setDonateVisible] = useState(false);
  const [pressedButton, setPressedButton] = useState<'boosty' | 'patreon' | null>(null);
  
  // ===== Share/Invite modal =====
  const [shareVisible, setShareVisible] = useState(false);

  // На Android: при открытых модалках "Support the project" и "Invite a friend" кнопка "Назад" закрывает модалку
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!donateVisible && !shareVisible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (donateVisible) {
        setDonateVisible(false);
        return true;
      }
      if (shareVisible) {
        setShareVisible(false);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [donateVisible, shareVisible]);
  const [inviteLink, setInviteLink] = useState<string>('');
  
  // ===== Invite request modal =====
  const [inviteRequestVisible, setInviteRequestVisible] = useState(false);
  const [inviteRequestData, setInviteRequestData] = useState<{
    code: string;
    inviter: {
      id: string;
      nick: string;
      avatar: string;
      avatarVer: number;
      avatarThumbB64: string;
    };
    areFriends?: boolean;
    hasPendingRequest?: boolean;
  } | null>(null);
  const BOOSTY_URL = process.env.EXPO_PUBLIC_BOOSTY_URL || "https://boosty.to/liviapp/donate";
  const PATREON_URL = process.env.EXPO_PUBLIC_PATREON_URL || "https://www.patreon.com/c/LiViApp";
  const appendUtm = React.useCallback((url: string, params: Record<string, string>) => {
    try {
      const u = new URL(url);
      Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
      return u.toString();
    } catch {
      // fallback простая конкатенация
      const hasQ = url.includes('?');
      const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      return url + (hasQ ? '&' : '?') + qs;
    }
  }, []);
  const incrCounter = React.useCallback(async (key: string) => {
    try {
      const raw = await AsyncStorage.getItem(key);
      const n = raw ? Number(raw) || 0 : 0;
      const next = String(n + 1);
      await AsyncStorage.setItem(key, next);
      logger.info(`[analytics] ${key} -> ${next}`);
      return Number(next);
    } catch {
      return 0;
    }
  }, []);
  
  // ===== Generate invite link =====
  const generateInviteLink = useCallback(async () => {
    try {
      const userId = getCurrentUserId();
      if (!userId) {
        showNotice(t('unauthorizedError', lang), 'error', 3000);
        return;
      }
      // Используем веб-ссылку, которая автоматически редиректит на приложение
      // Это работает и для iOS, и для Android
      // Определяем правильный URL сервера для генерации ссылки
      // КРИТИЧНО: В production используйте домен с HTTPS, не IP адреса!
      let serverUrl = API_BASE || 'https://api.liviapp.com';
      
      // Если API_BASE указывает на локальный адрес или IP - используем переменную окружения
      if (serverUrl.includes('192.168') || serverUrl.includes('localhost') || serverUrl.includes('127.0.0.1') || /^http:\/\/\d+\.\d+\.\d+\.\d+/.test(serverUrl)) {
        // Пробуем использовать переменную окружения для внешнего доступа
        const externalUrl = process.env.EXPO_PUBLIC_SERVER_URL || 
                           process.env.EXPO_PUBLIC_SERVER_URL_IOS || 
                           process.env.EXPO_PUBLIC_SERVER_URL_ANDROID;
        if (externalUrl && !externalUrl.includes('192.168') && !externalUrl.includes('localhost') && !externalUrl.includes('127.0.0.1') && !/^http:\/\/\d+\.\d+\.\d+\.\d+/.test(externalUrl)) {
          serverUrl = externalUrl.replace(/\/+$/, '');
        } else {
          // Fallback: используем production домен
          serverUrl = 'https://api.liviapp.com';
        }
      }
      
      const link = `${serverUrl}/invite/${userId}`;
      setInviteLink(link);
      setShareVisible(true);
      await incrCounter('invite_link_generated');
    } catch (e) {
      logger.error('Failed to generate invite link:', e);
      showNotice(t('inviteLinkCreateFailed', lang), 'error', 3000);
    }
  }, [showNotice, incrCounter]);
  
  const openLangPicker  = () => setLangPickerVisible(true);
  const closeLangPicker = () => setLangPickerVisible(false);
  const handleSelectLang = async (code: Lang) => { await setLang(code); setLangPickerVisible(false); };

  // ===== Обработка реферальной ссылки из route params =====
  const processedInviteRef = useRef<string | null>(null);

  const clearInviteRouteParams = useCallback(() => {
    try {
      navigation?.setParams?.({
        showInviteModal: false,
        inviteCode: undefined,
      } as any);
    } catch {}
  }, [navigation]);
  
  useEffect(() => {
    const checkInviteFromRoute = async () => {
      const inviteCode = route?.params?.inviteCode as string | undefined;
      const shouldShow = route?.params?.showInviteModal as boolean | undefined;
      
      if (!inviteCode || processedInviteRef.current === inviteCode) {
        return;
      }

      if (!shouldShow && !inviteCode) {
        return;
      }

      processedInviteRef.current = inviteCode;

      try {
        const result = await checkInviteLink(inviteCode);
        
        if (!result.ok) {
          showNotice(t('inviteLinkInvalid', lang), 'error', 3000);
          await clearPendingInviteCode();
          clearInviteRouteParams();
          processedInviteRef.current = null;
          return;
        }

        if (result.areFriends) {
          showNotice(t('inviteAlreadyFriendsWithUser', lang), 'info', 3000);
          await clearPendingInviteCode();
          clearInviteRouteParams();
          processedInviteRef.current = null;
          return;
        }

        if (result.hasPendingRequest) {
          showNotice(t('inviteRequestAlreadySent', lang), 'info', 3000);
          await clearPendingInviteCode();
          clearInviteRouteParams();
          processedInviteRef.current = null;
          return;
        }

        if (result.canAdd && result.inviter) {
          setInviteRequestData({
            code: inviteCode,
            inviter: {
              ...result.inviter,
              nick: trimNick(result.inviter.nick),
            },
            areFriends: result.areFriends,
            hasPendingRequest: result.hasPendingRequest,
          });
          setInviteRequestVisible(true);
        }
      } catch (e) {
        logger.error('Failed to check invite from route:', e);
        showNotice(t('inviteLinkProcessFailed', lang), 'error', 3000);
        processedInviteRef.current = null;
      }
    };

    if (route?.params?.inviteCode || route?.params?.showInviteModal) {
      const timer = setTimeout(() => {
        void checkInviteFromRoute();
      }, 300);
      
      return () => clearTimeout(timer);
    }
  }, [route?.params?.showInviteModal, route?.params?.inviteCode, showNotice, clearInviteRouteParams]);

  useEffect(() => {
    if (!inviteRequestVisible || !inviteRequestData?.inviter?.id) return;
    if (trimNick(inviteRequestData.inviter.nick)) return;
    const inviterId = inviteRequestData.inviter.id;
    let cancelled = false;
    void (async () => {
      try {
        const r = await checkInviteLink(inviterId);
        const loaded = trimNick(r?.inviter?.nick);
        if (!cancelled && loaded) {
          setInviteRequestData((prev) =>
            prev && prev.inviter.id === inviterId
              ? { ...prev, inviter: { ...prev.inviter, nick: loaded } }
              : prev,
          );
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteRequestVisible, inviteRequestData?.inviter?.id, inviteRequestData?.inviter?.nick]);

  // ===== Обработка принятия/отклонения приглашения =====
  const handleAcceptInvite = useCallback(async () => {
    if (!inviteRequestData) return;

    try {
      const result = await acceptInvite(inviteRequestData.inviter.id);
      
      if (result?.ok) {
        if (result.status === 'already') {
          showNotice(t('already_friends', lang), 'info', 3000);
        } else if (result.status === 'accepted') {
          showNotice(t('inviteUserAdded', lang), 'success', 3000);
          loadFriendsFnRef.current();
        } else {
          showNotice(t('inviteUserAdded', lang), 'success', 3000);
          loadFriendsFnRef.current();
        }
      } else {
        showNotice(result?.error || t('friendAddFailed', lang), 'error', 3000);
      }
      
      setInviteRequestVisible(false);
      setInviteRequestData(null);
      processedInviteRef.current = null;
      await clearPendingInviteCode();
      clearInviteRouteParams();
    } catch (e) {
      logger.error('Failed to accept invite:', e);
      showNotice(t('friendAddFailed', lang), 'error', 3000);
      setInviteRequestVisible(false);
      setInviteRequestData(null);
      processedInviteRef.current = null;
      await clearPendingInviteCode();
      clearInviteRouteParams();
    }
  }, [inviteRequestData, showNotice, clearInviteRouteParams]);

  const handleDeclineInvite = useCallback(async () => {
    setInviteRequestVisible(false);
    setInviteRequestData(null);
    processedInviteRef.current = null;
    await clearPendingInviteCode();
    clearInviteRouteParams();
  }, [clearInviteRouteParams]);

  // Android back: закрытие invite-модалки = decline (не теряем pending без явной отмены)
  useEffect(() => {
    if (Platform.OS !== 'android' || !inviteRequestVisible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      void handleDeclineInvite();
      return true;
    });
    return () => sub.remove();
  }, [inviteRequestVisible, handleDeclineInvite]);

  /* ===== Call (outgoing modal) ===== */
  const [calling, setCalling] = useState<{ visible: boolean; friend?: Friend | null; callId?: string | null }>({ visible: false });
  const [incomingCallScreen, setIncomingCallScreenState] = useState<{ visible: boolean; fromUserId: string | null }>(() => {
    const s = getIncomingCallScreenState();
    return { visible: s.visible, fromUserId: s.fromUserId };
  });
  useEffect(() => {
    const off = onIncomingCallScreenChange((visible, fromUserId) => {
      setIncomingCallScreenState({ visible, fromUserId: fromUserId ?? null });
    });
    return () => off();
  }, []);
  const [markReadMenu, setMarkReadMenu] = useState<{ friendId: string; type: 'video' | 'chat' } | null>(null);
  const [friendActionsGestureResetSeq, setFriendActionsGestureResetSeq] = useState(0);
  const openMarkReadMenu = useCallback((friendId: string, type: 'video' | 'chat') => {
    try {
      openSwipeableRef.current?.close?.();
    } catch {}
    openSwipeableRef.current = null;
    setMarkReadMenu({ friendId, type });
  }, []);
  const lastIncomingFromRef = useRef<string | null>(null);
  const [roomFull, setRoomFull] = useState<{ visible: boolean; name?: string }>({ visible: false });

  const pendingCancelRef = useRef(false);
  /** Инкремент при реальной отмене исходящего — attempt видит только cancel, случившийся после своего старта. */
  const outgoingCancelEpochRef = useRef(0);
  /** Пользователь явно сбросил исходящий (кнопка/натив): не показывать callStartFailed когда позже падает отложенный startCall. */
  const outgoingCallUserCanceledRef = useRef(false);
  const callingVisibleRef = useRef(false);
  callingVisibleRef.current = calling.visible;
  /** Monotonic token for outgoing-call attempts: cancel/restart must make older async startCall results stale. */
  const outgoingAttemptSeqRef = useRef(0);
  const activeOutgoingAttemptRef = useRef(0);
  const activeOutgoingCallIdRef = useRef<string | null>(null);
  const lastOutgoingExternalCloseResetAtRef = useRef(0);
  const lastOutgoingNativeCloseBeforeRetryAtRef = useRef(0);
  const OUTGOING_NATIVE_CLOSE_BEFORE_RETRY_MS = 120;

  /** UI без исходящего, но ref попытки остался после async — иначе onPress молча игнорируют тап. */
  const clearStaleOutgoingAttemptIfIdle = useCallback(() => {
    if (activeOutgoingAttemptRef.current <= 0) return;
    if (callingVisibleRef.current) return;
    logger.info('[HomeScreen] cleared stale outgoing attempt (UI idle)');
    activeOutgoingAttemptRef.current = 0;
    activeOutgoingCallIdRef.current = null;
    outgoingAttemptSeqRef.current += 1;
  }, []);

  const clearFriendsCallBusy = useCallback((userIds: Array<string | null | undefined>) => {
    const ids = new Set(
      userIds.map((id) => String(id || '').trim()).filter(Boolean),
    );
    if (!ids.size) return;
    const now = Date.now();
    const ended = recentlyEndedCallFriendIdsRef.current;
    ids.forEach((id) => ended.set(id, now));
    for (const [key, at] of ended) {
      if (now - at > RECENT_CALL_END_UNLOCK_MS) ended.delete(key);
    }
    setFriends((prev) =>
      prev.map((f) => (ids.has(String(f.id)) ? { ...f, isBusy: false } : f)),
    );
  }, []);

  const markRecentlyEndedCallFriend = useCallback((userId: string | null | undefined) => {
    const id = String(userId || '').trim();
    if (!id) return;
    const now = Date.now();
    const ended = recentlyEndedCallFriendIdsRef.current;
    ended.set(id, now);
    for (const [key, at] of ended) {
      if (now - at > RECENT_CALL_END_UNLOCK_MS) ended.delete(key);
    }
  }, []);

  const isRecentlyEndedCallFriend = useCallback((userId: string | null | undefined) => {
    const id = String(userId || '').trim();
    if (!id) return false;
    const at = recentlyEndedCallFriendIdsRef.current.get(id);
    if (!at) return false;
    if (Date.now() - at > RECENT_CALL_END_UNLOCK_MS) {
      recentlyEndedCallFriendIdsRef.current.delete(id);
      return false;
    }
    return true;
  }, []);

  const forceResetCallBusyRefs = useCallback(() => {
    try {
      const g = global as any;
      g.__videoCallPartnerUserIdRef = g.__videoCallPartnerUserIdRef || { current: null };
      g.__videoCallPartnerUserIdRef.current = null;
      g.__videoCallActiveRef = g.__videoCallActiveRef || { current: false };
      g.__videoCallActiveRef.current = false;
      g.__pipVisibleRef = g.__pipVisibleRef || { current: false };
      g.__pipVisibleRef.current = false;
      g.__pipInSystemModeRef = g.__pipInSystemModeRef || { current: false };
      g.__pipInSystemModeRef.current = false;
      g.__currentCallPiPParamsRef = g.__currentCallPiPParamsRef || { current: null };
      g.__currentCallPiPParamsRef.current = null;
      g.__outgoingCallMediaRef = g.__outgoingCallMediaRef || { current: null };
      g.__outgoingCallMediaRef.current = null;
      g.__onVideoCallEndedRef?.current?.();
    } catch {}
  }, []);

  const teardownOutgoingAttemptSubs = useCallback(() => {
    try {
      const g = global as any;
      const fn = g.__outgoingAttemptTeardownRef?.current;
      if (typeof fn === 'function') {
        fn();
      }
      if (g.__outgoingAttemptTeardownRef) {
        g.__outgoingAttemptTeardownRef.current = null;
      }
    } catch {}
  }, []);

  const closeAndCancelOutgoingBeforeRetry = useCallback((
    callId: string | null | undefined,
    source: string,
    options?: { skipNativeClose?: boolean },
  ) => {
    const id = String(callId || '').trim();
    lastOutgoingNativeCloseBeforeRetryAtRef.current = Date.now();
    if (!id) return;
    logger.info('[HomeScreen] closing previous outgoing before retry', {
      source,
      callId: id,
      skipNativeClose: !!options?.skipNativeClose,
    });
    if (!options?.skipNativeClose) {
      try { closeOutgoingCallActivity(id, { force: true }); } catch {}
    }
    try { cancelCall(id); } catch {}
    setTimeout(() => { try { cancelCall(id); } catch {} }, 150);
    void ensureSocketConnected(SOCKET_CONNECT_WAIT_MS)
      .then(() => { try { cancelCall(id); } catch {} })
      .catch(() => {});
  }, []);

  const waitForOutgoingNativeCloseBeforeRetry = useCallback(async (source: string) => {
    const elapsed = Date.now() - lastOutgoingNativeCloseBeforeRetryAtRef.current;
    if (elapsed < 0 || elapsed >= OUTGOING_NATIVE_CLOSE_BEFORE_RETRY_MS) return;
    const waitMs = OUTGOING_NATIVE_CLOSE_BEFORE_RETRY_MS - elapsed;
    logger.info('[HomeScreen] waiting for outgoing native close before retry', { source, waitMs });
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }, []);

  /** Перед тапом по чату/звонку: снять залипшие refs и не мешать Swipeable. */
  const clearNativeCanceledOutgoingAttempt = useCallback((source: string) => {
    const canceledByNative =
      typeof global !== 'undefined' &&
      (global as any).__outgoingCanceledByNativeRef?.current === true;
    if (!canceledByNative || activeOutgoingAttemptRef.current <= 0) return false;
    const resolvedCallId =
      activeOutgoingCallIdRef.current ||
      calling.callId ||
      String((global as any).__outgoingCallIdRef?.current || '').trim() ||
      null;
    try {
      (global as any).__outgoingCanceledByNativeRef.current = false;
    } catch {}
    logger.info('[HomeScreen] cleared native-canceled outgoing attempt before retry', {
      source,
      activeOutgoingAttempt: activeOutgoingAttemptRef.current,
      activeOutgoingCallId: activeOutgoingCallIdRef.current,
      resolvedCallId,
      callingVisibleRef: callingVisibleRef.current,
    });
    closeAndCancelOutgoingBeforeRetry(resolvedCallId, source);
    activeOutgoingAttemptRef.current = 0;
    activeOutgoingCallIdRef.current = null;
    outgoingAttemptSeqRef.current += 1;
    pendingCancelRef.current = false;
    outgoingCallUserCanceledRef.current = false;
    try { setOutgoingCallScreenVisible(false); } catch {}
    callingVisibleRef.current = false;
    setCalling((prev) =>
      prev.visible || prev.friend || prev.callId
        ? { visible: false, friend: null, callId: null }
        : prev,
    );
    setSwipeActionsHiddenForCall(null);
    return true;
  }, [calling.callId, closeAndCancelOutgoingBeforeRetry]);

  const prepareFriendRowActionTap = useCallback(() => {
    try {
      openSwipeableRef.current?.close?.();
    } catch {}
    try {
      const g = global as any;
      if (g.__videoCallActiveRef?.current === true && !isDirectCallSessionLive(g)) {
        forceResetCallBusyRefs();
      }
    } catch {}
    clearNativeCanceledOutgoingAttempt('prepareFriendRowActionTap');
    clearStaleOutgoingAttemptIfIdle();
    if (activeOutgoingAttemptRef.current > 0 && !callingVisibleRef.current) {
      activeOutgoingAttemptRef.current = 0;
      activeOutgoingCallIdRef.current = null;
      outgoingAttemptSeqRef.current += 1;
    }
  }, [clearNativeCanceledOutgoingAttempt, clearStaleOutgoingAttemptIfIdle, forceResetCallBusyRefs]);

  // ВАЖНО: не закрываем исходящий UI на socket 'connect'.
  // Иначе при старте звонка из вкладки «Друзья» (HomeScreen смонтирован) нативный исходящий экран
  // может закрываться сразу же, если сокет в этот момент переподключается/доподключается.
  // Закрытие исходящего уже покрыто событиями call:declined/cancel/timeout + локальным safeguard-таймаутом.

  // Ref текущего исходящего callId — fallback для App: при подключении сокета запросить call:accepted, если FCM не сработал (инициатор на нативном экране)
  useEffect(() => {
    (global as any).__outgoingCallIdRef = (global as any).__outgoingCallIdRef ?? { current: null };
    (global as any).__outgoingCallPeerUserIdRef = (global as any).__outgoingCallPeerUserIdRef ?? { current: null };
    (global as any).__outgoingCallIdRef.current = calling.visible && calling.callId ? calling.callId : null;
    (global as any).__outgoingCallPeerUserIdRef.current =
      calling.visible && calling.friend?.id ? String(calling.friend.id) : null;
    if (Platform.OS === 'android' && calling.visible && calling.callId) {
      const media = (global as any).__outgoingCallMediaRef?.current;
      if (media === 'video') {
        const nick = trimNick(calling.friend?.nick || calling.friend?.name || '');
        try {
          primeAndroidCallContextForLeaveHint({
            callId: calling.callId,
            partnerNick: nick || null,
          });
          setActiveVideoCall(true, nick || null);
        } catch (_) {}
      }
    }
    return () => {
      if ((global as any).__outgoingCallIdRef?.current === calling.callId) {
        (global as any).__outgoingCallIdRef.current = null;
      }
      if (
        calling.friend?.id &&
        (global as any).__outgoingCallPeerUserIdRef?.current === String(calling.friend.id)
      ) {
        (global as any).__outgoingCallPeerUserIdRef.current = null;
      }
    };
  }, [calling.visible, calling.callId, calling.friend]);

  /** call:accepted — только снять исходящий UI; не cancelCall, не forceResetCallBusyRefs (App уже на VideoCall). */
  const resetOutgoingAfterCallAccepted = useCallback((source = 'accepted') => {
    activeOutgoingAttemptRef.current = 0;
    activeOutgoingCallIdRef.current = null;
    pendingCancelRef.current = false;
    try { setOutgoingCallScreenVisible(false); } catch {}
    callingVisibleRef.current = false;
    setCalling((prev) =>
      prev.visible || prev.friend || prev.callId
        ? { visible: false, friend: null, callId: null }
        : prev,
    );
    setSwipeActionsHiddenForCall(null);
    try {
      const g = global as any;
      if (g.__outgoingCallUiActiveRef) g.__outgoingCallUiActiveRef.current = false;
      if (g.__activeOutgoingAttemptRef) g.__activeOutgoingAttemptRef.current = 0;
    } catch {}
    logger.info('[HomeScreen] reset outgoing after call accepted (light)', { source });
  }, []);

  // Закрытие модалки исходящего по событию извне (абонент отклонил на нативном экране/отменил/таймаут — событие приходит в App, эмитится emitCloseOutgoingCall)
  const resetOutgoingAfterExternalClose = useCallback((source = 'external', eventCallId?: string | null) => {
    const closeCallId = String(eventCallId || '').trim();
    const currentCallId = String(
      activeOutgoingCallIdRef.current || calling.callId || (global as any).__outgoingCallIdRef?.current || '',
    ).trim();
    const isActiveOutgoingAttempt = activeOutgoingAttemptRef.current > 0;
    const isNativeCancel = source.includes('native_cancel');
    const canceledByNative = (global as any).__outgoingCanceledByNativeRef?.current === true;
    const resolvedCloseCallId = closeCallId || (isNativeCancel ? currentCallId : '');
    const allowUnscopedActiveReset =
      source === 'call-press-stale-outgoing' ||
      source === 'video-start-native-flag';
    const allowScopedActiveReset =
      allowUnscopedActiveReset ||
      isNativeCancel ||
      source.includes('remote_closed');
    if (
      resolvedCloseCallId &&
      isActiveOutgoingAttempt &&
      (!currentCallId || resolvedCloseCallId !== currentCallId)
    ) {
      logger.info('[HomeScreen] reset outgoing after external close skipped stale callId', {
        source,
        closeCallId,
        resolvedCloseCallId,
        currentCallId: currentCallId || null,
        activeOutgoingAttempt: activeOutgoingAttemptRef.current,
        callingVisibleRef: callingVisibleRef.current,
      });
      return;
    }
    // Поздний remote_closed после native_cancel: UI уже сброшен — не травим следующий startCall
    // (pendingCancel/seq bump → cancel только что созданного callId → not_found на accept).
    if (
      source.includes('remote_closed') &&
      resolvedCloseCallId &&
      !isActiveOutgoingAttempt &&
      !currentCallId &&
      !callingVisibleRef.current
    ) {
      logger.info('[HomeScreen] reset outgoing after external close skipped late remote_closed', {
        source,
        closeCallId: resolvedCloseCallId,
        sinceLastMs: Date.now() - lastOutgoingExternalCloseResetAtRef.current,
      });
      return;
    }
    if (!resolvedCloseCallId && isActiveOutgoingAttempt && !allowUnscopedActiveReset) {
      if (!(isNativeCancel && canceledByNative)) {
        logger.info('[HomeScreen] reset outgoing after external close skipped unscoped active call', {
          source,
          currentCallId: currentCallId || null,
          activeOutgoingAttempt: activeOutgoingAttemptRef.current,
          callingVisibleRef: callingVisibleRef.current,
        });
        return;
      }
    }
    if (resolvedCloseCallId && isActiveOutgoingAttempt && resolvedCloseCallId === currentCallId && !allowScopedActiveReset) {
      logger.info('[HomeScreen] reset outgoing after external close skipped duplicate active call', {
        source,
        closeCallId,
        resolvedCloseCallId,
        currentCallId,
        activeOutgoingAttempt: activeOutgoingAttemptRef.current,
        callingVisibleRef: callingVisibleRef.current,
      });
      return;
    }
    const hadOutgoingState =
      activeOutgoingAttemptRef.current > 0 ||
      callingVisibleRef.current ||
      calling.visible ||
      !!calling.friend ||
      !!calling.callId ||
      !!openSwipeableRef.current ||
      !!markReadMenu;
    const now = Date.now();
    const duplicateReset = !hadOutgoingState && now - lastOutgoingExternalCloseResetAtRef.current < 900;
    if (duplicateReset) {
      logger.info('[HomeScreen] reset outgoing after external close skipped duplicate', {
        source,
        appState: AppState.currentState,
        sinceLastMs: now - lastOutgoingExternalCloseResetAtRef.current,
      });
      return;
    }
    lastOutgoingExternalCloseResetAtRef.current = now;
    teardownOutgoingAttemptSubs();
    const callIdToCancel = currentCallId;
    logger.info('[HomeScreen] reset outgoing after external close', {
      source,
      closeCallId: closeCallId || null,
      resolvedCloseCallId: resolvedCloseCallId || null,
      currentCallId: currentCallId || null,
      appState: AppState.currentState,
      activeOutgoingAttempt: activeOutgoingAttemptRef.current,
      callingVisibleRef: callingVisibleRef.current,
      callingVisible: calling.visible,
      hasMarkReadMenu: !!markReadMenu,
      openSwipeable: !!openSwipeableRef.current,
    });
    const outgoingPeerId =
      (calling.friend?.id != null ? String(calling.friend.id) : '') ||
      String(lastOutgoingPeerIdRef.current || '');
    disposeDirectCallAudioPrewarm(`home:outgoing-external-close:${source}`);
    activeOutgoingAttemptRef.current = 0;
    activeOutgoingCallIdRef.current = null;
    // Invalidate in-flight handleStartDirectCall (isCurrentAttempt) even if a new start bumps active again.
    outgoingAttemptSeqRef.current += 1;
    // call-press-stale / video-start-native-flag: чистим UI чтобы сразу набрать снова.
    // pendingCancel=true здесь отравляет следующий startCall (cancel только что созданного callId).
    const isRetryClear =
      source === 'call-press-stale-outgoing' || source === 'video-start-native-flag';
    if (isRetryClear) {
      pendingCancelRef.current = false;
      outgoingCallUserCanceledRef.current = false;
    } else {
      outgoingCancelEpochRef.current += 1;
      pendingCancelRef.current = true;
      outgoingCallUserCanceledRef.current = true;
    }
    const declinedAlready = callIdToCancel ? isOutgoingDeclineHandled(callIdToCancel) : false;
    const shouldSendCancelForNativeCancel = isNativeCancel && !closeCallId && !!resolvedCloseCallId;
    if (callIdToCancel && (!canceledByNative || shouldSendCancelForNativeCancel) && !declinedAlready) {
      const sendCancel = () => {
        try { cancelCall(callIdToCancel); } catch {}
      };
      sendCancel();
      setTimeout(sendCancel, 150);
      void ensureSocketConnected(SOCKET_CONNECT_WAIT_MS)
        .then(sendCancel)
        .catch(() => {});
    }
    try {
      const g = global as any;
      if (g.__outgoingCanceledByNativeRef) g.__outgoingCanceledByNativeRef.current = false;
    } catch {}
    if (isNativeCancel && resolvedCloseCallId) {
      closeAndCancelOutgoingBeforeRetry(resolvedCloseCallId, source, {
        skipNativeClose: canceledByNative,
      });
    }
    try { setOutgoingCallScreenVisible(false); } catch {}
    // Важно: ставим ref сразу, чтобы следующий tap не упёрся в stale calling.visible до рендера.
    callingVisibleRef.current = false;
    try {
      const g = global as any;
      if (g.__outgoingCallUiActiveRef) g.__outgoingCallUiActiveRef.current = false;
      if (g.__activeOutgoingAttemptRef) g.__activeOutgoingAttemptRef.current = 0;
    } catch {}
    setCalling((prev) => (
      prev.visible || prev.friend || prev.callId
        ? { visible: false, friend: null, callId: null }
        : prev
    ));
    setSwipeActionsHiddenForCall(null);
    try { openSwipeableRef.current?.close?.(); } catch {}
    openSwipeableRef.current = null;
    if (hadOutgoingState) {
      setFriendActionsGestureResetSeq((seq) => seq + 1);
    }
    forceResetCallBusyRefs();
    clearFriendsCallBusy([outgoingPeerId, lastOutgoingPeerIdRef.current]);
    lastOutgoingPeerIdRef.current = null;
  }, [calling.visible, calling.friend, calling.callId, markReadMenu, closeAndCancelOutgoingBeforeRetry, teardownOutgoingAttemptSubs, forceResetCallBusyRefs, clearFriendsCallBusy]);

  useEffect(() => {
    const off = onCallCanceled?.((d) => {
      const callerId = String((d as any)?.from || '').trim();
      const eventCallId = String((d as any)?.callId || '').trim();
      const currentCallId = String(activeOutgoingCallIdRef.current || calling.callId || '').trim();
      if (
        eventCallId &&
        activeOutgoingAttemptRef.current > 0 &&
        (!currentCallId || eventCallId !== currentCallId)
      ) {
        logger.info('[HomeScreen] onCallCanceled skipped stale outgoing event', {
          eventCallId,
          currentCallId: currentCallId || null,
          activeOutgoingAttempt: activeOutgoingAttemptRef.current,
        });
        return;
      }
      const isOurOutgoing =
        activeOutgoingAttemptRef.current > 0 ||
        callingVisibleRef.current ||
        !!currentCallId ||
        !!String(lastOutgoingPeerIdRef.current || '').trim();
      // Callee: не трогаем setState здесь — иначе ре-рендер Home в момент finish Incoming.
      // Busy/тост сбрасывает App через deferred emitCallCancelledOnHome + presence:update.
      if (!isOurOutgoing) {
        return;
      }
      const peerId = String(lastOutgoingPeerIdRef.current || '').trim();
      forceResetCallBusyRefs();
      clearFriendsCallBusy([callerId, peerId]);
      lastOutgoingPeerIdRef.current = null;
      activeOutgoingAttemptRef.current = 0;
      activeOutgoingCallIdRef.current = null;
      callingVisibleRef.current = false;
      setCalling((prev) =>
        prev.visible || prev.friend || prev.callId
          ? { visible: false, friend: null, callId: null }
          : prev,
      );
      setSwipeActionsHiddenForCall(null);
    });
    return off;
  }, [calling.callId, clearFriendsCallBusy, forceResetCallBusyRefs]);

  useEffect(() => {
    const unsub = onCloseOutgoingCall((payload) => {
      if (payload?.reason === 'accepted') {
        resetOutgoingAfterCallAccepted('onCloseOutgoingCall-accepted');
        return;
      }
      // Даже если callingVisibleRef уже false, активная async-попытка могла ещё ждать startCall.
      resetOutgoingAfterExternalClose(`onCloseOutgoingCall:${payload?.reason ?? 'external'}`, payload?.callId);
    });
    return unsub;
  }, [resetOutgoingAfterCallAccepted, resetOutgoingAfterExternalClose]);

  // Закрытие модалок «Поддержать LiVi» и «Пригласи друга» при переходе на видеозвонок (чтобы экран VideoCall был поверх)
  useEffect(() => {
    const unsub = onCloseHomeModals(() => {
      setDonateVisible(false);
      setShareVisible(false);
    });
    return unsub;
  }, []);

  // Сброс скрытия правых действий свайпа, когда исходящий вызов закрыт (убирает мелькание кнопки «Удалить»)
  useEffect(() => {
    if (!calling.visible) setSwipeActionsHiddenForCall(null);
  }, [calling.visible]);

  // Закрытие по call:declined делают App (closeOutgoingCallActivity) + offDeclined в handleStartVideoCall (setCalling, showNotice).
  // Прямую подписку socket.on('call:declined') убрали — она давала второй setCalling и двойное мерцание.

  const handleStartDirectCall = useCallback(async (friend: Friend, media: 'audio' | 'video' = 'video') => {
    const gStart = global as any;
    gStart.__outgoingStartInFlightRef = gStart.__outgoingStartInFlightRef || { current: false };
    if (gStart.__outgoingStartInFlightRef.current) {
      logger.info('[HomeScreen] skip duplicate outgoing start (already in flight)', {
        friendId: friend.id,
        media,
      });
      return;
    }
    gStart.__outgoingStartInFlightRef.current = true;
    try {
    const canceledByNative =
      typeof global !== 'undefined' &&
      (global as any).__outgoingCanceledByNativeRef?.current === true;
    if (canceledByNative) {
      if (!clearNativeCanceledOutgoingAttempt('handleStartDirectCall')) {
        resetOutgoingAfterExternalClose('video-start-native-flag');
      }
    }
    if (activeOutgoingAttemptRef.current > 0) {
      clearStaleOutgoingAttemptIfIdle();
      if (activeOutgoingAttemptRef.current > 0 && callingVisibleRef.current) {
        return;
      }
      if (activeOutgoingAttemptRef.current > 0) {
        activeOutgoingAttemptRef.current = 0;
        activeOutgoingCallIdRef.current = null;
        outgoingAttemptSeqRef.current += 1;
      }
    }
    if (callingVisibleRef.current) {
      try { setOutgoingCallScreenVisible(false); } catch {}
      callingVisibleRef.current = false;
      setCalling({ visible: false, friend: null, callId: null });
    }
    const attemptId = ++outgoingAttemptSeqRef.current;
    activeOutgoingAttemptRef.current = attemptId;
    activeOutgoingCallIdRef.current = null;
    try {
      const g = global as any;
      g.__activeOutgoingAttemptRef = g.__activeOutgoingAttemptRef || { current: 0 };
      g.__activeOutgoingAttemptRef.current = attemptId;
      g.__outgoingCallUiActiveRef = g.__outgoingCallUiActiveRef || { current: false };
      g.__outgoingCallUiActiveRef.current = true;
    } catch {}
    const isCurrentAttempt = () => activeOutgoingAttemptRef.current === attemptId;
    const friendName = friend.name ?? '';
    requestAnimationFrame(() => {
      setSwipeActionsHiddenForCall(friend.id);
      openSwipeableRef.current?.close?.();
    });
    clearOutgoingDeclineHandled();
    const callKeepReadyPromise =
      Platform.OS === 'android'
        ? isCallKeepAvailable()
          ? Promise.resolve(true)
          : setupCallKeep({ requestPermission: false })
        : Promise.resolve(true);
    try {
      warmCallSignaling();
      prefetchDirectCallIce('home:direct-call-start');
      // Audio prewarm нельзя стартовать на исходящем: mic capture глушит native ringback
      // (LiviOutgoingCallService). Prewarm mic — после call:accepted в App.tsx.
      // На redial после прошлого звонка сбрасываем залипший prewarm/mic.
      disposeDirectCallAudioPrewarm('home:outgoing-start');
      pendingCancelRef.current = false;
      outgoingCallUserCanceledRef.current = false;
      try {
        (global as any).__outgoingCanceledByNativeRef =
          (global as any).__outgoingCanceledByNativeRef || { current: false };
        (global as any).__outgoingCanceledByNativeRef.current = false;
      } catch {}
      const cancelEpochAtStart = outgoingCancelEpochRef.current;
      lastOutgoingPeerIdRef.current = String(friend.id);
      try {
        (global as any).__outgoingCallMediaRef = { current: media };
      } catch {}
      setCalling({ visible: true, friend, callId: null });
      callingVisibleRef.current = true;
      // Сразу помечаем «исходящий на экране», чтобы сокет не отключался при уходе в фон (диалог разрешений).
      // Иначе звонок не дойдёт до абонента (startCall по сокету).
      setOutgoingCallScreenVisible(true);
      await waitForOutgoingNativeCloseBeforeRetry('handleStartDirectCall');
      if (!isCurrentAttempt()) {
        try { setOutgoingCallScreenVisible(false); } catch {}
        try { closeOutgoingCallActivity(null, { force: true }); } catch {}
        return;
      }

      displayOutgoingCallImmediate(friend.id, friendName, media !== 'audio');

      if (Platform.OS === 'android') {
        await callKeepReadyPromise;
      }
      if (!isCurrentAttempt()) {
        try { setOutgoingCallScreenVisible(false); } catch {}
        try { closeOutgoingCallActivity(null, { force: true }); } catch {}
        return;
      }

      // Подписки ДО await startCall: иначе call:declined может прийти раньше регистрации → calling остаётся true → кнопки звонка глобально disabled.
      const socketUnsubs: Array<() => void> = [];
      let outgoingFinished = false;
      let safeguardTimer: ReturnType<typeof setTimeout> | null = null;

      const removeAllSocketSubs = () => {
        for (const u of socketUnsubs) {
          try {
            u();
          } catch {}
        }
        socketUnsubs.length = 0;
        if (safeguardTimer != null) {
          clearTimeout(safeguardTimer);
          safeguardTimer = null;
        }
        try {
          const g = global as any;
          if (g.__outgoingAttemptTeardownRef?.current === removeAllSocketSubs) {
            g.__outgoingAttemptTeardownRef.current = null;
          }
        } catch {}
      };

      try {
        const g = global as any;
        g.__outgoingAttemptTeardownRef = g.__outgoingAttemptTeardownRef || { current: null };
        g.__outgoingAttemptTeardownRef.current = removeAllSocketSubs;
      } catch {}

      const finishOutgoing = (body: () => void) => {
        if (outgoingFinished) return;
        outgoingFinished = true;
        if (isCurrentAttempt()) {
          activeOutgoingAttemptRef.current = 0;
          activeOutgoingCallIdRef.current = null;
        }
        removeAllSocketSubs();
        body();
      };

      const sub = (off: (() => void) | undefined) => {
        if (off) socketUnsubs.push(off);
      };

      const shouldHandleOutgoingEvent = (eventName: string, rawCallId?: string | null) => {
        if (!isCurrentAttempt()) return false;
        const eventCallId = String(rawCallId || '').trim();
        const currentCallId = String(activeOutgoingCallIdRef.current || '').trim();
        if (eventCallId && (!currentCallId || eventCallId !== currentCallId)) {
          logger.info('[HomeScreen] skipped stale outgoing socket event', {
            eventName,
            eventCallId,
            currentCallId: currentCallId || null,
            activeOutgoingAttempt: activeOutgoingAttemptRef.current,
          });
          return false;
        }
        if (!eventCallId && currentCallId) {
          logger.info('[HomeScreen] skipped unscoped outgoing socket event', {
            eventName,
            currentCallId,
            activeOutgoingAttempt: activeOutgoingAttemptRef.current,
          });
          return false;
        }
        return true;
      };

      sub(
        onCallAccepted?.(({ callId }) => {
          finishOutgoing(() => {
            logger.debug('Call accepted', { callId });
            if (callId) try { reportEndCallToCallKeep(callId); } catch {}
            try { setOutgoingCallScreenVisible(false); } catch {}
            try {
              const friendIdStr = String(friend.id);
              if (Platform.OS === 'android') {
                try { NativeModules.LiviAppModule?.cancelMissedCallNotificationForUser?.(friendIdStr); } catch (_) {}
              }
              setMissedByUser((prev) => {
                const next = { ...prev };
                if (next[friendIdStr] !== undefined) {
                  delete next[friendIdStr];
                }
                AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(next)).catch(() => {});
                logger.debug('[HomeScreen] Reset missed calls for accepted call (removed key)', { friendId: friendIdStr });
                return next;
              });
            } catch (e) {
              logger.warn('[HomeScreen] Error resetting missed calls for accepted call:', e);
            }
            callingVisibleRef.current = false;
            setCalling({ visible: false, friend: null, callId: null });
          });
        }),
      );

      sub(
        onCallDeclined?.((d) => {
          const eventCallId = String((d as any)?.callId || '').trim();
          if (!shouldHandleOutgoingEvent('call:declined', eventCallId)) return;
          finishOutgoing(() => {
            disposeDirectCallAudioPrewarm('home:outgoing-declined');
            logger.info('[decline/инициатор] HomeScreen offDeclined: setCalling(false), showNotice');
            try { setOutgoingCallScreenVisible(false); } catch {}
            forceResetCallBusyRefs();
            clearFriendsCallBusy([String(friend.id), lastOutgoingPeerIdRef.current]);
            lastOutgoingPeerIdRef.current = null;
            callingVisibleRef.current = false;
            setCalling({ visible: false, friend: null, callId: null });
            setSwipeActionsHiddenForCall(null);
            showNotice(t('callDeclined', lang), 'error', 3000);
          });
        }),
      );

      sub(
        onCallTimeout?.((d) => {
          const eventCallId = String((d as any)?.callId || '').trim();
          if (!shouldHandleOutgoingEvent('call:timeout', eventCallId)) return;
          finishOutgoing(() => {
            disposeDirectCallAudioPrewarm('home:outgoing-timeout');
            try { setOutgoingCallScreenVisible(false); } catch {}
            try { closeOutgoingCallActivity(eventCallId || null, { force: true }); } catch {}
            forceResetCallBusyRefs();
            clearFriendsCallBusy([String(friend.id), lastOutgoingPeerIdRef.current]);
            lastOutgoingPeerIdRef.current = null;
            callingVisibleRef.current = false;
            setCalling({ visible: false, friend: null, callId: null });
          });
        }),
      );

      sub(
        onCallRoomFull?.(() => {
          finishOutgoing(() => {
            disposeDirectCallAudioPrewarm('home:outgoing-room-full');
            clearFriendsCallBusy([String(friend.id), lastOutgoingPeerIdRef.current]);
            lastOutgoingPeerIdRef.current = null;
            callingVisibleRef.current = false;
            setCalling({ visible: false, friend: null, callId: null });
            setRoomFull({ visible: true, name: friend.name || '' });
            setTimeout(() => setRoomFull({ visible: false, name: '' }), 2000);
          });
        }),
      );

      sub(
        onCallCanceled?.((d) => {
          const eventCallId = String((d as any)?.callId || '').trim();
          if (!shouldHandleOutgoingEvent('call:cancel', eventCallId)) return;
          finishOutgoing(() => {
            disposeDirectCallAudioPrewarm('home:outgoing-canceled');
            try { setOutgoingCallScreenVisible(false); } catch {}
            try { closeOutgoingCallActivity(eventCallId || null, { force: true }); } catch {}
            forceResetCallBusyRefs();
            clearFriendsCallBusy([String(friend.id), lastOutgoingPeerIdRef.current]);
            lastOutgoingPeerIdRef.current = null;
            callingVisibleRef.current = false;
            setCalling({ visible: false, friend: null, callId: null });
          });
        }),
      );

      let r: any;
      try {
        r = await startCall(friend.id, media === 'audio' ? { media: 'audio' } : undefined);
      } catch (startErr) {
        if (!outgoingFinished) {
          outgoingFinished = true;
          if (isCurrentAttempt()) {
            activeOutgoingAttemptRef.current = 0;
            activeOutgoingCallIdRef.current = null;
          }
          removeAllSocketSubs();
        }
        throw startErr;
      }

      if (!isCurrentAttempt()) {
        const orphanCallId = String(r?.callId || '').trim();
        const newerActiveCallId = String(activeOutgoingCallIdRef.current || '').trim();
        // Гасим orphan этой попытки, но не callId новой исходящей.
        if (orphanCallId && orphanCallId !== newerActiveCallId) {
          logger.info('[HomeScreen] cancel orphan outgoing from stale attempt', {
            orphanCallId,
            newerActiveCallId: newerActiveCallId || null,
            attemptId,
            activeOutgoingAttempt: activeOutgoingAttemptRef.current,
          });
          try { cancelCall(orphanCallId); } catch {}
        }
        if (!outgoingFinished) {
          outgoingFinished = true;
          removeAllSocketSubs();
        }
        return;
      }

      if (!r?.ok) {
        if (!outgoingFinished) {
          outgoingFinished = true;
          if (isCurrentAttempt()) {
            activeOutgoingAttemptRef.current = 0;
            activeOutgoingCallIdRef.current = null;
          }
          removeAllSocketSubs();
        }
        throw new Error(r?.error || 'call_failed');
      }

      // Отклонение/таймаут пришли по сокету до ack startCall — UI уже сброшен; синхронизируем сервер.
      if (outgoingFinished) {
        const finishedCallId = String(r.callId || '').trim();
        const newerActiveCallId = String(activeOutgoingCallIdRef.current || '').trim();
        if (finishedCallId && finishedCallId !== newerActiveCallId) {
          try { cancelCall(finishedCallId); } catch {}
        }
        if (isCurrentAttempt()) {
          activeOutgoingAttemptRef.current = 0;
          activeOutgoingCallIdRef.current = null;
        }
        return;
      }

      setCalling((c) => ({ ...c, callId: r.callId || null }));
      activeOutgoingCallIdRef.current = r.callId || null;

      if (r.callId) {
        notifyOutgoingCallId(r.callId);
        try { setCallMediaHint(r.callId, media); } catch {}
      }

      // Только cancel, случившийся после старта этой попытки (epoch).
      // Stale OutgoingCallCanceledByUser может выставить native-флаг без reset — его игнорируем.
      const canceledDuringThisAttempt = outgoingCancelEpochRef.current !== cancelEpochAtStart;
      if (canceledDuringThisAttempt && r.callId) {
        try {
          (global as any).__outgoingCanceledByNativeRef &&
            ((global as any).__outgoingCanceledByNativeRef.current = false);
        } catch {}
        logger.info('[HomeScreen] cancel outgoing after start (canceled during attempt)', {
          callId: r.callId,
          pendingCancel: pendingCancelRef.current,
          epochAtStart: cancelEpochAtStart,
          epochNow: outgoingCancelEpochRef.current,
        });
        try { cancelCall(r.callId); } catch {}
        pendingCancelRef.current = false;
        finishOutgoing(() => {
          disposeDirectCallAudioPrewarm('home:outgoing-canceled-after-start');
          try { setOutgoingCallScreenVisible(false); } catch {}
          try { closeOutgoingCallActivity(r.callId || null, { force: true }); } catch {}
          forceResetCallBusyRefs();
          clearFriendsCallBusy([String(friend.id), lastOutgoingPeerIdRef.current]);
          lastOutgoingPeerIdRef.current = null;
          callingVisibleRef.current = false;
          setCalling({ visible: false, friend: null, callId: null });
        });
        return;
      }

      const callIdForTimeout = r.callId;
      safeguardTimer = setTimeout(() => {
        finishOutgoing(() => {
          disposeDirectCallAudioPrewarm('home:outgoing-safeguard-timeout');
          try { setOutgoingCallScreenVisible(false); } catch {}
          try { closeOutgoingCallActivity(callIdForTimeout || null, { force: true }); } catch {}
          if (callIdForTimeout) try { reportEndCallToCallKeep(callIdForTimeout); } catch {}
          forceResetCallBusyRefs();
          clearFriendsCallBusy([String(friend.id), lastOutgoingPeerIdRef.current]);
          lastOutgoingPeerIdRef.current = null;
          callingVisibleRef.current = false;
          setCalling({ visible: false, friend: null, callId: null });
          showNotice(t('noAnswer', lang), 'error', 3000);
        });
      }, OUTGOING_CALL_TIMEOUT_MS);
    } catch (e: any) {
      const errCode = String(e?.message ?? e ?? '').trim();
      logger.warn('[outgoing] handleStartDirectCall failed', { error: errCode, media });
      teardownOutgoingAttemptSubs();
      disposeDirectCallAudioPrewarm('home:outgoing-start-failed');
      if (isCurrentAttempt()) {
        activeOutgoingAttemptRef.current = 0;
        activeOutgoingCallIdRef.current = null;
      }
      try { setOutgoingCallScreenVisible(false); } catch {}
      try { closeOutgoingCallActivity(activeOutgoingCallIdRef.current || calling.callId || null, { force: true }); } catch {}
      forceResetCallBusyRefs();
      clearFriendsCallBusy([String(friend.id), lastOutgoingPeerIdRef.current]);
      if (errCode === 'initiator_busy' || errCode === 'busy') {
        try {
          const staleCallId =
            String((global as any).__pendingCallAcceptedRef?.current?.callId || '').trim() ||
            String((global as any).__outgoingCallIdRef?.current || '').trim() ||
            undefined;
          forceEndDirectCallWithPeer(String(friend.id), staleCallId || undefined);
        } catch {}
      }
      callingVisibleRef.current = false;
      setCalling({ visible: false, friend: null, callId: null });
      const canceledByNative =
        typeof global !== 'undefined' &&
        (global as any).__outgoingCanceledByNativeRef?.current === true;
      const skipNetworkBanner =
        outgoingCallUserCanceledRef.current ||
        pendingCancelRef.current ||
        canceledByNative;
      if (!skipNetworkBanner) {
        showNotice(t('callStartFailed', lang), 'error', 3000);
      }
      if (canceledByNative) {
        try {
          (global as any).__outgoingCanceledByNativeRef.current = false;
        } catch {}
      }
    }
    } finally {
      gStart.__outgoingStartInFlightRef.current = false;
    }
  }, [navigation, showNotice, resetOutgoingAfterExternalClose, clearNativeCanceledOutgoingAttempt, clearStaleOutgoingAttemptIfIdle, waitForOutgoingNativeCloseBeforeRetry, teardownOutgoingAttemptSubs, forceResetCallBusyRefs, clearFriendsCallBusy, lang]);

  const handleStartFriendCall = useCallback(
    (friend: Friend) => handleStartDirectCall(friend, 'audio'),
    [handleStartDirectCall],
  );


  /* ===== safe attachIdentity wrapper (queue if socket offline) ===== */
  const attachIdentitySafe = useCallback(
    async (params: { installId?: string | null; profile?: { nick?: string; avatar?: string } | null; }): Promise<{ ok: boolean; error?: string; userId?: string }> => {
      // Защита от дублирования запросов
      if (attachIdentityRef.current) {
        return attachIdentityRef.current;
      }
      
      const promise = (async () => {
        try {
          const s: any = socket as any;

          // ВАЖНО: не отправляем профиль, если пользователя ещё нет
          // Это предотвращает "воскрешение" удалённых данных из черновика
          const currentUserId = getCurrentUserId();
          const hasUser = !!currentUserId;

          let profilePayload: any = {};

          if (hasUser && params?.profile) {
            // Только если пользователь уже существует - отправляем профиль
            if ('nick' in params.profile) profilePayload.nick = String(params.profile.nick ?? '');
            if ('avatar' in params.profile) profilePayload.avatar = String((params.profile as any).avatar ?? '');
          } else {
            // Если пользователя нет - отправляем пустой профиль
            profilePayload = {};
          }

          // Дополнительная проверка: если пользователь уже существует и нет изменений профиля - пропускаем
          if (hasUser && Object.keys(profilePayload).length === 0) {
            return { ok: true, userId: currentUserId };
          }

          // React state `installId` на первом запуске может ещё быть '' (гонка с createUser).
          // Всегда резолвим через getInstallId(), иначе сервер отвечает no_installId.
          const resolvedInstallId = String(params?.installId || '').trim()
            || (await getInstallId().catch(() => ''));
          if (!resolvedInstallId) {
            console.warn('[attachIdentitySafe] no installId available yet');
            return { ok: false, error: 'no_installId' };
          }

          const payload = { installId: resolvedInstallId, profile: profilePayload };

          if (!s || !s.connected) { // очередь до коннекта
            pendingAttachRef.current = profilePayload;
            return { ok: true };
          }

          const result = await attachIdentity(payload);

          if (result?.ok) {
            pendingAttachRef.current = null;
          }

          // Сохраняем userId если получили его от сервера
          if (result.ok && result.userId) {
            const wasNewUser = !hasUser; // Это новый пользователь
            setCurrentUserId(result.userId);

            // Примечание: Отправка профиля для новых пользователей обрабатывается в ensureIdentity
            // Там есть доступ к текущему state (nick, avatarUri) который пользователь ввёл СЕЙЧАС
          } else if (result?.error === 'duplicate_request') {
            // КРИТИЧНО: duplicate_request означает, что первый запрос уже обрабатывается/обработан
            // Подождем немного и попробуем получить userId
            logger.debug('[attachIdentitySafe] duplicate_request received, waiting for first request to complete...');
            
            // Ждем немного, чтобы первый запрос успел обработаться
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Пробуем получить userId
            const existingUserId = await getMyUserId();
            
            if (existingUserId) {
              // Проверяем, существует ли пользователь на сервере
              const userExists = await checkUserExists(existingUserId);
              if (userExists) {
                // Пользователь существует - возвращаем успешный результат
                setCurrentUserId(existingUserId);
                pendingAttachRef.current = null;
                logger.debug('[attachIdentitySafe] User restored after duplicate_request', { existingUserId });
                return { ok: true, userId: existingUserId };
              } else {
                console.warn('[attachIdentitySafe] ⚠️ User from duplicate_request does not exist on server');
              }
            } else {
              console.warn('[attachIdentitySafe] ⚠️ Could not get userId after duplicate_request');
            }
            
            // Если не удалось получить userId, возвращаем ошибку
            console.error('[attachIdentitySafe] ❌ Attach failed: duplicate_request (could not restore userId)');
          } else {
            console.warn('[attachIdentitySafe] ⚠️ No userId in response!', result);
            if (!result.ok) {
              console.error('[attachIdentitySafe] ❌ Attach failed:', result.error);
            } else if (!result.userId) {
              console.error('[attachIdentitySafe] ❌ Response OK but no userId - server bug?');
            }
          }

          return result;
        } catch (err) {
        console.error('[attachIdentitySafe] ❌ Unexpected error:', err);
        return { ok: false, error: String(err) };
      }
      })();
      
      attachIdentityRef.current = promise;
      promise.finally(() => {
        attachIdentityRef.current = null;
      });
      return promise;
    },
    [],
  );

  /* ===== syncUserData - проверка существования пользователя ===== */
  const syncUserData = useCallback(async (): Promise<boolean> => {
    try {
      // Проверяем что функции определены
      if (typeof getCurrentUserId !== 'function') {
        console.warn('[syncUserData] getCurrentUserId is not a function');
        return true; // Продолжаем загрузку данных
      }

      if (typeof checkUserExists !== 'function') {
        console.warn('[syncUserData] checkUserExists is not a function');
        return true; // Продолжаем загрузку данных
      }

      if (isCreateUserInProgress()) {
        try {
          await waitForCreateUserCompletion();
        } catch (e) {
          console.warn('[syncUserData] Waiting for createUser failed:', e);
        }
      }

      let currentUserId = getCurrentUserId();
      if (!currentUserId) {
        return true; // Продолжаем загрузку данных
      }

      // Проверяем существует ли пользователь в MongoDB
      let userExists = await checkUserExists(currentUserId);

      if (userExists === false) {
        const fromInstall = await refreshUserIdFromInstall();
        if (fromInstall) {
          currentUserId = fromInstall;
          userExists = await checkUserExists(fromInstall);
        }
      }

      if (userExists === null) {
        return true;
      }
      
      if (userExists === false) {
        console.warn('[syncUserData] User not found on server, performing hard reset...');

        // Если пользователь уже начал вводить ник (пока мы ждём checkUserExists),
        // сохраняем ввод, чтобы resetAllState не "съедал" первый символ.
        const preservedNick = nickInputDirtyRef.current ? String(nickLiveRef.current || '').trim() : '';
        
        // Жёсткий локальный сброс
        if (typeof hardLocalReset === 'function') {
          await hardLocalReset();
        }
        
        if (typeof resetAllState === 'function') {
          resetAllState();
        }

        // Восстанавливаем ввод, если он уже был
        if (preservedNick) {
          nickLiveRef.current = preservedNick;
          nickInputDirtyRef.current = true;
          setNick(preservedNick);
          // держим draft актуальным даже после hard reset
          saveDraftProfile({ nick: preservedNick }).catch(() => {});
        }
        
        if (typeof showNotice === 'function') {
          showNotice(t('userDeletedDataCleared', lang), 'error', 3000);
        }
        return false; // Пользователь не существует
      }
      
      return true; // Пользователь существует
      
    } catch (error) {
      console.error('❌ Failed to sync user data:', error);
      // В случае ошибки не очищаем данные - возможно просто нет интернета
      return true; // Продолжаем загрузку данных
    }
  }, [showNotice, resetAllState]);

  /* ===== ensureIdentity ===== */
  const ensureIdentity = useCallback(async () => {
    // Защита от дублирования запросов
    if (ensureIdentityRef.current) {
      return ensureIdentityRef.current;
    }

    const promise = (async () => {
      // Если createUser уже выполняется (после установки), ждём его завершения, чтобы не слать параллельный attach
      if (isCreateUserInProgress()) {
        try {
          await waitForCreateUserCompletion();
        } catch (e) {
          console.warn('[ensureIdentity] Waiting for createUser failed:', e);
        }
      }

      const localInstallId = await getInstallId();
      setInstallId(localInstallId);

      // 1. Проверяем, есть ли userId
      const existingUserId = getCurrentUserId();

      // null = сервер временно недоступен; НЕ трактуем как "пользователя нет"
      let userExistsOnServer: boolean | null = null;

      let localNick = '';
      let cachedAvatar = '';
      let draftAvatar = '';

      // 2a. Сначала поднимаем локальный профиль с диска (до сетевого round-trip), чтобы ник не мигал «—».
      // Для новых пользователей (!existingUserId) черновик не трогаем — не воскрешаем данные после удаления аккаунта.
      if (existingUserId) {
        const draft = await loadDraftProfile();
        const cached = await loadProfileFromStorage();

        localNick = (cached?.nick ?? draft?.nick ?? '') as string;

        if (/^user_[a-z0-9]{3,10}$/i.test(localNick)) {
          localNick = '';
        }

        cachedAvatar = (cached?.avatar ?? '') as string;
        draftAvatar = (draft?.avatar ?? '') as string;

        const liveEarly = String(nickLiveRef.current || '').trim();
        if (!liveEarly && localNick) {
          setNick(localNick);
          nickLiveRef.current = localNick;
        }
        if (!String(savedNickRef.current || '').trim() && localNick) {
          setSavedNickDebug(localNick);
        }
      }

      // 2b. Если userId есть — проверяем существование на сервере (после локальной подстановки)
      if (existingUserId) {
        try {
          userExistsOnServer = await checkUserExists(existingUserId);

          if (userExistsOnServer === false) {
            const fromInstall = await refreshUserIdFromInstall();
            if (fromInstall && fromInstall !== existingUserId) {
              userExistsOnServer = await checkUserExists(fromInstall);
            }
          }

          if (userExistsOnServer === null) {
            userExistsOnServer = null;
          } else if (userExistsOnServer === false) {
            console.warn('[ensureIdentity] User not found on server, performing hard reset...');

            // Пользователь мог уже начать вводить ник, пока мы ждали checkUserExists.
            const preservedNick = nickInputDirtyRef.current ? String(nickLiveRef.current || '').trim() : '';
            
            // Жёсткий локальный сброс
            await hardLocalReset();
            resetAllState();

            // Восстанавливаем ввод, если он уже был
            if (preservedNick) {
              nickLiveRef.current = preservedNick;
              nickInputDirtyRef.current = true;
              setNick(preservedNick);
              saveDraftProfile({ nick: preservedNick }).catch(() => {});
            }
            
            // Attach без профиля (создаст нового пользователя)
            await attachIdentitySafe({ installId: localInstallId, profile: {} });
            return;
          }
        } catch (e) {
          console.warn('[ensureIdentity] Failed to check user existence:', e);
          // Продолжаем работу - возможно просто нет интернета
          userExistsOnServer = null; // неизвестно — держим локальный кэш
        }
      }

      // 3. Черновик уже загружен выше для existingUserId; для новых пользователей localNick остаётся пустым.

      // 4. Подставляем данные в UI ТОЛЬКО для существующих пользователей
      // Для новых пользователей показываем пустые поля (пользователь введёт сам)

      // savedNick - только если сервер не сказал "удалён" (false уже обработан return выше)
      if (existingUserId && !String(savedNickRef.current || '').trim() && localNick) {
        setSavedNickDebug(localNick);
      } else if (!existingUserId) {
        setSavedNickDebug('');
      }

      // savedAvatarUrl — аналогично (не затираем при null / офлайне)
      if (existingUserId) {
        setSavedAvatarUrl(cachedAvatar);
      } else {
        setSavedAvatarUrl('');
        try { await clearAllAvatarCaches(); } catch {}
      }

      // nick - только для существующих пользователей
      // КРИТИЧНО: используем nickLiveRef (state может отставать на 1 ввод),
      // иначе первый символ может "съедаться" async-логикой после удаления аккаунта.
      const liveNickNow = String(nickLiveRef.current || '').trim();
      if (!liveNickNow) {
        if (existingUserId && localNick) {
          setNick(localNick);
          nickLiveRef.current = localNick;
        } else {
          setNick('');
          nickLiveRef.current = '';
        }
      }

      // avatarUri - НЕ подставляем черновик для новых пользователей
      // Локальный file:// превью остаётся (если пользователь выбрал СЕЙЧАС)
      setAvatarUri((prev) => {
        // если пользователь уже выбрал локальный файл СЕЙЧАС — оставляем для превью
        if (prev && /^(file|content|ph|assets-library):\/\//i.test(prev)) {
          return prev;
        }
        // если уже что-то есть — не затираем
        if (prev) return prev;
        // гидрируем из кэша ТОЛЬКО для существующих пользователей
        if (existingUserId && draftAvatar) {
          return draftAvatar;
        }
        return '';
      });

      const profile: { nick?: string; avatar?: string } = {};

      // Передаём профиль только если есть userId и сервер не подтвердил удаление
      // Для новых пользователей profile = {} (будет проигнорирован в attachIdentitySafe)
      if (existingUserId) {
        const trimmedNick = String(localNick ?? '').trim();
        // Не шлём пустой nick в attach — сервер трактует '' как осознанную очистку (nick_cleared).
        if (trimmedNick) profile.nick = trimmedNick;
        if (cachedAvatar === '') profile.avatar = '';
        else if (/^https?:\/\//i.test(String(cachedAvatar))) profile.avatar = String(cachedAvatar).trim();
      } else {}

      // Проверяем, нужно ли вызывать attachIdentitySafe
      const currentUserId = getCurrentUserId();
      if (currentUserId) {
        return;
      }

      // attachIdentitySafe дополнительно проверит getCurrentUserId() перед отправкой профиля
      // Проверяем что attachIdentitySafe не выполняется уже
      let attachResult;
      if (attachIdentityRef.current) {
        attachResult = await attachIdentityRef.current;
      } else {
        attachResult = await attachIdentitySafe({ installId: localInstallId, profile });
      }

      // Если получили userId для НОВОГО пользователя И есть текущие введённые данные
      if (attachResult?.ok && attachResult?.userId && !existingUserId) {
        const wasNewUser = true;

        // Проверяем есть ли данные введённые пользователем СЕЙЧАС (не из черновика)
        const currentNick = String(nickLiveRef.current || '').trim();
        const currentAvatarUri = String(avatarUriRef.current || '').trim();

        // Отправляем только если пользователь что-то ввёл
        const hasCurrentData = currentNick || currentAvatarUri;

        if (hasCurrentData) {
          // Небольшая задержка для завершения attach на сервере
          await new Promise(r => setTimeout(r, 300));

          try {
            const profileUpdate: any = {};
            if (currentNick) profileUpdate.nick = currentNick;
            // avatarUri будет обработан в handleSaveProfile
            
            if (Object.keys(profileUpdate).length > 0) {
              await updateProfile(profileUpdate);
            }
          } catch (e) {
            console.warn('[ensureIdentity] Failed to update profile after user creation:', e);
          }
        } else {}
      }

      if (pendingAttachRef.current) {
        await attachIdentitySafe({ installId: localInstallId, profile: pendingAttachRef.current });
      }

      // Префетч аватара если есть
      if (cachedAvatar || draftAvatar) {
        const headerPreview = cachedAvatar || draftAvatar;
        const thumb = toAvatarThumb(headerPreview, 240, 240);
        if (thumb) try { (ExpoImage as any).prefetch?.(thumb); } catch {}
      }
    })();
    
    ensureIdentityRef.current = promise;
    promise.finally(() => {
      ensureIdentityRef.current = null;
    });
    return promise;
  }, [attachIdentitySafe, resetAllState]);

  // Синхронная загрузка профиля для предотвращения мерцания
  const loadProfileSync = useCallback(async () => {
    try {
      // КРИТИЧНО: кэш с диска ДО проверки userId — boot может ещё не выставить currentUserId в памяти.
      let cachedNick = '';
      let cachedAvatar = '';

      try {
        const cached = await loadProfileFromStorage();
        if (cached) {
          if (cached.nick && typeof cached.nick === 'string' && cached.nick.trim()) {
            cachedNick = cached.nick.trim();
            setNick((n) => (String(n || '').trim() ? n : cachedNick));
            setSavedNick((s) => (String(s || '').trim() ? s : cachedNick));
            logger.debug('[HomeScreen] Loaded nick from cache', { nick: cachedNick });
          }
          if (cached.avatar && typeof cached.avatar === 'string' && cached.avatar.trim()) {
            const url = cached.avatar.trim();
            cachedAvatar = url;
            setAvatarUri((a) => (String(a || '').trim() ? a : url));
            setMyFullAvatarUri((a) => (String(a || '').trim() ? a : url));
            setSavedAvatarUrl((s) => (String(s || '').trim() ? s : url));
            logger.debug('[HomeScreen] Loaded avatar from cache');
          }
        }
      } catch (e) {
        logger.warn('[HomeScreen] Failed to load from cache', { e });
      }

      const currentUserId = getCurrentUserId();
      if (!currentUserId) {
        logger.debug('[HomeScreen] No currentUserId yet; profile hydrated from disk only');
        setDataLoaded(true);
        return;
      }

      // Ждем подключения и авторизации socket перед загрузкой с сервера
      try {
        await waitSocketConnected();
        // Небольшая задержка для завершения reauth
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (e) {
        logger.warn('[HomeScreen] Socket connection wait failed', { e });
      }

      logger.debug('[HomeScreen] Loading profile for userId', { userId: currentUserId });

      // Загружаем профиль из MongoDB через backend с retry
      let profileLoadedSuccess = false;
      let hasActualData = false; // Флаг что данные реально установлены
      let loadedNick = ''; // Локальные переменные для отслеживания загруженных данных
      let loadedAvatar = ''; // (state обновляется асинхронно)
      
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          logger.debug('[HomeScreen] Loading profile attempt', { attempt, maxAttempts: 5 });
          const profileResponse = await getMyProfile();
          const profileAny: any = profileResponse?.profile ?? null;
          const avatarB64 = typeof profileAny?.avatarB64 === 'string' ? String(profileAny.avatarB64) : '';
          const avatarThumbB64 = typeof profileAny?.avatarThumbB64 === 'string' ? String(profileAny.avatarThumbB64) : '';
          const toDataUri = (raw: string) => {
            const s = String(raw || '').trim();
            if (!s) return '';
            return s.startsWith('data:') ? s : `data:image/jpeg;base64,${s}`;
          };
          // КРИТИЧНО: Убираем avatarB64 и avatarThumbB64 из логов (очень большие base64)
          const logProfile = profileResponse ? {
            ...profileResponse,
            profile: profileResponse.profile ? {
              ...profileResponse.profile,
              avatarB64: avatarB64 ? `[base64: ${avatarB64.length} chars]` : undefined,
              avatarThumbB64: avatarThumbB64 ? `[base64: ${avatarThumbB64.length} chars]` : undefined
            } : profileResponse.profile
          } : profileResponse;
          logger.debug('[HomeScreen] Profile response from backend', { profile: logProfile });
          
          // Проверяем что профиль не пустой (должен быть хотя бы nick или avatar)
          if (profileResponse?.ok && profileResponse.profile) {
            const profile = profileResponse.profile as any;
            logger.debug('[HomeScreen] Profile data', { nick: profile.nick, hasAvatar: !!avatarB64, hasAvatarThumb: !!avatarThumbB64, avatarVer: profile.avatarVer });
            logger.debug('Loaded profile from backend', { nick: profile.nick, hasAvatar: !!avatarB64 });
            
            // Обновляем никнейм из backend (если на сервере пусто — не затираем локальный кэш/UI)
            const serverNick = typeof profile.nick === 'string' ? profile.nick.trim() : '';
            if (serverNick) {
              loadedNick = serverNick;
              setNick(serverNick);
              setSavedNick(serverNick);
              setSavedNickDebug(serverNick);
              logger.debug('[HomeScreen] Set nick from backend', { nick: serverNick });
              hasActualData = true;
            } else if (cachedNick) {
              loadedNick = cachedNick;
              setNick((n) => (String(n || '').trim() ? n : cachedNick));
              setSavedNick((s) => (String(s || '').trim() ? s : cachedNick));
              setSavedNickDebug(cachedNick);
              logger.debug('[HomeScreen] Server nick empty, kept cached nick', { nick: cachedNick });
              if (isCreateUserInProgress()) {
                try { await waitForCreateUserCompletion(); } catch {}
              }
              void updateProfile({ nick: cachedNick }).catch(() => {});
            }
            
            // Обновляем аватар из backend
            if (avatarB64) {
              const avatarDataUri = toDataUri(avatarB64);
              loadedAvatar = avatarDataUri;
              setMyFullAvatarUri(avatarDataUri);
              setAvatarUri(avatarDataUri);
              setSavedAvatarUrl(avatarDataUri);
              logger.debug('[HomeScreen] Set avatar from backend avatarB64');
              logger.debug('Set avatar from backend avatarB64');
              hasActualData = true;
            } else if (avatarThumbB64) {
              const avatarDataUri = toDataUri(avatarThumbB64);
              loadedAvatar = avatarDataUri;
              setMyFullAvatarUri(avatarDataUri);
              setAvatarUri(avatarDataUri);
              setSavedAvatarUrl(avatarDataUri);
              logger.debug('[HomeScreen] Set avatar from backend avatarThumbB64');
              logger.debug('Set avatar from backend avatarThumbB64');
              hasActualData = true;
            }
            
            // Обновляем версию аватара
            if (typeof profile.avatarVer === 'number') {
              setMyAvatarVer(profile.avatarVer);
              // Persist avatarVer for cold start / offline avatar render
              try {
                const uid = getCurrentUserId();
                if (uid) {
                  AsyncStorage.setItem(`avatarVer_${uid}`, String(profile.avatarVer)).catch(() => {});
                }
              } catch {}
            }
            
            const persistedAvatar = avatarB64
              ? toDataUri(avatarB64)
              : (avatarThumbB64 ? toDataUri(avatarThumbB64) : '');
            const persistedNick =
              serverNick ||
              cachedNick ||
              String(nickLiveRef.current || '').trim() ||
              String(loadedNick || '').trim();

            await saveProfileToStorage({
              nick: persistedNick,
              avatar: persistedAvatar || cachedAvatar || '',
            });
            
            // Если есть реальные данные (nick или avatar), отмечаем как успешную загрузку
            if (hasActualData || (profile.nick && profile.nick.trim()) || avatarB64 || avatarThumbB64) {
              profileLoadedSuccess = true;
              logger.debug('[HomeScreen] Profile loaded successfully with data');
            } else {
              // Пустой профиль - это нормально для нового пользователя, но не выходим из цикла
              logger.debug('[HomeScreen] Profile loaded (empty profile for new user)');
              profileLoadedSuccess = true; // Принимаем пустой профиль как валидный ответ
            }
            
            // Выходим из цикла только если получили реальные данные
            if (profileLoadedSuccess) {
              break;
            }
          } else {
            logger.debug('[HomeScreen] Profile load attempt: empty/invalid response', { attempt, maxAttempts: 5 });
          }
        } catch (e) {
          logger.debug('[HomeScreen] Profile load attempt failed', { attempt, maxAttempts: 5, e });
          if (attempt < 5) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2 секунды задержка
          }
        }
      }
      
      // Проверяем есть ли реальные данные после всех попыток загрузки
      // Используем локальные переменные вместо state (state обновляется асинхронно)
      // Приоритет: загруженные с сервера > из кэша > из текущего state
      const finalNick = loadedNick || cachedNick || String(nickLiveRef.current || nick || '') || '';
      const finalAvatar = loadedAvatar || cachedAvatar || avatarUri || '';
      const hasRealData = (finalNick && finalNick.trim()) || (finalAvatar && finalAvatar.trim());
      
      if (!profileLoadedSuccess) {
        logger.warn('[HomeScreen] All profile load attempts failed, checking cached data');
        
        // Если профиль не загрузился с сервера, проверяем есть ли данные в кэше
        const cached = await loadProfileFromStorage();
        if (!cached || (!cached.nick && !cached.avatar)) {
          logger.warn('[HomeScreen] No cached data found, clearing profile');
          // Нет кэша - очищаем все локальные данные
          // Не трогаем ник/аватар, если пользователь уже начал вводить (state может отставать)
          const liveNick = String(nickLiveRef.current || '').trim();
          if (!hasRealData && !liveNick) {
            setNick('');
            nickLiveRef.current = '';
            setSavedNickDebug('');
            setSavedAvatarUrl('');
            setAvatarUri('');

            // Очищаем локальное хранилище (ключи должны совпадать с тем, что реально используем)
            try {
              await AsyncStorage.removeItem(PROFILE_KEY); // livi.profile.v1
              await AsyncStorage.removeItem(DRAFT_KEY);   // profile_draft_v1
              logger.debug('[HomeScreen] Cleared local storage after profile deletion');
            } catch (e) {
              logger.warn('[HomeScreen] Failed to clear local storage', { e });
            }
          }
        } else {
          logger.debug('[HomeScreen] Using cached profile data due to server failure');
        }
      }

      // Устанавливаем profileLoaded если есть реальные данные ИЛИ если пользователь новый (нет данных, но userId существует)
      // КРИТИЧНО: Для нового пользователя без данных profileLoaded должен быть true, чтобы показать экран создания профиля
      const isNewUser = !hasRealData && !profileLoadedSuccess && currentUserId;
      if (hasRealData || profileLoadedSuccess || isNewUser) {
        logger.debug('[HomeScreen] Profile loading complete', { 
          hasData: hasRealData || profileLoadedSuccess,
          isNewUser,
          hasNick: !!(finalNick && finalNick.trim()), 
          hasAvatar: !!(finalAvatar && finalAvatar.trim()) 
        });
        setProfileLoaded(true);
      } else {
        logger.warn('[HomeScreen] Profile loading complete but no data found and not a new user');
        // Не устанавливаем profileLoaded = true только если это не новый пользователь
      }

      // Всегда устанавливаем dataLoaded = true после попытки загрузки
      setDataLoaded(true);
    } catch (e) {
      logger.warn('[HomeScreen] Failed to load profile from storage', { e });
      setDataLoaded(true); // Даже при ошибке помечаем как загружено
    }
  }, [setSavedNickDebug]);

  /* ===== load profile from storage on init ===== */
  useEffect(() => {
    // Загружаем профиль только если он еще не загружен
    if (!profileLoaded) {
      loadProfileSync();
    }
  }, [loadProfileSync, profileKey, resolvedUserId, profileLoaded]); // Перезагружаем при изменении profileKey или currentUserId

  useEffect(() => {
    if (homeScreenAlreadyBooted && !splashDismissed) {
      setSplashDismissed(true);
    }
  }, [splashDismissed]);

  // Запоминаем, что сплеш уже был скрыт в этой сессии — при возврате из VideoCall/PiP не показывать его снова.
  useEffect(() => {
    if (splashDismissed) {
      homeScreenAlreadyBooted = true;
    }
  }, [splashDismissed]);

  // При возврате на Home (remount) с уже загруженным экраном — один раз подставляем профиль из хранилища (ник, аватар)
  const didRestoreProfileRef = useRef(false);
  useEffect(() => {
    if (homeScreenAlreadyBooted && !didRestoreProfileRef.current) {
      didRestoreProfileRef.current = true;
      loadProfileSync();
    }
  }, [loadProfileSync]);

  /* ===== Автозагрузка локального аватара в Cloudinary/Server ===== */
  // Auto-upload отключен - теперь загружаем только при явном нажатии "Сохранить"
  // Это предотвращает попытки использовать старый HTTP endpoint (404)

  /* ===== initial boot ===== */
  useEffect(() => {
    (async () => {
      try { await waitSocketConnected().catch(() => {}); } catch {}

      const userExists = await syncUserData();

      if (userExists !== false) {
        ensureIdentity().catch(() => {});
      }

      void loadFriends();
    })();
  }, [syncUserData, ensureIdentity, loadFriends]);

  /* ===== reconnect handling ===== */
  useEffect(() => {
    const off = onConnected(() => {
      (async () => {
        try {
          // Синхронизируем данные при переподключении
          const userExists = await syncUserData();
          
          if (userExists) {
            if (pendingAttachRef.current) {
              await attachIdentitySafe({ installId, profile: pendingAttachRef.current });
            }
            await ensureIdentity();
          }
        } finally {
          void loadFriends();
        }
      })().catch(() => {});
    });
    return () => { off?.(); };
  }, [syncUserData, attachIdentitySafe, ensureIdentity, loadFriends, installId]);

  // Глобальный таймаут (старый хук) — заменён на нижний, но оставляем скрытие модалки на всякий случай
  useEffect(() => {
    const off = onCallTimeoutEvent?.(() => {
      setCalling({ visible: false, friend: null, callId: null });
    });
    return () => { off?.(); };
  }, []);

  /* ===== auto-commit deletion when avatar cleared (КЛЮЧЕВОЕ) ===== */
  useEffect(() => {
    const prev = prevAvatarRef.current;
    if (prev && avatarUri === '') {
      (async () => {
        // локально: чистим всё
        await saveProfileToStorage({ nick: (savedNick || nick || '').trim(), avatar: '' });
        setSavedAvatarUrl('');
        await saveDraftProfile({ avatar: '' });

        // сервер: явное удаление
        // avatar больше не используется — серверный сброс осуществляется роутом /api/me/avatar

        // socket identity (на случай оффлайна): только avatar — иначе пустой nick в state затрёт ник в БД
        pendingAttachRef.current = { avatar: '' };
        await attachIdentitySafe({ installId, profile: pendingAttachRef.current }).catch(() => {});

        try { await loadFriends(); } catch {}
      })().catch(() => {});
    }
    prevAvatarRef.current = avatarUri;
  }, [avatarUri, attachIdentitySafe, installId, loadFriends, lang, nick, savedNick, showNotice]);

  /* ===== pull draft when Settings is open ===== */
  useEffect(() => {
    if (!menuOpen || tab !== 'settings') return;
    (async () => {
      try {
        // ВАЖНО: НЕ загружаем черновик для новых пользователей
        const currentUserId = getCurrentUserId();

        if (!currentUserId) {
          return;
        }

        const draft = await loadDraftProfile();

        // Только обновляем если есть значение И пользователь существует
        if (typeof draft.nick === 'string' && draft.nick.trim()) {
          setNick(draft.nick);
        }

        // Аватар из черновика - только file:// превью (не восстанавливаем старые URL)
        if (typeof draft.avatar === 'string' && draft.avatar) {
          const isLocalPreview = /^(file|content|ph|assets-library):\/\//i.test(draft.avatar);
          if (isLocalPreview) {
            setAvatarUri((u) => u || draft.avatar || '');
          } else {}
        }
      } catch (e) {
        console.warn('[Settings] Failed to load draft:', e);
      }
    })();
  }, [menuOpen, tab]);

  // Бейдж «Занято» у участников видеозвонка: сервер при инициации (call:initiate) и при принятии (call:accept)
  // рассылает presence:update({ userId, busy: true }) друзьям обоих участников; при завершении/отмене/отклонении
  // — presence:update({ userId, busy: false }). Обновление isBusy приходит в onPresenceUpdate выше.
  // Отдельно не вешаем inCall на всех друзей — только два участника звонка помечаются busy через сокет.

  const syncSelfPresenceOnlineIfIdle = useCallback((reason: string) => {
    try {
      const g = global as any;
      const session = g.__webrtcSessionRef?.current;
      const incomingAnswerTransition = g.__incomingAnswerTransitionRef?.current;
      const incomingAnswerTransitionActive =
        !!incomingAnswerTransition &&
        Number(incomingAnswerTransition.expiresAt || 0) > Date.now();
      const sessionNotEnded =
        !!session &&
        (typeof session.isEnded === 'function'
          ? !session.isEnded()
          : session?.room?.state !== 'disconnected');
      const hasAnyCallIds =
        !!g.__currentCallPiPParamsRef?.current?.callId ||
        !!g.__currentCallPiPParamsRef?.current?.roomId ||
        (!!session && typeof session.getCallId === 'function' && !!session.getCallId()) ||
        (!!session && typeof session.getRoomId === 'function' && !!session.getRoomId());
      const hasActiveLocalCall =
        g.__videoCallActiveRef?.current === true ||
        g.__randomChatPresenceBusyRef?.current === true ||
        g.__randomChatHadPresenceBusyRef?.current === true ||
        g.__pipVisibleRef?.current === true ||
        g.__pipInSystemModeRef?.current === true ||
        g.__outgoingCallScreenVisibleRef?.current === true ||
        g.__incomingCallScreenVisibleRef?.current === true ||
        !!String(g.__outgoingCallIdRef?.current || '').trim() ||
        incomingAnswerTransitionActive ||
        sessionNotEnded ||
        hasAnyCallIds ||
        calling.visible ||
        callingVisibleRef.current ||
        incomingCallScreen.visible ||
        activeOutgoingAttemptRef.current > 0;
      if (hasActiveLocalCall) return;
      emitPresenceUpdateIfChanged({ status: 'online', idle: true }, { force: true });
    } catch (e) {
      logger.warn('[HomeScreen] Failed to sync idle presence online', { reason, error: (e as Error)?.message });
    }
  }, [calling.visible, incomingCallScreen.visible]);

  useEffect(() => {
    if (tab !== 'friends') return;
    syncSelfPresenceOnlineIfIdle('friends-tab');
    try {
      const g = global as any;
      if (g.__videoCallActiveRef?.current === true && !isDirectCallSessionLive(g)) {
        forceResetCallBusyRefs();
      }
    } catch {}
    void loadFriends();
  }, [tab, syncSelfPresenceOnlineIfIdle, forceResetCallBusyRefs, loadFriends]);

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const scheduleIdleSync = (reason: string) => {
      if (!getCurrentUserId()) return;
      [250, 1200].forEach((delayMs) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          syncSelfPresenceOnlineIfIdle(reason);
          void loadFriends();
        }, delayMs);
        timers.add(timer);
      });
    };

    const offIdentity = onCurrentUserId((id) => {
      if (id) scheduleIdleSync('identity-ready');
    });
    const offConnected = onConnected(() => {
      scheduleIdleSync('socket-connected');
    });

    return () => {
      offIdentity?.();
      offConnected?.();
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, [loadFriends, syncSelfPresenceOnlineIfIdle]);

  /* ===== app resume ===== */
  const appStateRef = useRef(AppState.currentState);
  const lastResumeSyncAtRef = useRef(0);
  const RESUME_SYNC_DEBOUNCE_MS = 30 * 1000; // не чаще раза в 30 сек — убирает мерцание при частых active (два устройства, блокировка)
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      const wasBg = /inactive|background/.test(appStateRef.current);
      appStateRef.current = state;
      // После закрытия нативного Incoming (cancel) — окно settle: несколько active подряд не должны
      // дергать setAppIsActive / loadFriends (иначе мерцание любого экрана 2–3 раза).
      if (shouldSkipHomeUiSettle()) {
        return;
      }
      try { setAppIsActive(state === 'active'); } catch {}
      if (wasBg && state === 'active') {
        const now = Date.now();
        if (now - lastResumeSyncAtRef.current < RESUME_SYNC_DEBOUNCE_MS) return;
        lastResumeSyncAtRef.current = now;
        try {
          await waitSocketConnected();
          const userExists = await syncUserData();
          if (userExists) {
            await ensureIdentity();
            getCurrentUserId();
          }
          syncSelfPresenceOnlineIfIdle('app-resume');
          await loadFriends();
        } catch (e) { console.warn('resume error', e); }
      }
    });
    return () => sub.remove();
  }, [syncUserData, ensureIdentity, loadFriends, syncSelfPresenceOnlineIfIdle]);



  // Обновляем пропущенные видеозвонки из AsyncStorage при возврате на экран (iOS/Android)
  // КРИТИЧНО: Нормализуем ключи (преобразуем в строки) и фильтруем только значения > 0
  // Также обновляем счетчики непрочитанных сообщений при фокусе
  // При фокусе Home: подтянуть пропущенные из storage/natив для UI; бейдж не сбрасываем при открытии вкладки «Друзья».
  useEffect(() => {
    const unsub = navigation?.addListener?.('focus', async () => {
      try {
        // После отмены входящего не дергаем setState при focus — убираем двойной показ страницы
        if (shouldSkipHomeUiSettle()) {
          return;
        }
        syncSelfPresenceOnlineIfIdle('home-focus');
        const onFriendsTab = tabRef.current === 'friends';
        const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        const nativeMissed = await getMissedCountByUserFromNative();
        setMissedByUser((prev) => {
          const merged = mergeMissedFromSources(prev, parsed, nativeMissed);
          if (badgeMapsEqual(prev, merged)) return prev;
          AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(merged)).catch(() => {});
          return merged;
        });
        setMissedLoaded(true);
        if (!onFriendsTab) {
          await syncAppBadgeFromMissedCount();
        }

        if (friends.length > 0) {
          await refreshUnreadCountsForFriends(friends);
          logger.debug('[HomeScreen] Reloaded unread messages on focus (batch)', {
            count: friends.length,
          });
        }
      } catch (e) {
        logger.warn('[HomeScreen] Error reloading counters on focus:', e);
      }
    });
    return () => { try { unsub?.(); } catch {} };
  }, [navigation, friends, syncSelfPresenceOnlineIfIdle, refreshUnreadCountsForFriends]);

  // Регистрируем колбэк, чтобы при завершении видеозвонка (в т.ч. из PiP) принудительно обновить список друзей — снять бейдж «Занят» и disabled с кнопки.
  useEffect(() => {
    const g = global as any;
    if (!g.__onVideoCallEndedRef) g.__onVideoCallEndedRef = { current: null };
    g.__onVideoCallEndedRef.current = () => {
      const currentPartner = String((g.__videoCallPartnerUserIdRef?.current ?? '') || '').trim();
      const lastPartner = String((lastVideoCallPartnerRef.current ?? '') || '').trim();
      const lastOutgoingPeer = String(lastOutgoingPeerIdRef.current ?? '').trim();
      const partnerToClear = currentPartner || lastPartner || lastOutgoingPeer;
      if (partnerToClear) {
        markRecentlyEndedCallFriend(partnerToClear);
        setFriends((prev) => prev.map((f) => String(f.id) === partnerToClear ? { ...f, isBusy: false } : f));
      }
      lastOutgoingPeerIdRef.current = null;
      setVideoCallEndedTick((t) => t + 1);
    };
    return () => {
      if (g.__onVideoCallEndedRef) g.__onVideoCallEndedRef.current = null;
    };
  }, [markRecentlyEndedCallFriend]);

  // Запоминаем последнего партнера активного видеозвонка, чтобы при завершении можно было снять stale busy.
  useEffect(() => {
    const g = global as any;
    const partner = String((g.__videoCallPartnerUserIdRef?.current ?? '') || '').trim();
    const active = g.__videoCallActiveRef?.current === true;
    if (active && partner) {
      lastVideoCallPartnerRef.current = partner;
    }
  });

  // После завершения звонка делаем форс-синхронизацию друзей (в т.ч. busy), если событие busy:false было потеряно.
  useEffect(() => {
    if (videoCallEndedTick <= 0) return;
    void loadFriends();
  }, [videoCallEndedTick, loadFriends]);

  /* ===== presence & friend events ===== */
  useEffect(() => {
    // Если пришёл запрос закрыть входящий (из других экранов/чата) — закрываем и здесь
    const offReq = onRequestCloseIncoming(() => {
      setCalling({ visible: false, friend: null, callId: null });
    });
    const offAccepted = onFriendAccepted?.(async () => {
      // КРИТИЧНО: Обновляем профиль на сервере и синхронизируем с CometChat
      try {
        const currentNick = String(nickLiveRef.current || savedNick || nick || '');
        const currentAvatar = avatarUri || savedAvatarUrl || '';
        const patch: { nick?: string; avatar?: string } = {};
        if (currentNick) patch.nick = currentNick;
        // ⚠️ КРИТИЧНО: не отправляем data: и не отправляем avatar='' (это удаление аватара на сервере).
        // Сервер принимает только http(s) URL или явное удаление.
        if (currentAvatar && /^https?:\/\//i.test(currentAvatar)) {
          patch.avatar = currentAvatar;
        }
        if (Object.keys(patch).length) {
          await updateProfile(patch);
        }
        // В CometChat тоже лучше отправлять только URL (data: может быть не поддержан).
        await syncMyStreamProfile(currentNick, /^https?:\/\//i.test(currentAvatar) ? currentAvatar : undefined);
      } catch (e) {
        logger.warn('[HomeScreen] Failed to update profile after friend accepted:', e);
      }
      void loadFriends();
    });
    const offPresence = onPresenceUpdate?.((data: any) => {
      // КРИТИЧНО: Защита от некорректных типов данных (Date, null, undefined и т.д.)
      if (!data) return;
      
      // Обрабатываем оба формата: массив (для online) и объект (для busy)
      if (Array.isArray(data)) {
        // Формат массива: обновление online статуса
        // КРИТИЧНО: Дополнительная проверка что все элементы массива валидны
        try {
          const onlineSet = new Set((data || []).map((it: any) => {
            if (it === null || it === undefined) return null;
            return String(it?._id ?? it);
          }).filter((id: string | null): id is string => id !== null));
          
          setFriends((prev) => {
            const now = Date.now();
            return prev.map((f) => {
              const id = String(f.id);
              const inSet = onlineSet.has(id);
              if (inSet) {
                const pending = pendingPresenceOfflineTimersRef.current.get(id);
                if (pending) {
                  clearTimeout(pending);
                  pendingPresenceOfflineTimersRef.current.delete(id);
                }
                friendLastOnlineTrueAtRef.current.set(id, now);
                return { ...f, online: true };
              }
              if (!f.online) {
                return f;
              }
              if (!pendingPresenceOfflineTimersRef.current.has(id)) {
                const t = setTimeout(() => {
                  pendingPresenceOfflineTimersRef.current.delete(id);
                  friendLastOnlineTrueAtRef.current.delete(id);
                  setFriends((p) =>
                    p.map((x) =>
                      String(x.id) === id ? { ...x, online: false, isBusy: false } : x,
                    ),
                  );
                }, PRESENCE_OFFLINE_DEBOUNCE_MS);
                pendingPresenceOfflineTimersRef.current.set(id, t);
              }
              return { ...f, online: true };
            });
          });
        } catch (e) {
          console.warn('[onPresenceUpdate] Error processing array data:', e, { dataType: typeof data, isArray: Array.isArray(data) });
        }
      } else if (data && typeof data === 'object' && !Array.isArray(data) && data.userId) {
        // Формат объекта: обновление busy статуса
        const userId = String(data.userId);
        const busy = data.busy !== undefined ? !!data.busy : undefined;
        if (busy !== undefined) {
          setFriends((prev) => {
            const updated = prev.map((f) => {
              if (String(f.id) === userId) {
                return { ...f, isBusy: busy };
              }
              return f;
            });
            return updated;
          });
        }
      }
    });
    const offProfile = onFriendProfile?.(async ({ userId, nick, avatar, avatarVer, avatarThumbB64 }: any) => {
      // КРИТИЧНО: НЕ трогаем собственный профиль!
      // Обновления friend:profile обновляют ТОЛЬКО список друзей (setFriends),
      // НЕ затрагивая savedNick, nick, savedAvatarUrl, avatarUri
      const currentUserId = getCurrentUserId();

      if (!userId) {
        console.warn('[onFriendProfile] ⚠️ No userId in event, ignoring');
        return;
      }

      // Игнорируем обновления собственного профиля
      if (currentUserId && String(userId) === String(currentUserId)) {
        return;
      }

      // Дополнительная защита: если нет currentUserId, но пришли данные профиля
      // это может быть попытка обновить собственный профиль "молча"
      if (!currentUserId) {
        console.warn('[onFriendProfile] ⚠️ No currentUserId set, ignoring to prevent corruption');
        return;
      }

      // Логируем получение обновления профиля друга для диагностики
      logger.debug('[onFriendProfile] Friend profile update received', {
        userId,
        nick: nick || '(пусто)',
        nickLength: nick?.length || 0,
        hasAvatar: !!(avatarVer && avatarVer > 0),
        avatarVer,
        hasThumb: !!avatarThumbB64
      });

      // Кэшируем миниатюру если пришла
      if (avatarThumbB64 && avatarVer) {
        try {
          await putThumb(userId, avatarVer, avatarThumbB64);
        } catch (e) {
          console.warn('[onFriendProfile] Failed to cache thumbnail:', e);
        }
      }

      // Обновляем ТОЛЬКО список друзей, НЕ затрагивая собственный профиль
      // Если друга нет в списке, добавляем его (может быть только что подружились)
      setFriends((prev) => {
        const existingIndex = prev.findIndex(f => String(f.id) === String(userId));
        if (existingIndex >= 0) {
          // Обновляем существующего друга
          // КРИТИЧНО: Используем полный никнейм, не обрезаем до первой буквы
          // ВАЖНО: Если пришел пустой никнейм (nick === ''), это означает что пользователь удалил никнейм
          // В этом случае мы должны обновить name на пустую строку, а не оставлять старое значение
          const oldName = prev[existingIndex]?.name || '';
          // Если nick передан (даже если пустой), используем его. Если не передан - оставляем старое
          const updatedName = typeof nick === 'string' ? nick.trim() : oldName;
          
          // Определяем новую версию аватара и миниатюру
          // ВАЖНО: Если avatarVer === 0 и avatarThumbB64 пустой, это означает что аватар был удален
          const existingFriend = prev[existingIndex];
          const newAvatarVer = typeof avatarVer === 'number' ? avatarVer : existingFriend.avatarVer;
          const newAvatarThumbB64 = typeof avatarThumbB64 === 'string' ? avatarThumbB64 : existingFriend.avatarThumbB64;
          // Если версия аватара 0 и миниатюра пустая, очищаем аватар
          const finalAvatarThumbB64 = (newAvatarVer === 0 && !newAvatarThumbB64) ? '' : newAvatarThumbB64;
          
          // Логируем обновление для диагностики
          const nameChanged = updatedName !== oldName;
          const avatarChanged = newAvatarVer !== existingFriend.avatarVer || finalAvatarThumbB64 !== existingFriend.avatarThumbB64;
          if (nameChanged || avatarChanged) {
            logger.debug('[onFriendProfile] Friend profile updated', {
              userId,
              nameChanged,
              oldName: oldName || '(пусто)',
              newName: updatedName || '(пусто)',
              avatarChanged,
              oldAvatarVer: existingFriend.avatarVer,
              newAvatarVer,
              oldHasThumb: !!existingFriend.avatarThumbB64,
              newHasThumb: !!finalAvatarThumbB64
            });
          }
          
          return prev.map((f) =>
            String(f.id) === String(userId)
              ? { 
                  ...f, 
                  name: updatedName, // Полный никнейм (может быть пустым при удалении)
                  avatar: typeof avatar === 'string' ? avatar : f.avatar,
                  avatarVer: newAvatarVer, // Обновляем версию (может быть 0 при удалении)
                  avatarThumbB64: finalAvatarThumbB64 // Обновляем миниатюру (может быть пустой при удалении)
                }
              : f
          );
        } else {
          // Добавляем нового друга (только что подружились)
          // КРИТИЧНО: Используем полный никнейм, не обрезаем до первой буквы
          const newName = typeof nick === 'string' && nick.trim() ? nick.trim() : '—';
          logger.debug('[onFriendProfile] New friend added', {
            userId,
            name: newName || '(пусто)',
            nameLength: newName.length
          });
          return [
            ...prev,
            {
              id: userId,
              name: newName, // Полный никнейм, не обрезаем
              avatar: typeof avatar === 'string' ? avatar : '',
              avatarVer: typeof avatarVer === 'number' ? avatarVer : 0,
              avatarThumbB64: typeof avatarThumbB64 === 'string' ? avatarThumbB64 : '',
              online: false,
              isBusy: false,
              isRandomBusy: false,
              inCall: false,
            }
          ];
        }
      });

      // Мгновенная предзагрузка нового аватара (warmAvatar теперь no-op)
      if (typeof avatarVer === 'number' && avatarVer > 0) {
        warmAvatar(userId, avatarVer).catch(() => {});
      }
    });
    const offReq2 = onFriendRequest?.(() => {});
    
    // УДАЛЕНО: устаревшие обработчики onRandomBusy и onFriendsRoomState
    // Теперь используется только presence:update для обновления isBusy
    
    return () => { 
      offAccepted?.(); 
      offPresence?.(); 
      offReq?.(); 
      offProfile?.(); 
      offReq2?.(); 
      pendingPresenceOfflineTimersRef.current.forEach((tm) => clearTimeout(tm));
      pendingPresenceOfflineTimersRef.current.clear();
    };
  }, [loadFriends]);

  /* ===== Загрузка своего полного аватара при инициализации ===== */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const currentUserId = getCurrentUserId();
      if (!currentUserId || !myAvatarVer) {
        setMyFullAvatarUri('');
        return;
      }

      // Проверяем кэш
      const cachedFull = await getFull(currentUserId, myAvatarVer);
      if (cachedFull && !cancelled) {
        setMyFullAvatarUri(cachedFull);
        return;
      }

      socket.emit('user.getAvatar', { userId: currentUserId }, async (res: any) => {
        if (!cancelled && res?.ok && res.avatarB64) {
          await putFull(currentUserId, res.avatarVer, res.avatarB64);
          setMyFullAvatarUri(res.avatarB64);
          // Обновляем версию если изменилась
          if (res.avatarVer !== myAvatarVer) {
            setMyAvatarVer(res.avatarVer);
            // Сохраняем версию в AsyncStorage для восстановления при перезапуске
            try {
              const currentUserId = getCurrentUserId();
              if (currentUserId) {
                await AsyncStorage.setItem(`avatarVer_${currentUserId}`, String(res.avatarVer));
              }
            } catch (e) {
              console.warn('[user.avatar] Failed to save avatar version:', e);
            }
          }
        }
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [myAvatarVer]);

  /* ===== Обработчик user.avatar для получения своего полного аватара ===== */
  useEffect(() => {
    const handleMyAvatar = async ({ userId, avatarVer, avatarB64 }: any) => {
      const currentUserId = getCurrentUserId();
      if (!currentUserId || String(userId) !== String(currentUserId)) return;

      // Обновляем версию
      if (typeof avatarVer === 'number') {
        setMyAvatarVer(avatarVer);
        // Сохраняем версию в AsyncStorage для восстановления при перезапуске
        try {
          const currentUserId = getCurrentUserId();
          if (currentUserId) {
            await AsyncStorage.setItem(`avatarVer_${currentUserId}`, String(avatarVer));
          }
        } catch (e) {
          console.warn('[user.avatar] Failed to save avatar version:', e);
        }
      }

      // Обновляем UI с полным аватаром
      if (avatarB64) {
        setMyFullAvatarUri(avatarB64);

        // Очищаем локальный файл preview после успешной загрузки
        // Это переключит UI с локального превью на кешированный data URI
        setAvatarUri('');
      } else {
        setMyFullAvatarUri('');
      }

      // Кэшируем полный аватар
      if (avatarB64 && avatarVer) {
        try {
          await putFull(userId, avatarVer, avatarB64);
        } catch (e) {
          console.warn('[user.avatar] Failed to cache full avatar:', e);
        }
      }
    };

    socket.on('user.avatar', handleMyAvatar);

    return () => {
      socket.off('user.avatar', handleMyAvatar);
    };
  }, []);

  /* ===== Обработчик user.avatarUpdated для мгновенного обновления аватаров друзей ===== */
  useEffect(() => {
    const handleAvatarUpdated = async ({ userId, avatarVer, avatarThumbB64 }: any) => {
      // КРИТИЧНО: НЕ обновляем собственный профиль через это событие
      // Событие user.avatarUpdated предназначено для ДРУЗЕЙ
      const currentUserId = getCurrentUserId();

      if (!userId) {
        console.warn('[user.avatarUpdated] ⚠️ No userId in event, ignoring');
        return;
      }

      // Игнорируем обновления собственного аватара (есть отдельное событие user.avatar)
      if (currentUserId && String(userId) === String(currentUserId)) {
        return;
      }

      // Проверяем, что userId в списке друзей
      const isFriend = friendsRef.current.some(f => String(f.id) === String(userId));
      if (!isFriend) {
        return;
      }

      // Кэшируем миниатюру
      if (avatarThumbB64 && avatarVer) {
        try {
          await putThumb(userId, avatarVer, avatarThumbB64);
        } catch (e) {
          console.warn('[user.avatarUpdated] Failed to cache thumbnail:', e);
        }
      }

      // Обновляем ТОЛЬКО список друзей, НЕ затрагивая собственный профиль
      setFriends((prev) =>
        prev.map((f) =>
          String(f.id) === String(userId)
            ? {
                ...f,
                avatarVer: typeof avatarVer === 'number' ? avatarVer : f.avatarVer,
                avatarThumbB64: typeof avatarThumbB64 === 'string' ? avatarThumbB64 : f.avatarThumbB64
              }
            : f
        )
      );
    };

    socket.on('user.avatarUpdated', handleAvatarUpdated);
    
    return () => {
      socket.off('user.avatarUpdated', handleAvatarUpdated);
    };
  }, []);

  // Оптимизированная логика подключения - используем существующие функции
  useEffect(() => {
    const off = onConnected(async () => {
      try {
        // Используем существующую логику ensureIdentity вместо дублирования
        await ensureIdentity();
      } catch (e) {
        console.warn('connection identity setup failed:', e);
      }
    });
    return () => off?.();
  }, [ensureIdentity]);

  // УДАЛЕНО: устаревший обработчик дисконнекта для isRandomBusy/inFriendsFullRoom
  // Теперь используется только presence:update для обновления isBusy

  // УДАЛЕНО: Альтернативный способ получения userId из friend:profile
  // Причина: friend:profile должен обновлять ТОЛЬКО друзей, НЕ собственный профиль
  // userId должен устанавливаться ТОЛЬКО через identity:attach

  // Запоминаем, кто звонит, чтобы отметить пропущенный только у получателя
  useEffect(() => {
    const off = onCallIncomingEvent?.(({ from }) => { lastIncomingFromRef.current = String(from); });
    return () => { off?.(); };
  }, []);

  // Таймаут звонка: скрыть модалки; инкремент делаем централизованно в App.tsx
  useEffect(() => {
    const off = onCallTimeoutEvent?.(async () => {
      setCalling({ visible: false, friend: null, callId: null });
      lastIncomingFromRef.current = null;
    });
    return () => { off?.(); };
  }, []);

  // Отмена вызова звонящим: просто скрываем; инкремент делаем централизованно в App.tsx
  useEffect(() => {
    const off = onCallDeclinedEvent?.(async ({ from }) => {
      // Событие приходит:
      // - звонящему, если получатель нажал «Отклонить» (не считаем пропущенным)
      // - получателю, если звонящий нажал «Отменить» (считаем пропущенным)
      setCalling({ visible: false, friend: null, callId: null });
      lastIncomingFromRef.current = null;
    });
    return () => { off?.(); };
  }, []);

  /* ===== Конвертация изображения в base64 ===== */
  const imageToBase64 = async (uri: string): Promise<string> => {
    try {
      // Сначала оптимизируем изображение
      const manipResult = await manipulateAsync(
        uri,
        [{ resize: { width: 1024 } }], // Максимальная ширина 1024px
        { compress: 0.8, format: SaveFormat.JPEG, base64: true }
      );

      if (manipResult.base64) {
        return manipResult.base64;
      }

      // Fallback: читаем файл напрямую
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return base64;
    } catch (e) {
      console.error('[imageToBase64] Error:', e);
      throw e;
    }
  };

  /* ===== save profile (ник + аватар) ===== */
  const handleSaveProfile = async () => {
    if (savingRef.current) return;
    savingRef.current = true;

    const MIN_SPINNER_MS = 500;
    const startedAt = Date.now();
    const ensureMinSpinner = async () => {
      const dt = Date.now() - startedAt;
      if (dt < MIN_SPINNER_MS) await new Promise(r => setTimeout(r, MIN_SPINNER_MS - dt));
    };

    setSaving(true);
    let shouldToast = false;

    try {
      // Убедимся, что identity установлен перед загрузкой аватара
      const currentUserId = getCurrentUserId();
      if (!currentUserId) {
        await ensureIdentity();

        // Даем серверу время установить socket.data.userId
        await new Promise(r => setTimeout(r, 300));

        // Проверяем еще раз после ensureIdentity
        const newUserId = getCurrentUserId();
        if (!newUserId) {
          console.error('[handleSaveProfile] Still no userId after ensureIdentity');
          showNotice(t('unauthorized', lang), 'error');
          await ensureMinSpinner();
          setSaving(false);
          return;
        }
      }

      const finalNick = String((nickLiveRef.current || nick || '')).trim();
      // Android часто возвращает content://... (а не file://). Считаем это "локальным"
      // и прогоняем через normalizeLocalImageUri перед конвертацией в base64.
      const isLocalFile = /^(file|content|ph|assets-library):\/\//i.test(avatarUri);
      let finalAvatarUrl = avatarUri; // По умолчанию текущий URI

      // Если выбран локальный файл - загружаем через socket
      if (isLocalFile) {
        try {
          const fileUri = await normalizeLocalImageUri(avatarUri);
          const base64 = await imageToBase64(fileUri);

          const result = await new Promise<{ ok: boolean; avatarVer?: number; error?: string }>((resolve) => {
            socket.emit('user.uploadAvatar', { base64 }, (ack: any) => {
              resolve(ack || { ok: false, error: 'no_response' });
            });
          });

          if (!result.ok) {
            throw new Error(result.error || 'upload_failed');
          }

          // Обновляем версию аватара
          if (result.avatarVer) {
            setMyAvatarVer(result.avatarVer);

            // Сохраняем версию в AsyncStorage для восстановления при перезапуске
            try {
              const myUserId = getCurrentUserId();
              if (myUserId) {
                await AsyncStorage.setItem(`avatarVer_${myUserId}`, String(result.avatarVer));
              }
            } catch (e) {
              console.warn('[handleSaveProfile] Failed to save avatar version:', e);
            }

            // Получаем загруженный аватар из кэша и устанавливаем как myFullAvatarUri
            // Это обеспечит отображение аватара сразу после загрузки
            const myUserId = getCurrentUserId();
            if (myUserId) {
              try {
                const cachedFull = await getFull(myUserId, result.avatarVer);
                if (cachedFull) {
                  setMyFullAvatarUri(cachedFull);
                }
              } catch (e) {
                console.warn('[handleSaveProfile] Failed to get cached avatar:', e);
              }
            }
          }

          // НЕ очищаем avatarUri - оставляем локальный файл для отображения
          // UI автоматически переключится на myFullAvatarUri когда он загрузится
          setSavedAvatarUrl('');
          finalAvatarUrl = ''; // Аватар теперь хранится как data URI в БД
        } catch (e: any) {
          console.error('[handleSaveProfile] Avatar upload error:', e);
          showNotice(t('cloudUploadFailed', lang), 'error');
          await ensureMinSpinner();
          setSaving(false);
          return;
        }
      } else {
        // Если не локальный файл, используем текущий avatarUri (может быть https или пусто)
        finalAvatarUrl = avatarUri;
      }

      // Подготавливаем данные для сервера (только ник, аватар уже загружен через socket)
      const patch: { nick?: string; avatar?: string } = {};

      // Обновляем ник если изменился
      if (finalNick !== savedNick) {
        patch.nick = finalNick;
      }

      // Отправляем avatar только если это новый URL (не локальный файл)
      // Локальные файлы уже загружены через socket выше
      if (!isLocalFile && finalAvatarUrl !== savedAvatarUrl) {
        patch.avatar = finalAvatarUrl;
      }

      // Сохраняем в локальное хранилище
      await saveProfileToStorage({ 
        nick: finalNick, 
        avatar: finalAvatarUrl || '' 
      });
      await saveDraftProfile({ nick: finalNick });

      // Отправляем на сервер (только если есть изменения ника)
      if (Object.keys(patch).length > 0) {
        try {
          // Добавляем таймаут для всей операции
          const updatePromise = updateProfile(patch);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Server timeout')), 8000)
          );
          
          const result = await Promise.race([updatePromise, timeoutPromise]) as any;
          
          if (result?.ok) {
            pendingAttachRef.current = patch;
            attachIdentitySafe({ installId, profile: patch }).catch(() => {});
            syncMyStreamProfile(finalNick, finalAvatarUrl);
          } else {
            console.warn('[handleSaveProfile] Profile update failed:', result?.error);
            // Не прерываем выполнение, так как локальное сохранение уже прошло
          }
        } catch (e) {
          console.warn('[handleSaveProfile] Profile update error:', e);
          // Не прерываем выполнение, так как локальное сохранение уже прошло
          // Попробуем отправить через attachIdentity как fallback
          try {
            await attachIdentitySafe({ installId, profile: patch });
          } catch (fallbackError) {
            console.warn('[handleSaveProfile] Fallback profile update also failed:', fallbackError);
          }
        }
      } else {}

      // Обновляем локальное состояние
      setSavedNickDebug(finalNick);
      setSavedAvatarUrl(finalAvatarUrl);

      // Префетч для быстрого отображения
      if (finalAvatarUrl) {
        try { (ExpoImage as any).prefetch?.(toAvatarThumb(finalAvatarUrl, 240, 240)); } catch {}
      }

      shouldToast = true;
      showNotice(t('saved', lang), 'success', 3000);
    } catch (e) {
      console.error('[handleSaveProfile] ❌ Save profile error:', e);
      showNotice(t('saveFailed', lang), 'error', 3000);
      shouldToast = false; // Не показываем тост при ошибке
    } finally {
      await ensureMinSpinner();
      setSaving(false);
      savingRef.current = false;

      if (shouldToast) {
        setSavedToast(true);
      } else {}
    }
  };

  /* clear nickname */
  /* clear nickname (без прелоадера и без тоста) */
const handleClearNick = useCallback(async () => {
  try {
    await saveProfileToStorage({ nick: '', avatar: savedAvatarUrl || '' });
    await saveDraftProfile({ nick: '' });

    setNick('');
    setSavedNick('');

    pendingAttachRef.current = { nick: '' };
    attachIdentitySafe({ installId, profile: { nick: '' } }).catch(() => {});
  } catch (e) {
    console.warn('clear nick failed:', e);
  }
}, [savedAvatarUrl, installId, attachIdentitySafe]);

  /* delete avatar */
  const handleDeleteAvatar = useCallback(async () => {
    try {
      const currentUserId = String(getCurrentUserId() || '').trim();
      const resolvedInstallId = String(installId || (await getInstallId().catch(() => ''))).trim();

      const deleteViaSocket = async (): Promise<{ ok: boolean; error?: string }> => {
        return new Promise((resolve) => {
          const timeout = setTimeout(() => {
            resolve({ ok: false, error: 'timeout' });
          }, 10_000);

          try {
            socket.emit('user.deleteAvatar', {}, (ack: any) => {
              clearTimeout(timeout);
              resolve(ack || { ok: false, error: 'no_response' });
            });
          } catch {
            clearTimeout(timeout);
            resolve({ ok: false, error: 'socket_emit_failed' });
          }
        });
      };

      const deleteViaHttp = async (): Promise<{ ok: boolean; error?: string }> => {
        if (!currentUserId) return { ok: false, error: 'no_user_id' };
        const headers: Record<string, string> = { 'x-user-id': currentUserId };
        if (resolvedInstallId) headers['x-install-id'] = resolvedInstallId;
        try {
          const r = await fetch(`${API_BASE}/api/avatar/${encodeURIComponent(currentUserId)}`, {
            method: 'DELETE',
            headers,
          });
          const text = await r.text();
          let payload: any = {};
          try { payload = text ? JSON.parse(text) : {}; } catch {}
          if (r.ok && payload?.ok) return { ok: true };
          return { ok: false, error: String(payload?.error || `http_${r.status}`) };
        } catch {
          return { ok: false, error: 'network_error' };
        }
      };

      let result: { ok: boolean; error?: string } = { ok: false, error: 'unknown' };
      if ((socket as any)?.connected) {
        result = await deleteViaSocket();
      }
      if (!result.ok) {
        result = await deleteViaHttp();
      }
      if (!result.ok) throw new Error(result.error || 'delete_failed');

      // Очищаем локальное состояние
      setAvatarUri('');
      setSavedAvatarUrl('');
      setMyAvatarVer(0);
      setMyFullAvatarUri(''); // Также очищаем кешированный data URI

      // Очищаем кэш для текущего пользователя
      const currentUserIdForCache = getCurrentUserId();
      if (currentUserIdForCache) {
        await clearAvatarCacheFor(currentUserIdForCache);

        // Удаляем сохранённую версию аватара
        try {
          await AsyncStorage.removeItem(`avatarVer_${currentUserIdForCache}`);
        } catch (e) {
          console.warn('[handleDeleteAvatar] Failed to remove avatar version:', e);
        }
      }

      // Сохраняем в локальное хранилище
      await saveProfileToStorage({ nick: nick || '', avatar: '' });
      await saveDraftProfile({ nick: nick || '', avatar: '' });

      showNotice(t('avatarDeleted', lang), 'success');
    } catch (e: any) {
      console.error('[handleDeleteAvatar] Error:', e);
      const raw = String(e?.message || '').trim();
      const errorCode = raw.toLowerCase();
      const errorToast =
        errorCode === 'unauthorized'
          ? t('unauthorized', lang)
          : (errorCode === 'timeout' || errorCode === 'network_error' || errorCode === 'socket_emit_failed' || errorCode === 'no_response')
          ? (t('timeoutExceeded', lang) || t('noServer', lang))
          : (errorCode === 'no_user_id')
          ? t('noUserIdTryReopen', lang)
          : t('deleteFailed', lang);
      showNotice(errorToast, 'error');
    }
  }, [nick, lang, showNotice, installId]);


  /* avatar pick flow (gallery/camera/files) */
  const [pendingPicker, setPendingPicker] = useState<null | 'gallery' | 'camera'>(null);

  const openAvatarSheet = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [t('takePhoto', lang), t('chooseFromGallery', lang), t('cancel', lang)], cancelButtonIndex: 2, userInterfaceStyle: 'dark' },
        (i) => { if (i === 0) setPendingPicker('camera'); if (i === 1) setPendingPicker('gallery'); },
      );
    } else {
      setPendingPicker('gallery');
    }
  };

  useEffect(() => {
    if (!pendingPicker) return;
    let cancelled = false;

    (async () => {
      try {
        await new Promise((r) => setTimeout(r, 120));

        let localUri: string | undefined;

        if (pendingPicker === 'gallery') {
          const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.9 });
          if (!res.canceled) {
            const a = res.assets?.[0];
            localUri = await normalizeLocalImageUri(a?.uri ?? undefined, (a as any)?.assetId ?? null);
          }
        } else if (pendingPicker === 'camera') {
          let cam = await ImagePicker.getCameraPermissionsAsync();
          if (!cam.granted) cam = await ImagePicker.requestCameraPermissionsAsync();
          if (!cam.granted) { showNotice(t('noCamera', lang), 'error'); return; }

          const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.9 });
          if (!res.canceled) {
            const a = res.assets?.[0];
            localUri = await normalizeLocalImageUri(a?.uri ?? undefined, (a as any)?.assetId ?? null);
          }
        }

        if (!localUri) return;

        
        // Предзагружаем изображение в кэш перед показом для предотвращения мерцания
        try {
          // Предзагружаем с теми же параметрами, что и для отображения
          const thumbUrl = toAvatarThumb(localUri, 240, 240);
          if (thumbUrl) {
            await ExpoImage.prefetch(thumbUrl);
          }
          // Также предзагружаем оригинал
          await ExpoImage.prefetch(localUri);
          
          // Небольшая задержка после предзагрузки для стабильности
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch (e) {
          console.warn('🔄 Image prefetch failed:', e);
        }
        
        // Только локальное превью - загрузка будет при сохранении
        setAvatarUri(localUri);
        
        // Принудительно обновляем изображение для Android
        if (Platform.OS === 'android') {
          await forceImageRefresh();
          // Дополнительная задержка для Android
          await new Promise(resolve => setTimeout(resolve, 100));
          // Принудительно обновляем компонент
          setAvatarRefreshKey(prev => prev + 1);
        }
        
        // Сохраняем текущий никнейм в черновик, если он есть
        const currentNick = nick || '';
        await saveDraftProfile({ nick: currentNick, avatar: localUri });
      } catch (e) {
        console.warn('avatar pick flow error:', e);
        showNotice(t('pickImageFailed', lang), 'error');
      } finally {
        if (!cancelled) setPendingPicker(null);
      }
    })();


    return () => { cancelled = true; };
  }, [pendingPicker, showNotice, lang]);

  /* draft autosave for nick */
  useEffect(() => { saveDraftProfile({ nick }); }, [nick]);

  /* friend removed */
  useEffect(() => {
    const offRemoved = onFriendRemoved?.(({ userId }: { userId: string }) => {
      setFriends((prev) => prev.filter((f) => String(f.id) !== String(userId)));
    });
    return () => { offRemoved?.(); };
  }, []);

  /* prefetch my/friends avatars for UI */
  useEffect(() => {
    const urls: string[] = [];
    const me = toAvatarThumb(savedAvatarUrl || avatarUri, 240, 240);
    if (me) urls.push(me);
    for (const f of friends) if (f.avatar) urls.push(toAvatarThumb(f.avatar, 96, 96));
    urls.forEach((u) => (ExpoImage as any).prefetch?.(u));
  }, [savedAvatarUrl, avatarUri, friends, avatarRefreshKey]);

  /* wipe account */
  const wipeAccountOnServer = useCallback(async (id: string) => {
    const res = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const s: any = socket as any;
      if (!s) return resolve({ ok: false, error: 'no socket' });
      if (typeof s.timeout === 'function') {
        s.timeout(10000).emit('identity:wipeMe', { installId: id }, (err: any, r: any) => {
          if (err) return reject(err);
          resolve(r);
        });
      } else {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; reject(new Error('ack timeout')); } }, 10000);
        s.emit('identity:wipeMe', { installId: id }, (r: any) => { if (done) return; clearTimeout(t); done = true; resolve(r); });
      }
    });
    if (!res?.ok) throw new Error(res?.error || 'wipe failed');
  }, []);

  const handleWipeAccount = useCallback(async () => {
    if (wiping) return;

    setWiping(true);
    setMenuOpen(false);
    setInitialized(false); // Сбрасываем флаг инициализации

    try {
      if (!(socket as any)?.connected) { 
        showNotice(t('noServer', lang), 'error', 3000);
        setWiping(false);
        return;
      }

      const curId = installId || (await getInstallId());
      
      // 1. Удаляем на сервере
      await wipeAccountOnServer(curId);

      // 2. Жёсткий локальный сброс (очищает AsyncStorage и кэши)
      await hardLocalReset();
      
      // 3. КРИТИЧНО: Сбрасываем currentUserId в socket.ts, чтобы createUser() мог создать нового пользователя
      clearCurrentUserId();
      
      // 4. Сбрасываем React state
      resetAllState();

      // 5. Сбрасываем флаги загрузки, чтобы показать экран создания нового профиля
      setProfileLoaded(false);
      setDataLoaded(false);
      setNick('');
      setSavedNickDebug('');
      setSavedAvatarUrl('');
      setAvatarUri('');

      // 6. Сбрасываем installId
      await resetInstallId();
      const newId = await getInstallId();
      setInstallId(newId);

      // 7. КРИТИЧНО: Создаем нового пользователя после удаления старого
      // После clearCurrentUserId() createUser() создаст нового пользователя с новым installId
      const newUserId = await createUser();
      if (!newUserId) {
        throw new Error('Failed to create new user after account wipe');
      }
      logger.info('[handleWipeAccount] New user created:', { userId: newUserId, installId: newId });

      // 8. КРИТИЧНО: Устанавливаем флаги загрузки ПОСЛЕ создания пользователя
      // Для нового пользователя без данных profileLoaded должен быть true, чтобы показать экран создания профиля
      // Устанавливаем dataLoaded первым, затем profileLoaded
      setDataLoaded(true);
      setProfileLoaded(true);
      logger.info('[handleWipeAccount] Flags set, should show profile creation screen');
      
      // 9. КРИТИЧНО: Принудительно обновляем profileKey, чтобы loadProfileSync не вызывался снова
      // Это предотвращает сброс флагов после установки
      setProfileKey(prev => prev + 1);

      // 10. Показываем уведомление ПОСЛЕ всех операций сброса и установки флагов
      // Используем setTimeout, чтобы компонент успел отрендериться после сброса состояния
      setTimeout(() => {
        showNotice(t('accountWiped', lang), 'success', 3000);
      }, 300);
    } catch (e: any) {
      showNotice(`${t('wipeFailed', lang)}: ${e?.message || e}`, 'error', 3000);
      // При ошибке также устанавливаем флаги, чтобы не зависнуть на SplashLoader
      setProfileLoaded(true);
      setDataLoaded(true);
    } finally { 
      setWiping(false); 
    }
  }, [wiping, installId, showNotice, attachIdentitySafe, wipeAccountOnServer, lang, resetAllState]);


  /* ================= UI ================= */

  const onRefreshFriends = async () => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch { Vibration.vibrate(10); }
    setRefreshing(true);
    await loadFriends();
    setRefreshing(false);
  };

  const friendRowBlocksSwipeDelete = useCallback(
    (friend: Friend) => {
      const friendIdStr = String(friend.id);
      if (swipeActionsHiddenForCall === friendIdStr) return true;
      const g = global as any;
      const videoCallPartner = g.__videoCallPartnerUserIdRef?.current;
      if (
        isDirectCallSessionLive(g) &&
        videoCallPartner &&
        String(videoCallPartner) === friendIdStr
      ) {
        return true;
      }
      const isFriendBusy = friend.isBusy || false;
      const friendBusyBlocksCall =
        friend.online && isFriendBusy && !isRecentlyEndedCallFriend(friendIdStr);
      const inActiveCallWithFriend =
        isDirectCallSessionLive(g) &&
        !!videoCallPartner &&
        String(videoCallPartner) === friendIdStr;
      const isIncomingFromThisFriend =
        incomingCallScreen.visible &&
        incomingCallScreen.fromUserId != null &&
        String(incomingCallScreen.fromUserId) === friendIdStr;
      // Как в FriendCallActions: бейдж и при локальном активном звонке с другом.
      const showBusyBadge =
        (friendBusyBlocksCall || inActiveCallWithFriend) && !isIncomingFromThisFriend;
      if (showBusyBadge) return true;
      if (calling.visible && calling.friend && String(calling.friend.id) === friendIdStr) {
        return true;
      }
      return false;
    },
    [
      swipeActionsHiddenForCall,
      isRecentlyEndedCallFriend,
      incomingCallScreen.visible,
      incomingCallScreen.fromUserId,
      calling.visible,
      calling.friend,
    ],
  );

  const handleRemoveFriend = useCallback(
    async (peerId: string) => {
      const friend = friendsRef.current.find((f) => String(f.id) === String(peerId));
      if (friend && friendRowBlocksSwipeDelete(friend)) return;
      try {
        openSwipeableRef.current?.close?.();
      } catch {}
      openSwipeableRef.current = null;
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      } catch {
        Vibration.vibrate(12);
      }
      const prevFriends = friendsRef.current;
      setFriends((prev) => prev.filter((f) => f.id !== peerId));
      try {
        const res = await removeFriend(peerId);
        if (!res?.ok) throw new Error(res?.error || 'remove failed');
        showNotice(L('friendRemoved'), 'success', 3000);
      } catch (e: any) {
        setFriends(prevFriends);
        showNotice(`${L('friendRemoveFailed')}: ${e?.message || 'error'}`, 'error', 3000);
      }
    },
    [showNotice, L, friendRowBlocksSwipeDelete],
  );

  const clearMissedCallsForFriend = useCallback(async (friendIdStr: string) => {
    if (Platform.OS === 'android') {
      try { NativeModules.LiviAppModule?.cancelMissedCallNotificationForUser?.(friendIdStr); } catch (_) {}
      try { NativeModules.LiviAppModule?.removePendingMissedCall?.(friendIdStr); } catch (_) {}
    }
    try {
      const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
      const map: Record<string, number> = raw ? JSON.parse(raw) : {};
      if (typeof map === 'object' && map !== null) {
        delete map[friendIdStr];
        await AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(map));
      }
      setMissedByUser((prev) => {
        const next = { ...prev };
        delete next[friendIdStr];
        return next;
      });
      logger.debug('[HomeScreen] Reset missed calls for friend (removed key)', { friendId: friendIdStr });
      await syncAppBadgeFromMissedCount();
    } catch (e) {
      logger.warn('[HomeScreen] clearMissedCallsForFriend failed', { friendId: friendIdStr, error: (e as Error)?.message });
    }
  }, []);

  const friendBadgesSignature = React.useMemo(
    () => buildFriendBadgesSignature(missedByUser, unreadByUser),
    [missedByUser, unreadByUser],
  );
  const friendsCallSwipeBlockSignature = React.useMemo(
    () =>
      friends
        .map((f) => `${f.id}:${f.online ? 1 : 0}:${f.isBusy ? 1 : 0}`)
        .join(';'),
    [friends],
  );
  const friendsListExtraData = React.useMemo(
    () => ({
      friendActionsGestureResetSeq,
      videoCallEndedTick,
      callingVisible: calling.visible,
      incomingVisible: incomingCallScreen.visible,
      incomingFromUserId: incomingCallScreen.fromUserId ?? null,
      markReadFriendId: markReadMenu?.friendId ?? null,
      markReadMenuType: markReadMenu?.type ?? null,
      friendBadgesSignature,
      friendsCallSwipeBlockSignature,
      swipeActionsHiddenForCall,
    }),
    [
      friendActionsGestureResetSeq,
      videoCallEndedTick,
      calling.visible,
      incomingCallScreen.visible,
      incomingCallScreen.fromUserId,
      markReadMenu?.friendId,
      markReadMenu?.type,
      friendBadgesSignature,
      friendsCallSwipeBlockSignature,
      swipeActionsHiddenForCall,
    ],
  );

  // Показ уведомления «Звонок завершён» / «Вызов отменен», авто-открытие меню друзей, переход на вкладку «Друзья».
  // При переходе по тапу summary-уведомлений (пропущенные / непрочитанные) — снимаем уведомления из шторки и бейдж.
  useEffect(() => {
    const ended = (route as any)?.params?.callEnded;
    const cancelled = (route as any)?.params?.callCancelled;
    const openFriendsMenu = (route as any)?.params?.openFriendsMenu;
    const openFriendsTab = (route as any)?.params?.openFriendsTab;
    const pushMessageFrom = String((route as any)?.params?.pushMessageFrom || '').trim();
    if (ended) {
      suppressUpdateBadgeForCallNotice();
      showNotice(t('callEnded', lang), 'error', 3000);
    }
    if (cancelled) {
      suppressUpdateBadgeForCallNotice();
      showNotice(t('callCancelled', lang), 'error', 3000);
    }
    if (openFriendsMenu) {
      setMenuOpen(true);
    }
    if (openFriendsTab) {
      setTab('friends');
      if (pushMessageFrom && /^[a-f\d]{24}$/i.test(pushMessageFrom)) {
        dismissMessageNotificationsOnly().catch(() => {});
        setUnreadByUser((prev) => ({
          ...prev,
          [pushMessageFrom]: Math.max(1, prev[pushMessageFrom] || 0),
        }));
      }
    }
    if (openFriendsMenu || openFriendsTab) {
      AsyncStorage.getItem(MISSED_CALLS_KEY).then((raw) => {
        try {
          const parsed = raw ? JSON.parse(raw) : {};
          const normalized: Record<string, number> = {};
          if (parsed && typeof parsed === 'object') {
            Object.keys(parsed).forEach((key) => {
              const value = parsed[key];
              if (typeof value === 'number' && value > 0) normalized[String(key)] = value;
            });
          }
          setMissedByUser((prev) => {
            const merged = mergeMissedFromSources(prev, normalized, null);
            return badgeMapsEqual(prev, merged) ? prev : merged;
          });
        } catch {}
      }).catch(() => {});
    }
    if (ended || cancelled || openFriendsMenu || openFriendsTab) {
      clearHomeTransientRouteParams();
    }
  }, [route, showNotice, suppressUpdateBadgeForCallNotice]);

  // Отмена входящего, когда пользователь уже на Home: бейдж «Вызов отменён» на 3 сек через событие, без setParams — без лишних ре-рендеров
  useEffect(() => {
    const off = onCallCancelledOnHome((payload) => {
      const fromUserId = String(payload?.fromUserId || '').trim();
      if (fromUserId) clearFriendsCallBusy([fromUserId]);
      suppressUpdateBadgeForCallNotice();
      showNotice(t('callCancelled', lang), 'error', 3000);
    });
    return off;
  }, [showNotice, lang, suppressUpdateBadgeForCallNotice, clearFriendsCallBusy]);

  // Завершение звонка (закрытие экрана через goBack): тост «Звонок завершён» при фокусе на Home, без setParams — без лишних ре-рендеров
  useEffect(() => {
    const off = onCallEndedOnHome(() => {
      suppressUpdateBadgeForCallNotice();
      showNotice(t('callEnded', lang), 'error', 3000);
    });
    return off;
  }, [showNotice, lang, suppressUpdateBadgeForCallNotice]);

  // «Занято» при неудачном дозвоне — toast; бейдж isBusy только с presence:update (реальный звонок).
  useEffect(() => {
    const onBusy = (_payload: { from: string }) => {
      const callIdToClose = activeOutgoingCallIdRef.current || calling.callId || null;
      setCalling({ visible: false, friend: null, callId: null });
      try { setOutgoingCallScreenVisible(false); } catch {}
      try { closeOutgoingCallActivity(callIdToClose, { force: true }); } catch {}
      activeOutgoingAttemptRef.current = 0;
      activeOutgoingCallIdRef.current = null;
      callingVisibleRef.current = false;
      showNotice(t('user_busy', lang), 'error', 3000);
    };

    socket.on('call:busy', onBusy);
    return () => { socket.off('call:busy', onBusy as any); };
  }, [calling.callId, showNotice, lang]);

  // Старый обработчик удален - используем новую систему статусов

  // Показываем SplashLoader только пока данные загружаются
  // Если данные загружены (dataLoaded = true) и профиль загружен (profileLoaded = true),
  // но нет ника и аватара (hasRealData = false), то показываем экран создания профиля
  const currentNick = savedNick || nick || '';
  const currentAvatar = avatarUri || savedAvatarUrl || '';
  const hasRealData = (currentNick && currentNick.trim()) || (currentAvatar && currentAvatar.trim());
  // Home всегда монтируется под сплешем.
  // Сам сплеш ждёт server/dataLoaded только в пределах окна 2.5с, после чего исчезает принудительно.
  const showSplashOverlay = !splashDismissed;
  const [showCallSearchLockBadge, setShowCallSearchLockBadge] = useState(false);
  const hasActiveCallForSearch =
    pip.visible ||
    pip.inSystemPiPMode ||
    pip.pendingSystemPiP ||
    calling.visible ||
    incomingCallScreen.visible ||
    (global as any).__videoCallActiveRef?.current === true;
  const handleBlockedStartSearchPress = useCallback(() => {
    setShowCallSearchLockBadge(true);
  }, []);
  const handleOpenMenu = useCallback(() => {
    setMenuOpen(true);
  }, [setMenuOpen]);
  const handleStartSearch = useCallback(() => {
    navigation.navigate('RandomChat', { returnTo: { name: 'Home' } });
  }, [navigation]);
  const handleOpenAvatarModal = useCallback((uri: string) => {
    setModalAvatarUri(uri);
    setAvatarModalVisible(true);
  }, []);
  const centerProfile = React.useMemo(
    () => ({
      savedNick,
      avatarUri,
      myFullAvatarUri,
      myAvatarVer,
      resolvedAvatarUri,
      resolvedAvatarReady,
      avatarVerChecked,
      onOpenAvatarModal: handleOpenAvatarModal,
    }),
    [
      savedNick,
      avatarUri,
      myFullAvatarUri,
      myAvatarVer,
      resolvedAvatarUri,
      resolvedAvatarReady,
      avatarVerChecked,
      handleOpenAvatarModal,
    ],
  );
  useEffect(() => {
    if (!hasActiveCallForSearch) {
      setShowCallSearchLockBadge(false);
    }
  }, [hasActiveCallForSearch]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
    <SafeAreaView
        style={[
          styles.container,
          {
            paddingTop: Platform.OS === "android" ? 20 : 0,
            backgroundColor: theme.colors.background,
          },
        ]}
        edges={Platform.OS === "android" ? ['top', 'bottom','left','right'] : ['bottom','left','right','top']}
      >
      <StatusBar
        barStyle={Platform.OS === 'android' || menuOpen || isDark ? 'light-content' : 'dark-content'}
        translucent={Platform.OS === 'android'}
        backgroundColor={Platform.OS === 'android' ? 'transparent' : undefined}
      />


      <HomeWelcomeView
        styles={styles}
        isDark={isDark}
        themeBackground={theme.colors.background as string}
        layoutWidth={layoutWidth}
        layoutHeight={layoutHeight}
        L={L}
        menuBtnInnerBg={MENU_BTN_INNER_BG}
        menuChromeBg={MENU_CHROME_BG}
        onOpenMenu={handleOpenMenu}
        unreadByUser={unreadByUser}
        missedByUser={missedByUser}
        centerProfile={centerProfile}
        NoticeView={NoticeView}
        hasActiveCallForSearch={hasActiveCallForSearch}
        showCallSearchLockBadge={showCallSearchLockBadge}
        onStartSearch={handleStartSearch}
        onBlockedStartSearch={handleBlockedStartSearchPress}
        splashGone={!showSplashOverlay}
      />

      {/* Модалка аватара: полный экран, блюр/затемнение, круг 3×, pinch-to-zoom, тап вне — закрыть. Без вложенности touch/gesture (Nesting touch handlers with native animated driver). */}
      {avatarModalVisible && (
        <View style={[StyleSheet.absoluteFill, { zIndex: 1000 }]} pointerEvents="box-none">
          {Platform.OS === 'ios' ? (
            <>
              <BlurView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
              <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.2)' }]} />
            </>
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,1.0)' }]} />
          )}
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setAvatarModalVisible(false)} />
          <View style={[StyleSheet.absoluteFill, { justifyContent: 'center', alignItems: 'center' }]} pointerEvents="box-none">
            <PinchGestureHandler onGestureEvent={onAvatarModalPinchEvent} onHandlerStateChange={onAvatarModalPinchStateChange}>
              <Animated.View
                style={[
                  {
                    width: avatarModalSize,
                    height: avatarModalSize,
                    borderRadius: avatarModalSize / 2,
                    overflow: 'hidden' as const,
                    alignItems: 'center',
                    justifyContent: 'center',
                    transform: [{ scale: avatarModalScale }],
                  },
                ]}
              >
                {modalAvatarUri ? (
                  modalAvatarDisplayUri ? (
                    <ExpoImage
                      {...getAvatarImageProps(modalAvatarDisplayUri, `avatar_modal_${resolvedUserId}_${myAvatarVer}`)}
                      style={{ width: avatarModalSize, height: avatarModalSize }}
                    />
                  ) : (
                  <View style={{ width: avatarModalSize, height: avatarModalSize, borderRadius: avatarModalSize / 2, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: LIVI.titan, fontSize: avatarModalSize * 0.35, fontWeight: '500' }}>{displayAvatarLetter(savedNick)}</Text>
                  </View>
                  )
                ) : (
                  <View style={{ width: avatarModalSize, height: avatarModalSize, borderRadius: avatarModalSize / 2, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: LIVI.titan, fontSize: avatarModalSize * 0.35, fontWeight: '500' }}>{displayAvatarLetter(savedNick)}</Text>
                  </View>
                )}
              </Animated.View>
            </PinchGestureHandler>
          </View>
        </View>
      )}

      {/* Оверлей всегда смонтирован (мгновенный open). Скрыт через opacity+offscreen, пока menuOpen=false —
          иначе в app-switcher «торчат» вкладки. menuOpen/tab при фоне не сбрасываем. */}
      <HomeMenuOverlay
        styles={styles}
        menuOpen={menuOpen}
        menuOverlayOpacity={menuOverlayOpacity}
        menuOverlayTranslateY={menuOverlayTranslateY}
        closeMenu={closeMenu}
        onHeaderBackPress={
          wallpaperPickerTheme
            ? () => setWallpaperPickerTheme(null)
            : closeMenu
        }
        tab={tab}
        setTab={setTab}
        L={L}
        updateAvailable={updateAvailable}
      >
              {menuTabsMounted ? (
                <View
                  style={
                    tab === 'friends'
                      ? { flex: 1 }
                      : { display: 'none' as const }
                  }
                  pointerEvents={tab === 'friends' ? 'auto' : 'none'}
                  collapsable={false}
                >
                <HomeFriendsTab
                  friends={friends}
                  refreshing={refreshing}
                  onRefresh={onRefreshFriends}
                  initialized={initialized}
                  friendsListExtraData={friendsListExtraData}
                  markReadMenu={markReadMenu}
                  setMarkReadMenu={setMarkReadMenu}
                  setUnreadByUser={setUnreadByUser}
                  L={L}
                  lang={lang}
                  styles={styles}
                  navigation={navigation}
                  prepareFriendRowActionTap={prepareFriendRowActionTap}
                  handleStartFriendCall={handleStartFriendCall}
                  clearMissedCallsForFriend={clearMissedCallsForFriend}
                  friendRowBlocksSwipeDelete={friendRowBlocksSwipeDelete}
                  handleRemoveFriend={handleRemoveFriend}
                  calling={calling}
                  callingVisibleRef={callingVisibleRef}
                  activeOutgoingAttemptRef={activeOutgoingAttemptRef}
                  activeOutgoingCallIdRef={activeOutgoingCallIdRef}
                  lastChatOpenRef={lastChatOpenRef}
                  menuOpen={menuOpen}
                  donateVisible={donateVisible}
                  shareVisible={shareVisible}
                  inviteRequestVisible={inviteRequestVisible}
                  roomFullVisible={roomFull.visible}
                  incomingCallScreen={incomingCallScreen}
                  missedByUser={missedByUser}
                  unreadByUser={unreadByUser}
                  isRecentlyEndedCallFriend={isRecentlyEndedCallFriend}
                  resetOutgoingAfterExternalClose={resetOutgoingAfterExternalClose}
                  openSwipeableRef={openSwipeableRef}
                  swipeableRefsMap={swipeableRefsMap}
                />
                </View>
              ) : null}
              {menuTabsMounted && tab === 'settings' && (
                <SettingsTab
                  nick={nick}
                  setNick={(v) => {
                    nickLiveRef.current = v;
                    nickInputDirtyRef.current = true;
                    setNick(v);
                    saveDraftProfile({ nick: v });
                    // ВАЖНО: НЕ сохраняем ник в постоянное хранилище на каждый ввод.
                    // Иначе при резком "убийстве" приложения может записаться промежуточное значение (например, только первая буква),
                    // а затем при старте оно перезапишет ник на сервере через ensureIdentity/attachIdentity.
                  }}
                  avatarUri={avatarUri}
                  setAvatarUri={(u) => {
                    setAvatarUri(u);
                    saveDraftProfile({ avatar: u });
                    setAvatarRefreshKey((k) => k + 1);
                    // Также сохраняем в основное хранилище
                    // ВАЖНО: берём ник из live-ref (state может "догонять" при быстром вводе + выборе аватара)
                    saveProfileToStorage({ nick: String(nickLiveRef.current || nick || ''), avatar: u }).catch(() => {});
                  }}
                  refreshKey={avatarRefreshKey}
                  openAvatarSheet={openAvatarSheet}
                  handleSaveProfile={handleSaveProfile}
                  savedToast={savedToast}
                  setSavedToast={setSavedToast}
                  LIVI={LIVI}
                  styles={styles}
                  onClearNick={handleClearNick}
                  saving={saving}
                  onDeleteAvatar={handleDeleteAvatar}
                  // Передаём информацию о кешированном аватаре
                  myFullAvatarUri={myFullAvatarUri}
                  myAvatarVer={myAvatarVer}
                  myUserId={getCurrentUserId()}
                  handleWipeAccount={handleWipeAccount}
                  wiping={wiping}
                  lang={lang}
                  isDark={isDark}
                />
              )}
              {menuTabsMounted && tab === 'more' && (
                <HomeMoreTab
                  styles={styles}
                  L={L}
                  lang={lang}
                  preference={preference}
                  setPreference={setPreference}
                  accent={accent}
                  isDark={isDark}
                  openLangPicker={openLangPicker}
                  incrCounter={incrCounter}
                  setDonateVisible={setDonateVisible}
                  generateInviteLink={generateInviteLink}
                  updateAvailable={updateAvailable}
                  updateSpinAnim={updateSpinAnim}
                  wallpaperPickerTheme={wallpaperPickerTheme}
                  setWallpaperPickerTheme={setWallpaperPickerTheme}
                />
              )}
      </HomeMenuOverlay>

      {/* ───── Комната занята (caller info) ───── */}
      {roomFull.visible && (
        <View style={styles.overlayModal} pointerEvents="box-none">
          <BlurView intensity={50} tint="dark" style={StyleSheet.absoluteFill} />
          <View
            style={{
              alignItems: 'center',
              justifyContent: 'center',
              padding: 20,
              borderRadius: 16,
              backgroundColor: 'rgba(13,14,16,0.9)',
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: 'rgba(255,255,255,0.12)'
            }}
          >
            <Text style={{ color: LIVI.white, fontWeight: '700', fontSize: 16, textAlign: 'center' }}>{t('roomBusyTitle', lang)}</Text>
            {!!roomFull.name && <Text style={{ color: LIVI.text2, marginTop: 6 }}>{roomFull.name}</Text>}
            <TouchableOpacity onPress={() => setRoomFull({ visible: false })} activeOpacity={0.85} style={[styles.confirmBtn, { marginTop: 14, width: 120, backgroundColor: 'rgba(255,255,255,0.08)' }]}>
              <Text style={[styles.confirmBtnText, { color: LIVI.white }]}>{t('ok', lang)}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <LanguagePicker visible={langPickerVisible} onClose={closeLangPicker} onSelect={(code) => { void handleSelectLang(code); }} current={lang} />

      {ConfirmView}

      <Portal>
        {donateVisible && (
          <View style={styles.overlayModal} pointerEvents="box-none">
            {Platform.OS === 'android' ? (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.9)' }]} />
            ) : (
              <>
                <BlurView intensity={85} tint="dark" style={StyleSheet.absoluteFill} />
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.35)' }]} />
              </>
            )}
            <ChatStyleBackButton
              onPress={() => setDonateVisible(false)}
              iconColor={LIVI.titan}
              style={{
                position: 'absolute',
                zIndex: 10,
                top: insets.top + (Platform.OS === 'android' ? 35 : 16),
                left: Platform.OS === 'ios' ? 15 : 17,
              }}
            />
            <Surface
              style={[
                styles.confirmCard,
                {
                  minWidth: 300,
                  maxWidth: 400,
                  borderWidth: 1,
                  borderColor: accent.solid28,
                  borderRadius: 10,
                },
              ]}
            >
              <Text
                style={[
                  styles.confirmTitle,
                  { textAlign: 'center', marginBottom: 8, color: accent.softText, fontWeight: '600' },
                ]}
              >
                {t('supportProjectTitle', lang)}
              </Text>
              <Text
                style={{
                  color: LIVI.text2,
                  fontSize: 13,
                  fontWeight: '300',
                  textAlign: 'center',
                  marginBottom: 20,
                  lineHeight: 18,
                }}
              >
                {t('supportProjectSubtitle', lang)}
              </Text>
              <View style={{ marginBottom: 20 }}>
                <TouchableOpacity
                  onPress={async () => {
                    const clicks = await incrCounter('support_boosty_clicks');
                    const url = appendUtm(BOOSTY_URL, {
                      utm_source: 'livi_app',
                      utm_medium: 'support',
                      utm_campaign: 'donate',
                      utm_content: 'boosty',
                      utm_count: String(clicks),
                    });
                    logger.info('[support] Open Boosty', { url });
                    Linking.openURL(url);
                  }}
                  onPressIn={() => setPressedButton('boosty')}
                  onPressOut={() => setPressedButton(null)}
                  activeOpacity={1}
                  style={{
                    backgroundColor: pressedButton === 'boosty' ? accent.softText : accent.solid10,
                    borderColor: accent.solid28,
                    borderWidth: 1,
                    paddingVertical: 10,
                    paddingHorizontal: 16,
                    borderRadius: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 12,
                    gap: 8,
                  }}
                >
                  <ExpoImage
                    source={require('../assets/boosty-sign-logo.png')}
                    style={{ width: 22, height: 22 }}
                    contentFit="contain"
                    cachePolicy="memory-disk"
                  />
                  <Text style={{ 
                    color: LIVI.white, 
                    fontWeight: '700', 
                    fontSize: 15 
                  }}>
                    Boosty.to
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={async () => {
                    const clicks = await incrCounter('support_patreon_clicks');
                    const url = appendUtm(PATREON_URL, {
                      utm_source: 'livi_app',
                      utm_medium: 'support',
                      utm_campaign: 'donate',
                      utm_content: 'patreon',
                      utm_count: String(clicks),
                    });
                    logger.info('[support] Open Patreon', { url });
                    Linking.openURL(url);
                  }}
                  onPressIn={() => setPressedButton('patreon')}
                  onPressOut={() => setPressedButton(null)}
                  activeOpacity={1}
                  style={{
                    backgroundColor: pressedButton === 'patreon' ? accent.softText : accent.solid10,
                    borderColor: accent.solid28,
                    borderWidth: 1,
                    paddingVertical: 10,
                    paddingHorizontal: 16,
                    borderRadius: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  <ExpoImage
                    source={require('../assets/patreon-sign-logo.png')}
                    style={{ width: 22, height: 22 }}
                    contentFit="contain"
                    cachePolicy="memory-disk"
                  />
                  <Text style={{ 
                    color: LIVI.white, 
                    fontWeight: '700', 
                    fontSize: 15 
                  }}>
                    Patreon
                  </Text>
                </TouchableOpacity>
              </View>
            </Surface>
          </View>
        )}

        {/* Share/Invite Modal */}
        {shareVisible && (
          <View style={styles.overlayModal} pointerEvents="box-none">
            {Platform.OS === 'android' ? (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.9)' }]} />
            ) : (
              <>
                <BlurView intensity={85} tint="dark" style={StyleSheet.absoluteFill} />
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.35)' }]} />
              </>
            )}
            <ChatStyleBackButton
              onPress={() => setShareVisible(false)}
              iconColor={LIVI.titan}
              style={{
                position: 'absolute',
                zIndex: 10,
                top: insets.top + (Platform.OS === 'android' ? 35 : 16),
                left: Platform.OS === 'ios' ? 15 : 17,
              }}
            />
            <Surface
              style={[
                styles.confirmCard,
                {
                  minWidth: 300,
                  maxWidth: 400,
                  borderWidth: 1,
                  borderColor: 'rgba(77,208,225,0.3)',
                  borderRadius: 10,
                },
              ]}
            >
              <Text
                style={[
                  styles.confirmTitle,
                  { textAlign: 'center', marginBottom: 8, color: '#4DD0E1', fontWeight: '600' },
                ]}
              >
                {t('inviteFriendTitle', lang)}
              </Text>
              <Text
                style={{
                  color: LIVI.text2,
                  fontSize: 13,
                  fontWeight: '300',
                  textAlign: 'center',
                  marginBottom: 20,
                  lineHeight: 18,
                }}
              >
                {t('inviteFriendsSubtitle', lang)}
              </Text>
              
              <View style={{ marginBottom: 20 }}>
                <Text style={{ color: LIVI.text2, fontSize: 14, marginBottom: 8, fontWeight: '600' }}>
                  {t('inviteLinkLabel', lang)}
                </Text>
                <View style={{
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  borderWidth: 1,
                  borderColor: 'rgba(77,208,225,0.3)',
                  borderRadius: 10,
                  paddingVertical: 8,
                  paddingHorizontal: 10,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8
                }}>
                  <Text 
                    style={{ 
                      flex: 1, 
                      color: LIVI.white, 
                      fontSize: 13,
                      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace'
                    }}
                    numberOfLines={1}
                    ellipsizeMode="middle"
                  >
                    {inviteLink}
                  </Text>
                  <TouchableOpacity
                    onPress={async () => {
                      try {
                        await Clipboard.setStringAsync(inviteLink);
                        showNotice(t('linkCopied', lang), 'success', 3000);
                        await incrCounter('invite_link_copied');
                      } catch (e) {
                        logger.error('Failed to copy link:', e);
                        showNotice(t('copyFailed', lang), 'error', 3000);
                      }
                    }}
                    activeOpacity={0.7}
                    style={{
                      padding: 6,
                      borderRadius: 8,
                      backgroundColor: 'rgba(77,208,225,0.15)'
                    }}
                  >
                    <Ionicons name="copy-outline" size={18} color="#4DD0E1" />
                  </TouchableOpacity>
                </View>
                <Text style={{ color: LIVI.text2, fontSize: 12, marginTop: 8, textAlign: 'center', lineHeight: 16 }}>
                  {t('inviteShareHint', lang)}
                </Text>
              </View>

              <View style={{ gap: 12 }}>
                <TouchableOpacity
                  onPress={async () => {
                    try {
                      const shareMessage = t('inviteShareMessage', lang).replace('{link}', inviteLink);
                      
                      // Используем Share из React Native для текстовых ссылок
                      const result = await Share.share({
                        message: shareMessage,
                        url: inviteLink, // Для iOS это будет использовано как URL
                        title: t('inviteShareTitle', lang),
                      });
                      
                      if (result.action === Share.sharedAction) {
                        await incrCounter('invite_link_shared');
                        if (result.activityType) {
                          // Поделились через конкретное приложение
                          logger.debug('Shared via:', result.activityType);
                        }
                      } else if (result.action === Share.dismissedAction) {
                        // Пользователь отменил
                        logger.debug('Share dismissed');
                      }
                    } catch (e) {
                      logger.error('Failed to share link:', e);
                      // Fallback на копирование при ошибке
                      try {
                        await Clipboard.setStringAsync(inviteLink);
                        showNotice(t('linkCopied', lang), 'success', 3000);
                      } catch (copyError) {
                        showNotice(t('shareFailed', lang), 'error', 3000);
                      }
                    }
                  }}
                  activeOpacity={0.85}
                  style={{
                    backgroundColor: 'rgba(77, 208, 225, 0.12)',
                    borderWidth: 1,
                    borderColor: 'rgba(77,208,225,0.3)',
                    paddingVertical: 10,
                    paddingHorizontal: 16,
                    borderRadius: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  <Ionicons name="share-outline" size={18} color={LIVI.white} />
                  <Text style={{ 
                    color: LIVI.white, 
                    fontWeight: '700', 
                    fontSize: 15 
                  }}>
                    {t('share', lang)}
                  </Text>
                </TouchableOpacity>
              </View>
            </Surface>
          </View>
        )}

        {/* Invite Request Modal */}
        {inviteRequestVisible && inviteRequestData && (
          <View style={styles.overlayModal} pointerEvents="box-none">
            {Platform.OS === 'android' ? (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.9)' }]} />
            ) : (
              <>
                <BlurView intensity={85} tint="dark" style={StyleSheet.absoluteFill} />
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.35)' }]} />
              </>
            )}
            <Surface style={[styles.confirmCard, { minWidth: 300, maxWidth: 400, borderColor: '#4DD0E1' }]}>
              <Text style={[styles.confirmTitle, { textAlign: 'center', marginBottom: 20, color: '#4DD0E1' }]}>
                {t('friendInviteTitle', lang)}
              </Text>
              
              {inviteRequestData.areFriends ? (
                <View style={{ marginBottom: 20 }}>
                  <Text style={{ color: LIVI.text2, fontSize: 14, textAlign: 'center', marginBottom: 12 }}>
                    {t('alreadyFriendsWithUser', lang).replace(
                      '{user}',
                      trimNick(inviteRequestData.inviter.nick) || t('thisUser', lang),
                    )}
                  </Text>
                  <TouchableOpacity
                    onPress={handleDeclineInvite}
                    activeOpacity={0.85}
                    style={{
                      backgroundColor: '#4DD0E1',
                      paddingVertical: 14,
                      paddingHorizontal: 20,
                      borderRadius: 10,
                      alignItems: 'center'
                    }}
                  >
                    <Text style={{ color: LIVI.white, fontWeight: '700', fontSize: 16 }}>
                      {t('ok', lang)}
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <>
                  <View style={{ marginBottom: 20, alignItems: 'center' }}>
                    {inviteRequestData.inviter.avatarThumbB64 ? (
                      <AvatarImage
                        userId={inviteRequestData.inviter.id}
                        avatarVer={inviteRequestData.inviter.avatarVer}
                        uri={inviteRequestData.inviter.avatarThumbB64}
                        size={64}
                        fallbackText={trimNick(inviteRequestData.inviter.nick)?.[0]?.toUpperCase() || '?'}
                        containerStyle={{ marginBottom: 12 }}
                      />
                    ) : (
                      <View style={{
                        width: 64,
                        height: 64,
                        borderRadius: 32,
                        backgroundColor: '#4DD0E1',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginBottom: 12
                      }}>
                        <Text style={{ color: LIVI.white, fontSize: 24, fontWeight: '800' }}>
                          {trimNick(inviteRequestData.inviter.nick)?.[0]?.toUpperCase() || '?'}
                        </Text>
                      </View>
                    )}
                    <Text style={{ color: LIVI.white, fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' }}>
                      {trimNick(inviteRequestData.inviter.nick) || t('user', lang)}
                    </Text>
                    <Text style={{ color: LIVI.text2, fontSize: 14, textAlign: 'center' }}>
                      {t('wantsToAddYouAsFriend', lang)}
                    </Text>
                  </View>

                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <TouchableOpacity
                      onPress={handleDeclineInvite}
                      activeOpacity={0.85}
                      style={{
                        flex: 1,
                        backgroundColor: 'rgba(255,255,255,0.08)',
                        borderColor: LIVI.border,
                        borderWidth: StyleSheet.hairlineWidth,
                        paddingVertical: 14,
                        paddingHorizontal: 20,
                        borderRadius: 10,
                        alignItems: 'center'
                      }}
                    >
                      <Text style={{ color: LIVI.white, fontWeight: '700', fontSize: 16 }}>
                        {t('decline', lang)}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={handleAcceptInvite}
                      activeOpacity={0.85}
                      style={{
                        flex: 1,
                        backgroundColor: '#4DD0E1',
                        borderColor: '#4DD0E1',
                        borderWidth: StyleSheet.hairlineWidth,
                        paddingVertical: 14,
                        paddingHorizontal: 20,
                        borderRadius: 10,
                        alignItems: 'center'
                      }}
                    >
                      <Text style={{ color: LIVI.white, fontWeight: '700', fontSize: 16 }}>
                        {t('accept', lang)}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </Surface>
          </View>
        )}
      </Portal>
    </SafeAreaView>

    {showSplashOverlay && (
      <View style={[StyleSheet.absoluteFillObject, { zIndex: 9998 }]} pointerEvents="box-none">
        <SplashLoader
          dataLoaded={dataLoaded}
          hasNick={!!(currentNick && currentNick.trim())}
          hasAvatar={!!(currentAvatar && currentAvatar.trim())}
          onComplete={() => setSplashDismissed(true)}
        />
      </View>
    )}
    </View>
  );
}
