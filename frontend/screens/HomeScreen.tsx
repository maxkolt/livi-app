// screens/HomeScreen.tsx
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  FlatList,
  Dimensions,
  Platform,
  KeyboardAvoidingView,
  ActionSheetIOS,
  Animated,
  Easing,
  StyleProp,
  ViewStyle,
  AppState,
  NativeModules,
  ActivityIndicator,
  Linking,
} from 'react-native';

import { syncMyStreamProfile } from '../chat/cometchat';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import * as ImagePicker from 'expo-image-picker';
import SplashLoader from '../components/SplashLoader';
import { Swipeable } from 'react-native-gesture-handler';
import { Avatar, Divider, IconButton, List, Surface, Portal, Dialog, Button } from 'react-native-paper';
import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { getAvatarImageProps, getAvatarKey, forceImageRefresh } from '../utils/imageOptimization';
import AvatarImage from '../components/AvatarImage';
import AsyncStorage from '@react-native-async-storage/async-storage';


import {
  toAvatarThumb,
  normalizeLocalImageUri,
} from '../utils/uploadAvatar';

import LanguagePicker from '../components/LanguagePicker';
import { useAppTheme, ThemePreference } from '../theme/ThemeProvider';
import { t, loadLang, saveLang, defaultLang } from '../utils/i18n';
import type { Lang } from '../utils/i18n';

// expo-linear-gradient -> react-native-linear-gradient -> fallback
const LinearGradient: any = (() => {
  try {
    return require("expo-linear-gradient").LinearGradient;
  } catch {
    try {
      return require("react-native-linear-gradient").default;
    } catch {
      return ({ style, children }: any) => (
        <View style={[{ backgroundColor: "#2EE6FF" }, style]}>{children}</View>
      );
    }
  }
})();

import { getInstallId, resetInstallId } from '../utils/installId';
import { logger } from '../utils/logger';
import { onMessageReceived, onMessageReadReceipt, getUnreadCount, onCallTimeout as onCallTimeoutEvent, onCallIncoming as onCallIncomingEvent, onCallDeclined as onCallDeclinedEvent } from '../sockets/socket';
import { onMissedIncrement, onRequestCloseIncoming, emitCloseIncoming } from '../utils/globalEvents';
import SettingsTab from '../components/SettingsTab';
import { loadProfileFromStorage, saveProfileToStorage, clearAllAvatarCaches } from '../utils/profileStorage';
// УБРАНО: forceClearUserDataOnly не используется - вместо этого используется hardLocalReset() и clearAllUserData() из socket.ts
import { warmAvatar, putThumb, putFull, getFull, clearAvatarCacheFor } from '../utils/avatarCache';
import * as FileSystem from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

import socket, {
  fetchFriends,
  onFriendAccepted,
  onFriendRequest,
  onPresenceUpdate,
  inviteFriend,
  onConnected,
  onFriendRemoved,
  removeFriend,
  updateProfile,
  onFriendProfile,
  emitAck,
  attachIdentity,
  getCurrentUserId,
  setCurrentUserId,
  checkUserExists,
  clearAllUserData,
  API_BASE,
  startCall,
  cancelCall,
  getMyProfile,
  onCallAccepted,
  onCallDeclined,
  onCallTimeout,
  onCallRoomFull,
  onDisconnected,
} from '../sockets/socket';





/* ================= constants/helpers ================= */

type Props = { navigation: any };

type Friend = {
  id: string;
  name?: string;
  avatar?: string; // маркер наличия аватара
  avatarVer?: number; // версия аватара для кеширования
  avatarThumbB64?: string; // data URI миниатюры для списков
  online: boolean;
  isBusy?: boolean;
  isRandomBusy?: boolean;
  inCall?: boolean;
};

const LIVI = {
  bg: '#151F33',
  surface: '#0D0E10',
  glass: 'rgba(255,255,255,0.06)',
  border: 'rgba(255,255,255,0.12)',
  text: '#AEB6C6',
  text2: '#9FA7B4',
  accent: '#715BA8',
  titan: '#8A8F99',
  white: '#F4F5F7',
  green: '#2ECC71',
  red: '#FF5A67',
  darkText: '#151515',
  textThemeWhite: "#444444" 
};

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
const { width, height } = Dimensions.get("screen");

const displayName = (name?: string) => (name && name.trim().length ? name : '—');
const displayAvatarLetter = (name?: string) => {
  const n = (name || '').trim();
  return n ? n.slice(0, 1).toUpperCase() : '—';
};

const mapToFriend = (u: any): Friend => {
  const mapped = {
    id: String(u._id ?? u.id ?? ''),
    name: u.nick || u.name || u.username || '',
    avatar: u.avatar || u.image || '',
    avatarVer: typeof u.avatarVer === 'number' ? u.avatarVer : 0,
    avatarThumbB64: u.avatarThumbB64 || '', // data URI миниатюры
    online: !!u.online || !!u.isOnline,
    isBusy: !!u.isBusy,
    isRandomBusy: !!u.isRandomBusy,
    inCall: !!u.inCall,
  };

  return mapped;
};

const DRAFT_KEY = 'profile_draft_v1';
const MISSED_CALLS_KEY = 'missed_calls_by_user_v1';
const PROFILE_KEY = 'livi.profile.v1';
const INSTALL_ID_KEY = 'livi.installId';
const USER_ID_KEY = 'userId';

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
    ];

    // Удаляем основные ключи
    await AsyncStorage.multiRemove(keysToRemove);

    // 2. Очищаем все чаты и статусы (паттерны chat_messages_, chat_statuses_)
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const chatKeys = allKeys.filter(k => 
        k.startsWith('chat_messages_') || 
        k.startsWith('chat_statuses_')
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
const waitSocketConnected = () =>
  new Promise<void>((resolve) => {
    if ((socket as any)?.connected) return resolve();
    const on = () => { socket.off('connect', on); resolve(); };
    socket.on('connect', on);
  });

/* ==== notice banner ==== */
type NoticeKind = 'info' | 'success' | 'error';
const useLiviNotice = () => {
  const [notice, setNotice] = useState<{ text: string; kind: NoticeKind } | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isDark } = useAppTheme();

  const hide = useCallback(() => {
    Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => setNotice(null));
  }, [opacity]);

  const show = useCallback((text: string, kind: NoticeKind = 'info', ms = 1700) => {
    if (!text) return;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setNotice({ text, kind });
    Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }).start(() => {
      if (ms > 0) timerRef.current = setTimeout(hide, ms);
    });
  }, [hide, opacity]);

  const view = notice ? (
    <Animated.View
      style={[
        styles.notice,
        {
          opacity,
          borderColor: notice.kind === 'error' ? LIVI.red : notice.kind === 'success' ? LIVI.green : LIVI.accent,
          backgroundColor:
            notice.kind === 'error'
              ? (isDark ? 'rgba(255,90,103,0.16)' : 'rgba(255,90,103,0.30)')
              : notice.kind === 'success'
              ? (isDark ? 'rgba(42,135,81,0.16)' : 'rgba(42,135,81,0.30)')
              : (isDark ? 'rgba(113,91,168,0.15)' : 'rgba(113,91,168,0.28)'),
        },
      ]}
    >
      <Text style={[styles.noticeText, { color: isDark ? LIVI.text2 : LIVI.textThemeWhite }]}>{notice.text}</Text>
    </Animated.View>
  ) : null;

  return { showNotice: show, hideNotice: hide, NoticeView: view };
};

/* ==== confirm modal ==== */
  const useLiviConfirm = () => {
  const [state, setState] = useState<{ visible: boolean; title: string; message?: string; confirmText?: string; cancelText?: string; resolve?: (v: boolean) => void; }>({ visible: false, title: '' });

  const ask = useCallback((opts: { title: string; message?: string; confirmText?: string; cancelText?: string }) =>
    new Promise<boolean>((resolve) => {
      setState({ visible: true, title: opts.title, message: opts.message, confirmText: opts.confirmText || 'ОК', cancelText: opts.cancelText || 'Отмена', resolve });
    }), []);
  const onCancel = useCallback(() => { state.resolve?.(false); setState((s) => ({ ...s, visible: false })); }, [state]);
  const onOk     = useCallback(() => { state.resolve?.(true);  setState((s) => ({ ...s, visible: false })); }, [state]);

  const view = state.visible ? (
    <View style={styles.overlayModal}>
      <BlurView intensity={Platform.OS === 'android' ? 100 : 85} tint="dark" style={StyleSheet.absoluteFill} />
      {/* Дополнительное затемнение для Android */}
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: Platform.OS === 'android' ? 'rgba(0,0,0,0.58)' : 'rgba(0,0,0,0.35)' },
        ]}
      />
      <Surface style={styles.confirmCard}>
        <Text style={styles.confirmTitle}>{state.title}</Text>
        {!!state.message && <Text style={styles.confirmMsg}>{state.message}</Text>}
        <View style={styles.confirmBtns}>
          <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: LIVI.glass }]} onPress={onCancel}>
            <Text style={[styles.confirmBtnText, { color: LIVI.white }]}>{state.cancelText}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: LIVI.red }]} onPress={onOk}>
            <Text style={[styles.confirmBtnText, { color: LIVI.white }]}>{state.confirmText}</Text>
          </TouchableOpacity>
        </View>
      </Surface>
    </View>
  ) : null;

  return { askConfirm: ask, ConfirmView: view };
};

/* ================= Animated Border Button Component ================= */

type AnimatedBorderButtonProps = {
  isDark: boolean;
  onPress: () => void;
  label: string;
  style?: ViewStyle;
  backgroundColor?: string; // Цвет фона страницы для перекрытия градиента
};

const AnimatedBorderButton: React.FC<AnimatedBorderButtonProps> = ({ isDark, onPress, label, style, backgroundColor }) => {
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const [blurIntensity, setBlurIntensity] = useState<number>(isDark ? 15 : 20);
  const titanOpacity = useRef(new Animated.Value(0.25)).current;
  const borderWidth = 2; // Тонкий бордер

  // Цвета из палитры эквалайзера для темной темы - зациклены для непрерывности
  const darkColors = [
    '#14b8a6', '#3b82f6', '#00b5ff', '#FFF8F0', // бирюзовый, синий, голубой, жемчужно-белый
    '#14b8a6', '#3b82f6', '#00b5ff', '#FFF8F0', // дублируем для плавного перехода
  ];
  
  // Цвета из палитры эквалайзера для светлой темы - зациклены для непрерывности
  const lightColors = [
    '#a78bfa', '#FFF8F0', '#B0B5BF', // фиолетовый, жемчужно-белый, светлый титан (осветлен)
    '#a78bfa', '#FFF8F0', '#B0B5BF', // дублируем для плавного перехода
  ];
  
  const colors = isDark ? darkColors : lightColors;

  useEffect(() => {
    // Запускаем анимацию сразу при монтировании
    rotateAnim.setValue(0);
    const rotateAnimation = Animated.loop(
      Animated.timing(rotateAnim, {
        toValue: 1,
        duration: 3000, // одинаковая скорость для обеих тем
        easing: Easing.linear, // линейная для непрерывности
        useNativeDriver: true,
      }),
      { iterations: -1 } // бесконечный цикл
    );
    rotateAnimation.start();

    return () => {
      rotateAnimation.stop();
      rotateAnim.stopAnimation();
    };
  }, [rotateAnim]);

  const rotate = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  // Функция для конвертации hex в rgba
  const hexToRgba = (hex: string, alpha: number): string => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  // Цвет титана в зависимости от темы
  const titanColor = isDark ? '#8A8F99' : '#3B4453'; // LIVI.titan для темной, LightPalette.titan для светлой
  const titanRgba = hexToRgba(titanColor, 0.25); // 25% непрозрачности для еще большей прозрачности

  const buttonWidth = Platform.OS === "ios" ? screenWidth - 60 : screenWidth - 40;
  const buttonHeight = Platform.OS === "ios" ? 60 : 50;
  const borderRadius = 12;
  const gradientSize = Math.max(buttonWidth, buttonHeight) * 2; // Достаточно большой для плавного движения

  return (
    <View style={[{ alignItems: 'center', justifyContent: 'center' }, style]}>
      {/* Внешний контейнер для отражения/тени */}
      <View
        style={{
        
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Контейнер с градиентной рамкой и внешним отражением */}
        <View
          style={{
            width: buttonWidth + borderWidth * 2,
            height: buttonHeight + borderWidth * 2,
            borderRadius: borderRadius + borderWidth,
            overflow: 'hidden',
            shadowOpacity: 0, // Тень убрана
            elevation: 0,
            ...(Platform.OS === "android" && !isDark ? {
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: 'rgba(138, 143, 153, 0.3)', // Титановый цвет с прозрачностью для светлой темы
            } : {}),
          }}
        >
          {/* Анимированный градиент - заполняет весь контейнер */}
          <Animated.View
            style={{
              position: 'absolute',
              width: gradientSize,
              height: gradientSize,
              left: (buttonWidth + borderWidth * 2 - gradientSize) / 2,
              top: (buttonHeight + borderWidth * 2 - gradientSize) / 2,
              transform: [{ rotate }],
            }}
          >
            <LinearGradient
              colors={colors}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{
                width: '100%',
                height: '100%',
              }}
            />
          </Animated.View>
          
          {/* Внутренний контейнер - перекрывает центр градиента, создавая эффект рамки */}
          <View
            style={{
              position: 'absolute',
              top: borderWidth,
              left: borderWidth,
              right: borderWidth,
              bottom: borderWidth,
              borderRadius: borderRadius,
              overflow: 'hidden',
              backgroundColor: backgroundColor || (isDark ? '#151F33' : '#8a8f99'), // Для светлой темы используем цвет как у других кнопок (btnTitan)
            }}
          >
            {/* Эффект стекла с blur - фон страницы просвечивает через размытие */}
            <BlurView
              intensity={blurIntensity}
              tint={isDark ? 'dark' : 'light'}
              style={{
                ...StyleSheet.absoluteFillObject,
                borderRadius: borderRadius,
              }}
            />
            {/* Титановый слой с прозрачностью - создает эффект титанового стекла */}
            <Animated.View
              style={{
                ...StyleSheet.absoluteFillObject,
                borderRadius: borderRadius,
                backgroundColor: titanColor,
                opacity: titanOpacity,
              }}
            />
            <TouchableOpacity
              activeOpacity={1}
              onPressIn={() => {
                // Увеличиваем blur и прозрачность титана при нажатии - более заметно для светлой темы
                setBlurIntensity(isDark ? 25 : 40);
                Animated.timing(titanOpacity, {
                  toValue: isDark ? 0.4 : 0.5, // Больше для светлой темы
                  duration: 150,
                  useNativeDriver: true,
                }).start();
              }}
              onPressOut={() => {
                // Возвращаем к исходным значениям
                setBlurIntensity(isDark ? 15 : 20);
                Animated.timing(titanOpacity, {
                  toValue: 0.25,
                  duration: 200,
                  useNativeDriver: true,
                }).start();
              }}
              onPress={onPress}
              style={{
                width: '100%',
                height: '100%',
                borderRadius: borderRadius,
                backgroundColor: 'transparent', // Полностью прозрачный фон
                alignItems: 'center',
                justifyContent: 'center',
                paddingHorizontal: 32,
              }}
            >
              <Text style={[styles.buttonLabel, { color: isDark ? LIVI.text : LIVI.textThemeWhite, textAlign: 'center' }]}>{label}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </View>
  );
};

/* ================= component ================= */

export default function HomeScreen({ navigation, route }: Props & { route?: { params?: { callEnded?: boolean } } }) {
  const insets = useSafeAreaInsets();
  const { preference, setPreference, theme, isDark } = useAppTheme();

  /* friends state */
  const [friends, setFriends] = useState<Friend[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const friendsRef = useRef<Friend[]>([]);
  useEffect(() => { friendsRef.current = friends; }, [friends]);

  /* tabs & menu */
  const [menuOpen, setMenuOpen] = useState(false);
  const [tab, setTab] = useState<'friends' | 'settings' | 'more'>('friends');

  /* profile state */
  const [saving, setSaving] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const [wiping, setWiping] = useState(false);

  // Синхронная загрузка профиля при инициализации
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [nick, setNick] = useState('');
  const [avatarUri, setAvatarUri] = useState<string>('');      // может быть file:// для локального превью
  const [myFullAvatarUri, setMyFullAvatarUri] = useState<string>(''); // полный аватар (data URI)
  const [avatarRefreshKey, setAvatarRefreshKey] = useState(0); // для принудительного обновления на Android
  const [savedNick, setSavedNick] = useState<string>('');      // сохранённый ник
  
  // Отладочная версия setSavedNick с логированием
  const setSavedNickDebug = useCallback((value: string) => {
    setSavedNick(value);
  }, []);
  const [savedAvatarUrl, setSavedAvatarUrl] = useState<string>(''); // ТОЛЬКО https или ''
  const [myAvatarVer, setMyAvatarVer] = useState<number>(0);   // версия моего аватара
  const [profileKey, setProfileKey] = useState(0);

  const [installId, setInstallId] = useState<string>('');
  const prevAvatarRef = useRef<string>('');

  const [unreadByUser, setUnreadByUser] = useState<Record<string, number>>({});
  const pendingAttachRef = useRef<{ nick?: string; avatar?: string } | null>(null);
  const { askConfirm, ConfirmView } = useLiviConfirm();
  
  /* УДАЛЕНО: устаревшие статусы "Занято" - теперь используется friend.isBusy */

  /* ===== Защита от дублирования вызовов ===== */
  const ensureIdentityRef = useRef<Promise<any> | null>(null);
  const attachIdentityRef = useRef<Promise<any> | null>(null);

  /* ===== Сброс всего React state ===== */
  const resetAllState = useCallback(async () => {
    setFriends([]);
    setNick('');
    setSavedNickDebug('');
    setAvatarUri('');
    setSavedAvatarUrl('');
    setMyAvatarVer(0);
    setMyFullAvatarUri('');
    setUnreadByUser({});
    setProfileKey(k => k + 1);
    setAvatarRefreshKey(k => k + 1);
    setCurrentUserId('');

    // Очищаем версию аватара из AsyncStorage
    try {
      const currentUserId = getCurrentUserId();
      if (currentUserId) {
        await AsyncStorage.removeItem(`avatarVer_${currentUserId}`);
      }
    } catch (e) {
      logger.warn('Failed to remove avatar version:', e);
    }
  }, []);
  
  // Android: красим системную нижнюю панель под текущий экран/оверлей
  useEffect(() => {
    (async () => {
      if (Platform.OS !== 'android' || !(NativeModules as any)?.ExpoNavigationBar) return;
      try {
        const NavigationBar = await import('expo-navigation-bar');
        // Когда меню (друзья/профиль/ещё) открыто, фон тёмный даже в светлой теме → ставим тёмный цвет,
        // иначе используем фон темы экрана (светлый/тёмный)
        const bg = menuOpen ? '#0D0E10' : (theme.colors.background as string);
        await NavigationBar.setBackgroundColorAsync(bg);
        try { await NavigationBar.setButtonStyleAsync(menuOpen ? 'light' : (isDark ? 'light' : 'dark')); } catch {}
        try { await NavigationBar.setBehaviorAsync('inset-swipe'); } catch {}
        try { await NavigationBar.setPositionAsync(menuOpen ? 'absolute' : 'relative'); } catch {}
        try { await NavigationBar.setVisibilityAsync('visible'); } catch {}
      } catch {}
    })();
  }, [menuOpen, theme.colors.background, isDark]);


  /* language */
  const [lang, setLang] = useState<Lang>(defaultLang);
  const [langPickerVisible, setLangPickerVisible] = useState(false);
  const L = useCallback((key: string) => t(key, lang), [lang]);
  
  // ===== Donate modal =====
  const [donateVisible, setDonateVisible] = useState(false);
  const [pressedButton, setPressedButton] = useState<'boosty' | 'patreon' | null>(null);
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
      console.warn(`[analytics] ${key} -> ${next}`);
      return Number(next);
    } catch {
      return 0;
    }
  }, []);
  
  useEffect(() => { (async () => { setLang(await loadLang()); })(); }, []);
  const openLangPicker  = () => setLangPickerVisible(true);
  const closeLangPicker = () => setLangPickerVisible(false);
  const handleSelectLang = async (code: Lang) => { setLang(code); await saveLang(code); setLangPickerVisible(false); };

  const { showNotice: baseShowNotice, NoticeView } = useLiviNotice();
  const showNotice = useCallback((text: string, kind: NoticeKind = 'info', ms = 1700) => {
    const normalized = (text ?? '').trim().toLowerCase();
    if (normalized === t('saved', lang).toLowerCase() || normalized === `${t('saved', lang).toLowerCase()}!`) {
      setSavedToast(true); return;
    }
    baseShowNotice(text, kind, ms);
  }, [baseShowNotice, setSavedToast, lang]);

  /* ===== Call (outgoing modal) ===== */
  const [calling, setCalling] = useState<{ visible: boolean; friend?: Friend | null; callId?: string | null }>({ visible: false });
  const [missedByUser, setMissedByUser] = useState<Record<string, number>>({});
  const [missedLoaded, setMissedLoaded] = useState(false);
  const lastIncomingFromRef = useRef<string | null>(null);
  const [roomFull, setRoomFull] = useState<{ visible: boolean; name?: string }>({ visible: false });
  const wave1 = useRef(new Animated.Value(0)).current;
  const wave2 = useRef(new Animated.Value(0)).current;
  const wave3 = useRef(new Animated.Value(0)).current;

  const waveStyle = (i: number) => {
    const v = i === 0 ? wave1 : i === 1 ? wave2 : wave3;
    const scale = v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.4] });
    const opacity = v.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });
    return {
      position: 'absolute' as const,
      width: 160,
      height: 160,
      borderRadius: 80,
      borderWidth: 2,
      borderColor: 'rgba(255,255,255,0.35)',
      transform: [{ scale }],
      opacity,
    };
  };

  const startWaves = useCallback(() => {
    const loop = (val: Animated.Value, delay: number) => {
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(val, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      ).start();
    };
    loop(wave1, 0); loop(wave2, 400); loop(wave3, 800);
  }, [wave1, wave2, wave3]);

  const stopWaves = useCallback(() => {
    wave1.stopAnimation(); wave2.stopAnimation(); wave3.stopAnimation();
  }, [wave1, wave2, wave3]);

  const pendingCancelRef = useRef(false);

  const handleStartVideoCall = useCallback(async (friend: Friend) => {
    try {
      setCalling({ visible: true, friend, callId: null });
      startWaves();
      const r: any = await startCall(friend.id);
      if (!r?.ok) throw new Error(r?.error || 'call_failed');
      setCalling((c) => ({ ...c, callId: r.callId || null }));

      // Если пользователь успел нажать «Отменить» до прихода callId — шлём отмену сразу после ack
      if (pendingCancelRef.current && r.callId) {
        try { cancelCall(r.callId); } catch {}
        pendingCancelRef.current = false;
        setCalling({ visible: false, friend: null, callId: null });
        stopWaves();
        return;
      }

      let cleaned = false;
      const offAccepted = onCallAccepted?.(({ callId }) => {
        if (cleaned) return; cleaned = true;
        logger.debug('Call accepted', { callId });
        // Приняли прямой звонок — сбрасываем бейдж пропущенных для этого друга
        try {
          setMissedByUser((prev) => {
            const next = { ...prev, [friend.id]: 0 };
            AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(next)).catch(() => {});
            return next;
          });
        } catch {}
        setCalling({ visible: false, friend: null, callId: null });
        stopWaves();
        // Переход в экран видеочата (мы инициатор) с передачей callId
        navigation.navigate('VideoChat', { 
          callMode: 'friends', 
          directCall: true, 
          directInitiator: true, 
          peerUserId: friend.id, 
          callId: callId, // ← ДОБАВЛЕНО: передаём callId
          returnTo: { name: 'Home', params: { openFriendsMenu: true } } 
        });
      });
      const offDeclined = onCallDeclined?.(() => {
        if (cleaned) return; cleaned = true;
        // Получатель отклонил: инициатор НЕ увеличивает пропущенные
        setCalling({ visible: false, friend: null, callId: null });
        stopWaves();
        showNotice('Вызов отклонён', 'error', 1800);
      });
      const offTimeout = onCallTimeout?.(() => {
        if (cleaned) return; cleaned = true;
        // Таймаут: у инициатора счётчик не увеличиваем, просто закрываем UI
        setCalling({ visible: false, friend: null, callId: null });
        stopWaves();
        showNotice('Нет ответа', 'error', 1800);
      });
      const offRoomFull = onCallRoomFull?.(() => {
        if (cleaned) return; cleaned = true;
        setCalling({ visible: false, friend: null, callId: null });
        stopWaves();
        setRoomFull({ visible: true, name: friend.name || '' });
        setTimeout(() => setRoomFull({ visible: false, name: '' }), 2000);
      });

      // Таймаут на клиенте (20 сек) как safeguard
      setTimeout(() => {
        if (!cleaned) {
          cleaned = true;
          setCalling({ visible: false, friend: null, callId: null });
          stopWaves();
          showNotice('Нет ответа', 'error', 1800);
        }
      }, 20000);

      // Очистка будет при срабатывании одного из событий или таймаута
      return () => { offAccepted?.(); offDeclined?.(); offTimeout?.(); offRoomFull?.(); };
    } catch (e: any) {
      setCalling({ visible: false, friend: null, callId: null });
      stopWaves();
      showNotice('Не удалось инициировать вызов', 'error', 2000);
    }
  }, [navigation, showNotice, startWaves, stopWaves]);

  const handleCancelCall = useCallback(() => {
    if (calling.callId) {
      try {
        cancelCall(calling.callId);
        // Повторно через 150мс на случай сетевой гонки
        setTimeout(() => { try { cancelCall(calling.callId!); } catch {} }, 150);
      } catch {}
    } else {
      // callId ещё не пришёл — отметим, чтобы отменить сразу после ack
      pendingCancelRef.current = true;
    }
    setCalling({ visible: false, friend: null, callId: null });
    stopWaves();
  }, [calling.callId, stopWaves]);

  /* friends fetch */
  const loadFriendsRef = useRef<Promise<void> | null>(null);
  const loadFriends = useCallback(async () => {
    // Защита от дублирования запросов
    if (loadFriendsRef.current) {
      return loadFriendsRef.current;
    }
    
    const promise = (async () => {
      try {
        try { await waitSocketConnected(); } catch {}
        const res = await fetchFriends?.();
        const incoming = Array.isArray(res?.list) ? res.list : [];
        const fresh = incoming.map(mapToFriend);
        setFriends((prev) => {
          const merged: Friend[] = fresh.map((f) => {
            const prevOne = prev.find((p) => p.id === f.id) as any;
            return {
              ...f,
              name: f.name || prevOne?.name || '',
              avatar: f.avatar || prevOne?.avatar || '',
              avatarThumbB64: f.avatarThumbB64 || prevOne?.avatarThumbB64 || '',
              online: !!f.online,
              isBusy: !!f.isBusy, // Используем новое значение из API
              isRandomBusy: !!prevOne?.isRandomBusy,
              inCall: !!prevOne?.inCall,
            } as any;
          });

          // Кэшируем миниатюры для offline использования
          try {
            merged.forEach((f) => {
              if (f.avatarThumbB64 && f.avatarVer) {
                putThumb(f.id, f.avatarVer, f.avatarThumbB64).catch((e) => {
                  logger.warn('Failed to cache thumb:', e);
                });
              } else {}
            });
          } catch (e) {
            logger.warn('Error caching thumbs:', e);
          }

          return merged;
        });
      } catch (e) {
      logger.warn('Friends load error', e);
    } finally {
      setInitialized(true);
      loadFriendsRef.current = null;
    }
    })();
    
    loadFriendsRef.current = promise;
    return promise;
  }, []);

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

          const payload = { installId: params?.installId ?? '', profile: profilePayload };

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

      const currentUserId = getCurrentUserId();
      if (!currentUserId) {
        return true; // Продолжаем загрузку данных
      }

      // Проверяем существует ли пользователь в MongoDB
      const userExists = await checkUserExists(currentUserId);
      
      if (userExists === false) {
        console.warn('[syncUserData] User not found on server, performing hard reset...');
        
        // Жёсткий локальный сброс
        if (typeof hardLocalReset === 'function') {
          await hardLocalReset();
        }
        
        if (typeof resetAllState === 'function') {
          resetAllState();
        }
        
        if (typeof showNotice === 'function') {
          showNotice('Пользователь удален, данные очищены', 'error', 3000);
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
      const localInstallId = await getInstallId();
      setInstallId(localInstallId);

      // 1. Проверяем, есть ли userId
      const existingUserId = getCurrentUserId();

      let userExistsOnServer: boolean | null = false;

      // 2. Если userId есть - проверяем его существование на сервере
      if (existingUserId) {
        try {
          userExistsOnServer = await checkUserExists(existingUserId);

          if (userExistsOnServer === false) {
            console.warn('[ensureIdentity] User not found on server, performing hard reset...');
            
            // Жёсткий локальный сброс
            await hardLocalReset();
            resetAllState();
            
            // Attach без профиля (создаст нового пользователя)
            await attachIdentitySafe({ installId: localInstallId, profile: {} });
            return;
          }
        } catch (e) {
          console.warn('[ensureIdentity] Failed to check user existence:', e);
          // Продолжаем работу - возможно просто нет интернета
          userExistsOnServer = true; // считаем что пользователь существует
        }
      }

      // 3. Загружаем черновик/профиль ТОЛЬКО если пользователь СУЩЕСТВУЕТ на сервере
      // Для новых пользователей (!existingUserId) НЕ загружаем черновик
      // Это предотвращает "воскрешение" данных удалённого пользователя
      let localNick = '';
      let cachedAvatar = '';
      let draftAvatar = '';

      if (userExistsOnServer && existingUserId) {
        const draft = await loadDraftProfile();
        const cached = await loadProfileFromStorage();

        localNick = (cached?.nick ?? draft?.nick ?? '') as string;

        if (/^user_[a-z0-9]{3,10}$/i.test(localNick)) {
          localNick = '';
        }

        cachedAvatar = (cached?.avatar ?? '') as string; // ТОЛЬКО https или ''
        draftAvatar = (draft?.avatar ?? '') as string; // может быть file://
      } else if (!existingUserId) {} else {}

      // 4. Подставляем данные в UI ТОЛЬКО для существующих пользователей
      // Для новых пользователей показываем пустые поля (пользователь введёт сам)

      // savedNick - только для существующих пользователей
      if (userExistsOnServer && existingUserId && !savedNick && localNick) {
        setSavedNickDebug(localNick);
      } else if (!existingUserId || !userExistsOnServer) {
        setSavedNickDebug('');
      }

      // savedAvatarUrl - только для существующих пользователей
      if (userExistsOnServer && existingUserId) {
        setSavedAvatarUrl(cachedAvatar);
      } else {
        setSavedAvatarUrl('');
        try { await clearAllAvatarCaches(); } catch {}
      }

      // nick - только для существующих пользователей
      // Не перезаписываем если пользователь уже что-то ввел
      if (!nick || nick.trim() === '') {
        if (userExistsOnServer && existingUserId && localNick) {
          setNick(localNick);
        } else {
          setNick('');
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
        if (existingUserId && userExistsOnServer && draftAvatar) {
          return draftAvatar;
        }
        return '';
      });

      const profile: { nick?: string; avatar?: string } = {};

      // Передаём профиль только если пользователь СУЩЕСТВУЕТ на сервере
      // Для новых пользователей profile = {} (будет проигнорирован в attachIdentitySafe)
      if (userExistsOnServer && existingUserId) {
        if (typeof localNick === 'string') profile.nick = localNick.trim();
        if (cachedAvatar === '') profile.avatar = '';
        else if (/^https?:\/\//i.test(String(cachedAvatar))) profile.avatar = String(cachedAvatar).trim();
      } else {}

      // Проверяем, нужно ли вызывать attachIdentitySafe
      const currentUserId = getCurrentUserId();
      if (currentUserId && userExistsOnServer) {
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
        const currentNick = (nick ?? '').trim();
        const currentAvatarUri = (avatarUri ?? '').trim();

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
  }, [attachIdentitySafe, nick, savedNick, resetAllState, avatarUri]);

  // Синхронная загрузка профиля для предотвращения мерцания
  const loadProfileSync = useCallback(async () => {
    try {
      const currentUserId = getCurrentUserId();
      if (!currentUserId) {
        console.log('[HomeScreen] No currentUserId, skipping profile load');
        return;
      }

      // КРИТИЧНО: Сначала загружаем данные из локального кэша для мгновенного отображения
      let cachedNick = ''; // Локальные переменные для данных из кэша
      let cachedAvatar = '';
      
      try {
        const cached = await loadProfileFromStorage();
        if (cached) {
          // Загружаем никнейм из кэша, если текущий пустой или не установлен
          if (cached.nick && typeof cached.nick === 'string' && cached.nick.trim()) {
            const currentNick = nick || '';
            if (!currentNick || !currentNick.trim()) {
              cachedNick = cached.nick;
              setNick(cached.nick);
              setSavedNick(cached.nick);
              setSavedNickDebug(cached.nick);
              console.log('[HomeScreen] Loaded nick from cache:', cached.nick);
            }
          }
          // Загружаем аватар из кэша, если текущий пустой или не установлен
          if (cached.avatar && typeof cached.avatar === 'string' && cached.avatar.trim()) {
            const currentAvatar = avatarUri || '';
            if (!currentAvatar || !currentAvatar.trim()) {
              cachedAvatar = cached.avatar;
              setAvatarUri(cached.avatar);
              setMyFullAvatarUri(cached.avatar);
              setSavedAvatarUrl(cached.avatar);
              console.log('[HomeScreen] Loaded avatar from cache');
            }
          }
        }
      } catch (e) {
        console.warn('[HomeScreen] Failed to load from cache:', e);
      }

      // Ждем подключения и авторизации socket перед загрузкой с сервера
      try {
        await waitSocketConnected();
        // Небольшая задержка для завершения reauth
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (e) {
        console.warn('[HomeScreen] Socket connection wait failed:', e);
      }

      console.log('[HomeScreen] Loading profile for userId:', currentUserId);

      // Загружаем профиль из MongoDB через backend с retry
      let profileLoadedSuccess = false;
      let hasActualData = false; // Флаг что данные реально установлены
      let loadedNick = ''; // Локальные переменные для отслеживания загруженных данных
      let loadedAvatar = ''; // (state обновляется асинхронно)
      
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          console.log(`[HomeScreen] Loading profile attempt ${attempt}/5...`);
          const profileResponse = await getMyProfile();
          
          // Проверяем что профиль не пустой (должен быть хотя бы nick или avatar)
          if (profileResponse?.ok && profileResponse.profile) {
            const profile = profileResponse.profile;
            logger.debug('Loaded profile from backend', { nick: profile.nick, hasAvatar: !!profile.avatarB64 });
            
            // Обновляем никнейм из backend
            if (profile.nick && typeof profile.nick === 'string' && profile.nick.trim()) {
              loadedNick = profile.nick;
              setNick(profile.nick);
              setSavedNick(profile.nick);
              setSavedNickDebug(profile.nick);
              console.log('[HomeScreen] Set nick from backend:', profile.nick);
              hasActualData = true;
            }
            
            // Обновляем аватар из backend
            if (profile.avatarB64 && typeof profile.avatarB64 === 'string') {
              const avatarDataUri = `data:image/jpeg;base64,${profile.avatarB64}`;
              loadedAvatar = avatarDataUri;
              setMyFullAvatarUri(avatarDataUri);
              setAvatarUri(avatarDataUri);
              setSavedAvatarUrl(avatarDataUri);
              console.log('[HomeScreen] Set avatar from backend avatarB64');
              logger.debug('Set avatar from backend avatarB64');
              hasActualData = true;
            } else if (profile.avatarThumbB64 && typeof profile.avatarThumbB64 === 'string') {
              const avatarDataUri = `data:image/jpeg;base64,${profile.avatarThumbB64}`;
              loadedAvatar = avatarDataUri;
              setMyFullAvatarUri(avatarDataUri);
              setAvatarUri(avatarDataUri);
              setSavedAvatarUrl(avatarDataUri);
              console.log('[HomeScreen] Set avatar from backend avatarThumbB64');
              logger.debug('Set avatar from backend avatarThumbB64');
              hasActualData = true;
            }
            
            // Обновляем версию аватара
            if (typeof profile.avatarVer === 'number') {
              setMyAvatarVer(profile.avatarVer);
            }
            
            // Проверяем что данные реально установлены перед сохранением
            // Сохраняем в локальный кэш только если есть реальные данные
            if (hasActualData || (profile.nick && profile.nick.trim()) || profile.avatarB64 || profile.avatarThumbB64) {
              await saveProfileToStorage({
                nick: profile.nick || '',
                avatar: profile.avatarB64 ? `data:image/jpeg;base64,${profile.avatarB64}` : ''
              });
              
              profileLoadedSuccess = true;
              console.log('[HomeScreen] Profile loaded successfully with data');
            } else {
              console.warn('[HomeScreen] Profile response received but no actual data (empty profile)');
            }
            
            // Выходим из цикла только если получили реальные данные
            if (profileLoadedSuccess) {
              break;
            }
          } else {
            console.warn(`[HomeScreen] Profile load attempt ${attempt}: empty or invalid response`);
          }
        } catch (e) {
          console.warn(`[HomeScreen] Profile load attempt ${attempt} failed:`, e);
          if (attempt < 5) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2 секунды задержка
          }
        }
      }
      
      // Проверяем есть ли реальные данные после всех попыток загрузки
      // Используем локальные переменные вместо state (state обновляется асинхронно)
      // Приоритет: загруженные с сервера > из кэша > из текущего state
      const finalNick = loadedNick || cachedNick || nick || '';
      const finalAvatar = loadedAvatar || cachedAvatar || avatarUri || '';
      const hasRealData = (finalNick && finalNick.trim()) || (finalAvatar && finalAvatar.trim());
      
      if (!profileLoadedSuccess) {
        console.warn('[HomeScreen] All profile load attempts failed, checking cached data');
        
        // Если профиль не загрузился с сервера, проверяем есть ли данные в кэше
        const cached = await loadProfileFromStorage();
        if (!cached || (!cached.nick && !cached.avatar)) {
          console.warn('[HomeScreen] No cached data found, clearing profile');
          // Нет кэша - очищаем все локальные данные
          if (!hasRealData) {
            setNick('');
            setSavedNickDebug('');
            setSavedAvatarUrl('');
            setAvatarUri('');
            
            // Очищаем локальное хранилище
            try {
              await AsyncStorage.removeItem('profile');
              await AsyncStorage.removeItem('livi.home.draft.v1');
              console.log('[HomeScreen] Cleared local storage after profile deletion');
            } catch (e) {
              console.warn('[HomeScreen] Failed to clear local storage:', e);
            }
          }
        } else {
          console.log('[HomeScreen] Using cached profile data due to server failure');
        }
      }

      // Устанавливаем profileLoaded только если есть реальные данные
      if (hasRealData || profileLoadedSuccess) {
        console.log('[HomeScreen] Profile loading complete, has data:', { hasNick: !!(finalNick && finalNick.trim()), hasAvatar: !!(finalAvatar && finalAvatar.trim()) });
        setProfileLoaded(true);
      } else {
        console.warn('[HomeScreen] Profile loading complete but no data found');
        // Не устанавливаем profileLoaded = true, чтобы SplashLoader оставался видимым
      }

      // Всегда устанавливаем dataLoaded = true после попытки загрузки
      setDataLoaded(true);
    } catch (e) {
      console.warn('[HomeScreen] Failed to load profile from storage:', e);
      setDataLoaded(true); // Даже при ошибке помечаем как загружено
    }
  }, [setSavedNickDebug]);

  /* ===== load profile from storage on init ===== */
  useEffect(() => {
    // Загружаем профиль только если он еще не загружен
    if (!profileLoaded) {
      loadProfileSync();
    }
  }, [loadProfileSync, profileKey, getCurrentUserId(), profileLoaded]); // Перезагружаем при изменении profileKey или currentUserId

  /* ===== Автозагрузка локального аватара в Cloudinary/Server ===== */
  // Auto-upload отключен - теперь загружаем только при явном нажатии "Сохранить"
  // Это предотвращает попытки использовать старый HTTP endpoint (404)

  /* ===== initial boot ===== */
  useEffect(() => {
    (async () => {
      try { await waitSocketConnected().catch(() => {}); } catch {}
      
      // Сначала синхронизируем данные пользователя
      const userExists = await syncUserData();
      
      // Если пользователь существует, загружаем его данные
      if (userExists !== false) {
        await ensureIdentity();
      }
      
      //
      await loadFriends();
      // Инициализация пропущенных видеозвонков из хранилища
      try {
        const rawMissed = await AsyncStorage.getItem(MISSED_CALLS_KEY);
        setMissedByUser(rawMissed ? JSON.parse(rawMissed) : {});
        setMissedLoaded(true);
      } catch {}
    })();
  }, [syncUserData, ensureIdentity, loadFriends]);

  // Сохраняем пропущенные вызовы при изменении
  useEffect(() => {
    if (!missedLoaded) return;
    try { AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(missedByUser)).catch(() => {}); } catch {}
  }, [missedByUser, missedLoaded]);

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

        // socket identity (на случай оффлайна)
        pendingAttachRef.current = { nick: (savedNick || nick || '').trim(), avatar: '' };
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

  /* ===== refresh friends === */
  useEffect(() => {
    if (menuOpen && tab === 'friends') {
      setInitialized(true);
      void loadFriends();
      const tmr = setInterval(() => void loadFriends(), 10_000);
      return () => clearInterval(tmr);
    }
  }, [menuOpen, tab, loadFriends]);

  /* ===== warm avatar cache когда открыта вкладка друзей === */
  useEffect(() => {
    if (menuOpen && tab === 'friends' && friends.length > 0) {
      // Предзагружаем аватары всех друзей
      friends.forEach(f => {
        if (f.avatarVer) {
          warmAvatar(f.id, f.avatarVer).catch(() => {});
        }
      });
    }
  }, [menuOpen, tab, friends]);

  // ===== inCall busy flag: слушаем старт/конец звонков и отмечаем друзей как занятых =====
  useEffect(() => {
    const markAllInRoom = (busy: boolean) => {
      setFriends((prev) => prev.map((f: any) => (
        busy ? { ...f, inCall: true } : { ...f, inCall: false }
      )));
    };
    const onCallEnded = () => markAllInRoom(false);
    const onCallStarted = () => markAllInRoom(true);
    try { socket.on('call:ended', onCallEnded); } catch {}
    try { socket.on('call:accepted', onCallStarted); } catch {}
    return () => { try { socket.off('call:ended', onCallEnded); } catch {}; try { socket.off('call:accepted', onCallStarted); } catch {}; };
  }, []);

  /* ===== app resume ===== */
  const appStateRef = useRef(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      const wasBg = /inactive|background/.test(appStateRef.current);
      appStateRef.current = state;
      if (wasBg && state === 'active') {
        try {
          await waitSocketConnected();
          
          // Синхронизируем данные при возобновлении приложения
          const userExists = await syncUserData();
          
          if (userExists) {
            await ensureIdentity();
            const currentUserId = getCurrentUserId();
            if (currentUserId) {
              //
            } else {
            }
          }
          await loadFriends();
        } catch (e) { console.warn('resume error', e); }
      }
    });
    return () => sub.remove();
  }, [syncUserData, ensureIdentity, loadFriends]);

  /* ===== navbar color sync when overlay opens ===== */
  useEffect(() => {
    if (Platform.OS !== 'android' || !(NativeModules as any)?.ExpoNavigationBar) return;
    (async () => {
      try {
        const NavigationBar = await import('expo-navigation-bar');
        const applyOnce = async () => {
          await NavigationBar.setBackgroundColorAsync(menuOpen ? '#0D0E10' : (theme.colors.background as string));
          try { await NavigationBar.setBehaviorAsync('inset-swipe'); } catch {}
          try { await NavigationBar.setPositionAsync(menuOpen ? 'absolute' : 'relative'); } catch {}
          await NavigationBar.setButtonStyleAsync(menuOpen ? 'light' : (isDark ? 'light' : 'dark'));
        };
        await applyOnce();
        setTimeout(applyOnce, 50);
        setTimeout(applyOnce, 250);
      } catch {}
    })();
  }, [menuOpen, theme.colors.background, isDark]);

  /* ===== enforce navbar on focus (when returning from recents) ===== */
  useEffect(() => {
    if (Platform.OS !== 'android' || !(NativeModules as any)?.ExpoNavigationBar) return;
    const sub = navigation?.addListener?.('focus', async () => {
      try {
        const NavigationBar = await import('expo-navigation-bar');
        const applyOnce = async () => {
          await NavigationBar.setBackgroundColorAsync(theme.colors.background as string);
          try { await NavigationBar.setBehaviorAsync('inset-swipe'); } catch {}
          try { await NavigationBar.setPositionAsync('relative'); } catch {}
          await NavigationBar.setButtonStyleAsync(isDark ? 'light' : 'dark');
        };
        await applyOnce();
        try { await NavigationBar.setVisibilityAsync('hidden'); } catch {}
        setTimeout(async () => { try { await NavigationBar.setVisibilityAsync('visible'); } catch {} }, 20);
        setTimeout(applyOnce, 50);
        setTimeout(applyOnce, 250);
      } catch {}
    });
    return () => sub && navigation?.removeListener?.('focus', sub);
  }, [navigation]);

  // Обновляем пропущенные видеозвонки из AsyncStorage при возврате на экран (iOS/Android)
  useEffect(() => {
    const unsub = navigation?.addListener?.('focus', async () => {
      try {
        const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object') { setMissedByUser(parsed); setMissedLoaded(true); }
      } catch {}
    });
    return () => { try { unsub?.(); } catch {} };
  }, [navigation]);

  /* ===== presence & friend events ===== */
  useEffect(() => {
    // Если пришёл запрос закрыть входящий (из других экранов/чата) — закрываем и здесь
    const offReq = onRequestCloseIncoming(() => {
      setCalling({ visible: false, friend: null, callId: null });
    });
    const offAccepted = onFriendAccepted?.(() => void loadFriends());
    const offPresence = onPresenceUpdate?.((data: any) => {
      // Обрабатываем оба формата: массив (для online) и объект (для busy)
      if (Array.isArray(data)) {
        // Формат массива: обновление online статуса
        const onlineSet = new Set((data || []).map((it: any) => String(it?._id ?? it)));
        setFriends((prev) => prev.map((f) => ({ ...f, online: onlineSet.has(String(f.id)) })));
      } else if (data && typeof data === 'object' && data.userId) {
        // Формат объекта: обновление busy статуса
        const userId = String(data.userId);
        const busy = data.busy !== undefined ? !!data.busy : undefined;
        
        if (busy !== undefined) {
          setFriends((prev) => 
            prev.map((f) => 
              String(f.id) === userId 
                ? { ...f, isBusy: busy } 
                : f
            )
          );
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

      // Проверяем, что userId действительно в списке друзей
      const isFriend = friendsRef.current.some(f => String(f.id) === String(userId));
      if (!isFriend) {
        return;
      }

      // Кэшируем миниатюру если пришла
      if (avatarThumbB64 && avatarVer) {
        try {
          await putThumb(userId, avatarVer, avatarThumbB64);
        } catch (e) {
          console.warn('[onFriendProfile] Failed to cache thumbnail:', e);
        }
      }

      // Обновляем ТОЛЬКО список друзей, НЕ затрагивая собственный профиль
      setFriends((prev) =>
        prev.map((f) =>
          String(f.id) === String(userId)
            ? { 
                ...f, 
                name: typeof nick === 'string' ? nick : f.name, 
                avatar: typeof avatar === 'string' ? avatar : f.avatar,
                avatarVer: typeof avatarVer === 'number' ? avatarVer : f.avatarVer,
                avatarThumbB64: typeof avatarThumbB64 === 'string' ? avatarThumbB64 : f.avatarThumbB64
              }
            : f
        )
      );

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

  // Мгновенное обновление бейджа при инкременте в App.tsx (главная/меню)
  useEffect(() => {
    const off = onMissedIncrement(({ userId }) => {
      if (!userId) return;
      setMissedByUser((prev) => ({ ...prev, [userId]: (prev[userId] || 0) + 1 }));
    });
    return () => off?.();
  }, []);

  /* ===== unread counters (через сокеты) ===== */
  useEffect(() => {
    if (!friends.length) return;
    let disposed = false;
    let allTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRecalcAll = () => {
      if (allTimer) return;
      allTimer = setTimeout(async () => {
        allTimer = null;
        const entries: Record<string, number> = {};
        await Promise.all(friends.map(async (f) => {
          try { 
            // Используем новую функцию getUnreadCount
            const result = await getUnreadCount(f.id);
            entries[f.id] = result.ok ? (result.count || 0) : 0;
          } catch { 
            entries[f.id] = 0; 
          }
        }));
        if (!disposed) setUnreadByUser((prev) => ({ ...prev, ...entries }));
      }, 150);
    };

    const updateOne = async (pid: string) => {
      try {
        // Используем новую функцию getUnreadCount
        const result = await getUnreadCount(pid);
        const count = result.ok ? (result.count || 0) : 0;
        if (!disposed) setUnreadByUser((prev) => ({ ...prev, [pid]: count }));
      } catch {
        if (!disposed) setUnreadByUser((prev) => ({ ...prev, [pid]: 0 }));
      }
    };

    scheduleRecalcAll();

    // Слушатель новых сообщений для обновления счетчиков
    const offReceived = onMessageReceived((message) => {
      if (friends.some(f => f.id === message.from)) {
        updateOne(message.from);
      }
    });

    // Слушатель подтверждений прочтения
    const offReadReceipt = onMessageReadReceipt(() => {
      scheduleRecalcAll(); // Пересчитываем все счетчики
    });

    return () => { 
      disposed = true; 
      offReceived?.(); 
      offReadReceipt?.();
      if (allTimer) { 
        clearTimeout(allTimer); 
        allTimer = null; 
      } 
    };
  }, [friends]);

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
    if (saving) return;

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
          showNotice(t('unauthorized', lang) || 'Not authorized', 'error');
          await ensureMinSpinner();
          setSaving(false);
          return;
        }
      }

      const finalNick = (nick ?? '').trim();
      const isLocalFile = /^file:\/\//i.test(avatarUri);
      let finalAvatarUrl = avatarUri; // По умолчанию текущий URI

      // Если выбран локальный файл - загружаем через socket
      if (isLocalFile) {
        try {
          const base64 = await imageToBase64(avatarUri);

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
      showNotice(t('saved', lang), 'success', 1200);
    } catch (e) {
      console.error('[handleSaveProfile] ❌ Save profile error:', e);
      showNotice(t('saveFailed', lang), 'error', 2200);
      shouldToast = false; // Не показываем тост при ошибке
    } finally {
      await ensureMinSpinner();
      setSaving(false);

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
      // Проверяем подключение к серверу
      if (!(socket as any)?.connected) {
        showNotice(t('noServer', lang), 'error', 2200);
        return;
      }

      const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ ok: false, error: 'timeout' });
        }, 10000); // 10 секунд таймаут

        socket.emit('user.deleteAvatar', {}, (ack: any) => {
          clearTimeout(timeout);
          resolve(ack || { ok: false, error: 'no_response' });
        });
      });

      if (!result.ok) {
        const errorMessage = result.error === 'unauthorized' 
          ? t('unauthorized', lang) || 'Не авторизован'
          : result.error === 'timeout'
          ? 'Превышено время ожидания'
          : result.error || 'delete_failed';
        throw new Error(errorMessage);
      }

      // Очищаем локальное состояние
      setAvatarUri('');
      setSavedAvatarUrl('');
      setMyAvatarVer(0);
      setMyFullAvatarUri(''); // Также очищаем кешированный data URI

      // Очищаем кэш для текущего пользователя
      const currentUserId = getCurrentUserId();
      if (currentUserId) {
        await clearAvatarCacheFor(currentUserId);

        // Удаляем сохранённую версию аватара
        try {
          await AsyncStorage.removeItem(`avatarVer_${currentUserId}`);
        } catch (e) {
          console.warn('[handleDeleteAvatar] Failed to remove avatar version:', e);
        }
      }

      // Сохраняем в локальное хранилище
      await saveProfileToStorage({ nick: nick || '', avatar: '' });
      await saveDraftProfile({ nick: nick || '', avatar: '' });

      showNotice(t('avatarDeleted', lang) || 'Avatar deleted', 'success');
    } catch (e: any) {
      console.error('[handleDeleteAvatar] Error:', e);
      showNotice(t('deleteFailed', lang) || 'Delete failed', 'error');
    }
  }, [nick, lang, showNotice]);


  /* avatar pick flow (gallery/camera/files) */
  const [pendingPicker, setPendingPicker] = useState<null | 'gallery' | 'camera'>(null);

  const openAvatarSheet = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Сделать фото', 'Выбрать из галереи', 'Отмена'], cancelButtonIndex: 2, userInterfaceStyle: 'dark' },
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
          let perm = await ImagePicker.getMediaLibraryPermissionsAsync();
          if (!perm.granted) perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          const granted = perm.granted || (perm as any)?.accessPrivileges === 'limited';
          if (!granted) { showNotice(t('noPhotosAccess', lang), 'error'); return; }

          const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1], quality: 0.9 });
          if (!res.canceled) {
            const a = res.assets?.[0];
            localUri = await normalizeLocalImageUri(a?.uri ?? undefined, (a as any)?.assetId ?? null);
          }
        } else if (pendingPicker === 'camera') {
          let cam = await ImagePicker.getCameraPermissionsAsync();
          if (!cam.granted) cam = await ImagePicker.requestCameraPermissionsAsync();
          if (!cam.granted) { showNotice(t('noCamera', lang), 'error'); return; }

          const res = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1], quality: 0.9 });
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
    const ok = await askConfirm({ title: L('wipeTitle'), message: L('wipeMessage'), confirmText: L('wipeConfirm'), cancelText: L('cancel') });
    if (!ok) return;

    setWiping(true);
    setMenuOpen(false);
    setInitialized(false); // Сбрасываем флаг инициализации

    try {
      if (!(socket as any)?.connected) { 
        showNotice(t('noServer', lang), 'error', 2200);
        setWiping(false);
        return;
      }

      const curId = installId || (await getInstallId());
      
      // 1. Удаляем на сервере
      await wipeAccountOnServer(curId);

      // 2. Показываем уведомление ПЕРЕД сбросом состояния
      showNotice(t('accountWiped', lang), 'success', 2000);

      // 3. Жёсткий локальный сброс (очищает AsyncStorage и кэши)
      await hardLocalReset();
      
      // 4. Сбрасываем React state
      resetAllState();

      // 5. Сбрасываем installId
      await resetInstallId();
      const newId = await getInstallId();
      setInstallId(newId);

      // 6. Attach с новым installId (создаст нового пользователя)
      await attachIdentitySafe({ installId: newId, profile: {} });
    } catch (e: any) {
      showNotice(`${t('wipeFailed', lang)}: ${e?.message || e}`, 'error', 2600);
    } finally { setWiping(false); }
  }, [wiping, installId, askConfirm, showNotice, attachIdentitySafe, wipeAccountOnServer, lang, resetAllState]);


  /* ================= UI ================= */

  const onRefreshFriends = async () => { setRefreshing(true); await loadFriends(); setRefreshing(false); };

  const ChatButton = ({ friend }: { friend: Friend }) => {
    const count = unreadByUser[friend.id] || 0;
  
    const isLocalUri = (s: string) =>
      /^file:\/\//i.test(s) ||
      /^content:\/\//i.test(s) ||
      /^assets-library:\/\//i.test(s) ||
      /^ph:\/\//i.test(s);
  
    const handlePress = React.useCallback(() => {
      // Просто открываем чат с CometChat
      navigation.navigate('Chat', {
        peerId: friend.id,
        peerName: friend.name || '—',
        peerAvatarVer: friend.avatarVer || 0,
        peerAvatarThumbB64: friend.avatarThumbB64 || '',
        peerOnline: friend.online,
      });
    }, [friend, savedNick]);
  
    return (
      <View style={{ position: 'relative' }}>
        <IconButton
          icon="chat-processing"
          size={22}
          iconColor={LIVI.white}
          style={[styles.actionBtn, styles.actionBtnGap]}
          onPress={handlePress}
        />
        {count > 0 && (
          <View style={styles.badgeBubble}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>{count > 99 ? '99+' : count}</Text>
          </View>
        )}
      </View>
    );
  };
  const renderRightActions = (id: string) => (
    <View style={styles.swipeRight}>
      <IconButton icon="close" size={22} iconColor="#fff" style={{ backgroundColor: LIVI.red, marginRight: 12 }} onPress={() => handleRemoveFriend(id)} />
    </View>
  );

  const handleRemoveFriend = useCallback(
    async (peerId: string) => {
      const prevFriends = friendsRef.current;
      setFriends((prev) => prev.filter((f) => f.id !== peerId));
      try {
        const res = await removeFriend(peerId);
        if (!res?.ok) throw new Error(res?.error || 'remove failed');
        showNotice(L('friendRemoved'), 'success', 1400);
      } catch (e: any) {
        setFriends(prevFriends);
        showNotice(`${L('friendRemoveFailed')}: ${e?.message || 'error'}`, 'error', 2200);
      }
    },
    [showNotice, L],
  );

  type FriendDisplay = {
    displayName: string;
    avatarLetter: string;
    hasAvatar: boolean;
  };

  const getFriendDisplay = (f: Friend) => {
    const rawNick = (f.name || '').trim();
    const hasNick = rawNick.length > 0;
    // Проверяем не только версию, но и наличие самой миниатюры
    const hasAvatar = !!(f.avatarVer && f.avatarVer > 0 && f.avatarThumbB64);

    // Имя: ник, иначе «—»
    const displayName = hasNick ? rawNick : '—';

    // Буква: показываем если нет изображения, но есть ник
    const avatarLetter = !hasAvatar && hasNick ? rawNick.slice(0, 1).toUpperCase() : '';

    return { displayName, avatarLetter, hasAvatar };
  };
  

  const InviteButton = ({ friend }: { friend: Friend }) => {
    if (!friend.online) return null;

    const { displayName } = getFriendDisplay(friend);
    const missedCount = missedByUser[friend.id] || 0;

    // УПРОЩЕНО: Определяем статус "Занято" для 1-на-1
    const isOnline = friend.online;
    const isFriendBusy = friend.isBusy || false; // Флаг от сервера через presence:update
    const busy = isOnline && isFriendBusy;
    const pulse = React.useRef(new Animated.Value(0)).current;
    useEffect(() => {
      if (busy) {
        const anim = Animated.loop(
          Animated.sequence([
            Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
            Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
          ])
        );
        anim.start();
        return () => { try { (anim as any).stop?.(); } catch {} };
      } else {
        pulse.stopAnimation();
        pulse.setValue(0);
      }
    }, [busy, pulse]);

    return (
      <View style={styles.rightWrap}>
        {busy && (
          <Animated.View style={[styles.busyBadge, { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1] }) }]}>
            <Text style={styles.busyText}>Занято</Text>
          </Animated.View>
        )}
        <IconButton
          icon="video"
          size={22}
          iconColor={busy ? 'rgba(255,255,255,0.5)' : LIVI.white}
          style={[styles.inviteBtn, busy ? styles.inviteBtnDisabled : null]}
          disabled={busy}
          onPress={() => {
            setMissedByUser((prev) => {
              const next = { ...prev, [friend.id]: 0 };
              AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(next)).catch(()=>{});
              return next;
            });
            handleStartVideoCall(friend);
          }}
        />
        {missedCount > 0 && (
          <View style={[styles.badgeBubble, { right: -2 }]}> 
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>
              {missedCount > 99 ? '99+' : missedCount}
            </Text>
          </View>
        )}
      </View>
    );
  };
  

  const FriendsTab = () => (
    <FlatList
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      overScrollMode="never"
      data={friends}
      keyExtractor={(item) => item.id}
      ItemSeparatorComponent={Divider}
      refreshing={refreshing}
      onRefresh={onRefreshFriends}
      renderItem={({ item }) => (
        <Swipeable renderRightActions={() => renderRightActions(item.id)}>
          <List.Item
            style={[styles.listRow, styles.listRowAligned]}
            contentStyle={{ marginLeft: 0 }}
            rippleColor="transparent"
            left={() => {
              const { avatarLetter } = getFriendDisplay(item);
              return (
                <View style={styles.avatarBox}>
                  <AvatarImage
                    userId={item.id}
                    avatarVer={item.avatarVer || 0}
                    uri={item.avatarThumbB64 || undefined}
                    size={48}
                    fallbackText={avatarLetter || '—'}
                    containerStyle={{ overflow: 'hidden' }}
                    fallbackTextStyle={
                      avatarLetter
                        ? { fontWeight: '800', color: LIVI.white }
                        : { fontWeight: '400', color: LIVI.text2 }
                    }
                  />
                </View>
              );
            }}
            
            title={() => {
              const { displayName } = getFriendDisplay(item);
              return (
                <View style={styles.nameCol}>
                  <Text style={styles.friendName}>{displayName}</Text>
                  <Text style={[styles.friendStatus, { color: item.online ? LIVI.green : LIVI.red }]}>
                    {item.online ? L('online') : L('offline')}
                  </Text>
                </View>
              );
            }}            
            right={() => (
              <View style={styles.rowRightActions}>
                {item.online && <InviteButton friend={item} />}
                <ChatButton friend={item} />
              </View>
            )}
          />
        </Swipeable>
      )}
      contentContainerStyle={{ paddingBottom: 24, paddingHorizontal: 16, paddingRight: 6 }}
      ListEmptyComponent={initialized ? (<View style={{ padding: 16 }}><Text style={{ color: LIVI.text2 }}>👤 {L('friendsEmpty')}</Text></View>) : null}
    />
  );

  const MoreTab = () => (
    <View style={{ padding: 16, gap: 16 }}>


      {/* UI Settings */}
      <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', borderColor: LIVI.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12 }}>
        <Text style={{ color: LIVI.white, fontWeight: '700', marginBottom: 8 }}>{t('uiSettings', lang)}</Text>

        {/* Theme selector */}
        <Text style={{ color: LIVI.text2, fontSize: 14, fontWeight: '500', marginBottom: 8 }}>Тема приложения</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          {([
            { key: 'auto', label: 'Авто' },
            { key: 'light', label: 'Светлая' },
            { key: 'dark', label: 'Тёмная' },
          ] as { key: ThemePreference; label: string }[]).map((opt) => {
            const active = preference === opt.key;
            return (
              <TouchableOpacity
                key={opt.key}
                onPress={() => setPreference(opt.key)}
                activeOpacity={0.85}
                style={{
                  paddingVertical: 10,
                  paddingHorizontal: 14,
                  borderRadius: 24,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: LIVI.border,
                  backgroundColor: active ? 'rgba(113,91,168,0.22)' : 'rgba(255,255,255,0.02)'
                }}
              >
                <Text style={{ color: LIVI.white, fontWeight: '700', opacity: active ? 1 : 0.8 }}>{opt.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <TouchableOpacity
          activeOpacity={0.85}
          onPress={openLangPicker}
          style={{
            borderWidth: StyleSheet.hairlineWidth, borderColor: LIVI.border, borderRadius: 10,
            paddingVertical: 14, paddingHorizontal: 14, backgroundColor: 'rgba(255,255,255,0.02)',
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          }}
        >
          <Text style={{ color: LIVI.white, fontSize: 14, fontWeight: '600' }}>{L('chooseLanguage')}</Text>
          <Text style={{ color: LIVI.text2, fontSize: 14, fontWeight: '700' }}>{(lang ?? 'ru').toUpperCase()}</Text>
        </TouchableOpacity>

        <Text style={{ color: LIVI.text2, marginTop: 6, fontSize: 12 }}>{L('baseLang')}: {defaultLang.toUpperCase()}</Text>
      </View>

      {/* Donate */}
      <TouchableOpacity 
        activeOpacity={0.85}
        onPress={async () => {
          await incrCounter('support_help_clicks');
          setDonateVisible(true);
        }}
        style={{ 
          backgroundColor: 'rgba(113,91,168,0.1)', 
          borderColor: LIVI.accent, 
          borderWidth: StyleSheet.hairlineWidth, 
          borderRadius: 12, 
          padding: 14,
          flexDirection: 'row',
          alignItems: 'center'
        }}
      >
        <View style={{ 
          width: 44, 
          height: 44, 
          borderRadius: 22, 
          backgroundColor: LIVI.accent, 
          justifyContent: 'center', 
          alignItems: 'center',
          marginRight: 14,
          flexShrink: 0
        }}>
          <Text style={{ color: LIVI.white, fontSize: 15, fontWeight: '800', letterSpacing: 0.5 }}>
            LiVi
          </Text>
        </View>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <Text style={{ color: '#B8A9E8', fontSize: 16, fontWeight: '700', marginBottom: 3, lineHeight: 20 }}>
            Поддержать проект
          </Text>
          <Text style={{ color: LIVI.text2, fontSize: 13, lineHeight: 17 }}>
            Помоги развивать LiVi — видеочат будущего
          </Text>
        </View>
      </TouchableOpacity>
    </View>
  );

  const CenterTopProfile = React.memo(() => {
    const letter = displayAvatarLetter(savedNick);
    const wrapperStyle: StyleProp<ViewStyle> = {
      alignItems: "center",
      marginTop: Platform.OS === "android" ? 12 : (12 + 20), // Добавляем 20px для iOS
      marginBottom: -65,
    };

    // Используем новую систему кеширования или локальный файл для превью
    const isLocalPreview = avatarUri && /^(file|content|ph|assets-library):\/\//i.test(avatarUri);
    const myUserId = getCurrentUserId();

    return (
      <View style={wrapperStyle}>
        <View style={styles.centerAvatarWrap}>
          {isLocalPreview ? (
            // Локальное превью (до загрузки)
            (<ExpoImage
              source={{ uri: avatarUri }}
              style={styles.centerAvatarImg}
              cachePolicy="none"
            />)
          ) : myUserId && myAvatarVer > 0 ? (
            // Кешированный аватар через новую систему
            (<AvatarImage
              userId={myUserId}
              avatarVer={myAvatarVer}
              uri={myFullAvatarUri || undefined}
              size={Platform.OS === "ios" ? 136 : 120}
              fallbackText={letter}
              containerStyle={styles.centerAvatarImg}
              fallbackTextStyle={{ fontSize: 48, fontWeight: '800' }}
            />)
          ) : (
            // Плейсхолдер с буквой
            (<View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]}>
              <Text style={{ color: LIVI.titan, fontSize: 48, fontWeight: '500' }}>{letter}</Text>
            </View>)
          )}
        </View>
        <Text style={[styles.subtitleNik, { marginTop: 12, fontSize: Platform.OS === "ios" ? 25 : 20, color: isDark ? LIVI.text2 : LIVI.textThemeWhite }]}>{displayName(savedNick)}</Text>
      </View>
    );
  });

  // Показ уведомления «Звонок завершён» и, при необходимости, авто-открытие меню друзей
  useEffect(() => {
    const ended = (route as any)?.params?.callEnded;
    const openFriendsMenu = (route as any)?.params?.openFriendsMenu;
    if (ended) {
      showNotice('Звонок завершён', 'success', 3000);
    }
    if (openFriendsMenu) {
      setMenuOpen(true);
    }
    if (ended || openFriendsMenu) {
      try { navigation.setParams?.({ callEnded: undefined, openFriendsMenu: undefined }); } catch {}
    }
  }, [route, navigation, showNotice]);

  // Обработка «занято» от друга
  useEffect(() => {
    const onBusy = ({ from }: { from: string }) => {
      // Скрываем модалку вызова, если открыта
      setCalling({ visible: false, friend: null, callId: null });

      // Помечаем друга как "занят"
      setFriends(prev =>
        prev.map(f =>
          String((f as any).id) === String(from)
            ? { ...f, isBusy: true }
            : f
        )
      );

      // Не снимаем статус автоматически: бэйдж «Занято» должен сохраняться,
      // пока собеседник реально занят (снимется событиями сервера)
    };

    socket.on('call:busy', onBusy);
    return () => { socket.off('call:busy', onBusy as any); };
  }, []);

  // Старый обработчик удален - используем новую систему статусов

  // Показываем SplashLoader пока данные не загружены
  // Проверяем что данные реально установлены перед скрытием
  const currentNick = savedNick || nick || '';
  const currentAvatar = avatarUri || savedAvatarUrl || '';
  const hasRealData = (currentNick && currentNick.trim()) || (currentAvatar && currentAvatar.trim());
  const shouldShowSplash = !profileLoaded || (profileLoaded && !hasRealData);
  
  if (shouldShowSplash) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0D0E10' }}>
        <StatusBar barStyle="light-content" />
        <SplashLoader 
          dataLoaded={dataLoaded} 
          hasNick={!!(currentNick && currentNick.trim())}
          hasAvatar={!!(currentAvatar && currentAvatar.trim())}
          onComplete={() => {
            // Устанавливаем profileLoaded только если есть данные
            if (hasRealData) {
              setProfileLoaded(true);
            }
          }} 
        />
      </View>
    );
  }

  return (
    <SafeAreaView
        style={[
          styles.container,
          {
            paddingTop: Platform.OS === "android" ? 50 : 0,
            backgroundColor: theme.colors.background,
          },
        ]}
        edges={Platform.OS === "android" ? ['bottom','left','right'] : ['bottom','left','right','top']}
      >
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      <View style={[styles.topBar, { backgroundColor: 'transparent' }] }>
        <Text style={[styles.brand, { color: isDark ? LIVI.text : LIVI.textThemeWhite }]}>LiVi</Text>

        <View style={{ position: 'relative' }}>
          <IconButton 
            icon="menu" 
            size={Platform.OS === "ios" ? 28 : 24} 
            iconColor={isDark ? LIVI.white : LIVI.textThemeWhite} 
            style={[
              styles.menuBtn,
              { 
                backgroundColor: isDark 
                  ? 'rgba(138, 143, 153, 0.15)' // Титановый цвет для темной темы
                  : Platform.OS === 'android' 
                    ? 'rgba(59, 68, 83, 0.10)' // Чуть светлее для светлой темы на Android
                    : 'rgba(59, 68, 83, 0.15)', // Обычный для светлой темы на iOS
                borderColor: theme.colors.outline,
                borderWidth: StyleSheet.hairlineWidth,
              }
            ]} 
            onPress={() => setMenuOpen(true)} 
          />
          {(Object.values(unreadByUser).some((n) => n > 0) || Object.values(missedByUser).some((n) => n > 0)) && <View style={styles.menuDot} />}
        </View>
      </View>

      <CenterTopProfile />

      <View style={styles.center}>
        <Text style={[styles.title, { color: isDark ? LIVI.text : LIVI.textThemeWhite }]}>{L('welcomeTitle')}</Text>
        <Text style={[styles.subtitle, { color: isDark ? LIVI.text2 : LIVI.textThemeWhite }]}>{L('welcomeSubtitle')}</Text>
      </View>

      {NoticeView}

      <AnimatedBorderButton
        isDark={isDark}
        onPress={() => navigation.navigate("VideoChat", { callMode: 'random', returnTo: { name: 'Home' } })}
        label={L("startSearchBtn")}
        style={{ marginBottom: 60 }}
        backgroundColor={theme.colors.background as string}
      />

      {menuOpen && (
        <View style={styles.overlayMenu}>
          <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
          <Surface style={[styles.sheetFull, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 8) }]}>
            <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <View style={styles.sheetTopBar}>
                <TouchableOpacity
                  onPress={() => setMenuOpen(false)}
                  activeOpacity={0.85}
                  style={{
                    width: Platform.OS === 'ios' ? 40 : 36,
                    height: Platform.OS === 'ios' ? 40 : 36,
                    borderRadius: Platform.OS === 'ios' ? 16 : 14,
                    backgroundColor: 'rgba(255,255,255,0.06)',
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.12)',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginLeft: 5
                  }}
                >
                  <Ionicons name="arrow-back" size={Platform.OS === 'ios' ? 22 : 20} color={LIVI.titan} />
                </TouchableOpacity>
                <Text style={styles.sheetTitle}>{L('menuTitle')}</Text>
                {tab === 'settings' && handleWipeAccount && (
                  <TouchableOpacity
                    onPress={handleWipeAccount}
                    activeOpacity={0.85}
                    disabled={wiping}
                    style={{
                      width: Platform.OS === 'ios' ? 40 : 36,
                      height: Platform.OS === 'ios' ? 40 : 36,
                      borderRadius: Platform.OS === 'ios' ? 16 : 14,
                      backgroundColor: 'rgba(255,90,103,0.1)',
                      borderWidth: 1,
                      borderColor: 'rgba(255,255,255,0.12)',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginRight: 5,
                      opacity: wiping ? 0.7 : 1
                    }}
                  >
                    <Ionicons name="trash" size={Platform.OS === 'ios' ? 20 : 18} color="rgba(255,90,103,0.6)" />
                  </TouchableOpacity>
                )}
                {!(tab === 'settings' && handleWipeAccount) && <View style={{ width: Platform.OS === 'ios' ? 40 : 36 }} />}
              </View>

              <View style={styles.segmentCapsule}>
                {renderSegBtn('friends', L('tabFriends'), 'account-multiple', 'left')}
                <View style={styles.segDivider} />
                {renderSegBtn('settings', L('tabSettings'), 'cog', 'mid')}
                <View style={styles.segDivider} />
                {renderSegBtn('more', L('tabMore'), 'dots-horizontal', 'right')}
              </View>

              <Divider style={{ backgroundColor: LIVI.border, marginTop: 12 }} />

              <View style={{ flex: 1 }}>
                {tab === 'friends' && <FriendsTab />}
                {tab === 'settings' && (
                  <SettingsTab
                      nick={nick}
                      setNick={(v) => { 
                        setNick(v); 
                        saveDraftProfile({ nick: v }); 
                        // Также сохраняем в основное хранилище
                        saveProfileToStorage({ nick: v, avatar: savedAvatarUrl || avatarUri }).catch(() => {});
                      }}
                      avatarUri={avatarUri}
                      setAvatarUri={(u) => { 
                        setAvatarUri(u); 
                        saveDraftProfile({ avatar: u }); 
                        setAvatarRefreshKey((k) => k + 1);
                        // Также сохраняем в основное хранилище
                        saveProfileToStorage({ nick: nick, avatar: u }).catch(() => {});
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
                    />
                )}
                {tab === 'more' && <MoreTab />}
              </View>
            </KeyboardAvoidingView>
          </Surface>
        </View>
      )}

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
            <Text style={{ color: LIVI.white, fontWeight: '700', fontSize: 16, textAlign: 'center' }}>Комната пользователя занята</Text>
            {!!roomFull.name && <Text style={{ color: LIVI.text2, marginTop: 6 }}>{roomFull.name}</Text>}
            <TouchableOpacity onPress={() => setRoomFull({ visible: false })} activeOpacity={0.85} style={[styles.confirmBtn, { marginTop: 14, width: 120, backgroundColor: 'rgba(255,255,255,0.08)' }]}>
              <Text style={[styles.confirmBtnText, { color: LIVI.white }]}>ОК</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      {/* ───── Исходящий видеозвонок (caller modal) ───── */}
      {calling.visible && (
        <View style={styles.overlayModal} pointerEvents="box-none">
          <BlurView intensity={Platform.OS === 'android' ? 100 : 85} tint="dark" style={StyleSheet.absoluteFill} />
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: Platform.OS === 'android' ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.35)' },
            ]}
          />
          <Animated.View
            style={{
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              ...(Platform.OS === 'android' ? StyleSheet.absoluteFillObject : {})
            }}
          >
            <View style={{ width: 180, height: 180, alignItems: 'center', justifyContent: 'center' }}>
              {/* Волны */}
              <Animated.View style={[waveStyle(0)]} />
              <Animated.View style={[waveStyle(1)]} />
              <Animated.View style={[waveStyle(2)]} />
              {/* Иконка звонка */}
              <View style={{ width: 76, height: 76, borderRadius: 38, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' }}>
                <List.Icon icon="video" color={LIVI.white} />
              </View>
            </View>
            <Text style={{ color: LIVI.white, fontSize: 16, fontWeight: '700', marginTop: 12 }}>Вы звоните {displayName(calling.friend?.name)}</Text>
            <Text style={{ color: LIVI.text2, marginTop: 6 }}>Ожидаем ответа…</Text>
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 18 }}>
            <TouchableOpacity
  onPress={handleCancelCall}
  activeOpacity={0.6} // делаем заметнее
  style={[styles.confirmBtn, { backgroundColor: 'rgba(255,90,103,0.18)', width: 96 }]}
>
  <Text style={[styles.confirmBtnText, { color: LIVI.white }]}>Отменить</Text>
</TouchableOpacity>
            </View>
          </Animated.View>
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
            <TouchableOpacity
              onPress={() => setDonateVisible(false)}
              activeOpacity={0.85}
              style={{
                position: 'absolute',
                top: insets.top + (Platform.OS === "android" ? 35 : 16),
                left: Platform.OS === 'ios' ? 15 : 17,
                width: Platform.OS === 'ios' ? 40 : 36,
                height: Platform.OS === 'ios' ? 40 : 36,
                borderRadius: Platform.OS === 'ios' ? 16 : 14,
                backgroundColor: 'rgba(255,255,255,0.06)',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.12)',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 10
              }}
            >
              <Ionicons name="arrow-back" size={Platform.OS === 'ios' ? 22 : 20} color={LIVI.titan} />
            </TouchableOpacity>
            <Surface style={[styles.confirmCard, { minWidth: 300, maxWidth: 400, borderColor: LIVI.accent }]}>
              <Text style={[styles.confirmTitle, { textAlign: 'center', marginBottom: 20, color: '#B8A9E8' }]}>Поддержать проект</Text>
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
                    console.warn('[support] Open Boosty', { url });
                    Linking.openURL(url);
                  }}
                  onPressIn={() => setPressedButton('boosty')}
                  onPressOut={() => setPressedButton(null)}
                  activeOpacity={1}
                  style={{
                    backgroundColor: pressedButton === 'boosty' ? '#B8A9E8' : 'rgba(113,91,168,0.1)',
                    borderColor: LIVI.accent,
                    borderWidth: StyleSheet.hairlineWidth,
                    paddingVertical: 14,
                    paddingHorizontal: 20,
                    borderRadius: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 12,
                    gap: 10
                  }}
                >
                  <ExpoImage
                    source={require('../assets/boosty-sign-logo.png')}
                    style={{ width: 24, height: 24 }}
                    contentFit="contain"
                    cachePolicy="memory-disk"
                  />
                  <Text style={{ 
                    color: LIVI.white, 
                    fontWeight: '700', 
                    fontSize: 16 
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
                    console.warn('[support] Open Patreon', { url });
                    Linking.openURL(url);
                  }}
                  onPressIn={() => setPressedButton('patreon')}
                  onPressOut={() => setPressedButton(null)}
                  activeOpacity={1}
                  style={{
                    backgroundColor: pressedButton === 'patreon' ? '#B8A9E8' : 'rgba(113,91,168,0.1)',
                    borderColor: LIVI.accent,
                    borderWidth: StyleSheet.hairlineWidth,
                    paddingVertical: 14,
                    paddingHorizontal: 20,
                    borderRadius: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10
                  }}
                >
                  <ExpoImage
                    source={require('../assets/patreon-sign-logo.png')}
                    style={{ width: 24, height: 24 }}
                    contentFit="contain"
                    cachePolicy="memory-disk"
                  />
                  <Text style={{ 
                    color: LIVI.white, 
                    fontWeight: '700', 
                    fontSize: 16 
                  }}>
                    Patreon
                  </Text>
                </TouchableOpacity>
              </View>
            </Surface>
          </View>
        )}
      </Portal>
    </SafeAreaView>
  );

  /* segmented button */
  function renderSegBtn(value: 'friends' | 'settings' | 'more', label: string, icon: string, rounded: 'left' | 'mid' | 'right') {
    const active = tab === value;
    return (
      <TouchableOpacity key={value} activeOpacity={0.9} onPress={() => setTab(value)} style={[styles.segItem, rounded === 'left' && styles.segLeft, rounded === 'right' && styles.segRight]}>
        {active && <View style={[StyleSheet.absoluteFill, styles.segActiveBg]} />}
        {active && <View style={styles.segTopShadow} />}
        <View style={styles.segContent}>
          <List.Icon icon={icon} color={LIVI.white} style={{ margin: 0, marginRight: 8 }} />
          <Text style={styles.segLabel}>{label}</Text>
        </View>
      </TouchableOpacity>
    );
  }
}

/* ================= styles ================= */
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: LIVI.bg, paddingHorizontal: 14, paddingBottom: 32, justifyContent: 'center' },
  topBar: { height: 100, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',   paddingHorizontal: Platform.OS === "android" ? 0 : 10, },
  brand: { color: LIVI.text, fontSize: Platform.OS === "ios" ? 39 : 30, fontWeight: Platform.OS === "ios" ? '600' : '800', letterSpacing: 0.3, paddingHorizontal: Platform.OS === "android" ? 10 : 0 },
  menuBtn: { backgroundColor: LIVI.glass, borderRadius: 14 },
  listRow: { backgroundColor: 'transparent', paddingVertical: 10, paddingRight: 8 },
  listRowAligned: { alignItems: 'center', paddingLeft: 0, paddingRight: 8, minHeight: 72 },
  nameCol: { marginLeft: 0, justifyContent: 'center' },
  friendName: {
    color: LIVI.white,
    fontWeight: '700',
    fontSize: Platform.OS === "android" ? 16 : 20,
    lineHeight: Platform.OS === "android" ? 18 : 30,
  },
  friendStatus: {
    marginTop: 2,
    fontSize: Platform.OS === "android" ? 12 : 14,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  centerAvatarWrap: {
    width: Platform.OS === "ios" ? 136 : 120,
    height: Platform.OS === "ios" ? 136 : 120,
    borderRadius: Platform.OS === "ios" ? 68 : 60,
    overflow: 'hidden' as ViewStyle['overflow'],
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  
  centerAvatarImg: { width: '100%', height: '100%' },
  title: { color: LIVI.text, fontSize: Platform.OS === "android" ? 26 : 28, fontWeight: '700', letterSpacing: 0.3, textAlign: 'center' },
  subtitle: { color: LIVI.text2, fontSize: Platform.OS === "android" ? 14 : 16, lineHeight: 16, textAlign: 'center', paddingHorizontal: 8, marginTop: 2 },
  subtitleNik: { color: LIVI.text2, fontSize: 18, textAlign: 'center' },

  button: {
    borderRadius: 12,
    paddingVertical: Platform.OS === "ios" ? 18 : 16,
    paddingHorizontal: 32,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
    elevation: 6,
    backgroundColor: LIVI.titan,
  },
  buttonLabel: { color: '#151515', fontSize: 16, fontWeight: '700', letterSpacing: 0.4 },

  overlayMenu: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: screenWidth, height: screenHeight, backgroundColor: 'transparent', zIndex: 999 },
  overlayModal: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: screenWidth, height: screenHeight, backgroundColor: 'transparent', zIndex: 999, alignItems: 'center', justifyContent: 'center' },

  sheetFull: {
    position: "absolute",
    top: 0,
    left: 0,
    width,
    height,
    backgroundColor: Platform.OS === "android"
      ? "#0D0E10"  // Android — тот же цвет, что и у NavigationBar при открытом меню
      : "rgba(13,14,16,0.72)", // iOS
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LIVI.border,
  },
  sheetTopBar: { height: 56, flexDirection: 'row', marginTop: Platform.OS === "android" ? 26 : 12, alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 },
  sheetTitle: { color: LIVI.white, fontSize: 16, fontWeight: '700' },

  segmentCapsule: {
    flexDirection: 'row', alignItems: 'stretch', margin: Platform.OS === "android" ? 12 : 12,
    backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 114,
    borderWidth: StyleSheet.hairlineWidth, borderColor: LIVI.border, overflow: 'hidden', minHeight: 44,
  },
  segItem: { flex: 1, justifyContent: 'center' },
  segLeft: { borderTopLeftRadius: 114, borderBottomLeftRadius: 114 },
  segRight: { borderTopRightRadius: 114, borderBottomRightRadius: 114 },
  segContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 44 },
  segLabel: { color: LIVI.white, fontWeight: '500', fontSize: Platform.OS === "android" ? 14 : 17, },
  segDivider: { width: StyleSheet.hairlineWidth, backgroundColor: LIVI.border, marginVertical: 8 },
  segActiveBg: { backgroundColor: 'rgba(157, 161, 169, 0.11)' },
  segTopShadow: { position: 'absolute', top: 0, left: 0, right: 0, height: 0 },

  rowRightActions: { height: 48, flexDirection: 'row', alignItems: 'center', paddingRight: 1 },

  actionBtn: { backgroundColor: LIVI.glass, borderRadius: 12 },
  actionBtnGap: { marginLeft: 8 },

  segmentBottomArc: { position: 'absolute', left: 18, right: 18, bottom: 0, height: 44, borderRadius: 114, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: LIVI.border },

  menuDot: { position: 'absolute', top: 4, right: 4, width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,90,103,0.95)' },

  badgeBubble: {
    position: 'absolute', top: -2, right: -2, minWidth: 16, height: 16, paddingHorizontal: 3,
    borderRadius: 8, backgroundColor: 'rgba(255,90,103,0.9)', alignItems: 'center', justifyContent: 'center',
  },

  rightWrap: { width: 72, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  inviteBtn: { backgroundColor: LIVI.glass, borderRadius: 12 },
  inviteBtnDisabled: { 
    opacity: 0.5, 
    backgroundColor: LIVI.glass,
    // КРИТИЧНО: На Android disabled кнопки могут быть не видны, поэтому явно устанавливаем opacity
    // и сохраняем backgroundColor для видимости
  },
  busyBadge: {
    backgroundColor: 'rgba(255,90,103,0.25)',
    borderRadius: 8,
    paddingVertical: 2,
    paddingHorizontal: 6,
    marginRight: 6,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,90,103,0.6)',
  },
  busyText: {
    color: '#FF5A67',
    fontWeight: '700',
    fontSize: 11,
  },

  input: { marginBottom: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12 },
  fieldLabel: { color: LIVI.text2, fontSize: 14, fontWeight: '500', marginBottom: 8, marginTop: 16 },

  swipeRight: { flex: 1, alignItems: 'flex-end', justifyContent: 'center' },

  // SettingsTab needs
  avatarCircle: {
    width: 64, height: 64, borderRadius: 32, overflow: 'hidden' as ViewStyle['overflow'],
    backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center',
  },
  avatarImg: { width: '100%', height: '100%' },
  deleteBadge: { position: 'absolute', right: -6, bottom: -6, backgroundColor: 'rgba(0,0,0,0.5)' },

  // дефолт «—»
  avatarFallback: {
    width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(132, 135, 140, 0.35)',
  },
  avatarDash: { color: LIVI.text2, fontSize: 28, fontWeight: '800', lineHeight: 30 },

  // friend avatar
  avatarBox: {
    width: Platform.OS === "ios" ? 52 : 44,       // iOS больше, Android меньше
    height: Platform.OS === "ios" ? 52 : 44, 
    borderRadius: 24, overflow: 'hidden' as ViewStyle['overflow'],
    backgroundColor: 'rgba(132, 135, 140, 0.17)', alignItems: 'center', justifyContent: 'center',
  },
  avatarImgFull: { width: '100%', height: '100%' },
  avatarStub: { backgroundColor: 'rgba(255,255,255,0.30)' },

  // notice
  notice: {
    position: 'absolute',  
    bottom: Platform.OS === 'ios' ? 250 : 200,
    left: '10%', 
    right: '10%', 
    borderRadius: 14,
    paddingVertical: 12, paddingHorizontal: 16, 
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center',
  },
  noticeText: { color: LIVI.text2, fontSize: 14, fontWeight: '500', textAlign: 'center' },

  confirmCard: {
    width: '92%', backgroundColor: 'rgba(13,14,16,0.94)', borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth, borderColor: LIVI.border, padding: 16,
  },
  confirmTitle: { color: LIVI.white, fontSize: 18, fontWeight: '700', marginBottom: 6 },
  confirmMsg: { color: LIVI.text2, fontSize: 14 },
  confirmBtns: { flexDirection: 'row', gap: 10, marginTop: 16 },
  confirmBtn: {
    height: 46,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    alignSelf: 'stretch',
    flex: 1,
    backgroundColor: 'rgb(255, 90, 103)',
    borderWidth: 1,
    borderColor: 'rgb(200, 50, 65)',
  },
  confirmBtnText: { fontSize: 15, fontWeight: '700' },
});
