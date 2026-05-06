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
  FlatList,
  Dimensions,
  useWindowDimensions,
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
  Share,
  Vibration,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';

import { syncMyStreamProfile } from '../chat/cometchat';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
import SplashLoader from '../components/SplashLoader';
import { Swipeable, PinchGestureHandler, State, RectButton } from 'react-native-gesture-handler';
import { Avatar, Divider, IconButton, List, Surface, Portal, Dialog, Button, Icon } from 'react-native-paper';
import { Ionicons, MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { getAvatarImageProps, getAvatarKey, forceImageRefresh } from '../utils/imageOptimization';
import { useResolvedImageUri } from '../hooks/useResolvedImageUri';
import AvatarImage from '../components/AvatarImage';
import AsyncStorage from '@react-native-async-storage/async-storage';


import {
  toAvatarThumb,
  normalizeLocalImageUri,
} from '../utils/uploadAvatar';

import LanguagePicker from '../components/LanguagePicker';
import { useAppTheme, ThemePreference } from '../theme/ThemeProvider';
import { t, defaultLang } from '../utils/i18n';
import type { Lang } from '../utils/i18n';
import { useLang } from '../store/lang';

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
import { usePiP } from '../src/pip/PiPContext';
import { onMessageReceived, onMessageReadReceipt, onMessageDeleted, onMessagesDeleted, getUnreadCount, markMessagesAsRead, onCallTimeout as onCallTimeoutEvent, onCallIncoming as onCallIncomingEvent, onCallDeclined as onCallDeclinedEvent } from '../sockets/socket';
import { onMissedIncrement, onMissedClear, onMissedFetchedFromServer, onRequestCloseIncoming, emitCloseIncoming, onCloseOutgoingCall, onCallCancelledOnHome, onCallEndedOnHome, onCloseHomeModals, onCometChatStatus } from '../utils/globalEvents';
import { displayOutgoingCallImmediate, notifyOutgoingCallId, isCallKeepAvailable, reportEndCallToCallKeep, closeOutgoingCallActivity, OUTGOING_CALL_TIMEOUT_MS, clearOutgoingDeclineHandled, setupCallKeep } from '../utils/callKeep';
import { setMissedBadgeCleared, clearMissedBadgeCleared, syncAppBadgeFromMissedCount, dismissMissedCallNotificationsOnly, dismissMessageNotificationsOnly, dismissMessageNotificationForUser, getMissedCountByUserFromNative } from '../utils/pushNotifications';
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
  cancelCall,
  getMyProfile,
  onCallAccepted,
  onCallDeclined,
  onCallCanceled,
  onCallTimeout,
  onCallRoomFull,
  onDisconnected,
  isReconnecting,
  waitForCreateUserCompletion,
  checkInviteLink,
  requestFriend,
  acceptInvite,
  setOutgoingCallScreenVisible,
  onIncomingCallScreenChange,
  getIncomingCallScreenState,
  emitPresenceUpdateIfChanged,
} from '../sockets/socket';
import {
  isUpdateAvailable,
  isUpdateReminderCooldownActive,
  shouldShowUpdateBadge,
  markUpdateBadgeShown,
  clearUpdateCheckCache,
  clearUpdatePromotionWhenUpToDate,
  PLAY_STORE_UPDATE_URL,
} from '../utils/updateCheck';





/* ================= constants/helpers ================= */

type HomeRouteParams = {
  callEnded?: boolean;
  callCancelled?: boolean;
  inviteCode?: string;
  showInviteModal?: boolean;
  openFriendsMenu?: boolean;
};

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

/** Android: неактивная кнопка видео в списке друзей — тёмный «чип» и приглушённая иконка (единый вид на всех девайсах). */
const ANDROID_VIDEO_CALL_DISABLED_BG = '#1C1C1E';
const ANDROID_VIDEO_CALL_DISABLED_ICON = '#48484A';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

const displayName = (name?: string) => (name && name.trim().length ? name : '—');
const displayAvatarLetter = (name?: string) => {
  const n = (name || '').trim();
  return n ? n.slice(0, 1).toUpperCase() : '—';
};

const mapToFriend = (u: any): Friend => {
  // КРИТИЧНО: Используем полный никнейм, не обрезаем до первой буквы
  // Логика: берем никнейм из u.nick, u.name или u.username, обрезаем только пробелы
  const rawNick = u.nick || u.name || u.username || '';
  const fullNickname = typeof rawNick === 'string' ? rawNick.trim() : '';
  
  const mapped = {
    id: String(u._id ?? u.id ?? ''),
    name: fullNickname, // Полный никнейм, не обрезаем до первой буквы
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

  const show = useCallback((text: string, kind: NoticeKind = 'info', ms = 3000) => {
    if (!text) return;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setNotice({ text, kind });
    Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }).start(() => {
      if (ms > 0) timerRef.current = setTimeout(hide, ms);
    });
  }, [hide, opacity]);

  const noticeSurface =
    notice?.kind === 'success'
      ? { backgroundColor: 'rgba(34, 197, 94, 0.22)', borderColor: 'rgba(22, 163, 74, 0.9)' }
      : notice?.kind === 'error'
        ? { backgroundColor: 'rgba(255, 90, 103, 0.2)', borderColor: 'rgba(200, 50, 65, 0.85)' }
        : {
            borderColor: LIVI.accent,
            backgroundColor: isDark ? 'rgba(113,91,168,0.15)' : 'rgba(113,91,168,0.28)',
          };
  const view = notice ? (
    <Animated.View
      style={[
        styles.notice,
        {
          opacity,
          ...noticeSurface,
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
  const lang = useLang((s) => s.lang);

  const ask = useCallback((opts: { title: string; message?: string; confirmText?: string; cancelText?: string }) =>
    new Promise<boolean>((resolve) => {
      setState({
        visible: true,
        title: opts.title,
        message: opts.message,
        confirmText: opts.confirmText || t('ok', lang),
        cancelText: opts.cancelText || t('cancel', lang),
        resolve,
      });
    }), [lang]);
  const onCancel = useCallback(() => { state.resolve?.(false); setState((s) => ({ ...s, visible: false })); }, [state]);
  const onOk     = useCallback(() => { state.resolve?.(true);  setState((s) => ({ ...s, visible: false })); }, [state]);

  const view = state.visible ? (
    <View style={styles.overlayModal}>
      <BlurView intensity={Platform.OS === 'android' ? 100 : 85} tint="dark" style={StyleSheet.absoluteFill} />
      {/* Дополнительное затемнение для Android */}
      <View
        style={[
          StyleSheet.absoluteFill,
          // Android: сильнее затемняем задний фон
          { backgroundColor: Platform.OS === 'android' ? 'rgba(0,0,0,0.78)' : 'rgba(0,0,0,0.35)' },
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
  disabled?: boolean;
  onDisabledPress?: () => void;
};

const AnimatedBorderButton: React.FC<AnimatedBorderButtonProps> = ({
  isDark,
  onPress,
  label,
  style,
  backgroundColor,
  disabled = false,
  onDisabledPress,
}) => {
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const [blurIntensity, setBlurIntensity] = useState<number>(isDark ? 15 : 20);
  const titanOpacity = useRef(new Animated.Value(0.25)).current;
  const blockedFlashOpacity = useRef(new Animated.Value(0)).current;
  const blockedShakeX = useRef(new Animated.Value(0)).current;
  const borderWidth = 0.8; // Рамка кнопки «Начать поиск»

  // Цвета из палитры эквалайзера для темной темы - зациклены для непрерывности
  const darkColors = [
    '#14b8a6', '#3b82f6', '#00b5ff', '#FFF8F0', // бирюзовый, синий, голубой, жемчужно-белый
    '#14b8a6', '#3b82f6', '#00b5ff', '#FFF8F0', // дублируем для плавного перехода
  ];
  
  // Цвета из палитры эквалайзера для светлой темы - зациклены для непрерывности
  const lightColors = [
    '#8f7ad8', '#FFF8F0', '#B0B5BF', // фиолетовый (чуть темнее), жемчужно-белый, светлый титан (осветлен)
    '#8f7ad8', '#FFF8F0', '#B0B5BF', // дублируем для плавного перехода
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

  const triggerBlockedFeedback = useCallback(() => {
    // Короткий визуальный "нельзя": красный пульс + мягкий шейк.
    blockedFlashOpacity.stopAnimation();
    blockedShakeX.stopAnimation();
    blockedFlashOpacity.setValue(0);
    blockedShakeX.setValue(0);

    Animated.sequence([
      Animated.parallel([
        Animated.timing(blockedFlashOpacity, {
          toValue: 1,
          duration: 130,
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.timing(blockedShakeX, { toValue: 2, duration: 60, useNativeDriver: true }),
          Animated.timing(blockedShakeX, { toValue: -2, duration: 70, useNativeDriver: true }),
          Animated.timing(blockedShakeX, { toValue: 1.5, duration: 55, useNativeDriver: true }),
          Animated.timing(blockedShakeX, { toValue: 0, duration: 65, useNativeDriver: true }),
        ]),
      ]),
      Animated.timing(blockedFlashOpacity, {
        toValue: 0,
        duration: 280,
        useNativeDriver: true,
      }),
    ]).start();
    onDisabledPress?.();
  }, [blockedFlashOpacity, blockedShakeX, onDisabledPress]);

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
        <Animated.View
          style={{
            width: buttonWidth + borderWidth * 2,
            height: buttonHeight + borderWidth * 2,
            borderRadius: borderRadius + borderWidth,
            overflow: 'hidden',
            transform: [{ translateX: blockedShakeX }],
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
                opacity: disabled ? 0.18 : titanOpacity,
              }}
            />
            <Animated.View
              pointerEvents="none"
              style={{
                ...StyleSheet.absoluteFillObject,
                borderRadius: borderRadius,
                backgroundColor: 'rgba(255,90,103,0.35)',
                opacity: blockedFlashOpacity.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 0.55],
                }),
              }}
            />
            <TouchableOpacity
              activeOpacity={1}
              onPressIn={() => {
                if (disabled) {
                  triggerBlockedFeedback();
                  return;
                }
                // Увеличиваем blur и прозрачность титана при нажатии - более заметно для светлой темы
                setBlurIntensity(isDark ? 25 : 40);
                Animated.timing(titanOpacity, {
                  toValue: isDark ? 0.4 : 0.5, // Больше для светлой темы
                  duration: 150,
                  useNativeDriver: true,
                }).start();
              }}
              onPressOut={() => {
                if (disabled) return;
                // Возвращаем к исходным значениям
                setBlurIntensity(isDark ? 15 : 20);
                Animated.timing(titanOpacity, {
                  toValue: 0.25,
                  duration: 200,
                  useNativeDriver: true,
                }).start();
              }}
              onPress={() => {
                if (disabled) {
                  triggerBlockedFeedback();
                  return;
                }
                onPress();
              }}
              accessibilityState={{ disabled }}
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
              <Text
                style={[
                  styles.buttonLabel,
                  {
                    color: isDark ? LIVI.text : LIVI.textThemeWhite,
                    textAlign: 'center',
                    opacity: disabled ? 0.88 : 1,
                  },
                ]}
                allowFontScaling={false}
                maxFontSizeMultiplier={1}
              >
                {label}
              </Text>
            </TouchableOpacity>
            {disabled && (
              <Pressable
                style={StyleSheet.absoluteFillObject}
                onPressIn={triggerBlockedFeedback}
                onPress={triggerBlockedFeedback}
                android_ripple={{ color: 'rgba(255,90,103,0.10)', borderless: false }}
              />
            )}
          </View>
        </Animated.View>
      </View>
    </View>
  );
};

/* ================= component ================= */

/** При возврате на Home (например из VideoCall по Back → PiP) экран монтируется заново и state сбрасывается — без этого флага снова показывался бы SplashLoader. Запоминаем, что контент уже показывали в этой сессии. */
let homeScreenAlreadyBooted = false;

export default function HomeScreen({ navigation, route }: Props & { route?: { params?: HomeRouteParams } }) {
  const { width: layoutWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const pip = usePiP();
  const { preference, setPreference, theme, isDark } = useAppTheme();
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === 'active');

  /* friends state */
  const [friends, setFriends] = useState<Friend[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const friendsRef = useRef<Friend[]>([]);
  useEffect(() => { friendsRef.current = friends; }, [friends]);

  /** Метки времени «точно онлайн» для debounce офлайна в onPresenceUpdate (loadFriends больше не затирает online сервера). */
  const friendLastOnlineTrueAtRef = useRef<Map<string, number>>(new Map());
  const pendingPresenceOfflineTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Закрытие свайпа строки при нажатии «Видеозвонок», чтобы не видеть кнопку удаления друга до появления нативного экрана
  const openSwipeableRef = useRef<React.ElementRef<typeof Swipeable> | null>(null);
  const swipeableRefsMap = useRef<Record<string, React.ElementRef<typeof Swipeable>>>({});
  const [swipeActionsHiddenForCall, setSwipeActionsHiddenForCall] = useState<string | null>(null);
  
  // ===== friends cache (cold start UX) =====
  // При холодном старте сокет/идентификация могут занять 1-3+ сек, из-за чего вкладка "Друзья" выглядит пустой.
  // Решение: показываем последний кэшированный список друзей сразу, а потом обновляем через loadFriends().
  const FRIENDS_CACHE_KEY = 'friends_cache_v1';
  const friendsCacheLoadedRef = useRef(false);
  // Чтобы не ловить TS "использовано до объявления" (loadFriends объявлен ниже),
  // используем ref-обёртку для вызова loadFriends из ранних колбэков (например инвайты).
  const loadFriendsFnRef = useRef<() => void>(() => {});

  /* tabs & menu */
  const [menuOpen, setMenuOpen] = useState(false);
  const [tab, setTab] = useState<'friends' | 'settings' | 'more'>('friends');
  const tabRef = useRef<'friends' | 'settings' | 'more'>(tab);
  const menuOverlayOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  // При переходе на вкладку «Друзья» — сразу помечаем «увидел», снимаем все уведомления из шторки и обнуляем бейдж, чтобы они не появлялись снова до нового звонка/сообщения.
  useEffect(() => {
    if (tab !== 'friends') return;
    setMissedBadgeCleared()
      .then(() => dismissMissedCallNotificationsOnly())
      .then(() => syncAppBadgeFromMissedCount())
      .catch(() => {});
  }, [tab]);

  // Плавное появление оверлея меню — короткая анимация для быстрого отклика
  // КРИТИЧНО: при закрытии сбрасываем opacity в 0, чтобы при следующем открытии анимация была с 0
  useEffect(() => {
    if (!menuOpen) {
      menuOverlayOpacity.setValue(0);
      return;
    }
    menuOverlayOpacity.setValue(0);
    Animated.timing(menuOverlayOpacity, {
      toValue: 1,
      duration: 100,
      useNativeDriver: true,
    }).start();
  }, [menuOpen, menuOverlayOpacity]);

  const closeMenu = useCallback(() => {
    Animated.timing(menuOverlayOpacity, {
      toValue: 0,
      duration: 150,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setMenuOpen(false);
    });
  }, [menuOverlayOpacity]);

  /* обновление приложения: бейдж раз в сутки, индикатор у «Ещё», кнопка в табе Ещё */
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [showUpdateBadge, setShowUpdateBadgeState] = useState(false);
  const updateBadgeShownRef = useRef(false);
  const suppressUpdateBadgeUntilRef = useRef(0);
  /** Результат последней isUpdateAvailable() в check() — для shouldShowUpdateBadge без повторного запроса */
  const serverSaysUpdateRef = useRef(false);
  const updateSpinAnim = useRef(new Animated.Value(0)).current;

  // Единый фон для "титановой" кнопки меню и кружка аватара (в светлой теме),
  // чтобы элементы выглядели консистентно.
  const MENU_CHROME_BG = isDark
    ? 'rgba(138, 143, 153, 0.15)' // титановый для тёмной темы
    : Platform.OS === 'android'
      ? 'rgba(59, 68, 83, 0.10)' // чуть легче на Android
      : 'rgba(59, 68, 83, 0.15)'; // iOS

  // Внутри кнопки меню: тот же фон, что у кнопки «Начать поиск» (theme.colors.background).
  const MENU_BTN_INNER_BG = theme.colors.background as string;

  // На Android: при открытом меню кнопка "Назад" закрывает меню (возврат на страницу приветствия), а не выходит из приложения
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!menuOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeMenu();
      return true; // перехватываем — не выходим из приложения
    });
    return () => sub.remove();
  }, [menuOpen, closeMenu]);

  // На Android обработка выхода на корне (Back → системный PiP) централизована в App.tsx,
  // чтобы избежать конфликтов порядка BackHandler'ов (и неожиданного системного PiP на VideoCall).

  const suppressUpdateBadgeForCallNotice = useCallback((durationMs = 4000) => {
    suppressUpdateBadgeUntilRef.current = Math.max(
      suppressUpdateBadgeUntilRef.current,
      Date.now() + durationMs
    );
    setShowUpdateBadgeState(false);
  }, []);

  // Проверка доступности обновления (при старте и при возврате в приложение)
  // Дебаунс при resume: не чаще раза в 60 сек, чтобы избежать мерцания при частых AppState active (два устройства, блокировка экрана)
  const lastUpdateCheckAtRef = useRef(0);
  const UPDATE_CHECK_RESUME_DEBOUNCE_MS = 60 * 1000;
  useEffect(() => {
    let cancelled = false;
    clearUpdateCheckCache(); // при каждом запуске — свежая проверка, чтобы после установки обновления индикатор и кнопка «Обновить» исчезли
    const check = async () => {
      try {
        lastUpdateCheckAtRef.current = Date.now();
        const serverSaysUpdate = await isUpdateAvailable();
        serverSaysUpdateRef.current = serverSaysUpdate;
        const cooldown = await isUpdateReminderCooldownActive();
        if (!cancelled) {
          // Релиз: показываем напоминание только если сервер считает, что есть более новая версия, и не в кулдауне 24 ч
          // (кулдаун сбрасывается, если latestAppVersion на сервере выросла после закрытия).
          const showPromotion = __DEV__ ? true : !!(serverSaysUpdate && !cooldown);
          setUpdateAvailable(showPromotion);
          if (!__DEV__ && !serverSaysUpdate) {
            setShowUpdateBadgeState(false);
            await clearUpdatePromotionWhenUpToDate();
          }
        }
      } catch {}
    };
    check();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        const now = Date.now();
        if (now - lastUpdateCheckAtRef.current < UPDATE_CHECK_RESUME_DEBOUNCE_MS) return;
        clearUpdateCheckCache(); // при возврате в приложение — запросить свежую версию с сервера
        check();
      }
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  // Баннер обновления в слоте уведомлений (между подзаголовком и «Начать поиск»): в dev при updateAvailable; в релизе updateAvailable уже с учётом кулдауна, shouldShowUpdateBadge — лишняя сеть/дубль
  useEffect(() => {
    if (!updateAvailable) return;
    let cancelled = false;
    (async () => {
      try {
        const should = await shouldShowUpdateBadge(__DEV__ ? undefined : serverSaysUpdateRef.current);
        if (!cancelled && should && Date.now() >= suppressUpdateBadgeUntilRef.current) {
          if (__DEV__) updateBadgeShownRef.current = true;
          setShowUpdateBadgeState(true);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [updateAvailable]);

  // Анимация вращения иконки обновления (две стрелки по кругу); перезапуск при входе на вкладку «Ещё»
  useEffect(() => {
    if (!updateAvailable || tab !== 'more') return;
    const loop = Animated.loop(
      Animated.timing(updateSpinAnim, {
        toValue: 1,
        duration: 1500,
        useNativeDriver: true,
        easing: Easing.linear,
      })
    );
    updateSpinAnim.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [updateAvailable, updateSpinAnim, tab]);

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
  // Автоскрытие бейджа «Обновить» через 3 сек — только когда оверлей сплеша уже скрыт (пользователь видит страницу приветствия).
  // Раньше таймер был привязан к splashVisible (data/profile) и стартовал под оверлеем — бейдж исчезал через 1–2 сек после появления.
  useEffect(() => {
    if (!showUpdateBadge || !splashDismissed) return;
    const t = setTimeout(() => {
      setShowUpdateBadgeState(false);
      markUpdateBadgeShown();
    }, 3000);
    return () => clearTimeout(t);
  }, [showUpdateBadge, splashDismissed]);
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
  const [resolvedUserId, setResolvedUserId] = useState<string>('');
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

  useEffect(() => {
    const off = onCometChatStatus?.((payload) => {
      if (!payload?.message) return;
      const prefix = payload.title ? `${payload.title}: ` : '';
      const kind: NoticeKind =
        payload.kind === 'error' ? 'error' : payload.kind === 'success' ? 'success' : 'info';
      showNotice(`${prefix}${payload.message}`, kind, payload.kind === 'error' ? 4500 : 3000);
    });
    return () => {
      try { off?.(); } catch {}
    };
  }, [showNotice]);
  
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
      console.warn(`[analytics] ${key} -> ${next}`);
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
  
  useEffect(() => {
    const checkInviteFromRoute = async () => {
      const inviteCode = route?.params?.inviteCode as string | undefined;
      const shouldShow = route?.params?.showInviteModal as boolean | undefined;
      
      // Проверяем, не обрабатывали ли мы уже этот код
      if (!inviteCode || processedInviteRef.current === inviteCode) {
        return;
      }

      // Если showInviteModal не установлен, но есть inviteCode - все равно обрабатываем
      if (!shouldShow && !inviteCode) {
        return;
      }

      // Помечаем как обработанный
      processedInviteRef.current = inviteCode;

      try {
        const result = await checkInviteLink(inviteCode);
        
        if (!result.ok) {
          showNotice(t('inviteLinkInvalid', lang), 'error', 3000);
          return;
        }

        if (result.areFriends) {
          // Пользователи уже друзья
          showNotice(t('inviteAlreadyFriendsWithUser', lang), 'info', 3000);
          return;
        }

        if (result.hasPendingRequest) {
          // Заявка уже отправлена
          showNotice(t('inviteRequestAlreadySent', lang), 'info', 3000);
          return;
        }

        if (result.canAdd && result.inviter) {
          // Показываем модалку приглашения
          setInviteRequestData({
            code: inviteCode,
            inviter: result.inviter,
            areFriends: result.areFriends,
            hasPendingRequest: result.hasPendingRequest,
          });
          setInviteRequestVisible(true);
        }
      } catch (e) {
        logger.error('Failed to check invite from route:', e);
        showNotice(t('inviteLinkProcessFailed', lang), 'error', 3000);
        // Сбрасываем флаг обработки при ошибке, чтобы можно было повторить
        processedInviteRef.current = null;
      }
    };

    // Обрабатываем при изменении параметров или при первом монтировании
    if (route?.params?.inviteCode || route?.params?.showInviteModal) {
      // Небольшая задержка для гарантии готовности компонента
      const timer = setTimeout(() => {
        checkInviteFromRoute();
      }, 300);
      
      return () => clearTimeout(timer);
    }
  }, [route?.params?.showInviteModal, route?.params?.inviteCode, showNotice]);

  // ===== Обработка принятия/отклонения приглашения =====
  const handleAcceptInvite = useCallback(async () => {
    if (!inviteRequestData) return;

    try {
      // Используем acceptInvite для немедленного добавления в друзья (без заявки)
      const result = await acceptInvite(inviteRequestData.inviter.id);
      
      if (result?.ok) {
        if (result.status === 'already') {
          showNotice(t('already_friends', lang), 'info', 3000);
        } else if (result.status === 'accepted') {
          showNotice(t('inviteUserAdded', lang), 'success', 3000);
          // Обновляем список друзей
          loadFriendsFnRef.current();
        } else {
          showNotice(t('inviteUserAdded', lang), 'success', 3000);
          // Обновляем список друзей
          loadFriendsFnRef.current();
        }
      } else {
        showNotice(result?.error || t('friendAddFailed', lang), 'error', 3000);
      }
      
      setInviteRequestVisible(false);
      setInviteRequestData(null);
      // Сбрасываем флаг обработки
      if (route?.params?.inviteCode) {
        processedInviteRef.current = null;
      }
    } catch (e) {
      logger.error('Failed to accept invite:', e);
      showNotice(t('friendAddFailed', lang), 'error', 3000);
      setInviteRequestVisible(false);
      setInviteRequestData(null);
      // Сбрасываем флаг обработки при ошибке
      if (route?.params?.inviteCode) {
        processedInviteRef.current = null;
      }
    }
  }, [inviteRequestData, showNotice, route?.params?.inviteCode]);

  const handleDeclineInvite = useCallback(() => {
    setInviteRequestVisible(false);
    setInviteRequestData(null);
    // Сбрасываем флаг обработки, чтобы можно было открыть снова
    if (route?.params?.inviteCode) {
      processedInviteRef.current = null;
    }
  }, [route?.params?.inviteCode]);

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
  const [missedByUser, setMissedByUser] = useState<Record<string, number>>({});
  const [missedLoaded, setMissedLoaded] = useState(false);
  const [markReadMenu, setMarkReadMenu] = useState<{ friendId: string; type: 'video' | 'chat' } | null>(null);
  const menuStripWidth = useRef(new Animated.Value(0)).current;
  const rowRefForMarkReadMenu = useRef<View>(null);
  const avatarRefForMarkReadMenu = useRef<View>(null);
  const [markReadOverlayLeft, setMarkReadOverlayLeft] = useState<number | null>(null);
  const GAP_AFTER_AVATAR = 12;
  const MAX_MARK_READ_STRIP_WIDTH = 320;
  const LIST_PADDING_H = 16;
  const STRIP_RIGHT_MARGIN = 8;
  useEffect(() => {
    if (markReadMenu) {
      const overlayLeft = markReadOverlayLeft ?? (Platform.OS === 'ios' ? 52 + GAP_AFTER_AVATAR : 44 + GAP_AFTER_AVATAR);
      const windowWidth = Dimensions.get('window').width;
      const targetWidth = Math.min(
        MAX_MARK_READ_STRIP_WIDTH,
        Math.max(0, windowWidth - LIST_PADDING_H * 2 - overlayLeft - STRIP_RIGHT_MARGIN)
      );
      Animated.timing(menuStripWidth, { toValue: targetWidth, duration: 220, useNativeDriver: false }).start();
    } else {
      setMarkReadOverlayLeft(null);
      Animated.timing(menuStripWidth, { toValue: 0, duration: 180, useNativeDriver: false }).start();
    }
  }, [markReadMenu, markReadOverlayLeft, menuStripWidth]);
  const measureAvatarForOverlay = useCallback(() => {
    const row = rowRefForMarkReadMenu.current;
    const avatar = avatarRefForMarkReadMenu.current;
    if (row && avatar && typeof (avatar as any).measureLayout === 'function') {
      (avatar as any).measureLayout(
        row as any,
        (x: number, _y: number, width: number, _h: number) => setMarkReadOverlayLeft(x + width + GAP_AFTER_AVATAR)
      );
    }
  }, []);
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
  /** Пользователь явно сбросил исходящий (кнопка/натив): не показывать callStartFailed когда позже падает отложенный startCall. */
  const outgoingCallUserCanceledRef = useRef(false);
  const outgoingCallSoundRef = useRef<Audio.Sound | null>(null);
  const callingVisibleRef = useRef(false);
  callingVisibleRef.current = calling.visible;

  // ВАЖНО: не закрываем исходящий UI на socket 'connect'.
  // Иначе при старте звонка из вкладки «Друзья» (HomeScreen смонтирован) нативный исходящий экран
  // может закрываться сразу же, если сокет в этот момент переподключается/доподключается.
  // Закрытие исходящего уже покрыто событиями call:declined/cancel/timeout + локальным safeguard-таймаутом.

  // Ref текущего исходящего callId — fallback для App: при подключении сокета запросить call:accepted, если FCM не сработал (инициатор на нативном экране)
  useEffect(() => {
    (global as any).__outgoingCallIdRef = (global as any).__outgoingCallIdRef ?? { current: null };
    (global as any).__outgoingCallIdRef.current = calling.visible && calling.callId ? calling.callId : null;
    return () => {
      if ((global as any).__outgoingCallIdRef?.current === calling.callId) (global as any).__outgoingCallIdRef.current = null;
    };
  }, [calling.visible, calling.callId]);

  // Закрытие модалки исходящего по событию извне (абонент отклонил на нативном экране/отменил/таймаут — событие приходит в App, эмитится emitCloseOutgoingCall)
  useEffect(() => {
    const unsub = onCloseOutgoingCall(() => {
      // Дедуп: при отмене инициатором мы уже закрываем исходящий локально (handleCancelCall),
      // а потом может прийти второе закрытие через App/push → лишнее setCalling даёт 2 мерцания.
      if (!callingVisibleRef.current) return;
      // Важно: ставим ref сразу, чтобы подавить гонки до следующего рендера.
      callingVisibleRef.current = false;
      setCalling({ visible: false, friend: null, callId: null });
      stopWaves();
    });
    return unsub;
  }, [stopWaves]);

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

  // Звук вызова: в модалке — из JS (WAV в цикле); на нативном экране — из OutgoingCallActivity (тот же WAV).
  const OUTGOING_CALL_SOUND_DURATION_MS = 27000;
  useEffect(() => {
    if (!calling.visible || isCallKeepAvailable()) {
      const sound = outgoingCallSoundRef.current;
      if (sound) {
        outgoingCallSoundRef.current = null;
        sound.stopAsync().catch(() => {});
        sound.unloadAsync().catch(() => {});
      }
      return;
    }
    let cancelled = false;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          allowsRecordingIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: false,
          playThroughEarpieceAndroid: false, // основной динамик — разговорный тихо даже при 1.0
        });
        const { sound } = await Audio.Sound.createAsync(
          require('../assets/phone-calling-1b.wav'),
          { shouldPlay: false, isLooping: true }
        );
        if (cancelled) {
          sound.unloadAsync().catch(() => {});
          return;
        }
        const volume = 0.8; // 0.0–1.0; на основном динамике разница 0.4/0.9 слышна
        await sound.setVolumeAsync(volume);
        outgoingCallSoundRef.current = sound;
        await sound.playAsync();

        stopTimer = setTimeout(() => {
          if (outgoingCallSoundRef.current === sound) {
            outgoingCallSoundRef.current = null;
            sound.stopAsync().catch(() => {});
            sound.unloadAsync().catch(() => {});
          }
        }, OUTGOING_CALL_SOUND_DURATION_MS);
      } catch {
        // игнорируем ошибки загрузки/воспроизведения
      }
    })();
    return () => {
      cancelled = true;
      if (stopTimer != null) clearTimeout(stopTimer);
    };
  }, [calling.visible]);

  const handleStartVideoCall = useCallback(async (friend: Friend) => {
    const friendName = friend.name ?? '';
    setSwipeActionsHiddenForCall(friend.id);
    openSwipeableRef.current?.close?.();
    clearOutgoingDeclineHandled();
    try {
      pendingCancelRef.current = false;
      outgoingCallUserCanceledRef.current = false;
      setCalling({ visible: true, friend, callId: null });
      startWaves();
      // Сразу помечаем «исходящий на экране», чтобы сокет не отключался при уходе в фон (диалог разрешений).
      // Иначе звонок не дойдёт до абонента (startCall по сокету).
      setOutgoingCallScreenVisible(true);
      // Запрашиваем разрешение до показа нативного экрана, чтобы диалог не появлялся поверх «Вы звоните».
      if (Platform.OS === 'android') {
        await setupCallKeep({ requestPermission: true });
      }
      // Нативный экран исходящего — только после завершения запроса разрешений
      displayOutgoingCallImmediate(friend.id, friendName);

      // Подписки ДО await startCall: иначе call:declined может прийти раньше регистрации → calling остаётся true → кнопки видео глобально disabled.
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
      };

      const finishOutgoing = (body: () => void) => {
        if (outgoingFinished) return;
        outgoingFinished = true;
        removeAllSocketSubs();
        body();
      };

      const sub = (off: (() => void) | undefined) => {
        if (off) socketUnsubs.push(off);
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
            stopWaves();
          });
        }),
      );

      sub(
        onCallDeclined?.(() => {
          finishOutgoing(() => {
            logger.info('[decline/инициатор] HomeScreen offDeclined: setCalling(false), stopWaves, showNotice');
            callingVisibleRef.current = false;
            setCalling({ visible: false, friend: null, callId: null });
            stopWaves();
            showNotice(t('callDeclined', lang), 'error', 3000);
          });
        }),
      );

      sub(
        onCallTimeout?.(() => {
          finishOutgoing(() => {
            try { setOutgoingCallScreenVisible(false); } catch {}
            try { closeOutgoingCallActivity(); } catch {}
            callingVisibleRef.current = false;
            setCalling({ visible: false, friend: null, callId: null });
            stopWaves();
          });
        }),
      );

      sub(
        onCallRoomFull?.(() => {
          finishOutgoing(() => {
            callingVisibleRef.current = false;
            setCalling({ visible: false, friend: null, callId: null });
            stopWaves();
            setRoomFull({ visible: true, name: friend.name || '' });
            setTimeout(() => setRoomFull({ visible: false, name: '' }), 2000);
          });
        }),
      );

      sub(
        onCallCanceled?.(() => {
          finishOutgoing(() => {
            try { setOutgoingCallScreenVisible(false); } catch {}
            try { closeOutgoingCallActivity(); } catch {}
            callingVisibleRef.current = false;
            setCalling({ visible: false, friend: null, callId: null });
            stopWaves();
          });
        }),
      );

      let r: any;
      try {
        r = await startCall(friend.id);
      } catch (startErr) {
        if (!outgoingFinished) {
          outgoingFinished = true;
          removeAllSocketSubs();
        }
        throw startErr;
      }

      if (!r?.ok) {
        if (!outgoingFinished) {
          outgoingFinished = true;
          removeAllSocketSubs();
        }
        throw new Error(r?.error || 'call_failed');
      }

      // Отклонение/таймаут пришли по сокету до ack startCall — UI уже сброшен; синхронизируем сервер.
      if (outgoingFinished) {
        if (r.callId) {
          try { cancelCall(r.callId); } catch {}
        }
        return;
      }

      setCalling((c) => ({ ...c, callId: r.callId || null }));

      if (r.callId) {
        notifyOutgoingCallId(r.callId);
      }

      const canceledByNative = (global as any).__outgoingCanceledByNativeRef?.current === true;
      if ((pendingCancelRef.current || canceledByNative) && r.callId) {
        if (canceledByNative) (global as any).__outgoingCanceledByNativeRef.current = false;
        try { cancelCall(r.callId); } catch {}
        pendingCancelRef.current = false;
        finishOutgoing(() => {
          try { setOutgoingCallScreenVisible(false); } catch {}
          try { closeOutgoingCallActivity(); } catch {}
          callingVisibleRef.current = false;
          setCalling({ visible: false, friend: null, callId: null });
          stopWaves();
        });
        return;
      }

      const callIdForTimeout = r.callId;
      safeguardTimer = setTimeout(() => {
        finishOutgoing(() => {
          try { setOutgoingCallScreenVisible(false); } catch {}
          try { closeOutgoingCallActivity(); } catch {}
          if (callIdForTimeout) try { reportEndCallToCallKeep(callIdForTimeout); } catch {}
          callingVisibleRef.current = false;
          setCalling({ visible: false, friend: null, callId: null });
          stopWaves();
          showNotice(t('noAnswer', lang), 'error', 3000);
        });
      }, OUTGOING_CALL_TIMEOUT_MS);
    } catch (e: any) {
      logger.warn('[outgoing] handleStartVideoCall failed', { error: e?.message ?? String(e) });
      try { setOutgoingCallScreenVisible(false); } catch {}
      callingVisibleRef.current = false;
      setCalling({ visible: false, friend: null, callId: null });
      stopWaves();
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
  }, [navigation, showNotice, startWaves, stopWaves, lang]);

  const handleCancelCall = useCallback(() => {
    outgoingCallUserCanceledRef.current = true;
    // Важно: ставим ref сразу, чтобы внешние события (socket/push/native) не закрывали второй раз до рендера.
    callingVisibleRef.current = false;
    if (calling.callId) {
      try {
        reportEndCallToCallKeep(calling.callId);
        setOutgoingCallScreenVisible(false);
        closeOutgoingCallActivity();
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
    showNotice(t('callCancelled', lang), 'error', 3000);
  }, [calling.callId, stopWaves, showNotice, lang]);

  /* friends fetch */
  const loadFriendsRef = useRef<Promise<void> | null>(null);
  const loadFriends = useCallback(async () => {
    // Защита от дублирования запросов
    if (loadFriendsRef.current) {
      return loadFriendsRef.current;
    }
    
    const promise = (async () => {
      try {
        // Хотим максимально быстро получить "свежий" список.
        // Если сокет уже подключён — берём socket-ack. Если нет — используем REST /api/friends (по installId),
        // чтобы не ждать handshake/reauth и не держать вкладку пустой.
        let res: any = null;

        const s: any = socket as any;
        if (s?.connected) {
          try {
            res = await fetchFriends?.();
          } catch {}
        }

        if (!res?.ok) {
          // REST fallback (не зависит от сокета). Два таймаута для VPN: быстрая сеть 7s, медленная 20s.
          const base = String(API_BASE || 'https://api.liviapp.com').replace(/\/+$/, '');
          const id = await getInstallId().catch(() => '');
          if (id) {
            const url = `${base}/api/friends?page=1&limit=50`;
            const timeouts = [7000, 20000];
            for (const ms of timeouts) {
              try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), ms);
                const httpRes = await fetch(url, {
                  method: 'GET',
                  headers: {
                    'Content-Type': 'application/json',
                    'x-install-id': String(id),
                  },
                  signal: controller.signal,
                });
                clearTimeout(timeoutId);
                if (httpRes.ok) {
                  const json = await httpRes.json().catch(() => null);
                  if (json?.ok) {
                    res = json;
                    break;
                  }
                }
              } catch (_) {
                await new Promise((r) => setTimeout(r, 200));
              }
            }
          }
        }
        
        // КРИТИЧНО: Убираем avatarThumbB64 из логов (очень большой base64)
        const logRes = res ? {
          ...res,
          list: res.list?.map((f: any) => ({
            ...f,
            avatarThumbB64: f.avatarThumbB64 ? `[base64: ${f.avatarThumbB64.length} chars]` : undefined
          }))
        } : res;

        // ВАЖНО: при временном оффлайне/ошибке не затираем текущий список друзей пустым массивом.
        // Обновлять friends-state (и friends_cache) можно только при валидном успешном ответе.
        const hasUsableFriendsPayload = !!res?.ok && Array.isArray(res?.list);
        if (!hasUsableFriendsPayload) {
          logger.debug('[loadFriends] Skip friends overwrite: backend payload not usable', {
            ok: !!res?.ok,
            hasList: Array.isArray(res?.list),
            error: String(res?.error || ''),
          });
          return;
        }

        const incoming: any[] = res.list;
        const fresh: Friend[] = incoming.map(mapToFriend);
        setFriends((prev) => {
          const merged: Friend[] = fresh.map((f: Friend) => {
            const prevOne = prev.find((p) => p.id === f.id) as any;
            // КРИТИЧНО: Используем полный никнейм из нового списка, не обрезаем
            // Если в новом списке есть имя - используем его, иначе старое, иначе пустое
            const finalName = (f.name && f.name.trim()) || (prevOne?.name && prevOne.name.trim()) || '';
            
            // Проверяем, что никнейм не обрезан до одной буквы
            if (finalName && finalName.length === 1 && finalName !== '—' && f.name && f.name.trim().length > 1) {
              logger.error('[loadFriends] ❌ КРИТИЧЕСКАЯ ОШИБКА: никнейм обрезан до одной буквы!', {
                friendId: f.id,
                newName: f.name,
                newNameLength: f.name.length,
                prevName: prevOne?.name,
                prevNameLength: prevOne?.name?.length || 0,
                finalName,
                finalNameLength: finalName.length
              });
              // Исправляем: используем полный никнейм из нового списка
              const correctedName = f.name.trim();
              logger.info('[loadFriends] Исправляем: используем полный никнейм', { correctedName });
              
              // КРИТИЧНО: Сохраняем avatarThumbB64 правильно (как в основном блоке)
              const newAvatarVer = typeof f.avatarVer === 'number' ? f.avatarVer : (prevOne?.avatarVer || 0);
              const prevAvatarVer = prevOne?.avatarVer || 0;
              const avatarVerChanged = newAvatarVer !== prevAvatarVer;
              
              let finalAvatarThumbB64: string;
              if (avatarVerChanged || 'avatarThumbB64' in f) {
                finalAvatarThumbB64 = typeof f.avatarThumbB64 === 'string' ? f.avatarThumbB64 : '';
              } else {
                finalAvatarThumbB64 = prevOne?.avatarThumbB64 || '';
              }

              let mergedOnlineCorr: boolean;
              if (f.online) {
                friendLastOnlineTrueAtRef.current.set(f.id, Date.now());
                mergedOnlineCorr = true;
              } else if (prevOne?.online) {
                // Не гасим online из одного ответа loadFriends (гонка REST vs socket после call:end).
                // Офлайн — только из presence:update (массив видимых онлайн) с debounce.
                mergedOnlineCorr = true;
              } else {
                friendLastOnlineTrueAtRef.current.delete(f.id);
                mergedOnlineCorr = false;
              }
              
              return {
                ...f,
                name: correctedName,
                avatar: f.avatar || prevOne?.avatar || '',
                avatarVer: newAvatarVer,
                avatarThumbB64: finalAvatarThumbB64,
                online: mergedOnlineCorr,
                isBusy: f.isBusy !== undefined ? !!f.isBusy : !!prevOne?.isBusy,
                isRandomBusy: !!prevOne?.isRandomBusy,
                inCall: !!prevOne?.inCall,
              } as any;
            }
            
            // КРИТИЧНО: Сохраняем avatarThumbB64 и avatarVer правильно
            // Если в новом списке есть avatarThumbB64 (даже пустая строка), используем его
            // Если в новом списке нет avatarThumbB64 (undefined), сохраняем старое значение
            // Также учитываем avatarVer - если версия изменилась, нужно использовать новые данные
            const newAvatarVer = typeof f.avatarVer === 'number' ? f.avatarVer : (prevOne?.avatarVer || 0);
            const prevAvatarVer = prevOne?.avatarVer || 0;
            const avatarVerChanged = newAvatarVer !== prevAvatarVer;
            
            // Если версия изменилась или в новом списке явно указан avatarThumbB64, используем новое значение
            // Иначе сохраняем старое (если оно было)
            let finalAvatarThumbB64: string;
            if (avatarVerChanged || 'avatarThumbB64' in f) {
              // Версия изменилась или поле явно присутствует в ответе - используем новое значение
              finalAvatarThumbB64 = typeof f.avatarThumbB64 === 'string' ? f.avatarThumbB64 : '';
            } else {
              // Версия не изменилась и поле не пришло - сохраняем старое значение
              finalAvatarThumbB64 = prevOne?.avatarThumbB64 || '';
            }

            let mergedOnlineMain: boolean;
            if (f.online) {
              friendLastOnlineTrueAtRef.current.set(f.id, Date.now());
              mergedOnlineMain = true;
            } else if (prevOne?.online) {
              mergedOnlineMain = true;
            } else {
              friendLastOnlineTrueAtRef.current.delete(f.id);
              mergedOnlineMain = false;
            }
            
            return {
              ...f,
              name: finalName,
              avatar: f.avatar || prevOne?.avatar || '',
              avatarVer: newAvatarVer,
              avatarThumbB64: finalAvatarThumbB64,
              online: mergedOnlineMain,
              isBusy: f.isBusy !== undefined ? !!f.isBusy : !!prevOne?.isBusy,
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

          // Кэшируем список друзей для мгновенного отображения при холодном старте
          // (без ожидания сокета/ensureIdentity).
          try {
            const cacheList = merged.map((f: any) => ({
              id: String(f.id),
              name: String(f.name || ''),
              avatar: String(f.avatar || ''),
              avatarVer: typeof f.avatarVer === 'number' ? f.avatarVer : 0,
              // AvatarImage умеет грузить миниатюру из avatarCache по (userId, avatarVer),
              // но сохраняем avatarThumbB64 если он есть, чтобы сразу показывать без доп. async.
              avatarThumbB64: String(f.avatarThumbB64 || ''),
            }));
            AsyncStorage.setItem(
              FRIENDS_CACHE_KEY,
              JSON.stringify({ v: 1, ts: Date.now(), list: cacheList })
            ).catch(() => {});
          } catch {}

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

  // Поднимаем кэш друзей сразу (до socket/ensureIdentity), чтобы вкладка "Друзья" не была пустой при холодном старте.
  useEffect(() => {
    if (friendsCacheLoadedRef.current) return;
    friendsCacheLoadedRef.current = true;

    (async () => {
      try {
        const raw = await AsyncStorage.getItem(FRIENDS_CACHE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed?.list) ? parsed.list : (Array.isArray(parsed) ? parsed : []);
        if (!Array.isArray(list) || list.length === 0) return;

        const cached: Friend[] = list
          .map((it: any) => {
            const id = it?.id != null ? String(it.id) : '';
            if (!id) return null;
            return {
              id,
              name: String(it?.name || ''),
              avatar: String(it?.avatar || ''),
              avatarVer: typeof it?.avatarVer === 'number' ? it.avatarVer : 0,
              avatarThumbB64: String(it?.avatarThumbB64 || ''),
              // онлайн/занятость не считаем "истиной" при холодном старте — это будет обновлено presence/socket-ивентами
              online: false,
              isBusy: false,
            } as any;
          })
          .filter(Boolean) as Friend[];

        if (cached.length > 0) {
          // Не затираем уже загруженный список, если он успел прийти
          setFriends((prev) => (prev && prev.length > 0 ? prev : cached));
          setInitialized(true);
        }
      } catch {}
    })();
  }, []);

  // Делаем стабильный "вызоватор" loadFriends для ранних колбэков (инвайты и т.п.)
  useEffect(() => {
    loadFriendsFnRef.current = () => {
      loadFriends().catch(() => {});
    };
  }, [loadFriends]);

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

      const currentUserId = getCurrentUserId();
      if (!currentUserId) {
        return true; // Продолжаем загрузку данных
      }

      // Проверяем существует ли пользователь в MongoDB
      const userExists = await checkUserExists(currentUserId);
      
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
            
            // Обновляем никнейм из backend
            if (profile.nick && typeof profile.nick === 'string' && profile.nick.trim()) {
              loadedNick = profile.nick;
              setNick(profile.nick);
              setSavedNick(profile.nick);
              setSavedNickDebug(profile.nick);
              logger.debug('[HomeScreen] Set nick from backend', { nick: profile.nick });
              hasActualData = true;
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
            
            // Сохраняем профиль даже если он пустой (для нового пользователя это нормально)
            // Важно: сохраняем ответ от backend, даже если все поля пустые
            await saveProfileToStorage({
              nick: profile.nick || '',
              avatar: avatarB64 ? toDataUri(avatarB64) : (avatarThumbB64 ? toDataUri(avatarThumbB64) : '')
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
      
      // Сначала синхронизируем данные пользователя
      const userExists = await syncUserData();
      
      // Если пользователь существует, загружаем его данные
      if (userExists !== false) {
        // Не блокируем загрузку списка друзей — пусть идет параллельно, чтобы "Друзья" обновились быстрее.
        ensureIdentity().catch(() => {});
      }
      
      // Друзей грузим как можно раньше (socket или REST fallback)
      await loadFriends();
      // Инициализация пропущенных видеозвонков из хранилища
      // КРИТИЧНО: Нормализуем ключи (преобразуем в строки) для корректной работы
      try {
        const rawMissed = await AsyncStorage.getItem(MISSED_CALLS_KEY);
        const parsed = rawMissed ? JSON.parse(rawMissed) : {};
        // Нормализуем ключи: преобразуем все ключи в строки
        const normalized: Record<string, number> = {};
        if (parsed && typeof parsed === 'object') {
          Object.keys(parsed).forEach(key => {
            const value = parsed[key];
            if (typeof value === 'number' && value > 0) {
              normalized[String(key)] = value;
            }
          });
        }
        setMissedByUser(normalized);
        setMissedLoaded(true);
        logger.debug('[HomeScreen] Loaded missed calls from storage', { count: Object.keys(normalized).length, normalized });
      } catch (e) {
        logger.warn('[HomeScreen] Error loading missed calls:', e);
      }
    })();
  }, [syncUserData, ensureIdentity, loadFriends]);

  // Сохраняем пропущенные вызовы при изменении
  // КРИТИЧНО: Очищаем ключи с нулевыми значениями перед сохранением
  // НЕ обновляем состояние здесь, чтобы избежать бесконечного цикла
  useEffect(() => {
    if (!missedLoaded) return;
    try {
      // Фильтруем только ключи с значениями > 0
      const cleaned: Record<string, number> = {};
      Object.keys(missedByUser).forEach(key => {
        const value = missedByUser[key];
        if (typeof value === 'number' && value > 0) {
          cleaned[key] = value;
        }
      });
      // Сохраняем только очищенные данные (без нулевых значений)
      AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(cleaned)).catch(() => {});
    } catch (e) {
      logger.warn('[HomeScreen] Error saving missed calls:', e);
    }
  }, [missedByUser, missedLoaded]);

  useEffect(() => {
    syncAppBadgeFromMissedCount().catch(() => {});
  }, [unreadByUser]);

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

  /* ===== refresh friends === */
  useEffect(() => {
    if (menuOpen && tab === 'friends' && appIsActive) {
      setInitialized(true);
      void loadFriends();
      const tmr = setInterval(() => void loadFriends(), 10_000);
      return () => clearInterval(tmr);
    }
  }, [menuOpen, tab, appIsActive, loadFriends]);

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

  // При заходе во вкладку «Друзья» — помечаем «увидел», снимаем уведомления в шторке и обнуляем бейдж
  useEffect(() => {
    if (tab === 'friends') {
      setMissedBadgeCleared()
        .then(() => dismissMissedCallNotificationsOnly())
        .then(() => syncAppBadgeFromMissedCount())
        .catch(() => {});
    }
  }, [tab]);

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
        g.__pipVisibleRef?.current === true ||
        g.__pipInSystemModeRef?.current === true ||
        incomingAnswerTransitionActive ||
        sessionNotEnded ||
        hasAnyCallIds ||
        calling.visible ||
        incomingCallScreen.visible;
      if (hasActiveLocalCall) return;
      emitPresenceUpdateIfChanged({ status: 'online', idle: true }, { force: true });
    } catch (e) {
      logger.warn('[HomeScreen] Failed to sync idle presence online', { reason, error: (e as Error)?.message });
    }
  }, [calling.visible, incomingCallScreen.visible]);

  useEffect(() => {
    if (tab !== 'friends') return;
    syncSelfPresenceOnlineIfIdle('friends-tab');
  }, [tab, syncSelfPresenceOnlineIfIdle]);

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
      // После отмены входящего на Home (callee) пропускаем setAppIsActive, чтобы не было ре-рендера/мерцания страницы приветствия
      const skipSetAppIsActive = (global as any).__skipAppStateActiveSetAppIsActiveRef?.current === true;
      if (!skipSetAppIsActive) {
        try { setAppIsActive(state === 'active'); } catch {}
      } else {
        try { (global as any).__skipAppStateActiveSetAppIsActiveRef.current = false; } catch (_) {}
      }
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
  // При фокусе: если открыта вкладка «Друзья» — помечаем «увидел», снимаем уведомления и не показываем их снова; иначе при не-cleared обновляем бейдж (без повторного появления в шторке — только если уже были показаны).
  useEffect(() => {
    const unsub = navigation?.addListener?.('focus', async () => {
      try {
        // После отмены входящего на Home не дергаем setState при focus — убираем двойной показ страницы
        if ((global as any).__skipAppStateActiveSetAppIsActiveRef?.current === true) {
          return;
        }
        syncSelfPresenceOnlineIfIdle('home-focus');
        const onFriendsTab = tabRef.current === 'friends';
        if (onFriendsTab) {
          await setMissedBadgeCleared();
          await dismissMissedCallNotificationsOnly();
          await dismissMessageNotificationsOnly();
          await syncAppBadgeFromMissedCount();
        }
        // Обновляем пропущенные звонки: синхронизируем с нативным хранилищем (Android — источник истины при FCM), чтобы не было рассинхрона с шторкой и бейджем
        const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        const nativeMissed = await getMissedCountByUserFromNative();
        const merged: Record<string, number> = {};
        const allKeys = new Set([...Object.keys(parsed || {}), ...Object.keys(nativeMissed || {})]);
        allKeys.forEach((key) => {
          const fromStorage = typeof parsed?.[key] === 'number' ? parsed[key] : 0;
          const fromNative = typeof nativeMissed?.[key] === 'number' ? nativeMissed[key] : 0;
          const value = Math.max(fromStorage, fromNative);
          if (value > 0) merged[String(key)] = value;
        });
        await AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(merged));
        setMissedByUser(merged);
        setMissedLoaded(true);
        // Не пересоздаём уведомления в шторке при фокусе, если пользователь уже «увидел» (вкладка Друзья) или cleared
        const badgeCleared = await AsyncStorage.getItem('missed_calls_badge_cleared_v1');
        if (badgeCleared !== 'true' && !onFriendsTab) {
          await syncAppBadgeFromMissedCount();
        }

        // КРИТИЧНО: Обновляем счетчики непрочитанных сообщений при фокусе
        if (friends.length > 0) {
          const entries: Record<string, number> = {};
          await Promise.all(friends.map(async (f) => {
            try { 
              // КРИТИЧНО: Нормализуем ключ (преобразуем в строку) для корректной работы
              const friendIdStr = String(f.id);
              const result = await getUnreadCount(friendIdStr);
              entries[friendIdStr] = result.ok ? (result.count || 0) : 0;
            } catch { 
              const friendIdStr = String(f.id);
              entries[friendIdStr] = 0; 
            }
          }));
          setUnreadByUser((prev) => ({ ...prev, ...entries }));
          logger.debug('[HomeScreen] Reloaded unread messages on focus', { 
            count: Object.keys(entries).length,
            entries 
          });
        }
      } catch (e) {
        logger.warn('[HomeScreen] Error reloading counters on focus:', e);
      }
    });
    return () => { try { unsub?.(); } catch {} };
  }, [navigation, friends, syncSelfPresenceOnlineIfIdle]);

  // После восстановления сети reauth приносит пропущенные с сервера — перечитываем из AsyncStorage и обновляем UI
  useEffect(() => {
    const off = onMissedFetchedFromServer(async () => {
      try {
        const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        const normalized: Record<string, number> = {};
        if (parsed && typeof parsed === 'object') {
          Object.keys(parsed).forEach(key => {
            const value = parsed[key];
            if (typeof value === 'number' && value > 0) normalized[String(key)] = value;
          });
        }
        setMissedByUser(normalized);
        setMissedLoaded(true);
        await clearMissedBadgeCleared();
        await syncAppBadgeFromMissedCount();
      } catch {}
    });
    return off;
  }, []);

  // После восстановления сокета обновляем счётчики непрочитанных без ожидания focus Home (короткая задержка — reauth на сервере).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const refreshUnread = () => {
      const list = friendsRef.current;
      if (!list.length) return;
      (async () => {
        try {
          const entries: Record<string, number> = {};
          await Promise.all(
            list.map(async (f) => {
              const friendIdStr = String(f.id);
              try {
                const result = await getUnreadCount(friendIdStr);
                entries[friendIdStr] = result.ok ? (result.count || 0) : 0;
              } catch {
                entries[friendIdStr] = 0;
              }
            }),
          );
          setUnreadByUser((prev) => ({ ...prev, ...entries }));
          logger.debug('[HomeScreen] Unread counts refreshed after socket connect/reconnect', {
            n: Object.keys(entries).length,
          });
        } catch (e) {
          logger.warn('[HomeScreen] Unread refresh after socket failed:', e);
        }
      })().catch(() => {});
    };

    const schedule = () => {
      if (t) clearTimeout(t);
      t = setTimeout(refreshUnread, 700);
    };

    socket.on('connect', schedule);
    socket.on('reconnect', schedule);
    return () => {
      socket.off('connect', schedule);
      socket.off('reconnect', schedule);
      if (t) clearTimeout(t);
    };
  }, []);

  // Регистрируем колбэк, чтобы при завершении видеозвонка (в т.ч. из PiP) принудительно обновить список друзей — снять бейдж «Занят» и disabled с кнопки.
  useEffect(() => {
    const g = global as any;
    if (!g.__onVideoCallEndedRef) g.__onVideoCallEndedRef = { current: null };
    g.__onVideoCallEndedRef.current = () => {
      const currentPartner = String((g.__videoCallPartnerUserIdRef?.current ?? '') || '').trim();
      const lastPartner = String((lastVideoCallPartnerRef.current ?? '') || '').trim();
      const partnerToClear = currentPartner || lastPartner;
      if (partnerToClear) {
        setFriends((prev) => prev.map((f) => String(f.id) === partnerToClear ? { ...f, isBusy: false } : f));
      }
      setVideoCallEndedTick((t) => t + 1);
    };
    return () => {
      if (g.__onVideoCallEndedRef) g.__onVideoCallEndedRef.current = null;
    };
  }, []);

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
                      String(x.id) === id ? { ...x, online: false } : x,
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
      stopWaves();
      lastIncomingFromRef.current = null;
    });
    return () => { off?.(); };
  }, [stopWaves]);

  // Мгновенное обновление UI при инкременте в App.tsx (главная/меню). Запись в AsyncStorage только в App — здесь только state, чтобы не было двух писателей и гонок.
  useEffect(() => {
    const off = onMissedIncrement(({ userId }) => {
      if (!userId) return;
      const userIdStr = String(userId);
      setMissedByUser((prev) => {
        const next = { ...prev, [userIdStr]: (prev[userIdStr] || 0) + 1 };
        logger.debug('[HomeScreen] Missed call incremented (UI only, App already persisted)', { userId: userIdStr, count: next[userIdStr] });
        return next;
      });
      syncAppBadgeFromMissedCount().catch(() => {});
    });
    return () => off?.();
  }, []);

  // Сброс счётчика пропущенных при принятии вызова получателем или входе в видеозвонок/чат с другом. Сохраняем в AsyncStorage с await, чтобы сброс не терялся при быстром выходе.
  useEffect(() => {
    const off = onMissedClear(async ({ userId }) => {
      const userIdStr = String(userId);
      if (!userIdStr) return;
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.cancelMissedCallNotificationForUser?.(userIdStr); } catch (_) {}
        try { NativeModules.LiviAppModule?.removePendingMissedCall?.(userIdStr); } catch (_) {}
      }
      try {
        const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
        const map: Record<string, number> = raw ? JSON.parse(raw) : {};
        if (map[userIdStr] === undefined) return;
        delete map[userIdStr];
        await AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(map));
        setMissedByUser((prev) => {
          if (prev[userIdStr] === undefined) return prev;
          const next = { ...prev };
          delete next[userIdStr];
          return next;
        });
        await syncAppBadgeFromMissedCount();
        logger.debug('[HomeScreen] Missed calls cleared for user (emitMissedClear)', { userId: userIdStr });
      } catch (e) {
        logger.warn('[HomeScreen] onMissedClear failed', { userId: userIdStr, error: (e as Error)?.message });
      }
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
            // КРИТИЧНО: Нормализуем ключ (преобразуем в строку) для корректной работы
            const friendIdStr = String(f.id);
            // Используем новую функцию getUnreadCount
            const result = await getUnreadCount(friendIdStr);
            entries[friendIdStr] = result.ok ? (result.count || 0) : 0;
          } catch { 
            // КРИТИЧНО: Нормализуем ключ даже при ошибке
            const friendIdStr = String(f.id);
            entries[friendIdStr] = 0; 
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

    // Слушатель новых сообщений для обновления счетчиков; при новом сообщении сбрасываем «увидел», чтобы на иконке снова показывались все пропущенные
    const offReceived = onMessageReceived((message) => {
      const messageFromStr = String(message.from);
      if (!friends.some(f => String(f.id) === messageFromStr)) return;
      // Пользователь в открытом чате с этим отправителем — не поднимаем локальный счётчик (сервер тоже не кладёт unread при chat:viewing).
      const openChatPeer = String((global as any).__currentChatPeerId || '').trim();
      if (openChatPeer && openChatPeer === messageFromStr) {
        if (!disposed) setUnreadByUser((prev) => ({ ...prev, [messageFromStr]: 0 }));
      } else {
        void updateOne(messageFromStr);
      }
      clearMissedBadgeCleared().then(() => syncAppBadgeFromMissedCount()).catch(() => {});
    });

    // Слушатель подтверждений прочтения
    const offReadReceipt = onMessageReadReceipt(() => {
      scheduleRecalcAll(); // Пересчитываем все счетчики
    });

    // Если отправитель удалил сообщения "для всех", unread тоже должен уменьшиться.
    const offDeleted = onMessageDeleted(() => {
      scheduleRecalcAll();
    });
    const offDeletedBatch = onMessagesDeleted(() => {
      scheduleRecalcAll();
    });

    return () => { 
      disposed = true; 
      offReceived?.(); 
      offReadReceipt?.();
      offDeleted?.();
      offDeletedBatch?.();
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
          showNotice(t('unauthorized', lang) || 'Not authorized', 'error');
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
      // Проверяем подключение к серверу
      if (!(socket as any)?.connected) {
        showNotice(t('noServer', lang), 'error', 3000);
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
          ? t('unauthorized', lang)
          : result.error === 'timeout'
          ? t('timeoutExceeded', lang)
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
  }, [wiping, installId, askConfirm, showNotice, attachIdentitySafe, wipeAccountOnServer, lang, resetAllState]);


  /* ================= UI ================= */

  const onRefreshFriends = async () => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch { Vibration.vibrate(10); }
    setRefreshing(true);
    await loadFriends();
    setRefreshing(false);
  };

  const ChatButton = ({ friend }: { friend: Friend }) => {
    const friendIdStr = String(friend.id);
    const count = unreadByUser[friendIdStr] || 0;

    const handlePress = React.useCallback(() => {
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch {
        Vibration.vibrate(8);
      }

      const fullNickname = (friend.name && friend.name.trim()) || '—';
      logger.info('[ChatButton] Открываем чат', {
        friendId: friend.id,
        friendName: friend.name,
        fullNickname,
        nameLength: friend.name?.length || 0,
      });

      navigation.navigate('Chat', {
        peerId: friend.id,
        peerName: fullNickname,
        peerAvatarVer: friend.avatarVer || 0,
        peerAvatarThumbB64: friend.avatarThumbB64 || '',
        peerOnline: friend.online,
      });
    }, [navigation, friend.id, friend.name, friend.avatarVer, friend.avatarThumbB64, friend.online]);

    return (
      <View style={styles.chatBtnOuter}>
        <View style={styles.friendActionBadgeAnchor}>
          <RectButton
            style={[
              styles.friendActionBtnSize,
              {
                backgroundColor: '#2B2B2B',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.12)',
                justifyContent: 'center',
                alignItems: 'center',
              },
            ]}
            rippleColor="rgba(255,255,255,0.28)"
            underlayColor="rgba(255,255,255,0.14)"
            activeOpacity={0.82}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            delayLongPress={280}
            onPress={handlePress}
            onLongPress={
              count > 0
                ? () => {
                    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch { Vibration.vibrate(15); }
                    setMarkReadMenu({ friendId: friendIdStr, type: 'chat' });
                  }
                : undefined
            }
          >
            <MaterialCommunityIcons name="chat-processing" size={23} color={LIVI.white} />
          </RectButton>
          {count > 0 && (
            <View style={styles.badgeBubble} pointerEvents="none">
              <Text style={styles.badgeBubbleText}>{count > 99 ? '99+' : count}</Text>
            </View>
          )}
        </View>
      </View>
    );
  };
  const renderRightActions = (id: string) => {
    if (swipeActionsHiddenForCall === id) return <View style={styles.swipeRight} />;
    return (
      <View style={styles.swipeRight}>
        <IconButton
          icon="close"
          size={23}
          iconColor="rgb(255,90,103)"
          style={[
            styles.actionBtn,
            styles.friendActionBtnSize,
            {
              marginRight: 6,
              backgroundColor: 'rgba(255,90,103,0.18)',
              borderWidth: 1,
              borderColor: 'rgba(200,50,65,0.7)',
            },
          ]}
          onPress={() => handleRemoveFriend(id)}
        />
      </View>
    );
  };

  const handleRemoveFriend = useCallback(
    async (peerId: string) => {
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
    [showNotice, L],
  );

  type FriendDisplay = {
    displayName: string;
    avatarLetter: string;
    hasAvatar: boolean;
  };

  const getFriendDisplay = (f: Friend) => {
    // Логика отображения:
    // 1. Если нет аватара, но есть никнейм - показываем первую букву в круге аватара, но сам никнейм полностью
    // 2. Если есть аватар, но нет никнейма - вместо никнейма показываем "—"
    // 3. Если есть и аватар и никнейм - показываем и то и то
    // 4. Если нет ни того ни того - показываем "—"
    
    const rawNick = (f.name || '').trim();
    const hasNick = rawNick.length > 0;
    // Проверяем не только версию, но и наличие самой миниатюры
    const hasAvatar = !!(f.avatarVer && f.avatarVer > 0 && f.avatarThumbB64);

    // Имя для текста: полный никнейм, иначе «—»
    // КРИТИЧНО: НЕ используем slice(0, 1) для displayName - это только для avatarLetter
    const displayName = hasNick ? rawNick : '—';

    // Буква для аватара: показываем первую букву только если нет аватара, но есть никнейм
    // Это используется только для fallbackText в AvatarImage, НЕ для текста!
    const avatarLetter = !hasAvatar && hasNick ? rawNick.slice(0, 1).toUpperCase() : '';

    return { displayName, avatarLetter, hasAvatar };
  };

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

  const InviteButton = ({ friend }: { friend: Friend }) => {
    const { displayName } = getFriendDisplay(friend);
    // КРИТИЧНО: Нормализуем ключ (преобразуем в строку) для корректной работы с пропущенными звонками
    const friendIdStr = String(friend.id);
    const missedCount = missedByUser[friendIdStr] || 0;

    // Кнопка видеозвонка показывается всегда; дизейблится и бейдж «Занят» только когда друг занят в видеочате.
    // КРИТИЧНО: Учитываем и глобальные refs из VideoCall, но не доверяем им слепо:
    // при потере call:ended ref мог остаться true уже после падения LiveKit-комнаты.
    const isFriendBusy = friend.isBusy || false; // Флаг от сервера через presence:update (только когда вызов принят и оба в видеосвязи)
    const g = global as any;
    const videoCallActive = g.__videoCallActiveRef?.current;
    const videoCallPartner = g.__videoCallPartnerUserIdRef?.current;
    const session = g.__webrtcSessionRef?.current;
    const sessionNotEnded =
      !!session &&
      (typeof session.isEnded === 'function'
        ? !session.isEnded()
        : session?.room?.state !== 'disconnected');
    const params = g.__currentCallPiPParamsRef?.current;
    const hasAnyCallIds =
      !!params?.callId ||
      !!params?.roomId ||
      (!!session && typeof session.getRoomId === 'function' && !!session.getRoomId()) ||
      (!!session && typeof session.getCallId === 'function' && !!session.getCallId());
    const activeCallInProgress = !!videoCallActive && (sessionNotEnded || hasAnyCallIds);
    const busy = isFriendBusy || (activeCallInProgress && !!videoCallPartner && String(videoCallPartner) === friendIdStr);
    // Исходящий вызов в процессе (инициатор свернул нативный экран в шторку): у того, кому звоним — стиль «занято» без бейджа; у остальных — просто неактивная кнопка
    const outgoingInProgress = calling.visible;
    const isOutgoingToThisFriend = outgoingInProgress && !!calling.friend && String(calling.friend.id) === friendIdStr;
    // Входящий вызов в процессе (нативный экран входящего): у звонящего — стиль «занято» без бейджа; у остальных — неактивная кнопка. На всё время активного звонка все кнопки неактивны.
    const incomingInProgress = incomingCallScreen.visible;
    const isIncomingFromThisFriend = incomingInProgress && incomingCallScreen.fromUserId != null && String(incomingCallScreen.fromUserId) === friendIdStr;
    // Бейдж «Занято» только когда друг реально в звонке (принят вызов). Не показывать: (1) при входящем от этого друга — защита от старого busy и от незадеплоенного бэкенда; (2) при исходящем к этому другу уже учтено (showBusyBadge не использует isOutgoingToThisFriend).
    const showBusyBadge = isFriendBusy && !isIncomingFromThisFriend;
    // Стиль «занято» (серая кнопка) только у участника звонка или при дозвоне. У остальных друзей кнопка как обычно, просто не кликабельна.
    const useBusyButtonStyle = busy || isOutgoingToThisFriend || isIncomingFromThisFriend;
    const videoDisabled = busy || outgoingInProgress || incomingInProgress || activeCallInProgress;
    const pulse = React.useRef(new Animated.Value(0)).current;
    useEffect(() => {
      if (showBusyBadge) {
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
    }, [showBusyBadge, pulse]);

    return (
      <View style={styles.rightWrap}>
        {showBusyBadge && (
          <Animated.View style={[styles.busyBadge, { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1] }) }]}>
            <Text style={styles.busyText}>{t('busy', lang)}</Text>
          </Animated.View>
        )}
        <View
          style={styles.friendActionBadgeAnchor}
          pointerEvents={Platform.OS === 'android' && videoDisabled ? 'none' : 'auto'}
        >
          <RectButton
            enabled={!videoDisabled}
            accessibilityState={{ disabled: !!videoDisabled }}
            style={[
              styles.friendActionBtnSize,
              {
                justifyContent: 'center',
                alignItems: 'center',
              },
              Platform.OS === 'android' && videoDisabled
                ? styles.androidVideoCallBtnDisabled
                : {
                    backgroundColor: '#2B2B2B',
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.12)',
                  },
              useBusyButtonStyle && Platform.OS !== 'android' ? styles.inviteBtnDisabled : null,
            ]}
            rippleColor="rgba(255,255,255,0.28)"
            underlayColor="rgba(255,255,255,0.14)"
            activeOpacity={0.82}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            delayLongPress={280}
            onLongPress={
              missedCount > 0 && !videoDisabled
                ? () => {
                    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch { Vibration.vibrate(15); }
                    setMarkReadMenu({ friendId: friendIdStr, type: 'video' });
                  }
                : undefined
            }
            onPress={() => {
              if (videoDisabled) return;
              try {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              } catch {
                Vibration.vibrate(8);
              }
              const fid = String(friend.id);
              clearMissedCallsForFriend(fid);
              handleStartVideoCall(friend);
            }}
          >
            <MaterialCommunityIcons
              name="video"
              size={23}
              color={
                Platform.OS === 'android' && videoDisabled
                  ? ANDROID_VIDEO_CALL_DISABLED_BG
                  : useBusyButtonStyle
                    ? '#ddd'
                    : LIVI.white
              }
            />
          </RectButton>
          {Platform.OS === 'android' && videoDisabled && (
            <View style={styles.videoIconOverlay}>
              <MaterialIcons name="videocam" size={23} color={ANDROID_VIDEO_CALL_DISABLED_ICON} />
            </View>
          )}
          {missedCount > 0 && (
            <View style={styles.badgeBubble} pointerEvents="none">
              <Text style={styles.badgeBubbleText}>
                {missedCount > 99 ? '99+' : missedCount}
              </Text>
            </View>
          )}
        </View>
      </View>
    );
  };
  

  const FriendsTab = () => (
    <FlatList
      // Первый тап по action-кнопкам (чат/звонок) должен срабатывать даже при открытой клавиатуре.
      keyboardShouldPersistTaps="always"
      showsVerticalScrollIndicator={false}
      overScrollMode="never"
      removeClippedSubviews={false}
      data={friends}
      keyExtractor={(item) => item.id}
      ItemSeparatorComponent={() => <View style={styles.friendSeparator} />}
      refreshing={refreshing}
      onRefresh={onRefreshFriends}
      onScrollBeginDrag={() => setMarkReadMenu(null)}
      renderItem={({ item }) => (
        <Swipeable
          ref={(r) => { if (r) swipeableRefsMap.current[item.id] = r; }}
          onSwipeableOpen={() => { openSwipeableRef.current = swipeableRefsMap.current[item.id] ?? null; }}
          onSwipeableClose={() => { if (openSwipeableRef.current === swipeableRefsMap.current[item.id]) openSwipeableRef.current = null; }}
          renderRightActions={() => renderRightActions(item.id)}
          // Требуем более явный горизонтальный жест, чтобы случайные микросдвиги не "съедали" тапы по кнопкам.
          dragOffsetFromRightEdge={56}
          dragOffsetFromLeftEdge={56}
          overshootRight={false}
        >
          <View
            style={styles.listRowWrap}
            ref={markReadMenu?.friendId === item.id ? rowRefForMarkReadMenu : undefined}
          >
            <List.Item
              style={[styles.listRow, styles.listRowAligned, styles.listRowOverflowVisible]}
              containerStyle={styles.listRowContainerOverflowVisible}
              contentStyle={{ marginLeft: 0 }}
              rippleColor="transparent"
              left={() => {
              const { avatarLetter } = getFriendDisplay(item);
              const isMenuRow = markReadMenu?.friendId === item.id;
              return (
                <View
                  style={styles.avatarBox}
                  ref={isMenuRow ? avatarRefForMarkReadMenu : undefined}
                  onLayout={isMenuRow ? measureAvatarForOverlay : undefined}
                >
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
              const hidden = markReadMenu?.friendId === item.id;
              return (
                <View style={[styles.nameCol, hidden && { opacity: 0 }]}>
                  <Text style={styles.friendName}>{displayName}</Text>
                  <Text style={[styles.friendStatus, { color: item.online ? LIVI.green : LIVI.red }]}>
                    {item.online ? L('online') : L('offline')}
                  </Text>
                </View>
              );
            }}            
            right={() => {
              const hidden = markReadMenu?.friendId === item.id;
              return (
                <View style={[styles.rowRightActions, hidden && { opacity: 0 }]}>
                  <InviteButton friend={item} />
                  <ChatButton friend={item} />
                </View>
              );
            }}
          />
            {markReadMenu && markReadMenu.friendId === item.id && (
              <View
                style={[
                  styles.markReadMenuOverlay,
                  { left: markReadOverlayLeft ?? (Platform.OS === 'ios' ? 52 + GAP_AFTER_AVATAR : 44 + GAP_AFTER_AVATAR) },
                ]}
                pointerEvents="box-none"
              >
                <View style={styles.markReadMenuStripGap}>
                  <Animated.View style={[styles.markReadMenuStrip, { width: menuStripWidth }]} collapsable={false}>
                  <View style={styles.markReadMenuStripInner} pointerEvents="box-none">
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="tail"
                      style={styles.markReadMenuStripText}
                      allowFontScaling={false}
                    >
                      {markReadMenu.type === 'video' ? t('markAsViewed', lang) : t('markAsRead', lang)}
                    </Text>
                    <TouchableOpacity
                      style={styles.markReadMenuBtn}
                      activeOpacity={0.8}
                      onPress={() => {
                        const { friendId, type } = markReadMenu;
                        setMarkReadMenu(null);
                        if (type === 'video') {
                          clearMissedCallsForFriend(friendId);
                        } else {
                          markMessagesAsRead(friendId).then((r) => {
                            setUnreadByUser((prev) => ({ ...prev, [friendId]: 0 }));
                            if (r?.ok) {
                              dismissMessageNotificationForUser(friendId).catch(() => {});
                              syncAppBadgeFromMissedCount().catch(() => {});
                            }
                          }).catch(() => {});
                        }
                      }}
                    >
                      <Ionicons name="checkmark" size={18} color={LIVI.white} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.markReadMenuBtn}
                      activeOpacity={0.8}
                      onPress={() => setMarkReadMenu(null)}
                    >
                      <MaterialIcons name="close" size={18} color={LIVI.text2} />
                    </TouchableOpacity>
                  </View>
                </Animated.View>
                </View>
              </View>
            )}
          </View>
        </Swipeable>
      )}
      contentContainerStyle={{ paddingBottom: 24, paddingHorizontal: 16 }}
      ListEmptyComponent={initialized ? (<View style={{ padding: 16 }}><Text style={{ color: LIVI.text2 }}>👤 {L('friendsEmpty')}</Text></View>) : null}
    />
  );

  const MoreTab = () => (
    <View style={{ paddingTop: 8, paddingLeft: 8, paddingRight: 16, paddingBottom: 16, gap: 16, flex: 1 }}>


      {/* UI Settings */}
      <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', borderColor: LIVI.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12 }}>
        <Text style={{ color: LIVI.white, fontWeight: '700', marginBottom: 8 }}>{t('uiSettings', lang)}</Text>

        {/* Theme selector */}
        <Text style={{ color: LIVI.text2, fontSize: 14, fontWeight: '500', marginBottom: 8 }}>{t('appTheme', lang)}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          {([
            { key: 'auto', label: t('themeAuto', lang) },
            { key: 'light', label: t('themeLight', lang) },
            { key: 'dark', label: t('themeDark', lang) },
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

      {/* Donate — сплошная рамка одной толщины со всех сторон, адаптивно */}
      <TouchableOpacity 
        activeOpacity={0.85}
        onPress={async () => {
          await incrCounter('support_help_clicks');
          setDonateVisible(true);
        }}
        style={{ 
          borderRadius: 12, 
          borderWidth: 1,
          borderColor: LIVI.accent,
        }}
      >
        <View style={{ 
          backgroundColor: 'rgba(255,255,255,0.03)', 
          borderRadius: 11, 
          padding: 14,
          flexDirection: 'row',
          alignItems: 'center'
        }}>
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
              {t('supportProjectTitle', lang)}
            </Text>
            <Text style={{ color: LIVI.text2, fontSize: 13, lineHeight: 17 }}>
              {t('supportProjectSubtitle', lang)}
            </Text>
          </View>
        </View>
      </TouchableOpacity>

      {/* Invite Friends — сплошная рамка одной толщины со всех сторон, адаптивно */}
      <TouchableOpacity 
        activeOpacity={0.85}
        onPress={generateInviteLink}
        style={{ 
          borderRadius: 11, 
          borderWidth: 1,
          borderColor: '#4DD0E1',
        }}
      >
        <View style={{ 
          backgroundColor: 'rgba(255,255,255,0.03)', 
          borderRadius: 10, 
          padding: 14,
          flexDirection: 'row',
          alignItems: 'center'
        }}>
          <View style={{ 
            width: 44, 
            height: 44, 
            borderRadius: 22, 
            backgroundColor: '#4DD0E1', 
            justifyContent: 'center', 
            alignItems: 'center',
            marginRight: 14,
            flexShrink: 0
          }}>
            <Ionicons name="share-outline" size={22} color={LIVI.white} />
          </View>
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <Text style={{ color: '#4DD0E1', fontSize: 16, fontWeight: '700', marginBottom: 3, lineHeight: 20 }}>
              {t('inviteFriendsTitle', lang)}
            </Text>
            <Text style={{ color: LIVI.text2, fontSize: 13, lineHeight: 17 }}>
              {t('inviteFriendsSubtitle', lang)}
            </Text>
          </View>
        </View>
      </TouchableOpacity>

      {/* Кнопка «Обновить»: компактная, чтобы за неё ничего не вылезало */}
      {updateAvailable && (
        <View style={{ marginTop: 'auto', marginBottom: 56, alignItems: 'center', alignSelf: 'stretch' }}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => {
              markUpdateBadgeShown();
              Linking.openURL(PLAY_STORE_UPDATE_URL);
            }}
            style={{
              backgroundColor: 'transparent',
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: isDark ? '#5A5F69' : '#2E3643',
              borderRadius: 20,
              paddingVertical: 6,
              paddingHorizontal: 12,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
              minWidth: 100,
            }}
          >
            <Animated.View style={{ transform: [{ scaleX: -1 }, { rotate: updateSpinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-360deg'] }) }] }}>
              <ExpoImage source={require('../assets/icon-update.png')} style={{ width: 16, height: 16 }} contentFit="contain" />
            </Animated.View>
            <Text style={{ color: LIVI.text2, fontSize: 13, fontWeight: '300' }}>{L('updateBtn')}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );

  // КРИТИЧНО: нельзя объявлять компонент внутри HomeScreen и рендерить как <CenterTopProfile />,
  // иначе при любом setState будет создаваться новый тип компонента -> ремоунт -> мерцание аватара.
  const renderCenterTopProfile = () => {
    const letter = displayAvatarLetter(savedNick);
    const wrapperStyle: StyleProp<ViewStyle> = {
      alignItems: "center",
      marginTop: Platform.OS === "android" ? 20 : (12 + 20), // чуть ниже на Android (аватар + ник)
      // При максимальном «масштабе экрана» ширина в dp мала — сильный отрицательный отступ даёт наложение на приветствие
      marginBottom: layoutWidth < 400 ? -40 : -65,
    };

    // Используем новую систему кеширования или локальный файл для превью
    const isLocalPreview = avatarUri && /^(file|content|ph|assets-library):\/\//i.test(avatarUri);
    const hasDirectAvatarUri =
      avatarUri &&
      (/^data:image\//i.test(avatarUri) || /^https?:\/\//i.test(avatarUri));
    const myUserId = getCurrentUserId();
    const hasCachedAvatar = !!(myUserId && myAvatarVer > 0);
    const noAvatar = !isLocalPreview && !hasCachedAvatar && !hasDirectAvatarUri;
    const noNick = !(savedNick && String(savedNick).trim());

    return (
      <View style={wrapperStyle}>
        <Pressable onPress={() => { setModalAvatarUri(myFullAvatarUri || avatarUri || ''); setAvatarModalVisible(true); }} style={{ alignSelf: 'center' }}>
          <View style={[styles.centerAvatarWrap, { backgroundColor: MENU_CHROME_BG }]}>
            {isLocalPreview ? (
            // Локальное превью (до загрузки); на Android data: уже разрешён в file: через resolvedAvatarUri
            (<ExpoImage
              source={{ uri: resolvedAvatarUri || avatarUri }}
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
          ) : hasDirectAvatarUri && resolvedAvatarReady ? (
            // Прямой URI (data:image или https); на Android data: разрешён в file: — Glide не падает
            (<ExpoImage
              source={{ uri: resolvedAvatarUri }}
              style={styles.centerAvatarImg}
              cachePolicy={/^https?:\/\//i.test(avatarUri) ? 'memory-disk' : 'none'}
            />)
          ) : hasDirectAvatarUri ? (
            // Пока разрешаем data: -> file: на Android (плейсхолдер)
            avatarVerChecked ? (
              <View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]}>
                <Text style={{ color: LIVI.titan, fontSize: 48, fontWeight: '500' }}>{letter}</Text>
              </View>
            ) : (
              <View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]} />
            )
          ) : avatarVerChecked ? (
            // Плейсхолдер с буквой (после первой проверки кэша)
            (<View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]}>
              <Text style={{ color: LIVI.titan, fontSize: 48, fontWeight: '500' }}>{letter}</Text>
            </View>)
          ) : (
            // До первой проверки кэша — нейтральный круг (убирает мелькание буквы при переходе на Home после звонка)
            (<View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]} />)
          )}
          </View>
        </Pressable>
        <Text
          style={[
            styles.subtitleNik,
            {
              marginTop: 12,
              fontSize: Platform.OS === "ios" ? 25 : 20,
              // Когда показываем "—" (ник пустой) или нет аватара — цвет должен совпадать с плейсхолдером в аватаре.
              color: (noNick || noAvatar) ? LIVI.titan : (isDark ? LIVI.text2 : LIVI.textThemeWhite),
            },
          ]}
        >
          {displayName(savedNick)}
        </Text>
      </View>
    );
  };

  // Показ уведомления «Звонок завершён» / «Вызов отменен», авто-открытие меню друзей, переход на вкладку «Друзья».
  // При переходе по тапу summary-уведомлений (пропущенные / непрочитанные) — снимаем уведомления из шторки и бейдж.
  useEffect(() => {
    const ended = (route as any)?.params?.callEnded;
    const cancelled = (route as any)?.params?.callCancelled;
    const openFriendsMenu = (route as any)?.params?.openFriendsMenu;
    const openFriendsTab = (route as any)?.params?.openFriendsTab;
    if (ended) {
      suppressUpdateBadgeForCallNotice();
      showNotice(t('callEnded', lang), 'success', 3000);
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
      // Сразу снимаем уведомления из шторки (дублируем нативный dismiss на случай, если интент не дошёл)
      dismissMissedCallNotificationsOnly().catch(() => {});
      dismissMessageNotificationsOnly().catch(() => {});
      setMissedBadgeCleared()
        .then(() => syncAppBadgeFromMissedCount())
        .catch(() => {});
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
          setMissedByUser((prev) => ({ ...prev, ...normalized }));
        } catch {}
      }).catch(() => {});
    }
    if (ended || cancelled || openFriendsMenu || openFriendsTab) {
      try {
        navigation.setParams?.({
          callEnded: undefined,
          callCancelled: undefined,
          openFriendsMenu: undefined,
          openFriendsTab: undefined,
        });
      } catch {}
    }
  }, [route, navigation, showNotice, suppressUpdateBadgeForCallNotice]);

  // Отмена входящего, когда пользователь уже на Home: бейдж «Вызов отменён» на 3 сек через событие, без setParams — без лишних ре-рендеров
  useEffect(() => {
    const off = onCallCancelledOnHome(() => {
      suppressUpdateBadgeForCallNotice();
      showNotice(t('callCancelled', lang), 'error', 3000);
    });
    return off;
  }, [showNotice, lang, suppressUpdateBadgeForCallNotice]);

  // Завершение звонка (закрытие экрана через goBack): тост «Звонок завершён» при фокусе на Home, без setParams — без лишних ре-рендеров
  useEffect(() => {
    const off = onCallEndedOnHome(() => {
      suppressUpdateBadgeForCallNotice();
      showNotice(t('callEnded', lang), 'success', 3000);
    });
    return off;
  }, [showNotice, lang, suppressUpdateBadgeForCallNotice]);

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
    incomingCallScreen.visible;
  const handleBlockedStartSearchPress = useCallback(() => {
    setShowCallSearchLockBadge(true);
  }, []);
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
        barStyle={menuOpen || isDark ? 'light-content' : 'dark-content'}
        translucent={Platform.OS === 'android'}
        backgroundColor={Platform.OS === 'android' ? 'transparent' : undefined}
      />

      <View style={[styles.topBar, { backgroundColor: 'transparent' }] }>
        <Text style={[styles.brand, { color: isDark ? LIVI.text : LIVI.textThemeWhite }]}>
          LiVi
        </Text>

        <View style={{ position: 'relative', flexShrink: 0 }}>
          {/* Рамка через обёртку: одинаковая толщина на прямых и скруглениях (borderWidth на скруглениях рендерится тоньше) */}
          <View
            style={[
              styles.menuBtnOuter,
              { backgroundColor: isDark ? LIVI.text : LIVI.textThemeWhite },
            ]}
          >
            <Pressable
              style={({ pressed }) => [
                styles.menuBtnInner,
                { backgroundColor: MENU_BTN_INNER_BG, position: 'relative' },
                Platform.OS === 'ios' && pressed && styles.menuBtnPressed,
              ]}
              onPress={() => setMenuOpen(true)}
              android_ripple={{
                color: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.12)',
                borderless: false,
              }}
            >
              <BlurView
                intensity={isDark ? 15 : 20}
                tint={isDark ? 'dark' : 'light'}
                style={[StyleSheet.absoluteFillObject, { borderRadius: 13 }]}
              />
              <View
                style={[
                  StyleSheet.absoluteFillObject,
                  {
                    borderRadius: 13,
                    backgroundColor: isDark ? '#8A8F99' : '#3B4453',
                    opacity: isDark ? 0.25 : 0.14,
                  },
                ]}
              />
              <View style={styles.menuBtnIconWrap}>
                <Icon
                  source="menu"
                  size={Platform.OS === "ios" ? 28 : 24}
                  color={isDark ? LIVI.text : LIVI.textThemeWhite}
                />
              </View>
            </Pressable>
          </View>
          {(() => {
            // КРИТИЧНО: Проверяем наличие непрочитанных сообщений или пропущенных видеозвонков
            // Фильтруем только значения > 0, игнорируем нулевые и отрицательные
            const unreadValues = Object.values(unreadByUser).filter((n) => typeof n === 'number' && n > 0);
            const missedValues = Object.values(missedByUser).filter((n) => typeof n === 'number' && n > 0);
            const hasUnread = unreadValues.length > 0;
            const hasMissed = missedValues.length > 0;
            const shouldShow = hasUnread || hasMissed;
            
            // Логируем только если есть проблема (показываем когда не должно или наоборот)
            if (shouldShow) {
              logger.debug('[HomeScreen] Showing menu dot notification', { 
                hasUnread, 
                hasMissed, 
                unreadCount: unreadValues.length,
                missedCount: missedValues.length,
                totalMissedKeys: Object.keys(missedByUser).length,
                missedByUser 
              });
            }
            return shouldShow ? <View style={styles.menuDot} /> : null;
          })()}
        </View>
      </View>

      {renderCenterTopProfile()}

      <View style={[styles.welcomeBlock, Platform.OS === 'android' && { marginTop: 50 }]}>
        <View style={styles.welcomeTextBlock}>
          <Text
            style={[styles.title, { color: isDark ? LIVI.text : LIVI.textThemeWhite }]}
            allowFontScaling={false}
            maxFontSizeMultiplier={1}
            numberOfLines={2}
            adjustsFontSizeToFit
            minimumFontScale={0.55}
          >
            {L('welcomeTitle')}
          </Text>
          <View
            style={{
              width: Math.max(0, layoutWidth - 36),
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
                },
              ]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.18}
              allowFontScaling={false}
            >
              {L('welcomeSubtitle')}
            </Text>
          </View>
        </View>
        <View style={styles.noticeSlot}>
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
          {/* Бейдж «Обновить»: тот же слот, что и «Вызов отменён» — между подзаголовком и «Начать поиск», автоскрытие, тап — магазин */}
          {showUpdateBadge && (
            <View
              style={{
                padding: isDark ? 0.2 : 0.4,
                borderRadius: 14,
                position: 'relative',
                overflow: 'hidden',
                alignSelf: 'center',
                maxWidth: Math.min(320, layoutWidth - 40),
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
                style={[StyleSheet.absoluteFillObject, { borderRadius: 14 }]}
              />
              <View
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: isDark ? 0.2 : 0.4,
                  borderTopLeftRadius: 14,
                  borderTopRightRadius: 14,
                  overflow: 'hidden',
                  zIndex: 2,
                }}
              >
                <LinearGradient
                  colors={
                    isDark
                      ? ['#2dd4bf', '#38bdf8', '#FFF8F0', '#60a5fa']
                      : ['#8B82C8', '#7468B0', '#9A92A8', '#A09AAE']
                  }
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={[StyleSheet.absoluteFillObject, { borderTopLeftRadius: 14, borderTopRightRadius: 14 }]}
                />
              </View>
              <View
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: isDark ? 0.2 : 0.4,
                  borderBottomLeftRadius: 14,
                  borderBottomRightRadius: 14,
                  overflow: 'hidden',
                  zIndex: 2,
                }}
              >
                <LinearGradient
                  colors={
                    isDark
                      ? ['#60a5fa', '#38bdf8', '#2dd4bf', '#F0EEEC']
                      : ['#B0A8C4', '#A39BB8', '#8B82C8', '#8B82C8']
                  }
                  start={{ x: 1, y: 0 }}
                  end={{ x: 0, y: 0 }}
                  style={[StyleSheet.absoluteFillObject, { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 }]}
                />
              </View>
              <Pressable
                style={({ pressed }) => [
                  {
                    margin: isDark ? 0.2 : 0.4,
                    borderRadius: isDark ? 13.8 : 13.6,
                    alignItems: 'center',
                    justifyContent: 'center',
                    alignSelf: 'stretch',
                    backgroundColor: theme.colors.background,
                    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
                    paddingHorizontal: 20,
                    zIndex: 1,
                  },
                  pressed && { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' },
                ]}
                onPress={() => {
                  setShowUpdateBadgeState(false);
                  markUpdateBadgeShown();
                  Linking.openURL(PLAY_STORE_UPDATE_URL);
                }}
                android_ripple={{ color: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)', borderless: false }}
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
        <AnimatedBorderButton
          isDark={isDark}
          onPress={() => navigation.navigate("RandomChat", { returnTo: { name: 'Home' } })}
          label={L("startSearchBtn")}
          style={{ marginBottom: 40 }}
          backgroundColor={theme.colors.background as string}
          disabled={hasActiveCallForSearch}
          onDisabledPress={handleBlockedStartSearchPress}
        />
      </View>

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

      {/* Оверлей меню всегда в дереве (opacity 0 когда закрыт), чтобы в релизе не было задержки ~2 сек при первом открытии из-за тяжёлого маунта BlurView/контента. */}
      <Animated.View
        style={[styles.overlayMenu, { opacity: menuOverlayOpacity }]}
        pointerEvents={menuOpen ? 'box-none' : 'none'}
      >
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          <BlurView intensity={Platform.OS === 'ios' ? 80 : 60} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: Platform.OS === 'ios' ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.6)' }]} />
        </View>
        <SafeAreaView
          style={[styles.sheetFull]}
          edges={Platform.OS === 'android' ? ['top', 'bottom', 'left', 'right'] : undefined}
        >
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.sheetTopBar}>
              <TouchableOpacity
                onPress={() => {
                  try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch { Vibration.vibrate(10); }
                  closeMenu();
                }}
                activeOpacity={0.5}
                style={{
                  width: Platform.OS === 'ios' ? 40 : 38,
                  height: Platform.OS === 'ios' ? 40 : 38,
                  borderRadius: Platform.OS === 'ios' ? 16 : 14,
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  borderWidth: 1,
                  borderColor: 'rgba(255,255,255,0.12)',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginLeft: 5,
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
                    width: Platform.OS === 'ios' ? 40 : 38,
                    height: Platform.OS === 'ios' ? 40 : 38,
                    borderRadius: Platform.OS === 'ios' ? 16 : 14,
                    backgroundColor: 'rgba(255,90,103,0.1)',
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.12)',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 5,
                    opacity: wiping ? 0.7 : 1,
                  }}
                >
                  <Ionicons name="trash" size={Platform.OS === 'ios' ? 20 : 18} color="rgba(255,90,103,0.6)" />
                </TouchableOpacity>
              )}
              {!(tab === 'settings' && handleWipeAccount) && <View style={{ width: Platform.OS === 'ios' ? 40 : 38 }} />}
            </View>

            <View style={styles.segmentCapsule}>
              {renderSegBtn('friends', L('tabFriends'), 'account-multiple', 'left')}
              <View style={styles.segDivider} />
              {renderSegBtn('settings', L('tabSettings'), 'account-edit', 'mid')}
              <View style={styles.segDivider} />
              {renderMoreSegBtn()}
            </View>

            <Divider style={{ backgroundColor: LIVI.border, marginTop: 12 }} />

            <View style={{ flex: 1 }}>
              {tab === 'friends' && FriendsTab()}
              {tab === 'settings' && (
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
                />
              )}
              {tab === 'more' && MoreTab()}
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Animated.View>

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
      {/* ───── Исходящий видеозвонок: нативный экран при CallKeep, иначе модалка в приложении ───── */}
      {calling.visible && !isCallKeepAvailable() && (
        <View style={styles.overlayModal} pointerEvents="box-none">
          <BlurView intensity={Platform.OS === 'android' ? 100 : 85} tint="dark" style={StyleSheet.absoluteFill} />
          <View
            style={[
              StyleSheet.absoluteFill,
              // Android: сильнее затемняем задний фон
              { backgroundColor: Platform.OS === 'android' ? 'rgba(0,0,0,1)' : 'rgba(0,0,0,0.35)' },
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
            <Text style={{ color: LIVI.white, fontSize: 16, fontWeight: '700', marginTop: 12 }}>
              {t('callingYouCall', lang).replace('{name}', displayName(calling.friend?.name))}
            </Text>
            <Text style={{ color: LIVI.text2, marginTop: 6 }}>{t('callingWaiting', lang)}</Text>
            <View style={{ alignItems: 'center', marginTop: 300 }}>
              <TouchableOpacity
                onPress={handleCancelCall}
                activeOpacity={0.6}
                style={{
                  width: 76,
                  height: 76,
                  borderRadius: 38,
                  backgroundColor: 'rgba(255,90,103,0.25)',
                  borderWidth: 2,
                  borderColor: 'rgba(255,90,103,0.5)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <MaterialIcons name="call-end" size={28} color="#fff" />
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
              onPress={() => {
                try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch { Vibration.vibrate(10); }
                setDonateVisible(false);
              }}
              activeOpacity={0.5}
              style={{
                position: 'absolute',
                top: insets.top + (Platform.OS === "android" ? 35 : 16),
                left: Platform.OS === 'ios' ? 15 : 17,
                width: Platform.OS === 'ios' ? 40 : 38,
                height: Platform.OS === 'ios' ? 40 : 38,
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
              <Text style={[styles.confirmTitle, { textAlign: 'center', marginBottom: 20, color: '#B8A9E8' }]}>{t('supportProjectTitle', lang)}</Text>
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
            <TouchableOpacity
              onPress={() => {
                try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch { Vibration.vibrate(10); }
                setShareVisible(false);
              }}
              activeOpacity={0.5}
              style={{
                position: 'absolute',
                top: insets.top + (Platform.OS === "android" ? 35 : 16),
                left: Platform.OS === 'ios' ? 15 : 17,
                width: Platform.OS === 'ios' ? 40 : 38,
                height: Platform.OS === 'ios' ? 40 : 38,
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
            <Surface style={[styles.confirmCard, { minWidth: 300, maxWidth: 400, borderColor: '#4DD0E1' }]}>
              <Text style={[styles.confirmTitle, { textAlign: 'center', marginBottom: 20, color: '#4DD0E1' }]}>
                {t('inviteFriendTitle', lang)}
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
                  padding: 12,
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
                      padding: 8,
                      borderRadius: 8,
                      backgroundColor: 'rgba(77,208,225,0.15)'
                    }}
                  >
                    <Ionicons name="copy-outline" size={20} color="#4DD0E1" />
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
                    backgroundColor: '#4DD0E1',
                    borderColor: '#4DD0E1',
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
                  <Ionicons name="share-outline" size={20} color={LIVI.white} />
                  <Text style={{ 
                    color: LIVI.white, 
                    fontWeight: '700', 
                    fontSize: 16 
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
            <TouchableOpacity
              onPress={handleDeclineInvite}
              activeOpacity={0.85}
              style={{
                position: 'absolute',
                top: insets.top + (Platform.OS === "android" ? 35 : 16),
                left: Platform.OS === 'ios' ? 15 : 17,
                width: Platform.OS === 'ios' ? 40 : 38,
                height: Platform.OS === 'ios' ? 40 : 38,
                borderRadius: Platform.OS === 'ios' ? 16 : 14,
                backgroundColor: 'rgba(255,255,255,0.06)',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.12)',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 10
              }}
            >
              <Ionicons name="close" size={Platform.OS === 'ios' ? 22 : 20} color={LIVI.titan} />
            </TouchableOpacity>
            <Surface style={[styles.confirmCard, { minWidth: 300, maxWidth: 400, borderColor: '#4DD0E1' }]}>
              <Text style={[styles.confirmTitle, { textAlign: 'center', marginBottom: 20, color: '#4DD0E1' }]}>
                {t('friendInviteTitle', lang)}
              </Text>
              
              {inviteRequestData.areFriends ? (
                <View style={{ marginBottom: 20 }}>
                  <Text style={{ color: LIVI.text2, fontSize: 14, textAlign: 'center', marginBottom: 12 }}>
                    {t('alreadyFriendsWithUser', lang).replace('{user}', inviteRequestData.inviter.nick || t('thisUser', lang))}
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
                        fallbackText={inviteRequestData.inviter.nick?.[0]?.toUpperCase() || '?'}
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
                          {inviteRequestData.inviter.nick?.[0]?.toUpperCase() || '?'}
                        </Text>
                      </View>
                    )}
                    <Text style={{ color: LIVI.white, fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' }}>
                      {inviteRequestData.inviter.nick || t('user', lang)}
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
                        Принять
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

  /* Кнопка «Ещё»: индикатор обновления — картинка img-update.png (красный круг со стрелкой) */
  function renderMoreSegBtn() {
    const active = tab === 'more';
    const label = L('tabMore');
    return (
      <TouchableOpacity key="more" activeOpacity={0.9} onPress={() => setTab('more')} style={[styles.segItem, styles.segRight, { position: 'relative' }]}>
        {active && <View style={[StyleSheet.absoluteFill, styles.segActiveBg]} />}
        {active && <View style={styles.segTopShadow} />}
        {updateAvailable && (
          <View style={{ position: 'absolute', right: 7, top: 2, bottom: 0, justifyContent: 'center', width: 22, alignItems: 'center', zIndex: 1, transform: [{ scaleX: -1 }] }} pointerEvents="none">
            <ExpoImage
              source={require('../assets/icon-update.png')}
              style={{ width: 14, height: 14 }}
              contentFit="contain"
            />
          </View>
        )}
        <View style={[styles.segContent, { marginLeft: -18 }]}>
          <List.Icon icon="dots-horizontal" color={LIVI.white} style={{ margin: 0, marginRight: 8 }} />
          <Text style={styles.segLabel}>{label}</Text>
        </View>
      </TouchableOpacity>
    );
  }

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
  container: { flex: 1, backgroundColor: LIVI.bg, paddingHorizontal: 14, paddingBottom: 10, justifyContent: 'center' },
  topBar: { height: 100, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',   paddingHorizontal: Platform.OS === "android" ? 0 : 10, },
  brand: { color: LIVI.text, fontSize: 41, lineHeight: 40, fontWeight: '600', letterSpacing: 0.3 },
  menuBtn: { backgroundColor: LIVI.glass, borderRadius: 14 },
  menuBtnOuter: { borderRadius: 14, padding: 1, alignSelf: 'flex-start', overflow: 'hidden' },
  menuBtnInner: { borderRadius: 13, overflow: 'hidden', minWidth: 40, minHeight: 40, justifyContent: 'center', alignItems: 'center' },
  menuBtnPressed: { opacity: 0.75 },
  menuBtnIconWrap: { margin: 0, backgroundColor: 'transparent', justifyContent: 'center', alignItems: 'center' },
  menuBtnIcon: { margin: 0, backgroundColor: 'transparent' },
  // Симметричные отступы: левый край -> аватар = правый край -> иконка чата.
  // Горизонтальные отступы задаются contentContainerStyle у FlatList (paddingHorizontal: 16),
  // поэтому не добавляем дополнительный paddingRight на уровне строки.
  listRowWrap: { position: 'relative', overflow: 'visible' as const },
  listRow: { backgroundColor: 'transparent', paddingVertical: 10, paddingRight: 0 },
  listRowAligned: { alignItems: 'center', paddingLeft: 0, paddingRight: 0, minHeight: 72 },
  /** Чтобы бейджи на углу кнопок (translate 50%/-50%) не обрезались TouchableRipple / строкой */
  listRowOverflowVisible: { overflow: 'visible' as const },
  listRowContainerOverflowVisible: { overflow: 'visible' as const },
  nameCol: { marginLeft: 0, justifyContent: 'center' },
  friendName: {
    color: LIVI.white,
    fontWeight: '700',
    fontSize: Platform.OS === "android" ? 16 : 20,
    lineHeight: Platform.OS === "android" ? 18 : 30,
  },
  friendStatus: {
    marginTop: 2,
    fontSize: Platform.OS === "android" ? 11 : 13,
    fontWeight: '300',
    ...(Platform.OS === 'android' && { fontFamily: 'sans-serif-light' }),
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
  title: {
    color: LIVI.text,
    fontSize: Platform.OS === "android" ? 26 : 28,
    fontWeight: '700',
    letterSpacing: 0.3,
    textAlign: 'center',
    lineHeight: Platform.OS === 'android' ? 30 : 32,
    maxWidth: '100%',
  },
  // Без фиксированного lineHeight: на Android иначе adjustsFontSizeToFit часто не сжимает шрифт и обрезает хвост строки.
  subtitle: {
    color: LIVI.text2,
    fontSize: Platform.OS === 'android' ? 14 : 16,
    textAlign: 'center',
    marginTop: 2,
  },
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

  // IMPORTANT: do NOT use fixed screenWidth/screenHeight here.
  overlayMenu: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent', zIndex: 999 },
  overlayModal: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent', zIndex: 999, alignItems: 'center', justifyContent: 'center' },

  sheetFull: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Platform.OS === "android"
      ? "#0D0E10"
      : "rgba(13,14,16,0.88)",
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

  rowRightActions: { height: 48, flexDirection: 'row', alignItems: 'center', paddingRight: 6, overflow: 'visible' as const },
  friendSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.10)',
    marginLeft: 4,
    marginRight: 4,
  },

  actionBtn: { backgroundColor: LIVI.glass, borderRadius: 12 },
  friendActionBtnSize: { width: 40, height: 40, borderRadius: 12 },
  /** Отступ между видео и чатом — снаружи якоря 40×40, чтобы бейдж считался от угла кнопки */
  chatBtnOuter: { marginLeft: 14 },
  friendActionBadgeAnchor: {
    width: 40,
    height: 40,
    position: 'relative' as const,
    overflow: 'visible' as const,
  },

  segmentBottomArc: { position: 'absolute', left: 18, right: 18, bottom: 0, height: 44, borderRadius: 114, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: LIVI.border },

  menuDot: { position: 'absolute', top: 0, right: 0, width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,90,103,0.95)' },

  // Центр круга на вершине правого верхнего угла кнопки (половина снаружи кнопки) — как в макете.
  badgeBubble: {
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 20,
    minWidth: 11,
    minHeight: 11,
    height: 11,
    paddingHorizontal: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(255,90,103,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'android' ? { elevation: 10 } : {}),
    transform: [{ translateX: 4.5 }, { translateY: -3.5 }],
  },
  badgeBubbleText: { color: '#fff', fontSize: 8, fontWeight: '800', lineHeight: 8 },

  // left задаётся инлайн по measureLayout аватара + GAP_AFTER_AVATAR, чтобы отступ был одинаков на всех устройствах
  markReadMenuOverlay: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 3,
    justifyContent: 'center',
    alignItems: 'flex-end',
    zIndex: 10,
  },
  markReadMenuStripGap: {
    marginLeft: 0,
    alignSelf: 'flex-end',
  },
  markReadMenuStrip: {
    overflow: 'hidden',
    height: 40,
    borderRadius: 50,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LIVI.border,
    backgroundColor: LIVI.glass,
    justifyContent: 'center',
    alignSelf: 'flex-end',
  },
  markReadMenuStripInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 15,
    height: 48,
    minWidth: 260,
  },
  markReadMenuStripText: {
    flex: 1,
    color: LIVI.white,
    fontSize: 12,
    fontWeight: '400',
    marginRight: 16,
  },
  markReadMenuBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LIVI.border,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 14,
  },

  rightWrap: { width: 80, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', overflow: 'visible' as const },
  inviteBtn: { backgroundColor: LIVI.glass, borderRadius: 12 },
  inviteBtnDisabled: { 
    backgroundColor: LIVI.glass,
    opacity: 0.5,
  },
  androidVideoCallBtnDisabled: {
    backgroundColor: ANDROID_VIDEO_CALL_DISABLED_BG,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  videoIconOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    pointerEvents: 'none',
  },
  busyBadge: {
    backgroundColor: 'rgba(255,90,103,0.25)',
    borderRadius: 8,
    paddingVertical: 2,
    paddingHorizontal: 6,
    marginRight: 12,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,90,103,0.6)',
  },
  busyText: {
    color: '#FF5A67',
    fontWeight: '400',
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

  // Блок приветствия: заголовок по центру (как раньше), слот для бейджа между подзаголовком и кнопкой, кнопка «Начать поиск»
  welcomeBlock: { flex: 1, alignItems: 'center' },
  welcomeTextBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: 35,
    minHeight: 0,
    width: '100%',
    paddingHorizontal: 4,
  },
  noticeSlot: {
    minHeight: 72,
    justifyContent: 'flex-start',
    alignItems: 'center',
    width: '100%',
    marginBottom: 24,
    gap: 10,
  },
  // notice (бейдж «Вызов завершён» и др.): по центру между подзаголовком и кнопкой
  notice: {
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    width: '82%',
    alignSelf: 'center',
  },
  noticeText: { color: LIVI.text2, fontSize: 13, fontWeight: '500', textAlign: 'center' },

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
