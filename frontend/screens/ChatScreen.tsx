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
  Linking,
  Modal,
  Pressable,
  Animated,
  PanResponder,
  Vibration,
  NativeModules,
  Dimensions,
  Image,
  StyleSheet,
  Share,
} from "react-native";
 
import { useSafeAreaInsets, SafeAreaView } from "react-native-safe-area-context";
import { PanGestureHandler, PinchGestureHandler, State, GestureHandlerRootView } from "react-native-gesture-handler";
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
import { BlurView } from 'expo-blur';
import Svg, { Circle as SvgCircle, Defs, LinearGradient, Stop, G } from 'react-native-svg';
import { getAvatarImageProps } from '../utils/imageOptimization';
import { useResolvedImageUri } from '../hooks/useResolvedImageUri';

import { API_BASE, getMyProfile } from '../sockets/socket';
import { logger } from '../utils/logger';
import { toAvatarThumb } from '../utils/uploadAvatar';
import {
  onFriendProfile,
  onPresenceUpdate,
  PRESENCE_OFFLINE_DEBOUNCE_MS,
  isReconnecting,
} from '../sockets/socket';
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
  onMessageReaction,
  sendMessageReaction,
  markMessagesAsRead,
  sendReadReceipt,
  onUserPresence,
  hasVisibleOnlinePresenceSnapshot,
  isPeerInVisibleOnlinePresence,
  getChatMessages,
  clearMessageCache,
  clearChatMessages,
  onChatCleared,
  deleteMessage,
  editMessage,
  onMessageDeleted,
  onMessageEdited,
  globalMessageStorage,
  fetchMessages,
  fetchFriends,
  getAvatar,
  sendChatViewing,
} from "../sockets/socket";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLang } from "../store/lang";
import { t } from "../utils/i18n";
import { clearNotificationIndicators, setCurrentChatPeerId, dismissMessageNotificationForUser } from "../utils/pushNotifications";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";

type RouteParams = {
  peerId: string;
  peerName?: string;
  peerAvatar?: string; // deprecated
  peerAvatarVer?: number;
  peerAvatarThumbB64?: string;
  peerOnline?: boolean;
};
type Props = { route: { params?: RouteParams }; navigation: any };

/** Разбивает текст на сегменты «текст» и «ссылка» для отображения кликабельных URL в сообщениях. */
function parseTextWithUrls(text: string): { type: 'text' | 'url'; value: string }[] {
  if (!text || typeof text !== 'string') return [{ type: 'text', value: '' }];
  const regex = /(https?:\/\/[^\s<>"\]]+|www\.[^\s<>"\]]+)/gi;
  const parts = text.split(regex).filter(Boolean);
  return parts.map((part) => ({
    type: /^(https?:\/\/|www\.)/i.test(part) ? 'url' : 'text',
    value: part,
  }));
}

/** Нормализует URL для открытия (добавляет https:// для www.). */
function openMessageUrl(raw: string): void {
  const url = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`;
  Linking.openURL(url).catch(() => {});
}

const REACTION_EMOJIS_PAGE_1 = ['👍', '😊', '❤️', '😮', '😢', '👎'];
const REACTION_EMOJIS_PAGE_2 = ['😉', '😂', '😍', '😭', '🙏', '🔥'];
/** Порядок в bottom sheet по зажиму: первый ряд — 👍 ❤️ 🙏 🔥 😉 😂, второй — остальные */
const SHEET_REACTIONS_ROW_1 = ['👍', '❤️', '🙏', '🔥', '😉', '😂'];
const SHEET_REACTIONS_ROW_2 = ['😊', '😮', '😢', '👎', '😍', '😭'];

function ReactionBarModal({
  visible,
  onClose,
  onPickEmoji,
  isDark,
}: {
  visible: boolean;
  onClose: () => void;
  onPickEmoji: (emoji: string) => void;
  isDark: boolean;
}) {
  const scrollRef = React.useRef<ScrollView>(null);
  const hintBounce = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (visible) {
      scrollRef.current?.scrollTo({ x: 0, animated: false });
    }
  }, [visible]);

  React.useEffect(() => {
    if (!visible) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(hintBounce, { toValue: 6, duration: 500, useNativeDriver: true }),
        Animated.timing(hintBounce, { toValue: 0, duration: 500, useNativeDriver: true }),
      ]),
      { iterations: -1 }
    );
    loop.start();
    return () => loop.stop();
  }, [visible, hintBounce]);

  const barWidth = Math.min(320, Dimensions.get('window').width * 0.88);

  const barStyle = {
    width: barWidth,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    backgroundColor: isDark ? '#1e2329' : '#2d3238',
    borderRadius: 24,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)' as const,
  };

  const renderEmojiRow = (emojis: string[]) => (
    <View style={{ flexDirection: 'row', flex: 1, justifyContent: 'space-between', alignItems: 'center' }}>
      {emojis.map((emoji) => (
        <Pressable
          key={emoji}
          onPress={() => onPickEmoji(emoji)}
          style={{ padding: 6, minWidth: 36, alignItems: 'center', justifyContent: 'center' }}
          hitSlop={8}
        >
          <Text style={{ fontSize: 24 }}>{emoji}</Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)' }}
        onPress={onClose}
      >
        <Pressable onPress={() => {}} style={{ width: barWidth, overflow: 'hidden' }}>
          <ScrollView
            ref={scrollRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            decelerationRate="fast"
            snapToInterval={barWidth}
            snapToAlignment="start"
            contentContainerStyle={{ flexGrow: 1 }}
            style={{ borderRadius: 24, overflow: 'hidden' }}
          >
            {/* Страница 1: эффект слева + 6 эмодзи ровно по полосе */}
            <View style={barStyle}>
              <Animated.View
                style={{
                  marginRight: 6,
                  paddingRight: 8,
                  borderRightWidth: 1,
                  borderRightColor: 'rgba(255,255,255,0.15)',
                  transform: [{ translateX: hintBounce }],
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="chevron-back" size={18} color="rgba(255,255,255,0.8)" />
              </Animated.View>
              {renderEmojiRow(REACTION_EMOJIS_PAGE_1)}
            </View>
            {/* Страница 2: ещё 6 эмодзи ровно по полосе */}
            <View style={barStyle}>
              {renderEmojiRow(REACTION_EMOJIS_PAGE_2)}
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const SHEET_REACTIONS_ALL = [...SHEET_REACTIONS_ROW_1, ...SHEET_REACTIONS_ROW_2];
const REACTIONS_PAGE_SIZE = 4;

/** Один ряд реакций: по 4 эмодзи на страницу, на первой — стрелка «свайп вправо» */
function ReactionsRowWithSwipe({
  selectedMessage,
  hideMessageActions,
  sendMessageReaction,
  peerId,
  isDark,
}: {
  selectedMessage: any;
  hideMessageActions: () => void;
  sendMessageReaction: (msgId: string, emoji: string, peerId: string) => Promise<unknown>;
  peerId: string;
  isDark: boolean;
}) {
  const scrollRef = React.useRef<ScrollView>(null);
  const rowW = 220 - 24;
  const arrowBounce = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(arrowBounce, { toValue: 4, duration: 600, useNativeDriver: true }),
        Animated.timing(arrowBounce, { toValue: 0, duration: 600, useNativeDriver: true }),
      ]),
      { iterations: -1 }
    );
    loop.start();
    return () => loop.stop();
  }, [arrowBounce]);
  const emojiPress = (emoji: string) => {
    hideMessageActions();
    const msgId = selectedMessage?.id != null ? String(selectedMessage.id) : null;
    if (msgId) sendMessageReaction(msgId, emoji, peerId).catch(() => {});
  };
  const emojiStyle = (pressed: boolean) => ({
    padding: 4,
    minWidth: 30,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderRadius: 10,
    backgroundColor: pressed ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)') : 'transparent',
  });
  const pages: string[][] = [];
  for (let i = 0; i < SHEET_REACTIONS_ALL.length; i += REACTIONS_PAGE_SIZE) {
    pages.push(SHEET_REACTIONS_ALL.slice(i, i + REACTIONS_PAGE_SIZE));
  }
  return (
    <View style={{ borderRadius: 20, overflow: 'hidden', paddingVertical: 4, paddingHorizontal: 4 }}>
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        snapToInterval={rowW}
        snapToAlignment="start"
        contentContainerStyle={{ paddingHorizontal: 4 }}
        style={{ marginHorizontal: -4 }}
      >
        {pages.map((emojis, pageIndex) => (
          <View key={pageIndex} style={{ width: rowW, flexDirection: 'row', alignItems: 'center', justifyContent: pageIndex === 0 ? 'space-between' : 'space-around', paddingVertical: 2, paddingRight: pageIndex === 0 ? 8 : 0 }}>
            {emojis.map((emoji) => (
              <Pressable key={emoji} onPress={() => emojiPress(emoji)} style={({ pressed }) => emojiStyle(pressed)} hitSlop={4}>
                <Text style={{ fontSize: 20 }}>{emoji}</Text>
              </Pressable>
            ))}
            {pageIndex === 0 && (
              <Animated.View style={{ marginLeft: 4, transform: [{ translateX: arrowBounce }] }}>
                <Ionicons name="chevron-forward" size={18} color={isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)'} />
              </Animated.View>
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

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
    titan: theme.colors.onSurfaceVariant as string,
    text: theme.colors.onSurfaceVariant as string,
    white: theme.colors.onSurface as string,
    green: '#2ECC71',
    red: '#FF5A67',
    presenceGreen: isDark ? '#2ECC71' : '#28A85E',
    presenceRed: isDark ? '#FF5A67' : '#E64E59',
    replyQuoteAccent: isDark ? 'rgba(186, 236, 224, 0.98)' : 'rgba(154, 134, 190, 0.98)',
    replyQuotePressBg: isDark ? 'rgba(186, 236, 224, 0.14)' : 'rgba(154, 134, 190, 0.22)',
    replyHighlightAccent: isDark ? 'rgba(186, 236, 224, 0.95)' : 'rgba(154, 134, 190, 0.96)',
  } as const), [theme, isDark]);

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
  // Цвета облаков: в светлой теме немного затемняем входящие, исходящие чуть светлее
  // Тёмная тема — как было изначально; светлая — оставляем текущие оттенки
  const BUBBLE_BG_OUT = isDark ? LIVI.rgb : 'hsla(220, 2.80%, 79.00%, 0.70)';
  const BUBBLE_BG_IN  = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(114, 141, 175, 0.32)';
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
  useFocusEffect(
    useCallback(() => {
      if (peerId) {
        setCurrentChatPeerId(peerId);
        sendChatViewing(peerId);
        dismissMessageNotificationForUser(peerId).catch(() => {});
      }
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

  const [conversation, setConversation] =
    useState<CometChat.Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  /** Always points at latest `messages` for background/unmount persistence (avoid stale closures). */
  const latestMessagesForPersistRef = useRef(messages);
  latestMessagesForPersistRef.current = messages;
  /** Для каких id уже слали `message:read` — без этого при каждом своём сообщении шли read по всей истории peer и забивали сокет. */
  const readReceiptSentIdsRef = useRef<Set<string>>(new Set());
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
  const [confirmCancelText, setConfirmCancelText] = useState('');
  const [confirmOkText, setConfirmOkText] = useState('');
  const [confirmDestructive, setConfirmDestructive] = useState(false);
  const onConfirmRef = useRef<(() => void) | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  // Android: до первого onLayout нужен реалистичный размер нижней панели,
  // иначе входящее сообщение может стартово оказаться под инпутом.
  const estimatedInputHeight = 124 + Math.max(0, insets.bottom);
  const [inputHeight, setInputHeight] = useState(estimatedInputHeight);
  const [messageText, setMessageText] = useState("");
  const [peerActivity, setPeerActivity] = useState<'typing' | 'recording' | null>(null);
  const [peerTypingDots, setPeerTypingDots] = useState(1);
  const [readStatuses, setReadStatuses] = useState<Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>>({});
  const [uploadStatus, setUploadStatus] = useState<Record<string, 'sending' | 'sent' | 'failed'>>({});
  const [showClearMenu, setShowClearMenu] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<any>(null);
  const [selectedMessageLayout, setSelectedMessageLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const messageActionsLayoutRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const reactionsScrollRef = useRef<ScrollView>(null);
  const [showMessageActions, setShowMessageActions] = useState(false);
  const [showForwardPicker, setShowForwardPicker] = useState(false);
  const [forwardFriends, setForwardFriends] = useState<any[]>([]);
  const [forwardLoading, setForwardLoading] = useState(false);
  // Выбранные друзья для пересылки (несколько получателей)
  const [forwardSelectedFriendIds, setForwardSelectedFriendIds] = useState<Set<string>>(new Set());
  // Multi-select (режим "Выбрать")
  const [selectionMode, setSelectionMode] = useState(false);
  /** Подсветка сообщения при переходе по цитате в ответе */
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  // Для панели реакций: id сообщения, по которому дважды нажали (показать полосу эмодзи)
  const [reactionBarForMessageId, setReactionBarForMessageId] = useState<string | null>(null);
  /** ID сообщения, которое пользователь редактирует (текст в поле ввода). */
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  /** Сообщение, на которое отвечаем (показываем превью над полем ввода). */
  const [replyingToMessage, setReplyingToMessage] = useState<{ id: string; text: string; from?: string; isOwn?: boolean } | null>(null);
  const [forwardToast, setForwardToast] = useState<{ visible: boolean; ok: boolean; text: string }>({
    visible: false,
    ok: true,
    text: '',
  });
  const messageActionsOpacity = useRef(new Animated.Value(0)).current;
  const messageActionsTranslateY = useRef(new Animated.Value(30)).current;
  const forwardToastOpacity = useRef(new Animated.Value(0)).current;
  const forwardToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forwardSheetTranslateY = useRef(new Animated.Value(0)).current;
  /** Блокирует повторный вызов send до ре-рендера (двойной тап по «Отправить»). */
  const textSendGuardRef = useRef(false);

  useEffect(() => {
    if (showForwardPicker) forwardSheetTranslateY.setValue(0);
  }, [showForwardPicker]);

  const onForwardSheetGestureEvent = React.useCallback(
    (e: { nativeEvent: { translationY: number } }) => {
      forwardSheetTranslateY.setValue(Math.max(0, e.nativeEvent.translationY));
    },
    [],
  );

  const onForwardSheetHandlerStateChange = React.useCallback(
    (e: { nativeEvent: { state: number; translationY: number; velocityY: number } }) => {
      const { state, translationY, velocityY } = e.nativeEvent;
      if (state === State.END || state === 5) {
        const screenH = Dimensions.get('window').height;
        if (translationY > 80 || velocityY > 200) {
          Animated.timing(forwardSheetTranslateY, {
            toValue: screenH,
            duration: 220,
            useNativeDriver: true,
          }).start(() => {
            setShowForwardPicker(false);
            forwardSheetTranslateY.setValue(0);
          });
        } else {
          Animated.spring(forwardSheetTranslateY, {
            toValue: 0,
            useNativeDriver: true,
            tension: 80,
            friction: 12,
          }).start();
        }
      }
    },
    [],
  );

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
  const currentUserIdForPersistRef = useRef<string | null>(null);
  currentUserIdForPersistRef.current = currentUserId;

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

  // Фактический подъём панели над клавиатурой:
  // lift = keyboardInset - (на сколько система уже ужала контейнер)
  const systemResizeDelta =
    Platform.OS === 'ios' && keyboardVisible
      ? Math.max(0, baseRootLayoutHRef.current - rootLayoutH)
      : 0;
  // Android: в манифесте уже включён adjustResize, поэтому ручной подъём списка/инпута
  // только добавляет лишний layout-pass и визуальное мигание FlatList.
  const keyboardLift =
    Platform.OS === 'android'
      ? 0
      : (keyboardVisible ? Math.max(0, keyboardInset - systemResizeDelta) : 0);

  // ===== Typing indicator (peer + local) =====
  // Высота видимого зазора между последним сообщением и верхом инпута
  // (сюда ставим "Пишет..." / "Записывает..." / служебные события).
  const TYPING_GAP_H = -20;
  const peerTypingHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localTypingStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localTypingActiveRef = useRef(false);
  const lastTypingSentAtRef = useRef(0);
  const localRecordingPingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const localRecordingActiveRef = useRef(false);

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

  const stopLocalRecordingSignal = React.useCallback(() => {
    try {
      if (localRecordingPingTimerRef.current) {
        clearInterval(localRecordingPingTimerRef.current);
        localRecordingPingTimerRef.current = null;
      }
    } catch {}
    if (localRecordingActiveRef.current) {
      localRecordingActiveRef.current = false;
      try {
        if (peerId) sendChatTyping({ to: peerId, typing: false, recording: false });
      } catch {}
    }
  }, [peerId]);

  const startLocalRecordingSignal = React.useCallback(() => {
    if (!peerId) return;
    localRecordingActiveRef.current = true;
    try {
      // Send once immediately and then keep-alive while user holds the record button.
      sendChatTyping({ to: peerId, typing: false, recording: true });
    } catch {}
    try {
      if (localRecordingPingTimerRef.current) clearInterval(localRecordingPingTimerRef.current);
      localRecordingPingTimerRef.current = setInterval(() => {
        try { sendChatTyping({ to: peerId, typing: false, recording: true }); } catch {}
      }, 900);
    } catch {}
  }, [peerId]);

  const signalLocalTyping = React.useCallback(() => {
    if (!peerId) return;
    const now = Date.now();
    // Throttle "typing:true" to avoid spamming the socket,
    // but keep it frequent enough so the peer sees it almost immediately.
    if (!localTypingActiveRef.current || now - lastTypingSentAtRef.current > 450) {
      lastTypingSentAtRef.current = now;
      localTypingActiveRef.current = true;
      try {
        sendChatTyping({ to: peerId, typing: true, recording: false });
      } catch {}
    }
    if (localTypingStopTimerRef.current) clearTimeout(localTypingStopTimerRef.current);
    localTypingStopTimerRef.current = setTimeout(() => {
      stopLocalTyping();
    }, 1200);
  }, [peerId, stopLocalTyping]);

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      stopLocalTyping();
      stopLocalRecordingSignal();
      if (peerTypingHideTimerRef.current) {
        clearTimeout(peerTypingHideTimerRef.current);
        peerTypingHideTimerRef.current = null;
      }
    };
  }, [stopLocalTyping, stopLocalRecordingSignal]);

  useEffect(() => {
    // Incoming typing events from peer
    const off = onChatTyping((data) => {
      try {
        const from = String((data as any)?.from || '');
        const to = String((data as any)?.to || '');
        const typing = !!(data as any)?.typing;
        const recording = !!(data as any)?.recording;

        if (!from || from !== peerId) return;
        if (currentUserId && to && to !== String(currentUserId)) return;

        if (peerTypingHideTimerRef.current) {
          clearTimeout(peerTypingHideTimerRef.current);
          peerTypingHideTimerRef.current = null;
        }

        const next: 'typing' | 'recording' | null =
          recording ? 'recording' : (typing ? 'typing' : null);

        setPeerActivity(next);

        if (next) {
          // If "stop" event is lost, hide after a short grace period.
          // Recording needs a keep-alive ping while the peer is holding the button.
          const ttl = next === 'recording' ? 1400 : 1600;
          peerTypingHideTimerRef.current = setTimeout(() => {
            setPeerActivity(null);
          }, ttl);
        }
      } catch {}
    });
    return () => {
      off?.();
    };
  }, [peerId, currentUserId]);

  useEffect(() => {
    const active = peerActivity === 'typing' || peerActivity === 'recording';
    if (!active) {
      setPeerTypingDots(1);
      return;
    }
    const id = setInterval(() => {
      setPeerTypingDots((prev) => (prev % 3) + 1);
    }, 420);
    return () => clearInterval(id);
  }, [peerActivity]);

  const GapCenterIndicator = React.useMemo(() => {
    const peerTyping = peerActivity === 'typing';
    const peerRecording = peerActivity === 'recording';
    const isDeleteToast = forwardToast.visible && String(forwardToast.text || '') === t('chatDeleted', lang);
    // Приоритет: "Записывает" > "Печатает..." > "Отправлено"
    if (!peerTyping && !peerRecording && (!forwardToast.visible || isDeleteToast)) return null;

    const baseStyle = {
      fontSize: 13,
      fontStyle: 'italic' as const,
      fontWeight: '500' as const,
      letterSpacing: 0.2,
    };

    const text = peerRecording
      ? `${t('chatRecording', lang)}${'.'.repeat(peerTypingDots)}`
      : (peerTyping
        ? `${t('chatTyping', lang)}${'.'.repeat(peerTypingDots)}`
        : String(forwardToast.text || t('chatSent', lang)));

    const color = (peerTyping || peerRecording)
      ? (isDark ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.40)')
      : (forwardToast.ok ? '#55d187' : '#FF5A67');

    return (
      <Animated.View
        pointerEvents="none"
        style={{
          justifyContent: 'center',
          alignItems: 'center',
          opacity: (peerTyping || peerRecording) ? 1 : forwardToastOpacity,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ ...baseStyle, color }}>{text}</Text>
        </View>
      </Animated.View>
    );
  }, [peerActivity, peerTypingDots, isDark, forwardToast.visible, forwardToast.text, forwardToast.ok, forwardToastOpacity, lang]);

  const DeleteToastInline = React.useMemo(() => {
    if (!forwardToast.visible || String(forwardToast.text || '') !== t('chatDeleted', lang)) return null;
    return (
      <Animated.View
        pointerEvents="none"
        style={{
          alignItems: 'center',
          opacity: forwardToastOpacity,
        }}
      >
        <Text
          style={{
            fontSize: 13,
            fontStyle: 'italic',
            fontWeight: '500',
            letterSpacing: 0.2,
            color: '#FF5A67',
          }}
        >
          {forwardToast.text}
        </Text>
      </Animated.View>
    );
  }, [forwardToast.visible, forwardToast.text, forwardToastOpacity, lang]);

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
  const getMessagesKey = (userId: string, peerId: string) => {
    const sortedIds = [userId, peerId].sort();
    return `chat_messages_${sortedIds[0]}_${sortedIds[1]}`;
  };

  const getStatusesKey = (userId: string, peerId: string) => {
    const sortedIds = [userId, peerId].sort();
    return `chat_statuses_${sortedIds[0]}_${sortedIds[1]}`;
  };

  /**
   * Одна очередь на запись чата в AsyncStorage: параллельные setItem давали multi-second spikes (см. логи setItemMs).
   * Снимок всегда из ref в момент выполнения — быстрые пачки обновлений схлопываются в одну запись.
   */
  const persistWriteTailRef = useRef<Promise<void>>(Promise.resolve());

  const flushMessagesPersist = React.useCallback(async (_reason: string) => {
    const uid = String(currentUserIdForPersistRef.current || '').trim();
    const pid = String(peerIdForPersistRef.current || '').trim();
    const msgs = latestMessagesForPersistRef.current;
    if (!uid || !pid || !Array.isArray(msgs)) return;
    const sortedIds = [uid, pid].sort();
    const key = `chat_messages_${sortedIds[0]}_${sortedIds[1]}`;
    try {
      await AsyncStorage.setItem(key, JSON.stringify(msgs));
    } catch (error) {
      console.warn('💾 Failed to save messages to AsyncStorage:', error);
    }
  }, []);

  const enqueueMessagesPersist = React.useCallback((reason: string) => {
    persistWriteTailRef.current = persistWriteTailRef.current
      .then(() => flushMessagesPersist(reason))
      .catch(() => {});
  }, [flushMessagesPersist]);

  const persistDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistDebounceGenRef = useRef(0);

  // Debounced persist: keeps UI responsive during rapid send/receive (no JSON.stringify in setState updaters).
  useEffect(() => {
    if (!currentUserId || !peerId) return;
    // Avoid writing previous chat's messages under the new peer's storage key while history reloads.
    if (!historyReady) return;
    persistDebounceGenRef.current += 1;
    const gen = persistDebounceGenRef.current;
    if (persistDebounceTimerRef.current) {
      clearTimeout(persistDebounceTimerRef.current);
      persistDebounceTimerRef.current = null;
    }
    persistDebounceTimerRef.current = setTimeout(() => {
      persistDebounceTimerRef.current = null;
      if (gen !== persistDebounceGenRef.current) return;
      enqueueMessagesPersist('debounced_effect');
    }, 400);
    return () => {
      if (persistDebounceTimerRef.current) {
        clearTimeout(persistDebounceTimerRef.current);
        persistDebounceTimerRef.current = null;
      }
    };
  }, [messages, currentUserId, peerId, enqueueMessagesPersist, historyReady]);

  useEffect(() => {
    return () => {
      enqueueMessagesPersist('unmount_flush');
    };
  }, [enqueueMessagesPersist]);

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
          reactions: Array.isArray((message as any).reactions) ? (message as any).reactions.map((r: any) => ({ emoji: r.emoji, userId: String(r.userId) })) : [],
          ...((message as any).replyTo && (message as any).replyTo.id ? { replyTo: { id: (message as any).replyTo.id, text: (message as any).replyTo.text, from: (message as any).replyTo.from, isOwn: (message as any).replyTo.from === currentUserId } } : {}),
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
          return updated;
        });

        // Для получателя: первый скролл часто случается до фактического layout нового пузыря.
        // Делаем принудительный post-layout double-pass, чтобы сообщение не "проваливалось" под input bar.
        if (Platform.OS === 'android' && isFromPeer) {
          requestAnimationFrame(() => {
            scrollToBottom();
            setTimeout(() => scrollToBottom(), 90);
            setTimeout(() => scrollToBottom(), 220);
          });
        }

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

    // Слушатель реакций на сообщения
    const unsubscribeReaction = onMessageReaction((data) => {
      setMessages((prev) =>
        prev.map((msg) =>
          String(msg?.id) === data.messageId ? { ...msg, reactions: data.reactions || [] } : msg
        )
      );
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
      const mid = String((data as any)?.messageId || '').trim();
      if (!mid) return;
      setMessages((prev) => {
        const updated = prev.filter((msg) => String(msg?.id || '') !== mid);
        return updated;
      });
      // cleanup local maps (prevents stale statuses for deleted ids)
      try {
        updateReadStatuses((prev) => {
          const next: any = { ...prev };
          delete next[mid];
          return next;
        });
      } catch {}
      try {
        setUploadStatus((prev) => {
          const next: any = { ...prev };
          delete next[mid];
          return next;
        });
      } catch {}
      // If user had it selected, unselect it
      try {
        setSelectedMessageIds((prev) => {
          const next = new Set(prev);
          next.delete(mid);
          return next;
        });
      } catch {}
    });

    const unsubscribeMessageEdited = onMessageEdited((data) => {
      const mid = String((data as any)?.messageId || '').trim();
      const text = typeof (data as any)?.text === 'string' ? String((data as any).text) : '';
      if (!mid) return;
      setMessages((prev) => {
        const updated = prev.map((msg) =>
          String(msg?.id || '') === mid ? { ...msg, text } : msg
        );
        return updated;
      });
    });

    return () => {
      unsubscribeReceived();
      unsubscribeReadReceipt();
      unsubscribeReaction();
      unsubscribeChatCleared();
      unsubscribeMessageDeleted();
      unsubscribeMessageEdited();
      unsubscribeDelivered();
    };
  }, [currentUserId, peerId]);

  // When app returns from background with chat open, we might have missed realtime events
  // (e.g. message deleted by peer while device was sleeping). Do a quiet sync.
  const lastQuietSyncAtRef = useRef(0);
  const quietSyncInFlightRef = useRef(false);
  const messagesLenRef = useRef(0);
  const messagesRef = useRef<any[]>([]);
  useEffect(() => {
    messagesLenRef.current = messages.length;
    messagesRef.current = messages;
  }, [messages]);
  const quietSyncChat = React.useCallback(async () => {
    try {
      if (!currentUserId || !peerId) return;
      if (quietSyncInFlightRef.current) return;
      const now = Date.now();
      if (now - lastQuietSyncAtRef.current < 1200) return; // debounce
      lastQuietSyncAtRef.current = now;
      quietSyncInFlightRef.current = true;

      // Fetch at least the amount currently shown to avoid "shrinking" message count after wake.
      // Cap requests to avoid heavy sync on wake.
      const targetCount = Math.min(400, Math.max(60, Math.max(0, messagesLenRef.current)));
      const pages: any[] = [];
      let before: string | undefined = undefined;
      for (let i = 0; i < 3 && pages.length < targetCount; i++) {
        const limit = Math.min(200, Math.max(1, targetCount - pages.length));
        const resp: any = await fetchMessages({ with: peerId, limit, ...(before ? { before } : {}) });
        if (!(resp?.ok && Array.isArray(resp.messages))) break;
        const batch = resp.messages as any[];
        if (batch.length === 0) break;
        // Prepend older pages in front
        pages.unshift(...batch);
        before = String(batch[0]?.id || '').trim() || before;
        if (!resp?.hasMore) break;
      }

      if (pages.length === 0) return;

      const formatted = pages.map((msg: any) => ({
        id: msg.id,
        text: msg.text,
        type: msg.type,
        uri: msg.uri,
        name: (msg as any).name,
        size: (msg as any).size,
        duration: (msg as any).duration,
        sender: msg.from === currentUserId ? 'me' : 'peer',
        from: msg.from,
        to: msg.to,
        timestamp: new Date(msg.timestamp),
        read: !!msg.read,
        reactions: Array.isArray((msg as any).reactions) ? (msg as any).reactions.map((r: any) => ({ emoji: r.emoji, userId: String(r.userId) })) : [],
        ...(msg.replyTo && msg.replyTo.id ? { replyTo: { id: msg.replyTo.id, text: msg.replyTo.text, from: msg.replyTo.from, isOwn: msg.replyTo.from === currentUserId } } : {}),
      }));

      const serverIdSet = new Set(formatted.map((m: any) => String(m?.id || '')));

      setMessages((prev) => {
        // Preserve local pending/failed outgoing messages (file://) that server doesn't know about yet.
        const localKeep = prev.filter((m: any) => {
          const id = String(m?.id || '');
          if (!id) return false;
          if (serverIdSet.has(id)) return false;
          const st = (uploadStatus as any)?.[id];
          if (st === 'sending' || st === 'failed') return true;
          const uri = String(m?.uri || '');
          if (String(m?.sender || '') === 'me' && /^(file|content|ph|assets-library):\/\//i.test(uri)) return true;
          return false;
        });

        // Для сообщений с сервера: если у локального есть replyTo, а у серверного нет — сохраняем локальный replyTo (гонка синка).
        const prevById = new Map(prev.map((m: any) => [String(m?.id || ''), m]));
        const merged = [...formatted.map((f: any) => {
          const local = prevById.get(String(f?.id || ''));
          if (local?.replyTo && !f.replyTo) return { ...f, replyTo: local.replyTo };
          return f;
        }), ...localKeep];
        merged.sort((a: any, b: any) => {
          const ta = +new Date(a?.timestamp || 0);
          const tb = +new Date(b?.timestamp || 0);
          return ta - tb;
        });
        return merged;
      });
    } catch {}
    finally {
      quietSyncInFlightRef.current = false;
    }
  }, [currentUserId, peerId, uploadStatus]);

  const lastAppStatePersistAtRef = useRef(0);
  useEffect(() => {
    const appStateRef = { current: AppState.currentState };
    const sub = AppState.addEventListener('change', (state) => {
      const prev = appStateRef.current;
      const wasBg = /inactive|background/.test(String(prev || ''));
      appStateRef.current = state;
      if (state === 'background' || state === 'inactive') {
        const now = Date.now();
        // Android часто шлёт inactive + background подряд — двойной setItem конкурировал с debounce и давал multi-second блокировки.
        if (now - lastAppStatePersistAtRef.current < 900) return;
        lastAppStatePersistAtRef.current = now;
        if (
          currentUserIdForPersistRef.current &&
          peerIdForPersistRef.current &&
          Array.isArray(latestMessagesForPersistRef.current)
        ) {
          enqueueMessagesPersist('appstate_background');
        }
      }
      if (wasBg && state === 'active') {
        void quietSyncChat();
      }
    });
    return () => {
      try { sub.remove(); } catch {}
    };
  }, [quietSyncChat, enqueueMessagesPersist]);

  useEffect(() => {
    const unsub = navigation?.addListener?.('focus', () => {
      // If user returns to an already-open chat via app switcher, refresh once.
      void quietSyncChat();
    });
    return () => { try { unsub?.(); } catch {} };
  }, [navigation, quietSyncChat]);

  useEffect(() => {
    readReceiptSentIdsRef.current = new Set();
  }, [peerId, currentUserId]);

  // Read receipt только для новых входящих id (не при каждом изменении списка — иначе O(N) emit'ов на каждую свою отправку).
  useEffect(() => {
    if (!peerId || !currentUserId) return;
    if (!messages.length) {
      readReceiptSentIdsRef.current.clear();
      return;
    }
    for (const m of messages) {
      if (m?.sender !== 'peer') continue;
      const id = String(m?.id || '').trim();
      if (!id || readReceiptSentIdsRef.current.has(id)) continue;
      readReceiptSentIdsRef.current.add(id);
      sendReadReceipt(id, peerId);
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

  // Тот же источник, что список друзей: последний presence-массив с сервера (в т.ч. фон у собеседника).
  useFocusEffect(
    useCallback(() => {
      if (!peerId) return;
      if (!hasVisibleOnlinePresenceSnapshot()) return;
      const isOn = isPeerInVisibleOnlinePresence(String(peerId));
      setPeerOnline(isOn);
      try {
        navigation.setParams({ peerOnline: isOn } as any);
      } catch {}
    }, [peerId, navigation]),
  );

  /** Очищаем ленту только при смене peerId (не при первом появлении currentUserId для того же чата — меньше лишних миганий). */
  const prevPeerIdForHistoryRef = useRef<string | null>(null);

  // Загрузка истории при открытии чата
  useEffect(() => {
    if (!currentUserId || !peerId) return;
    const prevPeer = prevPeerIdForHistoryRef.current;
    if (prevPeer !== peerId) {
      prevPeerIdForHistoryRef.current = peerId;
      setMessages([]);
    }

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
              duration: (msg as any).duration,
              sender: msg.from === currentUserId ? 'me' : 'peer',
              from: msg.from,
              to: msg.to,
              timestamp: new Date(msg.timestamp),
              read: !!msg.read,
              reactions: Array.isArray((msg as any).reactions) ? (msg as any).reactions.map((r: any) => ({ emoji: r.emoji, userId: String(r.userId) })) : [],
              ...((msg as any).replyTo && (msg as any).replyTo.id ? { replyTo: { id: (msg as any).replyTo.id, text: (msg as any).replyTo.text, from: (msg as any).replyTo.from, isOwn: (msg as any).replyTo.from === currentUserId } } : {}),
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

  // Догоняем сообщения с сервера после reconnect, пока чат в фокусе (закрывает окно без message:received).
  const isFocusedRef = useRef(isChatScreenFocused);
  isFocusedRef.current = isChatScreenFocused;
  const historyReadyRef = useRef(false);
  useEffect(() => {
    historyReadyRef.current = historyReady;
  }, [historyReady]);
  const peerIdRef = useRef(peerId);
  const currentUserIdRef = useRef(currentUserId);
  useEffect(() => {
    peerIdRef.current = peerId;
  }, [peerId]);
  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      if (!isFocusedRef.current || !historyReadyRef.current) return;
      const pid = peerIdRef.current;
      const uid = currentUserIdRef.current;
      if (!pid || !uid) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        if (!isFocusedRef.current || peerIdRef.current !== pid || currentUserIdRef.current !== uid) return;
        (async () => {
          try {
            const serverMessages = await fetchMessages({ with: pid, limit: 50 });
            if (!serverMessages?.ok || !Array.isArray(serverMessages.messages)) return;

            const formattedMessages = serverMessages.messages.map((msg: any) => ({
              id: msg.id,
              text: msg.text,
              type: msg.type,
              uri: msg.uri,
              name: (msg as any).name,
              size: (msg as any).size,
              duration: (msg as any).duration,
              sender: msg.from === uid ? 'me' : 'peer',
              from: msg.from,
              to: msg.to,
              timestamp: new Date(msg.timestamp),
              read: !!msg.read,
              reactions: Array.isArray((msg as any).reactions)
                ? (msg as any).reactions.map((r: any) => ({ emoji: r.emoji, userId: String(r.userId) }))
                : [],
              ...((msg as any).replyTo && (msg as any).replyTo.id
                ? {
                    replyTo: {
                      id: (msg as any).replyTo.id,
                      text: (msg as any).replyTo.text,
                      from: (msg as any).replyTo.from,
                      isOwn: (msg as any).replyTo.from === uid,
                    },
                  }
                : {}),
            }));

            setMessages((prev) => {
              const byId = new Map<string, any>();
              for (const m of prev) byId.set(String(m.id), m);
              for (const m of formattedMessages) byId.set(String(m.id), m);
              return Array.from(byId.values()).sort((a, b) => {
                const ta = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp).getTime();
                const tb = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp).getTime();
                return ta - tb;
              });
            });

            try {
              const serverStatuses: Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'> = {};
              for (const m of formattedMessages) {
                if (m.sender === 'me') serverStatuses[m.id] = m.read ? 'read' : 'sent';
              }
              if (Object.keys(serverStatuses).length) {
                setReadStatuses((prev) => ({ ...prev, ...serverStatuses }));
              }
            } catch {}

            await markMessagesAsRead(pid);
            try {
              await clearNotificationIndicators();
            } catch {}
            logger.debug('[ChatScreen] Merged messages after socket connect/reconnect', { n: formattedMessages.length, peerId: pid });
          } catch (e) {
            logger.warn('[ChatScreen] Post-reconnect message sync failed:', e);
          }
        })().catch(() => {});
      }, 650);
    };

    socket.on('connect', run);
    socket.on('reconnect', run);
    return () => {
      socket.off('connect', run);
      socket.off('reconnect', run);
      if (t) clearTimeout(t);
    };
  }, []);

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
  }, [currentUserId, peerId, resolveMediaUri, updateReadStatuses]);

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

      // 🔊 Ensure stable, loud voice playback (avoid receiver/earpiece routing and recording categories).
      // This prevents volume/route "jumping" when notifications or other OS sounds steal audio focus.
      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          allowsRecordingIOS: false,
          staysActiveInBackground: false,
          shouldDuckAndroid: false,
          playThroughEarpieceAndroid: false,
        });
      } catch {}

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
        backgroundColor: LIVI.feedBg,
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
    const mid = String(messageId || '').trim();
    if (!mid) return;

    // Server message ids look like "msg_...". Local pending/outgoing messages can have numeric ids (Date.now()).
    // In release builds users are more likely to delete messages while they are still pending.
    // For such messages we should delete locally without hitting the server.
    const isServerId = /^msg_\d+_[a-z0-9]+$/i.test(mid) || mid.startsWith('msg_');
    if (!isServerId) {
      setMessages((prev) => {
        const updated = prev.filter((msg) => String(msg?.id || '') !== mid);
        return updated;
      });
      // cleanup local status maps
      updateReadStatuses((prev) => {
        const next = { ...prev };
        delete (next as any)[mid];
        return next as any;
      });
      setUploadStatus((prev) => {
        const next = { ...prev };
        delete (next as any)[mid];
        return next as any;
      });
      showForwardToastBadge(false, t('chatDeleted', lang));
      return;
    }

    const success = await deleteMessage(mid);
    if (success) {
      setMessages((prev) => {
        const updated = prev.filter((msg) => String(msg?.id || '') !== mid);
        return updated;
      });
      // cleanup status maps (server will also emit message:deleted, but keep local maps tidy)
      updateReadStatuses((prev) => {
        const next = { ...prev };
        delete (next as any)[mid];
        return next as any;
      });
      setUploadStatus((prev) => {
        const next = { ...prev };
        delete (next as any)[mid];
        return next as any;
      });
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
      setSelectedMessageLayout(null);
      messageActionsLayoutRef.current = null;
    });
  }, [messageActionsOpacity, messageActionsTranslateY]);

  const showMessageActionsSheet = React.useCallback((
    layout?: { x: number; y: number; width: number; height: number } | null
  ) => {
    if (layout && Platform.OS === 'android') {
      messageActionsLayoutRef.current = layout;
      setSelectedMessageLayout(layout);
    }
    const open = () => {
      setShowMessageActions(true);
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
    };
    if (Platform.OS === 'android' && layout) {
      requestAnimationFrame(open);
    } else {
      open();
    }
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
    try {
      if (forwardToastTimerRef.current) {
        clearTimeout(forwardToastTimerRef.current);
        forwardToastTimerRef.current = null;
      }
    } catch {}
    setForwardToast({ visible: true, ok, text });
    forwardToastOpacity.setValue(0);
    Animated.timing(forwardToastOpacity, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
    const holdMs = text === t('chatDeleted', lang) ? 1900 : 1400;
    forwardToastTimerRef.current = setTimeout(() => {
      Animated.timing(forwardToastOpacity, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }).start(() => {
        forwardToastTimerRef.current = null;
        setForwardToast((p) => ({ ...p, visible: false }));
      });
    }, holdMs);
  }, [forwardToastOpacity, lang]);

  const openForwardPicker = React.useCallback(async () => {
    setShowForwardPicker(true);
    setForwardSelectedFriendIds(new Set());
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

  // Отправка выбранных сообщений одному получателю. Возвращает число успешно отправленных.
  const forwardToRecipient = React.useCallback(
    async (to: string): Promise<number> => {
      const normalizeForwardMediaUri = (u: string) => {
        const resolved = resolveMediaUri(u);
        if (/^file:\/\//i.test(resolved)) return '';
        return resolved;
      };

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
        if (forwardables.length === 0) return 0;
        let okCount = 0;
        for (const payload of forwardables) {
          const r: any = await sendSocketMessage({ to, ...payload });
          if (r?.ok) okCount += 1;
        }
        return okCount;
      }

      const type = String(selectedMessage?.type || '').trim();
      if (type === 'text') {
        const txt = String(selectedMessage?.text ?? '').trim();
        if (!txt) return 0;
        const r: any = await sendSocketMessage({ to, text: txt, type: 'text' });
        return r?.ok ? 1 : 0;
      }
      if (type === 'image') {
        const rawUri = String(selectedMessage?.uri ?? '').trim();
        const uri = rawUri ? normalizeForwardMediaUri(rawUri) : '';
        if (!uri) return 0;
        const r: any = await sendSocketMessage({
          to,
          type: 'image',
          uri,
          name: selectedMessage?.name,
          size: selectedMessage?.size,
        });
        return r?.ok ? 1 : 0;
      }
      if (type === 'audio') {
        const rawUri = String(selectedMessage?.uri ?? '').trim();
        const uri = rawUri ? normalizeForwardMediaUri(rawUri) : '';
        if (!uri) return 0;
        const r: any = await sendSocketMessage({
          to,
          type: 'audio',
          uri,
          name: selectedMessage?.name,
          size: selectedMessage?.size,
          duration: selectedMessage?.duration,
        });
        return r?.ok ? 1 : 0;
      }
      return 0;
    },
    [selectionMode, messages, selectedMessageIds, selectedMessage, resolveMediaUri]
  );

  const forwardToSelectedFriends = React.useCallback(async () => {
    const ids = Array.from(forwardSelectedFriendIds);
    if (ids.length === 0) return;
    const friends = forwardFriends.filter((f) => ids.includes(String(f?._id || '')));
    if (friends.length === 0) return;

    const normalizeForwardMediaUri = (u: string) => {
      const resolved = resolveMediaUri(u);
      if (/^file:\/\//i.test(resolved)) return '';
      return resolved;
    };

    // Проверка «есть что пересылать» один раз (для режима выбора и одного сообщения)
    if (selectionMode) {
      const selected = messages.filter((m) => selectedMessageIds.has(String(m?.id || '')));
      let hasAny = false;
      for (const m of selected) {
        const type = String(m?.type || '').trim();
        if (type === 'text' && String(m?.text || '').trim()) hasAny = true;
        else if (type === 'image' && normalizeForwardMediaUri(String(m?.uri || ''))) hasAny = true;
        else if (type === 'audio' && normalizeForwardMediaUri(String(m?.uri || ''))) hasAny = true;
        if (hasAny) break;
      }
      if (!hasAny) {
        setNoticeKind('info');
        setNoticeTitle(t('chatForwardTitle', lang));
        setNoticeMessage(t('chatForwardNoSuitable', lang));
        setNoticeVisible(true);
        return;
      }
    } else if (selectedMessage) {
      const type = String(selectedMessage?.type || '').trim();
      if (type === 'text' && !String(selectedMessage?.text ?? '').trim()) return;
      if (type === 'image' && !normalizeForwardMediaUri(String(selectedMessage?.uri ?? ''))) return;
      if (type === 'audio' && !normalizeForwardMediaUri(String(selectedMessage?.uri ?? ''))) return;
    }

    let totalOk = 0;
    try {
      for (const f of friends) {
        const to = String(f?._id || '').trim();
        if (!to) continue;
        totalOk += await forwardToRecipient(to);
      }
    } finally {
      setShowForwardPicker(false);
      hideMessageActions();
      setForwardSelectedFriendIds(new Set());
      if (selectionMode) {
        setSelectionMode(false);
        setSelectedMessageIds(new Set());
      }
      showForwardToastBadge(totalOk > 0, totalOk > 0 ? t('chatSent', lang) : t('chatSendFailed', lang));
    }
  }, [
    forwardSelectedFriendIds,
    forwardFriends,
    selectionMode,
    messages,
    selectedMessageIds,
    selectedMessage,
    forwardToRecipient,
    hideMessageActions,
    showForwardToastBadge,
    resolveMediaUri,
    lang,
  ]);

  // Переслать в системные приложения (WhatsApp, Telegram, Instagram и др.)
  const shareForwardToSystem = React.useCallback(async () => {
    const normalizeUri = (u: string) => {
      const resolved = resolveMediaUri(u);
      if (/^file:\/\//i.test(resolved)) return '';
      return resolved;
    };
    let shareText = '';
    let shareUrl: string | undefined;
    if (selectionMode) {
      const selected = messages.filter((m) => selectedMessageIds.has(String(m?.id || '')));
      const parts: string[] = [];
      for (const m of selected) {
        const type = String(m?.type || '').trim();
        if (type === 'text') parts.push(String(m?.text ?? '').trim());
        else if (type === 'image') parts.push(t('mediaPhotoLabel', lang));
        else if (type === 'audio') parts.push(`🎤 ${t('chatVoiceMessage', lang)}`);
      }
      shareText = parts.filter(Boolean).join('\n');
      const firstMedia = selected.find((m) => String(m?.type || '').trim() !== 'text');
      if (firstMedia?.uri) shareUrl = normalizeUri(String(firstMedia.uri));
    } else if (selectedMessage) {
      const type = String(selectedMessage?.type || '').trim();
      if (type === 'text') shareText = String(selectedMessage?.text ?? '').trim();
      else if (type === 'image') {
        shareText = t('mediaPhotoLabel', lang);
        const raw = String(selectedMessage?.uri ?? '').trim();
        if (raw) shareUrl = normalizeUri(raw);
      } else if (type === 'audio') {
        shareText = `🎤 ${t('chatVoiceMessage', lang)}`;
        const raw = String(selectedMessage?.uri ?? '').trim();
        if (raw) shareUrl = normalizeUri(raw);
      }
    }
    if (!shareText && !shareUrl) return;
    try {
      await Share.share({
        message: shareText || (shareUrl || ''),
        url: shareUrl && /^https?:\/\//i.test(shareUrl) ? shareUrl : undefined,
        title: t('chatActionForward', lang),
      });
    } catch (_) {}
  }, [selectionMode, messages, selectedMessageIds, selectedMessage, resolveMediaUri, lang]);

  const forwardSelectedMessageTo = React.useCallback(
    async (friend: any) => {
      const to = String(friend?._id || '').trim();
      if (!to) return;
      const count = await forwardToRecipient(to);
      setShowForwardPicker(false);
      hideMessageActions();
      if (selectionMode) {
        setSelectionMode(false);
        setSelectedMessageIds(new Set());
      }
      showForwardToastBadge(count > 0, count > 0 ? t('chatSent', lang) : t('chatSendFailed', lang));
    },
    [forwardToRecipient, hideMessageActions, showForwardToastBadge, selectionMode, lang]
  );

  const exitSelectionMode = React.useCallback(() => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, []);

  // На Android: системная кнопка «Назад» — шаг назад (закрыть чат или выйти из режима выбора), а не на страницу приветствия
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectionMode) {
        exitSelectionMode();
        return true;
      }
      if (navigation?.goBack) {
        navigation.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [selectionMode, exitSelectionMode, navigation]);

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

      const idxInMessages = messages.findIndex((m: any) => String(m?.id) === id);
      if (idxInMessages < 0) {
        showNotice('info', 'LiVi', t('chatReplyOriginalNotFound', lang));
        return;
      }

      const index =
        Platform.OS === 'android' && messages.length > 0
          ? Math.max(0, messages.length - 1 - idxInMessages)
          : idxInMessages;

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
    const ids = messages.map((m) => String(m?.id || '')).filter(Boolean);
    const allSelected = ids.length > 0 && ids.every((id) => selectedMessageIds.has(id));
    if (allSelected) {
      setSelectedMessageIds(new Set());
    } else {
      setSelectedMessageIds(new Set(ids));
    }
  }, [messages, selectedMessageIds]);

  const batchDeleteSelected = React.useCallback(async () => {
    const ids = Array.from(selectedMessageIds);
    if (ids.length === 0) return;

    const idSet = new Set(ids.map((x) => String(x)));

    const isServerId = (id: string) => /^msg_\d+_[a-z0-9]+$/i.test(id) || id.startsWith('msg_');
    const serverIds = ids.map(String).filter((id) => isServerId(String(id)));
    const localOnlyIds = ids.map(String).filter((id) => !isServerId(String(id)));

    // Optimistic UI: remove all selected messages at once (no sequential "one-by-one" deletion).
    // Keep a snapshot of removed messages so we can restore only the ones that actually failed.
    const removedById = new Map<string, any>();
    try {
      const snap = Array.isArray(messagesRef.current) ? messagesRef.current : [];
      for (const mm of snap) {
        const mid = String(mm?.id || '').trim();
        if (mid && idSet.has(mid)) removedById.set(mid, mm);
      }
    } catch {}
    setMessages((prev) => {
      const next: any[] = [];
      for (const mm of prev) {
        const mid = String(mm?.id || '').trim();
        if (mid && idSet.has(mid)) {
          if (!removedById.has(mid)) removedById.set(mid, mm);
        } else {
          next.push(mm);
        }
      }
      return next;
    });

    // IMPORTANT: delete requests sequentially (emitAck/socket acks are not guaranteed to be concurrency-safe).
    // UI is already updated optimistically above, so user still sees "all deleted at once".
    const failedServer: string[] = [];
    for (const id of serverIds) {
      try {
        const mid = String(id);
        const ok = await deleteMessage(mid);
        if (!ok) failedServer.push(mid);
      } catch {
        failedServer.push(String(id));
      }
    }

    // local-only deletions are always considered successful (client-side only)
    const successServerIds = serverIds.filter((id) => !failedServer.includes(String(id)));

    // cleanup status maps for successful deletions (both server + local-only)
    const deletedOk = new Set<string>([...localOnlyIds, ...successServerIds].map(String));
    if (deletedOk.size > 0) {
      updateReadStatuses((prev) => {
        const next: any = { ...prev };
        for (const id of deletedOk) delete next[id];
        return next;
      });
      setUploadStatus((prev) => {
        const next: any = { ...prev };
        for (const id of deletedOk) delete next[id];
        return next;
      });
    }

    if (failedServer.length === 0) {
      exitSelectionMode();
      showForwardToastBadge(false, t('chatDeleted', lang));
      return;
    }

    // Restore ONLY failed server items (keep successful deletions applied).
    // Also preserve any new messages that might have arrived while we were deleting.
    const failedSet = new Set(failedServer.map(String));
    setMessages((prev) => {
      const toRestore: any[] = [];
      for (const id of failedSet) {
        const mm = removedById.get(String(id));
        if (mm) toRestore.push(mm);
      }
      const merged = [...prev, ...toRestore];
      merged.sort((a: any, b: any) => {
        const ta = +new Date(a?.timestamp || 0);
        const tb = +new Date(b?.timestamp || 0);
        return ta - tb;
      });
      return merged;
    });

    // Оставляем выделенными только те, что не удалились (можно повторить)
    setSelectedMessageIds(new Set(failedServer));
    showNotice(
      'error',
      t('errorTitle', lang),
      t('chatDeleteFailedCount', lang).replace('{count}', String(failedServer.length))
    );
  }, [
    selectedMessageIds,
    exitSelectionMode,
    showForwardToastBadge,
    showNotice,
    lang,
    deleteMessage,
    updateReadStatuses,
    setUploadStatus,
  ]);

  const confirmDeleteSelected = React.useCallback(() => {
    if (selectedCount === 0) return;
    openConfirm({
      title: t('chatDeleteMessagesTitle', lang),
      message: selectedCount === 1
        ? t('chatDeleteSelectedOne', lang)
        : t('chatDeleteSelectedMany', lang).replace('{count}', String(selectedCount)),
      okText: t('delete', lang),
      cancelText: t('cancelAction', lang),
      destructive: true,
      onConfirm: () => {
        void batchDeleteSelected();
      },
    });
  }, [selectedCount, openConfirm, batchDeleteSelected, lang]);

  const startForwardSelected = React.useCallback(() => {
    if (selectedCount === 0) return;
    if (!selectedHasAnyForwardable) {
      showNotice('info', t('chatForwardTitle', lang), t('chatForwardOnlySupported', lang));
      return;
    }
    void openForwardPicker();
  }, [selectedCount, selectedHasAnyForwardable, showNotice, openForwardPicker, lang]);

  // КРИТИЧНО: Header нельзя объявлять как "компонент-функцию" (const Header = () => ...)
  // и потом рендерить как <Header />, иначе при изменении зависимостей React будет считать,
  // что "тип компонента" поменялся → размонтирует/смонтирует заново (и аватар начнёт мерцать).
  // Поэтому делаем мемоизированный JSX-элемент.
  const headerEl = React.useMemo(() => (
    <View
      style={{
        paddingTop: headerTopPadding,
        height: headerH + headerTopPadding,
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
          try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch { Vibration.vibrate(10); }
          if (selectionMode) exitSelectionMode();
          else navigation.goBack();
        }}
        activeOpacity={0.5}
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
        <Text style={{
          color: LIVI.titan,
          fontSize: 18,
          fontWeight: "700",
        }}>
          {selectionMode ? t('chatSelectedCount', lang).replace('{count}', String(selectedCount)) : peerNameState}
        </Text>
        {!selectionMode && (
          <Text style={{
              marginTop: 2,
              fontSize: 11,
              color: peerOnline ? LIVI.presenceGreen : LIVI.presenceRed,
              fontWeight: '300',
              ...(Platform.OS === 'android' && { fontFamily: 'sans-serif-light' }),
            }}>
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
            <Text style={{ color: LIVI.titan, fontSize: 13, fontWeight: '600' }}>{t('chatSelectAll', lang)}</Text>
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
        <TouchableOpacity onPress={openAvatarModal} activeOpacity={0.8}>
          <AvatarImage
            userId={peerId}
            avatarVer={peerAvatarVerState}
            uri={fullAvatarUri || undefined}
            size={36}
            fallbackText={headerInitial}
            fallbackTextStyle={{ color: LIVI.titan }}
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
        </TouchableOpacity>
      )}
    </View>
  ), [
    headerH,
    headerTopPadding,
    LIVI.bg,
    LIVI.white,
    LIVI.titan,
    LIVI.presenceGreen,
    LIVI.presenceRed,
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
    openAvatarModal,
    selectionMode,
    selectedCount,
    exitSelectionMode,
    selectAllLoaded,
    startForwardSelected,
    confirmDeleteSelected,
  ]);

  // Stable handler to avoid re-rendering all MessageItem rows on parent re-renders
  const handleLongPressMessage = React.useCallback(
    (m: any, layout?: { x: number; y: number; width: number; height: number }) => {
      setSelectedMessage(m);
      if (!layout && Platform.OS === 'android') {
        messageActionsLayoutRef.current = null;
      }

      const isOwn = m?.from === currentUserId || m?.sender === 'me';
      const isText = String(m?.type || '') === 'text';
      const showEdit = isOwn && isText;

      const actionIds = ['copy', 'forward', 'select', 'reply', ...(showEdit ? (['edit'] as const) : []), 'delete', 'cancel'] as const;
      const options = [
        t('chatActionCopy', lang),
        t('chatActionForward', lang),
        t('chatActionSelect', lang),
        t('chatActionReply', lang),
        ...(showEdit ? [t('chatActionEdit', lang)] : []),
        t('delete', lang),
        t('cancelAction', lang),
      ];

      const cancelButtonIndex = actionIds.length - 1;
      const destructiveButtonIndex = actionIds.indexOf('delete');

      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options,
            cancelButtonIndex,
            destructiveButtonIndex,
            userInterfaceStyle: 'dark',
          },
          (buttonIndex) => {
            const action = actionIds[buttonIndex] || 'cancel';
            if (action === 'cancel') return;
            if (action === 'reply') {
              setEditingMessageId(null);
              setMessageText('');
              setReplyingToMessage({
                id: String(m?.id ?? ''),
                text: String(m?.text ?? m?.name ?? ''),
                from: m?.from,
                isOwn: isOwn,
              });
              return;
            }
            if (action === 'edit') {
              setMessageText(String(m?.text ?? ''));
              setEditingMessageId(m?.id ?? null);
              setReplyingToMessage(null);
              return;
            }
            if (action === 'delete') return confirmDeleteSelectedMessage(m);
            if (action === 'copy') return void copySelectedMessage(m);
            if (action === 'forward') return void openForwardPicker();
            if (action === 'select') return void enterSelectionModeFromMessage(m);
          }
        );
        return;
      }

      // Android: передаём layout при открытии и откладываем показ на следующий кадр
      showMessageActionsSheet(layout ?? null);
    },
    [currentUserId, confirmDeleteSelectedMessage, copySelectedMessage, openForwardPicker, showMessageActionsSheet, lang]
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

      if (Platform.OS === 'ios') {
        try {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } catch {
          Vibration.vibrate(3);
        }
      } else {
        Vibration.vibrate(25);
      }

      // Long press: меню сразу после системного long-press, без ожидания scale-анимации (+200ms)
      if (options?.immediate) {
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

  const sendMessage = async () => {
    if (!messageText.trim() || !currentUserId) return;

    // Редактирование существующего сообщения
    if (editingMessageId) {
      const newText = messageText.trim();
      setMessageText('');
      setEditingMessageId(null);
      const result = await editMessage(editingMessageId, newText);
      if (result.ok) {
        setMessages((prev) => {
          const updated = prev.map((m) =>
            m.id === editingMessageId ? { ...m, text: newText } : m
          );
          return updated;
        });
      } else {
        setMessageText(newText);
        setEditingMessageId(editingMessageId);
      }
      return;
    }

    if (textSendGuardRef.current) return;
    textSendGuardRef.current = true;
    setTimeout(() => {
      textSendGuardRef.current = false;
    }, 200);

    const messageToSend = messageText.trim();
    const replyTo = replyingToMessage ? { id: replyingToMessage.id, text: replyingToMessage.text, from: replyingToMessage.from, isOwn: replyingToMessage.isOwn } : undefined;
    setMessageText(""); // Очищаем поле сразу
    setReplyingToMessage(null);
    // Если отправили сообщение — прекращаем "typing"
    stopLocalTyping();
    
    // Добавляем сообщение локально
    const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const newMessage = {
      id: messageId,
      text: messageToSend,
      sender: 'me',
      from: currentUserId,
      to: peerId,
      timestamp: new Date(),
      type: 'text',
      ...(replyTo ? { replyTo } : {}),
    };
    
    setMessages((prev) => {
      const updatedMessages = [...prev, newMessage];
      return updatedMessages;
    });
    
    // Статус "отправляется" (пока нет птичек)
    updateReadStatuses(prev => ({ ...prev, [messageId]: 'sending' }));
    
    // Сеть в фоне — UI не ждёт ack (избегаем «зависания» и лишних повторных нажатий)
    void (async () => {
      try {
        const result = await sendSocketMessage({
          to: peerId,
          text: messageToSend,
          type: 'text',
          ...(replyTo
            ? {
                replyTo: {
                  id: replyTo.id,
                  text: replyTo.text,
                  from: replyTo.from ?? '',
                  isOwn: replyTo.isOwn,
                },
              }
            : {}),
        });
        
        if (result.ok) {
          clearMessageCache(peerId, currentUserId);

          const deliveryStatus = result.delivered ? 'delivered' : 'sent';

          updateReadStatuses(prev => ({
            ...prev,
            [messageId]: deliveryStatus
          }));

          if (result.messageId) {
            if (result.messageId !== messageId) {
              setMessages(prev => {
                const updated = prev.map(msg => 
                  msg.id === messageId 
                    ? { ...msg, id: result.messageId!, from: currentUserId, to: peerId }
                    : msg
                );
                return updated;
              });
              
              updateReadStatuses(prev => {
                const newStatuses = { ...prev };
                newStatuses[result.messageId!] = deliveryStatus;
                delete newStatuses[messageId];
                return newStatuses;
              });
            } else {
              updateReadStatuses(prev => ({
                ...prev,
                [messageId]: deliveryStatus
              }));
            }
          } else {
            updateReadStatuses(prev => ({
              ...prev,
              [messageId]: deliveryStatus
            }));
          }
        } else {
          throw new Error((result as any).error || 'Failed to send message');
        }
        
      } catch (e) {
        console.error('❌ Failed to send via socket:', e);
        updateReadStatuses(prev => ({
          ...prev,
          [messageId]: 'failed'
        }));
        setUploadStatus(prev => ({ ...prev, [messageId]: 'failed' }));
      }
    })();
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
  }, [currentUserId, peerId, resolveMediaUri, updateReadStatuses]);

  const startVoiceRecording = React.useCallback(async () => {
    try {
      if (voiceIsRecording) return;
      if (!currentUserId || !peerId) return;
      if (selectionMode) return; // avoid accidental recording in select mode
      resetVoiceGesture();

      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        // If we already signaled recording on press-in, stop it on permission denial.
        try { stopLocalRecordingSignal(); } catch {}
        showNotice('error', t('errorTitle', lang), t('needMicPermission', lang));
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
      try { stopLocalRecordingSignal(); } catch {}
    }
  }, [voiceIsRecording, currentUserId, peerId, selectionMode, resetVoiceGesture, showNotice, lang, stopLocalRecordingSignal]);

  const stopVoiceRecording = React.useCallback(async (cancelled?: boolean, autoStopped?: boolean) => {
    if (voiceStopInProgressRef.current) return;
    const rec = voiceRecordingRef.current;
    if (!rec) return;

    voiceStopInProgressRef.current = true;
    voiceRecordingRef.current = null;
    setVoiceIsRecording(false);
    // Stop recording indicator for peer immediately on release/cancel
    try { stopLocalRecordingSignal(); } catch {}

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
          playsInSilentModeIOS: true,
          // Back to normal playback mode after recording (prevents voice playback going through earpiece).
          allowsRecordingIOS: false,
          staysActiveInBackground: false,
          shouldDuckAndroid: false,
          playThroughEarpieceAndroid: false,
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
    showForwardToastBadge(false, t('chatDeleted', lang));
  }, [trashLid, trashFlash, voiceDragX, stopVoiceRecording, showForwardToastBadge, lang]);

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
        // IMPORTANT: show "Записывает..." to peer immediately on press-in.
        // This avoids a 3-5s delay on Android while permissions/audio mode/recorder are initializing.
        try {
          if (!voiceIsRecording && currentUserId && peerId && !selectionMode) {
            startLocalRecordingSignal();
          }
        } catch {}
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
  }, [currentUserId, peerId, updateReadStatuses, resolveMediaUri]);

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
  const MessageItem = React.useMemo(() => React.memo(({ item, currentUserId, readStatus, uploadStatus, onPressImage, onPressAudio, playingAudioId, playingAudioState, onLongPressMessage, onMessagePress, onReactionPress, selectionMode, isSelected, onToggleSelect, retryUiForId, onToggleRetryUi, onRetryFailed, resolveMediaUri, peerDisplayName, highlightedMessageId, onPressReplyQuote }: any) => {
    const bubbleRef = React.useRef<View>(null);
    const [imageLoadError, setImageLoadError] = React.useState(false);
    const [localImageUri, setLocalImageUri] = React.useState<string | null>(null);
    const [isDownloading, setIsDownloading] = React.useState(false);
    const imageUriForItem = item.type === 'image' ? (resolveMediaUri(item.uri) || '') : '';
    const [messageImageResolvedUri] = useResolvedImageUri(
      Platform.OS === 'android' && imageUriForItem && /^data:/i.test(imageUriForItem) ? imageUriForItem : ''
    );
    const fireLongPressWithLayout = React.useCallback(() => {
      const measure = () => {
        bubbleRef.current?.measureInWindow((x, y, w, h) => {
          onLongPressMessage(item, { x, y, width: w, height: h });
        });
      };
      if (Platform.OS === 'android') {
        requestAnimationFrame(measure);
      } else {
        measure();
      }
    }, [item, onLongPressMessage]);
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
                <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, marginTop: 4 }}>
                  {t('chatImageUnavailable', lang)}
                </Text>
              </View>
            );
          }
          const displayImageUri = (Platform.OS === 'android' && /^data:/i.test(imageUri)) ? messageImageResolvedUri : imageUri;
          
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
                delayLongPress={400}
                onLongPress={() => {
                  animateMessagePress(item.id, fireLongPressWithLayout, { immediate: true });
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
              delayLongPress={400}
              onLongPress={() => {
                animateMessagePress(item.id, fireLongPressWithLayout, { immediate: true });
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
                source={{ uri: localImageUri || displayImageUri }}
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

          const voiceRingSize = 42;
          const voiceRingCx = voiceRingSize / 2;
          const voiceRingR = 19;
          const voiceRingCirc = 2 * Math.PI * voiceRingR;
          const voiceDurMs =
            isPlaying && playingAudioState?.id === String(item.id || '')
              ? Math.max(0, Number(playingAudioState.durationMs || 0))
              : 0;
          const voicePosMs =
            isPlaying && playingAudioState?.id === String(item.id || '')
              ? Math.max(0, Number(playingAudioState.positionMs || 0))
              : 0;
          const voiceProgress =
            isPlaying && voiceDurMs > 0 ? Math.min(1, voicePosMs / voiceDurMs) : 0;
          const voiceGradId = `voicePearl-${String(item.id || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;

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
                  width: voiceRingSize,
                  height: voiceRingSize,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Svg
                  width={voiceRingSize}
                  height={voiceRingSize}
                  style={{ position: 'absolute' }}
                  pointerEvents="none"
                >
                  <Defs>
                    <LinearGradient id={voiceGradId} x1="0%" y1="0%" x2="100%" y2="100%">
                      <Stop offset="0%" stopColor={isDark ? '#C8FFF4' : '#EDE4FF'} stopOpacity={1} />
                      <Stop offset={isDark ? '45%' : '40%'} stopColor={isDark ? '#5ED4C8' : '#A894D8'} stopOpacity={1} />
                      <Stop offset="100%" stopColor={isDark ? '#A8E8E0' : '#D4C4F0'} stopOpacity={1} />
                    </LinearGradient>
                  </Defs>
                  <SvgCircle
                    cx={voiceRingCx}
                    cy={voiceRingCx}
                    r={voiceRingR}
                    fill="none"
                    stroke={isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)'}
                    strokeWidth={2.5}
                  />
                  {isPlaying ? (
                    <G rotation="-90" origin={`${voiceRingCx}, ${voiceRingCx}`}>
                      <SvgCircle
                        cx={voiceRingCx}
                        cy={voiceRingCx}
                        r={voiceRingR}
                        fill="none"
                        stroke={`url(#${voiceGradId})`}
                        strokeWidth={2.5}
                        strokeLinecap="round"
                        strokeDasharray={`${voiceRingCirc} ${voiceRingCirc}`}
                        strokeDashoffset={voiceRingCirc * (1 - voiceProgress)}
                      />
                    </G>
                  ) : null}
                </Svg>
                <Pressable
                  onPress={() => {
                    try { onPressAudio?.(item); } catch {}
                  }}
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
                </Pressable>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: LIVI.white, fontSize: 14, fontWeight: '600' }}>{t('chatVoiceMessage', lang)}</Text>
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
                  <Text style={{ color: '#FF5A67', fontSize: 12, fontWeight: '700' }}>{t('retry', lang)}</Text>
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
    const isQuotedTargetHighlighted =
      highlightedMessageId != null && String(highlightedMessageId) === String(item.id);

    const replyQuoteAccent = LIVI.replyQuoteAccent;
    const replyQuotePressBg = LIVI.replyQuotePressBg;
    const replyQuoteBarWidth = Platform.OS === 'ios' ? 1 : 2;
    const highlightAccentColor = LIVI.replyHighlightAccent;
    /** Android: borderWidth+radius даёт тонкие углы — делаем ровное «кольцо» через padding */
    const androidHighlightRing = isQuotedTargetHighlighted && Platform.OS === 'android';
    const ANDROID_RING_PX = 1;
    const BUBBLE_RADIUS = 16;

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

        <View ref={bubbleRef} style={{ alignSelf: isMyMessage ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
          {(() => {
            const bubbleFill = isMyMessage ? BUBBLE_BG_OUT : BUBBLE_BG_IN;
            const bubbleInner = (
              <>
          {/* Цитата ответа — вне TouchableOpacity, чтобы тап вёл к исходному сообщению */}
          {item.replyTo && (
            <Pressable
              disabled={!!selectionMode}
              onPress={() => onPressReplyQuote?.(String(item.replyTo.id))}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'flex-start',
                marginBottom: 8,
                paddingLeft: 8,
                paddingVertical: 4,
                marginHorizontal: -4,
                marginTop: -2,
                borderRadius: 8,
                borderLeftWidth: replyQuoteBarWidth,
                borderLeftColor: replyQuoteAccent,
                opacity: selectionMode ? 0.5 : pressed ? 0.85 : 1,
                backgroundColor: pressed && !selectionMode ? replyQuotePressBg : 'transparent',
              })}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: replyQuoteAccent, fontSize: 12, fontWeight: '600', marginBottom: 2 }}>
                  {item.replyTo.isOwn ? t('you', lang) : (peerDisplayName || '—')}
                </Text>
                <Text style={{ color: LIVI.white, fontSize: 13, opacity: 0.85 }} numberOfLines={2}>
                  {item.replyTo.text || '—'}
                </Text>
              </View>
            </Pressable>
          )}
          <TouchableOpacity
            onPress={() => {
              if (canToggle) {
                onToggleSelect?.(String(item.id));
                return;
              }
              if (String(item?.type || '') === 'audio') {
                onMessagePress?.(item);
                return;
              }
              onMessagePress?.(item);
            }}
            delayLongPress={400}
            onLongPress={() => {
              animateMessagePress(item.id, fireLongPressWithLayout, { immediate: true });
            }}
            activeOpacity={0.7}
            style={{ maxWidth: '100%' }}
          >
          {/* Основной контент */}
          {renderContent()}
          
          {/* Текст сообщения (если есть), ссылки кликабельны */}
          {item.type === 'text' && (() => {
            const baseStyle = {
              color: LIVI.white,
              fontSize: 16,
              marginBottom: 3,
              lineHeight: 22,
              fontWeight: '400' as const,
            };
            const linkStyle = {
              ...baseStyle,
              color: '#7eb8ff',
              textDecorationLine: 'underline' as const,
            };
            const segments = parseTextWithUrls(String(item.text ?? ''));
            return (
              <Text style={baseStyle}>
                {segments.map((seg, idx) =>
                  seg.type === 'url' ? (
                    <Text
                      key={idx}
                      onPress={() => openMessageUrl(seg.value)}
                      style={linkStyle}
                    >
                      {seg.value}
                    </Text>
                  ) : (
                    <Text key={idx}>{seg.value}</Text>
                  )
                )}
              </Text>
            );
          })()}
          
          {/* Нижняя строка: реакции слева, время + статус справа (всё внутри облака) */}
          {(() => {
            const reactions = Array.isArray(item.reactions) ? item.reactions : [];
            const hasReactions = reactions.length > 0;
            const byEmoji: Record<string, number> = {};
            if (hasReactions) {
              reactions.forEach((r: { emoji: string }) => {
                byEmoji[r.emoji] = (byEmoji[r.emoji] || 0) + 1;
              });
            }
            const list = hasReactions ? Object.entries(byEmoji).map(([emoji, count]) => ({ emoji, count })) : [];
            return (
              <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: hasReactions ? 'flex-end' : 'flex-end',
                marginTop: item.type !== 'text' ? 4 : 1,
              }}>
                {hasReactions ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0, marginRight: 10 }}>
                    {list.map(({ emoji, count }, idx) => (
                      <Pressable
                        key={emoji}
                        onPress={() => onReactionPress?.(item.id, emoji)}
                        style={({ pressed }) => [
                          {
                            flexDirection: 'row',
                            alignItems: 'center',
                            backgroundColor: 'transparent',
                            borderRadius: 12,
                            paddingHorizontal: 8,
                            paddingVertical: 4,
                            opacity: pressed ? 0.85 : 1,
                            transform: [{ scale: pressed ? 0.92 : 1 }],
                          },
                          idx > 0 ? { marginLeft: 4 } : {},
                        ]}
                      >
                        <Text style={{ fontSize: 14 }}>{emoji}</Text>
                        {count > 1 && (
                          <Text style={{ fontSize: 11, color: LIVI.text, marginLeft: 2, opacity: 0.9 }}>{count}</Text>
                        )}
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0 }}>
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
              </View>
            );
          })()}
          </TouchableOpacity>
              </>
            );
            if (androidHighlightRing) {
              return (
                <View
                  style={{
                    borderRadius: BUBBLE_RADIUS + ANDROID_RING_PX,
                    padding: ANDROID_RING_PX,
                    backgroundColor: highlightAccentColor,
                    maxWidth: '100%',
                    elevation: 0,
                  }}
                >
                  {/*
                    Облака полупрозрачные — без подложки сквозь них просвечивает цвет кольца.
                    Непрозрачный фон списка сообщений, поверх — как обычно bubbleFill.
                  */}
                  <View
                    style={{
                      borderRadius: BUBBLE_RADIUS,
                      backgroundColor: LIVI.feedBg,
                      overflow: 'hidden',
                      maxWidth: '100%',
                    }}
                  >
                    <View
                      style={{
                        padding: 12,
                        backgroundColor: bubbleFill,
                        maxWidth: '100%',
                      }}
                    >
                      {bubbleInner}
                    </View>
                  </View>
                </View>
              );
            }
            return (
              <View
                style={{
                  padding: 12,
                  backgroundColor: bubbleFill,
                  borderRadius: BUBBLE_RADIUS,
                  borderWidth: 1,
                  borderColor: isQuotedTargetHighlighted ? highlightAccentColor : BORDER_COLOR,
                  maxWidth: '100%',
                }}
              >
                {bubbleInner}
              </View>
            );
          })()}
        </View>

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
    LIVI.feedBg,
    LIVI.replyQuoteAccent,
    LIVI.replyQuotePressBg,
    LIVI.replyHighlightAccent,
    isDark,
  ]);

  // КРИТИЧНО: на каждый ввод нельзя пересоздавать массив data для FlatList,
  // иначе он будет перерисовывать (а иногда и переразмещать) все элементы -> мерцание изображений.
  const androidMessagesData = React.useMemo(() => {
    if (isEmpty) return [];
    // reverse создаёт новый массив, поэтому мемоизируем
    return [...messages].reverse();
  }, [isEmpty, messages]);

  const handleToggleRetryUi = React.useCallback((id: string) => {
    setRetryUiForId((prev) => (prev === id ? null : id));
  }, []);

  const handleRootLayout = React.useCallback((e: any) => {
    const h = Math.max(0, Math.round(Number(e?.nativeEvent?.layout?.height || 0)));
    if (!h) return;
    if (Platform.OS === 'android') {
      if (!keyboardVisible) {
        baseRootLayoutHRef.current = h;
      }
      return;
    }
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

  const androidListHeader = React.useMemo(() => {
    if (isEmpty) return null;
    return (
      <View
        style={{
          // Spacer so the last message doesn't hide under the input bar (and the keyboard on devices without resize).
          height: Math.max(inputHeight, estimatedInputHeight) + TYPING_GAP_H + keyboardLift,
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
    );
  }, [isEmpty, inputHeight, estimatedInputHeight, keyboardLift, GapCenterIndicator]);

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
      onToggleRetryUi={handleToggleRetryUi}
      onRetryFailed={retryFailedOutgoingMessage}
      onLongPressMessage={handleLongPressMessage}
      onMessagePress={handleMessagePress}
      onReactionPress={handleReactionPress}
      selectionMode={selectionMode}
      isSelected={selectedMessageIds.has(String(item.id))}
      onToggleSelect={toggleSelectMessage}
      resolveMediaUri={resolveMediaUri}
      peerDisplayName={peerNameState}
      highlightedMessageId={highlightedMessageId}
      onPressReplyQuote={scrollToQuotedMessage}
    />
  ), [MessageItem, currentUserId, readStatuses, uploadStatus, openMediaViewer, togglePlayAudioMessage, playingAudioId, playingAudioState, retryUiForId, handleToggleRetryUi, retryFailedOutgoingMessage, handleLongPressMessage, handleMessagePress, handleReactionPress, selectionMode, selectedMessageIds, toggleSelectMessage, resolveMediaUri, peerNameState, highlightedMessageId, scrollToQuotedMessage]);

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
        style={{ flex: 1, backgroundColor: LIVI.feedBg }}
        // Prevent touch-through during modal close animations (can trigger header back -> Home -> Chat flicker)
        pointerEvents={mediaViewerVisible || composeViewerVisible || avatarModalVisible ? 'none' : 'auto'}
        onLayout={handleRootLayout}
      >
        {headerEl}
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
              onScrollToIndexFailed={handleScrollToIndexFailed}
              onContentSizeChange={() => setTimeout(() => scrollToBottom(), 0)}
              ListEmptyComponent={() => {
                if (!historyReady) {
                  return (
                    <View
                      style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        backgroundColor: LIVI.feedBg,
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
                      backgroundColor: LIVI.feedBg,
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
            {DeleteToastInline ? (
              <View pointerEvents="none" style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 8 }}>
                {DeleteToastInline}
              </View>
            ) : null}
            {/* Поле ввода для iOS */}
            <View
              style={{
                borderTopWidth: BORDER_WIDTH,
                borderTopColor: BORDER_COLOR,
                backgroundColor: INPUT_BAR_BG,
                paddingHorizontal: 16,
                paddingTop: 18,
                // Важно: симметричные отступы сверху/снизу вокруг инпута
                // SafeAreaView уже обрабатывает safe area, поэтому не добавляем insets.bottom
                paddingBottom: 18,
              }}
              onLayout={handleInputBarLayout}
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
                    <Text style={{ color: LIVI.white, fontSize: 14, opacity: 0.9 }} numberOfLines={2}>
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

                <View style={{ flex: 1, justifyContent: 'center' }}>
                  <TextInput
                    style={{
                      flex: 1,
                      color: voiceIsRecording ? 'transparent' : LIVI.white,
                      fontSize: 16,
                      maxHeight: 100,
                    }}
                    placeholder={t('chatMessagePlaceholder', lang)}
                    placeholderTextColor={voiceIsRecording ? 'transparent' : LIVI.titan}
                    value={messageText}
                    onChangeText={(txt) => {
                      setMessageText(txt);
                      signalLocalTyping();
                    }}
                    multiline
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
              removeClippedSubviews={false}
              inverted={!showEmpty}
              onScrollToIndexFailed={handleScrollToIndexFailed}
              ListHeaderComponent={androidListHeader}
              ListEmptyComponent={() => {
                if (!historyReady) {
                  return (
                    <View
                      style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        backgroundColor: LIVI.feedBg,
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
                      backgroundColor: LIVI.feedBg,
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
            {DeleteToastInline ? (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: keyboardLift + (inputHeight > 0 ? inputHeight : 96) + 8,
                  alignItems: 'center',
                }}
              >
                {DeleteToastInline}
              </View>
            ) : null}

            {/* Поле ввода для Android: поднимаем над клавиатурой, если система не ресайзит окно */}
            <View
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: keyboardLift,
                borderTopWidth: BORDER_WIDTH,
                borderTopColor: BORDER_COLOR,
                backgroundColor: INPUT_BAR_BG,
                paddingHorizontal: 16,
                paddingTop: 18,
                // Когда клавиатура открыта — панель должна "стыковаться" с клавиатурой без зазора.
                // Когда клавиатура скрыта — добавляем safe-area снизу, чтобы не упираться в навигацию.
                paddingBottom: 18 + (keyboardVisible ? 0 : Math.max(0, insets.bottom)),
              }}
              onLayout={handleInputBarLayout}
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
                    <Text style={{ color: LIVI.white, fontSize: 14, opacity: 0.9 }} numberOfLines={2}>
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

                <View style={{ flex: 1, justifyContent: 'center' }}>
                  <TextInput
                    style={{ flex: 1, color: voiceIsRecording ? 'transparent' : LIVI.white, fontSize: 16, maxHeight: 100 }}
                    placeholder={t('chatMessagePlaceholder', lang)}
                    placeholderTextColor={voiceIsRecording ? 'transparent' : LIVI.titan}
                    value={messageText}
                    onChangeText={(txt) => {
                      setMessageText(txt);
                      signalLocalTyping();
                    }}
                    multiline
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
                    {(String(selectedMessage?.text || '').trim() || String(selectedMessage?.uri || '').trim()) && (
                      <>
                        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: dividerColor }} />
                        <Pressable
                          onPress={() => { hideMessageActions(); void copySelectedMessage(selectedMessage); }}
                          style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            paddingVertical: 12,
                            paddingHorizontal: 14,
                            backgroundColor: pressed ? (isDark ? 'rgba(123,97,255,0.12)' : 'rgba(123,97,255,0.10)') : 'transparent',
                          })}
                        >
                          <Text style={{ color: LIVI.white, fontSize: 15, fontWeight: '400' }}>{t('chatActionCopy', lang)}</Text>
                          <Ionicons name="copy-outline" size={20} color={LIVI.titan} />
                        </Pressable>
                        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: dividerColor }} />
                        <Pressable
                          onPress={() => { hideMessageActions(); void openForwardPicker(); }}
                          style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            paddingVertical: 12,
                            paddingHorizontal: 14,
                            backgroundColor: pressed ? (isDark ? 'rgba(123,97,255,0.12)' : 'rgba(123,97,255,0.10)') : 'transparent',
                          })}
                        >
                          <Text style={{ color: LIVI.white, fontSize: 15, fontWeight: '400' }}>{t('chatActionForward', lang)}</Text>
                          <Ionicons name="paper-plane-outline" size={20} color={LIVI.titan} />
                        </Pressable>
                        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: dividerColor }} />
                        <Pressable
                          onPress={() => { hideMessageActions(); enterSelectionModeFromMessage(selectedMessage); }}
                          style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            paddingVertical: 12,
                            paddingHorizontal: 14,
                            backgroundColor: pressed ? (isDark ? 'rgba(123,97,255,0.12)' : 'rgba(123,97,255,0.10)') : 'transparent',
                          })}
                        >
                          <Text style={{ color: LIVI.white, fontSize: 15, fontWeight: '400' }}>{t('chatActionSelect', lang)}</Text>
                          <Ionicons name="checkbox-outline" size={20} color={LIVI.titan} />
                        </Pressable>
                        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: dividerColor }} />
                        <Pressable
                          onPress={() => {
                            hideMessageActions();
                            setEditingMessageId(null);
                            setMessageText('');
                            setReplyingToMessage({
                              id: String(selectedMessage?.id ?? ''),
                              text: String(selectedMessage?.text ?? selectedMessage?.name ?? ''),
                              from: selectedMessage?.from,
                              isOwn: selectedMessage?.from === currentUserId || selectedMessage?.sender === 'me',
                            });
                          }}
                          style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            paddingVertical: 12,
                            paddingHorizontal: 14,
                            backgroundColor: pressed ? (isDark ? 'rgba(123,97,255,0.12)' : 'rgba(123,97,255,0.10)') : 'transparent',
                          })}
                        >
                          <Text style={{ color: LIVI.white, fontSize: 15, fontWeight: '400' }}>{t('chatActionReply', lang)}</Text>
                          <Ionicons name="arrow-undo-outline" size={20} color={LIVI.titan} />
                        </Pressable>
                        {(selectedMessage?.from === currentUserId || selectedMessage?.sender === 'me') && String(selectedMessage?.type || '') === 'text' && (
                          <>
                            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: dividerColor }} />
                            <Pressable
                              onPress={() => {
                                hideMessageActions();
                                setMessageText(String(selectedMessage?.text ?? ''));
                                setEditingMessageId(selectedMessage?.id ?? null);
                                setReplyingToMessage(null);
                              }}
                              style={({ pressed }) => ({
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                paddingVertical: 12,
                                paddingHorizontal: 14,
                                backgroundColor: pressed ? (isDark ? 'rgba(123,97,255,0.12)' : 'rgba(123,97,255,0.10)') : 'transparent',
                              })}
                            >
                              <Text style={{ color: LIVI.white, fontSize: 15, fontWeight: '400' }}>{t('chatActionEdit', lang)}</Text>
                              <Ionicons name="pencil-outline" size={20} color={LIVI.titan} />
                            </Pressable>
                          </>
                        )}
                        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: dividerColor }} />
                      </>
                    )}
                    <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: dividerColor }} />
                    <Pressable
                      onPress={() => { hideMessageActions(); confirmDeleteSelectedMessage(selectedMessage); }}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingVertical: 12,
                        paddingHorizontal: 14,
                        backgroundColor: pressed ? 'rgba(255,90,103,0.08)' : 'transparent',
                      })}
                    >
                      <Text style={{ color: '#FF5A67', fontSize: 15, fontWeight: '400' }}>{t('delete', lang)}</Text>
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
          <GestureHandlerRootView style={{ flex: 1 }}>
          <Pressable
            onPress={() => setShowForwardPicker(false)}
            style={{ flex: 1, backgroundColor: isDark ? 'rgba(0,0,0,0.50)' : 'rgba(0,0,0,0.40)', justifyContent: 'flex-end' }}
          >
          <PanGestureHandler
            activeOffsetY={[0, 8]}
            onGestureEvent={onForwardSheetGestureEvent}
            onHandlerStateChange={onForwardSheetHandlerStateChange}
          >
            <Animated.View
              style={{
                transform: [{ translateY: forwardSheetTranslateY }],
                maxHeight: '70%',
              }}
            >
            <Pressable
              onPress={() => {}}
              style={{
                backgroundColor: isDark ? '#0F1626' : 'rgba(182, 203, 216, 1)',
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                paddingTop: 8,
                paddingHorizontal: 14,
                paddingBottom: ANDROID_SHEET_BOTTOM_PAD,
              }}
            >
              <View
                style={{ width: '100%', alignItems: 'center', paddingTop: 4, paddingBottom: 12, minHeight: 40 }}
                pointerEvents="box-only"
              >
                <View
                  style={{
                    width: 42,
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.18)',
                  }}
                />
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10, paddingHorizontal: 8, position: 'relative' }}>
                <View style={{ position: 'absolute', left: 0, right: 0, alignItems: 'center', pointerEvents: 'none' }}>
                  <Text style={{ color: LIVI.white, fontSize: 16, fontWeight: '700' }}>
                    {`${t('chatActionForward', lang)}…`}
                  </Text>
                </View>
                <View style={{ flex: 1 }} />
                <Pressable
                  onPress={() => void shareForwardToSystem()}
                  style={({ pressed }) => ({
                    width: 44,
                    height: 44,
                    marginRight: -10,
                    borderRadius: 22,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: pressed ? (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)') : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'),
                  })}
                  hitSlop={8}
                >
                  <Ionicons name="share-outline" size={22} color={LIVI.titan} />
                </Pressable>
              </View>

              {forwardLoading ? (
                <View style={{ paddingVertical: 18, alignItems: 'center' }}>
                  <ActivityIndicator />
                </View>
              ) : (
                <FlatList
                  data={forwardFriends}
                  keyExtractor={(it: any) => String(it?._id || Math.random())}
                  showsVerticalScrollIndicator={false}
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
                          backgroundColor: pressed
                            ? isDark
                              ? 'rgba(123,97,255,0.10)'
                              : 'rgba(123,97,255,0.08)'
                            : isSelected
                              ? isDark
                                ? 'rgba(123,97,255,0.12)'
                                : 'rgba(123,97,255,0.10)'
                              : 'transparent',
                        })}
                      >
                        <AvatarImage
                          userId={friendId}
                          avatarVer={Number(item.avatarVer || 0)}
                          uri={item.avatarThumbB64 || undefined}
                          size={44}
                          fallbackText={String((item.nick || '--').trim()?.[0] || '--').toUpperCase()}
                          containerStyle={{
                            borderWidth: 1,
                            borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)',
                            overflow: 'hidden',
                            ...(isDark ? {} : { backgroundColor: 'rgba(0,0,0,0.08)' }),
                          }}
                          fallbackTextStyle={isDark ? { color: LIVI.white, fontSize: 16 } : { color: 'rgba(0,0,0,0.45)', fontSize: 16 }}
                        />
                        <View style={{ marginLeft: 12, flex: 1, justifyContent: 'center' }}>
                          <Text style={{ color: isDark ? LIVI.white : LIVI.text, fontSize: 16, fontWeight: '600' }}>
                            {(item.nick && String(item.nick).trim()) || '—'}
                          </Text>
                        </View>
                        <Ionicons
                          name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                          size={24}
                          color={isSelected ? '#7B61FF' : LIVI.titan}
                        />
                      </Pressable>
                    );
                  }}
                  ItemSeparatorComponent={() => (
                    <View style={{ height: 1, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }} />
                  )}
                  ListEmptyComponent={() => (
                    <View style={{ paddingVertical: 18, alignItems: 'center' }}>
                      <Text style={{ color: LIVI.titan, textAlign: 'center' }}>{t('chatForwardNoFriends', lang)}</Text>
                    </View>
                  )}
                />
              )}

              <View style={{ height: 10 }} />
              <TouchableOpacity
                onPress={() => void forwardToSelectedFriends()}
                disabled={forwardSelectedFriendIds.size === 0}
                style={{
                  paddingVertical: 14,
                  backgroundColor:
                    forwardSelectedFriendIds.size > 0
                      ? isDark
                        ? 'rgba(113,91,168,0.1)'
                        : 'rgba(79, 195, 247, 0.15)'
                      : 'transparent',
                  borderWidth: forwardSelectedFriendIds.size > 0 ? StyleSheet.hairlineWidth : 1,
                  borderColor:
                    forwardSelectedFriendIds.size > 0
                      ? isDark
                        ? '#715BA8'
                        : '#4FC3F7'
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
                        ? isDark
                          ? '#B8A9E8'
                          : '#4FC3F7'
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
            </Pressable>
            </Animated.View>
          </PanGestureHandler>
          </Pressable>
          </GestureHandlerRootView>
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
                {t('chatDeleteMessageTitle', lang)}
              </Text>
              <Text style={{ marginTop: 8, color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)', fontSize: 14, lineHeight: 18 }}>
                {t('chatActionCannotUndo', lang)}
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