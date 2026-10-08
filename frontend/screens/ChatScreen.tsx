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
  Keyboard,
  Pressable,
  Animated,
  NativeModules,
  DeviceEventEmitter,
  PixelRatio,
  Dimensions,
  Image,
  StyleSheet,
  Share,
  InteractionManager,
  unstable_batchedUpdates,
} from "react-native";
import { SystemBars } from 'react-native-edge-to-edge';
 
import { useSafeAreaInsets, SafeAreaView } from "react-native-safe-area-context";
import {
  KeyboardController,
  AndroidSoftInputModes,
  useKeyboardContext,
} from "react-native-keyboard-controller";
import {
  PanGestureHandler,
  PinchGestureHandler,
  State,
  NativeViewGestureHandler,
  FlatList as GHFlatList,
} from "react-native-gesture-handler";
import { onCloseIncoming, emitCloseIncoming, emitChatOpened } from '../utils/globalEvents';
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
import ChatEmojiKeyboard, {
  CHAT_EMOJI_PANEL_HEIGHT,
  CHAT_EMOJI_PANEL_LANDSCAPE_HEIGHT,
} from "../components/ChatEmojiKeyboard";
import {
  getStickerFallbackText,
} from "../components/chatStickers";
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { Audio } from 'expo-av';
import { getFull, peekFull, putFull, putThumb } from '../utils/avatarCache';
import { BlurView } from 'expo-blur';
import { getAvatarImageProps } from '../utils/imageOptimization';
import { useFisheyeAvatarUri } from '../utils/avatarFisheye';
import { useResolvedImageUri } from '../hooks/useResolvedImageUri';
import { resolveDataUriForAndroid } from '../utils/dataUriToFileUri';
import { ChatMessageItem } from './chat/ChatMessageItem';
import { ChatComposerContextBar } from './chat/ChatComposerContextBar';
import { AppOverlay, useOverlayBackHandler } from '../components/AppOverlay';
import { AppDialogButton, AppDialogModal, appDialogStyles } from '../components/AppDialog';
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
  buildChatPhotoTimeline,
  findChatPhotoTimelineIndex,
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
import { ChatMessagePreviewFit } from './chat/ChatMessagePreviewFit';
import {
  getChatHiddenForMeKey,
  getChatStatusesKey,
} from './chat/chatStorageKeys';
import {
  getAndroidImeLiftCacheDp,
  setAndroidImeLiftCacheDp,
  subscribeAndroidImeLiftCache,
  preloadAndroidImeLiftCache,
} from './chat/androidImeLiftCache';
import { ChatAttachSheet, type ChatAttachSheetHandle } from './chat/ChatAttachSheet';
import { ChatRoundButton, chatRoundButtonColors } from './chat/ChatRoundButton';
import {
  CHAT_STATUS_GAP_H,
  CHAT_STATUS_SLOT_H,
  ChatDeleteToastInline,
  ChatGapCenterIndicator,
  shouldShowChatDeleteToast,
  shouldShowChatGapCenter,
} from './chat/ChatGapStatus';
import { ChatParallaxWallpaper } from './chat/ChatParallaxWallpaper';
import { ChatMessageEdgeFade } from './chat/ChatMessageEdgeFade';
import { resolveKeyboardAvoidance } from './chat/chatKeyboardGeometry';
import {
  formatAndroidImeDockLog,
  resolveAndroidImeGapDp,
  resolveAndroidImeHeightScale,
  resolveStableAndroidNavInset,
} from './chat/chatAndroidImeDock';
import { GLASS_AVAILABLE, GlassFill, StageGradient } from './home/WelcomeStageBackground';
import { BlurSourceFill, type BackdropSources } from '../components/BackdropBlur';
import {
  HOME_NAV_BG,
  WELCOME_GLASS_RIM,
  WELCOME_POPUP_ACCENT,
  WELCOME_POPUP_PRESSED,
  WELCOME_POPUP_SHEET_CHROME,
  WELCOME_POPUP_SURFACE,
  WELCOME_CHROME_EDGE_RADIUS,
  WELCOME_NAV_ACTIVE_ACCENT,
  WELCOME_MUTED_TEXT,
  WELCOME_NAV_ACTIVE_ICON,
} from './home/constants';
import { emitRequestDirectCall } from '../utils/globalEvents';
import { markChatCallBubbleEligible } from './chat/chatCallEvents';
import {
  ReactionBarOverlay,
  ReactionsRowWithSwipe,
  SHEET_REACTIONS_ALL,
} from './chat/chatReactions';

import { API_BASE, getMyProfile } from '../sockets/socket';
import { logger } from '../utils/logger';
import {
  APP_COMPOSER_MAX_FONT_SIZE_MULTIPLIER,
} from '../utils/accessibilityTypography';
import { useModalLayout } from '../utils/modalLayout';
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
  isMessagePendingInOutbox,
  onOutboxPendingChange,
  onReactionOutboxChange,
  hasPendingReactions,
  withPendingReactions,
  markMessagesAsRead,
  onUserPresence,
  hasVisibleOnlinePresenceSnapshot,
  isPeerInVisibleOnlinePresence,
  clearMessageCache,
  getAvatar,
  sendChatViewing,
  ensureGloballyDeletedMessageIdsLoaded,
} from "../sockets/socket";
import { MAX_MESSAGE_TEXT_LENGTH } from "../sockets/modules/constants";
import {
  E2eChatBanner,
  usePeerChatEncrypted,
  useE2eStatus,
} from "./chat/E2eChatBanner";
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

/** Сколько реакций видно в свёрнутой строке меню сообщения (остальные — по стрелке). */
const MSG_REACTIONS_COLLAPSED = 5;
/** Как галочки «прочитано» в облаке сообщения. */
const CHAT_READ_TICK_COLOR = 'hsl(108, 53.10%, 35.10%)';
/** Компактная шапка чата: контент ближе к системной строке, как в Telegram. */
const CHAT_HEADER_H = 48;
const CHAT_HEADER_TOP_PADDING = 6;
/** Last non-zero Android navigation inset survives ChatScreen remounts/resume. */
let lastStableAndroidNavInset = 0;
/** Текст и плейсхолдер «Сообщение» начинаются с одного отступа от кнопки эмодзи. */
const COMPOSER_TEXT_INSET_LEFT = 6;
/**
 * Android: поле ввода чуть выше системных кнопок. Над клавиатурой зазор прежний —
 * подъём дока при открытой IME меньше на ту же величину.
 */
const ANDROID_COMPOSER_NAV_GAP = 6;
/** Закрытая, но уже собранная панель эмодзи: в потоке, нулевой высоты и невидима. */
const EMOJI_PANEL_PARKED_STYLE = { height: 0, overflow: 'hidden', opacity: 0 } as const;

/** Общий пустой список выбранных фото альбома — одна ссылка для memo облаков. */
const NO_ALBUM_INDICES: number[] = [];
const EMOJI_GLASS_RADIUS = { borderTopLeftRadius: 20, borderTopRightRadius: 20 } as const;
/** Без нативного стекла (Android < 12) — как меню действий: плотная подложка и кромка. */
const EMOJI_GLASS_BLOCK_STYLE = GLASS_AVAILABLE
  ? EMOJI_GLASS_RADIUS
  : {
      ...EMOJI_GLASS_RADIUS,
      backgroundColor: WELCOME_POPUP_SURFACE,
      borderWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: 0,
      borderColor: WELCOME_GLASS_RIM,
    };

/** Последняя измеренная высота композера (без системного отступа) — для следующего открытия. */
let lastChatComposerHeight = 0;

/** Подпись раздела в меню чата: мелко, разрядка, приглушённо — не заголовок. */
const chatMenuSectionLabel = {
  color: WELCOME_MUTED_TEXT,
  fontSize: 13,
  fontWeight: '600' as const,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
  marginLeft: 6,
};

export default function ChatScreen({ route, navigation }: Props) {
  const insets = useSafeAreaInsets();
  const keyboardAnimation = useKeyboardContext().animated;
  const { theme, isDark } = useAppTheme();
  const lang = useLang((s) => s.lang);
  // Геометрия всех модалок чата: реагирует на поворот экрана.
  const modalLayout = useModalLayout();
  const chatChromeSideInset = modalLayout.isLandscape
    ? modalLayout.isTablet
      ? 20
      : 14
    : 0;
  // Landscape: облака переписки чуть ближе к центру; шапка и поле ввода — на всю ширину.
  const chatListSideInset = modalLayout.isLandscape
    ? Math.round(Math.min(96, modalLayout.width * 0.07))
    : 0;
  const chatEmojiPanelHeight = modalLayout.isLandscape
    ? CHAT_EMOJI_PANEL_LANDSCAPE_HEIGHT
    : CHAT_EMOJI_PANEL_HEIGHT;
  // Меню по долгому нажатию: в portrait стопкой (реакции, облако, действия), в landscape
  // компактной группой: реакции над облаком, действия вплотную справа — по высоте места мало.
  const msgActionsLandscape = modalLayout.isLandscape;
  /** Строка реакций: MSG_REACTIONS_COLLAPSED эмодзи и стрелка; ячейка — от ширины экрана. */
  const msgReactionCell = msgActionsLandscape
    ? 36
    : Math.max(
        34,
        Math.min(
          44,
          Math.floor((modalLayout.width - insets.left - insets.right - 34) / (MSG_REACTIONS_COLLAPSED + 1)),
        ),
      );
  // +10: внутренние отступы и волосяная рамка, чтобы строка не переносилась.
  const msgActionsCardWidth = msgReactionCell * (MSG_REACTIONS_COLLAPSED + 1) + 10;
  const msgActionsListWidth = msgActionsLandscape ? 184 : 210;
  const msgActionsBlockGap = msgActionsLandscape ? 6 : 10;
  // Нижний отступ листов (вложения, «Переслать»). Листы — слой в окне приложения и
  // доходят до низа экрана: фон уходит под кнопки навигации, содержимое — над ними.
  const ANDROID_SHEET_BOTTOM_PAD = 12 + Math.max(0, insets.bottom);


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
            // (не логируем сам nick в консоль — PII)
            logger.debug('[ChatScreen] Profile nick loaded');
          }
        }
      } catch (e) {
        console.warn('[ChatScreen] Failed to load profile on init:', e);
      }
    })();
  }, []);

  // КРИТИЧНО: мемоизируем объект, иначе он новый на каждый рендер (и может ломать мемоизацию ниже)
  const LIVI = React.useMemo(() => ({
    rgb: theme.colors.background === '#252B34' ? 'rgba(37, 43, 52, 0.3)' : 'rgba(0,0,0,0.06)',
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
    // Цитата ответа и её «полурамка» — голубой акцент палитры (#62B0D8), как активные элементы.
    replyQuoteAccent: isDark ? 'rgba(98, 176, 216, 0.95)' : 'rgba(112, 98, 148, 0.88)',
    replyQuotePressBg: isDark ? 'rgba(98, 176, 216, 0.12)' : 'rgba(112, 98, 148, 0.10)',
    replyHighlightAccent: isDark ? 'rgba(98, 176, 216, 0.80)' : 'rgba(112, 98, 148, 0.78)',
    accent: uiAccent(isDark),
  } as const), [theme, isDark]);

  // Android: под барами тёмная сцена → всегда светлые иконки. iOS: по теме / шапке.
  useFocusEffect(
    React.useCallback(() => {
      SystemBars.setStyle(Platform.OS === 'android' || isDark ? 'light' : 'dark');
      return () => {};
    }, [isDark]),
  );

  // Шапка и композер в тёмной теме прозрачные — тот же градиент сцены, что у поиска/друзей/чатов.
  const CHAT_HEADER_BG = isDark ? 'transparent' : String(theme.colors.background || LIVI.bg);
  const INPUT_BAR_BG = React.useMemo(() => {
    if (isDark) return 'transparent';
    const bg = String(LIVI.bg || '');
    const m = bg.match(/^rgba\(([^)]+)\)$/i);
    if (!m) return bg;
    const parts = m[1].split(',').map((s) => s.trim());
    if (parts.length !== 4) return bg;
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, 1)`;
  }, [LIVI.bg, isDark]);
  // Круги mic/send не должны просвечивать поверх динамического glass-фона.
  const { idle: COMPOSER_IDLE_BUTTON_BG, pressed: COMPOSER_PRESSED_BUTTON_BG } =
    chatRoundButtonColors(isDark);
  // Иконки в кругах композера — цвет имени собеседника в шапке.
  const COMPOSER_BUTTON_ICON = isDark ? LIVI.white : LIVI.titan;
  // Чуть более плотная стеклянная подложка поля ввода.
  const COMPOSER_INPUT_BG = 'rgba(255,255,255,0.05)';
  const EMOJI_SURFACE_BG = isDark ? WELCOME_POPUP_SURFACE : INPUT_BAR_BG;

  const BORDER_COLOR = theme.colors.outline as string;
  // Входящие — нейтральный серо-синий блоков, на ступень светлее фона.
  const BUBBLE_BG_IN = 'rgba(70, 82, 98, 0.42)';
  // Исходящие — лёгкий тон общего акцента: свои сразу отличаются от чужих.
  const BUBBLE_BG_OUT = 'rgba(98, 176, 216, 0.2)';
  // В long-press меню копия сообщения должна оставаться плотной поверх scrim.
  // Цвета соответствуют обычным полупрозрачным облакам, сведённым с их подложкой.
  const MESSAGE_ACTIONS_BUBBLE_BG_IN = isDark ? '#333B47' : '#B4BDC0';
  const MESSAGE_ACTIONS_BUBBLE_BG_OUT = isDark ? '#314655' : '#B4C0D7';
  const BORDER_WIDTH = 1;

  const peerId = String(route?.params?.peerId || "");
  const peerIdForPersistRef = useRef(peerId);
  peerIdForPersistRef.current = peerId;
  const peerNameParam = route?.params?.peerName || "—";
  const peerAvatarVer = route?.params?.peerAvatarVer || 0;
  const peerAvatarThumbB64Param = route?.params?.peerAvatarThumbB64 || '';
  const [peerAvatarVerState, setPeerAvatarVerState] = useState<number>(peerAvatarVer);
  const [peerOnline, setPeerOnline] = useState<boolean>(!!route?.params?.peerOnline);
  // Полный аватар, если уже в памяти (чат открывали), иначе миниатюра — без смены кадра при открытии.
  const [fullAvatarUri, setFullAvatarUri] = useState<string>(
    () => peekFull(String(route?.params?.peerId || ''), peerAvatarVer) || peerAvatarThumbB64Param,
  );
  const setAvatarUriIfChanged = useCallback((next: string) => {
    setFullAvatarUri((prev) => (prev === next ? prev : next));
  }, []);

  // Android: прогреваем file: кэш для data: до первого кадра шапки (меньше серого вспышки).
  useEffect(() => {
    const warm = fullAvatarUri || peerAvatarThumbB64Param;
    if (Platform.OS === 'android' && warm && /^data:/i.test(warm)) {
      void resolveDataUriForAndroid(warm);
    }
  }, [peerAvatarThumbB64Param, fullAvatarUri]);

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
        // Гасим бейдж непрочитанных сразу на входе: сервер узнает о прочтении
        // через markMessagesAsRead, но ответ может и не дойти (сокет лёг).
        emitChatOpened(peerId);
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

  // Пользователь уже известен сокету — чат рисуется сразу, без кадра «загрузка».
  const [loading, setLoading] = useState(() => {
    try {
      return !getCurrentSocketUserId();
    } catch {
      return true;
    }
  });
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
  const composerInputRef = useRef<TextInput>(null);
  // Панель эмодзи собираем заранее и держим собранной: её монтирование — сотни мс JS,
  // и кнопка эмодзи открывала панель с заметной задержкой.
  const [emojiPanelWarm, setEmojiPanelWarm] = useState(false);
  useEffect(() => {
    if (emojiPanelWarm) return;
    if (emojiPanelOpen) {
      setEmojiPanelWarm(true);
      return;
    }
    if (loading || err) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const task = InteractionManager.runAfterInteractions(() => {
      timer = setTimeout(() => setEmojiPanelWarm(true), 800);
    });
    return () => {
      task.cancel();
      if (timer) clearTimeout(timer);
    };
  }, [emojiPanelOpen, emojiPanelWarm, loading, err]);
  const androidNativeImeAvailableRef = useRef(false);
  const androidFallbackImeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const androidKeyboardProgressRef = useRef(0);
  const androidImeHidePendingRef = useRef(false);
  /**
   * progress×(−imeTarget)+(1−p)×(−nav).
   * Target из WindowInsets; cache в memory+AsyncStorage прогревается с App boot,
   * чтобы первый open сессии не ждал insets с p≈0.9.
   */
  const androidImeLiftTargetAnim = useRef(
    new Animated.Value(getAndroidImeLiftCacheDp()),
  ).current;
  const androidImeLiftTargetRef = useRef(getAndroidImeLiftCacheDp());
  const androidImeLiftCacheRef = useRef(getAndroidImeLiftCacheDp());
  const androidKcHeightAbsRef = useRef(0);
  const androidImeDockLogAtRef = useRef(0);
  const safeAreaBottomRef = useRef(insets.bottom);
  safeAreaBottomRef.current = insets.bottom;
  const initialAndroidNavInset = resolveStableAndroidNavInset(
    lastStableAndroidNavInset,
    insets.bottom,
  );
  const androidPinnedNavInsetRef = useRef(initialAndroidNavInset);
  const [androidPinnedNavInset, setAndroidPinnedNavInset] = useState(initialAndroidNavInset);

  const syncAndroidPinnedNavInset = React.useCallback((nextRaw: number) => {
    const next = resolveStableAndroidNavInset(androidPinnedNavInsetRef.current, nextRaw);
    if (next > 1) lastStableAndroidNavInset = next;
    if (Math.abs(androidPinnedNavInsetRef.current - next) <= 1) return;
    androidPinnedNavInsetRef.current = next;
    setAndroidPinnedNavInset(next);
  }, []);

  const applyAndroidImeLiftTarget = React.useCallback(
    (heightDp: number, source: 'insets' | 'cache') => {
      if (androidImeHidePendingRef.current && source !== 'insets') return;
      const next = Math.max(0, Number(heightDp) || 0);
      if (next < 1) return;

      if (source === 'insets') {
        const changed = Math.abs(androidImeLiftTargetRef.current - next) > 0.5;
        androidImeLiftCacheRef.current = next;
        if (changed) {
          androidImeLiftTargetRef.current = next;
          androidImeLiftTargetAnim.setValue(next);
        }
        setAndroidImeLiftCacheDp(next);
        return;
      }

      if (androidImeLiftTargetRef.current + 0.5 >= next) return;
      androidImeLiftTargetRef.current = next;
      androidImeLiftTargetAnim.setValue(next);
    },
    [androidImeLiftTargetAnim],
  );

  const seedAndroidImeLiftFromCache = React.useCallback(() => {
    if (androidImeHidePendingRef.current) return;
    const cached = Math.max(androidImeLiftCacheRef.current, getAndroidImeLiftCacheDp());
    if (cached < 1) return;
    androidImeLiftCacheRef.current = cached;
    applyAndroidImeLiftTarget(cached, 'cache');
  }, [applyAndroidImeLiftTarget]);

  const logAndroidImeDock = React.useCallback((progress: number) => {
    if (!__DEV__) return;
    const now = Date.now();
    if (now - androidImeDockLogAtRef.current < 120) return;
    androidImeDockLogAtRef.current = now;
    const kc = androidKcHeightAbsRef.current;
    const ime = androidImeLiftTargetRef.current;
    const nav = androidPinnedNavInsetRef.current;
    const scale = resolveAndroidImeHeightScale(ime, kc, nav);
    const gap = resolveAndroidImeGapDp(ime, kc, 1);
    const translateY = progress * -ime + (1 - progress) * -nav;
    // eslint-disable-next-line no-console
    console.log(
      formatAndroidImeDockLog({
        progress,
        kcAbsDp: kc,
        imeDp: ime,
        navDp: nav,
        scale,
        gapDp: gap,
        translateY,
        pixelRatio: PixelRatio.get(),
        windowH: Dimensions.get('window').height,
      }),
    );
  }, []);

  const clearAndroidImeAfterHide = React.useCallback(() => {
    androidImeHidePendingRef.current = false;
    if (androidFallbackImeTimerRef.current) {
      clearTimeout(androidFallbackImeTimerRef.current);
      androidFallbackImeTimerRef.current = null;
    }
    setAndroidImeInset(0);
    androidNativeImeAvailableRef.current = false;
    androidKcHeightAbsRef.current = 0;
    const cached = Math.max(androidImeLiftCacheRef.current, getAndroidImeLiftCacheDp());
    if (cached > 1) {
      androidImeLiftCacheRef.current = cached;
      androidImeLiftTargetRef.current = cached;
      androidImeLiftTargetAnim.setValue(cached);
    }
    syncAndroidPinnedNavInset(safeAreaBottomRef.current);
  }, [androidImeLiftTargetAnim, syncAndroidPinnedNavInset]);
  const clearAndroidImeAfterHideRef = useRef(clearAndroidImeAfterHide);
  clearAndroidImeAfterHideRef.current = clearAndroidImeAfterHide;
  const applyAndroidImeLiftTargetRef = useRef(applyAndroidImeLiftTarget);
  applyAndroidImeLiftTargetRef.current = applyAndroidImeLiftTarget;
  const seedAndroidImeLiftFromCacheRef = useRef(seedAndroidImeLiftFromCache);
  seedAndroidImeLiftFromCacheRef.current = seedAndroidImeLiftFromCache;
  const logAndroidImeDockRef = useRef(logAndroidImeDock);
  logAndroidImeDockRef.current = logAndroidImeDock;

  // Прогрев + подписка: cache может прийти после mount ChatScreen, до фокуса.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let cancelled = false;
    const applyCached = (cached: number) => {
      if (cancelled || cached < 1) return;
      androidImeLiftCacheRef.current = cached;
      if (androidImeLiftTargetRef.current < 1) {
        androidImeLiftTargetRef.current = cached;
        androidImeLiftTargetAnim.setValue(cached);
      }
    };
    applyCached(getAndroidImeLiftCacheDp());
    const unsubscribe = subscribeAndroidImeLiftCache(applyCached);
    preloadAndroidImeLiftCache().then((cached) => {
      if (!cancelled) applyCached(cached);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [androidImeLiftTargetAnim]);

  // Пока IME закрыт — держим pinned nav в актуальном safe-area.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (androidImeInset > 0 || keyboardVisible) return;
    if (androidKeyboardProgressRef.current > 0.02) return;
    syncAndroidPinnedNavInset(insets.bottom);
  }, [androidImeInset, insets.bottom, keyboardVisible, syncAndroidPinnedNavInset]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    KeyboardController.setInputMode(AndroidSoftInputModes.SOFT_INPUT_ADJUST_NOTHING);
    return () => {
      KeyboardController.setDefaultMode();
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let prevProgress = 0;
    const id = keyboardAnimation.progress.addListener(({ value }) => {
      const progress = Math.max(0, Math.min(1, Number(value) || 0));
      if (progress > prevProgress && progress > 0.01 && !androidImeHidePendingRef.current) {
        seedAndroidImeLiftFromCacheRef.current();
      }
      if (progress + 0.03 < prevProgress && prevProgress > 0.4) {
        androidImeHidePendingRef.current = true;
      }
      if (progress > prevProgress + 0.02 && progress > 0.05 && androidImeHidePendingRef.current) {
        androidImeHidePendingRef.current = false;
        seedAndroidImeLiftFromCacheRef.current();
      }
      prevProgress = progress;
      androidKeyboardProgressRef.current = progress;
      logAndroidImeDockRef.current(progress);
      if (androidImeHidePendingRef.current && progress <= 0.02) {
        clearAndroidImeAfterHideRef.current();
      }
    });
    return () => keyboardAnimation.progress.removeListener(id);
  }, [keyboardAnimation.progress]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const id = keyboardAnimation.height.addListener(({ value }) => {
      androidKcHeightAbsRef.current = Math.abs(Number(value) || 0);
    });
    return () => keyboardAnimation.height.removeListener(id);
  }, [keyboardAnimation.height]);

  // Android delivers this directly from WindowInsets.Type.ime() in MainActivity.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = DeviceEventEmitter.addListener(
      'LiviAndroidImeInsets',
      (rawHeight: unknown) => {
        // MainActivity шлёт IME inset в dp по текущей displayMetrics.density.
        // Старые APK слали px — только их делим через PixelRatio.
        // Нельзя порог от короткой стороны: 363dp > 0.85×360 → ложный /3 → 121 и блок не встаёт.
        const raw = Math.max(0, Number(rawHeight) || 0);
        const { width: winW, height: winH } = Dimensions.get('window');
        const longSide = Math.max(winW, winH);
        const height =
          raw > longSide * 0.9
            ? Math.round(raw / PixelRatio.get())
            : Math.round(raw);
        androidNativeImeAvailableRef.current = true;
        if (androidFallbackImeTimerRef.current) {
          clearTimeout(androidFallbackImeTimerRef.current);
          androidFallbackImeTimerRef.current = null;
        }
        if (height > 0) {
          androidImeHidePendingRef.current = false;
          setKeyboardVisible(true);
          setAndroidImeInset(height);
          applyAndroidImeLiftTarget(height, 'insets');
        }
      },
    );
    return () => {
      subscription.remove();
      if (androidFallbackImeTimerRef.current) {
        clearTimeout(androidFallbackImeTimerRef.current);
      }
    };
  }, [applyAndroidImeLiftTarget]);

  // RN scales fontSize with system fontScale, but a fixed lineHeight:20 stays put —
  // at max a11y scale glyphs clip and the placeholder wraps the last letter down.
  const composerFontScale = Math.min(
    PixelRatio.getFontScale() || 1,
    APP_COMPOSER_MAX_FONT_SIZE_MULTIPLIER,
  );
  const composerFontSize = 16;
  const composerLineHeight = Math.round(20 * composerFontScale);
  const composerTextInputMaxHeight = Math.round(76 * composerFontScale);
  const composerPlaceholder = t('chatMessagePlaceholder', lang);
  // Android: до первого onLayout — оценка нижней панели (после более низкого инпута).
  // Не завышать: иначе ListHeader spacer держит лишний зазор до последнего сообщения.
  // Высота с прошлого открытия чата: иначе первый onLayout перерисовывал весь чат и
  // двигал ленту (оценка 72 против реальных ~50).
  const estimatedInputHeight = lastChatComposerHeight > 0 ? lastChatComposerHeight : 72;
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
  // Сквозное шифрование включается само у всех и не отключается: переписка шифруется,
  // как только ключи есть у обоих. Настроек в меню нет.
  const e2eStatus = useE2eStatus();
  const chatEncrypted = usePeerChatEncrypted(peerId, e2eStatus);
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
  const [msgReactionsExpanded, setMsgReactionsExpanded] = useState(false);
  /** Верх поля ввода в координатах экрана чата: по нему стопка меню встаёт над ним. */
  const [msgActionsComposerTop, setMsgActionsComposerTop] = useState<number | null>(null);
  /**
   * Меню по тапу уже отрисовано, но ждёт, не будет ли второго тапа: невидимо и
   * пропускает касания к чату (второй тап должен попасть в облако).
   */
  const [msgActionsHeld, setMsgActionsHeld] = useState(false);
  // Message actions sheet — useChatMessageActions
  const clearAlbumFocusOnActionsHidden = React.useCallback(() => {
    setAlbumFocusIndex(null);
    setMsgReactionsExpanded(false);
    setMsgActionsComposerTop(null);
    setMsgActionsHeld(false);
  }, []);
  const {
    showMessageActions,
    messageActionsLayoutRef,
    messageActionsProgress,
    hideMessageActionsRef,
    hideMessageActions,
    dismissMessageActionsNow,
    showMessageActionsSheet,
    revealMessageActions,
    clearAndroidLayoutIfNeeded,
  } = useChatMessageActions({ onHidden: clearAlbumFocusOnActionsHidden });
  /**
   * Меню сообщения стоит всегда в одном месте: низ чуть выше поля ввода,
   * выше — копия зажатого облака и строка реакций. Верх поля ввода считаем от
   * верха самой модалки: оба замера в одной системе (measureInWindow), так что
   * неважно, заходит модалка под статус-бар или нет.
   * Слой меню — на весь экран (фон и под системными кнопками), сверху отступ от статус-бара.
   */
  const MSG_ACTIONS_EDGE_PAD = 12;
  const msgActionsTopPad = insets.top + MSG_ACTIONS_EDGE_PAD;
  const MSG_ACTIONS_COMPOSER_GAP = 16;
  /** Меньше этого копия облака не сжимается — список уступает место ей. */
  const MSG_ACTIONS_PREVIEW_MIN_H = 56;
  const chatComposerDockRef = useRef<View>(null);
  const msgActionsRootRef = useRef<View>(null);
  /** Корень экрана чата: слой меню лежит на нём целиком, начало координат общее. */
  const chatScreenRootRef = useRef<View>(null);
  // Стопка встала над полем ввода — проявляем её (до замера она прозрачна).
  useEffect(() => {
    if (showMessageActions && msgActionsComposerTop != null && !msgActionsHeld) revealMessageActions();
  }, [showMessageActions, msgActionsComposerTop, msgActionsHeld, revealMessageActions]);
  /**
   * Верх поля ввода — заранее, до открытия меню: тогда меню встаёт на место в
   * том же рендере, что и появляется. Нет ответа замера — открываем без него
   * (слой меню сам замерит поле ввода по своему layout).
   */
  const measureMsgActionsComposerTop = React.useCallback((done: (top: number | null) => void) => {
    const root = chatScreenRootRef.current;
    const dock = chatComposerDockRef.current;
    if (Platform.OS !== 'android' || !root || !dock) {
      done(null);
      return;
    }
    let rootY: number | null = null;
    let dockTop: number | null = null;
    let answered = 0;
    let finished = false;
    const finish = (top: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(fallback);
      done(top);
    };
    const fallback = setTimeout(() => finish(null), 120);
    const collect = () => {
      answered += 1;
      if (answered < 2) return;
      finish(rootY != null && dockTop != null ? Math.round(dockTop - rootY) : null);
    };
    root.measureInWindow((_x, y) => {
      rootY = y;
      collect();
    });
    dock.measureInWindow((_x, y, _w, h) => {
      dockTop = h > 0 ? y : null;
      collect();
    });
  }, []);
  /** Запасной замер — по первому layout слоя меню, если заранее не вышло. */
  const measureMsgActionsComposer = React.useCallback(() => {
    const root = msgActionsRootRef.current;
    const dock = chatComposerDockRef.current;
    if (!root || !dock) return;
    root.measureInWindow((_rx, rootY) => {
      dock.measureInWindow((_x, y, _w, h) => {
        if (h > 0) {
          const measuredTop = Math.round(y - rootY);
          // Один точный замер на открытие: последующие layout-кадры не двигают меню.
          setMsgActionsComposerTop((current) => current ?? measuredTop);
        }
      });
    });
  }, []);
  /** Низ стопки меню в координатах модалки. */
  const msgActionsStackBottom =
    (msgActionsComposerTop ?? msgActionsTopPad) - MSG_ACTIONS_COMPOSER_GAP;
  const msgActionsStackH = Math.max(0, msgActionsStackBottom - msgActionsTopPad);
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
    sheetBottomPad: ANDROID_SHEET_BOTTOM_PAD,
    sheetMaxHeight: modalLayout.sheetMaxHeight,
    isLandscape: modalLayout.isLandscape,
  });
  /** Подсветка сообщения при переходе по цитате в ответе */
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Для панели реакций: id сообщения, по которому дважды нажали (показать полосу эмодзи)
  const [reactionBarForMessageId, setReactionBarForMessageId] = useState<string | null>(null);
  /** Облако, по которому был двойной тап: полоса реакций встаёт рядом с ним. */
  const [reactionBarAnchor, setReactionBarAnchor] = useState<
    { x: number; y: number; width: number; height: number; isOwn: boolean } | null
  >(null);
  const closeReactionBar = React.useCallback(() => {
    setReactionBarForMessageId(null);
    setReactionBarAnchor(null);
  }, []);
  /** ID сообщения, которое пользователь редактирует (текст в поле ввода). */
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  /** Текст сообщения, которое редактируем, — в плашке над полем ввода. */
  const editingOriginalText = React.useMemo(() => {
    if (!editingMessageId) return '';
    const m = messages.find((x) => String(x?.id) === String(editingMessageId));
    return String(m?.text ?? '');
  }, [editingMessageId, messages]);
  /** Крестик в плашке: выйти из редактирования, поле — пустое, как до него. */
  const cancelEditing = useCallback(() => {
    setEditingMessageId(null);
    messageTextRef.current = '';
    setMessageText('');
  }, []);
  // «Изменить» — сразу поле ввода с клавиатурой, как в Telegram.
  useEffect(() => {
    if (!editingMessageId) return;
    const id = setTimeout(() => composerInputRef.current?.focus(), 150);
    return () => clearTimeout(id);
  }, [editingMessageId]);
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
  } = useChatMediaViewers();
  const attachSheetRef = useRef<ChatAttachSheetHandle>(null);

  // Обертка для setReadStatuses с автосохранением. Стабильная: она в deps подписок useChatRealtime,
  // и новая функция на каждый рендер переподписывала их — а событие очереди, пришедшее во время
  // синхронного рендера, тогда крутилось по новым подписчикам бесконечно (JS 100%, чат замирал).
  // saveStatuses берёт id из ref, поэтому версия первого рендера актуальна.
  const updateReadStatuses = React.useCallback((updater: (prev: Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>) => Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>) => {
    setReadStatuses(prev => {
      const updated = updater(prev);
      saveStatuses(updated); // Автоматически сохраняем
      return updated;
    });
  }, []);
  // Обычно уже известен сокету — сразу, без лишнего рендера при открытии чата.
  const [currentUserId, setCurrentUserId] = useState<string | null>(() => {
    try {
      return getCurrentSocketUserId() || null;
    } catch {
      return null;
    }
  });
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
    voiceLocked,
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

  // Функция автоскролла к последнему сообщению (стабильная — в deps подписок useChatRealtime)
  const scrollToBottom = React.useCallback(() => {
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
  }, []);

  // Коалесируем многократные вызовы скролла, чтобы избежать дёрганий
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleScrollToBottom = (delay = 0) => {
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      scrollToBottom();
    }, delay);
  };

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
    const applyIosKeyboardFrame = (event: any) => {
      if (Platform.OS !== 'ios') return;
      try { Keyboard.scheduleLayoutAnimation(event); } catch {}
      const nextInset = resolveKeyboardAvoidance(
        event?.endCoordinates,
        Dimensions.get('screen').height,
        safeAreaBottomRef.current,
      );
      setKeyboardVisible(nextInset > 0);
      setKeyboardInset(nextInset);
      scheduleScrollToBottom(0);
    };
    const onShow = (event: any) => {
      if (Platform.OS === 'android') {
        // StickyView двигает dock; inset — для pad списка/empty.
        setKeyboardVisible(true);
        const height = Number(event?.endCoordinates?.height || 0);
        if (height > 0) {
          const resolvedHeight = Math.round(height);
          setKeyboardInset(resolvedHeight);
          // Dock уже едет по keyboardAnimation.height; inset — только pad/hit-test.
          if (!androidNativeImeAvailableRef.current) {
            if (androidFallbackImeTimerRef.current) {
              clearTimeout(androidFallbackImeTimerRef.current);
            }
            androidFallbackImeTimerRef.current = setTimeout(() => {
              if (!androidNativeImeAvailableRef.current) {
                setAndroidImeInset(resolvedHeight);
                applyAndroidImeLiftTargetRef.current(resolvedHeight, 'insets');
              }
              androidFallbackImeTimerRef.current = null;
            }, 100);
          }
        }
      } else {
        applyIosKeyboardFrame(event);
      }
    };
    const onHide = () => {
      if (Platform.OS === 'android') {
        setKeyboardVisible(false);
        setKeyboardInset(0);
        // ime target держим: progress 1→0 опустит dock; clear после progress≈0.
        if (androidKeyboardProgressRef.current <= 0.02) {
          clearAndroidImeAfterHideRef.current();
        } else {
          androidImeHidePendingRef.current = true;
        }
      } else {
        setKeyboardVisible(false);
        setKeyboardInset(0);
        scheduleScrollToBottom(0);
      }
    };
    const onWillShow = (event: any) => applyIosKeyboardFrame(event);
    const onWillHide = () => { 
      setKeyboardVisible(false); 
      setKeyboardInset(0);
      scheduleScrollToBottom(0); 
    };
    const onWillChangeFrame = (event: any) => applyIosKeyboardFrame(event);
    const onDidChangeFrame = (event: any) => {
      if (Platform.OS === 'ios') {
        applyIosKeyboardFrame(event);
        return;
      }
      if (androidNativeImeAvailableRef.current) return;
      const height = Math.max(0, Math.round(Number(event?.endCoordinates?.height || 0)));
      setKeyboardVisible(height > 0);
      setKeyboardInset(height);
      // Не трогаем dock здесь — подъём только через keyboardAnimation.height.
    };

    const subs = [
      Keyboard.addListener('keyboardWillShow', onWillShow), // iOS
      Keyboard.addListener('keyboardWillHide', onWillHide), // iOS
      Keyboard.addListener('keyboardWillChangeFrame', onWillChangeFrame),
      Keyboard.addListener('keyboardDidShow', onShow),       // Android
      Keyboard.addListener('keyboardDidHide', onHide),       // Android
      Keyboard.addListener('keyboardDidChangeFrame', onDidChangeFrame),
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

  // Android: pad для списка/empty/overlays — IME (окно не resize) или emoji-панель.
  const androidKeyboardPad = emojiPanelOpen
    ? chatEmojiPanelHeight + Math.max(0, androidPinnedNavInset)
    : Math.max(0, androidImeInset);
  /**
   * progress×(−ime) + (1−p)×(−nav).
   * ime из WindowInsets (логи: kc=0, ime=363) — единственный рабочий источник высоты.
   */
  const androidDockKeyboardTranslateY = emojiPanelOpen
    ? 0
    : Animated.add(
        Animated.multiply(
          keyboardAnimation.progress,
          Animated.add(Animated.multiply(androidImeLiftTargetAnim, -1), ANDROID_COMPOSER_NAV_GAP),
        ),
        Animated.multiply(
          Animated.add(1, Animated.multiply(keyboardAnimation.progress, -1)),
          -androidPinnedNavInset,
        ),
      );
  const androidListKeyboardTranslateY = androidDockKeyboardTranslateY;
  const androidEmptyKeyboardTranslateY = emojiPanelOpen
    ? 0
    : Animated.multiply(androidDockKeyboardTranslateY, 0.5);

  // Отступ композера над кнопками навигации; с панелью эмодзи его нет (навигация внутри панели).
  const androidComposerNavGap = Platform.OS === 'android' && !emojiPanelOpen ? ANDROID_COMPOSER_NAV_GAP : 0;
  // Высота композера = измеренная без этого отступа + отступ сейчас. Отступ меняется вместе с
  // панелью в одном кадре — иначе лента ждала onLayout и прыгала на 6 dp при открытии/закрытии.
  const resolvedInputBarHForChrome =
    (inputHeight > 0 ? inputHeight : estimatedInputHeight) + androidComposerNavGap;
  /** Середина облака под шапкой/композером → long-press нельзя. */
  const isLayoutBlockedByChrome = React.useCallback(
    (layout: { x: number; y: number; width: number; height: number }) => {
      if (!(layout.height > 0)) return false;
      const winH = Dimensions.get('window').height;
      const headerBottom = Math.max(0, insets.top) + CHAT_HEADER_H + CHAT_HEADER_TOP_PADDING;
      const bottomReserve =
        Platform.OS === 'android'
          ? androidKeyboardPad
          : keyboardVisible
            ? Math.max(0, keyboardInset)
            : Math.max(0, insets.bottom);
      const composerTop = winH - resolvedInputBarHForChrome - bottomReserve;
      const midY = layout.y + layout.height * 0.5;
      return midY < headerBottom || midY > composerTop;
    },
    [
      androidKeyboardPad,
      insets.top,
      insets.bottom,
      keyboardVisible,
      keyboardInset,
      resolvedInputBarHForChrome,
    ],
  );

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
        setAvatarUriIfChanged(peerAvatarThumbB64Param || '');
        return;
      }

      // Открыто по пушу (нет версии аватара) — запрашиваем аватар по peerId
      if (!peerAvatarVerState) {
        if (peerAvatarThumbB64Param && !cancelled) setAvatarUriIfChanged(peerAvatarThumbB64Param);
        try {
          const res = await getAvatar(peerId);
          if (cancelled) return;
          if (res?.ok && res.avatarB64 && res.avatarVer) {
            await putFull(peerId, res.avatarVer, res.avatarB64);
            setAvatarUriIfChanged(res.avatarB64);
            setPeerAvatarVerState(res.avatarVer);
          } else if (!peerAvatarThumbB64Param) {
            setAvatarUriIfChanged('');
          }
        } catch {
          if (!peerAvatarThumbB64Param && !cancelled) setAvatarUriIfChanged('');
        }
        return;
      }

      // Проверяем кэш полного аватара
      const cachedFull = await getFull(peerId, peerAvatarVerState);
      if (cachedFull && !cancelled) {
        setAvatarUriIfChanged(cachedFull);
        return;
      }

      try {
        const res = await getAvatar(peerId);
        if (cancelled) return;

        if (res?.ok && res.avatarB64) {
          await putFull(peerId, res.avatarVer!, res.avatarB64);
          setAvatarUriIfChanged(res.avatarB64);

          if (res.avatarVer !== peerAvatarVerState) {
            setPeerAvatarVerState(res.avatarVer!);
          }
        } else if (res?.ok && !res.avatarB64) {
          if (!peerAvatarThumbB64Param) setAvatarUriIfChanged('');
        }
      } catch {
        // мягко игнорируем — останется миниатюра/пусто
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [peerId, peerAvatarVerState, peerAvatarThumbB64Param, setAvatarUriIfChanged]);

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
  // Полноэкранный аватар — под той же линзой «рыбий глаз», что и все остальные.
  const modalAvatarLensed = useFisheyeAvatarUri(avatarModalVisible ? modalAvatarInstantUri : '');

  useOverlayBackHandler(avatarModalVisible, () => setAvatarModalVisible(false));

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

  // Функция для закрытия медиа просмотра
  const closeMediaViewer = React.useCallback(() => {
    setMediaViewerVisible(false);
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
  // Очереди отправки (сообщения, реакции) живут вне React — версия перерисовывает ленту.
  const [outboxVersion, setOutboxVersion] = useState(0);
  useEffect(() => {
    const bump = () => setOutboxVersion((v) => v + 1);
    const offPending = onOutboxPendingChange(bump);
    const offReactions = onReactionOutboxChange(bump);
    return () => {
      offPending();
      offReactions();
    };
  }, []);

  const headerH = CHAT_HEADER_H;
  const headerTopPadding = CHAT_HEADER_TOP_PADDING;
  const headerTotalH = headerH + headerTopPadding;

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

  // Единый список ВСЕХ фото переписки (в хронологическом порядке messages) — чтобы из
  // полноэкранного просмотра можно было пролистать все фото чата, а не только альбом
  // одного сообщения (как в WhatsApp/Telegram).
  const chatPhotoTimeline = React.useMemo(
    () => buildChatPhotoTimeline(messages, resolveMediaUri),
    [messages, resolveMediaUri],
  );

  // Функция для открытия медиа в полноэкранном режиме
  const openMediaViewer = React.useCallback((
    type: 'image',
    uri: string,
    name?: string,
    album?: { uris: string[]; index: number; message?: any },
  ) => {
    const messageId = String(album?.message?.id ?? '').trim();
    const photoIndexInMessage = Math.max(0, album?.index || 0);
    const globalIndex = messageId
      ? findChatPhotoTimelineIndex(chatPhotoTimeline, messageId, photoIndexInMessage)
      : -1;

    if (globalIndex >= 0 && chatPhotoTimeline.length > 1) {
      setSelectedMedia({
        type,
        uri: chatPhotoTimeline[globalIndex].uri || uri,
        name,
        uris: chatPhotoTimeline.map((entry) => entry.uri),
        index: globalIndex,
      });
      setMediaViewerVisible(true);
      return;
    }

    // Фолбэк (сообщение не нашлось в таймлайне — например, ещё грузится история):
    // прежнее поведение — альбом одного сообщения либо одно фото.
    const albumUris = Array.isArray(album?.uris)
      ? album.uris.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    setSelectedMedia({
      type,
      uri,
      name,
      uris: albumUris.length > 1 ? albumUris : undefined,
      index: albumUris.length > 1 ? Math.max(0, album?.index || 0) : 0,
    });
    setMediaViewerVisible(true);
  }, [chatPhotoTimeline]);

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
    historyReady,
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

  const { serverHistoryEmpty } = useChatHistorySync({
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
    navigation,
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
  // Меню сообщения и полоса реакций — слои над чатом: «Назад» сперва закрывает их.
  useOverlayBackHandler(showMessageActions, hideMessageActions);
  useOverlayBackHandler(reactionBarForMessageId !== null, closeReactionBar);

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

  const lastChatCallTapAtRef = useRef(0);

  const handleHeaderCall = React.useCallback(() => {
    const id = String(peerId || '').trim();
    if (!id) return;
    const now = Date.now();
    // Двойной тап по трубке в шапке чата — один исходящий.
    if (now - lastChatCallTapAtRef.current < 1200) return;
    try {
      const g = global as any;
      if (g.__outgoingStartInFlightRef?.current === true) return;
      if (g.__outgoingCallUiActiveRef?.current === true) return;
      if (g.__outgoingCallScreenVisibleRef?.current === true) return;
      if (g.__videoCallActiveRef?.current === true) return;
    } catch {}
    lastChatCallTapAtRef.current = now;
    // Экран звонка — отдельная Activity: без blur инпута IME висит поверх «Звонок..»
    // и снова всплывает, когда звонок закрывается и чат получает фокус.
    Keyboard.dismiss();
    setEmojiPanelOpen(false);
    markChatCallBubbleEligible(id, 'caller');
    emitRequestDirectCall({
      peerId: id,
      peerName: peerNameState,
      peerAvatarVer: peerAvatarVerState,
      peerAvatarThumbB64: fullAvatarUri || peerAvatarThumbB64Param || '',
      peerOnline,
      // Кнопка в шапке — иконка трубки (аудио), не видеокамеры. Раньше жёстко слала 'video',
      // из-за чего у звонящего сразу включалась камера, хотя он нажимал "звонок", не "видеозвонок".
      media: 'audio',
    });
  }, [peerId, peerNameState, peerAvatarVerState, fullAvatarUri, peerAvatarThumbB64Param, peerOnline]);

  /** Тап по облаку звонка — перезвонить; облако легко задеть случайно, поэтому сначала спросить. */
  const handleCallBubblePress = React.useCallback(() => {
    openConfirm({
      title: t('chatCallBackTitle', lang).replace('{name}', peerNameState || peerNameParam || ''),
      message: t('audioCallStatus', lang),
      okText: t('chatCallBackOk', lang),
      cancelText: t('cancelAction', lang),
      onConfirm: handleHeaderCall,
    });
  }, [openConfirm, handleHeaderCall, lang, peerNameState, peerNameParam]);

  // Стекло шапки и композера (Android 12+): фон и обои как есть, лента — размытой.
  const chatBlurKey = React.useId();
  const chatBlurStageId = `${chatBlurKey}-stage`;
  const chatBlurFeedId = `${chatBlurKey}-feed`;
  const chatBackdrop = React.useMemo<BackdropSources>(
    () => ({ background: [chatBlurStageId], blur: [chatBlurFeedId] }),
    [chatBlurStageId, chatBlurFeedId],
  );

  const headerApi = useChatHeader({
    lang,
    headerH,
    headerTopPadding,
    systemTopInset: Math.max(0, insets.top),
    LIVI,
    headerBg: CHAT_HEADER_BG,
    navigation,
    isDark,
    peerNameState,
    peerOnline,
    peerId,
    peerAvatarVerState,
    fullAvatarUri,
    headerInitial,
    openAvatarModal,
    onPressCall: handleHeaderCall,
    onPressMore: openClearMenu,
    encrypted: chatEncrypted,
    selectionMode,
    selectedCount,
    exitSelectionMode,
    selectAllLoaded,
    startForwardSelected,
    confirmDeleteSelected,
    backdrop: chatBackdrop,
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

  const { handleLongPressMessage } = useChatLongPressMessage({
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
    isLayoutBlockedByChrome,
  });

  type BubbleLayout = { x: number; y: number; width: number; height: number };
  /**
   * Открыть меню сообщения одним рендером. Старая архитектура RN не объединяет
   * setState вне обработчиков касания (таймер, колбэк замера) — без batch каждый
   * из них заново перерисовывал весь чат, и меню появлялось через секунду.
   */
  const openMessageActions = React.useCallback(
    (
      m: any,
      layout?: BubbleLayout,
      focusIndex: number | null = null,
      composerTop: number | null = null,
      held = false,
    ): boolean => {
      if (layout && isLayoutBlockedByChrome(layout)) return false;
      unstable_batchedUpdates(() => {
        if (composerTop != null) setMsgActionsComposerTop(composerTop);
        setMsgActionsHeld(held);
        handleLongPressMessage(m, layout, focusIndex);
      });
      return true;
    },
    [isLayoutBlockedByChrome, handleLongPressMessage],
  );
  /** Второго тапа не было — проявить заранее отрисованное меню. */
  const releaseHeldMessageActions = React.useCallback(
    (laidOut: boolean) => {
      // Анимация — сразу, на нативном драйвере; рендер, делающий меню нажимаемым, — следом.
      if (laidOut) revealMessageActions();
      setMsgActionsHeld(false);
    },
    [revealMessageActions],
  );
  /** Зажатие облака / плитки альбома: сперва верх поля ввода, потом меню. */
  const openMessageActionsFromLongPress = React.useCallback(
    (m: any, layout: BubbleLayout) => {
      measureMsgActionsComposerTop((top) => openMessageActions(m, layout, null, top));
    },
    [measureMsgActionsComposerTop, openMessageActions],
  );
  const openAlbumTileActionsFromLongPress = React.useCallback(
    (m: any, index: number, layout: BubbleLayout) => {
      measureMsgActionsComposerTop((top) => openMessageActions(m, layout, index, top));
    },
    [measureMsgActionsComposerTop, openMessageActions],
  );

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

      // Long press: только лёгкое сжатие облака, без виброотклика.
      if (options?.immediate) {
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

  /**
   * Тап по облаку: двойной — полоса быстрых реакций, одиночный — меню сообщения.
   * Одиночный ждёт второго тапа совсем недолго. Чтобы ожидание не складывалось с
   * рендером, меню рисуется сразу — невидимым и прозрачным для касаний, — а по
   * истечении ожидания только проявляется. Облако сжимается сразу.
   */
  const MESSAGE_DOUBLE_TAP_MS = 250;
  type PendingMessageTap = {
    id: string;
    timer: ReturnType<typeof setTimeout> | null;
    layout?: BubbleLayout;
    composerTop: number | null;
    /** Сколько замеров (облако, поле ввода) ещё не вернулось. */
    measuring: number;
    /** Меню уже отрисовано (невидимым или нет). */
    opened: boolean;
    /** Ожидание второго тапа кончилось. */
    released: boolean;
  };
  const pendingMessageTapRef = useRef<PendingMessageTap | null>(null);
  useEffect(() => () => {
    const pending = pendingMessageTapRef.current;
    if (pending?.timer) clearTimeout(pending.timer);
  }, []);
  const handleMessagePress = React.useCallback((
    item: any,
    measureBubble: (done: (layout?: BubbleLayout) => void) => void,
  ) => {
    const id = String(item?.id ?? '');
    const pending = pendingMessageTapRef.current;
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pendingMessageTapRef.current = null;
      if (pending.id === id) {
        // Двойной тап: невидимое меню убрать, у облака — полоса реакций.
        const isOwn = item?.from === currentUserId || item?.sender === 'me';
        const showBar = (layout?: BubbleLayout) => {
          unstable_batchedUpdates(() => {
            if (pending.opened) dismissMessageActionsNow();
            setReactionBarAnchor(layout ? { ...layout, isOwn } : null);
            setReactionBarForMessageId(id);
          });
        };
        if (pending.layout) showBar(pending.layout);
        else measureBubble(showBar);
        return;
      }
      if (pending.opened) dismissMessageActionsNow();
    }
    animateMessagePress(item.id, undefined, { immediate: true });
    const tap: PendingMessageTap = {
      id,
      timer: null,
      composerTop: null,
      measuring: 2,
      opened: false,
      released: false,
    };
    pendingMessageTapRef.current = tap;
    const measured = () => {
      tap.measuring -= 1;
      if (tap.measuring > 0 || tap.released || pendingMessageTapRef.current !== tap) return;
      // iOS: меню — системный ActionSheet, заранее его не нарисовать.
      if (Platform.OS === 'android') {
        tap.opened = openMessageActions(item, tap.layout, null, tap.composerTop, true);
      }
    };
    measureBubble((layout) => {
      tap.layout = layout;
      measured();
    });
    measureMsgActionsComposerTop((top) => {
      tap.composerTop = top;
      measured();
    });
    tap.timer = setTimeout(() => {
      tap.released = true;
      if (pendingMessageTapRef.current === tap) pendingMessageTapRef.current = null;
      if (tap.opened) releaseHeldMessageActions(tap.composerTop != null);
      else tap.opened = openMessageActions(item, tap.layout, null, tap.composerTop);
    }, MESSAGE_DOUBLE_TAP_MS);
  }, [
    animateMessagePress,
    currentUserId,
    openMessageActions,
    releaseHeldMessageActions,
    dismissMessageActionsNow,
    measureMsgActionsComposerTop,
  ]);

  /**
   * Своя реакция — переключатель: стоит (в т.ч. ещё не отправленная) — снять, нет — поставить.
   * В ленте видна сразу (очередь реакций), на сервер уходит, когда есть сеть.
   */
  const toggleMyReaction = React.useCallback((messageId: string, emoji: string) => {
    const mid = String(messageId || '');
    if (!mid || !emoji || !currentUserId) return;
    const msg = messagesRef.current.find((m) => String(m?.id) === mid);
    const current = withPendingReactions(msg?.reactions, mid, currentUserId);
    const hasMine = current.some((r) => r.emoji === emoji && String(r.userId) === String(currentUserId));
    sendMessageReaction(mid, emoji, peerId, !hasMine);
  }, [currentUserId, peerId]);

  /** Нажатие на реакцию под сообщением — поставить/снять свою, обновляется у обоих. */
  const handleReactionPress = toggleMyReaction;

  const {
    sendMessage,
    onPressSendButton,
    toggleEmojiPanel,
    dismissComposerKeyboard,
    handleComposerEmojiSelected,
    handleComposerEmojiBackspace,
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

  // Панель открыли с клавиатурой или уже выбрали эмодзи — кнопка на панели переключает
  // обратно на клавиатуру. Открыли со скрытой и ничего не выбрали — просто закрывает
  // панель: клавиатура, которой не было, не всплывает.
  const [emojiReturnsToKeyboard, setEmojiReturnsToKeyboard] = useState(false);
  const handleEmojiButtonPress = React.useCallback(() => {
    if (emojiPanelOpen) {
      const input = composerInputRef.current;
      if (emojiReturnsToKeyboard && input) input.focus();
      setEmojiPanelOpen(false);
      return;
    }
    setEmojiReturnsToKeyboard(keyboardVisible);
    toggleEmojiPanel();
  }, [emojiPanelOpen, emojiReturnsToKeyboard, keyboardVisible, toggleEmojiPanel]);
  const handleEmojiPanelEmojiSelected = React.useCallback(
    (emoji: Parameters<typeof handleComposerEmojiSelected>[0]) => {
      setEmojiReturnsToKeyboard(true);
      handleComposerEmojiSelected(emoji);
    },
    [handleComposerEmojiSelected],
  );

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
      attachSheetRef.current?.open();
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
  // Свои реакции, которые ещё в очереди (нет сети), — поверх серверных: видны сразу и не
  // пропадают, когда с сервера приходит история или чужая реакция. Тот же объект, если нечего менять.
  const messagesForList = React.useMemo(() => {
    if (!currentUserId) return messages;
    let changed = false;
    const out = messages.map((m) => {
      const mid = String(m?.id || '');
      if (!hasPendingReactions(mid)) return m;
      const reactions = withPendingReactions(m.reactions, mid, currentUserId);
      if (reactions === m.reactions) return m;
      changed = true;
      return { ...m, reactions };
    });
    return changed ? out : messages;
  }, [messages, outboxVersion, currentUserId]);

  const iosChatListData = React.useMemo(
    () => (!chatFeedReady || isEmpty ? [] : buildChatListRows(messagesForList)),
    [chatFeedReady, isEmpty, messagesForList],
  );

  const androidChatListData = React.useMemo(() => {
    if (!chatFeedReady || isEmpty) return [];
    return [...buildChatListRows(messagesForList)].reverse();
  }, [chatFeedReady, isEmpty, messagesForList]);

  iosChatListDataRef.current = iosChatListData;
  androidChatListDataRef.current = androidChatListData;

  const handleToggleRetryUi = React.useCallback((id: string) => {
    setRetryUiForId((prev) => (prev === id ? null : id));
  }, []);

  // Фон композера продолжается до физического края экрана одним слоем.
  // В emoji-панели Android нижний inset уже находится внутри самой панели.
  const composerSystemBottomInset = Platform.OS === 'android'
    ? emojiPanelOpen
      ? 0
      : Math.max(0, androidPinnedNavInset, insets.bottom)
    : Math.max(0, insets.bottom);

  const handleInputBarLayout = React.useCallback((e: any) => {
    const measuredH = Math.max(0, Math.round(Number(e?.nativeEvent?.layout?.height || 0)));
    // Продолжение под системную навигацию — фон, а не высота композера для ленты;
    // отступ над навигацией тоже не меряем (см. resolvedInputBarHForChrome).
    const h = Math.max(0, measuredH - composerSystemBottomInset - androidComposerNavGap);
    if (!h || Math.abs(inputHeight - h) <= 1) return;
    // Во время IME-анимации на Android не переписываем высоту — иначе paddingTop
    // списка меняется поверх native translate и даёт прыжок в конце.
    if (
      Platform.OS === 'android' &&
      androidKeyboardProgressRef.current > 0.02 &&
      androidKeyboardProgressRef.current < 0.98
    ) {
      return;
    }
    lastChatComposerHeight = h;
    setInputHeight(h);
  }, [composerSystemBottomInset, androidComposerNavGap, inputHeight]);

  // Список на весь экран под chrome: облака уезжают под шапку/композер и растворяются у края.
  // Инсеты — через padding контента; под IME оставляем только keyboard pad.
  const resolvedInputBarH = resolvedInputBarHForChrome;
  // One persistent status slot on every device. Typing/recording/deletion
  // labels are centered here without moving the last bubble.
  const InlineGapIndicator = DeleteToastInline || (!isEmpty ? GapCenterIndicator : null);
  const androidEmojiBottomReserve = emojiPanelOpen
    ? chatEmojiPanelHeight + Math.max(0, insets.bottom)
    : 0;
  const androidListBottomReserve = androidEmojiBottomReserve;
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    scheduleScrollToBottom(0);
  }, []);
  // Empty: центр в зоне над композером (+IME / emoji).
  const androidEmptyBottomPad = Math.max(
    72,
    resolvedInputBarH + androidEmojiBottomReserve + 10,
  );
  // Центр видимой области сообщений (между шапкой и композером).
  const chatEmptyFeedPlaceholder = React.useMemo(() => {
    if (!showEmpty) return null;
    return (
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: headerTotalH,
          // Android: над инпутом (+IME). iOS: родитель уже ужат по точному frame клавиатуры.
          bottom: Platform.OS === 'android' ? androidEmptyBottomPad : resolvedInputBarH,
          justifyContent: 'center',
          alignItems: 'center',
          paddingHorizontal: 28,
          zIndex: 1,
          transform:
            Platform.OS === 'android'
              ? [{ translateY: androidEmptyKeyboardTranslateY }]
              : undefined,
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
          {t('chatStartWith', lang).replace('{name}', peerNameParam)}
        </Text>
      </Animated.View>
    );
  }, [
    showEmpty,
    androidEmptyBottomPad,
    androidEmptyKeyboardTranslateY,
    isDark,
    peerNameParam,
    lang,
    headerTotalH,
    resolvedInputBarH,
  ]);

  /**
   * Подсветка плитки альбома под меню. Для обычных сообщений — null, так что
   * открытие меню не меняет renderMessageRow и лента не перерисовывается.
   */
  const albumFocusMessageId =
    showMessageActions && albumFocusIndex != null ? String(selectedMessage?.id || '') : '';
  const albumFocus = React.useMemo(
    () => (albumFocusMessageId ? { id: albumFocusMessageId, index: albumFocusIndex as number } : null),
    [albumFocusMessageId, albumFocusIndex],
  );

  const renderMessageRow = React.useCallback(
    ({ item, centered }: { item: ChatListRow; centered?: boolean }) => {
      if (item.type === 'date') {
        return (
          <View style={{ paddingTop: 10, paddingBottom: 6, alignItems: 'center' }}>
            <Text
              style={{
                fontSize: 11,
                fontWeight: isDark ? '300' : '600',
                // Светлые обои: onSurfaceVariant слишком бледный — как стрелка назад (titan).
                color: isDark ? LIVI.text : LIVI.titan,
                textAlign: 'center',
                ...(Platform.OS === 'android' && !isDark ? { fontFamily: 'sans-serif-medium' } : null),
              }}
              numberOfLines={1}
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
          readStatus={
            isOwnMessage
              ? isMessagePendingInOutbox(String(msg.id))
                ? 'sending'
                : readStatuses[msg.id]
              : undefined
          }
          uploadStatus={isOwnMessage ? uploadStatus[msg.id] : undefined}
          onPressImage={openMediaViewer}
          onPressAudio={togglePlayAudioMessage}
          playingAudioId={playingAudioId}
          playingAudioState={playingAudioState}
          retryUiForId={retryUiForId}
          onToggleRetryUi={handleToggleRetryUi}
          onRetryFailed={retryFailedOutgoingMessage}
          onLongPressMessage={openMessageActionsFromLongPress}
          isLayoutBlockedByChrome={isLayoutBlockedByChrome}
          onLongPressAlbumTile={openAlbumTileActionsFromLongPress}
          albumFocusIndex={
            albumFocus && albumFocus.id === String(msg?.id || '') ? albumFocus.index : null
          }
          onMessagePress={handleMessagePress}
          onPressCallBubble={handleCallBubblePress}
          onReactionPress={handleReactionPress}
          selectionMode={selectionMode}
          isSelected={
            isImageAlbumMessage(msg)
              ? selectedAlbumIndices(msg, selectedMessageIds).length ===
                getMessageImageUris(msg).length
              : selectedMessageIds.has(String(msg.id))
          }
          onToggleSelect={toggleSelectMessage}
          // Ни одного нового объекта/функции на строку: облака — React.memo, и обновление
          // статусов или подгрузка с сервера перерисовывают только изменившиеся облака.
          selectedAlbumIndices={
            isImageAlbumMessage(msg) ? selectedAlbumIndices(msg, selectedMessageIds) : NO_ALBUM_INDICES
          }
          onToggleAlbumTileSelect={toggleSelectAlbumTile}
          resolveMediaUri={resolveMediaUri}
          peerDisplayName={peerNameState}
          highlightedMessageId={highlightedMessageId}
          onPressReplyQuote={scrollToQuotedMessage}
          animateMessagePress={animateMessagePress}
          getMessageAnimation={getMessageAnimation}
          formatDurationDot={formatDurationDot}
          BUBBLE_BG_OUT={centered ? MESSAGE_ACTIONS_BUBBLE_BG_OUT : BUBBLE_BG_OUT}
          BUBBLE_BG_IN={centered ? MESSAGE_ACTIONS_BUBBLE_BG_IN : BUBBLE_BG_IN}
          LIVI={LIVI}
          isDark={isDark}
          lang={lang}
          centered={centered}
        />
      );
    },
    [
      currentUserId,
      readStatuses,
      outboxVersion,
      uploadStatus,
      openMediaViewer,
      togglePlayAudioMessage,
      playingAudioId,
      playingAudioState,
      retryUiForId,
      handleToggleRetryUi,
      retryFailedOutgoingMessage,
      openMessageActionsFromLongPress,
      isLayoutBlockedByChrome,
      openAlbumTileActionsFromLongPress,
      albumFocus,
      handleMessagePress,
      handleCallBubblePress,
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
      MESSAGE_ACTIONS_BUBBLE_BG_OUT,
      MESSAGE_ACTIONS_BUBBLE_BG_IN,
      LIVI,
      isDark,
      lang,
    ],
  );

  const ChatChrome = isDark ? StageGradient : View;
  const chatChromeBottomExtra = isDark
    ? ({ translucent: true, mirror: true, backdrop: chatBackdrop } as const)
    : {};

  return (
    <View ref={chatScreenRootRef} style={{ flex: 1, backgroundColor: HOME_NAV_BG }}>
    {/* Под стеклом фон и обои — без размытия (размывается только лента). */}
    <BlurSourceFill sourceId={chatBlurStageId}>
    {/* Сплошной фон, как на вкладках главной. */}
    <View style={[StyleSheet.absoluteFill, { backgroundColor: HOME_NAV_BG }]} />
    {/* Обоина на весь экран: от верхнего края до нижнего, под glass-шапкой и композером. */}
    {!loading && !err ? <ChatParallaxWallpaper isDark={isDark} /> : null}
    </BlurSourceFill>
    <SafeAreaView 
      // IMPORTANT: color the top safe-area (status bar area) to match the header.
      // Otherwise on Android (with translucent StatusBar) you'll see a white strip above the header.
      style={{ flex: 1, backgroundColor: 'transparent' }}
      // Android: bottom inset добавляем вручную только когда клавиатура скрыта,
      // иначе получаем лишний зазор между инпутом и клавиатурой на разных прошивках.
      edges={Platform.OS === 'android' ? ['top', 'left', 'right'] : ['top', 'bottom', 'left', 'right']}
    >
      <SystemBars style={Platform.OS === 'android' || isDark ? 'light' : 'dark'} />
      <View
        style={{ flex: 1, backgroundColor: 'transparent' }}
        // Не блокируем весь экран pointerEvents='none': на Android это иногда "съедало" первый тап.
        pointerEvents="auto"
      >
        <View style={{ flex: 1, overflow: 'visible', backgroundColor: 'transparent' }}>
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
          // iOS: padding из фактического frame обновляется и при смене высоты уже открытой клавиатуры.
          (<View style={{ flex: 1, paddingBottom: emojiPanelOpen ? 0 : keyboardInset }}>
            <View style={{ flex: 1, overflow: 'visible' }}>
            <ChatMessageEdgeFade
              style={{ flex: 1 }}
              top={headerTotalH}
              bottom={resolvedInputBarH + CHAT_STATUS_GAP_H}
            >
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
                paddingTop: headerTotalH + 10,
                paddingBottom: resolvedInputBarH + CHAT_STATUS_GAP_H,
                paddingHorizontal: chatListSideInset,
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
            </ChatMessageEdgeFade>
            {chatEmptyFeedPlaceholder}
            {InlineGapIndicator ? (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: resolvedInputBarH,
                  height: CHAT_STATUS_SLOT_H,
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 8,
                }}
              >
                {InlineGapIndicator}
              </View>
            ) : null}
            {/* Поле ввода для iOS — поверх ленты, облака уезжают под него */}
            <ChatChrome
              {...chatChromeBottomExtra}
              style={{
                position: 'absolute',
                left: chatChromeSideInset,
                right: chatChromeSideInset,
                bottom: -composerSystemBottomInset,
                zIndex: 20,
                backgroundColor: isDark ? undefined : INPUT_BAR_BG,
                paddingHorizontal: 6,
                // Без зависимости от записи: иначе высота композера меняется
                // и лента над ним сдвигается при старте/отмене голосового.
                paddingTop: 6,
                // Контент остаётся в safe-area, а этот же фон без стыка идёт
                // дальше под системную навигацию до физического края экрана.
                paddingBottom: 2 + composerSystemBottomInset,
                overflow: 'hidden',
                borderTopLeftRadius: WELCOME_CHROME_EDGE_RADIUS,
                borderTopRightRadius: WELCOME_CHROME_EDGE_RADIUS,
              }}
              onLayout={handleInputBarLayout}
            >
              <View
                collapsable={false}
                style={{ zIndex: 2, elevation: 2 }}
              >
              <E2eChatBanner
                lang={lang}
                peerId={peerId}
                encrypted={chatEncrypted}
                emptyChat={serverHistoryEmpty && showEmpty}
              />
              {editingMessageId ? (
                <ChatComposerContextBar
                  mode="edit"
                  title={t('chatEditingTitle', lang)}
                  text={editingOriginalText}
                  accent={LIVI.replyQuoteAccent}
                  textColor={LIVI.white}
                  closeColor={LIVI.titan}
                  closeA11y={t('cancelAction', lang)}
                  onClose={cancelEditing}
                />
              ) : replyingToMessage ? (
                <ChatComposerContextBar
                  mode="reply"
                  title={t('chatReplyingTo', lang).replace('{name}', replyingToMessage.isOwn ? t('you', lang) : peerNameState)}
                  text={replyingToMessage.text}
                  accent={LIVI.replyQuoteAccent}
                  textColor={LIVI.white}
                  closeColor={LIVI.titan}
                  closeA11y={t('cancelAction', lang)}
                  onClose={() => setReplyingToMessage(null)}
                />
              ) : null}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  backgroundColor: COMPOSER_INPUT_BG,
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
                        // Тот же круг 36×36, что у кнопки картинки, — высота строки не меняется.
                        width: 36,
                        height: 36,
                        alignItems: 'center',
                        justifyContent: 'center',
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
                  <ChatRoundButton
                    onPress={handleAttachments}
                    hitSlop={COMPOSER_HIT_ATTACH}
                    accessibilityLabel={t('chooseFromGallery', lang)}
                    backgroundColor={COMPOSER_IDLE_BUTTON_BG}
                    pressedBackgroundColor={COMPOSER_PRESSED_BUTTON_BG}
                    marginRight={12}
                  >
                    <Ionicons name="image" size={28} color={COMPOSER_BUTTON_ICON} />
                  </ChatRoundButton>
                )}

                {!voiceIsRecording ? (
                  <ChatRoundButton
                    onPress={handleEmojiButtonPress}
                    hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                    accessibilityLabel="Emoji"
                    backgroundColor={COMPOSER_IDLE_BUTTON_BG}
                    pressedBackgroundColor={COMPOSER_PRESSED_BUTTON_BG}
                    marginRight={8}
                  >
                    <Ionicons
                      name={emojiPanelOpen && emojiReturnsToKeyboard ? 'keypad-outline' : 'happy-outline'}
                      size={26}
                      color={emojiPanelOpen ? WELCOME_NAV_ACTIVE_ACCENT.softText : COMPOSER_BUTTON_ICON}
                    />
                  </ChatRoundButton>
                ) : null}

                {/* minWidth:0 — иначе Android multiline TextInput раздувает hit-box и перекрывает микрофон/отправку */}
                <View style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}>
                  <TextInput
                    ref={composerInputRef}
                    style={{
                      flex: 1,
                      color: voiceIsRecording ? 'transparent' : LIVI.white,
                      fontSize: composerFontSize,
                      lineHeight: composerLineHeight,
                      paddingTop: 2,
                      paddingBottom: 2,
                      paddingLeft: COMPOSER_TEXT_INSET_LEFT,
                      maxHeight: composerTextInputMaxHeight,
                    }}
                    placeholder=""
                    accessibilityLabel={composerPlaceholder}
                    maxLength={MAX_MESSAGE_TEXT_LENGTH}
                    maxFontSizeMultiplier={APP_COMPOSER_MAX_FONT_SIZE_MULTIPLIER}
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
                        ...StyleSheet.absoluteFillObject,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
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
                      <Text style={{ color: LIVI.white, fontSize: 14, fontWeight: '700' }}>
                        {formatDuration(Math.min(voiceRecordMs, VOICE_MAX_MS))}
                      </Text>
                      <Text style={{ color: LIVI.titan, fontSize: 12, fontWeight: '600', marginLeft: 6 }}>
                        / 1:00
                      </Text>
                    </View>
                  ) : null}
                  {!messageText && !voiceIsRecording ? (
                    <View
                      pointerEvents="none"
                      style={{
                        ...StyleSheet.absoluteFillObject,
                        justifyContent: 'center',
                        paddingLeft: COMPOSER_TEXT_INSET_LEFT,
                      }}
                    >
                      <Text
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.82}
                        maxFontSizeMultiplier={APP_COMPOSER_MAX_FONT_SIZE_MULTIPLIER}
                        style={{
                          color: LIVI.titan,
                          fontSize: composerFontSize,
                          lineHeight: composerLineHeight,
                        }}
                      >
                        {composerPlaceholder}
                      </Text>
                    </View>
                  ) : null}
                  {/* «Влево — отмена» — только пока держат: запись по тапу отменяют корзиной. */}
                  {voiceIsRecording && !voiceLocked ? (
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
                    backgroundColor: voiceIsRecording ? LIVI.titan : COMPOSER_IDLE_BUTTON_BG,
                  }}
                >
                  <View pointerEvents="none" style={{ alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons
                      name={voiceIsRecording ? 'mic' : 'mic-outline'}
                      size={20}
                      color={voiceIsRecording ? '#FF5A67' : COMPOSER_BUTTON_ICON}
                    />
                  </View>
                </Animated.View>

                <Pressable
                  onPress={onPressSendButton}
                  hitSlop={COMPOSER_HIT_SEND}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !messageText.trim() && !voiceIsRecording }}
                  style={({ pressed }) => ({
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor:
                      messageText.trim() || voiceIsRecording
                        ? LIVI.titan
                        : pressed
                          ? COMPOSER_PRESSED_BUTTON_BG
                          : COMPOSER_IDLE_BUTTON_BG,
                    marginLeft: 12,
                  })}
                >
                  <Ionicons
                    name={editingMessageId ? 'checkmark' : 'send'}
                    size={20}
                    color={messageText.trim() || voiceIsRecording ? LIVI.white : COMPOSER_BUTTON_ICON}
                  />
                </Pressable>
              </View>
              {emojiPanelOpen || emojiPanelWarm ? (
                <View
                  pointerEvents={emojiPanelOpen ? 'auto' : 'none'}
                  accessibilityElementsHidden={!emojiPanelOpen}
                  style={emojiPanelOpen ? null : EMOJI_PANEL_PARKED_STYLE}
                >
                <ChatEmojiKeyboard
                  compact={modalLayout.isLandscape}
                  isDark={isDark}
                  surfaceBg={EMOJI_SURFACE_BG}
                  textColor={LIVI.text}
                  langCode={lang}
                  onEmojiSelected={handleEmojiPanelEmojiSelected}
                  onEmojiBackspace={handleComposerEmojiBackspace}
                  onStickerSelected={handleComposerStickerSelected}
                />
                </View>
              ) : null}
              </View>
            </ChatChrome>
            </View>
          </View>)
        ) : (
          // Android: ADJUST_NOTHING + KeyboardStickyView — dock клеится к верху IME.
          (<View style={{ flex: 1, overflow: 'visible' }}>
            <Animated.View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: androidListBottomReserve,
                overflow: 'hidden',
                transform: [{ translateY: androidListKeyboardTranslateY }],
              }}
            >
            <ChatMessageEdgeFade
              style={{ flex: 1 }}
              top={headerTotalH}
              bottom={resolvedInputBarH + CHAT_STATUS_GAP_H}
              sourceId={chatBlurFeedId}
            >
            <FlatList
              ref={flatListRef}
              data={androidChatListData}
              keyExtractor={(item) => item.id}
              renderItem={renderMessageRow}
              style={{ flex: 1, backgroundColor: 'transparent' }}
              contentContainerStyle={{
                // flexGrow on a short inverted list lays cells in the middle
                // first, then snaps them to the bottom — skip it once the feed is ready.
                ...(!chatFeedReady || isEmpty
                  ? { flexGrow: 1, justifyContent: 'center' as const }
                  : null),
                // inverted: paddingTop = низ (под композер), paddingBottom = верх (под шапку)
                paddingTop: showEmpty ? 0 : resolvedInputBarH + CHAT_STATUS_GAP_H,
                paddingBottom: showEmpty ? 0 : headerTotalH + 8,
                paddingHorizontal: chatListSideInset,
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
            </ChatMessageEdgeFade>
            </Animated.View>

            {chatEmptyFeedPlaceholder}
            {InlineGapIndicator ? (
              <Animated.View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: resolvedInputBarH + androidEmojiBottomReserve,
                  height: CHAT_STATUS_SLOT_H,
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 8,
                  elevation: 8,
                  transform: [{ translateY: androidListKeyboardTranslateY }],
                }}
              >
                {InlineGapIndicator}
              </Animated.View>
            ) : null}

            <Animated.View
              ref={chatComposerDockRef}
              collapsable={false}
              style={[
                {
                  position: 'absolute',
                  left: chatChromeSideInset,
                  right: chatChromeSideInset,
                  bottom: -composerSystemBottomInset,
                  zIndex: 20,
                  elevation: 20,
                  transform: [
                    { translateY: androidDockKeyboardTranslateY },
                  ],
                },
              ]}
            >
            <ChatChrome
              {...chatChromeBottomExtra}
              {...(isDark && emojiPanelOpen ? { edgeFade: false } : null)}
              style={{
                backgroundColor: isDark ? undefined : INPUT_BAR_BG,
                paddingHorizontal: 6,
                // Без зависимости от записи: иначе высота композера меняется
                // и лента над ним сдвигается при старте/отмене голосового.
                paddingTop: 6,
                paddingBottom: 2 + androidComposerNavGap + composerSystemBottomInset,
                overflow: 'hidden',
                borderTopLeftRadius: WELCOME_CHROME_EDGE_RADIUS,
                borderTopRightRadius: WELCOME_CHROME_EDGE_RADIUS,
              }}
              onLayout={handleInputBarLayout}
            >
              <View
                collapsable={false}
                style={{ zIndex: 2, elevation: 2 }}
              >
              <E2eChatBanner
                lang={lang}
                peerId={peerId}
                encrypted={chatEncrypted}
                emptyChat={serverHistoryEmpty && showEmpty}
              />
              {editingMessageId ? (
                <ChatComposerContextBar
                  mode="edit"
                  title={t('chatEditingTitle', lang)}
                  text={editingOriginalText}
                  accent={LIVI.replyQuoteAccent}
                  textColor={LIVI.white}
                  closeColor={LIVI.titan}
                  closeA11y={t('cancelAction', lang)}
                  onClose={cancelEditing}
                />
              ) : replyingToMessage ? (
                <ChatComposerContextBar
                  mode="reply"
                  title={t('chatReplyingTo', lang).replace('{name}', replyingToMessage.isOwn ? t('you', lang) : peerNameState)}
                  text={replyingToMessage.text}
                  accent={LIVI.replyQuoteAccent}
                  textColor={LIVI.white}
                  closeColor={LIVI.titan}
                  closeA11y={t('cancelAction', lang)}
                  onClose={() => setReplyingToMessage(null)}
                />
              ) : null}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: COMPOSER_INPUT_BG,
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
                        // Тот же круг 36×36, что у кнопки картинки, — высота строки не меняется.
                        width: 36,
                        height: 36,
                        alignItems: 'center',
                        justifyContent: 'center',
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
                  <ChatRoundButton
                    onPress={handleAttachments}
                    hitSlop={COMPOSER_HIT_ATTACH}
                    accessibilityLabel={t('chooseFromGallery', lang)}
                    backgroundColor={COMPOSER_IDLE_BUTTON_BG}
                    pressedBackgroundColor={COMPOSER_PRESSED_BUTTON_BG}
                    marginRight={12}
                  >
                    <Ionicons name="image" size={28} color={COMPOSER_BUTTON_ICON} />
                  </ChatRoundButton>
                )}

                {!voiceIsRecording ? (
                  <ChatRoundButton
                    onPress={handleEmojiButtonPress}
                    hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                    accessibilityLabel="Emoji"
                    backgroundColor={COMPOSER_IDLE_BUTTON_BG}
                    pressedBackgroundColor={COMPOSER_PRESSED_BUTTON_BG}
                    marginRight={8}
                  >
                    <Ionicons
                      name={emojiPanelOpen && emojiReturnsToKeyboard ? 'keypad-outline' : 'happy-outline'}
                      size={26}
                      color={emojiPanelOpen ? WELCOME_NAV_ACTIVE_ACCENT.softText : COMPOSER_BUTTON_ICON}
                    />
                  </ChatRoundButton>
                ) : null}

                <View style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}>
                  <TextInput
                    ref={composerInputRef}
                    style={{
                      flex: 1,
                      color: voiceIsRecording ? 'transparent' : LIVI.white,
                      fontSize: composerFontSize,
                      lineHeight: composerLineHeight,
                      paddingTop: 0,
                      paddingBottom: 0,
                      paddingLeft: COMPOSER_TEXT_INSET_LEFT,
                      maxHeight: composerTextInputMaxHeight,
                      includeFontPadding: false,
                    }}
                    placeholder=""
                    accessibilityLabel={composerPlaceholder}
                    maxLength={MAX_MESSAGE_TEXT_LENGTH}
                    maxFontSizeMultiplier={APP_COMPOSER_MAX_FONT_SIZE_MULTIPLIER}
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
                        ...StyleSheet.absoluteFillObject,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
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
                      <Text style={{ color: LIVI.white, fontSize: 14, fontWeight: '700' }}>
                        {formatDuration(Math.min(voiceRecordMs, VOICE_MAX_MS))}
                      </Text>
                      <Text style={{ color: LIVI.titan, fontSize: 12, fontWeight: '600', marginLeft: 6 }}>
                        / 1:00
                      </Text>
                    </View>
                  ) : null}
                  {!messageText && !voiceIsRecording ? (
                    <View
                      pointerEvents="none"
                      style={{
                        ...StyleSheet.absoluteFillObject,
                        justifyContent: 'center',
                        paddingLeft: COMPOSER_TEXT_INSET_LEFT,
                      }}
                    >
                      <Text
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.82}
                        maxFontSizeMultiplier={APP_COMPOSER_MAX_FONT_SIZE_MULTIPLIER}
                        style={{
                          color: LIVI.titan,
                          fontSize: composerFontSize,
                          lineHeight: composerLineHeight,
                          ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
                        }}
                      >
                        {composerPlaceholder}
                      </Text>
                    </View>
                  ) : null}
                  {/* «Влево — отмена» — только пока держат: запись по тапу отменяют корзиной. */}
                  {voiceIsRecording && !voiceLocked ? (
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
                    backgroundColor: voiceIsRecording ? LIVI.titan : COMPOSER_IDLE_BUTTON_BG,
                  }}
                >
                  <View pointerEvents="none" style={{ alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons
                      name={voiceIsRecording ? 'mic' : 'mic-outline'}
                      size={20}
                      color={voiceIsRecording ? '#FF5A67' : COMPOSER_BUTTON_ICON}
                    />
                  </View>
                </Animated.View>

                <Pressable
                  onPress={onPressSendButton}
                  hitSlop={COMPOSER_HIT_SEND}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !messageText.trim() && !voiceIsRecording }}
                  style={({ pressed }) => ({
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor:
                      messageText.trim() || voiceIsRecording
                        ? LIVI.titan
                        : pressed
                          ? COMPOSER_PRESSED_BUTTON_BG
                          : COMPOSER_IDLE_BUTTON_BG,
                    marginLeft: 12,
                    overflow: 'hidden',
                  })}
                >
                  <Ionicons
                    name={editingMessageId ? 'checkmark' : 'send'}
                    size={20}
                    color={messageText.trim() || voiceIsRecording ? LIVI.white : COMPOSER_BUTTON_ICON}
                  />
                </Pressable>
              </View>
              </View>
            </ChatChrome>
            {emojiPanelOpen || emojiPanelWarm ? (
              <View
                pointerEvents={emojiPanelOpen ? 'auto' : 'none'}
                importantForAccessibility={emojiPanelOpen ? 'auto' : 'no-hide-descendants'}
                style={emojiPanelOpen ? null : EMOJI_PANEL_PARKED_STYLE}
              >
              {/* Отдельный блок из того же стекла, что меню действий над сообщением. */}
              <View
                style={[
                  {
                    paddingBottom: Math.max(0, insets.bottom),
                    // Стекло рисует фон окна целиком: без клипа оно закрывает ленту и композер.
                    overflow: 'hidden',
                  },
                  isDark ? EMOJI_GLASS_BLOCK_STYLE : { backgroundColor: INPUT_BAR_BG },
                ]}
              >
                {isDark ? <GlassFill backdrop={chatBackdrop} style={EMOJI_GLASS_RADIUS} /> : null}
                <View
                  collapsable={false}
                  style={{ zIndex: 2, elevation: 2 }}
                >
                <ChatEmojiKeyboard
                  compact={modalLayout.isLandscape}
                  isDark={isDark}
                  surfaceBg={EMOJI_SURFACE_BG}
                  textColor={LIVI.text}
                  langCode={lang}
                  onEmojiSelected={handleEmojiPanelEmojiSelected}
                  onEmojiBackspace={handleComposerEmojiBackspace}
                  onStickerSelected={handleComposerStickerSelected}
                />
                </View>
              </View>
              </View>
            ) : null}
            </Animated.View>
          </View>)
        )}
        </View>
        {/* Шапка поверх ленты — облака растворяются маской ленты; фон chrome без доп. затемнения. */}
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            // Шапка сама включает status-bar inset: один градиент без второго слоя и шва.
            top: -Math.max(0, insets.top),
            left: chatChromeSideInset,
            right: chatChromeSideInset,
            zIndex: 40,
            elevation: 40,
          }}
        >
          {headerEl}
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
                    modalAvatarLensed ? (
                      <ExpoImage
                        {...getAvatarImageProps(modalAvatarLensed, `avatar_modal_peer_${peerId}_${peerAvatarVerState}`)}
                        style={{ width: avatarModalSize, height: avatarModalSize }}
                      />
                    ) : null
                  ) : (
                    <View style={{ width: avatarModalSize, height: avatarModalSize, borderRadius: avatarModalSize / 2, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ color: LIVI.titan, fontSize: avatarModalSize * 0.35, fontWeight: '500' }}>{headerInitial}</Text>
                    </View>
                  )
                ) : (
                  modalAvatarExpected ? (
                    <View style={{ width: avatarModalSize, height: avatarModalSize, borderRadius: avatarModalSize / 2, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' }}>
                      {modalAvatarInstantUri ? (
                        modalAvatarLensed ? (
                          <ExpoImage
                            {...getAvatarImageProps(modalAvatarLensed, `avatar_modal_peer_${peerId}_${peerAvatarVerState}`)}
                            style={{ width: avatarModalSize, height: avatarModalSize }}
                          />
                        ) : null
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
        onClosed={() => {
          try {
            setSelectedMedia(null);
          } catch {}
        }}
        mediaType={selectedMedia?.type || 'image'}
        uri={selectedMedia?.uri || ''}
        name={selectedMedia?.name}
        uris={selectedMedia?.uris}
        initialIndex={selectedMedia?.index}
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

      {/* Меню чата: очистка переписки (шифрование включено всегда — настроек нет) */}
      <AppDialogModal
        visible={showClearMenu}
        onRequestClose={() => setShowClearMenu(false)}
        actions={[{ label: t('cancelAction', lang), onPress: () => setShowClearMenu(false) }]}
      >
        <View style={[appDialogStyles.section, { gap: 10 }]}>
          <Text style={chatMenuSectionLabel}>
            {t('chatClearMenuTitle', lang)}
          </Text>
          <AppDialogButton
            label={t('chatClearForAllOption', lang)}
            variant="danger"
            stretch={false}
            onPress={() => {
              setShowClearMenu(false);
              clearChatForAll();
            }}
          />
          <AppDialogButton
            label={t('chatClearForSelfOption', lang)}
            variant="danger"
            stretch={false}
            onPress={() => {
              setShowClearMenu(false);
              clearChatForMe();
            }}
          />
        </View>
      </AppDialogModal>

      {/* Android: bottom sheet для выбора вложений (камера/галерея) */}
      {Platform.OS === 'android' ? (
        <ChatAttachSheet
          ref={attachSheetRef}
          backdrop={chatBackdrop}
          isDark={isDark}
          lang={lang}
          LIVI={LIVI}
          outlineColor={theme.colors?.outline as string | undefined}
          bottomPad={ANDROID_SHEET_BOTTOM_PAD}
          onCamera={() => void handleCamera()}
          onGallery={() => void handleImagePicker()}
        />
      ) : null}

      {/* Переслать: выбор друга */}
      {showForwardPicker && (selectedMessage || selectionMode) && (
        // В landscape лист во всю ширину слишком растянут — AppOverlay ставит его по центру.
        <AppOverlay visible placement="bottom" onRequestClose={() => setShowForwardPicker(false)}>
          <Animated.View
            style={{
              transform: [{ translateY: forwardSheetTranslateY }],
              maxHeight: forwardPickerSheetMaxH,
              width: modalLayout.sheetWidth,
            }}
          >
          <Pressable
            onPress={() => {}}
            style={{
              ...(isDark && GLASS_AVAILABLE
                ? { backgroundColor: 'transparent' }
                : isDark
                  ? WELCOME_POPUP_SHEET_CHROME
                  : { backgroundColor: 'rgba(182, 203, 216, 1)' }),
              overflow: 'hidden',
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
            {isDark && GLASS_AVAILABLE ? (
              <GlassFill backdrop={chatBackdrop} style={{ borderTopLeftRadius: 20, borderTopRightRadius: 20 }} />
            ) : null}
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
                          color={isSelected ? (isDark ? WELCOME_POPUP_ACCENT : WELCOME_NAV_ACTIVE_ICON) : (theme.colors.titan as string)}
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

            <View
              style={{
                paddingTop: 8,
                // row-reverse: «Отмена» слева, «Переслать» справа — как в остальных диалогах.
                flexDirection: modalLayout.isLandscape ? 'row-reverse' : 'column',
                gap: modalLayout.isLandscape ? 10 : 0,
              }}
            >
            <TouchableOpacity
              onPress={() => void forwardToSelectedFriends()}
              disabled={forwardSelectedFriendIds.size === 0}
              style={{
                flex: modalLayout.isLandscape ? 1 : undefined,
                paddingVertical: modalLayout.isLandscape ? 11 : 14,
                backgroundColor:
                  forwardSelectedFriendIds.size > 0
                    ? (isDark ? `${WELCOME_POPUP_ACCENT}24` : WELCOME_NAV_ACTIVE_ACCENT.solid15)
                    : 'transparent',
                borderWidth: 1,
                borderColor:
                  forwardSelectedFriendIds.size > 0
                    ? (isDark ? `${WELCOME_POPUP_ACCENT}73` : WELCOME_NAV_ACTIVE_ICON)
                    : isDark
                      ? 'rgba(255,255,255,0.2)'
                      : 'rgba(0,0,0,0.15)',
                borderRadius: 12,
                marginBottom: modalLayout.isLandscape ? 0 : 8,
              }}
              activeOpacity={0.85}
            >
              <Text
                style={{
                  color:
                    forwardSelectedFriendIds.size > 0
                      ? (isDark ? WELCOME_POPUP_ACCENT : WELCOME_NAV_ACTIVE_ACCENT.softText)
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
                flex: modalLayout.isLandscape ? 1 : undefined,
                paddingVertical: modalLayout.isLandscape ? 11 : 14,
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
        </AppOverlay>
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
        accent={isDark ? WELCOME_POPUP_ACCENT : LIVI.accent.solid}
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

      {/* Универсальное подтверждение (массовое удаление, очистка, перезвонить и т.п.) */}
      <AppDialogModal
        visible={confirmVisible}
        onRequestClose={closeConfirm}
        title={confirmTitle || t('confirmActionTitle', lang)}
        message={confirmMessage || undefined}
        actions={[
          { label: confirmCancelText || t('cancelAction', lang), onPress: closeConfirm },
          {
            label: confirmOkText || t('ok', lang),
            onPress: runConfirm,
            variant: confirmDestructive ? 'danger' : 'primary',
          },
        ]}
      />

      {/* Подтверждение удаления сообщения (вместо Alert) — образец для всех диалогов */}
      <AppDialogModal
        visible={deleteConfirmVisible}
        onRequestClose={closeDeleteConfirm}
        title={deleteConfirmKind === 'multi' ? t('chatDeleteMessagesTitle', lang) : t('chatDeleteMessageTitle', lang)}
        message={
          deleteConfirmKind === 'multi'
            ? (selectedCount === 1
              ? t('chatDeleteSelectedOne', lang)
              : t('chatDeleteSelectedMany', lang).replace('{count}', String(selectedCount)))
            : t('chatActionCannotUndo', lang)
        }
        actions={[
          { label: t('cancelAction', lang), onPress: closeDeleteConfirm },
          { label: t('delete', lang), onPress: confirmDeleteNow, variant: 'danger' },
        ]}
      >
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
            backgroundColor: pressed ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)',
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: deleteForBoth ? 'rgba(255,90,103,0.45)' : 'rgba(255,255,255,0.12)',
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
              borderColor: deleteForBoth ? '#FF5A67' : 'rgba(255,255,255,0.45)',
            }}
          >
            {deleteForBoth ? <Ionicons name="checkmark" size={16} color="#FF5A67" /> : null}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: LIVI.white, fontSize: 15, fontWeight: '700' }}>
              {t('chatDeleteForEveryoneTitle', lang)}
            </Text>
            <Text style={{ marginTop: 3, color: 'rgba(255,255,255,0.50)', fontSize: 13, lineHeight: 17 }}>
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
      </AppDialogModal>

      {/* Уведомление/ошибка в виде диалогов приложения */}
      <AppDialogModal
        visible={noticeVisible}
        onRequestClose={closeNotice}
        icon={
          <Ionicons
            name={noticeKind === 'error' ? 'alert-circle-outline' : 'information-circle-outline'}
            size={18}
            color={noticeKind === 'error' ? '#FF5A67' : LIVI.titan}
          />
        }
        title={noticeTitle || (noticeKind === 'error' ? t('errorTitle', lang) : '')}
        message={noticeMessage || undefined}
        actions={[{ label: t('ok', lang), onPress: closeNotice }]}
      />
    </SafeAreaView>
    {/*
      Android: как в Telegram — сверху строка реакций, ниже список действий у края облака.
      Слой в окне чата, а не Modal: затемнение ложится и под системные кнопки (у окна
      диалога там своя тёмная подложка), и меню открывается без создания нового окна.
    */}
    {Platform.OS === 'android' && showMessageActions && selectedMessage && (
      <Pressable
        ref={msgActionsRootRef}
        onPress={hideMessageActions}
        onLayout={msgActionsComposerTop == null ? measureMsgActionsComposer : undefined}
        pointerEvents={msgActionsHeld ? 'none' : 'auto'}
        style={[StyleSheet.absoluteFill, { zIndex: 1000 }]}
      >
        {/* Чат приглушён (слегка) — видно, какое облако выбрано (его копия над меню). */}
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: 'rgba(0,0,0,0.36)', opacity: messageActionsProgress },
          ]}
        />
        <Animated.View
          pointerEvents={msgActionsComposerTop == null ? 'none' : 'box-none'}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: msgActionsTopPad,
            height: msgActionsStackH,
            overflow: 'hidden',
            opacity: messageActionsProgress,
          }}
        >
          {(() => {
            const msgId = selectedMessage?.id != null ? String(selectedMessage.id) : '';
            const isOwnMsg = selectedMessage?.from === currentUserId || selectedMessage?.sender === 'me';
            const isImageMsg = String(selectedMessage?.type || '') === 'image';
            const hasText = !!String(selectedMessage?.text || '').trim();
            const hasSticker = !!String(selectedMessage?.stickerId || '').trim();
            const hasContent = hasText || hasSticker || isImageMsg || !!String(selectedMessage?.uri || '').trim();
            const isRead =
              isOwnMsg && (readStatuses[msgId] === 'read' || (!readStatuses[msgId] && !!selectedMessage?.read));
            const myEmojis = new Set(
              withPendingReactions(selectedMessage?.reactions, msgId, currentUserId)
                .filter((r) => String(r.userId) === String(currentUserId))
                .map((r) => r.emoji),
            );
            const emojis = msgReactionsExpanded
              ? SHEET_REACTIONS_ALL
              : SHEET_REACTIONS_ALL.slice(0, MSG_REACTIONS_COLLAPSED);
            const emojiFontSize = msgActionsLandscape ? 22 : 26;
            // Стекло: сквозь блоки меню размыт чат (стекло ищет чат по экрану).
            const menuGlass = isDark && GLASS_AVAILABLE;
            const surface = {
              overflow: 'hidden' as const,
              backgroundColor: menuGlass ? 'transparent' : isDark ? WELCOME_POPUP_SURFACE : LIVI.bg,
              borderWidth: menuGlass ? 0 : isDark ? StyleSheet.hairlineWidth : 1,
              borderColor: isDark ? WELCOME_GLASS_RIM : 'rgba(0,0,0,0.06)',
            };
            const emojiPress = (emoji: string) => {
              hideMessageActions();
              if (msgId) toggleMyReaction(msgId, emoji);
            };

            type MenuRow = {
              key: string;
              label: string;
              icon: React.ComponentProps<typeof Ionicons>['name'];
              onPress: () => void;
              danger?: boolean;
            };
            const rows: MenuRow[] = [];
            if (hasContent) {
              rows.push({
                key: 'reply',
                label: t('chatActionReply', lang),
                icon: 'arrow-undo-outline',
                onPress: () => {
                  setEditingMessageId(null);
                  messageTextRef.current = '';
                  setMessageText('');
                  setReplyingToMessage({
                    id: msgId,
                    text: getChatReplyPreviewText(selectedMessage, lang),
                    from: selectedMessage?.from,
                    isOwn: isOwnMsg,
                  });
                },
              });
              if (!isImageMsg && (hasText || hasSticker)) {
                rows.push({
                  key: 'copy',
                  label: t('chatActionCopy', lang),
                  icon: 'copy-outline',
                  onPress: () => void copySelectedMessage(selectedMessage),
                });
              }
              if (isImageMsg) {
                rows.push({
                  key: 'save',
                  label: t('save', lang),
                  icon: 'download-outline',
                  onPress: () => requestImageAction('save', selectedMessage, albumFocusIndex),
                });
              }
              rows.push({
                key: 'forward',
                label: t('chatActionForward', lang),
                icon: 'arrow-redo-outline',
                onPress: () =>
                  isImageMsg
                    ? requestImageAction('forward', selectedMessage, albumFocusIndex)
                    : void openForwardPicker(),
              });
              if (isOwnMsg && String(selectedMessage?.type || '') === 'text') {
                rows.push({
                  key: 'edit',
                  label: t('chatActionEdit', lang),
                  icon: 'pencil-outline',
                  onPress: () => {
                    const text = String(selectedMessage?.text ?? '');
                    messageTextRef.current = text;
                    setMessageText(text);
                    setEditingMessageId(selectedMessage?.id ?? null);
                    setReplyingToMessage(null);
                  },
                });
              }
              rows.push({
                key: 'select',
                label: t('chatActionSelect', lang),
                icon: 'checkmark-circle-outline',
                onPress: () => enterSelectionModeFromMessage(selectedMessage, albumFocusIndex),
              });
            }
            rows.push({
              key: 'delete',
              label: t('delete', lang),
              icon: 'trash-outline',
              danger: true,
              onPress: () => {
                if (isImageMsg) requestImageAction('delete', selectedMessage, albumFocusIndex);
                else confirmDeleteSelectedMessage(selectedMessage);
              },
            });

            // Landscape: список — своя колонка во всю высоту; не влезает — строки
            // чуть мельче (не меньше 80%), дальше прокрутка.
            const baseRowHeight = msgActionsLandscape ? 40 : 48;
            const listNaturalH = rows.length * baseRowHeight + 8 + (isRead ? baseRowHeight : 0);
            const listFit = msgActionsLandscape
              ? Math.min(1, Math.max(0.8, msgActionsStackH / listNaturalH))
              : 1;
            const rowHeight = Math.round(baseRowHeight * listFit);
            const rowPadH = msgActionsLandscape ? 12 : 16;
            const iconGap = Math.round((msgActionsLandscape ? 12 : 16) * listFit);
            const actionFontSize = Math.round((msgActionsLandscape ? 14 : 16) * listFit);
            const actionIconSize = Math.round((msgActionsLandscape ? 19 : 22) * listFit);

            // Portrait: реакции и список целиком, копия облака — сколько останется
            // (длинное сообщение обрезается, а не меню).
            const pillRows = msgReactionsExpanded
              ? Math.ceil((SHEET_REACTIONS_ALL.length + 1) / (MSG_REACTIONS_COLLAPSED + 1))
              : 1;
            const pillH = pillRows * msgReactionCell + 10;
            const listMaxH = msgActionsLandscape
              ? msgActionsStackH
              : Math.max(
                  160,
                  msgActionsStackH - pillH - msgActionsBlockGap * 2 - MSG_ACTIONS_PREVIEW_MIN_H,
                );

            // Реакции: строка эмодзи и стрелка, которая раскрывает все.
            const reactionsRadius = msgReactionsExpanded ? 22 : (msgReactionCell + 8) / 2;
            const reactionsPill = (
              <View
                style={{
                  ...surface,
                  width: msgActionsCardWidth,
                  borderRadius: reactionsRadius,
                  padding: 4,
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >
                {menuGlass ? <GlassFill backdrop={chatBackdrop} style={{ borderRadius: reactionsRadius }} /> : null}
                {emojis.map((emoji) => (
                  <Pressable
                    key={emoji}
                    onPress={() => emojiPress(emoji)}
                    hitSlop={2}
                    style={({ pressed }) => ({
                      width: msgReactionCell,
                      height: msgReactionCell,
                      borderRadius: msgReactionCell / 2,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: pressed
                        ? 'rgba(255,255,255,0.08)'
                        : myEmojis.has(emoji)
                          ? 'rgba(255,255,255,0.12)'
                          : 'transparent',
                    })}
                  >
                    <Text style={{ fontSize: emojiFontSize }}>{emoji}</Text>
                  </Pressable>
                ))}
                <Pressable
                  onPress={() => setMsgReactionsExpanded((v) => !v)}
                  hitSlop={4}
                  accessibilityRole="button"
                  style={{ width: msgReactionCell, height: msgReactionCell, alignItems: 'center', justifyContent: 'center' }}
                >
                  {({ pressed }) => (
                    <View
                      style={{
                        width: msgReactionCell - 8,
                        height: msgReactionCell - 8,
                        borderRadius: (msgReactionCell - 8) / 2,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: pressed ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.08)',
                      }}
                    >
                      <Ionicons
                        name={msgReactionsExpanded ? 'chevron-up' : 'chevron-down'}
                        size={actionIconSize - 2}
                        color="rgba(255,255,255,0.8)"
                      />
                    </View>
                  )}
                </Pressable>
              </View>
            );
            const actionsList = (
              <View
                style={{
                  ...surface,
                  width: msgActionsListWidth,
                  maxHeight: listMaxH,
                  borderRadius: 12,
                  ...(isDark ? null : { backgroundColor: 'rgba(21,31,51,0.90)' }),
                }}
              >
                {menuGlass ? <GlassFill backdrop={chatBackdrop} style={{ borderRadius: 12 }} /> : null}
                {isRead ? (
                  <>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        height: rowHeight - 4,
                        paddingHorizontal: rowPadH,
                      }}
                    >
                      <Ionicons
                        name="checkmark-done"
                        size={actionIconSize - 2}
                        color={CHAT_READ_TICK_COLOR}
                        style={{ marginRight: iconGap - 4 }}
                      />
                      <Text style={{ color: WELCOME_MUTED_TEXT, fontSize: actionFontSize - 1 }} numberOfLines={1}>
                        {t('chatMessageReadStatus', lang)}
                      </Text>
                    </View>
                    <View style={{ height: msgActionsLandscape ? 4 : 6, backgroundColor: 'rgba(0,0,0,0.28)' }} />
                  </>
                ) : null}
                <ScrollView
                  // flexGrow 0: по умолчанию ScrollView растёт, и в landscape-колонке
                  // список тянулся на всю высоту с пустотой под пунктами.
                  style={{ flexGrow: 0, flexShrink: 1 }}
                  contentContainerStyle={{ flexGrow: 0, paddingVertical: 4 }}
                  showsVerticalScrollIndicator={false}
                  bounces={false}
                >
                  {rows.map((row) => (
                    <Pressable
                      key={row.key}
                      onPress={() => {
                        hideMessageActions();
                        row.onPress();
                      }}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        height: rowHeight,
                        paddingHorizontal: rowPadH,
                        backgroundColor: pressed
                          ? row.danger
                            ? 'rgba(255,90,103,0.08)'
                            : (isDark ? WELCOME_POPUP_PRESSED : LIVI.accent.vivid10)
                          : 'transparent',
                      })}
                    >
                      <Ionicons
                        name={row.icon}
                        size={actionIconSize}
                        color={row.danger ? '#FF5A67' : LIVI.titan}
                        style={{ marginRight: iconGap }}
                      />
                      <Text
                        style={{ color: row.danger ? '#FF5A67' : LIVI.white, fontSize: actionFontSize, fontWeight: '400', flexShrink: 1 }}
                        numberOfLines={1}
                      >
                        {row.label}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            );
            const previewRow = renderMessageRow({ item: selectedMessage, centered: true });

            if (msgActionsLandscape) {
              // Landscape: одна компактная группа, как стопка в portrait — реакции по центру
              // над облаком, список вплотную справа. Облако не влезает — уменьшается целиком.
              const sidePadL = Math.max(insets.left, chatChromeSideInset);
              const sidePadR = Math.max(insets.right, chatChromeSideInset);
              const columnGap = msgActionsBlockGap * 2;
              const maxBubbleColumnW = Math.max(
                msgActionsCardWidth,
                modalLayout.width - sidePadL - sidePadR - columnGap - msgActionsListWidth,
              );
              // Колонка по ширине зажатого облака — без пустоты между облаком и списком.
              const pressedBubbleW = messageActionsLayoutRef.current?.width ?? 0;
              const bubbleW = Math.min(
                pressedBubbleW > 0 ? Math.ceil(pressedBubbleW) : msgActionsCardWidth,
                maxBubbleColumnW,
              );
              const bubbleColumnW = Math.max(msgActionsCardWidth, bubbleW);
              // Строка облака: отступы 16+16, maxWidth 92%, само облако maxWidth 80% —
              // рендерим копию на ширине, где облако ложится тем же переносом, что в чате.
              const previewRenderW = Math.ceil(Math.max(bubbleW / 0.8 + 32, bubbleW / (0.8 * 0.92))) + 2;
              // Фото/альбом фиксированной ширины не переносится — ужимаем по ширине колонки.
              const previewWidthScale =
                isImageMsg && pressedBubbleW > bubbleColumnW ? bubbleColumnW / pressedBubbleW : 1;
              return (
                <View
                  pointerEvents="box-none"
                  style={{
                    flex: 1,
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    paddingLeft: sidePadL,
                    paddingRight: sidePadR,
                  }}
                >
                  <View pointerEvents="box-none" style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View pointerEvents="box-none" style={{ width: bubbleColumnW, alignItems: 'center' }}>
                      {reactionsPill}
                      <View style={{ height: msgActionsBlockGap }} />
                      <ChatMessagePreviewFit
                        key={msgId}
                        maxHeight={msgActionsStackH - pillH - msgActionsBlockGap}
                        contentWidth={previewRenderW}
                        widthScale={previewWidthScale}
                      >
                        {previewRow}
                      </ChatMessagePreviewFit>
                    </View>
                    <View style={{ width: columnGap }} />
                    {actionsList}
                  </View>
                </View>
              );
            }

            return (
            <View
              pointerEvents="box-none"
              style={{
                flex: 1,
                // Стопка прижата к низу — над полем ввода; реакции и список по центру.
                justifyContent: 'flex-end',
                alignItems: 'center',
              }}
            >
              {reactionsPill}

              {/* Копия выбранного облака — по центру, между реакциями и списком. */}
              <View
                pointerEvents="none"
                style={{
                  alignSelf: 'stretch',
                  flexShrink: 1,
                  minHeight: 0,
                  overflow: 'hidden',
                  marginVertical: msgActionsBlockGap,
                }}
              >
                {previewRow}
              </View>

              {actionsList}
            </View>
            );
          })()}
        </Animated.View>
      </Pressable>
    )}
    {/* Полоса реакций: двойной тап по сообщению; свайп вправо — ещё 6 эмодзи */}
    {reactionBarForMessageId !== null && (
      <ReactionBarOverlay
        visible
        backdrop={chatBackdrop}
        anchor={reactionBarAnchor}
        onClose={closeReactionBar}
        onPickEmoji={(emoji) => {
          toggleMyReaction(reactionBarForMessageId, emoji);
          closeReactionBar();
        }}
        isDark={isDark}
      />
    )}
    </View>
  );
}
