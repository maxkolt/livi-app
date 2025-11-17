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
} from "react-native";
 
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { CometChat } from "@cometchat/chat-sdk-react-native";
import { 
  getMyUserId,
  sendMessage as sendSocketMessage,
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

  // Android: красим системную нижнюю панель в цвет текущего экрана,
  // чтобы убрать синюю полосу поверх контента (светлая/тёмная темы)
  useEffect(() => {
    (async () => {
      if (Platform.OS !== 'android' || !(NativeModules as any)?.ExpoNavigationBar) return;
      try {
        const NavigationBar = await import('expo-navigation-bar');
        await NavigationBar.setBackgroundColorAsync(theme.colors.background as string);
        try { await NavigationBar.setButtonStyleAsync(isDark ? 'light' : 'dark'); } catch {}
        try { await NavigationBar.setBehaviorAsync('inset-swipe'); } catch {}
        try { await NavigationBar.setPositionAsync('relative'); } catch {}
        try { await NavigationBar.setVisibilityAsync('visible'); } catch {}
      } catch {}
    })();
  }, [theme.colors.background, isDark]);

  // Загружаем профиль при инициализации
  useEffect(() => {
    (async () => {
      try {
        const profileResponse = await getMyProfile();
        if (profileResponse?.ok && profileResponse.profile) {
          const profile = profileResponse.profile;
          logger.debug('Loaded profile on init', { nick: profile.nick, hasAvatar: !!profile.avatarB64 });
          
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

  const LIVI = {
    rgb: theme.colors.background === '#151F33' ? 'rgba(21, 31, 51, 0.3)' : 'rgba(0,0,0,0.06)',
    bg: theme.colors.background,
    surface: theme.colors.surface,
    titan: theme.colors.onSurfaceVariant as string,
    text: theme.colors.onSurfaceVariant as string,
    white: theme.colors.onSurface as string,
    green: '#2ECC71',
    red: '#FF5A67',
  } as const;

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
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [inputHeight, setInputHeight] = useState(0);
  const [messageText, setMessageText] = useState("");
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
      if (Platform.OS === 'android' && event?.endCoordinates?.height) {
        setKeyboardHeight(event.endCoordinates.height);
      }
      scheduleScrollToBottom(0); 
    };
    const onHide = () => { 
      setKeyboardVisible(false); 
      setKeyboardHeight(0);
      scheduleScrollToBottom(0); 
    };
    const onWillShow = (event: any) => { 
      setKeyboardVisible(true); 
      if (Platform.OS === 'ios' && event?.endCoordinates?.height) {
        setKeyboardHeight(event.endCoordinates.height);
      }
      scheduleScrollToBottom(0); 
    };
    const onWillHide = () => { 
      setKeyboardVisible(false); 
      setKeyboardHeight(0);
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
  const openMediaViewer = (type: 'image', uri: string, name?: string) => {
    setSelectedMedia({ type, uri, name });
    setMediaViewerVisible(true);
  };

  // Функция для закрытия медиа просмотра
  const closeMediaViewer = () => {
    setMediaViewerVisible(false);
    setSelectedMedia(null);
  };

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
          sender: isFromMe ? "me" : "peer",
          from: message.from,
          to: message.to,
          timestamp: new Date(message.timestamp),
        };

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
          const formattedMessages = serverMessages.messages.map(msg => ({
            id: msg.id,
            text: msg.text,
            type: msg.type,
            uri: msg.uri,
            sender: msg.from === currentUserId ? 'me' : 'peer',
            from: msg.from,
            to: msg.to,
            timestamp: new Date(msg.timestamp),
                read: !!msg.read,
          }));
          
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

  const hasHttp = (s?: string) => !!s && /^https?:\/\//i.test(String(s).trim());
  const isUploads = (s?: string) => !!s && String(s).startsWith('/uploads/');
  const resolveAvatar = (s?: string) => {
    if (!s) return '';
    if (hasHttp(s)) return toAvatarThumb(s, 72, 72);
    if (isUploads(s)) return `${API_BASE}${s}`;
    return '';
  };
  const resolveMediaUri = (s?: string) => {
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('/uploads/')) return `${API_BASE}${s}`;
    return s;
  };
  const firstLetter = (s?: string) => (s?.trim()?.[0] || '').toUpperCase();
  const [peerNameState, setPeerNameState] = useState<string>(peerNameParam);
  const headerInitial = peerNameState ? firstLetter(peerNameState) : '--';
  const headerPlaceholder = '--'; // Всегда показываем -- если нет аватара

  const Header = () => (
    <View
      style={{
        paddingTop: insets.top,
        height: headerH + insets.top,
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
  );

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
        setPeerNameState(nick || '—');
        navigation.setParams({ peerName: nick || '—' });
      }

      if (typeof avatarVer === 'number') {
        // Кэшируем миниатюру если пришла
        if (avatarThumbB64) {
          try {
            await putThumb(userId, avatarVer, avatarThumbB64);
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
        navigation.setParams({ peerOnline: onlineSet.has(String(peerId)) });
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
      <Text style={{ color: LIVI.text, marginTop: 12 }}>Загружаем чат…</Text>
    </View>
  );

  if (err) {
    return (
      <View
        style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
      >
        <Text
          style={{
            color: LIVI.text,
            marginBottom: 12,
            textAlign: "center",
          }}
        >
          Не удалось открыть чат: {err}
        </Text>
        <TouchableOpacity
          onPress={() => setErr(null)}
          style={{
            backgroundColor: "rgba(255,255,255,0.08)",
            paddingVertical: 10,
            paddingHorizontal: 18,
            borderRadius: 10,
          }}
        >
          <Text style={{ color: LIVI.white, fontWeight: "700" }}>Ок</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (loading) return <Loading />;
  const isEmpty = messages.length === 0;

  const openClearMenu = () => {
    setShowClearMenu(true);
  };

  const clearChatForMe = async () => {
    if (!currentUserId || !peerId) return;
    
    Alert.alert(
      "Удалить переписку только у меня",
      "Вы уверены, что хотите удалить всю переписку только у себя? У друга переписка останется.",
      [
        { text: "Отмена", style: "cancel" },
        { 
          text: "Удалить", 
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
              Alert.alert("Успешно", "Переписка удалена только у вас");
            } else {
              Alert.alert("Ошибка", "Не удалось удалить переписку на сервере");
            }
          }
        }
      ]
    );
  };

  const clearChatForAll = async () => {
    if (!currentUserId || !peerId) return;
    
    Alert.alert(
      "Удалить переписку у всех",
      "Вы уверены, что хотите удалить всю переписку для обоих пользователей? Это действие нельзя отменить.",
      [
        { text: "Отмена", style: "cancel" },
        { 
          text: "Удалить", 
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
              Alert.alert("Успешно", "Переписка удалена у всех");
            } else {
              Alert.alert("Ошибка", "Не удалось удалить переписку на сервере");
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
      Alert.alert("Ошибка", "Не удалось удалить сообщение");
    }
  };

  const showDeleteModal = () => {
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
  };

  const hideDeleteModal = () => {
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
  };

  // Функция для получения анимации сообщения
  const getMessageAnimation = (messageId: string) => {
    if (!messagePressAnimations[messageId]) {
      messagePressAnimations[messageId] = new Animated.Value(1);
    }
    return messagePressAnimations[messageId];
  };

  // Функция для анимации нажатия на сообщение
  const animateMessagePress = (messageId: string, callback?: () => void) => {
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
  };

  const sendMessage = async () => {
    if (!messageText.trim() || !currentUserId) return;
    
    
    const messageToSend = messageText.trim();
    setMessageText(""); // Очищаем поле сразу
    
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
            'Сделать фото',
            'Выбрать из галереи',
            'Отмена'
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
        'Прикрепить файл',
        'Выберите тип файла',
        [
          { text: 'Сделать фото', onPress: handleCamera },
          { text: 'Выбрать из галереи', onPress: handleImagePicker },
          { text: 'Отмена', style: 'cancel' }
        ]
      );
    }
  };

  const handleCamera = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Ошибка', 'Нужно разрешение на использование камеры');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        const messageId = Date.now().toString();
        
        // Только изображения
        const messageType = 'image';
        
        const newMessage = {
          id: messageId,
          type: messageType,
          uri: asset.uri,
          name: asset.fileName || `file_${Date.now()}`,
          size: asset.fileSize || 0,
          sender: 'me',
          from: currentUserId,
          to: peerId,
          timestamp: new Date(),
        };
        setMessages(prev => {
          // Проверяем, есть ли уже сообщение с таким ID
          const existingMessage = prev.find(msg => msg.id === messageId);
          if (existingMessage) {
            return prev;
          }


          return [...prev, newMessage];
        });
        
        // Статус для медиа файлов
        updateReadStatuses(prev => ({ ...prev, [messageId]: 'sending' }));
        
        // Загружаем медиа файл на сервер и отправляем через сокеты
        if (currentUserId) {
          try {
            // Устанавливаем статус "отправляется"
            setUploadStatus(prev => ({ ...prev, [messageId]: 'sending' }));

            // Загружаем файл на сервер
            const uploadResult = await uploadMediaToServer(asset.uri, messageType, undefined, currentUserId, peerId);

            if (uploadResult.success && uploadResult.url) {
              // Устанавливаем статус "отправляется"
              setUploadStatus(prev => ({ ...prev, [messageId]: 'sending' }));

              const socketResult = await sendSocketMessage({
                to: peerId,
                type: messageType,
                uri: uploadResult.url, // Используем публичный URL вместо локального
                name: asset.fileName || undefined,
                size: asset.fileSize || undefined
              });

              if (socketResult.ok && socketResult.messageId) {
                setMessages(prev => {
                  const updated = prev.map(msg => 
                    msg.id === messageId 
                      ? { ...msg, id: socketResult.messageId!, uri: resolveMediaUri(uploadResult.url), from: currentUserId, to: peerId }
                      : msg
                  );
                  saveMessages(updated); // Сохраняем обновленные сообщения
                  return updated;
                });

                // Устанавливаем статус отправки/доставки по факту
                setUploadStatus(prev => {
                  const newStatus = { ...prev };
                  newStatus[socketResult.messageId!] = 'sent';
                  delete newStatus[messageId]; // Удаляем старый статус
                  return newStatus;
                });

                updateReadStatuses(prev => {
                  const newStatuses = { ...prev };
                  const delivery = socketResult.delivered ? 'delivered' : 'sent';
                  newStatuses[socketResult.messageId!] = delivery;
                  delete newStatuses[messageId];
                  return newStatuses;
                });
              } else {
                console.warn('❌ Socket send failed:', socketResult);
                updateReadStatuses(prev => ({ ...prev, [messageId]: 'failed' }));
                setUploadStatus(prev => ({ ...prev, [messageId]: 'failed' }));
              }
            } else {
              console.error('❌ Media upload failed:', uploadResult.error);
              updateReadStatuses(prev => ({ ...prev, [messageId]: 'failed' }));
              setUploadStatus(prev => ({ ...prev, [messageId]: 'failed' }));
            }
          } catch (e) {
            console.error('Failed to upload and send media:', e);
            updateReadStatuses(prev => ({ ...prev, [messageId]: 'failed' }));
          }
        }
      }
    } catch (error) {
      console.error('Camera error:', error);
      Alert.alert('Ошибка', 'Не удалось сделать фото');
    }
  };

  const handleImagePicker = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Ошибка', 'Нужно разрешение на доступ к галерее');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        const messageId = Date.now().toString();
        
        // Только изображения
        const messageType = 'image';
        
        const newMessage = {
          id: messageId,
          type: messageType,
          uri: asset.uri,
          name: asset.fileName || `file_${Date.now()}`,
          size: asset.fileSize || 0,
          sender: 'me',
          from: currentUserId,
          to: peerId,
          timestamp: new Date(),
        };
        setMessages(prev => {
          // Проверяем, есть ли уже сообщение с таким ID
          const existingMessage = prev.find(msg => msg.id === messageId);
          if (existingMessage) {
            return prev;
          }


          return [...prev, newMessage];
        });
        
        // Статус для медиа файлов
        updateReadStatuses(prev => ({ ...prev, [messageId]: 'sending' }));
        
        // Загружаем медиа файл на сервер и отправляем через сокеты
        if (currentUserId) {
          try {
            // Устанавливаем статус "отправляется"
            setUploadStatus(prev => ({ ...prev, [messageId]: 'sending' }));

            // Загружаем файл на сервер
            const uploadResult = await uploadMediaToServer(asset.uri, messageType, undefined, currentUserId, peerId);

            if (uploadResult.success && uploadResult.url) {
              // Устанавливаем статус "отправляется"
              setUploadStatus(prev => ({ ...prev, [messageId]: 'sending' }));

              const socketResult = await sendSocketMessage({
                to: peerId,
                type: messageType,
                uri: uploadResult.url, // Используем публичный URL вместо локального
                name: asset.fileName || undefined,
                size: asset.fileSize || undefined
              });

              if (socketResult.ok && socketResult.messageId) {
                setMessages(prev => {
                  const updated = prev.map(msg => 
                    msg.id === messageId 
                      ? { ...msg, id: socketResult.messageId!, uri: uploadResult.url, from: currentUserId, to: peerId }
                      : msg
                  );
                  saveMessages(updated); // Сохраняем обновленные сообщения
                  return updated;
                });

                // Устанавливаем статус "отправлено"

                setUploadStatus(prev => {
                  const newStatus = { ...prev };
                  newStatus[socketResult.messageId!] = 'sent';
                  delete newStatus[messageId]; // Удаляем старый статус
                  return newStatus;
                });

                updateReadStatuses(prev => {
                  const newStatuses = { ...prev };
                  newStatuses[socketResult.messageId!] = 'delivered';
                  delete newStatuses[messageId];
                  return newStatuses;
                });
              } else {
                console.warn('❌ Socket send failed:', socketResult);
                updateReadStatuses(prev => ({ ...prev, [messageId]: 'failed' }));
              }
            } else {
              console.error('❌ Media upload failed:', uploadResult.error);
              updateReadStatuses(prev => ({ ...prev, [messageId]: 'failed' }));
              setUploadStatus(prev => ({ ...prev, [messageId]: 'failed' }));
            }
          } catch (e) {
            console.error('Failed to upload and send media:', e);
            updateReadStatuses(prev => ({ ...prev, [messageId]: 'failed' }));
          }
        }
      }
    } catch (error) {
      console.error('Image picker error:', error);
      Alert.alert('Ошибка', 'Не удалось выбрать изображение');
    }
  };


  const MessageItem = React.memo(({ item, currentUserId, readStatus, uploadStatus, onPressImage, onLongPressMessage }: any) => {
    const effectiveReadStatus = readStatus; // 'sending' | 'delivered' | 'read' | 'failed' | 'sent'
    // Fallback логика для определения отправителя если поле sender отсутствует
    let isMyMessage = item.sender === 'me';
    if (item.sender === undefined || item.sender === null) {
      isMyMessage = item.from === currentUserId;
      // оставляем только предупреждение, без лишних деталей
      console.warn('Message without sender field: using fallback');
    }

    const messageUploadStatus = uploadStatus || 'sent';

    const renderContent = () => {
      switch (item.type) {
        case 'image':
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
                  onPressImage('image', item.uri, item.name);
                });
              }}
              activeOpacity={0.9}
            >
              <ExpoImage
                source={{ uri: resolveMediaUri(item.uri) }}
                style={{
                  width: '100%',
                  height: '100%',
                  backgroundColor: 'rgba(255,255,255,0.1)',
                }}
                contentFit="cover"
                cachePolicy="memory-disk"
                transition={200}
                recyclingKey={`message_image_${item.id}`}
                allowDownscaling={false}
                placeholder={null}
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
  });

  return (
    <View style={{ flex: 1, backgroundColor: LIVI.surface }}>
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
            data={[...messages]}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <MessageItem
                item={item}
                currentUserId={currentUserId}
                readStatus={readStatuses[item.id]}
                uploadStatus={uploadStatus[item.id]}
                onPressImage={openMediaViewer}
                onLongPressMessage={(m: any) => { setSelectedMessage(m); showDeleteModal(); }}
              />
            )}
            style={{ flex: 1 }}
            contentContainerStyle={{ 
              flexGrow: 1,
              justifyContent: isEmpty ? 'center' : 'flex-end',
              paddingVertical: 16,
              paddingBottom: 12,
            }}
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
                placeholder="Введите сообщение..."
                placeholderTextColor={LIVI.titan}
                value={messageText}
                onChangeText={setMessageText}
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
        // Android: FlatList без KeyboardAvoidingView, блок ввода обернут отдельно
        (<View style={{ flex: 1 }}>
          <FlatList
            ref={flatListRef}
            data={isEmpty ? [] : [...messages].reverse()}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <MessageItem
                item={item}
                currentUserId={currentUserId}
                readStatus={readStatuses[item.id]}
                uploadStatus={uploadStatus[item.id]}
                onPressImage={openMediaViewer}
                onLongPressMessage={(m: any) => { setSelectedMessage(m); showDeleteModal(); }}
              />
            )}
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
              // Отступ под блок ввода; с adjustResize хватит высоты инпута + нижнего инсета
              <View style={{ height: 70 + insets.bottom }} />
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
          {/* Поле ввода для Android - динамическая позиция на основе высоты клавиатуры */}
          <View
            style={{
              position: 'absolute',
              // С adjustResize система сама ужимает экран под клавиатуру.
              // Держим инпут у низа, учитывая только safe-area.
              bottom: insets.bottom,
              left: 0,
              right: 0,
            }}
          >
            <View
              style={{
                borderTopWidth: BORDER_WIDTH,
                borderTopColor: BORDER_COLOR,
                backgroundColor: LIVI.bg,
                paddingHorizontal: 14,
                paddingTop: 12,
                paddingBottom: 12,
              }}
            >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: "rgba(255,255,255,0.06)",
                borderRadius: 28,
                paddingHorizontal: 12,
                paddingVertical: 4,
                borderWidth: 1,
                borderColor: BORDER_COLOR,
              }}
            >
              {/* Кнопка очистки убрана по требованию */}

              <TouchableOpacity
                onPress={handleAttachments}
                style={{ padding: 2, marginRight: 2 }}
              >
                <Ionicons name="image" size={28} color={LIVI.titan} />
              </TouchableOpacity>

              <TextInput
                style={{ flex: 1, color: LIVI.white, fontSize: 16, maxHeight: 100 }}
                placeholder="Введите сообщение..."
                placeholderTextColor={LIVI.titan}
                value={messageText}
                onChangeText={setMessageText}
                multiline
                onSubmitEditing={sendMessage}
                returnKeyType="send"
              />

              <TouchableOpacity
                onPress={sendMessage}
                style={{
                  backgroundColor: messageText.trim() ? LIVI.titan : "rgba(255,255,255,0.2)",
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
          </View>
        </View>)
      )}
      {/* Полноэкранный просмотр медиа */}
      <MediaViewer
        visible={mediaViewerVisible}
        onClose={closeMediaViewer}
        mediaType={selectedMedia?.type || 'image'}
        uri={selectedMedia?.uri || ''}
        name={selectedMedia?.name}
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
    </View>
  );
}