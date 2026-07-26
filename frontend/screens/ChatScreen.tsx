// screens/ChatScreen.tsx
import React, { useCallback, useEffect, useState, useRef } from "react";
import {
  BackHandler,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  AppState,
  Platform,
  Alert,
  ActionSheetIOS,
  FlatList,
  ScrollView,
  KeyboardAvoidingView,
  Keyboard,
  Modal,
  Pressable,
  Animated,
  Vibration,
  NativeModules,
  DeviceEventEmitter,
  PixelRatio,
  Dimensions,
  Image,
  StyleSheet,
  Share,
  StatusBar,
} from "react-native";
 
import { useSafeAreaInsets, SafeAreaView } from "react-native-safe-area-context";
import {
  KeyboardController,
  AndroidSoftInputModes,
} from "react-native-keyboard-controller";
import {
  PanGestureHandler,
  PinchGestureHandler,
  State,
  GestureHandlerRootView,
  NativeViewGestureHandler,
  FlatList as GHFlatList,
} from "react-native-gesture-handler";
import { onCloseIncoming, emitCloseIncoming } from '../utils/globalEvents';
import { displayAvatarLetter } from './home/friendHelpers';
import socket from '../sockets/socket';
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../theme/ThemeProvider";
import { uiAccent } from "../theme/uiAccent";
import {
  COMPOSER_HIT_ATTACH,
  COMPOSER_HIT_SEND,
} from "../constants/uiTokens";
import { Image as ExpoImage } from "expo-image";
import AvatarImage from "../components/AvatarImage";
import ChatEmojiKeyboard, { CHAT_EMOJI_PANEL_HEIGHT } from "../components/ChatEmojiKeyboard";
import {
  getStickerFallbackText,
} from "../components/chatStickers";
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { Audio } from 'expo-av';
import { getFull, putFull, putThumb } from '../utils/avatarCache';
import { BlurView } from 'expo-blur';
import { getAvatarImageProps } from '../utils/imageOptimization';
import { useResolvedImageUri } from '../hooks/useResolvedImageUri';
import { ChatMessageItem } from './chat/ChatMessageItem';
import {
  isOfflineQueuedOrOptimisticOutgoingId,
  type ChatReadStatus,
} from './chat/chatMessageIds';
import {
  CHAT_ALBUM_MAX,
  getMessageImageUris,
  isImageAlbumMessage,
  albumSelectionKey,
  selectedAlbumIndices,
} from './chat/chatAlbum';
import { ChatAlbumPickModal } from './chat/ChatAlbumPickModal';
import {
  isDeletableOnServerMessageId,
} from './chat/chatMessageOps';
import {
  buildChatListRows,
  indexInChatListData,
  CHAT_LIST_INITIAL_NUM_TO_RENDER,
  CHAT_LIST_MAX_TO_RENDER_PER_BATCH,
  CHAT_LIST_WINDOW_SIZE,
  CHAT_LIST_UPDATE_CELLS_BATCHING_PERIOD,
  type ChatListRow,
} from './chat/chatList';
import {
  getChatReplyPreviewText,
} from './chat/chatMessageMeta';
import { useChatSelection } from './chat/useChatSelection';
import { useChatForward } from './chat/useChatForward';
import { useChatDialogs } from './chat/useChatDialogs';
import { useChatMessageActions } from './chat/useChatMessageActions';
import { useChatAlbumScope } from './chat/useChatAlbumScope';
import { useChatTyping } from './chat/useChatTyping';
import { useChatDeleteConfirm } from './chat/useChatDeleteConfirm';
import {
  formatVoiceDuration,
  formatVoiceDurationDot,
} from './chat/chatVoiceCache';
import { VOICE_MAX_MS } from './chat/chatVoiceRecord';
import { useChatVoiceRecord } from './chat/useChatVoiceRecord';
import { useChatMediaViewers } from './chat/useChatMediaViewers';
import { useChatMessagePersist } from './chat/useChatMessagePersist';
import { useChatImageWarm } from './chat/useChatImageWarm';
import { useChatHistorySync } from './chat/useChatHistorySync';
import { useChatSendMedia } from './chat/useChatSendMedia';
import { useChatMediaOutbox } from './chat/useChatMediaOutbox';
import { useChatAudioPlayback } from './chat/useChatAudioPlayback';
import { useChatIncomingShare } from './chat/useChatIncomingShare';
import { useChatRealtime } from './chat/useChatRealtime';
import { useChatDeleteOps } from './chat/useChatDeleteOps';
import { useChatForwardSend } from './chat/useChatForwardSend';
import { useChatAlbumImageActions } from './chat/useChatAlbumImageActions';
import { useChatComposer } from './chat/useChatComposer';
import { useChatClear } from './chat/useChatClear';
import { useChatHeader } from './chat/useChatHeader';
import { useChatLongPressMessage } from './chat/useChatLongPressMessage';
import {
  getChatHiddenForMeKey,
  getChatStatusesKey,
} from './chat/chatStorageKeys';
import {
  ChatDeleteToastInline,
  ChatGapCenterIndicator,
  shouldShowChatDeleteToast,
  shouldShowChatGapCenter,
} from './chat/ChatGapStatus';
import { ChatParallaxWallpaper } from './chat/ChatParallaxWallpaper';
import {
  ReactionBarModal,
  ReactionsRowWithSwipe,
  SHEET_REACTIONS_ROW_1,
  SHEET_REACTIONS_ROW_2,
} from './chat/chatReactions';

import { API_BASE, getMyProfile } from '../sockets/socket';
import { logger } from '../utils/logger';
import { toAvatarThumb } from '../utils/uploadAvatar';
import {
  onFriendProfile,
  onPresenceUpdate,
  PRESENCE_OFFLINE_DEBOUNCE_MS,
  isReconnecting,
  onCurrentUserId,
  getCurrentUserId as getCurrentSocketUserId,
} from '../sockets/socket';
import { uploadMediaToServer } from '../utils/mediaUpload';
import MediaViewer from '../components/MediaViewer';
import * as ImagePicker from 'expo-image-picker';
import { 
  getMyUserId,
  sendMessage as sendSocketMessage,
  sendMessageReaction,
  markMessagesAsRead,
  onUserPresence,
  hasVisibleOnlinePresenceSnapshot,
  isPeerInVisibleOnlinePresence,
  clearMessageCache,
  getAvatar,
  sendChatViewing,
  ensureGloballyDeletedMessageIdsLoaded,
} from "../sockets/socket";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLang } from "../store/lang";
import { t, type Lang } from "../utils/i18n";
import { setCurrentChatPeerId, dismissMessageNotificationForUser, syncAppBadgeFromMissedCount } from "../utils/pushNotifications";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import type { IncomingShareItem } from '../utils/incomingShare';

type RouteParams = {
  peerId: string;
  peerName?: string;
  peerAvatar?: string; // deprecated
  peerAvatarVer?: number;
  peerAvatarThumbB64?: string;
  peerOnline?: boolean;
  incomingShareItems?: IncomingShareItem[];
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
    feedBg: isDark ? theme.colors.surface : 'rgb(200, 206, 216)',
    titan: (theme.colors.titan || theme.colors.onSurfaceVariant) as string,
    text: theme.colors.onSurfaceVariant as string,
    white: theme.colors.onSurface as string,
    green: '#2ECC71',
    red: '#FF5A67',
    presenceGreen: isDark ? '#2ECC71' : '#28A85E',
    presenceRed: isDark ? '#FF5A67' : '#E64E59',
    replyQuoteAccent: isDark ? 'rgba(168, 214, 204, 0.88)' : 'rgba(112, 98, 148, 0.88)',
    replyQuotePressBg: isDark ? 'rgba(168, 214, 204, 0.10)' : 'rgba(112, 98, 148, 0.10)',
    replyHighlightAccent: isDark ? 'rgba(168, 214, 204, 0.75)' : 'rgba(112, 98, 148, 0.78)',
    accent: uiAccent(isDark),
  } as const), [theme, isDark]);

  // Android: тёмный scrim status bar → всегда светлые иконки. iOS: по теме / шапке.
  useFocusEffect(
    React.useCallback(() => {
      const style =
        Platform.OS === 'android' || isDark ? 'light-content' : 'dark-content';
      StatusBar.setBarStyle(style, true);
      if (Platform.OS === 'android') {
        try {
          StatusBar.setTranslucent(true);
          StatusBar.setBackgroundColor('transparent', true);
        } catch {}
      }
      return () => {};
    }, [isDark]),
  );

  // Защита от полупрозрачного фона темы: панель ввода всегда должна быть полностью непрозрачной,
  // чтобы под ней не просвечивал контент на разных устройствах/прошивках.
  const INPUT_BAR_BG = React.useMemo(() => {
    if (isDark) return LIVI.bg;
    const bg = String(LIVI.bg || '');
    const m = bg.match(/^rgba\(([^)]+)\)$/i);
    if (!m) return bg;
    const parts = m[1].split(',').map((s) => s.trim());
    if (parts.length !== 4) return bg;
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, 1)`;
  }, [LIVI.bg, isDark]);

  const BORDER_COLOR = theme.colors.outline as string;
  // Тёмная тема — как есть. Светлая: исходящие серо-голубые; входящие — чуть затемнённый жемчужный белый.
  const BUBBLE_BG_OUT = isDark ? 'rgba(14, 20, 32, 0.99)' : 'hsla(220, 6%, 80%, 0.97)';
  const BUBBLE_BG_IN  = isDark ? 'rgba(26, 32, 42, 0.98)' : 'hsla(40, 8%, 89%, 0.97)';
  const BORDER_WIDTH = 1;

  const peerId = String(route?.params?.peerId || "");
  const peerIdForPersistRef = useRef(peerId);
  peerIdForPersistRef.current = peerId;
  const peerNameParam = route?.params?.peerName || "—";
  const peerAvatarVer = route?.params?.peerAvatarVer || 0;
  const peerAvatarThumbB64Param = route?.params?.peerAvatarThumbB64 || '';
  const [peerAvatarVerState, setPeerAvatarVerState] = useState<number>(peerAvatarVer);
  const [peerOnline, setPeerOnline] = useState<boolean>(!!route?.params?.peerOnline);
  const [fullAvatarUri, setFullAvatarUri] = useState<string>(peerAvatarThumbB64Param); // Используем миниатюру как начальное значение

  // Не показывать системное уведомление о сообщении от текущего собеседника, пока пользователь в этом чате.
  // Сообщить серверу «смотрю этот чат» (не слать пуш), снять уведомление этого чата из шторки.
  const isChatScreenFocused = useIsFocused();
  const isFocusedRef = useRef(isChatScreenFocused);
  isFocusedRef.current = isChatScreenFocused;
  useFocusEffect(
    useCallback(() => {
      if (peerId) {
        setCurrentChatPeerId(peerId);
        sendChatViewing(peerId);
        dismissMessageNotificationForUser(peerId).catch(() => {});
      }
      // Голос: режим аудио поднимаем при входе в чат — первый тап не ждёт setAudioModeAsync
      void Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        allowsRecordingIOS: false,
        staysActiveInBackground: false,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      }).catch(() => {});
      return () => {
        setCurrentChatPeerId(null);
        sendChatViewing(null);
      };
    }, [peerId])
  );

  // В фоне / на заблокированном экране сокет часто остаётся подключённым, а экран чата остаётся «в фокусе»
  // в навигации — сервер не получает disconnect и продолжает считать, что чат открыт, и не шлёт FCM.
  useEffect(() => {
    if (!peerId) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        if (isChatScreenFocused) sendChatViewing(peerId);
      } else {
        sendChatViewing(null);
      }
    });
    return () => sub.remove();
  }, [peerId, isChatScreenFocused]);

  // Продлеваем chat:viewing на сервере (TTL 90s), иначе длинная переписка без смены AppState → снова пуши и unread в памяти.
  useEffect(() => {
    if (!peerId) return;
    const id = setInterval(() => {
      try {
        if (AppState.currentState === 'active' && isChatScreenFocused) {
          sendChatViewing(peerId);
        }
      } catch {}
    }, 45_000);
    return () => clearInterval(id);
  }, [peerId, isChatScreenFocused]);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  /** Always points at latest `messages` for background/unmount persistence (avoid stale closures). */
  const latestMessagesForPersistRef = useRef(messages);
  latestMessagesForPersistRef.current = messages;
  /** Для каких live id уже слали `message:read`; history/initial sync закрывается batch `markMessagesAsRead`. */
  const readReceiptSentIdsRef = useRef<Set<string>>(new Set());
  // Чтобы не показывать "пустую заглушку" до загрузки истории (иначе она мелькает на входе в чат)
  const [historyReady, setHistoryReady] = useState(false);
  /** Prefetch chat images before first paint so bubbles don't flash empty→loaded. */
  const [chatImagesWarm, setChatImagesWarm] = useState(false);
  const {
    deleteConfirmVisible,
    deleteForBoth,
    setDeleteForBoth,
    deleteConfirmKind,
    closeDeleteConfirm,
    openDeleteConfirmSingle,
    openDeleteConfirmMulti,
    consumeDeleteConfirm,
  } = useChatDeleteConfirm();
  const batchDeleteSelectedRef = useRef<((forBoth: boolean, idsOverride?: string[]) => Promise<void>) | null>(null);
  // Кастомный алерт/ошибка + confirm (2 кнопки)
  const {
    noticeVisible,
    noticeTitle,
    noticeMessage,
    noticeKind,
    closeNotice,
    showNotice,
    confirmVisible,
    confirmTitle,
    confirmMessage,
    confirmCancelText,
    confirmOkText,
    confirmDestructive,
    openConfirm,
    closeConfirm,
    runConfirm,
  } = useChatDialogs();
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [androidImeInset, setAndroidImeInset] = useState(0);
  const [emojiPanelOpen, setEmojiPanelOpen] = useState(false);
  const androidNativeImeAvailableRef = useRef(false);
  const androidFallbackImeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Edge-to-edge: layout не должен одновременно сжиматься и сдвигаться.
   * Позицию dock определяет только нативная IME-высота из keyboard-controller.
   */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    KeyboardController.setInputMode(AndroidSoftInputModes.SOFT_INPUT_ADJUST_NOTHING);
    return () => {
      KeyboardController.setDefaultMode();
    };
  }, []);

  // Android delivers this directly from WindowInsets.Type.ime() in MainActivity.
  // The Keyboard event below remains a fallback for an older development build.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = DeviceEventEmitter.addListener(
      'LiviAndroidImeInsets',
      (rawHeight: unknown) => {
        const heightPx = Math.max(0, Number(rawHeight) || 0);
        // Android WindowInsets are pixels; React Native layout coordinates are dp.
        const height = Math.round(heightPx / PixelRatio.get());
        androidNativeImeAvailableRef.current = true;
        if (androidFallbackImeTimerRef.current) {
          clearTimeout(androidFallbackImeTimerRef.current);
          androidFallbackImeTimerRef.current = null;
        }
        setAndroidImeInset(height);
      },
    );
    return () => {
      subscription.remove();
      if (androidFallbackImeTimerRef.current) {
        clearTimeout(androidFallbackImeTimerRef.current);
      }
    };
  }, []);

  const composerTextInputMaxHeight = 76;
  // Android: до первого onLayout — оценка нижней панели (после более низкого инпута).
  // Не завышать: иначе ListHeader spacer держит лишний зазор до последнего сообщения.
  const estimatedInputHeight = 100 + Math.max(0, insets.bottom);
  const [inputHeight, setInputHeight] = useState(estimatedInputHeight);
  const [messageText, setMessageText] = useState("");
  const messageTextRef = useRef("");
  messageTextRef.current = messageText;
  const [readStatuses, setReadStatuses] = useState<Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>>({});
  const readStatusesRef = useRef(readStatuses);
  readStatusesRef.current = readStatuses;
  /** Удалённые на сервере id (в t.ч. legacy numeric): блокируем повтор из history/outbox. */
  const deletedServerMessageIdsRef = useRef<Set<string>>(new Set());
  /** outbox_* / optimistic ui id → id в Mongo (после доставки). */
  const outboxLocalIdToServerIdRef = useRef<Map<string, string>>(new Map());
  const rememberOutboxLocalToServerId = React.useCallback((localId: string, serverId: string) => {
    const local = String(localId || '').trim();
    const server = String(serverId || '').trim();
    if (!local || !server || local === server) return;
    const map = outboxLocalIdToServerIdRef.current;
    map.set(local, server);
    if (map.size > 500) {
      const keep = new Map(Array.from(map.entries()).slice(-250));
      outboxLocalIdToServerIdRef.current = keep;
    }
  }, []);
  const hiddenForMeMessageIdsRef = useRef<Set<string>>(new Set());
  const rememberDeletedServerMessageId = React.useCallback((rawId: string) => {
    const id = String(rawId || '').trim();
    if (!id || !isDeletableOnServerMessageId(id)) return;
    const s = deletedServerMessageIdsRef.current;
    s.add(id);
    if (s.size > 400) {
      deletedServerMessageIdsRef.current = new Set(Array.from(s).slice(-200));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void ensureGloballyDeletedMessageIdsLoaded().then((tombstones) => {
      if (cancelled) return;
      for (const id of tombstones) rememberDeletedServerMessageId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [rememberDeletedServerMessageId]);
  const [uploadStatus, setUploadStatus] = useState<Record<string, 'sending' | 'sent' | 'failed'>>({});
  const uploadStatusRef = useRef(uploadStatus);
  uploadStatusRef.current = uploadStatus;
  const [showClearMenu, setShowClearMenu] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<any>(null);
  /** Index of album tile under long-press (null = whole message). */
  const [albumFocusIndex, setAlbumFocusIndex] = useState<number | null>(null);
  /** Album save/forward/delete: multi-select photos. */
  const {
    albumScopeVisible,
    albumScopeKind,
    albumPickUris,
    albumPickInitial,
    albumScopeMessageRef,
    closeAlbumScope: closeAlbumScopeBase,
    openAlbumScope,
    consumeAlbumScope,
  } = useChatAlbumScope();
  const closeAlbumScope = React.useCallback(() => {
    closeAlbumScopeBase();
    setAlbumFocusIndex(null);
  }, [closeAlbumScopeBase]);
  const reactionsScrollRef = useRef<ScrollView>(null);
  // Message actions sheet — useChatMessageActions
  const clearAlbumFocusOnActionsHidden = React.useCallback(() => {
    setAlbumFocusIndex(null);
  }, []);
  const {
    showMessageActions,
    selectedMessageLayout,
    messageActionsLayoutRef,
    messageActionsOpacity,
    messageActionsTranslateY,
    hideMessageActionsRef,
    hideMessageActions,
    showMessageActionsSheet,
    clearAndroidLayoutIfNeeded,
  } = useChatMessageActions({ onHidden: clearAlbumFocusOnActionsHidden });
  const closeActionsOnEnterSelection = React.useCallback(() => {
    try {
      hideMessageActionsRef.current();
    } catch {}
  }, []);
  // Multi-select (режим "Выбрать") — useChatSelection
  const {
    selectionMode,
    setSelectionMode,
    selectedMessageIds,
    setSelectedMessageIds,
    selectedCount,
    selectedHasAnyForwardable,
    exitSelectionMode,
    toggleSelectMessage,
    toggleSelectAlbumTile,
    enterSelectionModeFromMessage,
    selectAllLoaded,
  } = useChatSelection({
    messages,
    onEnter: closeActionsOnEnterSelection,
  });
  // Forward picker / toast / sheet — useChatForward
  const {
    showForwardPicker,
    setShowForwardPicker,
    forwardFriends,
    forwardLoading,
    forwardSelectedFriendIds,
    setForwardSelectedFriendIds,
    forwardToast,
    forwardToastOpacity,
    forwardSheetTranslateY,
    forwardPickerSheetMaxH,
    forwardPickerLayout,
    onForwardSheetGestureEvent,
    onForwardSheetHandlerStateChange,
    showForwardToastBadge,
    openForwardPicker,
  } = useChatForward({
    lang,
    insetsTop: insets.top,
    sheetBottomPad: ANDROID_SHEET_BOTTOM_PAD,
  });
  /** Подсветка сообщения при переходе по цитате в ответе */
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Для панели реакций: id сообщения, по которому дважды нажали (показать полосу эмодзи)
  const [reactionBarForMessageId, setReactionBarForMessageId] = useState<string | null>(null);
  /** ID сообщения, которое пользователь редактирует (текст в поле ввода). */
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  /** Сообщение, на которое отвечаем (показываем превью над полем ввода). */
  const [replyingToMessage, setReplyingToMessage] = useState<{ id: string; text: string; from?: string; isOwn?: boolean } | null>(null);

  // Анимации для сообщений
  const messagePressAnimations = useRef<Record<string, Animated.Value>>({}).current;

  // Состояние для полноэкранного просмотра медиа + compose preview + attach sheet
  const {
    mediaViewerVisible,
    setMediaViewerVisible,
    selectedMedia,
    setSelectedMedia,
    composeViewerVisible,
    setComposeViewerVisible,
    composeAsset,
    setComposeAsset,
    showAttachSheet,
    setShowAttachSheet,
  } = useChatMediaViewers();

  // Обертка для setReadStatuses с автосохранением
  const updateReadStatuses = (updater: (prev: Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>) => Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>) => {
    setReadStatuses(prev => {
      const updated = updater(prev);
      saveStatuses(updated); // Автоматически сохраняем
      return updated;
    });
  };
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const currentUserIdForPersistRef = useRef<string | null>(null);
  currentUserIdForPersistRef.current = currentUserId;
  const {
    peerActivity,
    stopLocalTyping,
    stopLocalRecordingSignal,
    startLocalRecordingSignal,
    signalLocalTyping,
  } = useChatTyping({ peerId, currentUserId });

  const sendVoiceFromLocalRef = useRef<
    (localUri: string, durationMs: number, size?: number) => void | Promise<void>
  >(async () => {});
  const onVoiceRecorded = React.useCallback((localUri: string, durationMs: number) => {
    return sendVoiceFromLocalRef.current(localUri, durationMs);
  }, []);
  const onVoiceCancelToast = React.useCallback(() => {
    showForwardToastBadge(false, t('chatDeleted', lang));
  }, [showForwardToastBadge, lang]);
  const {
    voiceIsRecording,
    voiceRecordMs,
    setVoiceRecordMs,
    voiceDragX,
    micScale,
    trashLid,
    trashFlash,
    recordViz,
    trashMeasureRef,
    micPanResponder,
    updateTrashZone,
    stopVoiceRecording,
    cancelVoiceRecordingWithAnimation,
  } = useChatVoiceRecord({
    currentUserId,
    peerId,
    selectionMode,
    lang,
    showNotice,
    startLocalRecordingSignal,
    stopLocalRecordingSignal,
    onRecorded: onVoiceRecorded,
    onCancelToast: onVoiceCancelToast,
  });

  // Refs для автоскролла
  const flatListRef = useRef<FlatList>(null);
  const keyboardAwareListRef = useRef<any>(null);
  const iosChatListDataRef = useRef<ChatListRow[]>([]);
  const androidChatListDataRef = useRef<ChatListRow[]>([]);

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

  // При открытии IME увеличивается нижний spacer инвертированного списка.
  // Сразу прижимаем его к новому низу, чтобы были видны последнее сообщение,
  // статусы «отправлено/прочитано» и индикатор «печатает…».
  useEffect(() => {
    if (Platform.OS !== 'android' || !keyboardVisible || androidImeInset <= 0) return;
    scheduleScrollToBottom(0);
    const settleTimer = setTimeout(() => scheduleScrollToBottom(0), 90);
    return () => clearTimeout(settleTimer);
  }, [androidImeInset, keyboardVisible, inputHeight]);

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
      if (Platform.OS === 'android') {
        // StickyView двигает dock; inset — для pad списка/empty.
        setKeyboardVisible(true);
        const height = Number(event?.endCoordinates?.height || 0);
        if (height > 0) {
          const resolvedHeight = Math.round(height);
          setKeyboardInset(resolvedHeight);
          // Current builds receive the native inset in the same animation.
          // Older dev-builds still get a delayed RN fallback instead of a
          // visible 318dp → native-inset correction.
          if (!androidNativeImeAvailableRef.current) {
            if (androidFallbackImeTimerRef.current) {
              clearTimeout(androidFallbackImeTimerRef.current);
            }
            androidFallbackImeTimerRef.current = setTimeout(() => {
              if (!androidNativeImeAvailableRef.current) {
                setAndroidImeInset(resolvedHeight);
              }
              androidFallbackImeTimerRef.current = null;
            }, 100);
          }
        }
      } else {
        setKeyboardVisible(true);
        const height = Number(event?.endCoordinates?.height || 0);
        if (height > 0) setKeyboardInset(Math.round(height));
        scheduleScrollToBottom(0);
      }
    };
    const onHide = () => {
      if (Platform.OS === 'android') {
        setKeyboardVisible(false);
        setKeyboardInset(0);
        if (androidFallbackImeTimerRef.current) {
          clearTimeout(androidFallbackImeTimerRef.current);
          androidFallbackImeTimerRef.current = null;
        }
        setAndroidImeInset(0);
        scheduleScrollToBottom(0);
        setTimeout(() => scheduleScrollToBottom(0), 90);
      } else {
        setKeyboardVisible(false);
        setKeyboardInset(0);
        scheduleScrollToBottom(0);
      }
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

  // На любое изменение количества сообщений — прижать вниз.
  // Android: делаем дополнительный проход после layout нового пузыря,
  // иначе первое положение может остаться под инпутом до позднего пересчёта.
  useEffect(() => {
    scheduleScrollToBottom(0);
    if (Platform.OS === 'android') {
      scheduleScrollToBottom(80);
      scheduleScrollToBottom(220);
    }
  }, [messages.length]);

  // Android: композер (+ emoji) в одном dock; IME поднимает KeyboardStickyView.
  const systemResizeDelta =
    Platform.OS === 'ios' && keyboardVisible
      ? Math.max(0, baseRootLayoutHRef.current - rootLayoutH)
      : 0;
  const keyboardLift =
    Platform.OS === 'android'
      ? 0
      : (keyboardVisible ? Math.max(0, keyboardInset - systemResizeDelta) : 0);

  const composerBottomLift = emojiPanelOpen ? CHAT_EMOJI_PANEL_HEIGHT : keyboardLift;
  // Android: pad для списка/empty/overlays — IME (окно не resize) или emoji-панель.
  const androidKeyboardPad = emojiPanelOpen
    ? CHAT_EMOJI_PANEL_HEIGHT + Math.max(0, insets.bottom)
    : Math.max(0, androidImeInset);

  const GapCenterIndicator = shouldShowChatGapCenter(peerActivity, forwardToast, lang) ? (
    <ChatGapCenterIndicator
      peerActivity={peerActivity}
      forwardToast={forwardToast}
      forwardToastOpacity={forwardToastOpacity}
      isDark={isDark}
      lang={lang}
    />
  ) : null;

  const DeleteToastInline = shouldShowChatDeleteToast(forwardToast, lang) ? (
    <ChatDeleteToastInline
      forwardToast={forwardToast}
      forwardToastOpacity={forwardToastOpacity}
      lang={lang}
    />
  ) : null;

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
      if (!peerId) {
        setFullAvatarUri(peerAvatarThumbB64Param || '');
        return;
      }

      // Открыто по пушу (нет версии аватара) — запрашиваем аватар по peerId
      if (!peerAvatarVerState) {
        if (peerAvatarThumbB64Param && !cancelled) setFullAvatarUri(peerAvatarThumbB64Param);
        try {
          const res = await getAvatar(peerId);
          if (cancelled) return;
          if (res?.ok && res.avatarB64 && res.avatarVer) {
            await putFull(peerId, res.avatarVer, res.avatarB64);
            setFullAvatarUri(res.avatarB64);
            setPeerAvatarVerState(res.avatarVer);
          } else if (!peerAvatarThumbB64Param) {
            setFullAvatarUri('');
          }
        } catch {
          if (!peerAvatarThumbB64Param && !cancelled) setFullAvatarUri('');
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

  /* Модалка аватара собеседника в шапке чата: полный экран, блюр/затемнение, круг 3×, pinch-to-zoom */
  const [avatarModalVisible, setAvatarModalVisible] = useState(false);
  const [modalAvatarUri, setModalAvatarUri] = useState<string>('');
  const avatarModalPinchScale = useRef(new Animated.Value(1)).current;
  const avatarModalBaseScale = useRef(new Animated.Value(1)).current;
  const avatarModalLastScale = useRef(1);

  useEffect(() => {
    if (!avatarModalVisible) return;
    if (!modalAvatarUri && fullAvatarUri) setModalAvatarUri(fullAvatarUri);
    if (peerId && peerAvatarVerState > 0) {
      getFull(peerId, peerAvatarVerState).then((fullUri) => {
        if (fullUri) setModalAvatarUri(fullUri);
      }).catch(() => {});
    }
    avatarModalPinchScale.setValue(1);
    avatarModalBaseScale.setValue(1);
    avatarModalLastScale.current = 1;
  }, [avatarModalVisible, modalAvatarUri, fullAvatarUri, peerId, peerAvatarVerState, avatarModalPinchScale, avatarModalBaseScale]);

  // Предразрешаем URI аватара из шапки, чтобы в модалке не было промежуточного кадра.
  const [headerAvatarResolvedUri, headerAvatarResolvedReady] = useResolvedImageUri(fullAvatarUri || '');
  // На Android в модалке data: URI показываем через разрешённый file: (Glide иначе не показывает)
  const [modalAvatarResolvedUri] = useResolvedImageUri(avatarModalVisible ? modalAvatarUri : '');
  const modalAvatarDisplayUri = (Platform.OS === 'android' && /^data:/i.test(modalAvatarUri)) ? modalAvatarResolvedUri : modalAvatarUri;
  const modalAvatarInstantUri =
    modalAvatarDisplayUri ||
    ((Platform.OS === 'android' && /^data:/i.test(modalAvatarUri))
      ? (headerAvatarResolvedReady ? headerAvatarResolvedUri : '')
      : modalAvatarUri) ||
    ((Platform.OS === 'android' && /^data:/i.test(fullAvatarUri))
      ? (headerAvatarResolvedReady ? headerAvatarResolvedUri : '')
      : fullAvatarUri) ||
    '';
  const modalAvatarExpected = !!modalAvatarUri || !!fullAvatarUri || peerAvatarVerState > 0;

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
      avatarModalBaseScale.setValue(next);
      avatarModalPinchScale.setValue(1);
    }
  }, [avatarModalBaseScale, avatarModalPinchScale]);

  const openAvatarModal = useCallback(async () => {
    let initialUri = fullAvatarUri || '';
    if (Platform.OS === 'android' && /^data:/i.test(initialUri) && headerAvatarResolvedReady && headerAvatarResolvedUri) {
      initialUri = headerAvatarResolvedUri;
    }
    if (!initialUri && peerId && peerAvatarVerState > 0) {
      try {
        const cachedFull = await getFull(peerId, peerAvatarVerState);
        if (cachedFull) initialUri = cachedFull;
      } catch {}
    }
    setModalAvatarUri(initialUri);
    setAvatarModalVisible(true);
  }, [fullAvatarUri, headerAvatarResolvedReady, headerAvatarResolvedUri, peerId, peerAvatarVerState]);

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
  const loadHiddenForMeMessageIds = React.useCallback(async (uid: string, pid: string): Promise<Set<string>> => {
    try {
      const raw = await AsyncStorage.getItem(getChatHiddenForMeKey(uid, pid));
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return new Set(
        Array.isArray(parsed)
          ? parsed.map((id: any) => String(id || '').trim()).filter(Boolean)
          : [],
      );
    } catch {
      return new Set();
    }
  }, []);

  const persistHiddenForMeMessageIds = React.useCallback(async (uid: string, pid: string, ids: Set<string>) => {
    try {
      const key = getChatHiddenForMeKey(uid, pid);
      const list = Array.from(ids).filter(Boolean).slice(-1000);
      if (list.length === 0) {
        await AsyncStorage.removeItem(key);
      } else {
        await AsyncStorage.setItem(key, JSON.stringify(list));
      }
    } catch {}
  }, []);

  const rememberHiddenForMeMessageId = React.useCallback(async (rawId: string) => {
    const id = String(rawId || '').trim();
    const uid = String(currentUserIdForPersistRef.current || '').trim();
    const pid = String(peerIdForPersistRef.current || '').trim();
    if (!id || !uid || !pid) return;
    const next = new Set(hiddenForMeMessageIdsRef.current);
    next.add(id);
    hiddenForMeMessageIdsRef.current = next;
    await persistHiddenForMeMessageIds(uid, pid, next);
  }, [persistHiddenForMeMessageIds]);

  const rememberHiddenForMeMessageIds = React.useCallback(async (rawIds: string[]) => {
    const ids = Array.from(new Set(
      (rawIds || []).map((rawId) => String(rawId || '').trim()).filter(Boolean),
    ));
    const uid = String(currentUserIdForPersistRef.current || '').trim();
    const pid = String(peerIdForPersistRef.current || '').trim();
    if (ids.length === 0 || !uid || !pid) return;
    const next = new Set(hiddenForMeMessageIdsRef.current);
    for (const id of ids) next.add(id);
    hiddenForMeMessageIdsRef.current = next;
    await persistHiddenForMeMessageIds(uid, pid, next);
  }, [persistHiddenForMeMessageIds]);

  /**
   * Одна очередь на запись чата в AsyncStorage: параллельные setItem давали multi-second spikes.
   * Снимок всегда из ref в момент выполнения — быстрые пачки обновлений схлопываются в одну запись.
   */
  const { enqueueMessagesPersist } = useChatMessagePersist({
    historyReady,
    messages,
    currentUserId,
    peerId,
    currentUserIdForPersistRef,
    peerIdForPersistRef,
    latestMessagesForPersistRef,
  });

  const saveStatuses = async (statuses: Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>) => {
    try {
      // Читаем id из ref: эффект reconnect подписан с deps [] и иначе мог бы сохранять статусы под устаревшими peer/user.
      const uid = String(currentUserIdForPersistRef.current || '').trim();
      const pid = String(peerIdForPersistRef.current || '').trim();
      if (!uid || !pid) return;
      const key = getChatStatusesKey(uid, pid);
      await AsyncStorage.setItem(key, JSON.stringify(statuses));
    } catch (error) {
      // Игнорируем ошибки сохранения
    }
  };

  const loadStatuses = async (): Promise<Record<string, 'sending' | 'delivered' | 'read' | 'failed'>> => {
    try {
      const uid = String(currentUserIdForPersistRef.current || '').trim();
      const pid = String(peerIdForPersistRef.current || '').trim();
      if (!uid || !pid) return {};
      const key = getChatStatusesKey(uid, pid);
      const savedStatuses = await AsyncStorage.getItem(key);
      if (savedStatuses) {
        return JSON.parse(savedStatuses);
      }
      return {};
    } catch (error) {
      return {};
    }
  };

  useEffect(() => {
    // Быстрая инициализация как в старой версии
    const initializeChat = async () => {
      
      try {
        let userId: string | null = null;
        try {
          userId = getCurrentSocketUserId() || null;
        } catch {}
        if (userId) {
          setCurrentUserId(userId);
        }
        if (!userId) {
          userId = await getMyUserId();
        }
        if (!userId) {
          try {
            const raw = await AsyncStorage.getItem('userId');
            if (raw && /^[a-f\d]{24}$/i.test(String(raw))) {
              userId = String(raw);
            }
          } catch {}
        }
        
        if (userId) {
          setCurrentUserId(userId);
        } else {
          console.warn('🔍 ChatScreen: no userId received from getMyUserId');
        }

        setLoading(false);
        
      } catch (e) {
        console.error('❌ Chat init failed:', e);
        setLoading(false);
      }
    };

    // Инициализируем асинхронно
    initializeChat();

  }, [peerId, route?.params?.peerName, route?.params?.peerAvatar]);

  // Реактивно подхватываем userId из socket-модуля (boot/reauth), чтобы оффлайн-чат
  // не зависел от результата сетевого getMyUserId().
  useEffect(() => {
    const off = onCurrentUserId((id) => {
      const next = String(id || '').trim();
      if (next) setCurrentUserId(next);
    });
    return () => {
      try { off?.(); } catch {}
    };
  }, []);

  // Слушатели сообщений через сокеты

  const messagesRef = useRef<any[]>([]);

  const headerH = 56;
  const headerTopPadding = 14;

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

  useChatRealtime({
    peerId,
    currentUserId,
    setMessages,
    setUploadStatus,
    setSelectedMessageIds,
    updateReadStatuses,
    resolveMediaUri,
    scrollToBottom,
    latestMessagesForPersistRef,
    isFocusedRef,
    readReceiptSentIdsRef,
    deletedServerMessageIdsRef,
    outboxLocalIdToServerIdRef,
    rememberDeletedServerMessageId,
    rememberOutboxLocalToServerId,
    enqueueMessagesPersist,
  });


  const {
    playingAudioId,
    playingAudioState,
    togglePlayAudioMessage,
  } = useChatAudioPlayback({ messages, resolveMediaUri });

  const {
    retryUiForId,
    setRetryUiForId,
    enqueueMediaOutboxId,
    dequeueMediaOutboxId,
    retryFailedOutgoingMessage,
  } = useChatMediaOutbox({
    peerId,
    currentUserId,
    messages,
    setMessages,
    uploadStatus,
    setUploadStatus,
    readStatuses,
    updateReadStatuses,
    resolveMediaUri,
  });

  const {
    sendVoiceMessageFromLocal,
    sendPickedImage,
    sendPickedAlbum,
  } = useChatSendMedia({
    peerId,
    currentUserId,
    setMessages,
    setUploadStatus,
    updateReadStatuses,
    resolveMediaUri,
    enqueueMediaOutboxId,
    dequeueMediaOutboxId,
    setVoiceRecordMs,
  });

  sendVoiceFromLocalRef.current = sendVoiceMessageFromLocal;

  const formatDuration = formatVoiceDuration;
  const formatDurationDot = formatVoiceDurationDot;

  useChatHistorySync({
    peerId,
    currentUserId,
    setCurrentUserId,
    messages,
    setMessages,
    messagesRef,
    historyReady,
    setHistoryReady,
    setChatImagesWarm,
    setReadStatuses,
    updateReadStatuses,
    loadStatuses,
    loadHiddenForMeMessageIds,
    hiddenForMeMessageIdsRef,
    deletedServerMessageIdsRef,
    uploadStatusRef,
    readStatusesRef,
    isFocusedRef,
    enqueueMessagesPersist,
    currentUserIdForPersistRef,
    peerIdForPersistRef,
    latestMessagesForPersistRef,
    navigation,
    resolveMediaUri,
  });

  // КРИТИЧНО: headerInitial — только глиф для аватара (буква/emoji), не полный текст ника
  const [peerNameState, setPeerNameState] = useState<string>(peerNameParam);
  const headerInitial = peerNameState ? displayAvatarLetter(peerNameState) : '--';
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
    let presenceOfflineDebounce: ReturnType<typeof setTimeout> | null = null;
    const offPresence = onPresenceUpdate?.((data: any) => {
      // Обрабатываем только массив (для online статуса), игнорируем объекты {userId, busy}
      if (Array.isArray(data)) {
        const onlineSet = new Set((data || []).map((it: any) => String((it as any)?._id ?? it)));
        const isOn = onlineSet.has(String(peerId));
        if (isOn) {
          if (presenceOfflineDebounce) {
            clearTimeout(presenceOfflineDebounce);
            presenceOfflineDebounce = null;
          }
          setPeerOnline(true);
          try {
            navigation.setParams({ peerOnline: true } as any);
          } catch {}
          return;
        }
        if (!presenceOfflineDebounce) {
          presenceOfflineDebounce = setTimeout(() => {
            presenceOfflineDebounce = null;
            setPeerOnline(false);
            try {
              navigation.setParams({ peerOnline: false } as any);
            } catch {}
          }, PRESENCE_OFFLINE_DEBOUNCE_MS);
        }
      }
    });
    return () => {
      if (presenceOfflineDebounce) clearTimeout(presenceOfflineDebounce);
      offProfile?.();
      offPresence?.();
    };
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

  // После прочтения бейдж чинится через markMessagesAsRead + sync. Здесь только «живой» фокус приложения:
  // иначе при inactive/background спurious focus снимал всю шторку и обнулял бейдж (глобальный dismissAll).
  useEffect(() => {
    const unsub = navigation?.addListener?.('focus', () => {
      const run = () => {
        if (AppState.currentState !== 'active') return;
        try {
          if (peerId) void dismissMessageNotificationForUser(peerId);
          void syncAppBadgeFromMissedCount();
        } catch {}
      };
      run();
      requestAnimationFrame(() => {
        if (AppState.currentState !== 'active') return;
        run();
      });
    });
    return () => {
      try { unsub?.(); } catch {}
    };
  }, [navigation, peerId]);

  // Предзагрузка удалена - теперь используется система кеширования в AvatarImage

  const Loading = () => (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "transparent",
      }}
    >
      <ActivityIndicator />
      <Text style={{ color: LIVI.text, marginTop: 12 }}>{t('chatLoading', lang)}</Text>
    </View>
  );
  // КРИТИЧНО: НЕ делаем ранние return по loading/err, иначе ниже хуки (useMemo/useCallback) будут
  // вызываться не на каждом рендере -> "Rendered more hooks than during the previous render".
  const isEmpty = messages.length === 0;
  const chatFeedReady = historyReady && chatImagesWarm;
  const showEmpty = isEmpty && chatFeedReady;

  // При входе в чат: прогреть кэш картинок (короткий таймаут), чтобы облака не мерцали.
  useChatImageWarm({
    historyReady,
    messages,
    resolveMediaUri,
    chatImagesWarm,
    setChatImagesWarm,
  });

  const { openClearMenu, clearChatForMe, clearChatForAll } = useChatClear({
    peerId,
    currentUserId,
    lang,
    setMessages,
    setShowClearMenu,
    openConfirm,
    showNotice,
  });

  const { deleteSingleMessage, batchDeleteSelected } = useChatDeleteOps({
    peerId,
    currentUserId,
    lang,
    selectedMessageIds,
    messagesRef,
    outboxLocalIdToServerIdRef,
    latestMessagesForPersistRef,
    batchDeleteSelectedRef,
    setMessages,
    setUploadStatus,
    setSelectedMessage,
    setSelectionMode,
    setSelectedMessageIds,
    updateReadStatuses,
    enqueueMessagesPersist,
    dequeueMediaOutboxId,
    rememberDeletedServerMessageId,
    rememberHiddenForMeMessageId,
    rememberHiddenForMeMessageIds,
    hideMessageActions,
    exitSelectionMode,
    showForwardToastBadge,
    showNotice,
  });

  const confirmDeleteSelectedMessage = React.useCallback((m: any) => {
    if (!m?.id) return;
    // Закрываем нижний sheet (если открыт), чтобы не было наложений
    try { hideMessageActions(); } catch {}
    openDeleteConfirmSingle(m);
  }, [hideMessageActions, openDeleteConfirmSingle]);

  const copySelectedMessage = React.useCallback(async (m: any) => {
    const type = String(m?.type || '').trim();
    const text = String(m?.text ?? '').trim();
    const rawUri = String(m?.uri ?? '').trim();

    const value =
      text ||
      (type === 'sticker' ? getStickerFallbackText(m, lang) : '') ||
      ((type === 'image' || type === 'audio') && rawUri ? resolveMediaUri(rawUri) : '');

    if (!value) return;
    try {
      await Clipboard.setStringAsync(value);
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    } catch {}
  }, [resolveMediaUri, lang]);

  const {
    forwardToRecipient,
    forwardToSelectedFriends,
    shareForwardToSystem,
    forwardSelectedMessageTo,
    startForwardSelected,
  } = useChatForwardSend({
    peerId,
    currentUserId,
    lang,
    messages,
    selectionMode,
    selectedCount,
    selectedHasAnyForwardable,
    selectedMessageIds,
    selectedMessage,
    forwardFriends,
    forwardSelectedFriendIds,
    setMessages,
    setSelectionMode,
    setSelectedMessageIds,
    setShowForwardPicker,
    setForwardSelectedFriendIds,
    updateReadStatuses,
    resolveMediaUri,
    scrollToBottom,
    scheduleScrollToBottom,
    hideMessageActions,
    showForwardToastBadge,
    showNotice,
    openForwardPicker,
  });

  // На Android: системная кнопка «Назад» — шаг назад (закрыть чат или выйти из режима выбора), а не на страницу приветствия
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectionMode) {
        exitSelectionMode();
        return true;
      }
      if (emojiPanelOpen) {
        setEmojiPanelOpen(false);
        return true;
      }
      if (navigation?.goBack) {
        navigation.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [selectionMode, exitSelectionMode, navigation, emojiPanelOpen]);

  useEffect(() => {
    const selectedId = String(selectedMessage?.id || '').trim();
    if (!selectedId) return;
    const stillExists = messages.some((msg) => String(msg?.id || '').trim() === selectedId);
    if (stillExists) return;
    if (showMessageActions) {
      try { hideMessageActions(); } catch {}
    }
    setSelectedMessage(null);
  }, [selectedMessage, messages, showMessageActions, hideMessageActions]);

  const confirmDeleteNow = React.useCallback(() => {
    const { pending: m, forBoth } = consumeDeleteConfirm();
    if (Array.isArray(m?.ids)) {
      const ids = m.ids.map((id: any) => String(id || '').trim()).filter(Boolean);
      if (ids.length > 0) void batchDeleteSelectedRef.current?.(forBoth, ids);
      return;
    }
    const id = String(m?.id || '').trim();
    if (id) void deleteSingleMessage(id, forBoth);
  }, [deleteSingleMessage, consumeDeleteConfirm]);

  const handleScrollToIndexFailed = React.useCallback((info: { index: number; averageItemLength?: number }) => {
    const fl = flatListRef.current as any;
    if (!fl) return;
    setTimeout(() => {
      try {
        fl.scrollToIndex?.({ index: info.index, animated: true, viewPosition: 0.35 });
      } catch {}
    }, 120);
  }, []);

  const scrollToQuotedMessage = React.useCallback(
    (quotedMessageId: string) => {
      const id = String(quotedMessageId || '').trim();
      if (!id) return;

      const listData =
        Platform.OS === 'android' ? androidChatListDataRef.current : iosChatListDataRef.current;
      const index = indexInChatListData(listData, id);
      if (index < 0) {
        showNotice('info', 'LiVi', t('chatReplyOriginalNotFound', lang));
        return;
      }

      if (highlightClearTimerRef.current) {
        clearTimeout(highlightClearTimerRef.current);
        highlightClearTimerRef.current = null;
      }

      setHighlightedMessageId(id);

      requestAnimationFrame(() => {
        try {
          (flatListRef.current as any)?.scrollToIndex?.({
            index,
            animated: true,
            viewPosition: 0.35,
          });
        } catch {}
      });

      highlightClearTimerRef.current = setTimeout(() => {
        setHighlightedMessageId(null);
        highlightClearTimerRef.current = null;
      }, 1500);
    },
    [messages, showNotice, lang],
  );

  useEffect(() => {
    return () => {
      if (highlightClearTimerRef.current) {
        clearTimeout(highlightClearTimerRef.current);
        highlightClearTimerRef.current = null;
      }
    };
  }, []);


  const confirmDeleteSelected = React.useCallback(() => {
    if (selectedCount === 0) return;
    openDeleteConfirmMulti(Array.from(selectedMessageIds));
  }, [selectedCount, selectedMessageIds, openDeleteConfirmMulti]);


  const headerApi = useChatHeader({
    lang,
    headerH,
    headerTopPadding,
    LIVI,
    BORDER_WIDTH,
    BORDER_COLOR,
    navigation,
    isDark,
    outlineColor: (theme.colors?.outline as string) || 'rgba(0,0,0,0.12)',
    peerNameState,
    peerOnline,
    peerId,
    peerAvatarVerState,
    fullAvatarUri,
    headerInitial,
    openAvatarModal,
    selectionMode,
    selectedCount,
    exitSelectionMode,
    selectAllLoaded,
    startForwardSelected,
    confirmDeleteSelected,
  });
  const headerEl = headerApi.headerEl;

  const {
    requestImageAction,
    applyAlbumPick,
  } = useChatAlbumImageActions({
    currentUserId,
    lang,
    resolveMediaUri,
    setMessages,
    setSelectedMessage,
    setAlbumFocusIndex,
    openForwardPicker,
    openAlbumScope,
    consumeAlbumScope,
    confirmDeleteSelectedMessage,
    showForwardToastBadge,
    showNotice,
  });

  const { handleLongPressMessage, handleLongPressAlbumTile } = useChatLongPressMessage({
    currentUserId,
    lang,
    messageTextRef,
    setMessageText,
    setEditingMessageId,
    setReplyingToMessage,
    setSelectedMessage,
    setAlbumFocusIndex,
    copySelectedMessage,
    showMessageActionsSheet,
    clearAndroidLayoutIfNeeded,
    enterSelectionModeFromMessage,
    requestImageAction,
  });

  // Функция для получения анимации сообщения (стабильная ссылка, чтобы не ломать мемоизацию)
  const getMessageAnimation = React.useCallback((messageId: string) => {
    if (!messagePressAnimations[messageId]) {
      messagePressAnimations[messageId] = new Animated.Value(1);
    }
    return messagePressAnimations[messageId];
  }, [messagePressAnimations]);

  // Функция для анимации нажатия на сообщение
  const animateMessagePress = React.useCallback(
    (messageId: string, callback?: () => void, options?: { immediate?: boolean }) => {
      const animation = getMessageAnimation(messageId);

      // Long press: тактиль и лёгкое сжатие облака здесь, а не при показе меню.
      if (options?.immediate) {
        if (Platform.OS === 'ios') {
          try {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          } catch {
            Vibration.vibrate(5);
          }
        } else {
          try {
            Vibration.vibrate(10);
          } catch {}
        }
        animation.stopAnimation();
        animation.setValue(1);
        Animated.sequence([
          Animated.timing(animation, {
            toValue: 0.96,
            duration: 55,
            useNativeDriver: true,
          }),
          Animated.timing(animation, {
            toValue: 1,
            duration: 130,
            useNativeDriver: true,
          }),
        ]).start();
        callback?.();
        return;
      }

      if (Platform.OS === 'ios') {
        try {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } catch {
          Vibration.vibrate(3);
        }
      } else {
        Vibration.vibrate(25);
      }

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
        callback?.();
      });
    },
    [getMessageAnimation]
  );

  // Двойной тап по облачку сообщения — показать полосу реакций
  const lastTapForReactionRef = useRef({ time: 0, id: '' });
  const handleMessagePress = React.useCallback((item: any) => {
    const now = Date.now();
    const prev = lastTapForReactionRef.current;
    if (prev.id === item.id && now - prev.time < 400) {
      setReactionBarForMessageId(item.id);
      lastTapForReactionRef.current = { time: 0, id: '' };
      return;
    }
    lastTapForReactionRef.current = { time: now, id: item.id };
    animateMessagePress(item.id);
  }, [animateMessagePress]);

  /** Нажатие на реакцию — снять свою реакцию (toggle), обновляется у обоих. */
  const handleReactionPress = React.useCallback((messageId: string, emoji: string) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (String(m?.id) !== messageId) return m;
        const reactions = Array.isArray(m.reactions) ? m.reactions : [];
        const next = reactions.filter((r: any) => !(r.emoji === emoji && r.userId === currentUserId));
        return { ...m, reactions: next };
      })
    );
    sendMessageReaction(messageId, emoji, peerId).catch(() => {});
  }, [currentUserId, peerId]);

  const {
    sendMessage,
    onPressSendButton,
    toggleEmojiPanel,
    dismissComposerKeyboard,
    handleComposerEmojiSelected,
    handleComposerStickerSelected,
  } = useChatComposer({
    peerId,
    currentUserId,
    lang,
    voiceIsRecording,
    editingMessageId,
    setEditingMessageId,
    replyingToMessage,
    setReplyingToMessage,
    messageTextRef,
    setMessageText,
    setEmojiPanelOpen,
    setMessages,
    setUploadStatus,
    updateReadStatuses,
    stopVoiceRecording,
    stopLocalTyping,
    signalLocalTyping,
    rememberOutboxLocalToServerId,
  });

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

  useChatIncomingShare({
    peerId,
    currentUserId,
    route,
    navigation,
    lang,
    setMessages,
    setUploadStatus,
    updateReadStatuses,
    resolveMediaUri,
    sendPickedImage,
    showForwardToastBadge,
    scheduleScrollToBottom,
    scrollToBottom,
  });

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
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        // Не обрезаем принудительно: даём предпросмотр и возможность обрезать/не обрезать
        allowsEditing: false,
        allowsMultipleSelection: true,
        selectionLimit: CHAT_ALBUM_MAX,
        quality: 0.8,
      });

      if (!result.canceled && result.assets?.length) {
        const assets = result.assets.slice(0, CHAT_ALBUM_MAX);
        if (assets.length === 1) {
          openComposeViewer(assets[0]);
        } else {
          void sendPickedAlbum(assets);
        }
      }
    } catch (error) {
      console.error('Image picker error:', error);
      showNotice('error', t('errorTitle', lang), t('pickImageFailed', lang));
    }
  };


  // MessageItem вынесен в ./chat/ChatMessageItem (стабильный React.memo на уровне модуля).


  // КРИТИЧНО: на каждый ввод нельзя пересоздавать массив data для FlatList,
  // иначе он будет перерисовывать (а иногда и переразмещать) все элементы -> мерцание изображений.
  const iosChatListData = React.useMemo(
    () => (!chatFeedReady || isEmpty ? [] : buildChatListRows(messages)),
    [chatFeedReady, isEmpty, messages],
  );

  const androidChatListData = React.useMemo(() => {
    if (!chatFeedReady || isEmpty) return [];
    return [...buildChatListRows(messages)].reverse();
  }, [chatFeedReady, isEmpty, messages]);

  iosChatListDataRef.current = iosChatListData;
  androidChatListDataRef.current = androidChatListData;

  const handleToggleRetryUi = React.useCallback((id: string) => {
    setRetryUiForId((prev) => (prev === id ? null : id));
  }, []);

  const handleRootLayout = React.useCallback((e: any) => {
    const h = Math.max(0, Math.round(Number(e?.nativeEvent?.layout?.height || 0)));
    if (!h) return;
    if (Math.abs(rootLayoutH - h) > 1) {
      setRootLayoutH(h);
    }
    if (!keyboardVisible) {
      baseRootLayoutHRef.current = h;
    }
  }, [keyboardVisible, rootLayoutH]);

  const handleInputBarLayout = React.useCallback((e: any) => {
    const h = Math.max(0, Math.round(Number(e?.nativeEvent?.layout?.height || 0)));
    if (!h || Math.abs(inputHeight - h) <= 1) return;
    setInputHeight(h);
  }, [inputHeight]);

  // Android list viewport ends above the dock. Keeping the reserve on the
  // viewport (rather than in an inverted ListHeader) prevents the newest
  // bubble from being drawn underneath the composer.
  const resolvedInputBarH = inputHeight > 0 ? inputHeight : estimatedInputHeight;
  // One persistent status slot on every Android device. Typing/recording and
  // transient delivery/deletion labels use it without moving chat bubbles.
  const androidInlineStatusGapH = 24;
  const androidListBottomReserve =
    resolvedInputBarH + androidKeyboardPad + androidInlineStatusGapH;
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    scheduleScrollToBottom(0);
  }, [androidInlineStatusGapH]);
  // Empty: центр в зоне над композером (+IME / emoji).
  const androidEmptyBottomPad = Math.max(
    72,
    resolvedInputBarH + androidKeyboardPad + 10,
  );
  // Центр видимой области сообщений (над композером), не всего экрана.
  const chatEmptyFeedPlaceholder = React.useMemo(() => {
    if (!showEmpty) return null;
    return (
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          // Android: над инпутом (+IME). iOS: родитель уже ужат KeyboardAvoidingView.
          bottom: Platform.OS === 'android' ? androidEmptyBottomPad : 0,
          justifyContent: 'center',
          alignItems: 'center',
          paddingHorizontal: 28,
          zIndex: 1,
        }}
      >
        <Ionicons
          name="chatbubble-outline"
          size={64}
          color={isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.55)'}
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
  }, [showEmpty, androidEmptyBottomPad, isDark, peerNameParam]);

  const renderMessageRow = React.useCallback(
    ({ item }: { item: ChatListRow }) => {
      if (item.type === 'date') {
        return (
          <View style={{ paddingTop: 10, paddingBottom: 6, alignItems: 'center' }}>
            <Text
              style={{
                fontSize: 12,
                fontWeight: isDark ? '300' : '600',
                // Светлые обои: onSurfaceVariant слишком бледный — как стрелка назад (titan).
                color: isDark ? LIVI.text : LIVI.titan,
                textAlign: 'center',
                ...(Platform.OS === 'android' && !isDark ? { fontFamily: 'sans-serif-medium' } : null),
              }}
              allowFontScaling={false}
            >
              {item.label}
            </Text>
          </View>
        );
      }
      const msg = item as any;
      const isOwnMessage = msg?.sender === 'me' || msg?.from === currentUserId;
      return (
        <ChatMessageItem
          item={msg}
          currentUserId={currentUserId}
          readStatus={isOwnMessage ? readStatuses[msg.id] : undefined}
          uploadStatus={isOwnMessage ? uploadStatus[msg.id] : undefined}
          onPressImage={openMediaViewer}
          onPressAudio={togglePlayAudioMessage}
          playingAudioId={playingAudioId}
          playingAudioState={playingAudioState}
          retryUiForId={retryUiForId}
          onToggleRetryUi={handleToggleRetryUi}
          onRetryFailed={retryFailedOutgoingMessage}
          onLongPressMessage={handleLongPressMessage}
          onLongPressAlbumTile={handleLongPressAlbumTile}
          albumFocusIndex={
            showMessageActions &&
            selectedMessage &&
            String(selectedMessage?.id || '') === String(msg?.id || '')
              ? albumFocusIndex
              : null
          }
          onMessagePress={handleMessagePress}
          onReactionPress={handleReactionPress}
          selectionMode={selectionMode}
          isSelected={
            isImageAlbumMessage(msg)
              ? selectedAlbumIndices(msg, selectedMessageIds).length ===
                getMessageImageUris(msg).length
              : selectedMessageIds.has(String(msg.id))
          }
          onToggleSelect={toggleSelectMessage}
          selectedAlbumIndices={
            isImageAlbumMessage(msg) ? selectedAlbumIndices(msg, selectedMessageIds) : []
          }
          onToggleAlbumTileSelect={(index) => {
            toggleSelectAlbumTile(String(msg.id), index);
          }}
          resolveMediaUri={resolveMediaUri}
          peerDisplayName={peerNameState}
          highlightedMessageId={highlightedMessageId}
          onPressReplyQuote={scrollToQuotedMessage}
          animateMessagePress={animateMessagePress}
          getMessageAnimation={getMessageAnimation}
          formatDurationDot={formatDurationDot}
          BUBBLE_BG_OUT={BUBBLE_BG_OUT}
          BUBBLE_BG_IN={BUBBLE_BG_IN}
          BORDER_COLOR={BORDER_COLOR}
          LIVI={LIVI}
          isDark={isDark}
          lang={lang}
        />
      );
    },
    [
      currentUserId,
      readStatuses,
      uploadStatus,
      openMediaViewer,
      togglePlayAudioMessage,
      playingAudioId,
      playingAudioState,
      retryUiForId,
      handleToggleRetryUi,
      retryFailedOutgoingMessage,
      handleLongPressMessage,
      handleLongPressAlbumTile,
      showMessageActions,
      selectedMessage,
      albumFocusIndex,
      handleMessagePress,
      handleReactionPress,
      selectionMode,
      selectedMessageIds,
      toggleSelectMessage,
      toggleSelectAlbumTile,
      resolveMediaUri,
      peerNameState,
      highlightedMessageId,
      scrollToQuotedMessage,
      animateMessagePress,
      getMessageAnimation,
      formatDurationDot,
      BUBBLE_BG_OUT,
      BUBBLE_BG_IN,
      BORDER_COLOR,
      LIVI,
      isDark,
      lang,
    ],
  );

  return (
    <SafeAreaView 
      // IMPORTANT: color the top safe-area (status bar area) to match the header.
      // Otherwise on Android (with translucent StatusBar) you'll see a white strip above the header.
      style={{ flex: 1, backgroundColor: LIVI.bg }}
      // Android: bottom inset добавляем вручную только когда клавиатура скрыта,
      // иначе получаем лишний зазор между инпутом и клавиатурой на разных прошивках.
      edges={Platform.OS === 'android' ? ['top', 'left', 'right'] : ['top', 'bottom', 'left', 'right']}
    >
      <StatusBar
        barStyle={Platform.OS === 'android' || isDark ? 'light-content' : 'dark-content'}
        translucent={Platform.OS === 'android'}
        backgroundColor={Platform.OS === 'android' ? 'transparent' : undefined}
      />
      <View
        style={{ flex: 1, backgroundColor: isDark ? '#16243D' : '#B8D4EA' }}
        // Не блокируем весь экран pointerEvents='none': на Android это иногда "съедало" первый тап.
        pointerEvents="auto"
        onLayout={handleRootLayout}
      >
        {/* Обои на весь корень (не только под шапкой) — иначе при повороте планшета
            справа/снизу остаётся plate, пока внутренний flex ещё со старым layout. */}
        <ChatParallaxWallpaper isDark={isDark} />
        {headerEl}
        <View style={{ flex: 1, overflow: 'hidden', backgroundColor: 'transparent' }}>
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
              <Text style={{ color: LIVI.white, fontWeight: "700" }}>{t('tryAgain', lang)}</Text>
            </TouchableOpacity>
          </View>
        ) : Platform.OS === 'ios' ? (
          // iOS версия с KeyboardAvoidingView
          (<KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior="padding"
            keyboardVerticalOffset={0}
          >
            <View style={{ flex: 1 }}>
            <FlatList
              ref={flatListRef}
              data={iosChatListData}
              keyExtractor={(item) => item.id}
              renderItem={renderMessageRow}
              style={{
                flex: 1,
                backgroundColor: 'transparent',
              }}
              contentContainerStyle={{ 
                flexGrow: 1,
                justifyContent: showEmpty ? 'center' : 'flex-end',
                paddingVertical: 16,
                paddingBottom: 20,
              }}
              ListFooterComponent={null}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              onScrollBeginDrag={dismissComposerKeyboard}
              showsVerticalScrollIndicator={false}
              inverted={false}
              onScrollToIndexFailed={handleScrollToIndexFailed}
              initialNumToRender={CHAT_LIST_INITIAL_NUM_TO_RENDER}
              maxToRenderPerBatch={CHAT_LIST_MAX_TO_RENDER_PER_BATCH}
              windowSize={CHAT_LIST_WINDOW_SIZE}
              updateCellsBatchingPeriod={CHAT_LIST_UPDATE_CELLS_BATCHING_PERIOD}
              onContentSizeChange={() => setTimeout(() => scrollToBottom(), 0)}
              ListEmptyComponent={() => {
                if (!chatFeedReady) {
                  return (
                    <View
                      style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        backgroundColor: 'transparent',
                      }}
                    >
                      <ActivityIndicator color={LIVI.titan} />
                    </View>
                  );
                }
                return null;
              }}
            />
            {chatEmptyFeedPlaceholder}
            </View>
            {DeleteToastInline ? (
              <View pointerEvents="none" style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 8 }}>
                {DeleteToastInline}
              </View>
            ) : null}
            {!isEmpty && GapCenterIndicator ? (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: Math.max(inputHeight > 0 ? inputHeight : estimatedInputHeight, 72) + 4,
                  alignItems: 'center',
                  zIndex: 8,
                }}
              >
                {GapCenterIndicator}
              </View>
            ) : null}
            {/* Поле ввода для iOS */}
            <View
              style={{
                borderTopWidth: BORDER_WIDTH,
                borderTopColor: BORDER_COLOR,
                backgroundColor: INPUT_BAR_BG,
                paddingHorizontal: 16,
                paddingTop: voiceIsRecording ? 8 : 18,
                // Важно: симметричные отступы сверху/снизу вокруг инпута
                // SafeAreaView уже обрабатывает safe area, поэтому не добавляем insets.bottom
                paddingBottom: 18,
              }}
              onLayout={handleInputBarLayout}
            >
              {voiceIsRecording && (
                <View style={{ alignItems: 'center', marginBottom: 8 }}>
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
              {replyingToMessage && (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginBottom: 10,
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    borderRadius: 14,
                    backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
                    borderWidth: 1,
                    borderColor: BORDER_COLOR,
                  }}
                >
                  <Ionicons name="arrow-undo-outline" size={20} color={LIVI.replyQuoteAccent} style={{ marginRight: 10 }} />
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <Text style={{ color: LIVI.replyQuoteAccent, fontSize: 13, fontWeight: '600', marginBottom: 2 }}>
                      {t('chatReplyingTo', lang).replace('{name}', replyingToMessage.isOwn ? t('you', lang) : peerNameState)}
                    </Text>
                    <Text style={{ color: LIVI.white, fontSize: 14, opacity: 0.9 }} numberOfLines={1} ellipsizeMode="tail">
                      {replyingToMessage.text || '—'}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => setReplyingToMessage(null)}
                    hitSlop={8}
                    style={{ padding: 4 }}
                  >
                    <Ionicons name="close-circle" size={24} color={LIVI.titan} />
                  </TouchableOpacity>
                </View>
              )}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  backgroundColor: "rgba(255,255,255,0.06)",
                  borderRadius: 24,
                  paddingHorizontal: 14,
                  paddingVertical: Platform.OS === 'ios' ? 5 : 2,
                  borderWidth: 1,
                  borderColor: BORDER_COLOR,
                }}
              >
                {/* Кнопка очистки убрана по требованию */}
                {voiceIsRecording ? (
                  <Pressable
                    hitSlop={10}
                    accessibilityRole="button"
                    onPress={() => {
                      void cancelVoiceRecordingWithAnimation();
                    }}
                    style={{ marginRight: 12 }}
                  >
                    <Animated.View
                      ref={(r) => { trashMeasureRef.current = r as any; }}
                      onLayout={() => updateTrashZone()}
                      style={{
                        padding: 2,
                        transform: [
                          { scale: trashFlash.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) },
                          { rotate: trashLid.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-14deg'] }) },
                        ],
                        opacity: trashFlash.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }),
                      }}
                    >
                      <Ionicons name="trash-outline" size={28} color="#FF5A67" />
                    </Animated.View>
                  </Pressable>
                ) : (
                  <TouchableOpacity
                    onPress={handleAttachments}
                    hitSlop={COMPOSER_HIT_ATTACH}
                    style={{
                      padding: 2,
                      marginRight: 12,
                    }}
                  >
                    <Ionicons name="image" size={28} color={LIVI.titan} />
                  </TouchableOpacity>
                )}

                {!voiceIsRecording ? (
                  <TouchableOpacity
                    onPress={toggleEmojiPanel}
                    hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                    style={{ padding: 2, marginRight: 8 }}
                    accessibilityLabel="Emoji"
                  >
                    <Ionicons
                      name={emojiPanelOpen ? 'keypad-outline' : 'happy-outline'}
                      size={26}
                      color={emojiPanelOpen ? LIVI.accent.bright : LIVI.titan}
                    />
                  </TouchableOpacity>
                ) : null}

                {/* minWidth:0 — иначе Android multiline TextInput раздувает hit-box и перекрывает микрофон/отправку */}
                <View style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}>
                  <TextInput
                    style={{
                      flex: 1,
                      color: voiceIsRecording ? 'transparent' : LIVI.white,
                      fontSize: 16,
                      lineHeight: 20,
                      paddingTop: 2,
                      paddingBottom: 2,
                      maxHeight: composerTextInputMaxHeight,
                    }}
                    placeholder={t('chatMessagePlaceholder', lang)}
                    placeholderTextColor={voiceIsRecording ? 'transparent' : LIVI.titan}
                    value={messageText}
                    onChangeText={(txt) => {
                      messageTextRef.current = txt;
                      setMessageText(txt);
                      signalLocalTyping();
                    }}
                    onFocus={() => setEmojiPanelOpen(false)}
                    multiline
                    scrollEnabled
                    onSubmitEditing={sendMessage}
                    returnKeyType="send"
                    caretHidden={voiceIsRecording}
                    autoCorrect={true}
                    spellCheck={true}
                  />
                  {voiceIsRecording ? (
                    <View
                      pointerEvents="none"
                      style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        justifyContent: 'center',
                      }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', height: 36 }}>
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
                    </View>
                  ) : null}
                </View>

                <Animated.View
                  {...micPanResponder.panHandlers}
                  collapsable={false}
                  style={{
                    marginLeft: 4,
                    marginRight: 0,
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    alignItems: 'center',
                    justifyContent: 'center',
                    transform: [{ scale: micScale }],
                    backgroundColor: voiceIsRecording ? LIVI.titan : 'rgba(255,255,255,0.2)',
                    borderWidth: 1,
                    borderColor: BORDER_COLOR,
                  }}
                >
                  <View pointerEvents="none" style={{ alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons
                      name={voiceIsRecording ? 'mic' : 'mic-outline'}
                      size={20}
                      color={voiceIsRecording ? '#FF5A67' : LIVI.titan}
                    />
                  </View>
                </Animated.View>

                <TouchableOpacity
                  onPress={onPressSendButton}
                  hitSlop={COMPOSER_HIT_SEND}
                  accessibilityState={{ disabled: !messageText.trim() && !voiceIsRecording }}
                  activeOpacity={messageText.trim() || voiceIsRecording ? 0.88 : 1}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor:
                      messageText.trim() || voiceIsRecording
                        ? LIVI.titan
                        : 'rgba(255,255,255,0.2)',
                    marginLeft: 12,
                    borderWidth: 1,
                    borderColor: BORDER_COLOR,
                  }}
                >
                  <Ionicons
                    name="send"
                    size={20}
                    color={messageText.trim() || voiceIsRecording ? LIVI.white : LIVI.titan}
                  />
                </TouchableOpacity>
              </View>
              {emojiPanelOpen ? (
                <ChatEmojiKeyboard
                  isDark={isDark}
                  surfaceBg={INPUT_BAR_BG}
                  textColor={LIVI.text}
                  langCode={lang}
                  onEmojiSelected={handleComposerEmojiSelected}
                  onStickerSelected={handleComposerStickerSelected}
                />
              ) : null}
            </View>
          </KeyboardAvoidingView>)
        ) : (
          // Android: ADJUST_NOTHING + KeyboardStickyView — dock клеится к верху IME.
          (<View style={{ flex: 1, overflow: 'hidden' }}>
            <View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: androidListBottomReserve,
              }}
            >
            <FlatList
              ref={flatListRef}
              data={androidChatListData}
              keyExtractor={(item) => item.id}
              renderItem={renderMessageRow}
              style={{ flex: 1, backgroundColor: 'transparent' }}
              contentContainerStyle={{
                flexGrow: 1,
                justifyContent: isEmpty ? 'center' : 'flex-start',
                paddingTop: 0,
              }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              onScrollBeginDrag={dismissComposerKeyboard}
              removeClippedSubviews={false}
              inverted={!showEmpty}
              onScrollToIndexFailed={handleScrollToIndexFailed}
              initialNumToRender={CHAT_LIST_INITIAL_NUM_TO_RENDER}
              maxToRenderPerBatch={CHAT_LIST_MAX_TO_RENDER_PER_BATCH}
              windowSize={CHAT_LIST_WINDOW_SIZE}
              updateCellsBatchingPeriod={CHAT_LIST_UPDATE_CELLS_BATCHING_PERIOD}
              ListEmptyComponent={() => {
                if (!chatFeedReady) {
                  return (
                    <View
                      style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        backgroundColor: 'transparent',
                      }}
                    >
                      <ActivityIndicator color={LIVI.titan} />
                    </View>
                  );
                }
                return null;
              }}
            />
            </View>

            {chatEmptyFeedPlaceholder}
            {DeleteToastInline ? (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: resolvedInputBarH + androidKeyboardPad + 8,
                  alignItems: 'center',
                  zIndex: 8,
                  elevation: 8,
                }}
              >
                {DeleteToastInline}
              </View>
            ) : null}

            {!isEmpty && GapCenterIndicator ? (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: resolvedInputBarH + androidKeyboardPad + 4,
                  alignItems: 'center',
                  zIndex: 8,
                  elevation: 8,
                }}
              >
                {GapCenterIndicator}
              </View>
            ) : null}

            <View
              collapsable={false}
              style={[
                {
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  zIndex: 20,
                  elevation: 20,
                  transform: [
                    { translateY: emojiPanelOpen ? 0 : -androidImeInset },
                  ],
                },
              ]}
            >
            <View
              style={{
                borderTopWidth: BORDER_WIDTH,
                borderTopColor: BORDER_COLOR,
                backgroundColor: INPUT_BAR_BG,
                paddingHorizontal: 16,
                paddingTop: voiceIsRecording ? 8 : 18,
                // Nav inset только когда клавиатуры/emoji нет.
                paddingBottom:
                  18 +
                  (keyboardVisible || emojiPanelOpen ? 0 : Math.max(0, insets.bottom)),
              }}
              onLayout={handleInputBarLayout}
            >
              {voiceIsRecording && (
                <View style={{ alignItems: 'center', marginBottom: 8 }}>
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
              {replyingToMessage && (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginBottom: 10,
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    borderRadius: 14,
                    backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
                    borderWidth: 1,
                    borderColor: BORDER_COLOR,
                  }}
                >
                  <Ionicons name="arrow-undo-outline" size={20} color={LIVI.replyQuoteAccent} style={{ marginRight: 10 }} />
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <Text style={{ color: LIVI.replyQuoteAccent, fontSize: 13, fontWeight: '600', marginBottom: 2 }}>
                      {t('chatReplyingTo', lang).replace('{name}', replyingToMessage.isOwn ? t('you', lang) : peerNameState)}
                    </Text>
                    <Text style={{ color: LIVI.white, fontSize: 14, opacity: 0.9 }} numberOfLines={1} ellipsizeMode="tail">
                      {replyingToMessage.text || '—'}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => setReplyingToMessage(null)}
                    hitSlop={8}
                    style={{ padding: 4 }}
                  >
                    <Ionicons name="close-circle" size={24} color={LIVI.titan} />
                  </TouchableOpacity>
                </View>
              )}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  borderRadius: 24,
                  paddingHorizontal: 12,
                  paddingVertical: 2,
                  borderWidth: 1,
                  borderColor: BORDER_COLOR,
                }}
              >
                {voiceIsRecording ? (
                  <Pressable
                    hitSlop={10}
                    accessibilityRole="button"
                    onPress={() => {
                      void cancelVoiceRecordingWithAnimation();
                    }}
                    style={{ marginRight: 12 }}
                  >
                    <Animated.View
                      ref={(r) => { trashMeasureRef.current = r as any; }}
                      onLayout={() => updateTrashZone()}
                      style={{
                        padding: 2,
                        transform: [
                          { scale: trashFlash.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) },
                          { rotate: trashLid.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-14deg'] }) },
                        ],
                        opacity: trashFlash.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }),
                      }}
                    >
                      <Ionicons name="trash-outline" size={28} color="#FF5A67" />
                    </Animated.View>
                  </Pressable>
                ) : (
                  <TouchableOpacity
                    onPress={handleAttachments}
                    hitSlop={COMPOSER_HIT_ATTACH}
                    style={{
                      padding: 2,
                      marginRight: 12,
                    }}
                  >
                    <Ionicons name="image" size={28} color={LIVI.titan} />
                  </TouchableOpacity>
                )}

                {!voiceIsRecording ? (
                  <TouchableOpacity
                    onPress={toggleEmojiPanel}
                    hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                    style={{ padding: 2, marginRight: 8 }}
                    accessibilityLabel="Emoji"
                  >
                    <Ionicons
                      name={emojiPanelOpen ? 'keypad-outline' : 'happy-outline'}
                      size={26}
                      color={emojiPanelOpen ? LIVI.accent.bright : LIVI.titan}
                    />
                  </TouchableOpacity>
                ) : null}

                <View style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}>
                  <TextInput
                    style={{
                      flex: 1,
                      color: voiceIsRecording ? 'transparent' : LIVI.white,
                      fontSize: 16,
                      lineHeight: 20,
                      paddingTop: 0,
                      paddingBottom: 0,
                      maxHeight: composerTextInputMaxHeight,
                      includeFontPadding: false,
                    }}
                    placeholder={t('chatMessagePlaceholder', lang)}
                    placeholderTextColor={voiceIsRecording ? 'transparent' : LIVI.titan}
                    value={messageText}
                    onChangeText={(txt) => {
                      messageTextRef.current = txt;
                      setMessageText(txt);
                      signalLocalTyping();
                    }}
                    onFocus={() => setEmojiPanelOpen(false)}
                    multiline
                    scrollEnabled
                    onSubmitEditing={sendMessage}
                    returnKeyType="send"
                    caretHidden={voiceIsRecording}
                    autoCorrect={true}
                    spellCheck={true}
                  />
                  {voiceIsRecording ? (
                    <View
                      pointerEvents="none"
                      style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        justifyContent: 'center',
                      }}
                    >
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
                    </View>
                  ) : null}
                </View>

                <Animated.View
                  {...micPanResponder.panHandlers}
                  collapsable={false}
                  style={{
                    marginLeft: 4,
                    marginRight: 0,
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    alignItems: 'center',
                    justifyContent: 'center',
                    transform: [{ scale: micScale }],
                    backgroundColor: voiceIsRecording ? LIVI.titan : 'rgba(255,255,255,0.2)',
                    borderWidth: 1,
                    borderColor: BORDER_COLOR,
                  }}
                >
                  <View pointerEvents="none" style={{ alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons
                      name={voiceIsRecording ? 'mic' : 'mic-outline'}
                      size={20}
                      color={voiceIsRecording ? '#FF5A67' : LIVI.titan}
                    />
                  </View>
                </Animated.View>

                <TouchableOpacity
                  onPress={onPressSendButton}
                  hitSlop={COMPOSER_HIT_SEND}
                  accessibilityState={{ disabled: !messageText.trim() && !voiceIsRecording }}
                  activeOpacity={messageText.trim() || voiceIsRecording ? 0.88 : 1}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor:
                      messageText.trim() || voiceIsRecording ? LIVI.titan : 'rgba(255,255,255,0.2)',
                    marginLeft: 12,
                    borderWidth: 1,
                    borderColor: BORDER_COLOR,
                    overflow: 'hidden',
                  }}
                >
                  <Ionicons
                    name="send"
                    size={20}
                    color={messageText.trim() || voiceIsRecording ? LIVI.white : LIVI.titan}
                  />
                </TouchableOpacity>
              </View>
            </View>
            {emojiPanelOpen ? (
              <View
                style={{
                  backgroundColor: INPUT_BAR_BG,
                  borderTopWidth: BORDER_WIDTH,
                  borderTopColor: BORDER_COLOR,
                  paddingBottom: Math.max(0, insets.bottom),
                }}
              >
                <ChatEmojiKeyboard
                  isDark={isDark}
                  surfaceBg={INPUT_BAR_BG}
                  textColor={LIVI.text}
                  langCode={lang}
                  onEmojiSelected={handleComposerEmojiSelected}
                  onStickerSelected={handleComposerStickerSelected}
                />
              </View>
            ) : null}
            </View>
          </View>)
        )}
        </View>
      </View>
      {/* Модалка аватара собеседника: полный экран, блюр/затемнение, круг 3×, pinch-to-zoom */}
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
                  modalAvatarInstantUri ? (
                    <ExpoImage
                      {...getAvatarImageProps(modalAvatarInstantUri, `avatar_modal_peer_${peerId}_${peerAvatarVerState}`)}
                      style={{ width: avatarModalSize, height: avatarModalSize }}
                    />
                  ) : (
                    <View style={{ width: avatarModalSize, height: avatarModalSize, borderRadius: avatarModalSize / 2, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ color: LIVI.titan, fontSize: avatarModalSize * 0.35, fontWeight: '500' }}>{headerInitial}</Text>
                    </View>
                  )
                ) : (
                  modalAvatarExpected ? (
                    <View style={{ width: avatarModalSize, height: avatarModalSize, borderRadius: avatarModalSize / 2, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' }}>
                      {modalAvatarInstantUri ? (
                        <ExpoImage
                          {...getAvatarImageProps(modalAvatarInstantUri, `avatar_modal_peer_${peerId}_${peerAvatarVerState}`)}
                          style={{ width: avatarModalSize, height: avatarModalSize }}
                        />
                      ) : (
                        <Text style={{ color: LIVI.titan, fontSize: avatarModalSize * 0.35, fontWeight: '500' }}>{headerInitial}</Text>
                      )}
                    </View>
                  ) : (
                    <View style={{ width: avatarModalSize, height: avatarModalSize, borderRadius: avatarModalSize / 2, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ color: LIVI.titan, fontSize: avatarModalSize * 0.35, fontWeight: '500' }}>{headerInitial}</Text>
                    </View>
                  )
                )}
              </Animated.View>
            </PinchGestureHandler>
          </View>
        </View>
      )}

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

      {/* Полоса реакций: двойной тап по сообщению; свайп вправо — ещё 6 эмодзи */}
      {reactionBarForMessageId !== null && (
        <ReactionBarModal
          visible={true}
          onClose={() => setReactionBarForMessageId(null)}
          onPickEmoji={(emoji) => {
            sendMessageReaction(reactionBarForMessageId, emoji, peerId).catch(() => {});
            setReactionBarForMessageId(null);
          }}
          isDark={isDark}
        />
      )}

      {/* Android: одна карточка — сверху реакции, ниже выбранное сообщение, ниже список */}
      {Platform.OS === 'android' && showMessageActions && selectedMessage && (
        <Modal
          transparent
          visible={showMessageActions}
          animationType="fade"
          onRequestClose={hideMessageActions}
        >
          <Pressable
            onPress={hideMessageActions}
            style={{
              flex: 1,
              backgroundColor: isDark ? 'rgba(0,0,0,0.80)' : 'rgba(0,0,0,0.66)',
              justifyContent: 'flex-end',
              alignItems: 'center',
              paddingBottom: 100,
            }}
          >
            <Pressable
              onPress={() => {}}
              style={{
                width: 280,
                alignSelf: 'center',
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.25,
                shadowRadius: 12,
                elevation: 12,
              }}
            >
              {(() => {
                const cardBg = isDark ? 'rgba(30, 35, 41, 0.98)' : 'rgba(45, 50, 56, 0.98)';
                const borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
                const dividerColor = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)';
                const reactionsAll = [...SHEET_REACTIONS_ROW_1, ...SHEET_REACTIONS_ROW_2];
                const row1 = reactionsAll.slice(0, 5);
                const row2 = reactionsAll.slice(5, 10);
                const emojiPress = (emoji: string) => {
                  hideMessageActions();
                  const msgId = selectedMessage?.id != null ? String(selectedMessage.id) : null;
                  if (msgId) sendMessageReaction(msgId, emoji, peerId).catch(() => {});
                };
                return (
                <View style={{ width: 280, alignItems: 'center' }}>
                  {/* Блок 1: реакции (лежит на фоне модалки) */}
                  <View style={{ width: 256, borderRadius: 28, overflow: 'hidden', backgroundColor: LIVI.bg, borderWidth: 1, borderColor }}>
                      <ScrollView
                        ref={reactionsScrollRef}
                        horizontal
                        pagingEnabled
                        showsHorizontalScrollIndicator={false}
                        decelerationRate="fast"
                        snapToInterval={256}
                        snapToAlignment="start"
                        contentContainerStyle={{ paddingVertical: 4 }}
                        style={{ width: 256 }}
                      >
                        <View style={{ width: 256, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 }}>
                          {row1.map((emoji) => (
                            <Pressable key={emoji} onPress={() => emojiPress(emoji)} style={({ pressed }) => ({ padding: 6, borderRadius: 10, backgroundColor: pressed ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)') : 'transparent' })} hitSlop={4}>
                              <Text style={{ fontSize: 22 }}>{emoji}</Text>
                            </Pressable>
                          ))}
                          <Pressable
                            onPress={() => reactionsScrollRef.current?.scrollTo({ x: 256, animated: true })}
                            style={({ pressed }) => ({
                              width: 36,
                              height: 36,
                              borderRadius: 18,
                              alignItems: 'center',
                              justifyContent: 'center',
                              backgroundColor: pressed ? (isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)') : (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'),
                            })}
                            hitSlop={4}
                          >
                            <Ionicons name="chevron-back" size={20} color={isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)'} />
                          </Pressable>
                        </View>
                        <View style={{ width: 256, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: 8 }}>
                          {row2.map((emoji) => (
                            <Pressable key={emoji} onPress={() => emojiPress(emoji)} style={({ pressed }) => ({ padding: 6, borderRadius: 10, backgroundColor: pressed ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)') : 'transparent' })} hitSlop={4}>
                              <Text style={{ fontSize: 22 }}>{emoji}</Text>
                            </Pressable>
                          ))}
                        </View>
                      </ScrollView>
                  </View>
                  {/* Отступ 12px — виден фон модалки (на нём лежат оба блока) */}
                  {/* Блок 2: список действий */}
                  <View style={{ marginTop: 12, width: 245, borderRadius: 12, overflow: 'hidden', backgroundColor: LIVI.bg, borderWidth: 1, borderColor }}>
                    {(() => {
                      const isImageMsg = String(selectedMessage?.type || '') === 'image';
                      const row = (
                        label: string,
                        icon: React.ComponentProps<typeof Ionicons>['name'],
                        onPress: () => void,
                        danger?: boolean,
                      ) => (
                        <React.Fragment key={label + String(icon)}>
                          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: dividerColor }} />
                          <Pressable
                            onPress={onPress}
                            style={({ pressed }) => ({
                              flexDirection: 'row',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              paddingVertical: 12,
                              paddingHorizontal: 14,
                              backgroundColor: pressed
                                ? danger
                                  ? 'rgba(255,90,103,0.08)'
                                  : (isDark ? LIVI.accent.vivid12 : LIVI.accent.vivid10)
                                : 'transparent',
                            })}
                          >
                            <Text style={{ color: danger ? '#FF5A67' : LIVI.white, fontSize: 15, fontWeight: '400' }}>
                              {label}
                            </Text>
                            <Ionicons name={icon} size={20} color={danger ? '#FF5A67' : LIVI.titan} />
                          </Pressable>
                        </React.Fragment>
                      );
                      return (
                        <>
                    {(String(selectedMessage?.text || '').trim() || String(selectedMessage?.uri || '').trim() || String(selectedMessage?.stickerId || '').trim() || isImageMsg) && (
                      <>
                        {!isImageMsg && (String(selectedMessage?.text || '').trim() || String(selectedMessage?.stickerId || '').trim()) ? (
                          row(t('chatActionCopy', lang), 'copy-outline', () => {
                            hideMessageActions();
                            void copySelectedMessage(selectedMessage);
                          })
                        ) : null}
                        {isImageMsg ? (
                          <>
                            {row(t('save', lang), 'download-outline', () => {
                              hideMessageActions();
                              requestImageAction('save', selectedMessage, albumFocusIndex);
                            })}
                            {row(t('chatActionForward', lang), 'paper-plane-outline', () => {
                              hideMessageActions();
                              requestImageAction('forward', selectedMessage, albumFocusIndex);
                            })}
                          </>
                        ) : (
                          row(t('chatActionForward', lang), 'paper-plane-outline', () => {
                            hideMessageActions();
                            void openForwardPicker();
                          })
                        )}
                        {row(t('chatActionSelect', lang), 'checkbox-outline', () => {
                          hideMessageActions();
                          enterSelectionModeFromMessage(selectedMessage, albumFocusIndex);
                        })}
                        {row(t('chatActionReply', lang), 'arrow-undo-outline', () => {
                            hideMessageActions();
                            setEditingMessageId(null);
                            messageTextRef.current = '';
                            setMessageText('');
                            setReplyingToMessage({
                              id: String(selectedMessage?.id ?? ''),
                              text: getChatReplyPreviewText(selectedMessage, lang),
                              from: selectedMessage?.from,
                              isOwn: selectedMessage?.from === currentUserId || selectedMessage?.sender === 'me',
                            });
                          })}
                        {(selectedMessage?.from === currentUserId || selectedMessage?.sender === 'me') && String(selectedMessage?.type || '') === 'text' && (
                          row(t('chatActionEdit', lang), 'pencil-outline', () => {
                                hideMessageActions();
                                const text = String(selectedMessage?.text ?? '');
                                messageTextRef.current = text;
                                setMessageText(text);
                                setEditingMessageId(selectedMessage?.id ?? null);
                                setReplyingToMessage(null);
                              })
                        )}
                        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: dividerColor }} />
                      </>
                    )}
                    <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: dividerColor }} />
                    <Pressable
                      onPress={() => {
                        hideMessageActions();
                        if (isImageMsg) {
                          requestImageAction('delete', selectedMessage, albumFocusIndex);
                        } else {
                          confirmDeleteSelectedMessage(selectedMessage);
                        }
                      }}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingVertical: 12,
                        paddingHorizontal: 14,
                        backgroundColor: pressed ? 'rgba(255,90,103,0.08)' : 'transparent',
                      })}
                    >
                      <Text style={{ color: '#FF5A67', fontSize: 15, fontWeight: '400' }}>
                        {t('delete', lang)}
                      </Text>
                      <Ionicons name="trash-outline" size={20} color="#FF5A67" />
                    </Pressable>
                    <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: dividerColor }} />
                    <Pressable
                      onPress={hideMessageActions}
                      style={({ pressed }) => ({
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingVertical: 12,
                        paddingHorizontal: 14,
                        backgroundColor: pressed ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)') : 'transparent',
                      })}
                    >
                      <Text style={{ color: LIVI.titan, fontSize: 15, fontWeight: '400' }}>{t('cancelAction', lang)}</Text>
                    </Pressable>
                        </>
                      );
                    })()}
                  </View>
                </View>
                );
              })()}
            </Pressable>
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
                  backgroundColor: LIVI.bg,
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
                      ? (isDark ? LIVI.accent.vivid12 : LIVI.accent.vivid10)
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
                      ? (isDark ? LIVI.accent.vivid12 : LIVI.accent.vivid10)
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
                      ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)')
                      : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'),
                    ...(isDark
                      ? null
                      : {
                          borderWidth: 1,
                          borderColor: (theme.colors?.outline as string) || 'rgba(0,0,0,0.12)',
                        }),
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
          <GestureHandlerRootView style={{ flex: 1 }}>
          <Pressable
            onPress={() => setShowForwardPicker(false)}
            style={{ flex: 1, backgroundColor: isDark ? 'rgba(0,0,0,0.50)' : 'rgba(0,0,0,0.40)', justifyContent: 'flex-end' }}
          >
            <Animated.View
              style={{
                transform: [{ translateY: forwardSheetTranslateY }],
                maxHeight: forwardPickerSheetMaxH,
                width: '100%',
              }}
            >
            <Pressable
              onPress={() => {}}
              style={{
                backgroundColor: isDark ? LIVI.bg : 'rgba(182, 203, 216, 1)',
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                paddingTop: 8,
                paddingHorizontal: 14,
                paddingBottom: ANDROID_SHEET_BOTTOM_PAD,
                height: forwardPickerLayout.sheetHeight,
                maxHeight: forwardPickerSheetMaxH,
                width: '100%',
                flexDirection: 'column',
              }}
            >
              <View style={{ paddingBottom: 2 }}>
                <PanGestureHandler
                  activeOffsetY={10}
                  onGestureEvent={onForwardSheetGestureEvent}
                  onHandlerStateChange={onForwardSheetHandlerStateChange}
                >
                <View style={{ width: '100%', alignItems: 'center', paddingTop: 2, paddingBottom: 4, minHeight: 28 }}>
                  <View
                    style={{
                      width: 42,
                      height: 4,
                      borderRadius: 2,
                      backgroundColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.18)',
                    }}
                  />
                </View>
                </PanGestureHandler>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    minHeight: 36,
                    marginTop: -8,
                    paddingHorizontal: 4,
                  }}
                >
                  {/* Симметрия с правой кнопкой — заголовок по центру экрана и по вертикали с кнопкой */}
                  <View style={{ width: 36, marginLeft: -2 }} />
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }} pointerEvents="none">
                    <Text style={{ color: theme.colors.titan as string, fontSize: 16, fontWeight: '700' }}>
                      {`${t('chatActionForward', lang)}…`}
                    </Text>
                  </View>
                  <View style={{ width: 36, marginRight: -2, alignItems: 'center', justifyContent: 'center' }}>
                    <Pressable
                      onPress={() => void shareForwardToSystem()}
                      style={({ pressed }) => ({
                        width: 36,
                        height: 36,
                        borderRadius: 10,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderWidth: 1,
                        borderColor: isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.14)',
                        backgroundColor: pressed
                          ? isDark
                            ? 'rgba(255,255,255,0.12)'
                            : 'rgba(0,0,0,0.08)'
                          : isDark
                            ? 'rgba(255,255,255,0.06)'
                            : 'rgba(0,0,0,0.06)',
                      })}
                      hitSlop={10}
                    >
                      <Ionicons name="share-social-outline" size={19} color={LIVI.titan} />
                    </Pressable>
                  </View>
                </View>
              </View>
              {/* Линия на всю ширину шита: компенсируем paddingHorizontal родителя (14). */}
              <View
                style={{
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.1)',
                  marginHorizontal: -14,
                  marginTop: 12,
                  marginBottom: 8,
                }}
              />

              <View style={{ flex: 1, minHeight: 0 }}>
                <NativeViewGestureHandler disallowInterruption>
                {forwardLoading ? (
                  <View style={{ flex: 1, minHeight: 0, paddingVertical: 18, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator />
                  </View>
                ) : (
                  <GHFlatList
                    data={forwardFriends}
                    keyExtractor={(it: any, index: number) => String(it?._id || `fwd-friend-${index}`)}
                    style={{ flex: 1, minHeight: 0 }}
                    nestedScrollEnabled
                    scrollEnabled={forwardFriends.length > 0}
                    contentContainerStyle={
                      forwardFriends.length === 0
                        ? { flexGrow: 1, paddingVertical: 8 }
                        : { paddingTop: 4, paddingBottom: 8 }
                    }
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator
                    scrollEventThrottle={16}
                    windowSize={10}
                    initialNumToRender={12}
                    maxToRenderPerBatch={10}
                    updateCellsBatchingPeriod={50}
                    renderItem={({ item }) => {
                      const friendId = String(item?._id || '');
                      const isSelected = forwardSelectedFriendIds.has(friendId);
                      return (
                        <Pressable
                          onPress={() => {
                            setForwardSelectedFriendIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(friendId)) next.delete(friendId);
                              else next.add(friendId);
                              return next;
                            });
                          }}
                          style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingVertical: 10,
                            paddingHorizontal: 8,
                            borderRadius: 14,
                            overflow: 'hidden',
                            // Выбор только на чекбоксе — строка без заливки по selected.
                            backgroundColor: pressed
                              ? isDark
                                ? 'rgba(255,255,255,0.08)'
                                : 'rgba(0,0,0,0.05)'
                              : 'transparent',
                          })}
                        >
                          <AvatarImage
                            userId={friendId}
                            avatarVer={Number(item.avatarVer || 0)}
                            uri={item.avatarThumbB64 || undefined}
                            size={44}
                            fallbackText={displayAvatarLetter(item.nick || item.name)}
                            containerStyle={{
                              borderWidth: 1,
                              borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)',
                              overflow: 'hidden',
                              ...(isDark ? {} : { backgroundColor: 'rgba(0,0,0,0.08)' }),
                            }}
                            fallbackTextStyle={isDark ? { color: LIVI.white, fontSize: 18 } : { color: 'rgba(0,0,0,0.45)', fontSize: 18 }}
                          />
                          <View style={{ marginLeft: 12, flex: 1, justifyContent: 'center' }}>
                            <Text style={{ color: isDark ? LIVI.white : LIVI.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
                              {(item.nick && String(item.nick).trim()) || '—'}
                            </Text>
                          </View>
                          <Ionicons
                            name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                            size={24}
                            color={isSelected ? LIVI.accent.bright : (theme.colors.titan as string)}
                          />
                        </Pressable>
                      );
                    }}
                    ItemSeparatorComponent={() => {
                      const sepColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
                      return (
                        <View
                          style={{
                            height: 1,
                            marginHorizontal: 12,
                            backgroundColor: sepColor,
                          }}
                        />
                      );
                    }}
                    ListEmptyComponent={() => (
                      <View style={{ paddingVertical: 18, alignItems: 'center' }}>
                        <Text style={{ color: LIVI.titan, textAlign: 'center' }}>{t('chatForwardNoFriends', lang)}</Text>
                      </View>
                    )}
                  />
                )}
                </NativeViewGestureHandler>
              </View>

              <View style={{ paddingTop: 8 }}>
              <TouchableOpacity
                onPress={() => void forwardToSelectedFriends()}
                disabled={forwardSelectedFriendIds.size === 0}
                style={{
                  paddingVertical: 14,
                  backgroundColor:
                    forwardSelectedFriendIds.size > 0
                      ? LIVI.accent.forwardSendBg
                      : 'transparent',
                  borderWidth: forwardSelectedFriendIds.size > 0 ? StyleSheet.hairlineWidth : 1,
                  borderColor:
                    forwardSelectedFriendIds.size > 0
                      ? LIVI.accent.forwardSendBorder
                      : isDark
                        ? 'rgba(255,255,255,0.2)'
                        : 'rgba(0,0,0,0.15)',
                  borderRadius: 12,
                  marginBottom: 8,
                }}
                activeOpacity={0.85}
              >
                <Text
                  style={{
                    color:
                      forwardSelectedFriendIds.size > 0
                        ? LIVI.accent.forwardSendText
                        : LIVI.titan,
                    fontSize: 16,
                    fontWeight: '600',
                    textAlign: 'center',
                  }}
                >
                  {forwardSelectedFriendIds.size > 0
                    ? `${t('chatActionForward', lang)} (${forwardSelectedFriendIds.size})`
                    : t('chatActionForward', lang)}
                </Text>
              </TouchableOpacity>
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
                  {t('cancelAction', lang)}
                </Text>
              </TouchableOpacity>
              </View>
            </Pressable>
            </Animated.View>
          </Pressable>
          </GestureHandlerRootView>
        </Modal>
      )}

      {/* "Отправлено" теперь показывается в том же gap, что и "Печатает..." */}

      {/* Альбом: мультивыбор фото для сохранить / переслать / удалить */}
      <ChatAlbumPickModal
        visible={albumScopeVisible}
        kind={albumScopeKind}
        uris={albumPickUris}
        initialSelected={albumPickInitial}
        resolveMediaUri={resolveMediaUri}
        isDark={isDark}
        bg={isDark ? LIVI.bg : 'rgba(255,255,255,0.98)'}
        text={isDark ? LIVI.white : 'rgba(0,0,0,0.88)'}
        muted={isDark ? 'rgba(255,255,255,0.48)' : 'rgba(0,0,0,0.48)'}
        accent={LIVI.accent.solid}
        title={
          albumScopeKind === 'save'
            ? t('chatAlbumScopeSaveTitle', lang)
            : albumScopeKind === 'forward'
              ? t('chatAlbumScopeForwardTitle', lang)
              : t('chatAlbumScopeDeleteTitle', lang)
        }
        subtitle={t('chatAlbumScopeSubtitle', lang)}
        selectAllLabel={t('chatAlbumScopeSelectAll', lang)}
        clearLabel={t('chatAlbumScopeClear', lang)}
        confirmLabel={
          albumScopeKind === 'save'
            ? t('chatAlbumScopeConfirmSave', lang)
            : albumScopeKind === 'forward'
              ? t('chatAlbumScopeConfirmForward', lang)
              : t('chatAlbumScopeConfirmDelete', lang)
        }
        cancelLabel={t('cancelAction', lang)}
        onClose={closeAlbumScope}
        onConfirm={(indices) => {
          void applyAlbumPick(indices);
        }}
      />

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
                {confirmTitle || t('confirmActionTitle', lang)}
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
                  {confirmCancelText || t('cancelAction', lang)}
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
                    : (pressed ? LIVI.accent.vivid22 : LIVI.accent.vivid16),
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: confirmDestructive ? 'rgba(255,90,103,0.45)' : LIVI.accent.vivid45,
                })}
              >
                <Text
                  style={{
                    color: confirmDestructive ? '#FF5A67' : LIVI.titan,
                    fontSize: 15,
                    fontWeight: '700',
                  }}
                >
                  {confirmOkText || t('ok', lang)}
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
                {deleteConfirmKind === 'multi' ? t('chatDeleteMessagesTitle', lang) : t('chatDeleteMessageTitle', lang)}
              </Text>
              <Text style={{ marginTop: 8, color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)', fontSize: 14, lineHeight: 18 }}>
                {deleteConfirmKind === 'multi'
                  ? (selectedCount === 1
                    ? t('chatDeleteSelectedOne', lang)
                    : t('chatDeleteSelectedMany', lang).replace('{count}', String(selectedCount)))
                  : t('chatActionCannotUndo', lang)}
              </Text>
            </View>

            <View
              style={{
                height: StyleSheet.hairlineWidth,
                backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)',
              }}
            />

            <Pressable
              onPress={() => setDeleteForBoth((v) => !v)}
              style={({ pressed }) => ({
                marginHorizontal: 12,
                marginTop: 12,
                paddingHorizontal: 12,
                paddingVertical: 12,
                borderRadius: 14,
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: pressed
                  ? (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)')
                  : (isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)'),
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: deleteForBoth ? 'rgba(255,90,103,0.45)' : (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'),
              })}
            >
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: 10,
                  backgroundColor: deleteForBoth ? 'rgba(255,90,103,0.18)' : 'transparent',
                  borderWidth: 1,
                  borderColor: deleteForBoth ? '#FF5A67' : (isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.35)'),
                }}
              >
                {deleteForBoth ? <Ionicons name="checkmark" size={16} color="#FF5A67" /> : null}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: isDark ? LIVI.white : 'rgba(0,0,0,0.88)', fontSize: 15, fontWeight: '700' }}>
                  {t('chatDeleteForEveryoneTitle', lang)}
                </Text>
                <Text style={{ marginTop: 3, color: isDark ? 'rgba(255,255,255,0.50)' : 'rgba(0,0,0,0.50)', fontSize: 13, lineHeight: 17 }}>
                  {deleteForBoth
                    ? (deleteConfirmKind === 'multi'
                      ? t('chatDeleteForEveryoneBothMulti', lang)
                      : t('chatDeleteForEveryoneBothSingle', lang))
                    : (deleteConfirmKind === 'multi'
                      ? t('chatDeleteForEveryoneMeMulti', lang)
                      : t('chatDeleteForEveryoneMeSingle', lang))}
                </Text>
              </View>
            </Pressable>

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
                <Text style={{ color: LIVI.titan, fontSize: 15, fontWeight: '600' }}>{t('cancelAction', lang)}</Text>
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
                <Text style={{ color: '#FF5A67', fontSize: 15, fontWeight: '700' }}>{t('delete', lang)}</Text>
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