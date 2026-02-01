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
  Animated,
  Vibration,
  NativeModules,
  Dimensions,
  Image,
} from "react-native";
 
import { useSafeAreaInsets, SafeAreaView } from "react-native-safe-area-context";
import { onCloseIncoming, emitCloseIncoming } from '../utils/globalEvents';
import socket from '../sockets/socket';
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../theme/ThemeProvider";
import { Image as ExpoImage } from "expo-image";
import AvatarImage from "../components/AvatarImage";
import * as Haptics from 'expo-haptics';
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
  getAvatar,
} from "../sockets/socket";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLang } from "../store/lang";
import { t } from "../utils/i18n";

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
  const [showDeleteIndicator, setShowDeleteIndicator] = useState(false);
  const deleteModalOpacity = useRef(new Animated.Value(0)).current;
  const deleteModalScale = useRef(new Animated.Value(0.8)).current;

  // Анимации для сообщений
  const messagePressAnimations = useRef<Record<string, Animated.Value>>({}).current;

  // Состояние для полноэкранного просмотра медиа
  const [mediaViewerVisible, setMediaViewerVisible] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<{
    type: 'image';
    uri: string;
    name?: string;
  } | null>(null);

  // Состояние для предпросмотра выбранного фото перед отправкой (без лишних Alert/ActionSheet)
  const [composeViewerVisible, setComposeViewerVisible] = useState(false);
  const [composeAsset, setComposeAsset] = useState<any>(null);



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

  const TypingIndicator = React.useMemo(() => {
    if (!peerTyping) return null;
    const color = isDark ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.40)';
    return (
      <View pointerEvents="none" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <Text
          style={{
            color,
            fontSize: 13,
            fontStyle: 'italic',
            fontWeight: '500',
            letterSpacing: 0.2,
          }}
        >
          {`Печатает${'.'.repeat(peerTypingDots)}`}
        </Text>
      </View>
    );
  }, [peerTyping, peerTypingDots, isDark]);

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
              logger.info('[ChatScreen] Loading image message from history', {
                messageId: msg.id,
                from: msg.from,
                to: msg.to,
                uri: msg.uri,
                resolvedUri: resolveMediaUri(msg.uri),
                hasUri: !!msg.uri,
              });
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
  // КРИТИЧНО: firstLetter используется ТОЛЬКО для аватара (headerInitial), НЕ для текста
  // Для текста используем peerNameState (полный никнейм)
  const firstLetter = (s?: string) => (s?.trim()?.[0] || '').toUpperCase();
  const [peerNameState, setPeerNameState] = useState<string>(peerNameParam);
  const headerInitial = peerNameState ? firstLetter(peerNameState) : '--'; // Только для аватара!
  const headerPlaceholder = '--'; // Всегда показываем -- если нет аватара

  // КРИТИЧНО: Header нельзя объявлять как "новую функцию" на каждый рендер,
  // иначе шапка (и аватар) будут размонтироваться на каждый ввод в TextInput.
  const Header = React.useCallback(() => (
    <View
      style={{
        // КРИТИЧНО: Не добавляем paddingTop, так как SafeAreaView уже обрабатывает safe area
        // Используем одинаковую высоту для iOS и Android для единообразного стиля
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
        onPress={() => navigation.goBack()}
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
        <Ionicons name="arrow-back" size={20} color={LIVI.titan} />
      </TouchableOpacity>

      <View style={{ flex: 1, alignItems: "center" }}>
        <Text style={{ color: LIVI.white, fontSize: 18, fontWeight: "700" }}>
          {peerNameState}
        </Text>
        <Text
          style={{
            marginTop: 2,
            fontSize: 12,
            color: peerOnline ? LIVI.green : LIVI.red,
            fontWeight: "600",
          }}
        >
          {peerOnline ? "Online" : "Offline"}
        </Text>
      </View>

      <AvatarImage
        userId={peerId}
        avatarVer={peerAvatarVerState}
        uri={fullAvatarUri || undefined}
        size={36}
        fallbackText={headerInitial}
        containerStyle={{ backgroundColor: 'rgba(255,255,255,0.12)' }}
      />
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
  ]);

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

  const openClearMenu = () => {
    setShowClearMenu(true);
  };

  const clearChatForMe = async () => {
    if (!currentUserId || !peerId) return;
    
    Alert.alert(
      t('chatClearMineTitle', lang),
      t('chatClearMineMsg', lang),
      [
        { text: t('cancel', lang), style: "cancel" },
        { 
          text: t('delete', lang), 
          style: "destructive",
          onPress: async () => {
            // Сразу очищаем локальные сообщения у инициатора
            setMessages([]);
            clearMessageCache(peerId, currentUserId);

            // Очищаем AsyncStorage у инициатора
            const chatKey = globalMessageStorage.getChatKey(currentUserId, peerId);
            await AsyncStorage.removeItem(chatKey);

            // Отправляем запрос на сервер для очистки только у себя
            const success = await clearChatMessages(peerId, false);
            if (success) {
              Alert.alert(t('successTitle', lang), t('chatClearedMineSuccess', lang));
            } else {
              Alert.alert(t('errorTitle', lang), t('chatClearFailedServer', lang));
            }
          }
        }
      ]
    );
  };

  const clearChatForAll = async () => {
    if (!currentUserId || !peerId) return;
    
    Alert.alert(
      t('chatClearAllTitle', lang),
      t('chatClearAllMsg', lang),
      [
        { text: t('cancel', lang), style: "cancel" },
        { 
          text: t('delete', lang), 
          style: "destructive",
          onPress: async () => {
            // Сразу очищаем локальные сообщения у инициатора
            setMessages([]);
            clearMessageCache(peerId, currentUserId);

            // Очищаем AsyncStorage у инициатора
            const chatKey = globalMessageStorage.getChatKey(currentUserId, peerId);
            await AsyncStorage.removeItem(chatKey);

            // Отправляем запрос на сервер для очистки у обоих пользователей
            const success = await clearChatMessages(peerId, true);
            if (success) {
              Alert.alert(t('successTitle', lang), t('chatClearedAllSuccess', lang));
            } else {
              Alert.alert(t('errorTitle', lang), t('chatClearFailedServer', lang));
            }
          }
        }
      ]
    );
  };


  const deleteSingleMessage = async (messageId: string) => {
    const success = await deleteMessage(messageId);
    if (success) {
      setMessages(prev => prev.filter(msg => msg.id !== messageId));
    } else {
      Alert.alert(t('errorTitle', lang), t('chatDeleteMessageFailed', lang));
    }
  };

  const showDeleteModal = React.useCallback(() => {
    setShowDeleteIndicator(true);
    
    // Мягкая вибрация для появления модального окна
    if (Platform.OS === 'ios') {
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      } catch (error) {
        Vibration.vibrate(5);
      }
    } else {
      Vibration.vibrate(40);
    }
    
    // Сброс значений анимации
    deleteModalOpacity.setValue(0);
    deleteModalScale.setValue(0.7);
    
    Animated.parallel([
      Animated.timing(deleteModalOpacity, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.spring(deleteModalScale, {
        toValue: 1,
        tension: 120,
        friction: 7,
        useNativeDriver: true,
      }),
    ]).start();
  }, [deleteModalOpacity, deleteModalScale]);

  const hideDeleteModal = React.useCallback(() => {
    Animated.parallel([
      Animated.timing(deleteModalOpacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(deleteModalScale, {
        toValue: 0.7,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setShowDeleteIndicator(false);
      setSelectedMessage(null);
    });
  }, [deleteModalOpacity, deleteModalScale]);

  // Stable handler to avoid re-rendering all MessageItem rows on parent re-renders
  const handleLongPressMessage = React.useCallback(
    (m: any) => {
      setSelectedMessage(m);
      showDeleteModal();
    },
    [showDeleteModal]
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
      Alert.alert(
        t('attachFileTitle', lang),
        t('attachFileMsg', lang),
        [
          { text: t('takePhoto', lang), onPress: handleCamera },
          { text: t('chooseFromGallery', lang), onPress: handleImagePicker },
          { text: t('cancel', lang), style: 'cancel' }
        ]
      );
    }
  };

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
        Alert.alert(t('errorTitle', lang), t('needCameraPermission', lang));
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
      Alert.alert(t('errorTitle', lang), t('takePhotoFailed', lang));
    }
  };

  const handleImagePicker = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(t('errorTitle', lang), t('needGalleryPermission', lang));
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
      Alert.alert(t('errorTitle', lang), t('pickImageFailed', lang));
    }
  };


  // КРИТИЧНО: если MessageItem создаётся внутри ChatScreen без мемоизации типа компонента,
  // то при каждом setMessageText FlatList будет размонтировать/монтировать все элементы -> мерцание всех картинок.
  const MessageItem = React.useMemo(() => React.memo(({ item, currentUserId, readStatus, uploadStatus, onPressImage, onLongPressMessage }: any) => {
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
          
        case 'failed':
          // Не доставлено - красный кружок с восклицательным знаком
          return (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 2 }}>
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
            </View>
          );
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

    return (
      <Animated.View
        style={{
          transform: [{ scale: messageAnimation }],
          marginHorizontal: 16,
          marginVertical: 4,
          alignSelf: isMyMessage ? 'flex-end' : 'flex-start',
          maxWidth: '80%',
        }}
      >
        <TouchableOpacity
          onPress={() => {
            animateMessagePress(item.id);
          }}
          onLongPress={() => {
            if (isMyMessage) {
              animateMessagePress(item.id, () => {
                onLongPressMessage(item);
              });
            }
          }}
          activeOpacity={0.7}
          style={{
            padding: 12,
            backgroundColor: isMyMessage ? BUBBLE_BG_OUT : BUBBLE_BG_IN,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: BORDER_COLOR,
          }}
        >
        {/* Основной контент */}
        {renderContent()}
        
        {/* Текст сообщения (если есть) */}
        {item.type === 'text' && (
          <Text style={{ 
            color: LIVI.white, 
            fontSize: 16, 
            marginBottom: 8,
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
          marginTop: item.type !== 'text' ? 4 : 2,
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
      </Animated.View>
    );
  }), [
    resolveMediaUri,
    animateMessagePress,
    getMessageAnimation,
    BUBBLE_BG_OUT,
    BUBBLE_BG_IN,
    BORDER_COLOR,
    LIVI.white,
    LIVI.titan,
    LIVI.red,
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
      onLongPressMessage={handleLongPressMessage}
    />
  ), [MessageItem, currentUserId, readStatuses, uploadStatus, openMediaViewer, handleLongPressMessage]);

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
                justifyContent: isEmpty ? 'center' : 'flex-end',
                paddingVertical: 16,
                paddingBottom: 12,
              }}
              ListFooterComponent={TypingIndicator ? (
                <View style={{ height: 24, justifyContent: 'center', alignItems: 'center' }}>
                  {TypingIndicator}
                </View>
              ) : null}
              showsVerticalScrollIndicator={false}
              inverted={false}
              onContentSizeChange={() => setTimeout(() => scrollToBottom(), 0)}
              ListEmptyComponent={() => (
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
              )}
            />
            {/* Поле ввода для iOS */}
            <View
              style={{
                borderTopWidth: BORDER_WIDTH,
                borderTopColor: BORDER_COLOR,
                backgroundColor: LIVI.bg,
                paddingHorizontal: 16,
                paddingTop: 18,
                // КРИТИЧНО: Используем одинаковый paddingBottom для iOS и Android для единообразного стиля
                // SafeAreaView уже обрабатывает safe area, поэтому не добавляем insets.bottom
                paddingBottom: 26,
              }}
              onLayout={(e) => setInputHeight(e.nativeEvent.layout.height)}
            >
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
                <TouchableOpacity
                  onPress={handleAttachments}
                  style={{
                    padding: 2,
                    marginRight: 12,
                  }}
                >
                  <Ionicons name="image" size={28} color={LIVI.titan} />
                </TouchableOpacity>

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
                />

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
              inverted={!isEmpty}
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
                  {TypingIndicator ? (
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
                      {TypingIndicator}
                    </View>
                  ) : null}
                </View>
              ) : null}
              ListEmptyComponent={() => (
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
              )}
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
                paddingBottom: 22 + (keyboardVisible ? 0 : Math.max(0, insets.bottom)),
              }}
              onLayout={(e) => setInputHeight(e.nativeEvent.layout.height)}
            >
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
                <TouchableOpacity
                  onPress={handleAttachments}
                  style={{
                    padding: 2,
                    marginRight: 12,
                  }}
                >
                  <Ionicons name="image" size={28} color={LIVI.titan} />
                </TouchableOpacity>

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
                />

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
      {/* Модальное окно для удаления сообщения */}
      {showDeleteIndicator && selectedMessage && (
        <Animated.View style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.6)',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1001,
          opacity: deleteModalOpacity,
        }}>
          <Animated.View style={{
            backgroundColor: LIVI.surface,
            borderRadius: 16,
            padding: 20,
            margin: 18,
            minWidth: 200,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.15)',
            transform: [{ scale: deleteModalScale }],
            alignItems: 'center',
            shadowColor: '#000',
            shadowOffset: {
              width: 0,
              height: 6,
            },
            shadowOpacity: 0.25,
            shadowRadius: 8,
            elevation: 6,
          }}>
            <Text style={{
              color: LIVI.white,
              fontSize: 16,
              fontWeight: '700',
              textAlign: 'center',
              marginBottom: 18,
            }}>
              Удалить сообщение?
            </Text>
            
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 22 }}>
             {/* Cancel (X) */}
              <TouchableOpacity
                onPress={hideDeleteModal}
                activeOpacity={0.85}
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: isDark
                    ? 'rgba(255,255,255,0.08)'     // тёмная тема — как было
                    : 'rgba(0,0,0,0.09)',          // светлая — чуть темнее фон
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 1,
                  borderColor: isDark
                    ? 'rgba(255,255,255,0.2)'
                    : 'rgba(0,0,0,0.1)',
                }}
              >
                <Ionicons
                  name="close"
                  size={22}
                  color={isDark ? LIVI.white : 'rgba(0,0,0,0.8)'}
                />
              </TouchableOpacity>
              
              {/* Confirm (check) */}
              <TouchableOpacity
                onPress={() => {
                  hideDeleteModal();
                  deleteSingleMessage(selectedMessage.id);
                }}
                activeOpacity={0.85}
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: 'rgba(71, 207, 115, 0.18)',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 2,
                  borderColor: 'rgba(71, 207, 115, 0.35)'
                }}
              >
                <Ionicons name="checkmark" size={22} color="#47CF73" />
              </TouchableOpacity>
            </View>
          </Animated.View>
        </Animated.View>
      )}
    </SafeAreaView>
  );
}