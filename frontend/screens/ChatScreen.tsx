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
  PanResponder,
  Vibration,
  NativeModules,
  Dimensions,
  Image,
  StyleSheet,
  Share,
} from "react-native";
 
import { useSafeAreaInsets, SafeAreaView } from "react-native-safe-area-context";
import {
  PanGestureHandler,
  PinchGestureHandler,
  State,
  GestureHandlerRootView,
  NativeViewGestureHandler,
  FlatList as GHFlatList,
} from "react-native-gesture-handler";
import { onCloseIncoming, emitCloseIncoming, onCometChatStatus } from '../utils/globalEvents';
import { displayAvatarLetter } from './home/friendHelpers';
import socket from '../sockets/socket';
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../theme/ThemeProvider";
import { uiAccent } from "../theme/uiAccent";
import {
  COMPOSER_HIT_ATTACH,
  COMPOSER_HIT_SEND,
  FRIEND_ACTION_BUTTON,
  FRIEND_ACTION_ICON_SIZE,
} from "../constants/uiTokens";
import { Image as ExpoImage } from "expo-image";
import AvatarImage from "../components/AvatarImage";
import ChatStyleBackButton from "../components/ChatStyleBackButton";
import ChatEmojiKeyboard, { CHAT_EMOJI_PANEL_HEIGHT } from "../components/ChatEmojiKeyboard";
import {
  getStickerFallbackText,
  type BuiltInSticker,
} from "../components/chatStickers";
import type { EmojiType } from "rn-emoji-keyboard";
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
import { CHAT_ALBUM_MAX, getMessageImageUris, isImageAlbumMessage, albumSelectionKey, parseAlbumSelectionKey, albumSelectionKeysForMessage, selectedAlbumIndices } from './chat/chatAlbum';
import { ChatAlbumPickModal } from './chat/ChatAlbumPickModal';
import { saveImageToGallery } from '../utils/saveToGallery';
import { prefetchImages } from '../utils/imageOptimization';

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
import * as FileSystem from 'expo-file-system';
import { CometChat } from "@cometchat/chat-sdk-react-native";
import { 
  getMyUserId,
  sendMessage as sendSocketMessage,
  onMessageUrisUpdated,
  updateMessageUris,
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
  getChatMessagesLocal,
  clearMessageCache,
  clearChatMessages,
  onChatCleared,
  deleteMessage,
  deleteMessages,
  editMessage,
  onMessageDeleted,
  onMessagesDeleted,
  onMessageEdited,
  globalMessageStorage,
  fetchMessages,
  removeQueuedMessagesMatching,
  removeQueuedEditsMatching,
  onOutboxMessageDelivered,
  fetchFriends,
  getAvatar,
  sendChatViewing,
  ensureGloballyDeletedMessageIdsLoaded,
  isGloballyDeletedMessageId,
} from "../sockets/socket";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLang } from "../store/lang";
import { t, type Lang } from "../utils/i18n";
import { setCurrentChatPeerId, dismissMessageNotificationForUser, syncAppBadgeFromMissedCount } from "../utils/pushNotifications";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import type { IncomingShareItem } from '../utils/incomingShare';
import { getInstallId } from '../utils/installId';

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

/** Стабильное имя файла в cacheDirectory для кэша голосового по удалённому URL. */
function voiceCacheFileNameForRemoteUrl(remoteUri: string): string {
  let h = 0;
  for (let i = 0; i < remoteUri.length; i++) {
    h = (Math.imul(31, h) + remoteUri.charCodeAt(i)) | 0;
  }
  return `livi_voice_${(h >>> 0).toString(16)}_${remoteUri.length}.m4a`;
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
const CHAT_LIST_INITIAL_NUM_TO_RENDER = 12;
const CHAT_LIST_MAX_TO_RENDER_PER_BATCH = 8;
const CHAT_LIST_WINDOW_SIZE = 7;
const CHAT_LIST_UPDATE_CELLS_BATCHING_PERIOD = 50;

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

function isServerMessageId(messageId: string): boolean {
  const id = String(messageId || '').trim();
  return !!id && !isOfflineQueuedOrOptimisticOutgoingId(id);
}

/** Id может быть на сервере (в т.ч. clientMessageId вида 1734…-abc) — только outbox_* ещё не отправлен. */
function isDeletableOnServerMessageId(messageId: string): boolean {
  const id = String(messageId || '').trim();
  if (!id) return false;
  return !id.startsWith('outbox_');
}

/** Совпадение исходящего текста ± время — убрать дубликат outbox/optimistic, когда сервер уже отдал msg_*. */
function approxSameOutgoingTextMessage(a: any, b: any): boolean {
  if (String(a?.sender || '') !== 'me' || String(b?.sender || '') !== 'me') return false;
  const t1 = String(a?.text ?? '').trim();
  const t2 = String(b?.text ?? '').trim();
  if (!t1 || t1 !== t2) return false;
  const ty1 = String(a?.type || 'text');
  const ty2 = String(b?.type || 'text');
  if (ty1 !== 'text' || ty2 !== 'text') return false;
  const dt = Math.abs(+new Date(a?.timestamp || 0) - +new Date(b?.timestamp || 0));
  return dt < 180_000;
}

function mergeChatReadStatuses(
  localStatuses: Record<string, ChatReadStatus> = {},
  serverStatuses: Record<string, ChatReadStatus> = {},
): Record<string, ChatReadStatus> {
  const rank: Record<ChatReadStatus, number> = {
    failed: 0,
    sending: 1,
    sent: 2,
    delivered: 3,
    read: 4,
  };
  const next: Record<string, ChatReadStatus> = { ...localStatuses };
  for (const [id, serverStatus] of Object.entries(serverStatuses)) {
    const localStatus = next[id];
    next[id] =
      localStatus && rank[localStatus] > rank[serverStatus]
        ? localStatus
        : serverStatus;
  }
  return next;
}

/** Удалить сообщение и «близнеца» outbox/optimistic с тем же текстом (чтобы не остался второй пузырь). */
function filterRemoveMessageAndOutgoingDupes(prev: any[], deletedId: string): any[] {
  const victim = prev.find((m) => String(m?.id || '') === deletedId);
  return prev.filter((msg) => {
    const id = String(msg?.id || '');
    if (id === deletedId) return false;
    if (
      victim &&
      String(victim?.sender || '') === 'me' &&
      String(msg?.sender || '') === 'me' &&
      isOfflineQueuedOrOptimisticOutgoingId(id) &&
      approxSameOutgoingTextMessage(msg, victim)
    ) {
      return false;
    }
    return true;
  });
}

/** Снять с ленты id с сервера и связанные outbox/optimistic (по тексту и local→server map). */
function removeMessagesForDeletedIds(
  prev: any[],
  rawIds: readonly string[],
  localToServer?: ReadonlyMap<string, string>,
): any[] {
  const deletedSet = new Set(
    (rawIds || []).map((id) => String(id || '').trim()).filter(Boolean),
  );
  if (deletedSet.size === 0) return prev;

  const aliasIds = new Set<string>();
  if (localToServer) {
    for (const sid of deletedSet) {
      for (const [local, server] of localToServer.entries()) {
        if (server === sid) aliasIds.add(local);
      }
    }
  }

  let next = prev;
  for (const id of deletedSet) {
    next = filterRemoveMessageAndOutgoingDupes(next, id);
  }
  for (const aid of aliasIds) {
    next = filterRemoveMessageAndOutgoingDupes(next, aid);
  }

  return next.filter((msg) => {
    const id = String(msg?.id || '').trim();
    if (!id) return true;
    if (deletedSet.has(id) || aliasIds.has(id)) return false;
    const mapped = localToServer?.get(id);
    if (mapped && deletedSet.has(mapped)) return false;
    return true;
  });
}

/** Перед delete «для обоих»: outbox_* → server id из ленты или из map после доставки. */
function resolveServerMessageIdForDelete(
  messageId: string,
  messages: any[],
  localToServer: ReadonlyMap<string, string>,
): string {
  const id = String(messageId || '').trim();
  if (!id) return '';
  if (isDeletableOnServerMessageId(id)) return id;

  const mapped = localToServer.get(id);
  if (mapped && isDeletableOnServerMessageId(mapped)) return mapped;

  const victim = messages.find((m) => String(m?.id || '').trim() === id);
  if (!victim) return id;

  for (const m of messages) {
    const mid = String(m?.id || '').trim();
    if (!mid || mid === id) continue;
    if (String(m?.sender || '') !== 'me') continue;
    if (!isDeletableOnServerMessageId(mid)) continue;
    if (approxSameOutgoingTextMessage(m, victim)) return mid;
  }
  return id;
}

function isHardDeleteBatchError(error: unknown): boolean {
  const e = String(error || '').trim();
  return e === 'network' || e === 'server_error' || e === 'unauthorized';
}

type ChatListRow =
  | { type: 'date'; id: string; label: string }
  | ({ type: 'message' } & Record<string, any>);

function localDayKey(ts: Date): string {
  return `${ts.getFullYear()}-${ts.getMonth() + 1}-${ts.getDate()}`;
}

/** Подпись дня в ленте: DD.MM.YYYY */
function formatChatDateSeparator(ts: Date): string {
  const day = ts.getDate().toString().padStart(2, '0');
  const month = (ts.getMonth() + 1).toString().padStart(2, '0');
  return `${day}.${month}.${ts.getFullYear()}`;
}

function buildChatListRows(messages: any[]): ChatListRow[] {
  const rows: ChatListRow[] = [];
  let lastDayKey: string | null = null;
  for (const m of messages) {
    const raw = m?.timestamp;
    const ts = raw instanceof Date ? raw : new Date(raw || 0);
    if (Number.isNaN(ts.getTime())) {
      rows.push({ type: 'message', ...m });
      continue;
    }
    const dk = localDayKey(ts);
    if (dk !== lastDayKey) {
      rows.push({ type: 'date', id: `date-${dk}`, label: formatChatDateSeparator(ts) });
      lastDayKey = dk;
    }
    rows.push({ type: 'message', ...m });
  }
  return rows;
}

function stickerFieldsFromMessage(msg: any) {
  return {
    stickerId: msg?.stickerId,
    stickerPackId: msg?.stickerPackId,
    stickerEmoji: msg?.stickerEmoji,
    stickerLabel: msg?.stickerLabel,
  };
}

function albumUrisFieldFromMessage(msg: any): { uris?: string[] } {
  const uris = Array.isArray(msg?.uris)
    ? msg.uris.map((u: any) => String(u || '').trim()).filter(Boolean).slice(0, CHAT_ALBUM_MAX)
    : [];
  return uris.length > 1 ? { uris } : {};
}

function getChatReplyPreviewText(message: any, langCode: string): string {
  if (String(message?.type || '') === 'sticker') {
    return getStickerFallbackText(
      {
        id: message?.stickerId,
        packId: message?.stickerPackId,
        emoji: message?.stickerEmoji,
        label: message?.stickerLabel,
      },
      langCode,
    );
  }
  if (String(message?.type || '') === 'image') {
    const n = getMessageImageUris(message).length;
    if (n > 1) return t('chatAlbumPhotos', langCode as Lang).replace('{count}', String(n));
    return t('mediaPhotoLabel', langCode as Lang);
  }
  return String(message?.text ?? message?.name ?? '');
}

function indexInChatListData(data: ChatListRow[], messageId: string): number {
  const id = String(messageId || '').trim();
  return data.findIndex((row) => row.type === 'message' && String((row as any).id) === id);
}

/** Animated "..." for peer typing/recording — isolated so ChatScreen doesn't re-render every ~420ms (send taps were dropped). */
function ChatPeerActivityLabel({
  peerActivity,
  lang,
  isDark,
}: {
  peerActivity: 'typing' | 'recording';
  lang: Lang;
  isDark: boolean;
}) {
  const [dots, setDots] = useState(1);
  useEffect(() => {
    setDots(1);
    const id = setInterval(() => {
      setDots((prev) => (prev % 3) + 1);
    }, 420);
    return () => clearInterval(id);
  }, [peerActivity]);

  const baseStyle = {
    fontSize: 13,
    fontStyle: 'italic' as const,
    fontWeight: '500' as const,
    letterSpacing: 0.2,
  };
  const text =
    peerActivity === 'recording'
      ? `${t('chatRecording', lang)}${'.'.repeat(dots)}`
      : `${t('chatTyping', lang)}${'.'.repeat(dots)}`;
  const color = isDark ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.40)';

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Text style={{ ...baseStyle, color }}>{text}</Text>
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
    accent: uiAccent(isDark),
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

  const [conversation, setConversation] =
    useState<CometChat.Conversation | null>(null);
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
  // Кастомное подтверждение удаления сообщения (вместо системного Alert)
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleteForBoth, setDeleteForBoth] = useState(true);
  const [deleteConfirmKind, setDeleteConfirmKind] = useState<'single' | 'multi'>('single');
  const pendingDeleteRef = useRef<any>(null);
  const batchDeleteSelectedRef = useRef<((forBoth: boolean, idsOverride?: string[]) => Promise<void>) | null>(null);
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
  const composerTextInputMaxHeight = 76;
  // Android: до первого onLayout нужен реалистичный размер нижней панели,
  // иначе входящее сообщение может стартово оказаться под инпутом.
  const estimatedInputHeight = 124 + Math.max(0, insets.bottom);
  const [inputHeight, setInputHeight] = useState(estimatedInputHeight);
  const [messageText, setMessageText] = useState("");
  const messageTextRef = useRef("");
  messageTextRef.current = messageText;
  const [emojiPanelOpen, setEmojiPanelOpen] = useState(false);
  const [peerActivity, setPeerActivity] = useState<'typing' | 'recording' | null>(null);
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
  const [albumScopeVisible, setAlbumScopeVisible] = useState(false);
  const [albumScopeKind, setAlbumScopeKind] = useState<'save' | 'forward' | 'delete'>('delete');
  const [albumPickUris, setAlbumPickUris] = useState<string[]>([]);
  const [albumPickInitial, setAlbumPickInitial] = useState<number[]>([0]);
  const albumScopeMessageRef = useRef<any>(null);
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
  const forwardPickerSheetMaxH = React.useMemo(() => {
    const h = Dimensions.get('window').height;
    return Math.min(Math.round(h * 0.72), Math.round(h - insets.top - 12));
  }, [insets.top, showForwardPicker]);

  /** Высота шита по числу друзей; список внутри — flex + скролл без конфликта с Pan. */
  const forwardPickerLayout = React.useMemo(() => {
    const maxSheet = forwardPickerSheetMaxH;
    const padBottom = ANDROID_SHEET_BOTTOM_PAD;
    const padTop = 30;
    const headerAndSep = 86;
    const footerBlock = 140;
    const maxList = Math.max(110, maxSheet - padTop - padBottom - headerAndSep - footerBlock);
    const rowApprox = 62;
    const listPadding = 16;
    let listNeed: number;
    if (forwardLoading) {
      listNeed = Math.min(168, maxList);
    } else if (forwardFriends.length === 0) {
      listNeed = Math.min(96, maxList);
    } else {
      const contentH = forwardFriends.length * rowApprox + listPadding;
      listNeed = Math.min(Math.max(contentH, 72), maxList);
    }
    const sheetHeight = Math.min(maxSheet, padTop + headerAndSep + listNeed + footerBlock + padBottom);
    return { sheetHeight };
  }, [
    forwardPickerSheetMaxH,
    forwardLoading,
    forwardFriends.length,
    ANDROID_SHEET_BOTTOM_PAD,
  ]);

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
  /** Сразу true в onPanResponderGrant — жест «к мусорке» работает до setState(voiceIsRecording). */
  const voiceDragEnabledRef = useRef(false);
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
  /** Инкремент при новом запуске воспроизведения — отмена устаревшего createAsync при быстром переключении */
  const audioPlayGenerationRef = useRef(0);
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  /** Удалённый resolveMediaUri(uri) → локальный file:// после downloadAsync — быстрый старт play */
  const voiceAudioCacheRef = useRef<Map<string, string>>(new Map());
  const voiceAudioDownloadRef = useRef<Map<string, Promise<string>>>(new Map());

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
  const incomingShareHandledRef = useRef<string>('');

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

  const composerBottomLift = emojiPanelOpen ? CHAT_EMOJI_PANEL_HEIGHT : keyboardLift;

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

        setPeerActivity((prev) => (prev === next ? prev : next));

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
        {peerTyping || peerRecording ? (
          <ChatPeerActivityLabel
            peerActivity={peerRecording ? 'recording' : 'typing'}
            lang={lang}
            isDark={isDark}
          />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ ...baseStyle, color }}>
              {String(forwardToast.text || t('chatSent', lang))}
            </Text>
          </View>
        )}
      </Animated.View>
    );
  }, [peerActivity, isDark, forwardToast.visible, forwardToast.text, forwardToast.ok, forwardToastOpacity, lang]);

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

  const getMediaOutboxKey = (userId: string, peerId: string) => {
    const sortedIds = [userId, peerId].sort();
    return `chat_media_outbox_${sortedIds[0]}_${sortedIds[1]}`;
  };

  const getHiddenForMeKey = (userId: string, peerId: string) => {
    const sortedIds = [userId, peerId].sort();
    return `chat_hidden_message_ids_${sortedIds[0]}_${sortedIds[1]}`;
  };

  const loadHiddenForMeMessageIds = React.useCallback(async (uid: string, pid: string): Promise<Set<string>> => {
    try {
      const raw = await AsyncStorage.getItem(getHiddenForMeKey(uid, pid));
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
      const key = getHiddenForMeKey(uid, pid);
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
      // Читаем id из ref: эффект reconnect подписан с deps [] и иначе мог бы сохранять статусы под устаревшими peer/user.
      const uid = String(currentUserIdForPersistRef.current || '').trim();
      const pid = String(peerIdForPersistRef.current || '').trim();
      if (!uid || !pid) return;
      const key = getStatusesKey(uid, pid);
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
      const key = getStatusesKey(uid, pid);
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
  useEffect(() => {
    if (!currentUserId) return;


    // Слушатель входящих сообщений
    const unsubscribeReceived = onMessageReceived((message) => {
      const senderId = message.from;
      const isFromMe = senderId === currentUserId;
      const isFromPeer = senderId === peerId;

      if (isFromPeer || isFromMe) {
        // Очищаем кэш при получении нового сообщения
        clearMessageCache(peerId, currentUserId || undefined);
        
        
        
        const newMessage = {
          id: message.id,
          text: message.text,
          type: message.type,
          uri: message.uri,
          uris: Array.isArray((message as any).uris) && (message as any).uris.length > 1
            ? (message as any).uris.map((u: any) => String(u || '').trim()).filter(Boolean).slice(0, CHAT_ALBUM_MAX)
            : undefined,
          name: (message as any).name,
          size: (message as any).size,
          duration: (message as any).duration,
          ...stickerFieldsFromMessage(message),
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
            urisCount: getMessageImageUris(newMessage).length,
            resolvedUri: resolveMediaUri(message.uri),
            hasUri: !!message.uri,
          });
        }

        const existedBeforeLiveReceive = isFromPeer
          ? latestMessagesForPersistRef.current.some((msg: any) => String(msg?.id || '') === String(newMessage.id || ''))
          : false;

        setMessages((prev) => {
          // Проверяем, есть ли уже сообщение с таким ID
          const existingMessage = prev.find(msg => msg.id === newMessage.id);
          if (existingMessage) {
            return prev;
          }
          
          const updated = [...prev, newMessage];
          return updated;
        });

        const chatIsActiveForRead =
          isFocusedRef.current && AppState.currentState === 'active';

        if (isFromPeer && !existedBeforeLiveReceive && chatIsActiveForRead) {
          const id = String(newMessage.id || '').trim();
          if (id && !readReceiptSentIdsRef.current.has(id)) {
            readReceiptSentIdsRef.current.add(id);
            sendReadReceipt(id, peerId);
          }
        }

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

        // Отмечаем прочитанным только если чат реально открыт (экран в фокусе). Иначе при возврате на «Друзья»
        // ChatScreen остаётся в стеке и гасит unread на Home сразу после появления бейджа.
        if (isFromPeer && chatIsActiveForRead) {
          setTimeout(() => {
            if (!isFocusedRef.current || AppState.currentState !== 'active') return;
            markMessagesAsRead(senderId);
            try {
              void dismissMessageNotificationForUser(senderId);
              void syncAppBadgeFromMissedCount();
            } catch {}
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
        clearMessageCache(peerId, currentUserId || undefined);
        // Очищаем AsyncStorage
        const chatKey = globalMessageStorage.getChatKey(currentUserId, peerId);
        AsyncStorage.removeItem(chatKey);
      } else {
      }
    });

    // Слушатель удаления сообщений.
    // Коротко буферизуем входящие delete-события, чтобы массовое удаление у собеседника
    // визуально схлопывалось одной пачкой, а не по одному сообщению.
    const pendingDeletedIds = new Set<string>();
    let pendingDeletedTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPendingDeleted = () => {
      if (pendingDeletedIds.size === 0) return;
      const deletedIds = new Set(Array.from(pendingDeletedIds));
      pendingDeletedIds.clear();
      pendingDeletedTimer = null;
      for (const id of deletedIds) rememberDeletedServerMessageId(String(id));
      clearMessageCache(peerId, currentUserId || undefined);
      setMessages((prev) => {
        const next = removeMessagesForDeletedIds(
          prev,
          Array.from(deletedIds),
          outboxLocalIdToServerIdRef.current,
        );
        latestMessagesForPersistRef.current = next;
        queueMicrotask(() => enqueueMessagesPersist('delete_event_messages'));
        return next;
      });
      try {
        updateReadStatuses((prev) => {
          const next: any = { ...prev };
          for (const id of deletedIds) delete next[id];
          return next;
        });
      } catch {}
      try {
        setUploadStatus((prev) => {
          const next: any = { ...prev };
          for (const id of deletedIds) delete next[id];
          return next;
        });
      } catch {}
      try {
        setSelectedMessageIds((prev) => {
          const next = new Set(prev);
          for (const id of deletedIds) next.delete(id);
          return next;
        });
      } catch {}
    };
    const applyDeletedIds = (ids: string[]) => {
      const deletedIds = new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean));
      if (deletedIds.size === 0) return;
      for (const id of deletedIds) rememberDeletedServerMessageId(String(id));
      clearMessageCache(peerId, currentUserId || undefined);
      setMessages((prev) => {
        const next = removeMessagesForDeletedIds(
          prev,
          Array.from(deletedIds),
          outboxLocalIdToServerIdRef.current,
        );
        latestMessagesForPersistRef.current = next;
        queueMicrotask(() => enqueueMessagesPersist('delete_event_messages'));
        return next;
      });
      try {
        updateReadStatuses((prev) => {
          const next: any = { ...prev };
          for (const id of deletedIds) delete next[id];
          return next;
        });
      } catch {}
      try {
        setUploadStatus((prev) => {
          const next: any = { ...prev };
          for (const id of deletedIds) delete next[id];
          return next;
        });
      } catch {}
      try {
        setSelectedMessageIds((prev) => {
          const next = new Set(prev);
          for (const id of deletedIds) next.delete(id);
          return next;
        });
      } catch {}
    };
    const unsubscribeMessageDeleted = onMessageDeleted((data) => {
      const mid = String((data as any)?.messageId || '').trim();
      if (!mid) return;
      rememberDeletedServerMessageId(mid);
      pendingDeletedIds.add(mid);
      if (pendingDeletedTimer) clearTimeout(pendingDeletedTimer);
      pendingDeletedTimer = setTimeout(flushPendingDeleted, 120);
    });
    const unsubscribeMessagesDeleted = onMessagesDeleted((data) => {
      if (pendingDeletedTimer) {
        clearTimeout(pendingDeletedTimer);
        pendingDeletedTimer = null;
      }
      pendingDeletedIds.clear();
      applyDeletedIds(Array.isArray((data as any)?.messageIds) ? (data as any).messageIds : []);
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

    const unsubscribeMessageUrisUpdated = onMessageUrisUpdated((data) => {
      const mid = String((data as any)?.messageId || '').trim();
      if (!mid) return;
      if ((data as any)?.deleted) {
        setMessages((prev) => prev.filter((msg) => String(msg?.id || '') !== mid));
        return;
      }
      const nextUris = Array.isArray((data as any)?.uris)
        ? (data as any).uris.map((u: any) => String(u || '').trim()).filter(Boolean).slice(0, CHAT_ALBUM_MAX)
        : [];
      const primary = String((data as any)?.uri || nextUris[0] || '').trim();
      setMessages((prev) =>
        prev.map((msg) => {
          if (String(msg?.id || '') !== mid) return msg;
          return {
            ...msg,
            uri: primary || msg.uri,
            uris: nextUris.length > 1 ? nextUris : undefined,
          };
        }),
      );
    });

    const unsubscribeOutboxDelivered = onOutboxMessageDelivered((ev) => {
      if (String(ev.to || '') !== peerId) return;
      const serverMessageId = String(ev.serverMessageId || '').trim();
      if (!serverMessageId) return;
      const olds = new Set(
        [ev.outboxId, ev.optimisticUiId].map((x) => String(x || '').trim()).filter(Boolean),
      );
      if (olds.size === 0) return;
      for (const oid of olds) rememberOutboxLocalToServerId(oid, serverMessageId);

      if (deletedServerMessageIdsRef.current.has(serverMessageId)) {
        clearMessageCache(peerId, currentUserId || undefined);
        setMessages((prev) => prev.filter((msg) => !olds.has(String(msg?.id || ''))));
        updateReadStatuses((prev) => {
          const next: any = { ...prev };
          for (const oid of olds) delete next[oid];
          delete next[serverMessageId];
          return next;
        });
        return;
      }

      clearMessageCache(peerId, currentUserId || undefined);
      setMessages((prev) => {
        let changed = false;
        const mapped = prev.map((msg) => {
          const id = String(msg?.id || '');
          if (!olds.has(id)) return msg;
          changed = true;
          return { ...msg, id: serverMessageId, from: currentUserId, to: peerId };
        });
        if (!changed) return prev;
        const seen = new Set<string>();
        return mapped.filter((msg) => {
          const id = String(msg?.id || '');
          if (!id) return true;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      });
      updateReadStatuses((prev) => {
        const next: any = { ...prev };
        let st = next[serverMessageId] || 'sent';
        for (const oid of olds) {
          const v = next[oid];
          if (v === 'delivered') st = 'delivered';
        }
        for (const oid of olds) delete next[oid];
        if (!next[serverMessageId]) next[serverMessageId] = st;
        return next;
      });
    });

    return () => {
      if (pendingDeletedTimer) {
        clearTimeout(pendingDeletedTimer);
        pendingDeletedTimer = null;
      }
      flushPendingDeleted();
      unsubscribeReceived();
      unsubscribeReadReceipt();
      unsubscribeReaction();
      unsubscribeChatCleared();
      unsubscribeMessageDeleted();
      unsubscribeMessagesDeleted();
      unsubscribeMessageEdited();
      unsubscribeMessageUrisUpdated();
      unsubscribeOutboxDelivered();
      unsubscribeDelivered();
    };
  }, [currentUserId, peerId, rememberDeletedServerMessageId, rememberOutboxLocalToServerId]);

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

      const hiddenForMeIds = hiddenForMeMessageIdsRef.current;
      const formatted = pages
        .filter((msg: any) => !hiddenForMeIds.has(String(msg?.id || '').trim()))
        .filter((msg: any) => !isGloballyDeletedMessageId(String(msg?.id || '')))
        .filter((msg: any) => !deletedServerMessageIdsRef.current.has(String(msg?.id || '').trim()))
        .map((msg: any) => ({
          id: msg.id,
          text: msg.text,
          type: msg.type,
          uri: msg.uri,
          ...albumUrisFieldFromMessage(msg),
          name: (msg as any).name,
          size: (msg as any).size,
          duration: (msg as any).duration,
          ...stickerFieldsFromMessage(msg),
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
          if (!id || serverIdSet.has(id)) return false;

          const stUp = (uploadStatusRef.current as any)?.[id];
          if (stUp === 'sending' || stUp === 'failed') return true;
          const uri = String(m?.uri || '');
          if (String(m?.sender || '') === 'me' && /^(file|content|ph|assets-library):\/\//i.test(uri)) return true;

          if (String(m?.sender || '') !== 'me') return false;

          const rs = readStatusesRef.current?.[id];
          if (rs === 'sending' || rs === 'failed') return true;
          // Текст из офлайн-outbox: пока сервер не вернул msg_* в этой выборке — не выкидываем из ленты (quiet sync).
          if (isOfflineQueuedOrOptimisticOutgoingId(id)) return true;

          return false;
        });

        // Убираем клиентский дубликат, если сервер уже отдал то же исходящее (иначе два пузыря).
        const dropLocalIds = new Set<string>();
        const serverMine = formatted.filter((x: any) => String(x?.sender || '') === 'me');
        for (const loc of localKeep) {
          const lid = String(loc?.id || '');
          if (!isOfflineQueuedOrOptimisticOutgoingId(lid)) continue;
          for (const sv of serverMine) {
            if (approxSameOutgoingTextMessage(loc, sv)) {
              dropLocalIds.add(lid);
              break;
            }
          }
        }

        // Для сообщений с сервера: если у локального есть replyTo, а у серверного нет — сохраняем локальный replyTo (гонка синка).
        const prevById = new Map(prev.map((m: any) => [String(m?.id || ''), m]));
        let merged = [...formatted.map((f: any) => {
          const local = prevById.get(String(f?.id || ''));
          if (local?.replyTo && !f.replyTo) return { ...f, replyTo: local.replyTo };
          return f;
        }), ...localKeep];
        if (dropLocalIds.size > 0) {
          merged = merged.filter((m: any) => !dropLocalIds.has(String(m?.id || '')));
        }
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
  }, [currentUserId, peerId]);

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
  /** Инкремент при каждом запуске загрузки истории — отменяет фоновый fetch при смене собеседника. */
  const historySyncGenerationRef = useRef(0);

  // Загрузка истории при открытии чата
  useEffect(() => {
    if (!peerId) return;
    let uid = String(currentUserId || '').trim();
    if (!uid) {
      try {
        uid = String(getCurrentSocketUserId() || '').trim();
      } catch {}
    }
    if (!uid) return;
    if (!currentUserId && uid) {
      setCurrentUserId(uid);
    }
    const prevPeer = prevPeerIdForHistoryRef.current;
    if (prevPeer !== peerId) {
      prevPeerIdForHistoryRef.current = peerId;
      setMessages([]);
    }

    historySyncGenerationRef.current += 1;
    const syncGen = historySyncGenerationRef.current;
    const pid = peerId;

    const loadHistory = async () => {
      setHistoryReady(false);
      setChatImagesWarm(false);
      clearMessageCache(pid, uid);

      const fetchPromise = fetchMessages({ with: pid, limit: 50 }).catch(() => null);

      let localPreloaded = false;
      try {
        const [localMessages, savedStatuses, hiddenIds] = await Promise.all([
          getChatMessagesLocal(pid, uid),
          loadStatuses(),
          loadHiddenForMeMessageIds(uid, pid),
        ]);
        if (historySyncGenerationRef.current !== syncGen) return;
        hiddenForMeMessageIdsRef.current = hiddenIds;
        setReadStatuses(savedStatuses || {});
        const visibleLocalMessages = Array.isArray(localMessages)
          ? localMessages.filter((msg: any) => !hiddenIds.has(String(msg?.id || '').trim()))
          : [];
        if (visibleLocalMessages.length > 0) {
          setMessages(visibleLocalMessages);
          localPreloaded = true;
        }
      } catch {}

      if (historySyncGenerationRef.current !== syncGen) return;
      // Сразу показываем локальную ленту или пустую заглушку — без ожидания fetchMessages (сокет/HTTP могут висеть десятки секунд).
      setHistoryReady(true);

      void (async () => {
        try {
          const serverMessages = await fetchPromise;
          if (historySyncGenerationRef.current !== syncGen) return;

          if (serverMessages?.ok && serverMessages.messages) {
            const hiddenForMeIds = hiddenForMeMessageIdsRef.current;
            const formattedMessages = serverMessages.messages
              .filter((msg: any) => !hiddenForMeIds.has(String(msg?.id || '').trim()))
              .filter((msg: any) => !isGloballyDeletedMessageId(String(msg?.id || '')))
              .filter((msg: any) => !deletedServerMessageIdsRef.current.has(String(msg?.id || '').trim()))
              .map((msg: any) => {
              if (msg.type === 'image') {
                const mid = String(msg.id || '').trim();
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
                ...albumUrisFieldFromMessage(msg),
                name: (msg as any).name,
                size: (msg as any).size,
                duration: (msg as any).duration,
                ...stickerFieldsFromMessage(msg),
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
              };
            });

            setMessages((prev) => {
              const serverIds = new Set(formattedMessages.map((m: any) => String(m?.id || '')));
              const serverMine = formattedMessages.filter((x: any) => String(x?.sender || '') === 'me');
              const localKeep = prev.filter((m: any) => {
                const id = String(m?.id || '');
                if (!id || serverIds.has(id)) return false;
                if (isServerMessageId(id)) return false;
                if (String(m?.sender || '') !== 'me') return false;
                const stUp = (uploadStatusRef.current as any)?.[id];
                if (stUp === 'sending' || stUp === 'failed') return true;
                const rs = readStatusesRef.current?.[id];
                return rs === 'sending' || rs === 'failed' || isOfflineQueuedOrOptimisticOutgoingId(id);
              });
              const dropLocalIds = new Set<string>();
              for (const loc of localKeep) {
                const lid = String(loc?.id || '');
                if (!isOfflineQueuedOrOptimisticOutgoingId(lid)) continue;
                for (const sv of serverMine) {
                  if (approxSameOutgoingTextMessage(loc, sv)) {
                    dropLocalIds.add(lid);
                    break;
                  }
                }
              }
              const prevById = new Map(prev.map((m: any) => [String(m?.id || ''), m]));
              const merged = [
                ...formattedMessages.map((f: any) => {
                  const local = prevById.get(String(f?.id || ''));
                  return local?.replyTo && !f.replyTo ? { ...f, replyTo: local.replyTo } : f;
                }),
                ...localKeep.filter((m: any) => !dropLocalIds.has(String(m?.id || ''))),
              ];
              return merged.sort((a, b) => {
                const ta = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp).getTime();
                const tb = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp).getTime();
                return ta - tb;
              });
            });

            await markMessagesAsRead(pid);
            try {
              await dismissMessageNotificationForUser(pid);
              await syncAppBadgeFromMissedCount();
            } catch {}

            try {
              const serverStatuses: Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'> = {};
              for (const m of formattedMessages) {
                if (m.sender === 'me') {
                  serverStatuses[m.id] = m.read ? 'read' : 'sent';
                }
              }
              const savedStatuses = await loadStatuses();
              updateReadStatuses(() => mergeChatReadStatuses(savedStatuses || {}, serverStatuses));
            } catch {}
          } else {
            if (!localPreloaded) {
              const fallbackLocal = await getChatMessages(pid, uid);
              if (historySyncGenerationRef.current !== syncGen) return;
              const hiddenIds = hiddenForMeMessageIdsRef.current;
              setMessages(fallbackLocal.filter((msg: any) => !hiddenIds.has(String(msg?.id || '').trim())));
            }
            const savedStatuses = await loadStatuses();
            if (historySyncGenerationRef.current !== syncGen) return;
            setReadStatuses(savedStatuses);
          }
        } catch (error) {
          console.warn('Chat history network load failed, using local cache:', error);
          if (historySyncGenerationRef.current !== syncGen) return;
          if (!localPreloaded) {
            try {
              const localMessages = await getChatMessages(pid, uid);
              const hiddenIds = hiddenForMeMessageIdsRef.current;
              setMessages(localMessages.filter((msg: any) => !hiddenIds.has(String(msg?.id || '').trim())));
              const savedStatuses = await loadStatuses();
              setReadStatuses(savedStatuses);
            } catch (fallbackError) {
              console.warn('Local fallback loading failed:', fallbackError);
              setMessages([]);
            }
          }
        }
      })();
    };

    loadHistory();
  }, [peerId, currentUserId]);

  // Догоняем сообщения с сервера после reconnect, пока чат в фокусе (закрывает окно без message:received).
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

            const hiddenForMeIds = hiddenForMeMessageIdsRef.current;
            const formattedMessages = serverMessages.messages
              .filter((msg: any) => !hiddenForMeIds.has(String(msg?.id || '').trim()))
              .map((msg: any) => ({
              id: msg.id,
              text: msg.text,
              type: msg.type,
              uri: msg.uri,
              ...albumUrisFieldFromMessage(msg),
              name: (msg as any).name,
              size: (msg as any).size,
              duration: (msg as any).duration,
              ...stickerFieldsFromMessage(msg),
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
              const serverIds = new Set(formattedMessages.map((m: any) => String(m?.id || '')));
              const localKeep = prev.filter((m: any) => {
                const id = String(m?.id || '');
                if (!id || serverIds.has(id)) return false;
                if (isServerMessageId(id)) return false;
                if (String(m?.sender || '') !== 'me') return false;
                const stUp = (uploadStatusRef.current as any)?.[id];
                if (stUp === 'sending' || stUp === 'failed') return true;
                const rs = readStatusesRef.current?.[id];
                return rs === 'sending' || rs === 'failed' || isOfflineQueuedOrOptimisticOutgoingId(id);
              });
              const prevById = new Map(prev.map((m: any) => [String(m?.id || ''), m]));
              const merged = [
                ...formattedMessages.map((f: any) => {
                  const local = prevById.get(String(f?.id || ''));
                  return local?.replyTo && !f.replyTo ? { ...f, replyTo: local.replyTo } : f;
                }),
                ...localKeep,
              ];
              return merged.sort((a, b) => {
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
                updateReadStatuses((prev) => mergeChatReadStatuses(prev, serverStatuses));
              }
            } catch {}

            await markMessagesAsRead(pid);
            try {
              await dismissMessageNotificationForUser(pid);
              await syncAppBadgeFromMissedCount();
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

  const ensureVoiceCachedToLocalFile = React.useCallback(async (resolvedUri: string): Promise<string> => {
    const u = String(resolvedUri || '').trim();
    if (!u || !/^https?:\/\//i.test(u)) return u;
    const baseDir = FileSystem.cacheDirectory;
    if (!baseDir) return u;

    const cachedPath = voiceAudioCacheRef.current.get(u);
    if (cachedPath) {
      try {
        const info = await FileSystem.getInfoAsync(cachedPath);
        if (info.exists) return cachedPath;
      } catch {}
      voiceAudioCacheRef.current.delete(u);
    }

    const inflight = voiceAudioDownloadRef.current.get(u);
    if (inflight) return inflight;

    const task = (async () => {
      try {
        const dest = `${baseDir}${voiceCacheFileNameForRemoteUrl(u)}`;
        const { uri: localUri } = await FileSystem.downloadAsync(u, dest);
        voiceAudioCacheRef.current.set(u, localUri);
        return localUri;
      } finally {
        voiceAudioDownloadRef.current.delete(u);
      }
    })();

    voiceAudioDownloadRef.current.set(u, task);
    return task;
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
    audioPlayGenerationRef.current += 1;
    const prev = audioSoundRef.current;
    audioSoundRef.current = null;
    setPlayingAudioId(null);
    setPlayingAudioState(null);
    if (prev) {
      await prev.stopAsync().catch(() => {});
      // unload часто сотни мс — не блокируем следующий play
      void prev.unloadAsync().catch(() => {});
    }
  }, []);

  const [retryUiForId, setRetryUiForId] = useState<string | null>(null);

  const mediaOutboxRetryInFlightRef = useRef<Set<string>>(new Set());

  const enqueueMediaOutboxId = React.useCallback(async (id: string) => {
    try {
      const uid = String(currentUserId || '').trim();
      const pid = String(peerId || '').trim();
      const mid = String(id || '').trim();
      if (!uid || !pid || !mid) return;
      const key = getMediaOutboxKey(uid, pid);
      const raw = await AsyncStorage.getItem(key);
      const list = raw ? (JSON.parse(raw) as string[]) : [];
      const next = Array.isArray(list) ? list.map(String) : [];
      if (!next.includes(mid)) {
        next.push(mid);
        await AsyncStorage.setItem(key, JSON.stringify(next));
      }
    } catch {}
  }, [currentUserId, peerId]);

  const dequeueMediaOutboxId = React.useCallback(async (id: string) => {
    try {
      const uid = String(currentUserId || '').trim();
      const pid = String(peerId || '').trim();
      const mid = String(id || '').trim();
      if (!uid || !pid || !mid) return;
      const key = getMediaOutboxKey(uid, pid);
      const raw = await AsyncStorage.getItem(key);
      const list = raw ? (JSON.parse(raw) as string[]) : [];
      const next = (Array.isArray(list) ? list.map(String) : []).filter((x) => x !== mid);
      if (next.length) {
        await AsyncStorage.setItem(key, JSON.stringify(next));
      } else {
        await AsyncStorage.removeItem(key);
      }
    } catch {}
  }, [currentUserId, peerId]);

  const loadMediaOutboxIds = React.useCallback(async (): Promise<string[]> => {
    try {
      const uid = String(currentUserId || '').trim();
      const pid = String(peerId || '').trim();
      if (!uid || !pid) return [];
      const key = getMediaOutboxKey(uid, pid);
      const raw = await AsyncStorage.getItem(key);
      const list = raw ? (JSON.parse(raw) as string[]) : [];
      return Array.isArray(list) ? Array.from(new Set(list.map(String).filter(Boolean))) : [];
    } catch {
      return [];
    }
  }, [currentUserId, peerId]);

  const retryFailedOutgoingMessage = React.useCallback(async (m: any): Promise<boolean> => {
    try {
      if (!m?.id || !currentUserId || !peerId) return false;
      const mid = String(m.id);
      const type = String(m?.type || '').trim();
      if (!type) return false;

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
            return false;
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
          clientUiMessageId: mid,
        });

        if (socketResult?.localCancelled) {
          await dequeueMediaOutboxId(mid);
          return true;
        }

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
          return true;
        }

        updateReadStatuses((prev) => ({ ...prev, [mid]: 'failed' }));
        setUploadStatus((prev) => ({ ...prev, [mid]: 'failed' }));
        return false;
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
            return false;
          }
          remoteUrl = upload.url;
        }

        const socketResult: any = await sendSocketMessage({
          to: peerId,
          type: 'image',
          uri: remoteUrl,
          name: fileName || undefined,
          size: fileSize || undefined,
          clientUiMessageId: mid,
        });

        if (socketResult?.localCancelled) {
          await dequeueMediaOutboxId(mid);
          return true;
        }

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
          return true;
        }

        updateReadStatuses((prev) => ({ ...prev, [mid]: 'failed' }));
        setUploadStatus((prev) => ({ ...prev, [mid]: 'failed' }));
        return false;
      }

      // Fallback: no retry implemented for this type
      updateReadStatuses((prev) => ({ ...prev, [mid]: 'failed' }));
      setUploadStatus((prev) => ({ ...prev, [mid]: 'failed' }));
      return false;
    } catch {
      try {
        const mid = String(m?.id || '');
        if (mid) {
          updateReadStatuses((prev) => ({ ...prev, [mid]: 'failed' }));
          setUploadStatus((prev) => ({ ...prev, [mid]: 'failed' }));
        }
      } catch {}
      return false;
    }
  }, [currentUserId, peerId, resolveMediaUri, updateReadStatuses]);

  const drainMediaOutbox = React.useCallback(async () => {
    const ids = await loadMediaOutboxIds();
    if (!ids.length) return;
    for (const id of ids) {
      if (mediaOutboxRetryInFlightRef.current.has(id)) continue;
      const msg = messages.find((x: any) => String(x?.id) === String(id));
      if (!msg) {
        await dequeueMediaOutboxId(id);
        continue;
      }
      const uri = String(msg?.uri || '').trim();
      const type = String(msg?.type || '').trim();
      const isMedia = type === 'image' || type === 'audio';
      const canRetry = !!uri && (!/^https?:\/\//i.test(uri) || (uploadStatus[id] === 'failed' || readStatuses[id] === 'failed'));
      if (!isMedia || !canRetry) continue;
      mediaOutboxRetryInFlightRef.current.add(id);
      try {
        const ok = await retryFailedOutgoingMessage(msg);
        if (ok) await dequeueMediaOutboxId(id);
      } finally {
        mediaOutboxRetryInFlightRef.current.delete(id);
      }
    }
  }, [dequeueMediaOutboxId, loadMediaOutboxIds, messages, readStatuses, retryFailedOutgoingMessage, uploadStatus]);

  useEffect(() => {
    const run = () => {
      void drainMediaOutbox();
    };
    socket.on('connect', run);
    socket.on('reconnect', run);
    run();
    return () => {
      socket.off('connect', run);
      socket.off('reconnect', run);
    };
  }, [drainMediaOutbox]);

  const [playingAudioState, setPlayingAudioState] = useState<{
    id: string;
    durationMs: number;
    positionMs: number;
  } | null>(null);

  const togglePlayAudioMessage = React.useCallback(async (m: any) => {
    let playGen = 0;
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

      playGen = ++audioPlayGenerationRef.current;
      const fallbackDurationMs = Math.max(0, Number(m?.duration || 0) * 1000);
      // UI сразу «играет» — не ждём decode/createAsync
      setPlayingAudioState({ id: mid, durationMs: fallbackDurationMs, positionMs: 0 });
      setPlayingAudioId(mid);

      // Режим уже поднимается в useFocusEffect; здесь не блокируем старт
      void Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        allowsRecordingIOS: false,
        staysActiveInBackground: false,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      }).catch(() => {});

      let playUri = uri;
      if (/^https?:\/\//i.test(uri)) {
        try {
          playUri = await ensureVoiceCachedToLocalFile(uri);
        } catch {
          playUri = uri;
        }
      }

      const { sound } = await Audio.Sound.createAsync(
        { uri: playUri },
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
      if (playGen !== audioPlayGenerationRef.current) {
        await sound.unloadAsync().catch(() => {});
        return;
      }
      audioSoundRef.current = sound;
    } catch {
      if (playGen !== 0 && playGen === audioPlayGenerationRef.current) {
        setPlayingAudioId(null);
        setPlayingAudioState(null);
      }
    }
  }, [resolveMediaUri, playingAudioId, stopAudioPlayback, ensureVoiceCachedToLocalFile]);

  useEffect(() => {
    const baseDir = FileSystem.cacheDirectory;
    if (!baseDir) return;
    const tail = messages.length > 30 ? messages.slice(-30) : messages;
    for (const m of tail) {
      if (String(m?.type || '') !== 'audio') continue;
      const raw = String(m?.uri || '').trim();
      if (!raw) continue;
      const resolved = resolveMediaUri(raw);
      if (!resolved || !/^https?:\/\//i.test(resolved)) continue;
      void ensureVoiceCachedToLocalFile(resolved).catch(() => {});
    }
  }, [messages, resolveMediaUri, ensureVoiceCachedToLocalFile]);

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
        Animated.timing(recordViz, { toValue: 1, duration: 340, useNativeDriver: true }),
        Animated.timing(recordViz, { toValue: 0, duration: 340, useNativeDriver: true }),
      ])
    );
    recordVizLoopRef.current = loop;
    loop.start();
    return () => {
      try { loop.stop(); } catch {}
    };
  }, [voiceIsRecording, recordViz]);
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
  const chatFeedReady = historyReady && chatImagesWarm;
  const showEmpty = isEmpty && chatFeedReady;

  // При входе в чат: прогреть кэш картинок (короткий таймаут), чтобы облака не мерцали.
  useEffect(() => {
    if (!historyReady || chatImagesWarm) return;
    const t = setTimeout(() => setChatImagesWarm(true), 450);
    return () => clearTimeout(t);
  }, [historyReady, chatImagesWarm]);

  useEffect(() => {
    if (!historyReady) return;
    let cancelled = false;
    const urls: string[] = [];
    const seen = new Set<string>();
    const tail = messages.length > 40 ? messages.slice(-40) : messages;
    for (const m of tail) {
      if (String(m?.type || '') !== 'image') continue;
      for (const u of getMessageImageUris(m)) {
        const r = resolveMediaUri(u);
        if (!r || seen.has(r)) continue;
        if (Platform.OS === 'android' && /^data:/i.test(r)) continue;
        if (!/^(https?:|file:)/i.test(r)) continue;
        seen.add(r);
        urls.push(r);
        if (urls.length >= 56) break;
      }
      if (urls.length >= 56) break;
    }
    if (chatImagesWarm) {
      if (urls.length > 0) void prefetchImages(urls).catch(() => {});
      return;
    }
    if (urls.length === 0) return; // ждём сообщения или safety timeout
    (async () => {
      try {
        await Promise.race([
          prefetchImages(urls),
          new Promise<void>((resolve) => setTimeout(resolve, 340)),
        ]);
      } catch {}
      if (!cancelled) setChatImagesWarm(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [historyReady, messages, resolveMediaUri, chatImagesWarm]);

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


  const deleteSingleMessage = async (messageId: string, forBoth: boolean = true) => {
    let mid = String(messageId || '').trim();
    if (!mid) return;
    void removeQueuedEditsMatching([mid]).catch(() => {});

    const snap = Array.isArray(messagesRef.current) ? messagesRef.current : [];
    if (!isDeletableOnServerMessageId(mid) && forBoth) {
      const resolved = resolveServerMessageIdForDelete(
        mid,
        snap,
        outboxLocalIdToServerIdRef.current,
      );
      if (isDeletableOnServerMessageId(resolved)) {
        mid = resolved;
      }
    }

    // Только outbox_* ещё не на сервере. Id вида timestamp-random — clientMessageId в Mongo.
    if (!isDeletableOnServerMessageId(mid)) {
      void removeQueuedMessagesMatching([mid]).catch(() => {});
      void dequeueMediaOutboxId(mid);
      setMessages((prev) => {
        const next = filterRemoveMessageAndOutgoingDupes(prev, mid);
        latestMessagesForPersistRef.current = next;
        clearMessageCache(peerId, currentUserId || undefined);
        queueMicrotask(() => enqueueMessagesPersist('delete_local_message'));
        const nextIds = new Set(next.map((m: any) => String(m?.id || '')));
        const dropped = prev
          .map((m: any) => String(m?.id || ''))
          .filter((id) => id && !nextIds.has(id));
        if (dropped.length) {
          queueMicrotask(() => {
            updateReadStatuses((rs) => {
              const n = { ...rs };
              for (const d of dropped) delete (n as any)[d];
              return n as any;
            });
            setUploadStatus((up) => {
              const n = { ...up };
              for (const d of dropped) delete (n as any)[d];
              return n;
            });
            void removeQueuedMessagesMatching(dropped).catch(() => {});
            dropped.forEach((d) => dequeueMediaOutboxId(d));
          });
        }
        return next;
      });
      showForwardToastBadge(false, t('chatDeleted', lang));
      return;
    }

    if (!forBoth) {
      await rememberHiddenForMeMessageId(mid);
      clearMessageCache(peerId, currentUserId || undefined);
      setMessages((prev) => {
        const next = filterRemoveMessageAndOutgoingDupes(prev, mid);
        latestMessagesForPersistRef.current = next;
        queueMicrotask(() => enqueueMessagesPersist('delete_message_for_me'));
        const nextIds = new Set(next.map((m: any) => String(m?.id || '')));
        const dropped = prev
          .map((m: any) => String(m?.id || ''))
          .filter((id) => id && !nextIds.has(id));
        if (dropped.length) {
          queueMicrotask(() => {
            updateReadStatuses((rs) => {
              const n = { ...rs };
              for (const d of dropped) delete (n as any)[d];
              return n as any;
            });
            setUploadStatus((up) => {
              const n = { ...up };
              for (const d of dropped) delete (n as any)[d];
              return n;
            });
            void removeQueuedMessagesMatching(dropped).catch(() => {});
            dropped.forEach((d) => dequeueMediaOutboxId(d));
          });
        }
        return next;
      });
      showForwardToastBadge(false, t('chatDeleted', lang));
      return;
    }

    const success = await deleteMessage(mid);
    if (success) {
      rememberDeletedServerMessageId(mid);
      clearMessageCache(peerId, currentUserId || undefined);
      setMessages((prev) => {
        const next = filterRemoveMessageAndOutgoingDupes(prev, mid);
        latestMessagesForPersistRef.current = next;
        queueMicrotask(() => enqueueMessagesPersist('delete_server_message'));
        const nextIds = new Set(next.map((m: any) => String(m?.id || '')));
        const dropped = prev
          .map((m: any) => String(m?.id || ''))
          .filter((id) => id && !nextIds.has(id));
        if (dropped.length) {
          queueMicrotask(() => {
            updateReadStatuses((rs) => {
              const n = { ...rs };
              for (const d of dropped) delete (n as any)[d];
              return n as any;
            });
            setUploadStatus((up) => {
              const n = { ...up };
              for (const d of dropped) delete (n as any)[d];
              return n;
            });
            void removeQueuedMessagesMatching(dropped).catch(() => {});
            dropped.forEach((d) => dequeueMediaOutboxId(d));
          });
        }
        return next;
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
      setAlbumFocusIndex(null);
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
      messageActionsOpacity.setValue(0);
      messageActionsTranslateY.setValue(30);
      Animated.parallel([
        Animated.timing(messageActionsOpacity, {
          toValue: 1,
          duration: 120,
          useNativeDriver: true,
        }),
        Animated.timing(messageActionsTranslateY, {
          toValue: 0,
          duration: 120,
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
    setDeleteConfirmKind('single');
    setDeleteForBoth(true);
    setDeleteConfirmVisible(true);
  }, [hideMessageActions]);

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

      /** Сразу показать в текущем чате, если переслали собеседнику этого экрана (иначе ждём socket echo с задержкой). */
      const appendIfForwardedToThisPeer = (r: any, partial: { type: string; text?: string; uri?: string; uris?: string[]; name?: any; size?: any; duration?: any; stickerId?: string; stickerPackId?: string; stickerEmoji?: string; stickerLabel?: string }) => {
        const uid = String(currentUserId || '').trim();
        const pid = String(peerId || '').trim();
        const t = String(to || '').trim();
        if (!uid || !pid || t !== pid) return;
        if (!r?.ok || r?.localCancelled) return;
        const mid = String(r?.messageId || '').trim();
        if (!mid || mid.startsWith('outbox_')) return;
        const tsRaw = (r as any)?.timestamp;
        const ts = tsRaw ? new Date(tsRaw) : new Date();
        const typ = String(partial.type || 'text').trim();
        setMessages((prev) => {
          if (prev.some((m) => String(m?.id) === mid)) return prev;
          const row: any = {
            id: mid,
            type: typ,
            sender: 'me',
            from: uid,
            to: pid,
            timestamp: ts,
            reactions: [],
          };
          if (typ === 'text') row.text = String(partial.text || '');
          else if (typ === 'sticker') {
            row.text = partial.text || getStickerFallbackText({ label: partial.stickerLabel }, lang);
            row.stickerId = partial.stickerId;
            row.stickerPackId = partial.stickerPackId;
            row.stickerEmoji = partial.stickerEmoji;
            row.stickerLabel = partial.stickerLabel;
          }
          else {
            if (partial.uri) row.uri = resolveMediaUri(String(partial.uri));
            if (Array.isArray(partial.uris) && partial.uris.length > 1) {
              row.uris = partial.uris.map((u) => resolveMediaUri(String(u)) || String(u));
              if (!row.uri) row.uri = row.uris[0];
            }
            if (partial.name != null) row.name = partial.name;
            if (partial.size != null) row.size = partial.size;
            if (partial.duration != null) row.duration = partial.duration;
          }
          return [...prev, row];
        });
        updateReadStatuses((prev) => ({
          ...prev,
          [mid]: (r as any)?.delivered ? 'delivered' : 'sent',
        }));
        if (Platform.OS === 'android') {
          requestAnimationFrame(() => {
            scrollToBottom();
            setTimeout(() => scrollToBottom(), 90);
            setTimeout(() => scrollToBottom(), 220);
          });
        } else {
          scheduleScrollToBottom(0);
          setTimeout(() => scrollToBottom(), 60);
        }
      };

      if (selectionMode) {
        const forwardables: any[] = [];
        for (const m of messages) {
          const mid = String(m?.id || '').trim();
          if (!mid) continue;
          const type = String(m?.type || '').trim();
          if (type === 'image' && isImageAlbumMessage(m)) {
            const idxs = selectedAlbumIndices(m, selectedMessageIds);
            if (!idxs.length) continue;
            const album = getMessageImageUris(m);
            const resolved = idxs
              .map((i) => normalizeForwardMediaUri(album[i]))
              .filter(Boolean);
            if (!resolved.length) continue;
            if (resolved.length === 1) {
              forwardables.push({ type: 'image', uri: resolved[0], name: m?.name, size: m?.size });
            } else {
              forwardables.push({
                type: 'image',
                uri: resolved[0],
                uris: resolved,
                name: m?.name,
                size: m?.size,
              });
            }
            continue;
          }
          if (!selectedMessageIds.has(mid)) continue;
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
          } else if (type === 'sticker') {
            const stickerId = String(m?.stickerId || '').trim();
            if (stickerId) {
              forwardables.push({
                type: 'sticker',
                text: getStickerFallbackText(m, lang),
                ...stickerFieldsFromMessage(m),
              });
            }
          }
        }
        if (forwardables.length === 0) return 0;
        let okCount = 0;
        for (const payload of forwardables) {
          const r: any = await sendSocketMessage({ to, ...payload });
          if (r?.localCancelled) continue;
          if (r?.ok) {
            okCount += 1;
            appendIfForwardedToThisPeer(r, payload);
          }
        }
        return okCount;
      }

      const type = String(selectedMessage?.type || '').trim();
      if (type === 'text') {
        const txt = String(selectedMessage?.text ?? '').trim();
        if (!txt) return 0;
        const r: any = await sendSocketMessage({ to, text: txt, type: 'text' });
        if (r?.ok && !r?.localCancelled) {
          appendIfForwardedToThisPeer(r, { type: 'text', text: txt });
          return 1;
        }
        return 0;
      }
      if (type === 'image') {
        const forceOne = !!(selectedMessage as any)?.__albumForwardOne;
        const album = forceOne ? [] : getMessageImageUris(selectedMessage);
        if (album.length > 1) {
          const resolved = album.map((u) => normalizeForwardMediaUri(u)).filter(Boolean);
          if (!resolved.length) return 0;
          const r: any = await sendSocketMessage({
            to,
            type: 'image',
            uri: resolved[0],
            uris: resolved,
            name: selectedMessage?.name,
            size: selectedMessage?.size,
          });
          if (r?.ok && !r?.localCancelled) {
            appendIfForwardedToThisPeer(r, {
              type: 'image',
              uri: resolved[0],
              uris: resolved,
              name: selectedMessage?.name,
              size: selectedMessage?.size,
            });
            return 1;
          }
          return 0;
        }
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
        if (r?.ok && !r?.localCancelled) {
          appendIfForwardedToThisPeer(r, { type: 'image', uri, name: selectedMessage?.name, size: selectedMessage?.size });
          return 1;
        }
        return 0;
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
        if (r?.ok && !r?.localCancelled) {
          appendIfForwardedToThisPeer(r, {
            type: 'audio',
            uri,
            name: selectedMessage?.name,
            size: selectedMessage?.size,
            duration: selectedMessage?.duration,
          });
          return 1;
        }
        return 0;
      }
      if (type === 'sticker') {
        const stickerId = String(selectedMessage?.stickerId || '').trim();
        if (!stickerId) return 0;
        const payload = {
          to,
          type: 'sticker' as const,
          text: getStickerFallbackText(selectedMessage, lang),
          ...stickerFieldsFromMessage(selectedMessage),
        };
        const r: any = await sendSocketMessage(payload);
        if (r?.ok && !r?.localCancelled) {
          appendIfForwardedToThisPeer(r, payload);
          return 1;
        }
        return 0;
      }
      return 0;
    },
    [
      selectionMode,
      messages,
      selectedMessageIds,
      selectedMessage,
      resolveMediaUri,
      peerId,
      currentUserId,
      updateReadStatuses,
      scrollToBottom,
      scheduleScrollToBottom,
      lang,
    ]
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
      let hasAny = false;
      for (const m of messages) {
        const mid = String(m?.id || '').trim();
        if (!mid) continue;
        const type = String(m?.type || '').trim();
        if (type === 'image' && isImageAlbumMessage(m)) {
          const idxs = selectedAlbumIndices(m, selectedMessageIds);
          if (!idxs.length) continue;
          const album = getMessageImageUris(m);
          const ok = idxs.some((i) => normalizeForwardMediaUri(String(album[i] || '')));
          if (ok) {
            hasAny = true;
            break;
          }
          continue;
        }
        if (!selectedMessageIds.has(mid)) continue;
        if (type === 'text' && String(m?.text || '').trim()) hasAny = true;
        else if (type === 'image' && normalizeForwardMediaUri(String(m?.uri || ''))) hasAny = true;
        else if (type === 'audio' && normalizeForwardMediaUri(String(m?.uri || ''))) hasAny = true;
        else if (type === 'sticker' && String(m?.stickerId || '').trim()) hasAny = true;
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
      if (type === 'sticker' && !String(selectedMessage?.stickerId ?? '').trim()) return;
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
      const parts: string[] = [];
      for (const m of messages) {
        const mid = String(m?.id || '').trim();
        if (!mid) continue;
        const type = String(m?.type || '').trim();
        if (type === 'image' && isImageAlbumMessage(m)) {
          const n = selectedAlbumIndices(m, selectedMessageIds).length;
          if (n > 0) {
            for (let i = 0; i < n; i++) parts.push(t('mediaPhotoLabel', lang));
          }
          continue;
        }
        if (!selectedMessageIds.has(mid)) continue;
        if (type === 'text') parts.push(String(m?.text ?? '').trim());
        else if (type === 'image') parts.push(t('mediaPhotoLabel', lang));
        else if (type === 'audio') parts.push(`🎤 ${t('chatVoiceMessage', lang)}`);
        else if (type === 'sticker') parts.push(getStickerFallbackText(m, lang));
      }
      shareText = parts.filter(Boolean).join('\n');
      const firstAlbum = messages.find(
        (m) => isImageAlbumMessage(m) && selectedAlbumIndices(m, selectedMessageIds).length > 0,
      );
      if (firstAlbum) {
        const idxs = selectedAlbumIndices(firstAlbum, selectedMessageIds);
        const uris = getMessageImageUris(firstAlbum);
        const raw = uris[idxs[0]];
        if (raw) shareUrl = normalizeUri(String(raw));
      } else {
        const firstMedia = messages.find(
          (m) =>
            selectedMessageIds.has(String(m?.id || '')) &&
            String(m?.type || '').trim() !== 'text',
        );
        if (firstMedia?.uri) shareUrl = normalizeUri(String(firstMedia.uri));
      }
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
      } else if (type === 'sticker') {
        shareText = getStickerFallbackText(selectedMessage, lang);
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

  const toggleSelectMessage = React.useCallback((id: string) => {
    const mid = String(id || '').trim();
    if (!mid) return;
    const msg = messages.find((m) => String(m?.id || '').trim() === mid);
    // Album: side checkbox toggles ALL photos on/off
    if (msg && isImageAlbumMessage(msg)) {
      const keys = albumSelectionKeysForMessage(msg);
      setSelectedMessageIds((prev) => {
        const next = new Set(prev);
        next.delete(mid);
        const allOn = keys.length > 0 && keys.every((k) => next.has(k));
        if (allOn) {
          for (const k of keys) next.delete(k);
        } else {
          for (const k of keys) next.add(k);
        }
        return next;
      });
      return;
    }
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(mid)) next.delete(mid);
      else next.add(mid);
      return next;
    });
  }, [messages]);

  const toggleSelectAlbumTile = React.useCallback((messageId: string, index: number) => {
    const mid = String(messageId || '').trim();
    if (!mid || index < 0) return;
    const key = albumSelectionKey(mid, index);
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      // Drop legacy whole-message key if present — expand to per-tile then toggle
      if (next.has(mid)) {
        next.delete(mid);
        const msg = messages.find((m) => String(m?.id || '') === mid);
        const n = getMessageImageUris(msg).length;
        for (let i = 0; i < n; i++) {
          if (i !== index) next.add(albumSelectionKey(mid, i));
        }
        return next;
      }
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [messages]);

  useEffect(() => {
    if (!selectionMode) return;
    if (selectedMessageIds.size === 0) {
      exitSelectionMode();
      return;
    }
    let hasSelectedMessagesLeft = false;
    const byId = new Map(
      messages.map((m) => [String(m?.id || '').trim(), m] as const).filter(([id]) => !!id),
    );
    for (const key of selectedMessageIds) {
      const parsed = parseAlbumSelectionKey(key);
      if (parsed) {
        const msg = byId.get(parsed.messageId);
        if (msg && parsed.index < getMessageImageUris(msg).length) {
          hasSelectedMessagesLeft = true;
          break;
        }
        continue;
      }
      if (byId.has(key)) {
        hasSelectedMessagesLeft = true;
        break;
      }
    }
    if (!hasSelectedMessagesLeft) exitSelectionMode();
  }, [selectionMode, selectedMessageIds, messages, exitSelectionMode]);

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

  const enterSelectionModeFromMessage = React.useCallback((m: any, focusIndex: number | null = null) => {
    const mid = String(m?.id || '').trim();
    setSelectionMode(true);
    setSelectedMessageIds(() => {
      const next = new Set<string>();
      if (!mid) return next;
      if (isImageAlbumMessage(m)) {
        const uris = getMessageImageUris(m);
        const idx =
          focusIndex != null && focusIndex >= 0 && focusIndex < uris.length
            ? focusIndex
            : 0;
        next.add(albumSelectionKey(mid, idx));
      } else {
        next.add(mid);
      }
      return next;
    });
    // Закрываем sheet, если он был открыт
    try { hideMessageActions(); } catch {}
  }, [hideMessageActions]);

  const closeDeleteConfirm = React.useCallback(() => {
    setDeleteConfirmVisible(false);
    setDeleteForBoth(true);
    setDeleteConfirmKind('single');
    pendingDeleteRef.current = null;
  }, []);

  const confirmDeleteNow = React.useCallback(() => {
    const m = pendingDeleteRef.current;
    const forBoth = deleteForBoth;
    setDeleteConfirmVisible(false);
    setDeleteForBoth(true);
    setDeleteConfirmKind('single');
    pendingDeleteRef.current = null;
    if (Array.isArray(m?.ids)) {
      const ids = m.ids.map((id: any) => String(id || '').trim()).filter(Boolean);
      if (ids.length > 0) void batchDeleteSelectedRef.current?.(forBoth, ids);
      return;
    }
    const id = String(m?.id || '').trim();
    if (id) void deleteSingleMessage(id, forBoth);
  }, [deleteSingleMessage, deleteForBoth]);

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

  React.useEffect(() => {
    const off = onCometChatStatus?.((payload) => {
      if (!payload?.message) return;
      showNotice(payload.kind === 'error' ? 'error' : 'info', payload.title || 'LiVi', payload.message);
    });
    return () => {
      try { off?.(); } catch {}
    };
  }, [showNotice]);

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
    for (const m of messages) {
      const id = String(m?.id || '').trim();
      if (!id) continue;
      const type = String(m?.type || '').trim();
      if (type === 'image' && isImageAlbumMessage(m)) {
        if (selectedAlbumIndices(m, selectedMessageIds).length > 0) return true;
        continue;
      }
      if (!selectedMessageIds.has(id)) continue;
      if (type === 'text' && String(m?.text || '').trim()) return true;
      if (type === 'image' && String(m?.uri || '').trim()) return true;
      if (type === 'audio' && String(m?.uri || '').trim()) return true;
      if (type === 'sticker' && String(m?.stickerId || '').trim()) return true;
    }
    return false;
  }, [selectionMode, selectedMessageIds, messages]);

  const selectAllLoaded = React.useCallback(() => {
    const allKeys: string[] = [];
    for (const m of messages) {
      const mid = String(m?.id || '').trim();
      if (!mid) continue;
      if (isImageAlbumMessage(m)) {
        allKeys.push(...albumSelectionKeysForMessage(m));
      } else {
        allKeys.push(mid);
      }
    }
    const allSelected =
      allKeys.length > 0 && allKeys.every((k) => selectedMessageIds.has(k));
    if (allSelected) {
      setSelectedMessageIds(new Set());
    } else {
      setSelectedMessageIds(new Set(allKeys));
    }
  }, [messages, selectedMessageIds]);

  const batchDeleteSelected = React.useCallback(async (forBoth: boolean = true, idsOverride?: string[]) => {
    const rawKeys = Array.from(new Set(
      (idsOverride || Array.from(selectedMessageIds))
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    ));
    if (rawKeys.length === 0) return;

    const snapForPlan = Array.isArray(messagesRef.current) ? [...messagesRef.current] : [];
    const byId = new Map(
      snapForPlan.map((m) => [String(m?.id || '').trim(), m] as const).filter(([id]) => !!id),
    );

    // Expand selection: album tile keys → full delete or partial URI update
    const fullDeleteIds = new Set<string>();
    const albumPartials: Array<{ messageId: string; message: any; removeIndices: number[] }> = [];

    const albumRemoveByMsg = new Map<string, Set<number>>();
    for (const key of rawKeys) {
      const parsed = parseAlbumSelectionKey(key);
      if (parsed) {
        let set = albumRemoveByMsg.get(parsed.messageId);
        if (!set) {
          set = new Set();
          albumRemoveByMsg.set(parsed.messageId, set);
        }
        set.add(parsed.index);
        continue;
      }
      fullDeleteIds.add(key);
    }

    for (const [messageId, removeSet] of albumRemoveByMsg) {
      const message = byId.get(messageId);
      if (!message) continue;
      const uris = getMessageImageUris(message);
      const removeIndices = Array.from(removeSet).filter((i) => i >= 0 && i < uris.length);
      if (!removeIndices.length) continue;
      const isOwn = message?.from === currentUserId || message?.sender === 'me';
      if (!isOwn || removeIndices.length >= uris.length) {
        fullDeleteIds.add(messageId);
      } else {
        albumPartials.push({ messageId, message, removeIndices });
      }
    }

    // Partial album edits (own messages): remove only selected photos
    for (const edit of albumPartials) {
      const uris = getMessageImageUris(edit.message);
      const removeSet = new Set(edit.removeIndices);
      const next = uris.filter((_, i) => !removeSet.has(i));
      if (next.length === 0) {
        fullDeleteIds.add(edit.messageId);
        continue;
      }
      const r = await updateMessageUris(String(edit.messageId), next);
      if (r?.ok) {
        if (r.deleted) {
          fullDeleteIds.add(edit.messageId);
        } else {
          setMessages((prev) =>
            prev.map((x) =>
              String(x?.id) === String(edit.messageId)
                ? {
                    ...x,
                    uri: r.uri || next[0],
                    uris: next.length > 1 ? next : undefined,
                  }
                : x,
            ),
          );
        }
      }
    }

    const ids = Array.from(fullDeleteIds);
    if (ids.length === 0) {
      try { hideMessageActions(); } catch {}
      setSelectedMessage(null);
      exitSelectionMode();
      return;
    }

    const idSet = new Set(ids.map((x) => String(x)));
    const snapForResolve = Array.isArray(messagesRef.current) ? [...messagesRef.current] : [];
    const localToServer = outboxLocalIdToServerIdRef.current;

    let serverIds: string[] = [];
    let localOnlyIds: string[] = [];
    if (forBoth) {
      const resolvedServer = new Set<string>();
      localOnlyIds = [];
      for (const uiId of ids) {
        const resolved = resolveServerMessageIdForDelete(uiId, snapForResolve, localToServer);
        if (isDeletableOnServerMessageId(resolved)) {
          resolvedServer.add(resolved);
        } else {
          localOnlyIds.push(String(uiId));
        }
      }
      serverIds = Array.from(resolvedServer);
    } else {
      localOnlyIds = [...ids];
    }
    if (!forBoth) {
      await rememberHiddenForMeMessageIds(ids);
    }

    // Optimistic UI: remove all selected messages at once (no sequential "one-by-one" deletion).
    // Keep a snapshot of removed messages so we can restore only the ones that actually failed.
    const removedById = new Map<string, any>();
    const prevSnap = Array.isArray(messagesRef.current) ? [...messagesRef.current] : [];
    try {
      for (const mm of prevSnap) {
        const mid = String(mm?.id || '').trim();
        if (mid && idSet.has(mid)) removedById.set(mid, mm);
      }
    } catch {}
    let nextMessages = prevSnap;
    for (const id of ids) {
      const delId = String(id || '').trim();
      if (!delId) continue;
      nextMessages = filterRemoveMessageAndOutgoingDupes(nextMessages, delId);
    }
    const nextIds = new Set(nextMessages.map((m: any) => String(m?.id || '').trim()).filter(Boolean));
    const droppedAll = prevSnap
      .map((m: any) => String(m?.id || '').trim())
      .filter((mid) => mid && !nextIds.has(mid));
    latestMessagesForPersistRef.current = nextMessages;
    clearMessageCache(peerId, currentUserId || undefined);
    setMessages(nextMessages);
    queueMicrotask(() => {
      enqueueMessagesPersist('delete_selected_messages');
      void removeQueuedMessagesMatching(droppedAll).catch(() => {});
      droppedAll.forEach((d) => dequeueMediaOutboxId(d));
    });
    // UI уже очистили оптимистично, поэтому режим выбора закрываем сразу.
    try { hideMessageActions(); } catch {}
    setSelectedMessage(null);
    exitSelectionMode();

    const batchResult = forBoth && serverIds.length > 0
      ? await deleteMessages(serverIds)
      : { deletedIds: [], failedIds: [], error: undefined as string | undefined };
    const deletedOnServer = new Set(
      (Array.isArray(batchResult?.deletedIds) ? batchResult.deletedIds : []).map(String),
    );
    const notFoundOrGone = forBoth
      ? (Array.isArray(batchResult?.failedIds) ? batchResult.failedIds.map(String) : [])
      : [];
    const hardFailure = forBoth && serverIds.length > 0 && isHardDeleteBatchError(batchResult?.error);

    // На сервере уже нет (not_found) — снимаем локально, не восстанавливаем «призраков».
    const failedServer = hardFailure
      ? serverIds.filter((id) => !deletedOnServer.has(String(id)))
      : [];

    // local-only deletions are always considered successful (client-side only)
    const successServerIds = serverIds.filter((id) => deletedOnServer.has(String(id)));
    const goneServerIds = hardFailure ? [] : notFoundOrGone;
    for (const sid of [...successServerIds, ...goneServerIds]) {
      rememberDeletedServerMessageId(String(sid));
    }

    // cleanup status maps for successful deletions (both server + local-only)
    const deletedOk = new Set<string>([...localOnlyIds, ...successServerIds, ...goneServerIds].map(String));
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
    setSelectionMode(true);
    setSelectedMessageIds(new Set(failedServer));
    showNotice(
      'error',
      t('errorTitle', lang),
      t('chatDeleteFailedCount', lang).replace('{count}', String(failedServer.length))
    );
  }, [
    selectedMessageIds,
    exitSelectionMode,
    currentUserId,
    showForwardToastBadge,
    showNotice,
    lang,
    deleteMessages,
    updateReadStatuses,
    setUploadStatus,
    hideMessageActions,
    rememberDeletedServerMessageId,
    rememberHiddenForMeMessageIds,
  ]);
  batchDeleteSelectedRef.current = batchDeleteSelected;

  const confirmDeleteSelected = React.useCallback(() => {
    if (selectedCount === 0) return;
    pendingDeleteRef.current = { ids: Array.from(selectedMessageIds) };
    setDeleteConfirmKind('multi');
    setDeleteForBoth(true);
    setDeleteConfirmVisible(true);
  }, [selectedCount, selectedMessageIds]);

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
      <ChatStyleBackButton
        icon={selectionMode ? 'close' : 'arrow-back'}
        iconColor={LIVI.titan}
        iconSize={FRIEND_ACTION_ICON_SIZE - 2}
        style={{
          width: 40,
          height: 40,
          borderRadius: FRIEND_ACTION_BUTTON.borderRadius - 1,
          ...(isDark
            ? null
            : {
                backgroundColor: 'rgba(0,0,0,0.06)',
                borderWidth: 1,
                borderColor: (theme.colors?.outline as string) || 'rgba(0,0,0,0.12)',
              }),
        }}
        onPress={() => {
          if (selectionMode) exitSelectionMode();
          else navigation.goBack();
        }}
      />

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
            size={FRIEND_ACTION_BUTTON.width}
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
  const downloadUriToCache = React.useCallback(async (uri: string): Promise<string> => {
    const resolved = resolveMediaUri(uri) || uri;
    if (!resolved) return '';
    if (/^file:\/\//i.test(resolved) || /^content:\/\//i.test(resolved)) return resolved;
    try {
      const ext = resolved.toLowerCase().includes('.png') ? 'png' : 'jpg';
      const target = `${FileSystem.cacheDirectory}livi_save_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const res = await FileSystem.downloadAsync(resolved, target);
      return res?.uri || '';
    } catch {
      return '';
    }
  }, [resolveMediaUri]);

  const saveAlbumUris = React.useCallback(async (uris: string[]) => {
    let ok = 0;
    let permDenied = false;
    for (const u of uris) {
      const local = await downloadUriToCache(u);
      if (!local) continue;
      try {
        await saveImageToGallery(local);
        ok += 1;
      } catch (e) {
        if (/permission|Photos|gallery/i.test(String((e as any)?.message || e))) {
          permDenied = true;
        }
      }
    }
    if (ok > 0) {
      showForwardToastBadge(true, t('chatAlbumSaved', lang));
      if (ok < uris.length) showNotice('error', t('errorTitle', lang), t('chatAlbumSavePartialFail', lang));
    } else {
      showNotice(
        'error',
        t('errorTitle', lang),
        permDenied ? t('chatAlbumSaveNoPermission', lang) : t('saveFailed', lang),
      );
    }
  }, [downloadUriToCache, showForwardToastBadge, showNotice, lang]);

  const runSelectedImageAction = React.useCallback(
    async (action: string, m: any, focusIndex: number | null) => {
      if (!m) return;
      const uris = getMessageImageUris(m);
      const isAlbum = uris.length > 1;
      const idx =
        focusIndex != null && focusIndex >= 0 && focusIndex < uris.length ? focusIndex : null;
      const oneUri = idx != null ? uris[idx] : uris[0];
      const isOwn = m?.from === currentUserId || m?.sender === 'me';

      if (action === 'save' || action === 'save_one') {
        if (oneUri) await saveAlbumUris([oneUri]);
        return;
      }
      if (action === 'save_all') {
        await saveAlbumUris(uris);
        return;
      }
      if (action === 'forward' || action === 'forward_all') {
        setSelectedMessage(m);
        await openForwardPicker();
        return;
      }
      if (action === 'forward_one') {
        if (!oneUri) return;
        setSelectedMessage({ ...m, uri: oneUri, uris: undefined, __albumForwardOne: true });
        await openForwardPicker();
        return;
      }
      if (action === 'delete_one' && isOwn && isAlbum && idx != null) {
        const next = uris.filter((_, i) => i !== idx);
        if (next.length === 0) {
          confirmDeleteSelectedMessage(m);
          return;
        }
        const r = await updateMessageUris(String(m.id), next);
        if (r?.ok) {
          if (r.deleted) {
            setMessages((prev) => prev.filter((x) => String(x?.id) !== String(m.id)));
          } else {
            setMessages((prev) =>
              prev.map((x) =>
                String(x?.id) === String(m.id)
                  ? {
                      ...x,
                      uri: r.uri || next[0],
                      uris: next.length > 1 ? next : undefined,
                    }
                  : x,
              ),
            );
          }
          showForwardToastBadge(true, t('chatDeleted', lang));
        } else {
          showNotice('error', t('errorTitle', lang), t('saveFailed', lang));
        }
        return;
      }
      if (action === 'delete' || action === 'delete_all') {
        confirmDeleteSelectedMessage(m);
      }
    },
    [
      currentUserId,
      saveAlbumUris,
      openForwardPicker,
      confirmDeleteSelectedMessage,
      showForwardToastBadge,
      showNotice,
      lang,
    ],
  );

  const closeAlbumScope = React.useCallback(() => {
    setAlbumScopeVisible(false);
    albumScopeMessageRef.current = null;
    setAlbumPickUris([]);
    setAlbumPickInitial([0]);
    setAlbumFocusIndex(null);
  }, []);

  const openAlbumScope = React.useCallback(
    (kind: 'save' | 'forward' | 'delete', m: any, focusIndex: number | null) => {
      const uris = getMessageImageUris(m);
      albumScopeMessageRef.current = m;
      setAlbumScopeKind(kind);
      setAlbumPickUris(uris);
      const initial =
        focusIndex != null && focusIndex >= 0 && focusIndex < uris.length
          ? [focusIndex]
          : [0];
      setAlbumPickInitial(initial);
      setAlbumScopeVisible(true);
    },
    [],
  );

  /** Single menu entry → run now, or open multi-select for albums. */
  const requestImageAction = React.useCallback(
    (kind: 'save' | 'forward' | 'delete', m: any, focusIndex: number | null) => {
      if (!m) return;
      const uris = getMessageImageUris(m);
      const isAlbum = uris.length > 1;
      const hasFocus =
        isAlbum && focusIndex != null && focusIndex >= 0 && focusIndex < uris.length;
      const focusForOne = hasFocus ? focusIndex : isAlbum ? 0 : null;
      const isOwn = m?.from === currentUserId || m?.sender === 'me';

      if (kind === 'delete') {
        if (isAlbum && isOwn) {
          openAlbumScope('delete', m, focusForOne);
          return;
        }
        void runSelectedImageAction('delete', m, focusIndex);
        return;
      }
      if (isAlbum) {
        openAlbumScope(kind, m, focusForOne);
        return;
      }
      if (kind === 'save') {
        void runSelectedImageAction('save', m, focusIndex);
        return;
      }
      void runSelectedImageAction('forward', m, focusIndex);
    },
    [currentUserId, openAlbumScope, runSelectedImageAction],
  );

  const applyAlbumPick = React.useCallback(
    async (indices: number[]) => {
      const m = albumScopeMessageRef.current;
      const kind = albumScopeKind;
      const uris = getMessageImageUris(m);
      const pickedIdx = indices.filter((i) => i >= 0 && i < uris.length);
      const picked = pickedIdx.map((i) => uris[i]).filter(Boolean);
      setAlbumScopeVisible(false);
      albumScopeMessageRef.current = null;
      setAlbumPickUris([]);
      setAlbumFocusIndex(null);
      if (!m || !picked.length) return;

      if (kind === 'save') {
        await saveAlbumUris(picked);
        return;
      }
      if (kind === 'forward') {
        if (picked.length === 1) {
          setSelectedMessage({ ...m, uri: picked[0], uris: undefined, __albumForwardOne: true });
        } else {
          setSelectedMessage({
            ...m,
            uri: picked[0],
            uris: picked,
            __albumForwardOne: false,
          });
        }
        await openForwardPicker();
        return;
      }

      // delete
      const isOwn = m?.from === currentUserId || m?.sender === 'me';
      if (!isOwn) {
        confirmDeleteSelectedMessage(m);
        return;
      }
      if (picked.length >= uris.length) {
        confirmDeleteSelectedMessage(m);
        return;
      }
      const removeSet = new Set(pickedIdx);
      const next = uris.filter((_, i) => !removeSet.has(i));
      if (next.length === 0) {
        confirmDeleteSelectedMessage(m);
        return;
      }
      const r = await updateMessageUris(String(m.id), next);
      if (r?.ok) {
        if (r.deleted) {
          setMessages((prev) => prev.filter((x) => String(x?.id) !== String(m.id)));
        } else {
          setMessages((prev) =>
            prev.map((x) =>
              String(x?.id) === String(m.id)
                ? {
                    ...x,
                    uri: r.uri || next[0],
                    uris: next.length > 1 ? next : undefined,
                  }
                : x,
            ),
          );
        }
        showForwardToastBadge(true, t('chatDeleted', lang));
      } else {
        showNotice('error', t('errorTitle', lang), t('saveFailed', lang));
      }
    },
    [
      albumScopeKind,
      saveAlbumUris,
      openForwardPicker,
      currentUserId,
      confirmDeleteSelectedMessage,
      showForwardToastBadge,
      showNotice,
      lang,
    ],
  );

  const handleLongPressMessage = React.useCallback(
    (m: any, layout?: { x: number; y: number; width: number; height: number }, focusIndex: number | null = null) => {
      setSelectedMessage(m);
      setAlbumFocusIndex(focusIndex);
      if (!layout && Platform.OS === 'android') {
        messageActionsLayoutRef.current = null;
      }

      const isOwn = m?.from === currentUserId || m?.sender === 'me';
      const isText = String(m?.type || '') === 'text';
      const isImage = String(m?.type || '') === 'image';
      const showEdit = isOwn && isText;

      const actionIds: string[] = [];
      const options: string[] = [];
      const push = (id: string, label: string) => {
        actionIds.push(id);
        options.push(label);
      };

      if (isText || String(m?.stickerId || '').trim()) {
        push('copy', t('chatActionCopy', lang));
      }
      if (isImage) {
        push('save', t('save', lang));
        push('forward', t('chatActionForward', lang));
      } else {
        push('forward', t('chatActionForward', lang));
      }
      push('select', t('chatActionSelect', lang));
      push('reply', t('chatActionReply', lang));
      if (showEdit) push('edit', t('chatActionEdit', lang));
      push('delete', t('delete', lang));
      push('cancel', t('cancelAction', lang));

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
            if (action === 'cancel') {
              setAlbumFocusIndex(null);
              return;
            }
            if (action === 'reply') {
              setEditingMessageId(null);
              messageTextRef.current = '';
              setMessageText('');
              setReplyingToMessage({
                id: String(m?.id ?? ''),
                text: getChatReplyPreviewText(m, lang),
                from: m?.from,
                isOwn: isOwn,
              });
              setAlbumFocusIndex(null);
              return;
            }
            if (action === 'edit') {
              const text = String(m?.text ?? '');
              messageTextRef.current = text;
              setMessageText(text);
              setEditingMessageId(m?.id ?? null);
              setReplyingToMessage(null);
              setAlbumFocusIndex(null);
              return;
            }
            if (action === 'copy') {
              void copySelectedMessage(m);
              setAlbumFocusIndex(null);
              return;
            }
            if (action === 'select') {
              void enterSelectionModeFromMessage(m, focusIndex);
              setAlbumFocusIndex(null);
              return;
            }
            if (action === 'save' || action === 'forward' || action === 'delete') {
              requestImageAction(action, m, focusIndex);
              return;
            }
          }
        );
        return;
      }

      // Android: штатное меню действий (без Alert)
      showMessageActionsSheet(layout ?? null);
    },
    [
      currentUserId,
      copySelectedMessage,
      showMessageActionsSheet,
      enterSelectionModeFromMessage,
      requestImageAction,
      lang,
    ]
  );

  const handleLongPressAlbumTile = React.useCallback(
    (m: any, index: number, layout?: { x: number; y: number; width: number; height: number }) => {
      handleLongPressMessage(m, layout, index);
    },
    [handleLongPressMessage],
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

  const sendMessage = async () => {
    if (!currentUserId) return;
    setEmojiPanelOpen(false);

    // Во время записи голоса «Отправить» сразу завершает запись и уходит в чат (как отпускание микрофона)
    if (voiceIsRecording) {
      await stopVoiceRecording(false, false);
      return;
    }

    const composerText = messageTextRef.current;
    if (!composerText.trim()) return;

    // Редактирование существующего сообщения
    if (editingMessageId) {
      const newText = composerText.trim();
      messageTextRef.current = '';
      setMessageText('');
      setEditingMessageId(null);
      const result = await editMessage(editingMessageId, newText);
      if (result.ok || result.queued) {
        setMessages((prev) => {
          const updated = prev.map((m) =>
            m.id === editingMessageId ? { ...m, text: newText } : m
          );
          return updated;
        });
      } else {
        messageTextRef.current = newText;
        setMessageText(newText);
        setEditingMessageId(editingMessageId);
      }
      return;
    }

    const messageToSend = composerText.trim();
    const replyTo = replyingToMessage ? { id: replyingToMessage.id, text: replyingToMessage.text, from: replyingToMessage.from, isOwn: replyingToMessage.isOwn } : undefined;
    messageTextRef.current = '';
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
          clientUiMessageId: messageId,
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

        if ((result as any)?.localCancelled) {
          return;
        }
        
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

  const onPressSendButton = React.useCallback(() => {
    if (!messageTextRef.current.trim() && !voiceIsRecording) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      Vibration.vibrate(10);
    }
    setEmojiPanelOpen(false);
    void sendMessage();
  }, [voiceIsRecording, sendMessage]);

  const toggleEmojiPanel = React.useCallback(() => {
    setEmojiPanelOpen((open) => {
      const next = !open;
      if (next) {
        try {
          Keyboard.dismiss();
        } catch {}
      }
      return next;
    });
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      Vibration.vibrate(10);
    }
  }, []);

  /** Тап по пустой области списка / скролл — закрыть клавиатуру и панель эмодзи. */
  const dismissComposerKeyboard = React.useCallback(() => {
    try {
      Keyboard.dismiss();
    } catch {}
    setEmojiPanelOpen(false);
  }, []);

  const handleComposerEmojiSelected = React.useCallback(
    (emoji: EmojiType) => {
      const ch = String(emoji?.emoji || '');
      if (!ch) return;
      setMessageText((prev) => {
        const next = prev + ch;
        messageTextRef.current = next;
        return next;
      });
      signalLocalTyping();
    },
    [signalLocalTyping],
  );

  const handleComposerStickerSelected = React.useCallback(
    (sticker: BuiltInSticker) => {
      if (!sticker?.id) return;
      const replyTo = replyingToMessage
        ? { id: replyingToMessage.id, text: replyingToMessage.text, from: replyingToMessage.from, isOwn: replyingToMessage.isOwn }
        : undefined;
      const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const fallbackText = getStickerFallbackText(sticker, lang);
      setReplyingToMessage(null);
      stopLocalTyping();

      const newMessage = {
        id: messageId,
        text: fallbackText,
        sender: 'me',
        from: currentUserId,
        to: peerId,
        timestamp: new Date(),
        type: 'sticker',
        stickerId: sticker.id,
        stickerPackId: sticker.packId,
        stickerEmoji: sticker.emoji,
        stickerLabel: sticker.label,
        ...(replyTo ? { replyTo } : {}),
      };

      setMessages((prev) => [...prev, newMessage]);
      updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));

      void (async () => {
        try {
          const result = await sendSocketMessage({
            to: peerId,
            text: fallbackText,
            type: 'sticker',
            stickerId: sticker.id,
            stickerPackId: sticker.packId,
            stickerEmoji: sticker.emoji,
            stickerLabel: sticker.label,
            clientUiMessageId: messageId,
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

          if ((result as any)?.localCancelled) return;
          if (!result.ok) throw new Error((result as any).error || 'Failed to send sticker');

          if (currentUserId) clearMessageCache(peerId, currentUserId);
          const deliveryStatus: 'delivered' | 'sent' = result.delivered ? 'delivered' : 'sent';
          updateReadStatuses((prev) => ({ ...prev, [messageId]: deliveryStatus }));

          const serverMessageId = String(result.messageId || '');
          if (serverMessageId && serverMessageId !== messageId) {
            rememberOutboxLocalToServerId(messageId, serverMessageId);
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === messageId
                  ? { ...msg, id: serverMessageId, from: currentUserId, to: peerId }
                  : msg,
              ),
            );
            updateReadStatuses((prev) => {
              const next: Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'> = { ...prev, [serverMessageId]: deliveryStatus };
              delete next[messageId];
              return next;
            });
          }
        } catch (e) {
          console.error('❌ Failed to send sticker via socket:', e);
          updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
          setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
        }
      })();
    },
    [currentUserId, peerId, replyingToMessage, lang, stopLocalTyping, updateReadStatuses],
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
      setShowAttachSheet(true);
    }
  };

  const VOICE_MAX_MS = 60_000;
  // Swipe-left cancel: чувствительнее и шире зона корзины — меньше «промахов»
  const VOICE_CANCEL_ARM_DX = -12;
  const VOICE_CANCEL_DISARM_DX = -4;
  const VOICE_TRASH_PAD = 34;

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

  const resetVoiceGesture = React.useCallback((opts?: { keepVoiceDrag?: boolean }) => {
    cancelArmedRef.current = false;
    voiceCancelTriggeredRef.current = false;
    if (!opts?.keepVoiceDrag) voiceDragEnabledRef.current = false;
    try { voiceDragX.setValue(0); } catch {}
    try { trashLid.setValue(0); } catch {}
    try { trashFlash.setValue(0); } catch {}
    Animated.timing(micScale, { toValue: 1, duration: 44, useNativeDriver: true }).start();
  }, [voiceDragX, trashLid, trashFlash, micScale]);

  const armCancelUI = React.useCallback(() => {
    if (cancelArmedRef.current) return;
    cancelArmedRef.current = true;
    try { trashLid.setValue(1); } catch {}
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
  }, [trashLid]);

  const disarmCancelUI = React.useCallback(() => {
    if (!cancelArmedRef.current) return;
    cancelArmedRef.current = false;
    try { trashLid.setValue(0); } catch {}
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
        void enqueueMediaOutboxId(messageId);
        return;
      }

      const socketResult: any = await sendSocketMessage({
        to: peerId,
        type: 'audio',
        uri: uploadResult.url,
        name,
        size,
        duration: durationSec,
        clientUiMessageId: messageId,
      });

      if (socketResult?.localCancelled) {
        updateReadStatuses((prev) => {
          const n = { ...prev };
          delete (n as any)[messageId];
          return n as any;
        });
        setUploadStatus((prev) => {
          const n = { ...prev };
          delete (n as any)[messageId];
          return n;
        });
        try { await FileSystem.deleteAsync(localFileForCleanup, { idempotent: true }); } catch {}
        void dequeueMediaOutboxId(messageId);
        return;
      }

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
        void enqueueMediaOutboxId(messageId);
      }
    } catch {
      updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
      setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
      void enqueueMediaOutboxId(messageId);
    } finally {
      setVoiceRecordMs(0);
    }
  }, [currentUserId, peerId, resolveMediaUri, updateReadStatuses, enqueueMediaOutboxId]);

  const startVoiceRecording = React.useCallback(async () => {
    try {
      if (voiceIsRecording) return;
      if (!currentUserId || !peerId) {
        resetVoiceGesture();
        return;
      }
      if (selectionMode) {
        resetVoiceGesture();
        return;
      }
      resetVoiceGesture({ keepVoiceDrag: true });

      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        // If we already signaled recording on press-in, stop it on permission denial.
        try { stopLocalRecordingSignal(); } catch {}
        resetVoiceGesture();
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
      }, 100);
    } catch {
      setVoiceIsRecording(false);
      voiceRecordingRef.current = null;
      try { stopLocalRecordingSignal(); } catch {}
      resetVoiceGesture();
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
          try { void FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
        }
        setVoiceRecordMs(0);
        return;
      }

      if (cancelled || voiceCancelTriggeredRef.current) {
        try { void FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
        setVoiceRecordMs(0);
        return;
      }

      if (autoStopped) {
        try { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch {}
      } else {
        try { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      }

      // Размер не блокирует старт отправки (upload и так знает файл)
      void sendVoiceMessageFromLocal(uri, durationMs, undefined).catch(() => {});
    } catch {
      // ignore
    } finally {
      voiceStopInProgressRef.current = false;
      resetVoiceGesture();
      try {
        void Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          // Back to normal playback mode after recording (prevents voice playback going through earpiece).
          allowsRecordingIOS: false,
          staysActiveInBackground: false,
          shouldDuckAndroid: false,
          playThroughEarpieceAndroid: false,
        });
      } catch {}
    }
  }, [voiceRecordMs, sendVoiceMessageFromLocal, resetVoiceGesture]);

  const cancelVoiceRecordingWithAnimation = React.useCallback(async () => {
    if (voiceCancelTriggeredRef.current) return;
    voiceCancelTriggeredRef.current = true;

    try { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch {}
    await stopVoiceRecording(true, false);
    showForwardToastBadge(false, t('chatDeleted', lang));
  }, [stopVoiceRecording, showForwardToastBadge, lang]);

  const micPanResponder = React.useMemo(() => {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (_evt, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
      onMoveShouldSetPanResponderCapture: (_evt, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        voiceDragEnabledRef.current = true;
        try {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } catch {}
        Animated.timing(micScale, { toValue: 0.9, duration: 40, useNativeDriver: true }).start();
        // snapshot start point (helps debug / stability)
        try {
          voiceStartXRef.current = 0;
          voiceStartYRef.current = 0;
        } catch {}
        // measure trash zone after it renders
        requestAnimationFrame(() => updateTrashZone());
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
        if (!voiceDragEnabledRef.current) return;
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
        Animated.timing(micScale, { toValue: 1, duration: 44, useNativeDriver: true }).start();
        if (!voiceRecordingRef.current) {
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
        Animated.timing(micScale, { toValue: 1, duration: 44, useNativeDriver: true }).start();
        if (voiceRecordingRef.current) {
          await stopVoiceRecording(true, false);
        }
        resetVoiceGesture();
      },
    });
  }, [PanResponder, micScale, startVoiceRecording, voiceIsRecording, voiceDragX, armCancelUI, disarmCancelUI, resetVoiceGesture, stopVoiceRecording, cancelVoiceRecordingWithAnimation, isInTrashZone, updateTrashZone]);

  const sendPickedImage = React.useCallback(async (asset: any): Promise<boolean> => {
    if (!currentUserId || !peerId) return false;

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
        void enqueueMediaOutboxId(messageId);
        return false;
      }

      const socketResult: any = await sendSocketMessage({
        to: peerId,
        type: messageType,
        uri: uploadResult.url,
        name: fileName || undefined,
        size: fileSize || undefined,
        clientUiMessageId: messageId,
      });

      if (socketResult?.localCancelled) {
        updateReadStatuses((prev) => {
          const n = { ...prev };
          delete (n as any)[messageId];
          return n as any;
        });
        setUploadStatus((prev) => {
          const n = { ...prev };
          delete (n as any)[messageId];
          return n;
        });
        void dequeueMediaOutboxId(messageId);
        return false;
      }

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
        return true;
      } else {
        console.warn('❌ Socket send failed:', socketResult);
        updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
        setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
        void enqueueMediaOutboxId(messageId);
        return false;
      }
    } catch (e) {
      console.error('Failed to upload and send media:', e);
      updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
      setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
      void enqueueMediaOutboxId(messageId);
      return false;
    }
  }, [currentUserId, peerId, updateReadStatuses, resolveMediaUri, enqueueMediaOutboxId, dequeueMediaOutboxId]);

  /** Send 2…10 photos as one album message. */
  const sendPickedAlbum = React.useCallback(async (assets: any[]): Promise<boolean> => {
    if (!currentUserId || !peerId) return false;
    const list = (Array.isArray(assets) ? assets : []).slice(0, CHAT_ALBUM_MAX);
    if (list.length < 2) {
      if (list[0]) return sendPickedImage(list[0]);
      return false;
    }

    const messageId = Date.now().toString();
    const localUris = list.map((a) => String(a?.uri || '').trim()).filter(Boolean);
    if (localUris.length < 2) return false;

    const newMessage = {
      id: messageId,
      type: 'image' as const,
      uri: localUris[0],
      uris: localUris,
      name: list[0]?.fileName || `album_${Date.now()}`,
      size: list.reduce((s, a) => s + (Number(a?.fileSize) || 0), 0),
      sender: 'me',
      from: currentUserId,
      to: peerId,
      timestamp: new Date(),
    };

    setMessages((prev) => {
      if (prev.find((msg) => msg.id === messageId)) return prev;
      return [...prev, newMessage];
    });
    updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));
    setUploadStatus((prev) => ({ ...prev, [messageId]: 'sending' }));

    try {
      const remoteUris: string[] = [];
      for (let i = 0; i < list.length; i++) {
        const localUri = String(list[i]?.uri || '').trim();
        if (!localUri) continue;
        const uploadResult = await uploadMediaToServer(localUri, 'image', undefined, currentUserId, peerId);
        if (!uploadResult.success || !uploadResult.url) {
          updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
          setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
          void enqueueMediaOutboxId(messageId);
          return false;
        }
        remoteUris.push(uploadResult.url);
      }
      if (remoteUris.length < 2) {
        updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
        setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
        return false;
      }

      const resolvedUris = remoteUris.map((u) => resolveMediaUri(u) || u);
      const socketResult: any = await sendSocketMessage({
        to: peerId,
        type: 'image',
        uri: remoteUris[0],
        uris: remoteUris,
        name: list[0]?.fileName || undefined,
        size: list.reduce((s, a) => s + (Number(a?.fileSize) || 0), 0) || undefined,
        clientUiMessageId: messageId,
      });

      if (socketResult?.localCancelled) {
        updateReadStatuses((prev) => {
          const n = { ...prev };
          delete (n as any)[messageId];
          return n as any;
        });
        setUploadStatus((prev) => {
          const n = { ...prev };
          delete (n as any)[messageId];
          return n;
        });
        void dequeueMediaOutboxId(messageId);
        return false;
      }

      if (socketResult.ok && socketResult.messageId) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId
              ? {
                  ...msg,
                  id: socketResult.messageId!,
                  uri: resolvedUris[0],
                  uris: resolvedUris,
                  from: currentUserId,
                  to: peerId,
                }
              : msg,
          ),
        );
        setUploadStatus((prev) => {
          const newStatus = { ...prev };
          newStatus[socketResult.messageId!] = 'sent';
          delete newStatus[messageId];
          return newStatus;
        });
        updateReadStatuses((prev) => {
          const newStatuses = { ...prev };
          newStatuses[socketResult.messageId!] = socketResult.delivered ? 'delivered' : 'sent';
          delete newStatuses[messageId];
          return newStatuses;
        });
        return true;
      }

      updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
      setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
      void enqueueMediaOutboxId(messageId);
      return false;
    } catch (e) {
      console.error('Failed to upload and send album:', e);
      updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
      setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
      void enqueueMediaOutboxId(messageId);
      return false;
    }
  }, [currentUserId, peerId, sendPickedImage, updateReadStatuses, resolveMediaUri, enqueueMediaOutboxId, dequeueMediaOutboxId]);

  const uploadRawShareFile = React.useCallback(async (localUri: string) => {
    const installId = await getInstallId().catch(() => '');
    const normalizedUri = localUri.startsWith('file://') ? localUri : `file://${localUri}`;
    try {
      const mpUrl = `${API_BASE}/api/upload/media/multipart`;
      const mpRes = await FileSystem.uploadAsync(mpUrl, normalizedUri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'file',
        headers: {
          ...(installId ? { 'x-install-id': String(installId) } : {}),
        },
      });
      if (mpRes.status >= 200 && mpRes.status < 300) {
        let json: { ok?: boolean; url?: string; secure_url?: string } | null = null;
        try {
          json = JSON.parse(mpRes.body || '{}');
        } catch {
          json = null;
        }
        if (json?.ok && (json.url || json.secure_url)) {
          return json.url || json.secure_url || '';
        }
      }
    } catch {
      // ignore
    }
    return '';
  }, []);

  const sendIncomingShareInChat = React.useCallback(
    async (items: IncomingShareItem[]): Promise<number> => {
      if (!currentUserId || !peerId || !items?.length) return 0;
      let sent = 0;
      for (const item of items) {
        if (item.kind === 'image' && item.uri) {
          const ok = await sendPickedImage({
            uri: item.uri,
            fileName: item.name || `file_${Date.now()}`,
            fileSize: item.size || 0,
          });
          if (ok) sent += 1;
          continue;
        }
        if (item.kind === 'text') {
          const text = String(item.text || '').trim();
          if (!text) continue;
          const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          setMessages((prev) => [
            ...prev,
            {
              id: messageId,
              text,
              sender: 'me',
              from: currentUserId,
              to: peerId,
              timestamp: new Date(),
              type: 'text',
            },
          ]);
          updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));
          const result: any = await sendSocketMessage({
            to: peerId,
            text,
            type: 'text',
            clientUiMessageId: messageId,
          });
          if (result?.localCancelled) continue;
          if (result?.ok) {
            sent += 1;
            const deliveryStatus = result.delivered ? 'delivered' : 'sent';
            if (result.messageId && result.messageId !== messageId) {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === messageId
                    ? { ...msg, id: result.messageId, from: currentUserId, to: peerId }
                    : msg,
                ),
              );
              updateReadStatuses((prev) => {
                const next = { ...prev };
                next[result.messageId] = deliveryStatus;
                delete next[messageId];
                return next;
              });
            } else {
              updateReadStatuses((prev) => ({ ...prev, [messageId]: deliveryStatus }));
            }
          } else {
            updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
          }
          continue;
        }
        const localUri = String(item.uri || '').trim();
        if (!localUri) continue;
        if (item.kind === 'audio') {
          const messageId = Date.now().toString();
          const fileName = item.name || `voice_${Date.now()}.m4a`;
          const fileSize = item.size || 0;
          setMessages((prev) => [
            ...prev,
            {
              id: messageId,
              type: 'audio',
              uri: localUri,
              name: fileName,
              size: fileSize,
              sender: 'me',
              from: currentUserId,
              to: peerId,
              timestamp: new Date(),
            },
          ]);
          updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));
          setUploadStatus((prev) => ({ ...prev, [messageId]: 'sending' }));
          const upload = await uploadMediaToServer(localUri, 'audio', undefined, currentUserId, peerId);
          if (!upload.success || !upload.url) {
            updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
            setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
            continue;
          }
          const socketResult: any = await sendSocketMessage({
            to: peerId,
            type: 'audio',
            uri: upload.url,
            name: fileName,
            size: fileSize,
            clientUiMessageId: messageId,
          });
          if (socketResult?.ok && socketResult.messageId) {
            sent += 1;
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === messageId
                  ? {
                      ...msg,
                      id: socketResult.messageId,
                      uri: resolveMediaUri(upload.url),
                      from: currentUserId,
                      to: peerId,
                    }
                  : msg,
              ),
            );
            const delivery = socketResult.delivered ? 'delivered' : 'sent';
            updateReadStatuses((prev) => {
              const next = { ...prev };
              next[socketResult.messageId] = delivery;
              delete next[messageId];
              return next;
            });
            setUploadStatus((prev) => {
              const next = { ...prev };
              next[socketResult.messageId] = 'sent';
              delete next[messageId];
              return next;
            });
          } else {
            updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
            setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
          }
          continue;
        }
        if (item.kind === 'document') {
          const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          const label = item.name ? `📎 ${item.name}` : '📎';
          setMessages((prev) => [
            ...prev,
            {
              id: messageId,
              text: label,
              sender: 'me',
              from: currentUserId,
              to: peerId,
              timestamp: new Date(),
              type: 'text',
            },
          ]);
          updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));
          const remoteUrl = await uploadRawShareFile(localUri);
          if (!remoteUrl) {
            updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
            continue;
          }
          const text = `${label}\n${remoteUrl}`;
          setMessages((prev) =>
            prev.map((msg) => (msg.id === messageId ? { ...msg, text } : msg)),
          );
          const result: any = await sendSocketMessage({
            to: peerId,
            type: 'text',
            text,
            clientUiMessageId: messageId,
          });
          if (result?.ok) {
            sent += 1;
            const deliveryStatus = result.delivered ? 'delivered' : 'sent';
            if (result.messageId && result.messageId !== messageId) {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === messageId
                    ? { ...msg, id: result.messageId, text, from: currentUserId, to: peerId }
                    : msg,
                ),
              );
              updateReadStatuses((prev) => {
                const next = { ...prev };
                next[result.messageId] = deliveryStatus;
                delete next[messageId];
                return next;
              });
            } else {
              updateReadStatuses((prev) => ({ ...prev, [messageId]: deliveryStatus }));
            }
          } else {
            updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
          }
        }
      }
      return sent;
    },
    [currentUserId, peerId, sendPickedImage, updateReadStatuses, resolveMediaUri, uploadRawShareFile],
  );

  React.useEffect(() => {
    const items = route?.params?.incomingShareItems;
    if (!items?.length || !currentUserId || !peerId) return;
    const key = `${peerId}:${items.length}:${items[0]?.uri || items[0]?.text || ''}`;
    if (incomingShareHandledRef.current === key) return;
    incomingShareHandledRef.current = key;
    let cancelled = false;
    (async () => {
      const sent = await sendIncomingShareInChat(items);
      if (cancelled) return;
      try {
        navigation.setParams({ incomingShareItems: undefined });
      } catch {
        // ignore
      }
      showForwardToastBadge(sent > 0, sent > 0 ? t('chatSent', lang) : t('chatSendFailed', lang));
      if (sent > 0) {
        scheduleScrollToBottom(0);
        setTimeout(() => scrollToBottom(), 80);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    route?.params?.incomingShareItems,
    currentUserId,
    peerId,
    navigation,
    sendIncomingShareInChat,
    showForwardToastBadge,
    lang,
  ]);

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

  // Только высота: индикатор «пишет…» вынесен в absolute-overlay ниже, чтобы ListHeaderComponent
  // не пересоздавался каждые ~420ms (анимация точек) — иначе FlatList перелayout и тапы по отправке теряются.
  const androidListHeader = React.useMemo(() => {
    if (isEmpty) return null;
    return (
      <View
        pointerEvents="box-none"
        style={{
          // Spacer so the last message doesn't hide under the input bar (and the keyboard on devices without resize).
          height: Math.max(inputHeight, estimatedInputHeight) + TYPING_GAP_H + composerBottomLift,
        }}
      />
    );
  }, [isEmpty, inputHeight, estimatedInputHeight, composerBottomLift]);

  const renderMessageRow = React.useCallback(
    ({ item }: { item: ChatListRow }) => {
      if (item.type === 'date') {
        return (
          <View style={{ paddingTop: 10, paddingBottom: 6, alignItems: 'center' }}>
            <Text
              style={{
                fontSize: 12,
                fontWeight: '300',
                color: LIVI.text,
                textAlign: 'center',
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
      <View
        style={{ flex: 1, backgroundColor: LIVI.feedBg }}
        // Не блокируем весь экран pointerEvents='none': на Android это иногда "съедало" первый тап.
        pointerEvents="auto"
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
              data={iosChatListData}
              keyExtractor={(item) => item.id}
              renderItem={renderMessageRow}
              style={{ flex: 1 }}
              contentContainerStyle={{ 
                flexGrow: 1,
                justifyContent: showEmpty ? 'center' : 'flex-end',
                paddingVertical: 16,
                paddingBottom: 12,
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
                    transform: [{ scale: micScale }],
                    backgroundColor: voiceIsRecording ? LIVI.titan : 'rgba(255,255,255,0.2)',
                    borderRadius: 14,
                    borderWidth: 1,
                    borderColor: BORDER_COLOR,
                    padding: 6,
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
                    backgroundColor:
                      messageText.trim() || voiceIsRecording
                        ? LIVI.titan
                        : 'rgba(255,255,255,0.2)',
                    borderRadius: 14,
                    padding: 6,
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
          // Android: полагаемся на adjustResize (MainActivity windowSoftInputMode=adjustResize)
          (<View style={{ flex: 1 }}>
            {/** Если система уже "ужала" окно, поднимаем только остаток (без двойного подъёма). */}
            <FlatList
              ref={flatListRef}
              data={androidChatListData}
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
              keyboardDismissMode="on-drag"
              onScrollBeginDrag={dismissComposerKeyboard}
              removeClippedSubviews={false}
              inverted={!showEmpty}
              onScrollToIndexFailed={handleScrollToIndexFailed}
              initialNumToRender={CHAT_LIST_INITIAL_NUM_TO_RENDER}
              maxToRenderPerBatch={CHAT_LIST_MAX_TO_RENDER_PER_BATCH}
              windowSize={CHAT_LIST_WINDOW_SIZE}
              updateCellsBatchingPeriod={CHAT_LIST_UPDATE_CELLS_BATCHING_PERIOD}
              ListHeaderComponent={androidListHeader}
              ListEmptyComponent={() => {
                if (!chatFeedReady) {
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
                  bottom: composerBottomLift + (inputHeight > 0 ? inputHeight : 96) + 8,
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
                  bottom:
                    composerBottomLift +
                    Math.max(inputHeight > 0 ? inputHeight : estimatedInputHeight, 72) +
                    4,
                  alignItems: 'center',
                  zIndex: 8,
                  elevation: 8,
                }}
              >
                {GapCenterIndicator}
              </View>
            ) : null}

            {emojiPanelOpen ? (
              <View
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: CHAT_EMOJI_PANEL_HEIGHT,
                  zIndex: 15,
                  elevation: 15,
                  backgroundColor: INPUT_BAR_BG,
                  borderTopWidth: BORDER_WIDTH,
                  borderTopColor: BORDER_COLOR,
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
            {/* Поле ввода для Android: поднимаем над клавиатурой, если система не ресайзит окно */}
            <View
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: composerBottomLift,
                zIndex: 20,
                elevation: 20,
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
                    transform: [{ scale: micScale }],
                    backgroundColor: voiceIsRecording ? LIVI.titan : 'rgba(255,255,255,0.2)',
                    borderRadius: 14,
                    borderWidth: 1,
                    borderColor: BORDER_COLOR,
                    padding: 6,
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
                    backgroundColor:
                      messageText.trim() || voiceIsRecording ? LIVI.titan : 'rgba(255,255,255,0.2)',
                    borderRadius: 14,
                    padding: 6,
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