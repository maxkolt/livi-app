// screens/ChatScreen.tsx
import React, { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Platform,
  Alert,
  ActionSheetIOS,
  FlatList,
  KeyboardAvoidingView,
  Keyboard,
  Modal,
  Pressable,
  Animated,
  PanResponder,
  Vibration,
  NativeModules,
  Dimensions,
  Image,
  StyleSheet,
} from "react-native";
 
import { useSafeAreaInsets, SafeAreaView } from "react-native-safe-area-context";
import { onCloseIncoming, emitCloseIncoming } from '../utils/globalEvents';
import socket from '../sockets/socket';
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../theme/ThemeProvider";
import { Image as ExpoImage } from "expo-image";
import AvatarImage from "../components/AvatarImage";
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { Audio } from 'expo-av';
import { getFull, putFull, putThumb } from '../utils/avatarCache';
 
import { API_BASE, getMyProfile } from '../sockets/socket';
import { logger } from '../utils/logger';
import { toAvatarThumb } from '../utils/uploadAvatar';
import { onFriendProfile, onPresenceUpdate } from '../sockets/socket';
import { uploadMediaToServer } from '../utils/mediaUpload';
import MediaViewer from '../components/MediaViewer';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { CometChat } from "@cometchat/chat-sdk-react-native";
import { 
  getMyUserId,
  sendMessage as sendSocketMessage,
  sendChatTyping,
  onChatTyping,
  onMessageReceived,
  onMessageReadReceipt,
  markMessagesAsRead,
  sendReadReceipt,
  onUserPresence,
  getChatMessages,
  clearMessageCache,
  clearChatMessages,
  onChatCleared,
  deleteMessage,
  onMessageDeleted,
  globalMessageStorage,
  fetchMessages,
  fetchFriends,
  getAvatar,
} from "../sockets/socket";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLang } from "../store/lang";
import { t } from "../utils/i18n";
import { clearNotificationIndicators } from "../utils/pushNotifications";

type RouteParams = {
  peerId: string;
  peerName?: string;
  peerAvatar?: string; // deprecated
  peerAvatarVer?: number;
  peerAvatarThumbB64?: string;
  peerOnline?: boolean;
};
type Props = { route: { params?: RouteParams }; navigation: any };

export default function ChatScreen({ route, navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useAppTheme();
  const lang = useLang((s) => s.lang);
  // Android: одинаковый нижний отступ для bottom sheet на всех девайсах.
  // На кнопочной навигации insets.bottom часто = 0, поэтому фиксируем минимальный паддинг.
  // Важно: на жестовой навигации insets.bottom может быть большим, и лист визуально "висит" слишком высоко.
  // Поэтому делаем clamp: не меньше 24px и не больше 32px.
  const ANDROID_SHEET_BOTTOM_PAD = Platform.OS === 'android'
    ? Math.max(18, Math.min(26, 10 + Math.max(0, insets.bottom)))
    : 12 + Math.max(0, insets.bottom);


  // Загружаем профиль при инициализации
  useEffect(() => {
    (async () => {
      try {
        const profileResponse = await getMyProfile();
        if (profileResponse?.ok && profileResponse.profile) {
          const profile = profileResponse.profile;
          const hasAvatar = ("avatarB64" in profile ? !!profile.avatarB64 : !!profile.avatarUrl);
          logger.debug('Loaded profile on init', { nick: profile.nick, hasAvatar });
          
          // Обновляем никнейм из backend
          if (profile.nick && typeof profile.nick === 'string') {
            // Здесь можно обновить никнейм если нужно
            console.log('[ChatScreen] Profile nick:', profile.nick);
          }
        }
      } catch (e) {
        console.warn('[ChatScreen] Failed to load profile on init:', e);
      }
    })();
  }, []);

  // КРИТИЧНО: мемоизируем объект, иначе он новый на каждый рендер (и может ломать мемоизацию ниже)
  const LIVI = React.useMemo(() => ({
    rgb: theme.colors.background === '#151F33' ? 'rgba(21, 31, 51, 0.3)' : 'rgba(0,0,0,0.06)',
    bg: theme.colors.background,
    surface: theme.colors.surface,
    titan: theme.colors.onSurfaceVariant as string,
    text: theme.colors.onSurfaceVariant as string,
    white: theme.colors.onSurface as string,
    green: '#2ECC71',
    red: '#FF5A67',
  } as const), [theme, isDark]);

  const BORDER_COLOR = theme.colors.outline as string;
  // Цвета облаков: в светлой теме немного затемняем входящие, исходящие чуть светлее
  // Тёмная тема — как было изначально; светлая — оставляем текущие оттенки
  const BUBBLE_BG_OUT = isDark ? LIVI.rgb : 'hsla(220, 2.80%, 79.00%, 0.70)';
  const BUBBLE_BG_IN  = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(114, 141, 175, 0.32)';
  const BORDER_WIDTH = 1;

  const peerId = String(route?.params?.peerId || "");
  const peerNameParam = route?.params?.peerName || "—";
  const peerAvatarVer = route?.params?.peerAvatarVer || 0;
  const peerAvatarThumbB64Param = route?.params?.peerAvatarThumbB64 || '';
  const [peerAvatarVerState, setPeerAvatarVerState] = useState<number>(peerAvatarVer);
  const [peerOnline, setPeerOnline] = useState<boolean>(!!route?.params?.peerOnline);
  const [fullAvatarUri, setFullAvatarUri] = useState<string>(peerAvatarThumbB64Param); // Используем миниатюру как начальное значение

  const [conversation, setConversation] =
    useState<CometChat.Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  // Чтобы не показывать "пустую заглушку" до загрузки истории (иначе она мелькает на входе в чат)
  const [historyReady, setHistoryReady] = useState(false);
  // Кастомное подтверждение удаления сообщения (вместо системного Alert)
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const pendingDeleteRef = useRef<any>(null);
  // Кастомный алерт/ошибка (вместо системного Alert)
  const [noticeVisible, setNoticeVisible] = useState(false);
  const [noticeTitle, setNoticeTitle] = useState('');
  const [noticeMessage, setNoticeMessage] = useState('');
  const [noticeKind, setNoticeKind] = useState<'error' | 'info'>('info');
  // Универсальный confirm (2 кнопки) для замены Alert.alert с действиями
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState('');
  const [confirmMessage, setConfirmMessage] = useState('');
  const [confirmCancelText, setConfirmCancelText] = useState('Отмена');
  const [confirmOkText, setConfirmOkText] = useState('Ок');
  const [confirmDestructive, setConfirmDestructive] = useState(false);
  const onConfirmRef = useRef<(() => void) | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [inputHeight, setInputHeight] = useState(0);
  const [messageText, setMessageText] = useState("");
  const [peerTyping, setPeerTyping] = useState(false);
  const [peerTypingDots, setPeerTypingDots] = useState(1);
  const [readStatuses, setReadStatuses] = useState<Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>>({});
  const [uploadStatus, setUploadStatus] = useState<Record<string, 'sending' | 'sent' | 'failed'>>({});
  const [showClearMenu, setShowClearMenu] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<any>(null);
  const [showMessageActions, setShowMessageActions] = useState(false);
  const [showForwardPicker, setShowForwardPicker] = useState(false);
  const [forwardFriends, setForwardFriends] = useState<any[]>([]);
  const [forwardLoading, setForwardLoading] = useState(false);
  // Multi-select (режим "Выбрать")
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [forwardToast, setForwardToast] = useState<{ visible: boolean; ok: boolean; text: string }>({
    visible: false,
    ok: true,
    text: '',
  });
  const messageActionsOpacity = useRef(new Animated.Value(0)).current;
  const messageActionsTranslateY = useRef(new Animated.Value(30)).current;
  const forwardToastOpacity = useRef(new Animated.Value(0)).current;
  // Чтобы не спамить логами при перезагрузках/повторных fetch — логируем каждую картинку из истории один раз
  const loggedHistoryImageIdsRef = useRef<Set<string>>(new Set());
  // И дополнительно ограничиваем общий объём этих логов (в dev), чтобы консоль не шумела
  const loggedHistoryImagesCountRef = useRef(0);

  // Анимации для сообщений
  const messagePressAnimations = useRef<Record<string, Animated.Value>>({}).current;

  // Состояние для полноэкранного просмотра медиа
  const [mediaViewerVisible, setMediaViewerVisible] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<{
    type: 'image';
    uri: string;
    name?: string;
  } | null>(null);

  /* ===== Voice messages (hold-to-record) ===== */
  const voiceRecordingRef = useRef<Audio.Recording | null>(null);
  const voiceRecordTimerRef = useRef<any>(null);
  const voiceStopInProgressRef = useRef(false);
  const voiceCancelTriggeredRef = useRef(false);
  const [voiceIsRecording, setVoiceIsRecording] = useState(false);
  const [voiceRecordMs, setVoiceRecordMs] = useState(0);

  // Gesture/animations for swipe-to-cancel
  const voiceDragX = useRef(new Animated.Value(0)).current; // 0..negative
  const micScale = useRef(new Animated.Value(1)).current;
  const trashLid = useRef(new Animated.Value(0)).current; // 0 closed -> 1 open
  const trashFlash = useRef(new Animated.Value(0)).current; // subtle feedback on cancel
  const cancelArmedRef = useRef(false);
  const recordViz = useRef(new Animated.Value(0)).current;
  const recordVizLoopRef = useRef<Animated.CompositeAnimation | null>(null);
  const trashZoneRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const trashMeasureRef = useRef<View | null>(null);
  const voiceStartXRef = useRef(0);
  const voiceStartYRef = useRef(0);

  const audioSoundRef = useRef<Audio.Sound | null>(null);
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);

  // Состояние для предпросмотра выбранного фото перед отправкой (без лишних Alert/ActionSheet)
  const [composeViewerVisible, setComposeViewerVisible] = useState(false);
  const [composeAsset, setComposeAsset] = useState<any>(null);

  // Android: кастомный sheet для выбора вложений (камера/галерея)
  const [showAttachSheet, setShowAttachSheet] = useState(false);



  // Обертка для setReadStatuses с автосохранением
  const updateReadStatuses = (updater: (prev: Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>) => Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>) => {
    setReadStatuses(prev => {
      const updated = updater(prev);
      saveStatuses(updated); // Автоматически сохраняем
      return updated;
    });
  };
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // Refs для автоскролла
  const flatListRef = useRef<FlatList>(null);
  const keyboardAwareListRef = useRef<any>(null);

  // Функция автоскролла к последнему сообщению
  const scrollToBottom = () => {
    try {
      if (flatListRef.current) {
        if (Platform.OS === 'android') {
          // В инвертированном списке "низ" = offset 0
          (flatListRef.current as any).scrollToOffset?.({ offset: 0, animated: false });
        } else {
          flatListRef.current.scrollToEnd({ animated: false });
        }
      }
    } catch (error) {
      console.warn('Failed to scroll to bottom:', error);
      // Fallback: пробуем scrollToEnd
      try {
        if (flatListRef.current) {
          if (Platform.OS === 'android') {
            (flatListRef.current as any).scrollToOffset?.({ offset: 0, animated: false });
          } else {
            flatListRef.current.scrollToEnd({ animated: false });
          }
        }
      } catch (e) {
        console.warn('Fallback scroll also failed:', e);
      }
    }
  };

  // Коалесируем многократные вызовы скролла, чтобы избежать дёрганий
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleScrollToBottom = (delay = 0) => {
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      scrollToBottom();
    }, delay);
  };

  // Реальная высота контейнера (по onLayout), чтобы корректно понять, ресайзит ли система окно при клавиатуре
  const [rootLayoutH, setRootLayoutH] = useState<number>(0);
  const baseRootLayoutHRef = useRef<number>(0);

  // Всегда прижимаем к низу при показе/скрытии клавиатуры
  useEffect(() => {
    // Закрыть возможный глобальный оверлей входящего, если звонящий отменил/таймаут
    const offClose = onCloseIncoming(() => {
      try { navigation?.setParams?.({}); } catch {}
      // Здесь ничего не рисуем — просто гарантируем, что чат не держит модалку
    });
    // Доп. гарантия: если напрямую пришёл сигнал отмены/таймаута — форсируем закрытие глобальной модалки
    const forceClose = () => { try { emitCloseIncoming(); } catch {} };
    try { socket.on('call:timeout', forceClose); } catch {}
    try { socket.on('call:declined', forceClose); } catch {}
    try { socket.on('call:cancel', forceClose); } catch {}

    // Локальный таймер: если висит входящий в чате и 20с тишина — гарантированно закрыть
    const incomingTimerRef: { current: any } = { current: null };
    const onIncoming = () => {
      if (incomingTimerRef.current) { clearTimeout(incomingTimerRef.current); incomingTimerRef.current = null; }
      incomingTimerRef.current = setTimeout(() => { try { emitCloseIncoming(); } catch {} }, 20500);
    };
    const clearIncomingTimer = () => { if (incomingTimerRef.current) { clearTimeout(incomingTimerRef.current); incomingTimerRef.current = null; } };
    try { socket.on('call:incoming', onIncoming); } catch {}
    try { socket.on('call:accepted', clearIncomingTimer); } catch {}
    try { socket.on('call:declined', clearIncomingTimer); } catch {}
    try { socket.on('call:cancel', clearIncomingTimer); } catch {}
    try { socket.on('call:timeout', clearIncomingTimer); } catch {}
    const onShow = (event: any) => { 
      setKeyboardVisible(true); 
      if (Platform.OS === 'android') {
        const screenY = Number(event?.endCoordinates?.screenY || 0);
        const screenH = Dimensions.get('screen').height;
        const fallbackH = Number(event?.endCoordinates?.height || 0);
        const inset = screenY > 0 ? Math.max(0, screenH - screenY) : Math.max(0, fallbackH);
        setKeyboardInset(inset);
      }
      scheduleScrollToBottom(0); 
    };
    const onHide = () => { 
      setKeyboardVisible(false); 
      setKeyboardInset(0);
      scheduleScrollToBottom(0); 
    };
    const onWillShow = (event: any) => { 
      setKeyboardVisible(true); 
      if (Platform.OS === 'ios' && event?.endCoordinates?.height) {
        // On iOS KeyboardAvoidingView will handle offsets; we keep this for potential diagnostics only.
      }
      scheduleScrollToBottom(0); 
    };
    const onWillHide = () => { 
      setKeyboardVisible(false); 
      scheduleScrollToBottom(0); 
    };

    const subs = [
      Keyboard.addListener('keyboardWillShow', onWillShow), // iOS
      Keyboard.addListener('keyboardWillHide', onWillHide), // iOS
      Keyboard.addListener('keyboardDidShow', onShow),       // Android
      Keyboard.addListener('keyboardDidHide', onHide),       // Android
    ];
    return () => { subs.forEach(s => s.remove()); offClose?.(); try { socket.off('call:timeout', forceClose); } catch {}; try { socket.off('call:declined', forceClose); } catch {}; try { socket.off('call:cancel', forceClose); } catch {}; try { socket.off('call:incoming', onIncoming); } catch {}; try { socket.off('call:accepted', clearIncomingTimer); } catch {}; try { socket.off('call:declined', clearIncomingTimer); } catch {}; try { socket.off('call:cancel', clearIncomingTimer); } catch {}; try { socket.off('call:timeout', clearIncomingTimer); } catch {}; clearIncomingTimer(); };
  }, []);

  // На любое изменение количества сообщений — прижать вниз
  useEffect(() => {
    scheduleScrollToBottom(0);
  }, [messages.length, keyboardVisible]);

  // Фактический подъём панели над клавиатурой:
  // lift = keyboardInset - (на сколько система уже ужала контейнер)
  const systemResizeDelta = keyboardVisible ? Math.max(0, baseRootLayoutHRef.current - rootLayoutH) : 0;
  // Android: если система реально ресайзит окно (adjustResize), панель должна "лежать" на клавиатуре
  // без какого-либо bottom-offset (иначе появится воздух). Если система НЕ ресайзит — поднимаем сами.
  const isAndroidResizeMode =
    Platform.OS === 'android' && keyboardVisible && systemResizeDelta > 80; // 80px threshold to avoid jitter
  const keyboardLift =
    Platform.OS === 'android'
      ? (keyboardVisible ? (isAndroidResizeMode ? 0 : Math.max(0, keyboardInset)) : 0)
      : (keyboardVisible ? Math.max(0, keyboardInset - systemResizeDelta) : 0);

  // ===== Typing indicator (peer + local) =====
  // Высота видимого зазора между последним сообщением и верхом инпута (сюда ставим "Печатает...")
  const TYPING_GAP_H = 17;
  const peerTypingHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localTypingStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localTypingActiveRef = useRef(false);
  const lastTypingSentAtRef = useRef(0);

  const stopLocalTyping = React.useCallback(() => {
    if (localTypingStopTimerRef.current) {
      clearTimeout(localTypingStopTimerRef.current);
      localTypingStopTimerRef.current = null;
    }
    if (localTypingActiveRef.current) {
      localTypingActiveRef.current = false;
      try {
        if (peerId) sendChatTyping({ to: peerId, typing: false });
      } catch {}
    }
  }, [peerId]);

  const signalLocalTyping = React.useCallback(() => {
    if (!peerId) return;
    const now = Date.now();
    // Throttle "typing:true" to avoid spamming the socket
    if (!localTypingActiveRef.current || now - lastTypingSentAtRef.current > 900) {
      lastTypingSentAtRef.current = now;
      localTypingActiveRef.current = true;
      try {
        sendChatTyping({ to: peerId, typing: true });
      } catch {}
    }
    if (localTypingStopTimerRef.current) clearTimeout(localTypingStopTimerRef.current);
    localTypingStopTimerRef.current = setTimeout(() => {
      stopLocalTyping();
    }, 2000);
  }, [peerId, stopLocalTyping]);

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      stopLocalTyping();
      if (peerTypingHideTimerRef.current) {
        clearTimeout(peerTypingHideTimerRef.current);
        peerTypingHideTimerRef.current = null;
      }
    };
  }, [stopLocalTyping]);

  useEffect(() => {
    // Incoming typing events from peer
    const off = onChatTyping((data) => {
      try {
        const from = String((data as any)?.from || '');
        const to = String((data as any)?.to || '');
        const typing = !!(data as any)?.typing;

        if (!from || from !== peerId) return;
        if (currentUserId && to && to !== String(currentUserId)) return;

        if (peerTypingHideTimerRef.current) {
          clearTimeout(peerTypingHideTimerRef.current);
          peerTypingHideTimerRef.current = null;
        }

        if (typing) {
          setPeerTyping(true);
          // If peer stops typing but "typing:false" is lost, hide after 2s
          peerTypingHideTimerRef.current = setTimeout(() => {
            setPeerTyping(false);
          }, 2100);
        } else {
          setPeerTyping(false);
        }
      } catch {}
    });
    return () => {
      off?.();
    };
  }, [peerId, currentUserId]);

  useEffect(() => {
    if (!peerTyping) {
      setPeerTypingDots(1);
      return;
    }
    const id = setInterval(() => {
      setPeerTypingDots((prev) => (prev % 3) + 1);
    }, 420);
    return () => clearInterval(id);
  }, [peerTyping]);

  const GapCenterIndicator = React.useMemo(() => {
    // Приоритет: "Печатает..." > "Отправлено"
    if (!peerTyping && !forwardToast.visible) return null;

    const baseStyle = {
      fontSize: 13,
      fontStyle: 'italic' as const,
      fontWeight: '500' as const,
      letterSpacing: 0.2,
    };

    const text = peerTyping ? `Печатает${'.'.repeat(peerTypingDots)}` : String(forwardToast.text || 'Отправлено');
    const color = peerTyping
      ? (isDark ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.40)')
      : (forwardToast.ok ? '#55d187' : '#FF5A67');

    return (
      <Animated.View
        pointerEvents="none"
        style={{
          justifyContent: 'center',
          alignItems: 'center',
          opacity: peerTyping ? 1 : forwardToastOpacity,
        }}
      >
        <Text style={{ ...baseStyle, color }}>{text}</Text>
      </Animated.View>
    );
  }, [peerTyping, peerTypingDots, isDark, forwardToast.visible, forwardToast.text, forwardToast.ok, forwardToastOpacity]);

  // Кэшируем миниатюру при инициализации (если передана)
  useEffect(() => {
    if (peerAvatarThumbB64Param && peerAvatarVerState) {
      (async () => {
        try {
          await putThumb(peerId, peerAvatarVerState, peerAvatarThumbB64Param);
        } catch (e) {
          console.warn('[ChatScreen] Failed to cache thumb:', e);
        }
      })();
    }
  }, []); // Только при монтировании

  // Загрузка полного аватара друга
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!peerId || !peerAvatarVerState) {
        // Если нет версии, но есть миниатюра из параметров - используем её
        if (peerAvatarThumbB64Param) {
          setFullAvatarUri(peerAvatarThumbB64Param);
        } else {
          setFullAvatarUri('');
        }
        return;
      }

      // Проверяем кэш полного аватара
      const cachedFull = await getFull(peerId, peerAvatarVerState);
      if (cachedFull && !cancelled) {
        setFullAvatarUri(cachedFull);
        return;
      }

      // Если нет полного, но есть миниатюра - используем её временно
      if (peerAvatarThumbB64Param && !cancelled) {
        setFullAvatarUri(peerAvatarThumbB64Param);
      }

      try {
        const res = await getAvatar(peerId);
        if (cancelled) return;

        if (res?.ok && res.avatarB64) {
          await putFull(peerId, res.avatarVer!, res.avatarB64);
          setFullAvatarUri(res.avatarB64);

          if (res.avatarVer !== peerAvatarVerState) {
            setPeerAvatarVerState(res.avatarVer!);
          }
        } else if (res?.ok && !res.avatarB64) {
          if (!peerAvatarThumbB64Param) setFullAvatarUri('');
        }
      } catch {
        // мягко игнорируем — останется миниатюра/пусто
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [peerId, peerAvatarVerState]);

  // Функция для открытия медиа в полноэкранном режиме
  const openMediaViewer = React.useCallback((type: 'image', uri: string, name?: string) => {
    setSelectedMedia({ type, uri, name });
    setMediaViewerVisible(true);
  }, []);

  // Функция для закрытия медиа просмотра
  const closeMediaViewer = React.useCallback(() => {
    setMediaViewerVisible(false);
    // NB: keep selectedMedia to avoid extra prop churn while animating close;
    // we'll clear it in a microtask after visibility changes.
    setTimeout(() => {
      try { setSelectedMedia(null); } catch {}
    }, 0);
  }, []);

  // Функции для работы с сохраненными сообщениями и статусами
  const getMessagesKey = (userId: string, peerId: string) => {
    const sortedIds = [userId, peerId].sort();
    return `chat_messages_${sortedIds[0]}_${sortedIds[1]}`;
  };

  const getStatusesKey = (userId: string, peerId: string) => {
    const sortedIds = [userId, peerId].sort();
    return `chat_statuses_${sortedIds[0]}_${sortedIds[1]}`;
  };

  const saveMessages = async (messages: any[]) => {
    try {
      if (!currentUserId || !peerId) return;
      const key = getMessagesKey(currentUserId, peerId);
      await AsyncStorage.setItem(key, JSON.stringify(messages));
    } catch (error) {
      console.warn('💾 Failed to save messages to AsyncStorage:', error);
    }
  };

  const saveStatuses = async (statuses: Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>) => {
    try {
      if (!currentUserId || !peerId) return;
      const key = getStatusesKey(currentUserId, peerId);
      await AsyncStorage.setItem(key, JSON.stringify(statuses));
    } catch (error) {
      // Игнорируем ошибки сохранения
    }
  };

  const loadStatuses = async (): Promise<Record<string, 'sending' | 'delivered' | 'read' | 'failed'>> => {
    try {
      if (!currentUserId || !peerId) return {};
      const key = getStatusesKey(currentUserId, peerId);
      const savedStatuses = await AsyncStorage.getItem(key);
      if (savedStatuses) {
        return JSON.parse(savedStatuses);
      }
      return {};
    } catch (error) {
      return {};
    }
  };

  const loadMessages = async () => {
    try {
      if (!currentUserId || !peerId) return [];
      const key = getMessagesKey(currentUserId, peerId);
      const savedMessages = await AsyncStorage.getItem(key);
      if (savedMessages) {
        return JSON.parse(savedMessages);
      }
      return [];
    } catch (error) {
      return [];
    }
  };

  useEffect(() => {
    // Быстрая инициализация как в старой версии
    const initializeChat = async () => {
      
      try {
        // Получаем userId через REST API (как в старой версии)
        const userId = await getMyUserId();
        
        if (userId) {
          setCurrentUserId(userId);
        } else {
          console.warn('🔍 ChatScreen: no userId received from getMyUserId');
        }
        
        // Создаем фиктивную conversation сразу (UI готов мгновенно)
        const fakeUser = {
          getUid: () => peerId,
          getName: () => route?.params?.peerName || "—",
          getAvatar: () => route?.params?.peerAvatar || "",
        } as CometChat.User;
        
        const fakeConv = {
          getConversationWith: () => fakeUser,
          getUnreadMessageCount: () => 0,
        } as CometChat.Conversation;
        
        setConversation(fakeConv);
        setLoading(false);
        
      } catch (e) {
        console.error('❌ Chat init failed:', e);
        setLoading(false);
      }
    };

    // Инициализируем асинхронно
    initializeChat();

  }, [peerId, route?.params?.peerName, route?.params?.peerAvatar]);

  // Слушатели сообщений через сокеты
  useEffect(() => {
    if (!currentUserId) return;


    // Слушатель входящих сообщений
    const unsubscribeReceived = onMessageReceived((message) => {
      const senderId = message.from;
      const isFromMe = senderId === currentUserId;
      const isFromPeer = senderId === peerId;

      if (isFromPeer || isFromMe) {
        // Очищаем кэш при получении нового сообщения
        clearMessageCache(peerId, currentUserId);
        
        
        
        const newMessage = {
          id: message.id,
          text: message.text,
          type: message.type,
          uri: message.uri,
          name: (message as any).name,
          size: (message as any).size,
          duration: (message as any).duration,
          sender: isFromMe ? "me" : "peer",
          from: message.from,
          to: message.to,
          timestamp: new Date(message.timestamp),
        };
        
        // КРИТИЧНО: Логируем входящие сообщения с изображениями для отладки
        if (message.type === 'image') {
          logger.info('[ChatScreen] Received image message', {
            messageId: message.id,
            from: message.from,
            to: message.to,
            uri: message.uri,
            resolvedUri: resolveMediaUri(message.uri),
            hasUri: !!message.uri,
          });
        }

        setMessages((prev) => {
          // Проверяем, есть ли уже сообщение с таким ID
          const existingMessage = prev.find(msg => msg.id === newMessage.id);
          if (existingMessage) {
            return prev;
          }
          
          const updated = [...prev, newMessage];
          saveMessages(updated);
          return updated;
        });

        // Сохраняем сообщение глобально для офлайн доступа
        if (isFromPeer && currentUserId) {
          globalMessageStorage.saveMessage(message, currentUserId);
        }

        // Отмечаем как прочитанное только сообщения от собеседника
        if (isFromPeer) {
          setTimeout(() => {
            markMessagesAsRead(senderId);
            try { void clearNotificationIndicators(); } catch {}
          }, 1000);
        }
      }
    });

    // Слушатель подтверждений прочтения
    const unsubscribeReadReceipt = onMessageReadReceipt((receipt) => {
      // Перекладываем статус в карту по server messageId
      updateReadStatuses(prev => ({
        ...prev, 
        [receipt.messageId]: 'read'
      }));
    });

    // Отслеживаем подтверждение доставки, если прилетает отдельным событием
    // Если статус доставки приходит отдельным механизмом, можно повесить сюда нужный слушатель в будущем
    const unsubscribeDelivered = () => {};

    // Слушатель очистки чата
    const unsubscribeChatCleared = onChatCleared((data) => {
      // Очищаем чат если это касается текущего чата
      // data.by - кто инициировал очистку, data.with - с кем очищается чат
      // Проверяем, что текущий чат между currentUserId и peerId участвует в очистке
      const isCurrentChatCleared = (
        (// Я очистил чат с peerId
        (data.by === currentUserId && data.with === peerId) || (data.by === peerId && data.with === currentUserId))     // peerId очистил чат со мной
      );
      
      if (isCurrentChatCleared) {
        setMessages([]);
        clearMessageCache(peerId, currentUserId);
        // Очищаем AsyncStorage
        const chatKey = globalMessageStorage.getChatKey(currentUserId, peerId);
        AsyncStorage.removeItem(chatKey);
      } else {
      }
    });

    // Слушатель удаления сообщений
    const unsubscribeMessageDeleted = onMessageDeleted((data) => {
      setMessages(prev => prev.filter(msg => msg.id !== data.messageId));
    });


    return () => {
      unsubscribeReceived();
      unsubscribeReadReceipt();
      unsubscribeChatCleared();
      unsubscribeMessageDeleted();
      unsubscribeDelivered();
    };
  }, [currentUserId, peerId]);

  // Отправляем read receipt для всех сообщений peer при открытии чата
  useEffect(() => {
    if (messages.length && peerId && currentUserId) {
      const peerMessages = messages.filter(m => m.sender === "peer");
      peerMessages.forEach(m => {
        sendReadReceipt(m.id, peerId);
      });
    }
  }, [messages, peerId, currentUserId]);

  // Подписываемся на изменения онлайн-статуса собеседника
  useEffect(() => {
    if (!peerId) return;
    
    const unsubscribePresence = onUserPresence((userId, online) => {
      if (userId === peerId) {
        setPeerOnline(online);
      }
    });
    
    return unsubscribePresence;
  }, [peerId]);

  // Загрузка истории при открытии чата
  useEffect(() => {
    if (!currentUserId || !peerId) return;
    
    const loadHistory = async () => {
      try {
        // На входе в чат не показываем "пусто", пока не загрузили историю
        setHistoryReady(false);
        // Очищаем кэш для принудительной перезагрузки с правильными полями
        clearMessageCache(peerId, currentUserId);
        
        // Загружаем сообщения с сервера через новую систему
        const serverMessages = await fetchMessages({ 
          with: peerId, 
          limit: 50 
        });
        
            if (serverMessages?.ok && serverMessages.messages) {
          // Конвертируем сообщения сервера в формат фронтенда
          const formattedMessages = serverMessages.messages.map((msg: any) => {
            // КРИТИЧНО: Логируем сообщения с изображениями при загрузке истории
            if (msg.type === 'image') {
            const mid = String(msg.id || '').trim();
            // В проде это не нужно. В dev ограничиваем максимум 1 логом.
            if (__DEV__ && mid && !loggedHistoryImageIdsRef.current.has(mid) && loggedHistoryImagesCountRef.current < 1) {
              loggedHistoryImageIdsRef.current.add(mid);
              loggedHistoryImagesCountRef.current += 1;
              logger.info('[ChatScreen] Loading image message from history', {
                messageId: msg.id,
                from: msg.from,
                to: msg.to,
                uri: msg.uri,
                resolvedUri: resolveMediaUri(msg.uri),
                hasUri: !!msg.uri,
              });
            }
            }
            
            return {
              id: msg.id,
              text: msg.text,
              type: msg.type,
              uri: msg.uri,
              name: (msg as any).name,
              size: (msg as any).size,
              sender: msg.from === currentUserId ? 'me' : 'peer',
              from: msg.from,
              to: msg.to,
              timestamp: new Date(msg.timestamp),
              read: !!msg.read,
            };
          });
          
              setMessages(formattedMessages);
          
          // Отмечаем сообщения как прочитанные
          await markMessagesAsRead(peerId);
          // Clear notification tray/badge after reading
          try { await clearNotificationIndicators(); } catch {}
          
              // Синхронизируем статусы доставки/прочтения из сервера для моих сообщений
              try {
                const serverStatuses: Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'> = {};
                for (const m of formattedMessages) {
                  if (m.sender === 'me') {
                    serverStatuses[m.id] = m.read ? 'read' : 'sent';
                  }
                }
                // Загружаем сохраненные статусы и объединяем, отдавая приоритет данным с сервера
                const savedStatuses = await loadStatuses();
                setReadStatuses({ ...(savedStatuses || {}), ...serverStatuses });
              } catch {}

            } else {
          // Fallback: загружаем локальные сообщения
          const localMessages = await getChatMessages(peerId, currentUserId);
          setMessages(localMessages);
        }
            // Если выше не загрузили (ветка fallback) — поднимем сохраненные статусы
            if (!(serverMessages?.ok && serverMessages.messages)) {
              const savedStatuses = await loadStatuses();
              setReadStatuses(savedStatuses);
            }
        
        
        
      } catch (error) {
        console.error("Error loading chat history:", error);
        // Fallback на локальные сообщения при ошибке
        try {
          const localMessages = await getChatMessages(peerId, currentUserId);
          setMessages(localMessages);
        } catch (fallbackError) {
          console.error('Fallback loading also failed:', fallbackError);
          setMessages([]); // Пустая история при ошибке
        }
      } finally {
        // История (успешно или с фолбэком) отработала — можно показывать заглушку при реально пустом чате
        setHistoryReady(true);
      }
    };

    loadHistory();
  }, [peerId, currentUserId]);



  const headerH = 56;

  const resolveAvatar = React.useCallback((s?: string) => {
    if (!s) return '';
    const raw = String(s).trim();
    if (/^https?:\/\//i.test(raw)) return toAvatarThumb(raw, 72, 72);
    if (raw.startsWith('/uploads/')) return `${API_BASE}${raw}`;
    return '';
  }, []);

  const resolveMediaUri = React.useCallback((s?: string) => {
    if (!s) {
      logger.warn('[ChatScreen] resolveMediaUri: empty URI');
      return '';
    }
    // Если уже полный URL, возвращаем как есть
    if (/^https?:\/\//i.test(s)) {
      return s;
    }
    // Если относительный путь начинается с /uploads/, добавляем API_BASE
    if (s.startsWith('/uploads/')) {
      const fullUrl = `${API_BASE}${s}`;
      logger.debug('[ChatScreen] resolveMediaUri: resolved relative path', { original: s, resolved: fullUrl });
      return fullUrl;
    }
    // Если путь не начинается с /, возможно это уже полный путь без протокола
    // Или это может быть base64 или другой формат
    logger.debug('[ChatScreen] resolveMediaUri: returning as-is', { uri: s });
    return s;
  }, []);

  const formatDuration = React.useCallback((ms: number) => {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }, []);

  // UI format requested: 0.07, 1.02, etc.
  const formatDurationDot = React.useCallback((ms: number) => {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}.${String(s).padStart(2, '0')}`;
  }, []);

  const stopAudioPlayback = React.useCallback(async () => {
    try {
      if (audioSoundRef.current) {
        await audioSoundRef.current.stopAsync().catch(() => {});
        await audioSoundRef.current.unloadAsync().catch(() => {});
      }
    } finally {
      audioSoundRef.current = null;
      setPlayingAudioId(null);
      setPlayingAudioState(null);
    }
  }, []);

  const [retryUiForId, setRetryUiForId] = useState<string | null>(null);

  const retryFailedOutgoingMessage = React.useCallback(async (m: any) => {
    try {
      if (!m?.id || !currentUserId || !peerId) return;
      const mid = String(m.id);
      const type = String(m?.type || '').trim();
      if (!type) return;

      setRetryUiForId(null);
      setUploadStatus((prev) => ({ ...prev, [mid]: 'sending' }));
      updateReadStatuses((prev) => ({ ...prev, [mid]: 'sending' }));

      if (type === 'audio') {
        const localUri = String(m?.uri || '').trim();
        const name = String(m?.name || `voice_${Date.now()}.m4a`);
        const size = Number(m?.size || 0) || 0;
        const durationSec = Number(m?.duration || 0) || 0;

        let remoteUrl = localUri;
        const looksRemote = /^https?:\/\//i.test(remoteUrl);
        if (!looksRemote) {
          const upload = await uploadMediaToServer(localUri, 'audio', undefined, currentUserId, peerId);
          if (!upload.success || !upload.url) {
            updateReadStatuses((prev) => ({ ...prev, [mid]: 'failed' }));
            setUploadStatus((prev) => ({ ...prev, [mid]: 'failed' }));
            return;
          }
          remoteUrl = upload.url;
        }

        const socketResult: any = await sendSocketMessage({
          to: peerId,
          type: 'audio',
          uri: remoteUrl,
          name,
          size,
          duration: durationSec,
        });

        if (socketResult?.ok && socketResult?.messageId) {
          const newId = String(socketResult.messageId);
          setMessages((prev) => {
            const updated = prev.map((msg: any) =>
              String(msg?.id) === mid
                ? { ...msg, id: newId, uri: resolveMediaUri(remoteUrl), from: currentUserId, to: peerId }
                : msg
            );
            saveMessages(updated);
            return updated;
          });

          setUploadStatus((prev) => {
            const next = { ...prev };
            next[newId] = 'sent';
            delete next[mid];
            return next;
          });

          updateReadStatuses((prev) => {
            const next = { ...prev };
            const delivery = socketResult.delivered ? 'delivered' : 'sent';
            next[newId] = delivery;
            delete next[mid];
            return next;
          });

          // cleanup local file if it exists and we have sent successfully
          try { if (!looksRemote) await FileSystem.deleteAsync(localUri, { idempotent: true }); } catch {}
          return;
        }

        updateReadStatuses((prev) => ({ ...prev, [mid]: 'failed' }));
        setUploadStatus((prev) => ({ ...prev, [mid]: 'failed' }));
        return;
      }

      if (type === 'image') {
        const localUri = String(m?.uri || '').trim();
        const fileName = String(m?.name || `file_${Date.now()}`);
        const fileSize = Number(m?.size || 0) || 0;

        let remoteUrl = localUri;
        const looksRemote = /^https?:\/\//i.test(remoteUrl);
        if (!looksRemote) {
          const upload = await uploadMediaToServer(localUri, 'image', undefined, currentUserId, peerId);
          if (!upload.success || !upload.url) {
            updateReadStatuses((prev) => ({ ...prev, [mid]: 'failed' }));
            setUploadStatus((prev) => ({ ...prev, [mid]: 'failed' }));
            return;
          }
          remoteUrl = upload.url;
        }

        const socketResult: any = await sendSocketMessage({
          to: peerId,
          type: 'image',
          uri: remoteUrl,
          name: fileName || undefined,
          size: fileSize || undefined,
        });

        if (socketResult?.ok && socketResult?.messageId) {
          const newId = String(socketResult.messageId);
          setMessages((prev) => {
            const updated = prev.map((msg: any) =>
              String(msg?.id) === mid
                ? { ...msg, id: newId, uri: resolveMediaUri(remoteUrl), from: currentUserId, to: peerId }
                : msg
            );
            saveMessages(updated);
            return updated;
          });

          setUploadStatus((prev) => {
            const next = { ...prev };
            next[newId] = 'sent';
            delete next[mid];
            return next;
          });

          updateReadStatuses((prev) => {
            const next = { ...prev };
            const delivery = socketResult.delivered ? 'delivered' : 'sent';
            next[newId] = delivery;
            delete next[mid];
            return next;
          });
          return;
        }

        updateReadStatuses((prev) => ({ ...prev, [mid]: 'failed' }));
        setUploadStatus((prev) => ({ ...prev, [mid]: 'failed' }));
        return;
      }

      // Fallback: no retry implemented for this type
      updateReadStatuses((prev) => ({ ...prev, [mid]: 'failed' }));
      setUploadStatus((prev) => ({ ...prev, [mid]: 'failed' }));
    } catch {
      try {
        const mid = String(m?.id || '');
        if (mid) {
          updateReadStatuses((prev) => ({ ...prev, [mid]: 'failed' }));
          setUploadStatus((prev) => ({ ...prev, [mid]: 'failed' }));
        }
      } catch {}
    }
  }, [currentUserId, peerId, resolveMediaUri, updateReadStatuses, saveMessages]);

  const [playingAudioState, setPlayingAudioState] = useState<{
    id: string;
    durationMs: number;
    positionMs: number;
  } | null>(null);

  const togglePlayAudioMessage = React.useCallback(async (m: any) => {
    try {
      const mid = String(m?.id || '').trim();
      const rawUri = String(m?.uri || '').trim();
      const uri = rawUri ? resolveMediaUri(rawUri) : '';
      if (!mid || !uri) return;

      if (playingAudioId === mid) {
        await stopAudioPlayback();
        return;
      }

      await stopAudioPlayback();

      const fallbackDurationMs = Math.max(0, Number(m?.duration || 0) * 1000);
      setPlayingAudioState({ id: mid, durationMs: fallbackDurationMs, positionMs: 0 });

      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true },
        (status) => {
          const s: any = status as any;
          if (s && typeof s.positionMillis === 'number') {
            setPlayingAudioState((prev) => {
              if (!prev || prev.id !== mid) return prev;
              return {
                id: prev.id,
                durationMs: typeof s.durationMillis === 'number' ? Number(s.durationMillis) : prev.durationMs,
                positionMs: Number(s.positionMillis || 0),
              };
            });
          }
          if (s?.didJustFinish) {
            void stopAudioPlayback();
          }
        }
      );
      audioSoundRef.current = sound;
      setPlayingAudioId(mid);
    } catch {
      // ignore
    }
  }, [resolveMediaUri, playingAudioId, stopAudioPlayback]);

  useEffect(() => {
    return () => {
      // cleanup sounds/recording on unmount
      try { void stopAudioPlayback(); } catch {}
      try {
        if (voiceRecordingRef.current) {
          voiceRecordingRef.current.stopAndUnloadAsync().catch(() => {});
        }
      } catch {}
      try { if (voiceRecordTimerRef.current) clearInterval(voiceRecordTimerRef.current); } catch {}
    };
  }, [stopAudioPlayback]);

  // Recording visualization loop (placeholder replacement)
  useEffect(() => {
    try {
      recordVizLoopRef.current?.stop?.();
    } catch {}
    recordViz.setValue(0);

    if (!voiceIsRecording) return;

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(recordViz, { toValue: 1, duration: 520, useNativeDriver: true }),
        Animated.timing(recordViz, { toValue: 0, duration: 520, useNativeDriver: true }),
      ])
    );
    recordVizLoopRef.current = loop;
    loop.start();
    return () => {
      try { loop.stop(); } catch {}
    };
  }, [voiceIsRecording, recordViz]);
  // КРИТИЧНО: firstLetter используется ТОЛЬКО для аватара (headerInitial), НЕ для текста
  // Для текста используем peerNameState (полный никнейм)
  const firstLetter = (s?: string) => (s?.trim()?.[0] || '').toUpperCase();
  const [peerNameState, setPeerNameState] = useState<string>(peerNameParam);
  const headerInitial = peerNameState ? firstLetter(peerNameState) : '--'; // Только для аватара!
  const headerPlaceholder = '--'; // Всегда показываем -- если нет аватара

  // Header будет объявлен ниже (после всех helper-функций), чтобы не было "используется до объявления".

  // live updates for peer profile while chat is open
  useEffect(() => {
    const offProfile = onFriendProfile?.(async ({ userId, nick, avatar, avatarVer, avatarThumbB64 }: any) => {
      // Обновляем только профиль конкретного друга в этом чате
      if (String(userId) !== String(peerId)) return;

      // КРИТИЧНО: дополнительная проверка - НЕ обновляем собственный профиль
      const currentUserId = (await import('../sockets/socket')).getCurrentUserId();
      if (currentUserId && String(userId) === String(currentUserId)) {
        return;
      }

      if (typeof nick === 'string') {
        // КРИТИЧНО: Используем полный никнейм для текста, не обрезаем до первой буквы
        // firstLetter используется только для headerInitial (аватар), не для текста
        const fullNickname = nick.trim() || '—';
        setPeerNameState(fullNickname);
        navigation.setParams({ peerName: fullNickname });
      }

      if (typeof avatarVer === 'number') {
        // Кэшируем миниатюру если пришла
        if (avatarThumbB64) {
          try {
            await putThumb(userId, avatarVer, avatarThumbB64);
            // КРИТИЧНО: Обновляем fullAvatarUri сразу с миниатюрой для мгновенного отображения
            setFullAvatarUri(avatarThumbB64);
          } catch (e) {
            console.warn('[ChatScreen] Failed to cache thumbnail:', e);
          }
        }
        
        // Обновляем версию - это триггернет загрузку полного аватара через useEffect
        setPeerAvatarVerState(avatarVer);
        navigation.setParams({ peerAvatarVer: avatarVer });
      }
    });
    const offPresence = onPresenceUpdate?.((data: any) => {
      // Обрабатываем только массив (для online статуса), игнорируем объекты {userId, busy}
      if (Array.isArray(data)) {
        const onlineSet = new Set((data || []).map((it: any) => String((it as any)?._id ?? it)));
        const isOnline = onlineSet.has(String(peerId));
        // КРИТИЧНО: Обновляем и локальное состояние, и navigation params для обновления в реальном времени
        setPeerOnline(isOnline);
        navigation.setParams({ peerOnline: isOnline });
      }
    });
    return () => { offProfile?.(); offPresence?.(); };
  }, [peerId, navigation]);

  // Обработчик user.avatarUpdated для мгновенного обновления аватара
  useEffect(() => {
    const handleAvatarUpdated = async ({ userId, avatarVer, avatarThumbB64 }: any) => {
      // Обновляем только аватар конкретного друга в этом чате
      if (String(userId) !== String(peerId)) return;

      // КРИТИЧНО: дополнительная проверка - НЕ обновляем собственный аватар
      const currentUserId = (await import('../sockets/socket')).getCurrentUserId();
      if (currentUserId && String(userId) === String(currentUserId)) {
        return;
      }

      // Кэшируем миниатюру
      if (avatarThumbB64 && avatarVer) {
        try {
          await putThumb(userId, avatarVer, avatarThumbB64);
          // КРИТИЧНО: Обновляем fullAvatarUri сразу с миниатюрой для мгновенного отображения
          setFullAvatarUri(avatarThumbB64);
        } catch (e) {
          console.warn('[ChatScreen] Failed to cache thumbnail:', e);
        }
      }

      // Обновляем версию - это триггернет загрузку полного аватара
      setPeerAvatarVerState(avatarVer);
    };

    socket.on('user.avatarUpdated', handleAvatarUpdated);
    
    return () => {
      socket.off('user.avatarUpdated', handleAvatarUpdated);
    };
  }, [peerId]);

  // When chat is focused, clear system notification tray/badge.
  // This fixes the case: user opens app from notifications, reads messages, but badge stays.
  useEffect(() => {
    const unsub = navigation?.addListener?.('focus', () => {
      try { void clearNotificationIndicators(); } catch {}
    });
    return () => {
      try { unsub?.(); } catch {}
    };
  }, [navigation]);

  // Предзагрузка удалена - теперь используется система кеширования в AvatarImage

  const Loading = () => (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: LIVI.surface,
      }}
    >
      <ActivityIndicator />
      <Text style={{ color: LIVI.text, marginTop: 12 }}>{t('chatLoading', lang)}</Text>
    </View>
  );
  // КРИТИЧНО: НЕ делаем ранние return по loading/err, иначе ниже хуки (useMemo/useCallback) будут
  // вызываться не на каждом рендере -> "Rendered more hooks than during the previous render".
  const isEmpty = messages.length === 0;
  const showEmpty = isEmpty && historyReady;

  const openClearMenu = () => {
    setShowClearMenu(true);
  };

  const clearChatForMe = async () => {
    if (!currentUserId || !peerId) return;

    openConfirm({
      title: t('chatClearMineTitle', lang),
      message: t('chatClearMineMsg', lang),
      okText: t('delete', lang),
      cancelText: t('cancel', lang),
      destructive: true,
      onConfirm: () => {
        (async () => {
          // Сразу очищаем локальные сообщения у инициатора
          setMessages([]);
          clearMessageCache(peerId, currentUserId);

          // Очищаем AsyncStorage у инициатора
          const chatKey = globalMessageStorage.getChatKey(currentUserId, peerId);
          await AsyncStorage.removeItem(chatKey);

          // Отправляем запрос на сервер для очистки только у себя
          const success = await clearChatMessages(peerId, false);
          if (success) {
            showNotice('info', t('successTitle', lang), t('chatClearedMineSuccess', lang));
          } else {
            showNotice('error', t('errorTitle', lang), t('chatClearFailedServer', lang));
          }
        })().catch(() => {
          showNotice('error', t('errorTitle', lang), t('chatClearFailedServer', lang));
        });
      },
    });
  };

  const clearChatForAll = async () => {
    if (!currentUserId || !peerId) return;

    openConfirm({
      title: t('chatClearAllTitle', lang),
      message: t('chatClearAllMsg', lang),
      okText: t('delete', lang),
      cancelText: t('cancel', lang),
      destructive: true,
      onConfirm: () => {
        (async () => {
          // Сразу очищаем локальные сообщения у инициатора
          setMessages([]);
          clearMessageCache(peerId, currentUserId);

          // Очищаем AsyncStorage у инициатора
          const chatKey = globalMessageStorage.getChatKey(currentUserId, peerId);
          await AsyncStorage.removeItem(chatKey);

          // Отправляем запрос на сервер для очистки у обоих пользователей
          const success = await clearChatMessages(peerId, true);
          if (success) {
            showNotice('info', t('successTitle', lang), t('chatClearedAllSuccess', lang));
          } else {
            showNotice('error', t('errorTitle', lang), t('chatClearFailedServer', lang));
          }
        })().catch(() => {
          showNotice('error', t('errorTitle', lang), t('chatClearFailedServer', lang));
        });
      },
    });
  };


  const deleteSingleMessage = async (messageId: string) => {
    const success = await deleteMessage(messageId);
    if (success) {
      setMessages(prev => prev.filter(msg => msg.id !== messageId));
    } else {
      showNotice('error', t('errorTitle', lang), t('chatDeleteMessageFailed', lang));
    }
  };

  const hideMessageActions = React.useCallback(() => {
    Animated.parallel([
      Animated.timing(messageActionsOpacity, {
        toValue: 0,
        duration: 160,
        useNativeDriver: true,
      }),
      Animated.timing(messageActionsTranslateY, {
        toValue: 30,
        duration: 160,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setShowMessageActions(false);
    });
  }, [messageActionsOpacity, messageActionsTranslateY]);

  const showMessageActionsSheet = React.useCallback(() => {
    setShowMessageActions(true);

    // Haptics on open
    if (Platform.OS === 'ios') {
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch { Vibration.vibrate(5); }
    } else {
      Vibration.vibrate(30);
    }

    messageActionsOpacity.setValue(0);
    messageActionsTranslateY.setValue(30);
    Animated.parallel([
      Animated.timing(messageActionsOpacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.timing(messageActionsTranslateY, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start();
  }, [messageActionsOpacity, messageActionsTranslateY]);

  const confirmDeleteSelectedMessage = React.useCallback((m: any) => {
    if (!m?.id) return;
    // Закрываем нижний sheet (если открыт), чтобы не было наложений
    try { hideMessageActions(); } catch {}
    pendingDeleteRef.current = m;
    setDeleteConfirmVisible(true);
  }, [deleteSingleMessage]);

  const copySelectedMessage = React.useCallback(async (m: any) => {
    const type = String(m?.type || '').trim();
    const text = String(m?.text ?? '').trim();
    const rawUri = String(m?.uri ?? '').trim();

    const value =
      text ||
      ((type === 'image' || type === 'audio') && rawUri ? resolveMediaUri(rawUri) : '');

    if (!value) return;
    try {
      await Clipboard.setStringAsync(value);
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    } catch {}
  }, [resolveMediaUri]);

  const showForwardToastBadge = React.useCallback((ok: boolean, text: string) => {
    setForwardToast({ visible: true, ok, text });
    forwardToastOpacity.setValue(0);
    Animated.timing(forwardToastOpacity, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
    setTimeout(() => {
      Animated.timing(forwardToastOpacity, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }).start(() => {
        setForwardToast((p) => ({ ...p, visible: false }));
      });
    }, 1400);
  }, [forwardToastOpacity]);

  const openForwardPicker = React.useCallback(async () => {
    setShowForwardPicker(true);
    setForwardLoading(true);
    try {
      // Грузим ВСЕХ друзей (страницами), чтобы список был полный
      const all: any[] = [];
      const seen = new Set<string>();
      let page = 1;
      const limit = 50;
      // Safety cap: не зацикливаться, если сервер вернул некорректную пагинацию
      for (let i = 0; i < 20; i++) {
        const res: any = await fetchFriends(page, limit);
        const list = Array.isArray(res?.list) ? res.list : [];
        for (const f of list) {
          const id = String(f?._id || '').trim();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          all.push(f);
        }
        const hasMore = !!res?.pagination?.hasMore;
        if (!hasMore || list.length === 0) break;
        page += 1;
      }
      setForwardFriends(all);
    } catch {
      setForwardFriends([]);
    } finally {
      setForwardLoading(false);
    }
  }, []);

  const forwardSelectedMessageTo = React.useCallback(async (friend: any) => {
    try {
      const to = String(friend?._id || '').trim();
      if (!to) return;

      setShowForwardPicker(false);
      hideMessageActions();

      const normalizeForwardMediaUri = (u: string) => {
        const resolved = resolveMediaUri(u);
        // локальные file:// нельзя пересылать
        if (/^file:\/\//i.test(resolved)) return '';
        return resolved;
      };

      // Если включён режим выбора — пересылаем все выбранные сообщения (текст + медиа)
      if (selectionMode) {
        const selected = messages.filter((m) => selectedMessageIds.has(String(m?.id || '')));

        const forwardables: any[] = [];
        for (const m of selected) {
          const type = String(m?.type || '').trim();
          if (type === 'text') {
            const txt = String(m?.text || '').trim();
            if (txt) forwardables.push({ type: 'text', text: txt });
          } else if (type === 'image') {
            const rawUri = String(m?.uri || '').trim();
            const uri = rawUri ? normalizeForwardMediaUri(rawUri) : '';
            if (uri) forwardables.push({ type: 'image', uri, name: m?.name, size: m?.size });
          } else if (type === 'audio') {
            const rawUri = String(m?.uri || '').trim();
            const uri = rawUri ? normalizeForwardMediaUri(rawUri) : '';
            if (uri) forwardables.push({ type: 'audio', uri, name: m?.name, size: m?.size, duration: m?.duration });
          }
        }

        if (forwardables.length === 0) {
          setNoticeKind('info');
          setNoticeTitle('Пересылка');
          setNoticeMessage('Нет подходящих сообщений для пересылки.');
          setNoticeVisible(true);
          return;
        }

        let okCount = 0;
        for (const payload of forwardables) {
          const r: any = await sendSocketMessage({ to, ...payload });
          if (r?.ok) okCount += 1;
        }

        setSelectionMode(false);
        setSelectedMessageIds(new Set());
        showForwardToastBadge(okCount > 0, okCount > 0 ? 'Отправлено' : 'Не удалось отправить');
        return;
      }

      // Обычный режим — пересылаем одно выбранное сообщение
      const type = String(selectedMessage?.type || '').trim();
      if (type === 'text') {
        const txt = String(selectedMessage?.text ?? '').trim();
        if (!txt) return;
        const r: any = await sendSocketMessage({ to, text: txt, type: 'text' });
        showForwardToastBadge(!!r?.ok, r?.ok ? 'Отправлено' : 'Не удалось отправить');
        return;
      }
      if (type === 'image') {
        const rawUri = String(selectedMessage?.uri ?? '').trim();
        const uri = rawUri ? normalizeForwardMediaUri(rawUri) : '';
        if (!uri) {
          setNoticeKind('info');
          setNoticeTitle('Пересылка');
          setNoticeMessage('Это изображение ещё не готово для пересылки.');
          setNoticeVisible(true);
          return;
        }
        const r: any = await sendSocketMessage({
          to,
          type: 'image',
          uri,
          name: selectedMessage?.name,
          size: selectedMessage?.size,
        });
        showForwardToastBadge(!!r?.ok, r?.ok ? 'Отправлено' : 'Не удалось отправить');
        return;
      }
      if (type === 'audio') {
        const rawUri = String(selectedMessage?.uri ?? '').trim();
        const uri = rawUri ? normalizeForwardMediaUri(rawUri) : '';
        if (!uri) {
          setNoticeKind('info');
          setNoticeTitle('Пересылка');
          setNoticeMessage('Это голосовое ещё не готово для пересылки.');
          setNoticeVisible(true);
          return;
        }
        const r: any = await sendSocketMessage({
          to,
          type: 'audio',
          uri,
          name: selectedMessage?.name,
          size: selectedMessage?.size,
          duration: selectedMessage?.duration,
        });
        showForwardToastBadge(!!r?.ok, r?.ok ? 'Отправлено' : 'Не удалось отправить');
        return;
      }
    } catch {}
  }, [selectedMessage, hideMessageActions, showForwardToastBadge, selectionMode, messages, selectedMessageIds, resolveMediaUri]);

  const exitSelectionMode = React.useCallback(() => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, []);

  const toggleSelectMessage = React.useCallback((id: string) => {
    const mid = String(id || '').trim();
    if (!mid) return;
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(mid)) next.delete(mid);
      else next.add(mid);
      return next;
    });
  }, []);

  const enterSelectionModeFromMessage = React.useCallback((m: any) => {
    const mid = String(m?.id || '').trim();
    setSelectionMode(true);
    setSelectedMessageIds(() => {
      const next = new Set<string>();
      if (mid) next.add(mid);
      return next;
    });
    // Закрываем sheet, если он был открыт
    try { hideMessageActions(); } catch {}
  }, [hideMessageActions]);

  const closeDeleteConfirm = React.useCallback(() => {
    setDeleteConfirmVisible(false);
    pendingDeleteRef.current = null;
  }, []);

  const confirmDeleteNow = React.useCallback(() => {
    const m = pendingDeleteRef.current;
    const id = String(m?.id || '').trim();
    setDeleteConfirmVisible(false);
    pendingDeleteRef.current = null;
    if (!id) return;
    void deleteSingleMessage(id);
  }, [deleteSingleMessage]);

  const closeNotice = React.useCallback(() => {
    setNoticeVisible(false);
  }, []);

  const showNotice = React.useCallback(
    (kind: 'error' | 'info', title: string, message: string) => {
      setNoticeKind(kind);
      setNoticeTitle(title);
      setNoticeMessage(message);
      setNoticeVisible(true);
    },
    [],
  );

  const openConfirm = React.useCallback(
    (opts: {
      title: string;
      message: string;
      okText: string;
      cancelText: string;
      destructive?: boolean;
      onConfirm: () => void;
    }) => {
      setConfirmTitle(opts.title);
      setConfirmMessage(opts.message);
      setConfirmOkText(opts.okText);
      setConfirmCancelText(opts.cancelText);
      setConfirmDestructive(!!opts.destructive);
      onConfirmRef.current = opts.onConfirm;
      setConfirmVisible(true);
    },
    [],
  );

  const closeConfirm = React.useCallback(() => {
    setConfirmVisible(false);
    onConfirmRef.current = null;
  }, []);

  const runConfirm = React.useCallback(() => {
    const fn = onConfirmRef.current;
    setConfirmVisible(false);
    onConfirmRef.current = null;
    try { fn?.(); } catch {}
  }, []);

  const selectedCount = selectedMessageIds.size;
  const selectedHasAnyForwardable = React.useMemo(() => {
    if (!selectionMode || selectedMessageIds.size === 0) return false;
    // Пересылаем текст и медиа
    for (const m of messages) {
      const id = String(m?.id || '').trim();
      if (!id) continue;
      if (!selectedMessageIds.has(id)) continue;
      const type = String(m?.type || '').trim();
      if (type === 'text' && String(m?.text || '').trim()) return true;
      if (type === 'image' && String(m?.uri || '').trim()) return true;
      if (type === 'audio' && String(m?.uri || '').trim()) return true;
    }
    return false;
  }, [selectionMode, selectedMessageIds, messages]);

  const selectAllLoaded = React.useCallback(() => {
    setSelectedMessageIds(new Set(messages.map((m) => String(m?.id || '')).filter(Boolean)));
  }, [messages]);

  const batchDeleteSelected = React.useCallback(async () => {
    const ids = Array.from(selectedMessageIds);
    if (ids.length === 0) return;

    const idSet = new Set(ids.map((x) => String(x)));

    // Optimistic UI: remove all selected messages at once (no sequential "one-by-one" deletion).
    let beforeMessages: any[] = [];
    setMessages((prev) => {
      beforeMessages = prev;
      return prev.filter((mm) => !idSet.has(String(mm?.id || '')));
    });

    // IMPORTANT: delete requests sequentially (emitAck/socket acks are not guaranteed to be concurrency-safe).
    // UI is already updated optimistically above, so user still sees "all deleted at once".
    const failed: string[] = [];
    for (const id of ids) {
      try {
        const mid = String(id);
        const ok = await deleteMessage(mid);
        if (!ok) failed.push(mid);
      } catch {
        failed.push(String(id));
      }
    }

    if (failed.length === 0) {
      exitSelectionMode();
      showForwardToastBadge(true, 'Удалено');
      return;
    }

    // Restore failed items (keep successful deletions applied)
    const succeededSet = new Set(ids.map(String).filter((id) => !failed.includes(id)));
    setMessages(() => beforeMessages.filter((mm) => !succeededSet.has(String(mm?.id))));

    // Оставляем выделенными только те, что не удалились (можно повторить)
    setSelectedMessageIds(new Set(failed));
    showNotice('error', t('errorTitle', lang), `Не удалось удалить: ${failed.length}`);
  }, [selectedMessageIds, exitSelectionMode, showForwardToastBadge, showNotice, lang]);

  const confirmDeleteSelected = React.useCallback(() => {
    if (selectedCount === 0) return;
    openConfirm({
      title: 'Удалить сообщения?',
      message: selectedCount === 1 ? 'Удалить выбранное сообщение?' : `Удалить выбранные сообщения: ${selectedCount}?`,
      okText: 'Удалить',
      cancelText: 'Отмена',
      destructive: true,
      onConfirm: () => {
        void batchDeleteSelected();
      },
    });
  }, [selectedCount, openConfirm, batchDeleteSelected]);

  const startForwardSelected = React.useCallback(() => {
    if (selectedCount === 0) return;
    if (!selectedHasAnyForwardable) {
      showNotice('info', 'Пересылка', 'Можно переслать только текстовые сообщения, изображения или голосовые.');
      return;
    }
    void openForwardPicker();
  }, [selectedCount, selectedHasAnyForwardable, showNotice, openForwardPicker]);

  // КРИТИЧНО: Header нельзя объявлять как "новую функцию" на каждый рендер,
  // иначе шапка (и аватар) будут размонтироваться на каждый ввод в TextInput.
  const Header = React.useCallback(() => (
    <View
      style={{
        height: headerH,
        backgroundColor: LIVI.bg,
        borderBottomWidth: BORDER_WIDTH,
        borderBottomColor: BORDER_COLOR,
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 12,
      }}
    >
      <TouchableOpacity
        onPress={() => {
          if (selectionMode) exitSelectionMode();
          else navigation.goBack();
        }}
        activeOpacity={0.85}
        style={{
          width: 36,
          height: 36,
          borderRadius: 14,
          backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
          borderColor: (theme.colors?.outline as string) || 'rgba(0,0,0,0.12)',
          borderWidth: 1,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name={selectionMode ? "close" : "arrow-back"} size={20} color={LIVI.titan} />
      </TouchableOpacity>

      <View style={{ flex: 1, alignItems: "center" }}>
        <Text style={{ color: LIVI.white, fontSize: 18, fontWeight: "700" }}>
          {selectionMode ? `Выбрано: ${selectedCount}` : peerNameState}
        </Text>
        {!selectionMode && (
          <Text style={{ marginTop: 2, fontSize: 12, color: peerOnline ? LIVI.green : LIVI.red, fontWeight: "500" }}>
            {peerOnline ? t('online', lang) : t('offline', lang)}
          </Text>
        )}
      </View>

      {selectionMode ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <TouchableOpacity
            onPress={selectAllLoaded}
            activeOpacity={0.85}
            style={{
              height: 36,
              paddingHorizontal: 10,
              borderRadius: 14,
              backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
              borderColor: (theme.colors?.outline as string) || 'rgba(0,0,0,0.12)',
              borderWidth: 1,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: LIVI.titan, fontSize: 13, fontWeight: '600' }}>Все</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={startForwardSelected}
            activeOpacity={0.85}
            style={{
              width: 36,
              height: 36,
              borderRadius: 14,
              backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
              borderColor: (theme.colors?.outline as string) || 'rgba(0,0,0,0.12)',
              borderWidth: 1,
              alignItems: "center",
              justifyContent: "center",
              opacity: selectedCount === 0 ? 0.45 : 1,
            }}
          >
            <Ionicons name="paper-plane-outline" size={18} color={LIVI.titan} />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={confirmDeleteSelected}
            activeOpacity={0.85}
            style={{
              width: 36,
              height: 36,
              borderRadius: 14,
              backgroundColor: isDark ? "rgba(255,90,103,0.14)" : "rgba(255,90,103,0.12)",
              borderColor: 'rgba(255,90,103,0.35)',
              borderWidth: 1,
              alignItems: "center",
              justifyContent: "center",
              opacity: selectedCount === 0 ? 0.45 : 1,
            }}
          >
            <Ionicons name="trash-outline" size={18} color="#FF5A67" />
          </TouchableOpacity>
        </View>
      ) : (
        <AvatarImage
          userId={peerId}
          avatarVer={peerAvatarVerState}
          uri={fullAvatarUri || undefined}
          size={36}
          fallbackText={headerInitial}
          // If no avatar: match back button background + 1px outline
          containerStyle={
            fullAvatarUri
              ? undefined
              : {
                  backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)',
                  borderWidth: 1,
                  borderColor: (theme.colors?.outline as string) || 'rgba(0,0,0,0.12)',
                }
          }
        />
      )}
    </View>
  ), [
    headerH,
    LIVI.bg,
    LIVI.white,
    LIVI.titan,
    LIVI.green,
    LIVI.red,
    BORDER_WIDTH,
    BORDER_COLOR,
    navigation,
    isDark,
    (theme.colors?.outline as string) || 'rgba(0,0,0,0.12)',
    peerNameState,
    peerOnline,
    peerId,
    peerAvatarVerState,
    fullAvatarUri,
    headerInitial,
    selectionMode,
    selectedCount,
    exitSelectionMode,
    selectAllLoaded,
    startForwardSelected,
    confirmDeleteSelected,
  ]);

  // Stable handler to avoid re-rendering all MessageItem rows on parent re-renders
  const handleLongPressMessage = React.useCallback(
    (m: any) => {
      setSelectedMessage(m);

      const options = ['Копировать', 'Переслать', 'Выбрать', 'Удалить', 'Отмена'];

      const cancelButtonIndex = options.length - 1;
      const destructiveButtonIndex = options.indexOf('Удалить');

      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options,
            cancelButtonIndex,
            destructiveButtonIndex,
            userInterfaceStyle: 'dark',
          },
          (buttonIndex) => {
            const picked = options[buttonIndex];
            if (picked === 'Отмена') return;
            if (picked === 'Удалить') return confirmDeleteSelectedMessage(m);
            if (picked === 'Копировать') return void copySelectedMessage(m);
            if (picked === 'Переслать') return void openForwardPicker();
            if (picked === 'Выбрать') return void enterSelectionModeFromMessage(m);
          }
        );
        return;
      }

      // Android: custom bottom sheet (чтобы не перекрывать экран большой модалкой)
      showMessageActionsSheet();
    },
    [confirmDeleteSelectedMessage, copySelectedMessage, openForwardPicker, showMessageActionsSheet]
  );

  // Функция для получения анимации сообщения (стабильная ссылка, чтобы не ломать мемоизацию)
  const getMessageAnimation = React.useCallback((messageId: string) => {
    if (!messagePressAnimations[messageId]) {
      messagePressAnimations[messageId] = new Animated.Value(1);
    }
    return messagePressAnimations[messageId];
  }, [messagePressAnimations]);

  // Функция для анимации нажатия на сообщение
  const animateMessagePress = React.useCallback((messageId: string, callback?: () => void) => {
    const animation = getMessageAnimation(messageId);
    
    // Тактильная обратная связь
    if (Platform.OS === 'ios') {
      // Используем мягкую вибрацию для iOS
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch (error) {
        // Fallback на обычную вибрацию если Haptics недоступен
        Vibration.vibrate(3);
      }
    } else {
      Vibration.vibrate(25); // Мягкая вибрация для Android
    }
    
    // Анимация сжатия
    Animated.sequence([
      Animated.timing(animation, {
        toValue: 0.95,
        duration: 100,
        useNativeDriver: true,
      }),
      Animated.timing(animation, {
        toValue: 1,
        duration: 100,
        useNativeDriver: true,
      }),
    ]).start(() => {
      if (callback) callback();
    });
  }, [getMessageAnimation]);

  const sendMessage = async () => {
    if (!messageText.trim() || !currentUserId) return;
    
    
    const messageToSend = messageText.trim();
    setMessageText(""); // Очищаем поле сразу
    // Если отправили сообщение — прекращаем "typing"
    stopLocalTyping();
    
    // Добавляем сообщение локально
    const messageId = Date.now().toString();
    const newMessage = {
      id: messageId,
      text: messageToSend,
      sender: 'me',
      from: currentUserId,
      to: peerId,
      timestamp: new Date(),
      type: 'text',
    };
    
    const updatedMessages = [...messages, newMessage];
    setMessages(updatedMessages);
    
    // Сохраняем сообщения в AsyncStorage
    saveMessages(updatedMessages);
    
    
    // Статус "отправляется" (пока нет птичек)
    updateReadStatuses(prev => ({ ...prev, [messageId]: 'sending' }));
    
    // Отправляем через сокеты
    try {
      const result = await sendSocketMessage({
        to: peerId,
        text: messageToSend,
        type: 'text'
      });
      
      if (result.ok) {
        // Очищаем кэш для обновления сообщений с правильными полями
        clearMessageCache(peerId, currentUserId);

        // Определяем статус доставки
        const deliveryStatus = result.delivered ? 'delivered' : 'sent';

        // Сразу ставим статус доставки
        updateReadStatuses(prev => ({
          ...prev,
          [messageId]: deliveryStatus
        }));

        // ВСЕГДА обновляем ID если сервер вернул messageId
        if (result.messageId) {
          if (result.messageId !== messageId) {
            // Обновляем ID сообщения на реальный от сервера
            setMessages(prev => {
              const updated = prev.map(msg => 
                msg.id === messageId 
                  ? { ...msg, id: result.messageId!, from: currentUserId, to: peerId }
                  : msg
              );
              saveMessages(updated);
              return updated;
            });
            
            // Переносим статус на новый ID
            updateReadStatuses(prev => {
              const newStatuses = { ...prev };
              newStatuses[result.messageId!] = deliveryStatus;
              delete newStatuses[messageId]; // Убираем старый ID
              return newStatuses;
            });
          } else {
            // ID не изменился, просто обновляем статус
            updateReadStatuses(prev => ({
              ...prev,
              [messageId]: deliveryStatus
            }));
          }
        } else {
          // Нет messageId от сервера - оставляем как есть
          updateReadStatuses(prev => ({
            ...prev,
            [messageId]: deliveryStatus
          }));
        }
      } else {
        throw new Error(result.error || 'Failed to send message');
      }
      
    } catch (e) {
      console.error('❌ Failed to send via socket:', e);
      // Помечаем сообщение как неотправленное
      updateReadStatuses(prev => ({
        ...prev,
        [messageId]: 'failed'
      }));
      setUploadStatus(prev => ({ ...prev, [messageId]: 'failed' }));
    }
  };

  const handleAttachments = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [
            t('takePhoto', lang),
            t('chooseFromGallery', lang),
            t('cancel', lang)
          ],
          cancelButtonIndex: 2,
          userInterfaceStyle: 'dark'
        },
        (buttonIndex) => {
          switch (buttonIndex) {
            case 0:
              handleCamera();
              break;
            case 1:
              handleImagePicker();
              break;
          }
        }
      );
    } else {
      setShowAttachSheet(true);
    }
  };

  const VOICE_MAX_MS = 60_000;
  // Swipe-left cancel with hysteresis (more stable on Android)
  const VOICE_CANCEL_ARM_DX = -22;     // more sensitive
  const VOICE_CANCEL_DISARM_DX = -10;  // keeps it armed unless user clearly returns
  const VOICE_TRASH_PAD = 18;          // hit zone padding around trash icon (px)

  const updateTrashZone = React.useCallback(() => {
    try {
      const node: any = trashMeasureRef.current;
      if (!node?.measureInWindow) return;
      node.measureInWindow((x: number, y: number, w: number, h: number) => {
        trashZoneRef.current = { x, y, w, h };
      });
    } catch {}
  }, []);

  const isInTrashZone = React.useCallback((moveX: number, moveY: number) => {
    const z = trashZoneRef.current;
    if (!z) return false;
    return (
      moveX >= (z.x - VOICE_TRASH_PAD) &&
      moveX <= (z.x + z.w + VOICE_TRASH_PAD) &&
      moveY >= (z.y - VOICE_TRASH_PAD) &&
      moveY <= (z.y + z.h + VOICE_TRASH_PAD)
    );
  }, []);

  const resetVoiceGesture = React.useCallback(() => {
    cancelArmedRef.current = false;
    voiceCancelTriggeredRef.current = false;
    try { voiceDragX.setValue(0); } catch {}
    try { trashLid.setValue(0); } catch {}
    try { trashFlash.setValue(0); } catch {}
    Animated.timing(micScale, { toValue: 1, duration: 90, useNativeDriver: true }).start();
  }, [voiceDragX, trashLid, trashFlash, micScale]);

  const armCancelUI = React.useCallback(() => {
    if (cancelArmedRef.current) return;
    cancelArmedRef.current = true;
    Animated.parallel([
      Animated.timing(trashLid, { toValue: 1, duration: 140, useNativeDriver: true }),
      Animated.sequence([
        Animated.timing(trashFlash, { toValue: 1, duration: 90, useNativeDriver: true }),
        Animated.timing(trashFlash, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]),
    ]).start();
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
  }, [trashLid, trashFlash]);

  const disarmCancelUI = React.useCallback(() => {
    if (!cancelArmedRef.current) return;
    cancelArmedRef.current = false;
    Animated.timing(trashLid, { toValue: 0, duration: 120, useNativeDriver: true }).start();
  }, [trashLid]);

  const sendVoiceMessageFromLocal = React.useCallback(async (localUri: string, durationMs: number, size?: number) => {
    if (!currentUserId || !peerId) return;

    const messageId = Date.now().toString();
    const durationSec = Math.max(1, Math.round(durationMs / 1000));
    const name = `voice_${Date.now()}.m4a`;
    const localFileForCleanup = String(localUri || '');

    const newMessage = {
      id: messageId,
      type: 'audio',
      uri: localUri,
      name,
      size: size || 0,
      duration: durationSec,
      sender: 'me',
      from: currentUserId,
      to: peerId,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, newMessage]);
    updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));

    try {
      setUploadStatus((prev) => ({ ...prev, [messageId]: 'sending' }));
      const uploadResult = await uploadMediaToServer(localUri, 'audio', undefined, currentUserId, peerId);
      if (!uploadResult.success || !uploadResult.url) {
        updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
        setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
        return;
      }

      const socketResult: any = await sendSocketMessage({
        to: peerId,
        type: 'audio',
        uri: uploadResult.url,
        name,
        size,
        duration: durationSec,
      });

      if (socketResult?.ok && socketResult?.messageId) {
        setMessages((prev) => {
          const updated = prev.map((msg: any) =>
            msg.id === messageId
              ? { ...msg, id: socketResult.messageId!, uri: resolveMediaUri(uploadResult.url), from: currentUserId, to: peerId }
              : msg
          );
          saveMessages(updated);
          return updated;
        });

        setUploadStatus((prev) => {
          const next = { ...prev };
          next[socketResult.messageId!] = 'sent';
          delete next[messageId];
          return next;
        });

        updateReadStatuses((prev) => {
          const next = { ...prev };
          const delivery = socketResult.delivered ? 'delivered' : 'sent';
          next[socketResult.messageId!] = delivery;
          delete next[messageId];
          return next;
        });

        // cleanup recorded file only after successful send
        try { await FileSystem.deleteAsync(localFileForCleanup, { idempotent: true }); } catch {}
      } else {
        updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
        setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
      }
    } catch {
      updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
      setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
    } finally {
      setVoiceRecordMs(0);
    }
  }, [currentUserId, peerId, resolveMediaUri, updateReadStatuses, saveMessages]);

  const startVoiceRecording = React.useCallback(async () => {
    try {
      if (voiceIsRecording) return;
      if (!currentUserId || !peerId) return;
      if (selectionMode) return; // avoid accidental recording in select mode
      resetVoiceGesture();

      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        showNotice('error', t('errorTitle', lang), 'Нужно разрешение на микрофон.');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        // IMPORTANT: allow OS routing to headset/Bluetooth; do not force speaker
        playThroughEarpieceAndroid: true,
        staysActiveInBackground: false,
      });

      const recording = new Audio.Recording();
      voiceRecordingRef.current = recording;
      voiceStopInProgressRef.current = false;
      setVoiceRecordMs(0);
      setVoiceIsRecording(true);

      await recording.prepareToRecordAsync({
        android: {
          extension: '.m4a',
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 96000,
        },
        ios: {
          extension: '.m4a',
          audioQuality: Audio.IOSAudioQuality.HIGH,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 96000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: undefined as any,
        isMeteringEnabled: false,
      } as any);

      await recording.startAsync();
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch {}

      if (voiceRecordTimerRef.current) clearInterval(voiceRecordTimerRef.current);
      voiceRecordTimerRef.current = setInterval(async () => {
        try {
          const rec = voiceRecordingRef.current;
          if (!rec) return;
          const st: any = await rec.getStatusAsync();
          const ms = Number(st?.durationMillis || 0);
          setVoiceRecordMs(ms);
          if (ms >= VOICE_MAX_MS) {
            void stopVoiceRecording(false, true);
          }
        } catch {}
      }, 160);
    } catch {
      setVoiceIsRecording(false);
      voiceRecordingRef.current = null;
    }
  }, [voiceIsRecording, currentUserId, peerId, selectionMode, resetVoiceGesture, showNotice, lang]);

  const stopVoiceRecording = React.useCallback(async (cancelled?: boolean, autoStopped?: boolean) => {
    if (voiceStopInProgressRef.current) return;
    const rec = voiceRecordingRef.current;
    if (!rec) return;

    voiceStopInProgressRef.current = true;
    voiceRecordingRef.current = null;
    setVoiceIsRecording(false);

    try { if (voiceRecordTimerRef.current) clearInterval(voiceRecordTimerRef.current); } catch {}
    voiceRecordTimerRef.current = null;

    try {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI() || '';
      const st: any = await rec.getStatusAsync().catch(() => null);
      const durationMs = Number(st?.durationMillis || voiceRecordMs || 0);

      // Very short taps shouldn't create a voice message
      if (!uri || durationMs < 600) {
        if (uri) {
          try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
        }
        setVoiceRecordMs(0);
        return;
      }

      const info = await FileSystem.getInfoAsync(uri).catch(() => null as any);
      const size = typeof info?.size === 'number' ? Number(info.size) : undefined;
      if (cancelled || voiceCancelTriggeredRef.current) {
        // cancel: throw away the recording
        try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
        setVoiceRecordMs(0);
        return;
      }

      if (autoStopped) {
        try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch {}
      } else {
        try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      }

      // release -> send immediately
      await sendVoiceMessageFromLocal(uri, durationMs, size);
    } catch {
      // ignore
    } finally {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          // IMPORTANT: allow OS routing to headset/Bluetooth; do not force speaker
          playThroughEarpieceAndroid: true,
          staysActiveInBackground: false,
        });
      } catch {}
      voiceStopInProgressRef.current = false;
      resetVoiceGesture();
    }
  }, [voiceRecordMs, sendVoiceMessageFromLocal, resetVoiceGesture]);

  const cancelVoiceRecordingWithAnimation = React.useCallback(async () => {
    if (voiceCancelTriggeredRef.current) return;
    voiceCancelTriggeredRef.current = true;

    // Open lid and "throw" to left
    Animated.parallel([
      Animated.timing(trashLid, { toValue: 1, duration: 120, useNativeDriver: true }),
      Animated.timing(voiceDragX, { toValue: -120, duration: 140, useNativeDriver: true }),
      Animated.sequence([
        Animated.timing(trashFlash, { toValue: 1, duration: 90, useNativeDriver: true }),
        Animated.timing(trashFlash, { toValue: 0, duration: 220, useNativeDriver: true }),
      ]),
    ]).start(() => {
      Animated.timing(trashLid, { toValue: 0, duration: 180, useNativeDriver: true }).start();
    });

    try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch {}
    await stopVoiceRecording(true, false);
    showForwardToastBadge(false, 'Удалено');
  }, [trashLid, trashFlash, voiceDragX, stopVoiceRecording, showForwardToastBadge]);

  const micPanResponder = React.useMemo(() => {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: (_evt, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
      onMoveShouldSetPanResponderCapture: (_evt, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        Animated.timing(micScale, { toValue: 0.92, duration: 90, useNativeDriver: true }).start();
        // snapshot start point (helps debug / stability)
        try {
          voiceStartXRef.current = 0;
          voiceStartYRef.current = 0;
        } catch {}
        // measure trash zone after it renders
        setTimeout(() => updateTrashZone(), 0);
        void startVoiceRecording();
      },
      onPanResponderMove: (_evt, gestureState) => {
        if (!voiceIsRecording) return;
        const dx = Math.min(0, Math.max(-120, gestureState.dx));
        voiceDragX.setValue(dx);
        const inZone = isInTrashZone(Number(gestureState.moveX || 0), Number(gestureState.moveY || 0));
        if (inZone) {
          armCancelUI();
          return;
        }
        // fallback dx hysteresis
        if (!cancelArmedRef.current) {
          if (dx <= VOICE_CANCEL_ARM_DX) armCancelUI();
        } else {
          if (dx >= VOICE_CANCEL_DISARM_DX) disarmCancelUI();
        }
      },
      onPanResponderRelease: async (_evt, gestureState) => {
        Animated.timing(micScale, { toValue: 1, duration: 90, useNativeDriver: true }).start();
        if (!voiceIsRecording) {
          resetVoiceGesture();
          return;
        }
        const dx = Math.min(0, Math.max(-120, gestureState.dx));
        const inZone = isInTrashZone(Number(gestureState.moveX || 0), Number(gestureState.moveY || 0));
        if (inZone || dx <= VOICE_CANCEL_ARM_DX || cancelArmedRef.current) {
          await cancelVoiceRecordingWithAnimation();
          return;
        }
        await stopVoiceRecording(false, false);
      },
      onPanResponderTerminate: async () => {
        Animated.timing(micScale, { toValue: 1, duration: 90, useNativeDriver: true }).start();
        if (voiceIsRecording) {
          await stopVoiceRecording(true, false);
        }
        resetVoiceGesture();
      },
    });
  }, [PanResponder, micScale, startVoiceRecording, voiceIsRecording, voiceDragX, armCancelUI, disarmCancelUI, resetVoiceGesture, stopVoiceRecording, cancelVoiceRecordingWithAnimation, isInTrashZone, updateTrashZone]);

  const sendPickedImage = React.useCallback(async (asset: any) => {
    if (!currentUserId || !peerId) return;

    const messageId = Date.now().toString();
    const messageType = 'image';

    const localUri = asset?.uri;
    const fileName = asset?.fileName || `file_${Date.now()}`;
    const fileSize = asset?.fileSize || 0;

    const newMessage = {
      id: messageId,
      type: messageType,
      uri: localUri,
      name: fileName,
      size: fileSize,
      sender: 'me',
      from: currentUserId,
      to: peerId,
      timestamp: new Date(),
    };

    setMessages((prev) => {
      const existingMessage = prev.find((msg) => msg.id === messageId);
      if (existingMessage) return prev;
      return [...prev, newMessage];
    });

    updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));

    try {
      setUploadStatus((prev) => ({ ...prev, [messageId]: 'sending' }));

      const uploadResult = await uploadMediaToServer(localUri, messageType, undefined, currentUserId, peerId);
      if (!uploadResult.success || !uploadResult.url) {
        console.error('❌ Media upload failed:', uploadResult.error);
        updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
        setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
        return;
      }

      const socketResult = await sendSocketMessage({
        to: peerId,
        type: messageType,
        uri: uploadResult.url,
        name: fileName || undefined,
        size: fileSize || undefined,
      });

      if (socketResult.ok && socketResult.messageId) {
        setMessages((prev) => {
          const updated = prev.map((msg) =>
            msg.id === messageId ? { ...msg, id: socketResult.messageId!, uri: resolveMediaUri(uploadResult.url), from: currentUserId, to: peerId } : msg
          );
          saveMessages(updated);
          return updated;
        });

        setUploadStatus((prev) => {
          const newStatus = { ...prev };
          newStatus[socketResult.messageId!] = 'sent';
          delete newStatus[messageId];
          return newStatus;
        });

        updateReadStatuses((prev) => {
          const newStatuses = { ...prev };
          const delivery = socketResult.delivered ? 'delivered' : 'sent';
          newStatuses[socketResult.messageId!] = delivery;
          delete newStatuses[messageId];
          return newStatuses;
        });
      } else {
        console.warn('❌ Socket send failed:', socketResult);
        updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
        setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
      }
    } catch (e) {
      console.error('Failed to upload and send media:', e);
      updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
      setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
    }
  }, [currentUserId, peerId, updateReadStatuses, saveMessages, resolveMediaUri]);

  const openComposeViewer = React.useCallback((asset: any) => {
    setComposeAsset(asset);
    setComposeViewerVisible(true);
  }, []);

  const handleCamera = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        showNotice('error', t('errorTitle', lang), t('needCameraPermission', lang));
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        // Не обрезаем принудительно: даём предпросмотр и возможность обрезать/не обрезать
        allowsEditing: false,
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        openComposeViewer(asset);
      }
    } catch (error) {
      console.error('Camera error:', error);
      showNotice('error', t('errorTitle', lang), t('takePhotoFailed', lang));
    }
  };

  const handleImagePicker = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        showNotice('error', t('errorTitle', lang), t('needGalleryPermission', lang));
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        // Не обрезаем принудительно: даём предпросмотр и возможность обрезать/не обрезать
        allowsEditing: false,
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        openComposeViewer(asset);
      }
    } catch (error) {
      console.error('Image picker error:', error);
      showNotice('error', t('errorTitle', lang), t('pickImageFailed', lang));
    }
  };


  // КРИТИЧНО: если MessageItem создаётся внутри ChatScreen без мемоизации типа компонента,
  // то при каждом setMessageText FlatList будет размонтировать/монтировать все элементы -> мерцание всех картинок.
  const MessageItem = React.useMemo(() => React.memo(({ item, currentUserId, readStatus, uploadStatus, onPressImage, onPressAudio, playingAudioId, playingAudioState, onLongPressMessage, selectionMode, isSelected, onToggleSelect, retryUiForId, onToggleRetryUi, onRetryFailed }: any) => {
    const [imageLoadError, setImageLoadError] = React.useState(false);
    const [localImageUri, setLocalImageUri] = React.useState<string | null>(null);
    const [isDownloading, setIsDownloading] = React.useState(false);
    const effectiveReadStatus = readStatus; // 'sending' | 'delivered' | 'read' | 'failed' | 'sent'
    // Fallback логика для определения отправителя если поле sender отсутствует
    let isMyMessage = item.sender === 'me';
    if (item.sender === undefined || item.sender === null) {
      isMyMessage = item.from === currentUserId;
      // оставляем только предупреждение, без лишних деталей
      console.warn('Message without sender field: using fallback');
    }

    const messageUploadStatus = uploadStatus || 'sent';
    
    // Сбрасываем ошибку и локальный URI при изменении URI
    React.useEffect(() => {
      setImageLoadError(false);
      setLocalImageUri(null);
      setIsDownloading(false);
    }, [item.uri]);
    
    // Функция для скачивания изображения через FileSystem (обходит ATS)
    const downloadImageViaFileSystem = React.useCallback(async (uri: string) => {
      if (isDownloading || localImageUri) return; // Уже скачивается или уже скачано
      
      setIsDownloading(true);
      try {
        const fileName = `image_${item.id}_${Date.now()}.jpg`;
        const targetUri = `${FileSystem.cacheDirectory}${fileName}`;
        
        logger.debug('[ChatScreen] MessageItem: downloading image via FileSystem', { 
          messageId: item.id, 
          sourceUri: uri,
          targetUri 
        });
        
        const downloadResult = await FileSystem.downloadAsync(uri, targetUri);
        
        if (downloadResult.uri) {
          logger.debug('[ChatScreen] MessageItem: image downloaded successfully', { 
            messageId: item.id, 
            localUri: downloadResult.uri 
          });
          setLocalImageUri(downloadResult.uri);
          setImageLoadError(false);
        } else {
          throw new Error('Download failed: no URI returned');
        }
      } catch (error: any) {
        logger.error('[ChatScreen] MessageItem: FileSystem download error', { 
          messageId: item.id, 
          uri, 
          error: error?.message || String(error) 
        });
        setImageLoadError(true);
      } finally {
        setIsDownloading(false);
      }
    }, [item.id, isDownloading, localImageUri]);

    const renderContent = () => {
      switch (item.type) {
        case 'image':
          const imageUri = resolveMediaUri(item.uri);
          if (!imageUri) {
            logger.warn('[ChatScreen] MessageItem: image URI is empty', { messageId: item.id, originalUri: item.uri });
            return (
              <View style={{
                width: 200,
                height: 150,
                backgroundColor: 'rgba(255,255,255,0.1)',
                borderRadius: 12,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.2)',
              }}>
                <Ionicons name="image-outline" size={32} color="rgba(255,255,255,0.5)" />
                <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, marginTop: 4 }}>Изображение недоступно</Text>
              </View>
            );
          }
          
          logger.debug('[ChatScreen] MessageItem: rendering image', { 
            messageId: item.id, 
            originalUri: item.uri, 
            resolvedUri: imageUri 
          });
          
          // Если была ошибка загрузки, показываем fallback UI
          if (imageLoadError) {
            return (
              <TouchableOpacity 
                style={{ 
                  position: 'relative',
                  backgroundColor: 'rgba(255,255,255,0.1)',
                  borderRadius: 12,
                  overflow: 'hidden',
                  marginBottom: 8,
                  width: 200,
                  height: 150,
                  borderWidth: 1,
                  borderColor: 'rgba(255,255,255,0.2)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                onPress={() => {
                  animateMessagePress(item.id, () => {
                    onPressImage('image', imageUri, item.name);
                  });
                }}
                onLongPress={() => {
                  animateMessagePress(item.id, () => {
                    onLongPressMessage(item);
                  });
                }}
                activeOpacity={0.9}
              >
                <Ionicons name="image-outline" size={40} color="rgba(255,255,255,0.5)" />
                <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 8, textAlign: 'center', paddingHorizontal: 8 }}>
                  Нажмите для просмотра
                </Text>
              </TouchableOpacity>
            );
          }
          
          return (
            <TouchableOpacity 
              style={{ 
                position: 'relative',
                backgroundColor: 'rgba(255,255,255,0.1)',
                borderRadius: 12,
                overflow: 'hidden',
                marginBottom: 8,
                width: 200,
                height: 150,
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.2)',
                shadowColor: '#000',
                shadowOffset: {
                  width: 0,
                  height: 2,
                },
                shadowOpacity: 0.1,
                shadowRadius: 4,
                elevation: 2,
              }}
              onPress={() => {
                animateMessagePress(item.id, () => {
                  onPressImage('image', imageUri, item.name);
                });
              }}
              onLongPress={() => {
                animateMessagePress(item.id, () => {
                  onLongPressMessage(item);
                });
              }}
              activeOpacity={0.9}
            >
              {isDownloading && (
                <View style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'rgba(0,0,0,0.3)',
                }}>
                  <ActivityIndicator size="small" color="#fff" />
                </View>
              )}
              <ExpoImage
                source={{ uri: localImageUri || imageUri }}
                style={{
                  width: '100%',
                  height: '100%',
                  backgroundColor: 'rgba(255,255,255,0.1)',
                }}
                contentFit="cover"
                cachePolicy="memory-disk"
                // КРИТИЧНО: на Android transition часто даёт мерцание в списках
                transition={Platform.OS === 'android' ? 0 : 200}
                recyclingKey={`message_image_${item.id}_${localImageUri ? 'local' : 'remote'}`}
                allowDownscaling={false}
                placeholder={null}
                onError={(error: any) => {
                  // КРИТИЧНО: Детальное логирование ошибки для диагностики
                  const errorDetails: any = {
                    messageId: item.id,
                    uri: imageUri,
                    originalUri: item.uri,
                    errorType: typeof error,
                    errorString: String(error),
                  };
                  
                  // Пытаемся извлечь больше информации об ошибке
                  try {
                    if (error?.nativeEvent) {
                      errorDetails.nativeEvent = error.nativeEvent;
                    }
                    if (error?.message) {
                      errorDetails.errorMessage = error.message;
                    }
                    if (error?.code) {
                      errorDetails.errorCode = error.code;
                    }
                    // Пытаемся сериализовать весь объект ошибки
                    const errorKeys = Object.keys(error || {});
                    if (errorKeys.length > 0) {
                      errorDetails.errorKeys = errorKeys;
                      errorDetails.errorValues = errorKeys.reduce((acc: any, key: string) => {
                        try {
                          acc[key] = String(error[key]);
                        } catch {
                          acc[key] = '[unserializable]';
                        }
                        return acc;
                      }, {});
                    }
                  } catch (e) {
                    errorDetails.serializationError = String(e);
                  }
                  
                  logger.error('[ChatScreen] MessageItem: image load error', errorDetails);
                  console.error('[ChatScreen] Image load error details:', errorDetails);
                  
                  // КРИТИЧНО: Если ошибка связана с ATS, пытаемся скачать через FileSystem
                  const isATSError = errorDetails.errorValues?.error?.includes('App Transport Security') || 
                                     errorDetails.nativeEvent?.error?.includes('App Transport Security');
                  
                  if (isATSError && !localImageUri && !isDownloading) {
                    logger.info('[ChatScreen] MessageItem: ATS error detected, trying FileSystem download', { 
                      messageId: item.id, 
                      uri: imageUri 
                    });
                    downloadImageViaFileSystem(imageUri);
                  } else {
                    setImageLoadError(true);
                  }
                }}
                onLoadStart={() => {
                  setImageLoadError(false); // Сбрасываем ошибку при новой попытке загрузки
                  logger.debug('[ChatScreen] MessageItem: image load started', { 
                    messageId: item.id, 
                    uri: imageUri 
                  });
                }}
                onLoad={() => {
                  setImageLoadError(false); // Успешная загрузка
                  logger.debug('[ChatScreen] MessageItem: image loaded successfully', { 
                    messageId: item.id, 
                    uri: imageUri 
                  });
                }}
                onLoadEnd={() => {
                  logger.debug('[ChatScreen] MessageItem: image load ended', { 
                    messageId: item.id, 
                    uri: imageUri 
                  });
                }}
              />
             
              
              
              {messageUploadStatus === 'sending' && (
                <View style={{
                  position: 'absolute',
                  bottom: 8,
                  left: 8,
                  right: 8,
                  backgroundColor: 'rgba(0,0,0,0.8)',
                  borderRadius: 4,
                  padding: 8,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <ActivityIndicator size="small" color="#4CAF50" style={{ marginRight: 6 }} />
                  <Text style={{
                    color: 'white',
                    fontSize: 10,
                    fontWeight: '600',
                  }}>
                    Отправляется...
                  </Text>
                </View>
              )}
              
              {messageUploadStatus === 'failed' && (
                <View style={{
                  position: 'absolute',
                  bottom: 8,
                  left: 8,
                  right: 8,
                  backgroundColor: 'rgba(255,0,0,0.8)',
                  borderRadius: 4,
                  padding: 8,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <Ionicons name="alert-circle" size={12} color="white" style={{ marginRight: 4 }} />
                  <Text style={{
                    color: 'white',
                    fontSize: 10,
                    fontWeight: '600',
                  }}>
                    Ошибка отправки
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          );
        case 'audio': {
          const isPlaying = String(playingAudioId || '') === String(item.id || '');
          const durSec = Number(item?.duration || 0);
          const fullMs = durSec > 0 ? durSec * 1000 : 0;
          const remainingMs =
            isPlaying && playingAudioState?.id === String(item.id || '')
              ? Math.max(0, Number(playingAudioState.durationMs || 0) - Number(playingAudioState.positionMs || 0))
              : fullMs;
          const durLabel = (isPlaying ? remainingMs : fullMs) > 0 ? formatDurationDot(isPlaying ? remainingMs : fullMs) : '';

          return (
            <View
              style={{
                minWidth: 200,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)',
                  borderWidth: 1,
                  borderColor: BORDER_COLOR,
                }}
              >
                <Ionicons name={isPlaying ? 'pause' : 'play'} size={18} color={LIVI.white} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: LIVI.white, fontSize: 14, fontWeight: '600' }}>Голосовое</Text>
                <Text style={{ marginTop: 2, color: LIVI.titan, fontSize: 12, fontWeight: '500' }}>
                  {durLabel || '—'}
                </Text>
              </View>

              {messageUploadStatus === 'sending' && (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <ActivityIndicator size="small" color={LIVI.titan} />
                </View>
              )}
            </View>
          );
        }
        default:
          return null; // Текст будет отображаться в основном блоке
      }
    };

    const renderStatusIcons = () => {
      if (!isMyMessage) return null;
      
      // Все возможные статусы: sending, delivered, read, failed, error
      switch (effectiveReadStatus) {
        case 'sending':
          // Отправляется - часы
          return (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 2 }}>
              <Ionicons 
                name="time-outline" 
                size={14} 
                color={LIVI.titan}
              />
            </View>
          );
          
        case 'failed': {
          const showRetry = String(retryUiForId || '') === String(item?.id || '');
          return (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 6, gap: 8 }}>
              {showRetry && (
                <Pressable
                  onPress={() => {
                    try { onRetryFailed?.(item); } catch {}
                  }}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 10,
                    height: 28,
                    borderRadius: 14,
                    backgroundColor: isDark ? 'rgba(255,90,103,0.16)' : 'rgba(255,90,103,0.12)',
                    borderWidth: 1,
                    borderColor: 'rgba(255,90,103,0.45)',
                  }}
                >
                  <Ionicons name="refresh-circle" size={18} color="#FF5A67" style={{ marginRight: 6 }} />
                  <Text style={{ color: '#FF5A67', fontSize: 12, fontWeight: '700' }}>Повторить</Text>
                </Pressable>
              )}

              <Pressable
                onPress={() => {
                  try { onToggleRetryUi?.(String(item?.id || '')); } catch {}
                }}
                hitSlop={8}
                style={{ flexDirection: 'row', alignItems: 'center' }}
              >
                <View style={{
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  backgroundColor: LIVI.red,
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  <Text style={{ 
                    color: 'white', 
                    fontSize: 9, 
                    fontWeight: 'bold',
                    lineHeight: 9 
                  }}>!</Text>
                </View>
              </Pressable>
            </View>
          );
        }
        case 'sent':
          // Отправлено на сервер (еще не доставлено) — одна серая птичка
          return (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 2 }}>
              <Ionicons 
                name="checkmark" 
                size={14} 
                color={LIVI.titan}
              />
            </View>
          );
          
        case 'delivered':
          // Доставлено получателю, но не прочитано — одна серая птичка
          return (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 2 }}>
              <Ionicons 
                name="checkmark" 
                size={14} 
                color={LIVI.titan}
              />
            </View>
          );
          
        case 'read':
          // Прочитано - две бирюзовые птички
          return (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 2 }}>
              <View style={{ position: 'relative' }}>
                <Ionicons name="checkmark" size={14} color="hsl(108, 53.10%, 35.10%)" />
                <Ionicons name="checkmark" size={14} color="hsl(108, 53.10%, 35.10%)" style={{ position: 'absolute', left: 5, top: 0 }} />
              </View>
            </View>
          );
          
        default:
          // Неизвестный статус или undefined - показываем часы
          return (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 2 }}>
              <Ionicons 
                name="time-outline" 
                size={14} 
                color={LIVI.titan}
              />
            </View>
          );
      }
    };

    const messageAnimation = getMessageAnimation(item.id);
    const canToggle = !!selectionMode;

    return (
      <Animated.View
        style={{
          transform: [{ scale: messageAnimation }],
          marginHorizontal: 16,
          marginVertical: 4,
          alignSelf: isMyMessage ? 'flex-end' : 'flex-start',
          // row, чтобы чекбокс был рядом с облаком и по центру по высоте
          flexDirection: 'row',
          alignItems: 'center',
          // чуть шире, т.к. добавляется чекбокс
          maxWidth: '92%',
        }}
      >
        {/* Чекбокс выбора (режим "Выбрать") — рядом с облаком и по центру */}
        {selectionMode && !isMyMessage && (
          <Pressable
            onPress={() => onToggleSelect?.(String(item.id))}
            style={({ pressed }) => ({
              width: 26,
              height: 26,
              borderRadius: 13,
              borderWidth: 1.5,
              borderColor: isSelected ? '#55d187' : (isDark ? 'rgba(255,255,255,0.24)' : 'rgba(0,0,0,0.18)'),
              backgroundColor: pressed
                ? (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)')
                : (isSelected ? 'rgba(85,209,135,0.18)' : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)')),
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: 10,
              overflow: 'hidden',
            })}
          >
            {isSelected ? <Ionicons name="checkmark" size={18} color="#55d187" /> : null}
          </Pressable>
        )}

        <TouchableOpacity
          onPress={() => {
            if (canToggle) {
              onToggleSelect?.(String(item.id));
              return;
            }
            if (String(item?.type || '') === 'audio') {
              animateMessagePress(item.id, () => {
                try { onPressAudio?.(item); } catch {}
              });
              return;
            }
            animateMessagePress(item.id);
          }}
          onLongPress={() => {
            animateMessagePress(item.id, () => {
              onLongPressMessage(item);
            });
          }}
          activeOpacity={0.7}
          style={{
            padding: 12,
            backgroundColor: isMyMessage ? BUBBLE_BG_OUT : BUBBLE_BG_IN,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: BORDER_COLOR,
            maxWidth: '80%',
          }}
        >
        {/* Основной контент */}
        {renderContent()}
        
        {/* Текст сообщения (если есть) */}
        {item.type === 'text' && (
          <Text style={{ 
            color: LIVI.white, 
            fontSize: 16, 
            // меньше воздуха между текстом и временем
            marginBottom: 3,
            lineHeight: 22,
            fontWeight: '400',
          }}>
            {item.text}
          </Text>
        )}
        
        {/* Нижняя строка: время + статус в стиле Telegram */}
        <View style={{ 
          flexDirection: 'row', 
          alignItems: 'center', 
          justifyContent: 'flex-end',
          marginTop: item.type !== 'text' ? 4 : 1,
        }}>
          <Text style={{ 
            color: LIVI.text, 
            fontSize: 12,
            marginRight: isMyMessage ? 4 : 0,
            opacity: 0.8,
            fontWeight: '500',
          }}>
            {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
          {renderStatusIcons()}
        </View>
        </TouchableOpacity>

        {selectionMode && isMyMessage && (
          <Pressable
            onPress={() => onToggleSelect?.(String(item.id))}
            style={({ pressed }) => ({
              width: 26,
              height: 26,
              borderRadius: 13,
              borderWidth: 1.5,
              borderColor: isSelected ? '#55d187' : (isDark ? 'rgba(255,255,255,0.24)' : 'rgba(0,0,0,0.18)'),
              backgroundColor: pressed
                ? (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)')
                : (isSelected ? 'rgba(85,209,135,0.18)' : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)')),
              alignItems: 'center',
              justifyContent: 'center',
              marginLeft: 10,
              overflow: 'hidden',
            })}
          >
            {isSelected ? <Ionicons name="checkmark" size={18} color="#55d187" /> : null}
          </Pressable>
        )}
      </Animated.View>
    );
  }), [
    resolveMediaUri,
    formatDuration,
    formatDurationDot,
    animateMessagePress,
    getMessageAnimation,
    BUBBLE_BG_OUT,
    BUBBLE_BG_IN,
    BORDER_COLOR,
    LIVI.white,
    LIVI.titan,
    LIVI.red,
    isDark,
  ]);

  // КРИТИЧНО: на каждый ввод нельзя пересоздавать массив data для FlatList,
  // иначе он будет перерисовывать (а иногда и переразмещать) все элементы -> мерцание изображений.
  const androidMessagesData = React.useMemo(() => {
    if (isEmpty) return [];
    // reverse создаёт новый массив, поэтому мемоизируем
    return [...messages].reverse();
  }, [isEmpty, messages]);

  const renderMessageRow = React.useCallback(({ item }: any) => (
    <MessageItem
      item={item}
      currentUserId={currentUserId}
      readStatus={readStatuses[item.id]}
      uploadStatus={uploadStatus[item.id]}
      onPressImage={openMediaViewer}
      onPressAudio={togglePlayAudioMessage}
      playingAudioId={playingAudioId}
      playingAudioState={playingAudioState}
      retryUiForId={retryUiForId}
      onToggleRetryUi={(id: string) => setRetryUiForId((prev) => (prev === id ? null : id))}
      onRetryFailed={retryFailedOutgoingMessage}
      onLongPressMessage={handleLongPressMessage}
      selectionMode={selectionMode}
      isSelected={selectedMessageIds.has(String(item.id))}
      onToggleSelect={toggleSelectMessage}
    />
  ), [MessageItem, currentUserId, readStatuses, uploadStatus, openMediaViewer, togglePlayAudioMessage, playingAudioId, playingAudioState, retryUiForId, retryFailedOutgoingMessage, handleLongPressMessage, selectionMode, selectedMessageIds, toggleSelectMessage]);

  return (
    <SafeAreaView 
      // IMPORTANT: color the top safe-area (status bar area) to match the header.
      // Otherwise on Android (with translucent StatusBar) you'll see a white strip above the header.
      style={{ flex: 1, backgroundColor: LIVI.bg }}
      // Android: bottom inset добавляем вручную только когда клавиатура скрыта,
      // иначе получаем лишний зазор между инпутом и клавиатурой на разных прошивках.
      edges={Platform.OS === 'android' ? ['top', 'left', 'right'] : ['top', 'bottom', 'left', 'right']}
    >
      <View
        style={{ flex: 1, backgroundColor: LIVI.surface }}
        // Prevent touch-through during modal close animations (can trigger header back -> Home -> Chat flicker)
        pointerEvents={mediaViewerVisible || composeViewerVisible ? 'none' : 'auto'}
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          setRootLayoutH(h);
          if (!keyboardVisible) {
            baseRootLayoutHRef.current = h;
          }
        }}
      >
        <Header />
        {loading ? (
          <Loading />
        ) : err ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: LIVI.white, marginBottom: 12, textAlign: "center" }}>
              {err}
            </Text>
            <TouchableOpacity
              onPress={() => setErr(null)}
              style={{
                backgroundColor: LIVI.titan,
                paddingVertical: 10,
                paddingHorizontal: 18,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: BORDER_COLOR,
              }}
            >
              <Text style={{ color: LIVI.white, fontWeight: "700" }}>Попробовать снова</Text>
            </TouchableOpacity>
          </View>
        ) : Platform.OS === 'ios' ? (
          // iOS версия с KeyboardAvoidingView
          (<KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior="padding"
            keyboardVerticalOffset={0}
          >
            <FlatList
              ref={flatListRef}
              data={messages}
              keyExtractor={(item) => item.id}
              renderItem={renderMessageRow}
              style={{ flex: 1 }}
              contentContainerStyle={{ 
                flexGrow: 1,
                justifyContent: showEmpty ? 'center' : 'flex-end',
                paddingVertical: 16,
                paddingBottom: 12,
              }}
              ListFooterComponent={GapCenterIndicator ? (
                <View style={{ height: 24, justifyContent: 'center', alignItems: 'center' }}>
                  {GapCenterIndicator}
                </View>
              ) : null}
              showsVerticalScrollIndicator={false}
              inverted={false}
              onContentSizeChange={() => setTimeout(() => scrollToBottom(), 0)}
              ListEmptyComponent={() => {
                if (!historyReady) {
                  return (
                    <View
                      style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        backgroundColor: LIVI.surface,
                      }}
                    >
                      <ActivityIndicator color={LIVI.titan} />
                    </View>
                  );
                }
                if (!showEmpty) return null;
                return (
                  <View
                    style={{
                      flex: 1,
                      justifyContent: 'center',
                      alignItems: 'center',
                      backgroundColor: LIVI.surface,
                      ...(Platform.OS === 'ios' ? {} : { transform: [{ scaleY: -1 }] }),
                    }}
                  >
                    <Ionicons
                      name="chatbubble-outline"
                      size={64}
                      color={isDark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.30)'}
                    />
                    <Text
                      style={{
                        color: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.55)',
                        fontSize: 18,
                        marginTop: 16,
                        textAlign: 'center',
                        fontWeight: '500',
                      }}
                    >
                      Начните общение с {peerNameParam}
                    </Text>
                  </View>
                );
              }}
            />
            {/* Поле ввода для iOS */}
            <View
              style={{
                borderTopWidth: BORDER_WIDTH,
                borderTopColor: BORDER_COLOR,
                backgroundColor: LIVI.bg,
                paddingHorizontal: 16,
                paddingTop: 18,
                // Важно: симметричные отступы сверху/снизу вокруг инпута
                // SafeAreaView уже обрабатывает safe area, поэтому не добавляем insets.bottom
                paddingBottom: 18,
              }}
              onLayout={(e) => setInputHeight(e.nativeEvent.layout.height)}
            >
              {voiceIsRecording && (
                <View style={{ alignItems: 'center', marginBottom: 10 }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 14,
                      backgroundColor: isDark ? 'rgba(255,90,103,0.14)' : 'rgba(255,90,103,0.12)',
                      borderWidth: 1,
                      borderColor: 'rgba(255,90,103,0.28)',
                    }}
                  >
                    <Animated.View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: '#FF5A67',
                        marginRight: 8,
                        opacity: trashFlash.interpolate({ inputRange: [0, 1], outputRange: [1, 0.5] }),
                      }}
                    />
                    <Text style={{ color: LIVI.white, fontSize: 12, fontWeight: '700' }}>
                      Запись {formatDuration(Math.min(voiceRecordMs, VOICE_MAX_MS))}
                    </Text>
                    <Text style={{ color: LIVI.titan, fontSize: 12, fontWeight: '600', marginLeft: 6 }}>
                      / 1:00
                    </Text>
                  </View>
                </View>
              )}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  backgroundColor: "rgba(255,255,255,0.06)",
                  borderRadius: 28,
                  paddingHorizontal: 14,
                  paddingVertical: Platform.OS === 'ios' ? 8 : 4,
                  borderWidth: 1,
                  borderColor: BORDER_COLOR,
                }}
              >
                {/* Кнопка очистки убрана по требованию */}
                {voiceIsRecording ? (
                  <Animated.View
                    ref={(r) => { trashMeasureRef.current = r as any; }}
                    onLayout={() => updateTrashZone()}
                    style={{
                      padding: 2,
                      marginRight: 12,
                      transform: [
                        { scale: trashFlash.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) },
                        { rotate: trashLid.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-14deg'] }) },
                      ],
                      opacity: trashFlash.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }),
                    }}
                  >
                    <Ionicons name="trash-outline" size={28} color="#FF5A67" />
                  </Animated.View>
                ) : (
                  <TouchableOpacity
                    onPress={handleAttachments}
                    style={{
                      padding: 2,
                      marginRight: 12,
                    }}
                  >
                    <Ionicons name="image" size={28} color={LIVI.titan} />
                  </TouchableOpacity>
                )}

                {voiceIsRecording ? (
                  <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', height: 36 }}>
                    <Animated.View
                      style={{
                        opacity: recordViz.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.45] }),
                        transform: [
                          {
                            translateX: recordViz.interpolate({ inputRange: [0, 1], outputRange: [0, -10] }) as any,
                          },
                        ],
                      }}
                    >
                      <Ionicons name="chevron-back" size={18} color={LIVI.titan} />
                    </Animated.View>
                  </View>
                ) : (
                  <TextInput
                    style={{
                      flex: 1,
                      color: LIVI.white,
                      fontSize: 16,
                      maxHeight: 100,
                    }}
                    placeholder={t('chatMessagePlaceholder', lang)}
                    placeholderTextColor={LIVI.titan}
                    value={messageText}
                    onChangeText={(txt) => {
                      setMessageText(txt);
                      signalLocalTyping();
                    }}
                    multiline
                    onSubmitEditing={sendMessage}
                    returnKeyType="send"
                    editable={!voiceIsRecording}
                  />
                )}

                <Animated.View
                  {...micPanResponder.panHandlers}
                  style={{
                    marginLeft: 6,
                    transform: [{ scale: micScale }],
                  }}
                >
                  <View pointerEvents="none" style={{ padding: 8 }}>
                    <Ionicons
                      name={voiceIsRecording ? 'mic' : 'mic-outline'}
                      size={22}
                      color={voiceIsRecording ? '#FF5A67' : LIVI.titan}
                    />
                  </View>
                </Animated.View>

                <TouchableOpacity
                  onPress={sendMessage}
                  style={{
                    backgroundColor: messageText.trim()
                      ? LIVI.titan
                      : "rgba(255,255,255,0.2)",
                    borderRadius: 14,
                    padding: 6,
                    marginLeft: 6,
                    borderWidth: 1,
                    borderColor: BORDER_COLOR,
                  }}
                  disabled={!messageText.trim()}
                >
                  <Ionicons
                    name="send"
                    size={20}
                    color={messageText.trim() ? LIVI.white : LIVI.titan}
                  />
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>)
        ) : (
          // Android: полагаемся на adjustResize (MainActivity windowSoftInputMode=adjustResize)
          (<View style={{ flex: 1 }}>
            {/** Если система уже "ужала" окно, поднимаем только остаток (без двойного подъёма). */}
            <FlatList
              ref={flatListRef}
              data={androidMessagesData}
              keyExtractor={(item) => item.id}
              renderItem={renderMessageRow}
              style={{ flex: 1 }}
              contentContainerStyle={{
                flexGrow: 1,
                justifyContent: isEmpty ? 'center' : 'flex-start',
                paddingTop: 12,
              }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              inverted={!showEmpty}
              maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
              ListHeaderComponent={!isEmpty ? () => (
                <View
                  style={{
                    // Spacer so the last message doesn't hide under the input bar (and the keyboard on devices without resize).
                    height:
                      inputHeight > 0
                        ? inputHeight +
                          TYPING_GAP_H +
                          keyboardLift
                        : 96,
                  }}
                >
                  {/* ВАЖНО: сам spacer живёт "под" инпутом (его цель — добавить padding),
                      поэтому текст нужно рисовать в верхней (видимой) части spacer-а. */}
                  {GapCenterIndicator ? (
                    <View
                      pointerEvents="none"
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        height: TYPING_GAP_H,
                        justifyContent: 'center',
                        alignItems: 'center',
                      }}
                    >
                      {GapCenterIndicator}
                    </View>
                  ) : null}
                </View>
              ) : null}
              ListEmptyComponent={() => {
                if (!historyReady) {
                  return (
                    <View
                      style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        backgroundColor: LIVI.surface,
                      }}
                    >
                      <ActivityIndicator color={LIVI.titan} />
                    </View>
                  );
                }
                if (!showEmpty) return null;
                return (
                  <View
                    style={{
                      flex: 1,
                      justifyContent: 'center',
                      alignItems: 'center',
                      backgroundColor: LIVI.surface,
                    }}
                  >
                    <Ionicons
                      name="chatbubble-outline"
                      size={64}
                      color={isDark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.30)'}
                    />
                    <Text
                      style={{
                        color: isDark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.30)',
                        fontSize: 18,
                        marginTop: 16,
                        textAlign: 'center',
                        fontWeight: '500',
                      }}
                    >
                      Начните общение с {peerNameParam}
                    </Text>
                  </View>
                );
              }}
            />

            {/* Поле ввода для Android: поднимаем над клавиатурой, если система не ресайзит окно */}
            <View
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: keyboardLift,
                borderTopWidth: BORDER_WIDTH,
                borderTopColor: BORDER_COLOR,
                backgroundColor: LIVI.bg,
                paddingHorizontal: 16,
                paddingTop: 18,
                // Когда клавиатура открыта — панель должна "стыковаться" с клавиатурой без зазора.
                // Когда клавиатура скрыта — добавляем safe-area снизу, чтобы не упираться в навигацию.
                paddingBottom: 18 + (keyboardVisible ? 0 : Math.max(0, insets.bottom)),
              }}
              onLayout={(e) => setInputHeight(e.nativeEvent.layout.height)}
            >
              {voiceIsRecording && (
                <View style={{ alignItems: 'center', marginBottom: 10 }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 14,
                      backgroundColor: isDark ? 'rgba(255,90,103,0.14)' : 'rgba(255,90,103,0.12)',
                      borderWidth: 1,
                      borderColor: 'rgba(255,90,103,0.28)',
                    }}
                  >
                    <Animated.View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: '#FF5A67',
                        marginRight: 8,
                        opacity: trashFlash.interpolate({ inputRange: [0, 1], outputRange: [1, 0.5] }),
                      }}
                    />
                    <Text style={{ color: LIVI.white, fontSize: 12, fontWeight: '700' }}>
                      Запись {formatDuration(Math.min(voiceRecordMs, VOICE_MAX_MS))}
                    </Text>
                    <Text style={{ color: LIVI.titan, fontSize: 12, fontWeight: '600', marginLeft: 6 }}>
                      / 1:00
                    </Text>
                  </View>
                </View>
              )}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  borderRadius: 28,
                  paddingHorizontal: 12,
                  borderWidth: 1,
                  borderColor: BORDER_COLOR,
                }}
              >
                {voiceIsRecording ? (
                  <Animated.View
                    ref={(r) => { trashMeasureRef.current = r as any; }}
                    onLayout={() => updateTrashZone()}
                    style={{
                      padding: 2,
                      marginRight: 12,
                      transform: [
                        { scale: trashFlash.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) },
                        { rotate: trashLid.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-14deg'] }) },
                      ],
                      opacity: trashFlash.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }),
                    }}
                  >
                    <Ionicons name="trash-outline" size={28} color="#FF5A67" />
                  </Animated.View>
                ) : (
                  <TouchableOpacity
                    onPress={handleAttachments}
                    style={{
                      padding: 2,
                      marginRight: 12,
                    }}
                  >
                    <Ionicons name="image" size={28} color={LIVI.titan} />
                  </TouchableOpacity>
                )}

                {voiceIsRecording ? (
                  <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', height: 36 }}>
                    <Animated.View
                      style={{
                        opacity: recordViz.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.45] }),
                        transform: [
                          {
                            translateX: recordViz.interpolate({ inputRange: [0, 1], outputRange: [0, -10] }) as any,
                          },
                        ],
                      }}
                    >
                      <Ionicons name="chevron-back" size={18} color={LIVI.titan} />
                    </Animated.View>
                  </View>
                ) : (
                  <TextInput
                    style={{ flex: 1, color: LIVI.white, fontSize: 16, maxHeight: 100 }}
                    placeholder={t('chatMessagePlaceholder', lang)}
                    placeholderTextColor={LIVI.titan}
                    value={messageText}
                    onChangeText={(txt) => {
                      setMessageText(txt);
                      signalLocalTyping();
                    }}
                    multiline
                    onSubmitEditing={sendMessage}
                    returnKeyType="send"
                    editable={!voiceIsRecording}
                  />
                )}

                <Animated.View
                  {...micPanResponder.panHandlers}
                  style={{
                    marginLeft: 6,
                    transform: [{ scale: micScale }],
                  }}
                >
                  <View pointerEvents="none" style={{ padding: 8 }}>
                    <Ionicons
                      name={voiceIsRecording ? 'mic' : 'mic-outline'}
                      size={22}
                      color={voiceIsRecording ? '#FF5A67' : LIVI.titan}
                    />
                  </View>
                </Animated.View>

                <TouchableOpacity
                  onPress={sendMessage}
                  style={{
                    backgroundColor: messageText.trim() ? LIVI.titan : 'rgba(255,255,255,0.2)',
                    borderRadius: 14,
                    padding: 6,
                    marginLeft: 6,
                    borderWidth: 1,
                    borderColor: BORDER_COLOR,
                  }}
                  disabled={!messageText.trim()}
                >
                  <Ionicons
                    name="send"
                    size={20}
                    color={messageText.trim() ? LIVI.white : LIVI.titan}
                  />
                </TouchableOpacity>
              </View>
            </View>
          </View>)
        )}
      </View>
      {/* Полноэкранный просмотр медиа */}
      <MediaViewer
        visible={mediaViewerVisible}
        onClose={closeMediaViewer}
        mediaType={selectedMedia?.type || 'image'}
        uri={selectedMedia?.uri || ''}
        name={selectedMedia?.name}
      />

      {/* Предпросмотр выбранного фото перед отправкой (можно обрезать или отправить как есть) */}
      <MediaViewer
        visible={composeViewerVisible}
        onClose={() => {
          setComposeViewerVisible(false);
          setComposeAsset(null);
        }}
        mediaType="image"
        uri={composeAsset?.uri || ''}
        name={composeAsset?.fileName}
        onSend={(finalUri) => {
          try {
            if (!composeAsset) return;
            void sendPickedImage({ ...composeAsset, uri: finalUri });
          } finally {
            setComposeViewerVisible(false);
            setComposeAsset(null);
          }
        }}
      />

      {/* Модальное окно для меню очистки чата */}
      {showClearMenu && (
        <View style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
        }}>
          <View style={{
            backgroundColor: LIVI.surface,
            borderRadius: 16,
            padding: 20,
            margin: 20,
            minWidth: 280,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.1)',
          }}>
            <Text style={{
              color: LIVI.white,
              fontSize: 18,
              fontWeight: '700',
              textAlign: 'center',
              marginBottom: 20,
            }}>
              Очистить переписку
            </Text>
            
            <TouchableOpacity
              onPress={() => {
                setShowClearMenu(false);
                clearChatForMe();
              }}
              style={{
                backgroundColor: 'rgba(255,255,255,0.1)',
                borderRadius: 12,
                padding: 16,
                marginBottom: 12,
                alignItems: 'center',
              }}
            >
              <Text style={{
                color: LIVI.white,
                fontSize: 16,
                fontWeight: '600',
              }}>
                Удалить только у меня
              </Text>
              <Text style={{
                color: LIVI.titan,
                fontSize: 12,
                marginTop: 4,
                textAlign: 'center',
              }}>
                Удалить переписку только у вас
              </Text>
            </TouchableOpacity>
            
            <TouchableOpacity
              onPress={() => {
                setShowClearMenu(false);
                clearChatForAll();
              }}
              style={{
                backgroundColor: 'rgba(255,255,255,0.1)',
                borderRadius: 12,
                padding: 16,
                marginBottom: 12,
                alignItems: 'center',
              }}
            >
              <Text style={{
                color: LIVI.white,
                fontSize: 16,
                fontWeight: '600',
              }}>
                Удалить у всех
              </Text>
              <Text style={{
                color: LIVI.titan,
                fontSize: 12,
                marginTop: 4,
                textAlign: 'center',
              }}>
                Удалить переписку у вас и у друга
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => {
                setShowClearMenu(false);
                clearChatForMe();
              }}
              style={{
                backgroundColor: 'rgba(255,255,255,0.1)',
                borderRadius: 12,
                padding: 16,
                marginBottom: 20,
                alignItems: 'center',
              }}
            >
              <Text style={{
                color: LIVI.white,
                fontSize: 16,
                fontWeight: '600',
              }}>
                Удалить только у себя
              </Text>
              <Text style={{
                color: LIVI.titan,
                fontSize: 12,
                marginTop: 4,
                textAlign: 'center',
              }}>
                У друга переписка останется
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => setShowClearMenu(false)}
              style={{
                backgroundColor: 'rgba(255,255,255,0.05)',
                borderRadius: 12,
                padding: 16,
                alignItems: 'center',
              }}
            >
              <Text style={{
                color: LIVI.titan,
                fontSize: 16,
                fontWeight: '600',
              }}>
                Отмена
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Android: bottom sheet с действиями над сообщением */}
      {Platform.OS === 'android' && showMessageActions && selectedMessage && (
        <Modal
          transparent
          visible={showMessageActions}
          animationType="none"
          onRequestClose={hideMessageActions}
        >
          <Pressable
            onPress={hideMessageActions}
            style={{
              flex: 1,
              backgroundColor: isDark ? 'rgba(0,0,0,0.50)' : 'rgba(0,0,0,0.40)',
              justifyContent: 'flex-end',
            }}
          >
            <Animated.View
              style={{
                opacity: messageActionsOpacity,
                transform: [{ translateY: messageActionsTranslateY }],
              }}
            >
              <Pressable
                onPress={() => {}}
                style={{
                  backgroundColor: isDark ? '#0F1626' : LIVI.surface,
                  borderTopLeftRadius: 20,
                  borderTopRightRadius: 20,
                  paddingTop: 8,
                  paddingBottom: ANDROID_SHEET_BOTTOM_PAD,
                  paddingHorizontal: 14,
                  // убираем тонкую линию сверху — она отличается по девайсам и выглядит как артефакт
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: -6 },
                  shadowOpacity: 0.20,
                  shadowRadius: 12,
                  elevation: 12,
                }}
              >
                {/* handle */}
                <View style={{ alignItems: 'center', paddingTop: 4, paddingBottom: 8 }}>
                  <View
                    style={{
                      width: 42,
                      height: 4,
                      borderRadius: 2,
                      backgroundColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.18)',
                    }}
                  />
                </View>

                {(String(selectedMessage?.text || '').trim() || String(selectedMessage?.uri || '').trim()) && (
                  <>
                    <Pressable
                      onPress={() => {
                        hideMessageActions();
                        void copySelectedMessage(selectedMessage);
                      }}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 14,
                        paddingHorizontal: 12,
                        borderRadius: 14,
                        overflow: 'hidden',
                        backgroundColor: pressed
                          ? (isDark ? 'rgba(123,97,255,0.12)' : 'rgba(123,97,255,0.10)')
                          : 'transparent',
                      })}
                    >
                      <Ionicons name="copy-outline" size={20} color={LIVI.titan} />
                      <Text style={{ color: LIVI.white, fontSize: 16, fontWeight: '600', marginLeft: 12 }}>
                        Копировать
                      </Text>
                    </Pressable>

                    <Pressable
                      onPress={() => {
                        hideMessageActions();
                        void openForwardPicker();
                      }}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 14,
                        paddingHorizontal: 12,
                        borderRadius: 14,
                        overflow: 'hidden',
                        marginTop: 2,
                        backgroundColor: pressed
                          ? (isDark ? 'rgba(123,97,255,0.12)' : 'rgba(123,97,255,0.10)')
                          : 'transparent',
                      })}
                    >
                      <Ionicons name="paper-plane-outline" size={20} color={LIVI.titan} />
                      <Text style={{ color: LIVI.white, fontSize: 16, fontWeight: '600', marginLeft: 12 }}>
                        Переслать
                      </Text>
                    </Pressable>

                    <Pressable
                      onPress={() => {
                        enterSelectionModeFromMessage(selectedMessage);
                      }}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 14,
                        paddingHorizontal: 12,
                        borderRadius: 14,
                        overflow: 'hidden',
                        marginTop: 2,
                        backgroundColor: pressed
                          ? (isDark ? 'rgba(123,97,255,0.12)' : 'rgba(123,97,255,0.10)')
                          : 'transparent',
                      })}
                    >
                      <Ionicons name="checkbox-outline" size={20} color={LIVI.titan} />
                      <Text style={{ color: LIVI.white, fontSize: 16, fontWeight: '600', marginLeft: 12 }}>
                        Выбрать
                      </Text>
                    </Pressable>

                    <View style={{ height: 10 }} />
                  </>
                )}

                <Pressable
                  onPress={() => {
                    hideMessageActions();
                    confirmDeleteSelectedMessage(selectedMessage);
                  }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 14,
                    paddingHorizontal: 12,
                    borderRadius: 14,
                    overflow: 'hidden',
                    backgroundColor: pressed
                      ? 'rgba(255,90,103,0.10)'
                      : (isDark ? 'rgba(255,90,103,0.06)' : 'rgba(255,90,103,0.07)'),
                    borderWidth: 1,
                    borderColor: 'rgba(255,90,103,0.22)',
                  })}
                >
                  <Ionicons name="trash-outline" size={20} color="#FF5A67" />
                  <Text style={{ color: '#FF5A67', fontSize: 16, fontWeight: '700', marginLeft: 12 }}>
                    Удалить
                  </Text>
                </Pressable>

                <Pressable
                  onPress={hideMessageActions}
                  style={({ pressed }) => ({
                    marginTop: 10,
                    paddingVertical: 14,
                    paddingHorizontal: 12,
                    borderRadius: 14,
                    overflow: 'hidden',
                    backgroundColor: pressed
                      ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)')
                      : (isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'),
                    borderWidth: 1,
                    borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)',
                    alignItems: 'center',
                  })}
                >
                  <Text style={{ color: LIVI.titan, fontSize: 16, fontWeight: '600', textAlign: 'center' }}>
                    Отмена
                  </Text>
                </Pressable>
              </Pressable>
            </Animated.View>
          </Pressable>
        </Modal>
      )}

      {/* Android: bottom sheet для выбора вложений (камера/галерея) */}
      {Platform.OS === 'android' && showAttachSheet && (
        <Modal
          transparent
          visible={showAttachSheet}
          animationType="none"
          onRequestClose={() => setShowAttachSheet(false)}
        >
          <Pressable
            onPress={() => setShowAttachSheet(false)}
            style={{
              flex: 1,
              backgroundColor: isDark ? 'rgba(0,0,0,0.50)' : 'rgba(0,0,0,0.40)',
              justifyContent: 'flex-end',
            }}
          >
            <Animated.View style={{ opacity: 1, transform: [{ translateY: 0 }] }}>
              <Pressable
                onPress={() => {}}
                style={{
                  backgroundColor: isDark ? '#0F1626' : LIVI.surface,
                  borderTopLeftRadius: 20,
                  borderTopRightRadius: 20,
                  paddingTop: 8,
                  paddingBottom: ANDROID_SHEET_BOTTOM_PAD,
                  paddingHorizontal: 14,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: -6 },
                  shadowOpacity: 0.20,
                  shadowRadius: 12,
                  elevation: 12,
                }}
              >
                <View style={{ alignItems: 'center', paddingTop: 4, paddingBottom: 8 }}>
                  <View
                    style={{
                      width: 42,
                      height: 4,
                      borderRadius: 2,
                      backgroundColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.18)',
                    }}
                  />
                </View>

                <Pressable
                  onPress={() => {
                    setShowAttachSheet(false);
                    void handleCamera();
                  }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 14,
                    paddingHorizontal: 12,
                    borderRadius: 14,
                    overflow: 'hidden',
                    backgroundColor: pressed
                      ? (isDark ? 'rgba(123,97,255,0.12)' : 'rgba(123,97,255,0.10)')
                      : 'transparent',
                  })}
                >
                  <Ionicons name="camera-outline" size={20} color={LIVI.titan} />
                  <Text style={{ color: LIVI.white, fontSize: 16, fontWeight: '600', marginLeft: 12 }}>
                    {t('takePhoto', lang)}
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() => {
                    setShowAttachSheet(false);
                    void handleImagePicker();
                  }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 14,
                    paddingHorizontal: 12,
                    borderRadius: 14,
                    overflow: 'hidden',
                    marginTop: 2,
                    backgroundColor: pressed
                      ? (isDark ? 'rgba(123,97,255,0.12)' : 'rgba(123,97,255,0.10)')
                      : 'transparent',
                  })}
                >
                  <Ionicons name="images-outline" size={20} color={LIVI.titan} />
                  <Text style={{ color: LIVI.white, fontSize: 16, fontWeight: '600', marginLeft: 12 }}>
                    {t('chooseFromGallery', lang)}
                  </Text>
                </Pressable>

                <View style={{ height: 10 }} />

                <Pressable
                  onPress={() => setShowAttachSheet(false)}
                  style={({ pressed }) => ({
                    paddingVertical: 14,
                    borderRadius: 14,
                    overflow: 'hidden',
                    backgroundColor: pressed
                      ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)')
                      : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                  })}
                >
                  <Text style={{ color: LIVI.titan, fontSize: 16, fontWeight: '600', textAlign: 'center' }}>
                    {t('cancel', lang)}
                  </Text>
                </Pressable>
              </Pressable>
            </Animated.View>
          </Pressable>
        </Modal>
      )}

      {/* Переслать: выбор друга */}
      {showForwardPicker && (selectedMessage || selectionMode) && (
        <Modal
          transparent
          visible={showForwardPicker}
          animationType="fade"
          onRequestClose={() => setShowForwardPicker(false)}
        >
          <Pressable
            onPress={() => setShowForwardPicker(false)}
            style={{ flex: 1, backgroundColor: isDark ? 'rgba(0,0,0,0.50)' : 'rgba(0,0,0,0.40)', justifyContent: 'flex-end' }}
          >
            <Pressable
              onPress={() => {}}
              style={{
                backgroundColor: isDark ? '#0F1626' : LIVI.surface,
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                paddingTop: 8,
                paddingHorizontal: 14,
                paddingBottom: ANDROID_SHEET_BOTTOM_PAD,
                // убираем тонкую линию сверху — выглядит как артефакт на некоторых девайсах
                maxHeight: '70%',
              }}
            >
              <View style={{ alignItems: 'center', paddingTop: 4, paddingBottom: 8 }}>
                <View
                  style={{
                    width: 42,
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.18)',
                  }}
                />
              </View>
              <Text style={{ color: LIVI.white, fontSize: 16, fontWeight: '700', textAlign: 'center', marginBottom: 10 }}>
                Переслать…
              </Text>

              {forwardLoading ? (
                <View style={{ paddingVertical: 18, alignItems: 'center' }}>
                  <ActivityIndicator />
                </View>
              ) : (
                <FlatList
                  data={forwardFriends}
                  keyExtractor={(it: any) => String(it?._id || Math.random())}
                  showsVerticalScrollIndicator={false}
                  renderItem={({ item }) => (
                    <Pressable
                      onPress={() => void forwardSelectedMessageTo(item)}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 10,
                        paddingHorizontal: 8,
                        borderRadius: 14,
                        overflow: 'hidden', // чтобы ripple/подсветка были только со скруглением
                        // На некоторых Android ripple рисуется квадратом поверх скругления,
                        // поэтому используем только нашу подсветку через backgroundColor.
                        backgroundColor: pressed ? (isDark ? 'rgba(123,97,255,0.10)' : 'rgba(123,97,255,0.08)') : 'transparent',
                      })}
                    >
                      <AvatarImage
                        userId={String(item._id)}
                        avatarVer={Number(item.avatarVer || 0)}
                        uri={item.avatarThumbB64 || undefined}
                        size={44}
                        fallbackText={String((item.nick || '--').trim()?.[0] || '--').toUpperCase()}
                        containerStyle={{
                          borderWidth: 1,
                          borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)',
                          overflow: 'hidden',
                        }}
                        fallbackTextStyle={{ color: LIVI.white, fontSize: 16 }}
                      />
                      <View style={{ marginLeft: 12, flex: 1 }}>
                        <Text style={{ color: LIVI.white, fontSize: 16, fontWeight: '600' }}>
                          {(item.nick && String(item.nick).trim()) || '—'}
                        </Text>
                        {typeof item.online === 'boolean' && (
                          <Text style={{ color: item.online ? '#55d187' : 'rgba(255,255,255,0.45)', fontSize: 12 }}>
                            {item.online ? 'Online' : 'Offline'}
                          </Text>
                        )}
                      </View>
                      <Ionicons name="chevron-forward" size={18} color={LIVI.titan} />
                    </Pressable>
                  )}
                  ItemSeparatorComponent={() => (
                    <View style={{ height: 1, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }} />
                  )}
                  ListEmptyComponent={() => (
                    <View style={{ paddingVertical: 18, alignItems: 'center' }}>
                      <Text style={{ color: LIVI.titan, textAlign: 'center' }}>Нет друзей для пересылки</Text>
                    </View>
                  )}
                />
              )}

              <View style={{ height: 10 }} />
              <TouchableOpacity
                onPress={() => setShowForwardPicker(false)}
                style={{
                  paddingVertical: 14,
                  backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
                  borderRadius: 12,
                }}
                activeOpacity={0.85}
              >
                <Text style={{ color: LIVI.titan, fontSize: 16, fontWeight: '600', textAlign: 'center' }}>
                  Отмена
                </Text>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {/* "Отправлено" теперь показывается в том же gap, что и "Печатает..." */}

      {/* Универсальное подтверждение (используется для массового удаления/очистки и т.п.) */}
      <Modal
        visible={confirmVisible}
        transparent
        animationType="fade"
        onRequestClose={closeConfirm}
      >
        <Pressable
          onPress={closeConfirm}
          style={{
            flex: 1,
            backgroundColor: isDark ? 'rgba(0,0,0,0.62)' : 'rgba(0,0,0,0.38)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              width: '100%',
              maxWidth: 380,
              borderRadius: 18,
              // Светлая тема: оставляем как есть. Тёмная: фирменный LiVi background (без серого оттенка).
              backgroundColor: isDark ? LIVI.bg : 'rgba(255,255,255,0.98)',
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)',
              overflow: 'hidden',
            }}
          >
            <View style={{ paddingHorizontal: 18, paddingTop: 18, paddingBottom: 14 }}>
              <Text style={{ color: isDark ? LIVI.white : 'rgba(0,0,0,0.92)', fontSize: 18, fontWeight: '700' }}>
                {confirmTitle || 'Подтвердите действие'}
              </Text>
              <Text style={{ marginTop: 8, color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)', fontSize: 14, lineHeight: 18 }}>
                {confirmMessage || ''}
              </Text>
            </View>

            <View
              style={{
                height: StyleSheet.hairlineWidth,
                backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)',
              }}
            />

            <View style={{ flexDirection: 'row', padding: 12, gap: 10 }}>
              <Pressable
                onPress={closeConfirm}
                style={({ pressed }) => ({
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: 14,
                  alignItems: 'center',
                  backgroundColor: pressed
                    ? (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)')
                    : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                })}
              >
                <Text style={{ color: LIVI.titan, fontSize: 15, fontWeight: '600' }}>
                  {confirmCancelText || 'Отмена'}
                </Text>
              </Pressable>

              <Pressable
                onPress={runConfirm}
                style={({ pressed }) => ({
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: 14,
                  alignItems: 'center',
                  backgroundColor: confirmDestructive
                    ? (pressed ? 'rgba(255,90,103,0.26)' : 'rgba(255,90,103,0.18)')
                    : (pressed ? 'rgba(123,97,255,0.22)' : 'rgba(123,97,255,0.16)'),
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: confirmDestructive ? 'rgba(255,90,103,0.45)' : 'rgba(123,97,255,0.45)',
                })}
              >
                <Text
                  style={{
                    color: confirmDestructive ? '#FF5A67' : LIVI.titan,
                    fontSize: 15,
                    fontWeight: '700',
                  }}
                >
                  {confirmOkText || 'Ок'}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Кастомное подтверждение удаления сообщения (вместо Alert) */}
      <Modal
        visible={deleteConfirmVisible}
        transparent
        animationType="fade"
        onRequestClose={closeDeleteConfirm}
      >
        <Pressable
          onPress={closeDeleteConfirm}
          style={{
            flex: 1,
            backgroundColor: isDark ? 'rgba(0,0,0,0.62)' : 'rgba(0,0,0,0.38)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              width: '100%',
              maxWidth: 380,
              borderRadius: 18,
              // Светлая тема: оставляем как есть. Тёмная: фирменный LiVi background (без серого оттенка).
              backgroundColor: isDark ? LIVI.bg : 'rgba(255,255,255,0.98)',
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)',
              overflow: 'hidden',
            }}
          >
            <View style={{ paddingHorizontal: 18, paddingTop: 18, paddingBottom: 14 }}>
              <Text style={{ color: isDark ? LIVI.white : 'rgba(0,0,0,0.92)', fontSize: 18, fontWeight: '700' }}>
                Удалить сообщение?
              </Text>
              <Text style={{ marginTop: 8, color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)', fontSize: 14, lineHeight: 18 }}>
                Это действие нельзя отменить.
              </Text>
            </View>

            <View
              style={{
                height: StyleSheet.hairlineWidth,
                backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)',
              }}
            />

            <View style={{ flexDirection: 'row', padding: 12, gap: 10 }}>
              <Pressable
                onPress={closeDeleteConfirm}
                style={({ pressed }) => ({
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: 14,
                  alignItems: 'center',
                  backgroundColor: pressed
                    ? (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)')
                    : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                })}
              >
                <Text style={{ color: LIVI.titan, fontSize: 15, fontWeight: '600' }}>Отмена</Text>
              </Pressable>

              <Pressable
                onPress={confirmDeleteNow}
                style={({ pressed }) => ({
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: 14,
                  alignItems: 'center',
                  backgroundColor: pressed ? 'rgba(255,90,103,0.26)' : 'rgba(255,90,103,0.18)',
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: 'rgba(255,90,103,0.45)',
                })}
              >
                <Text style={{ color: '#FF5A67', fontSize: 15, fontWeight: '700' }}>Удалить</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Кастомный алерт/ошибка (в тех же цветах LiVi) */}
      <Modal
        visible={noticeVisible}
        transparent
        animationType="fade"
        onRequestClose={closeNotice}
      >
        <Pressable
          onPress={closeNotice}
          style={{
            flex: 1,
            backgroundColor: isDark ? 'rgba(0,0,0,0.62)' : 'rgba(0,0,0,0.38)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              width: '100%',
              maxWidth: 380,
              borderRadius: 18,
              backgroundColor: isDark ? LIVI.bg : 'rgba(255,255,255,0.98)',
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)',
              overflow: 'hidden',
            }}
          >
            <View style={{ paddingHorizontal: 18, paddingTop: 18, paddingBottom: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons
                  name={noticeKind === 'error' ? 'alert-circle-outline' : 'information-circle-outline'}
                  size={18}
                  color={noticeKind === 'error' ? '#FF5A67' : LIVI.titan}
                  style={{ marginRight: 10 }}
                />
                <Text style={{ color: isDark ? LIVI.white : 'rgba(0,0,0,0.92)', fontSize: 18, fontWeight: '700', flex: 1 }}>
                  {noticeTitle || (noticeKind === 'error' ? t('errorTitle', lang) : '')}
                </Text>
              </View>
              {!!noticeMessage && (
                <Text style={{ marginTop: 10, color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)', fontSize: 14, lineHeight: 18 }}>
                  {noticeMessage}
                </Text>
              )}
            </View>

            <View
              style={{
                height: StyleSheet.hairlineWidth,
                backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)',
              }}
            />

            <View style={{ padding: 12 }}>
              <Pressable
                onPress={closeNotice}
                style={({ pressed }) => ({
                  paddingVertical: 12,
                  borderRadius: 14,
                  alignItems: 'center',
                  backgroundColor: pressed
                    ? (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)')
                    : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                })}
              >
                <Text style={{ color: noticeKind === 'error' ? '#FF5A67' : LIVI.titan, fontSize: 15, fontWeight: '700' }}>
                  Ок
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}