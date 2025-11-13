// frontend/sockets/socket.ts
import { io, Socket } from "socket.io-client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { logger } from '../utils/logger';

// Глобальное хранение сообщений
export const globalMessageStorage = {
  // Функция для получения ключа чата
  getChatKey: (userId1: string, userId2: string) => {
    const sortedIds = [userId1, userId2].sort();
    return `chat_messages_${sortedIds[0]}_${sortedIds[1]}`;
  },
  
  // Сохранение сообщения в AsyncStorage
  saveMessage: async (message: any, currentUserId: string) => {
    try {
      const chatKey = globalMessageStorage.getChatKey(currentUserId, message.from);
      const existingMessages = await AsyncStorage.getItem(chatKey);
      const messages = existingMessages ? JSON.parse(existingMessages) : [];

      // Проверяем, что сообщение еще не сохранено
      if (!messages.find((m: any) => m.id === message.id)) {
        const newMessage = {
          id: message.id,
          text: message.text,
          type: message.type,
          uri: message.uri,
          name: message.name,
          size: message.size,
          sender: 'peer',
          from: message.from,
          to: message.to,
          timestamp: new Date(message.timestamp),
        };

        messages.push(newMessage);
        await AsyncStorage.setItem(chatKey, JSON.stringify(messages));
      } else {}
    } catch (error) {
      logger.warn('Failed to save message globally:', error);
    }
  }
};
import { Platform } from "react-native";
import { getInstallId } from "../utils/installId";

/* ========= Server URL ========= */
import { SERVER_CONFIG } from '../src/config/server';

export const API_BASE = SERVER_CONFIG.BASE_URL;

/* ========= helpers ========= */
const isOid = (s?: string) => !!s && /^[a-f\d]{24}$/i.test(s);

/* ========= auth state ========= */
let currentUserId: string | undefined;
let bootInProgress = false; // Защита от повторного вызова boot()

/* ========= socket (singleton) ========= */
let socketInstance: Socket | null = null;
let reconnecting = false;
export const isReconnecting = () => reconnecting;
export const getSocket = (): Socket => {
  if (!socketInstance) {
    socketInstance = io(API_BASE, {
      path: "/socket.io",
      transports: ["websocket"],
      forceNew: false, // не создаём новый, держим singleton
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 15000,
    });
  }
  return socketInstance;
};

export const socket: Socket = getSocket();

/* ========= auth apply & connect ========= */
async function applyAuthAndConnect() {
  const installId = await getInstallId();
  // @ts-ignore
  socket.auth = { installId, ...(currentUserId ? { userId: currentUserId } : {}) };

  if (!socket.connected) {
    try {
      socket.connect();
    } catch (err) {
      logger.warn("Socket connect error:", err);
    }
  } else {
    logger.debug("Socket already connected, skip reconnect");
  }
}

async function boot() {
  // Защита от повторного вызова
  if (bootInProgress) {
    logger.debug('Boot already in progress, skipping...');
    return;
  }
  
  bootInProgress = true;
  logger.debug('Starting boot process...');
  
  try {
    const saved = await AsyncStorage.getItem("userId");
    if (saved && isOid(saved)) {
      logger.debug('Found saved userId:', saved);
      
      // Сначала устанавливаем userId и подключаемся
      currentUserId = saved;
      
      // Подключаемся к socket
      if (!socket.connected) {
        await applyAuthAndConnect();
      }
      
      // Проверяем профиль пользователя через getMyProfile
      try {
        const profileResponse = await getMyProfile();
        if (profileResponse?.ok && profileResponse.profile) {
          const profile = profileResponse.profile;
          logger.debug('Loaded profile from backend:', { nick: profile?.nick });
          
          // Если профиль пустой (пользователь удален админом), создаем нового
          if (!profile.nick && !profile.avatarB64 && !profile.avatarThumbB64) {
            logger.info('Profile is empty (user deleted by admin), creating new user...');
            await createUser();
            return; // Выходим из функции boot
          }
          
          logger.debug('Using existing user with profile:', saved);
        } else {
          logger.info('Failed to load profile, creating new user...');
          await createUser();
          return; // Выходим из функции boot
        }
      } catch (e) {
        logger.warn('Profile check failed, creating new user...', e);
        await createUser();
        return; // Выходим из функции boot
      }
    } else {
      // Нет сохраненного userId (удаление приложения или сброс аккаунта) - создаем нового
      logger.info('No saved userId, creating new user...');
      await createUser();
    }
  } catch (e) {
    logger.error('Boot error loading userId:', e);
    logger.info('Error occurred, creating new user...');
    await createUser();
  }
  
  // КРИТИЧНО: Подключаемся с актуальным currentUserId (только если не создавали нового пользователя)
  logger.debug('Final currentUserId:', currentUserId);
  if (!socket.connected) {
    await applyAuthAndConnect();
  } else if (currentUserId) {
    // Если socket уже подключен, но у нас есть userId - отправляем reauth
    logger.debug('Socket connected, sending reauth with userId:', currentUserId);
    try {
      const reauthResponse = await emitAck<{ ok: boolean; userId?: string; error?: string }>('reauth', { userId: currentUserId });
      if (reauthResponse?.ok) {
        logger.debug('Reauth successful');
      } else {
        logger.warn('Reauth failed:', reauthResponse?.error);
      }
    } catch (e) {
      logger.warn('Reauth error:', e);
    }
  }
  
  // Сбрасываем флаг завершения boot процесса
  bootInProgress = false;
  console.log('[boot] Boot process completed');
}
void boot();

/* ========= logging ========= */
socket.on("connect", async () => {
  reconnecting = false;
  console.log(`[socket] connected ${socket.id}`);
  
  // КРИТИЧНО: Если у нас есть userId, но socket подключился без него - отправляем reauth
  if (currentUserId && !(socket as any).data?.userId) {
    console.log('[socket] Connected without userId, sending reauth:', currentUserId);
    try {
      const reauthResponse = await emitAck<{ ok: boolean; userId?: string; error?: string }>('reauth', { userId: currentUserId });
      if (reauthResponse?.ok) {
        console.log('[socket] Reauth successful after connect');
      } else {
        console.warn('[socket] Reauth failed after connect:', reauthResponse?.error);
      }
    } catch (e) {
      console.warn('[socket] Reauth error after connect:', e);
    }
  }
});
socket.on("reconnect_attempt", () => { reconnecting = true; });
socket.on("reconnect", () => { reconnecting = false; });
socket.on("disconnect", (r) => {
  const transient = ["transport close", "ping timeout"];
  reconnecting = transient.includes(r) || r === undefined;
  console.warn(`[socket] disconnected (${r}) reconnecting=${reconnecting}`);
});
socket.on("connect_error", (e) => {
  reconnecting = true;
  console.warn(`[socket] error ${e?.message || e}`);
});
// Busy handler (for logging/forwarding to UI screens)
socket.on('call:busy', (data) => {});

// Обработчики для системы бэйджа "Занято"
socket.on('random:busy', (data: { userId: string; busy: boolean }) => {});

socket.on('friends:room_state', (data: { roomId: string; participants: string[] }) => {});


// Глобальный слушатель для сохранения всех входящих сообщений
// УБРАН - сообщения теперь обрабатываются только в ChatScreen

/* ========= ICE candidates ========= */
// Буфер ICE-кандидатов на уровне сокета (для модулей, где PC создаются позже)
const __candidateBuffer: Record<string, any[]> = {};

export function socketBufferIceCandidate(from: string, candidate: any) {
  const key = String(from || '');
  if (!key || !candidate) return;
  if (!__candidateBuffer[key]) __candidateBuffer[key] = [];
  __candidateBuffer[key].push(candidate);
  try {} catch {}
}

export function socketFlushBufferedIceCandidates(from: string): any[] {
  const key = String(from || '');
  if (!key) return [];
  const list = __candidateBuffer[key] || [];
  delete __candidateBuffer[key];
  try {
    list.length;
  } catch {}
  return list;
}

// socket.onAny((event, ...args) => {
//   console.log("[socket:onAny]", event, args);
// });

/* ========= small utils ========= */
async function waitForConnect(ms = 8000): Promise<void> {
  if (socket.connected) return;
  return new Promise((resolve, reject) => {
    const onOk = () => { cleanup(); resolve(); };
    const t = setTimeout(() => { cleanup(); reject(new Error("wait connect timeout")); }, ms);
    const cleanup = () => { clearTimeout(t); socket.off("connect", onOk); };
    socket.once("connect", onOk);
    // гарантируем попытку соединения
    try { socket.connect(); } catch {}
  });
}

type AnyObj = Record<string, any>;
export async function emitAck<T = any>(
  event: string,
  payload?: AnyObj,
  timeoutMs = 12000,
  retries = 2,                 // <= добавили авто-ретраи
): Promise<T> {
  // 1) если оффлайн/реконнект — сначала дождаться коннекта
  if (!socket.connected || reconnecting) {
    try { await waitForConnect(7000); } 
    catch { throw new Error(`offline: cannot emit "${event}"`); }
  }

  const tryOnce = () =>
    new Promise<T>((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) { done = true; reject(new Error(`Ack timeout for "${event}"`)); }
      }, timeoutMs);

      const ack = (resp: T) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(resp);
      };

      // socket.emit с ack
      try {
        if (payload !== undefined) socket.emit(event, payload, ack);
        else socket.emit(event, null, ack);
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
    });

  // 2) ретраи на таймаут
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    try {
      return await tryOnce();
    } catch (e: any) {
      lastErr = e;
      // если снова ушли в реконнект — подождём и повторим
      if (!socket.connected || reconnecting) {
        try { await waitForConnect(7000); } catch {}
      }
      // джиттер между попытками
      await new Promise(r => setTimeout(r, 250 + Math.random() * 300));
    }
  }
  throw lastErr;
}

export function onConnected(cb: () => void): () => void {
  const h = () => cb();
  if (socket.connected) h();
  socket.on("connect", h);
  return () => socket.off("connect", h);
}

export function onDisconnected(cb: (reason?: string) => void): () => void {
  const h = (r?: string) => cb(r);
  socket.on("disconnect", h);
  return () => socket.off("disconnect", h);
}

/* ========= Friends API ========= */
export type FriendListItem = {
  _id: string;
  nick?: string;
  avatar?: string; // локальный путь /uploads/... или пусто
  online: boolean;
  isBusy?: boolean; // статус занятости для видеозвонков
};

export function addFriend(toUserId: string) {
  if (!isOid(toUserId)) return Promise.reject(new Error("invalid ObjectId"));
  return emitAck<{ ok: boolean; status?: string; error?: string }>(
    "friends:add",
    { to: toUserId },
  );
}
export const inviteFriend = addFriend;
export const requestFriend = addFriend; // Для обратной совместимости

export function respondFriend(fromUserId: string, accept: boolean, requestId?: string) {
  if (!isOid(fromUserId)) return Promise.reject(new Error("invalid ObjectId"));
  return emitAck<{ ok: boolean; status?: string; error?: string }>(
    "friends:respond",
    { from: fromUserId, accept, requestId },
  );
}

export function fetchFriends(page: number = 1, limit: number = 50) {
  console.log('[fetchFriends] Requesting friends list, page:', page, 'limit:', limit);
  return emitAck<{ 
    ok: boolean; 
    list: FriendListItem[];
    pagination?: {
      page: number;
      limit: number;
      total: number;
      hasMore: boolean;
    }
  }>("friends:fetch", { page, limit });
}

export function onFriendAdded(
  cb: (d: { userId: string; userNick?: string }) => void,
): () => void {
  const h = (d: any) => cb(d);
  socket.on("friend_added", h);
  socket.on("friend:added", h);
  return () => {
    socket.off("friend_added", h);
    socket.off("friend:added", h);
  };
}

export function onFriendRequest(
  cb: (d: { from: string; requestId?: string; fromNick?: string }) => void,
): () => void {
  const h = (d: any) => cb(d);
  socket.on("friend_request", h);
  socket.on("friend:request", h);
  return () => {
    socket.off("friend_request", h);
    socket.off("friend:request", h);
  };
}

export function onFriendAccepted(cb: (d: { userId: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on("friend_accepted", h);
  socket.on("friend:accepted", h);
  return () => {
    socket.off("friend_accepted", h);
    socket.off("friend:accepted", h);
  };
}

export function onFriendDeclined(cb: (d: { userId: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on("friend_declined", h);
  socket.on("friend:declined", h);
  return () => {
    socket.off("friend_declined", h);
    socket.off("friend:declined", h);
  };
}

export function onFriendRemoved(cb: (p: { userId: string }) => void): () => void {
  const h = (d: any) => cb({ userId: String(d?.userId ?? d?.id ?? d) });
  socket.on("friend_removed", h);
  socket.on("friend:removed", h);
  return () => {
    socket.off("friend_removed", h);
    socket.off("friend:removed", h);
  };
}

export function removeFriend(peerId: string) {
  if (!isOid(peerId)) return Promise.reject(new Error("invalid ObjectId"));
  return emitAck<{ ok: boolean; error?: string }>("friends:remove", { peerId });
}

export function checkFriendship(userId: string) {
  if (!isOid(userId)) return Promise.reject(new Error("invalid ObjectId"));
  return emitAck<{ ok: boolean; areFriends: boolean; error?: string }>("friends:check", { userId });
}

/* ========= Presence ========= */
export function onPresenceUpdate(
  cb: (data: Array<{ _id: string; online: boolean }> | string[] | { userId: string; busy: boolean }) => void,
): () => void {
  const h = (data: any) => {
    // Передаем все данные как есть - HomeScreen сам разберет формат
    cb(data);
  };
  socket.on("presence_update", h);
  socket.on("presence:update", h);
  return () => {
    socket.off("presence_update", h);
    socket.off("presence:update", h);
  };
}

export function onUserPresence(
  cb: (userId: string, online: boolean) => void,
): () => void {
  // Сохраняем предыдущий список онлайн пользователей для сравнения
  let previousOnlineUsers = new Set<string>();
  
  return onPresenceUpdate((data) => {
    // Логи presence убраны - показывают только рабочее состояние
    
    if (Array.isArray(data)) {
      const currentOnlineUsers = new Set<string>();
      
      // Обрабатываем массив (обычно это массив строк - ID онлайн пользователей)
      data.forEach(item => {
        const userId = typeof item === 'string' ? item : item._id;
        if (userId) {
          currentOnlineUsers.add(userId);
        }
      });
      
      // Определяем, кто стал онлайн
      currentOnlineUsers.forEach(userId => {
        if (!previousOnlineUsers.has(userId)) {
          cb(userId, true); // Пользователь стал онлайн
        }
      });
      
      // Определяем, кто стал офлайн
      previousOnlineUsers.forEach(userId => {
        if (!currentOnlineUsers.has(userId)) {
          cb(userId, false); // Пользователь стал офлайн
        }
      });
      
      // Обновляем предыдущий список
      previousOnlineUsers = currentOnlineUsers;
    }
  });
}

/* ========= Signaling (webrtc) ========= */
export function sendOffer(to: string, offer: any) {
  socket.emit("offer", { to, offer });
}
export function sendAnswer(to: string, answer: any) {
  socket.emit("answer", { to, answer });
}
export function sendCandidate(to: string, candidate: any) {
  socket.emit("ice-candidate", { to, candidate });
}

export function onRtcOffer(
  cb: (d: { from: string; offer: any }) => void,
): () => void {
  socket.on("offer", cb as any);
  return () => socket.off("offer", cb as any);
}
export function onRtcAnswer(
  cb: (d: { from: string; answer: any }) => void,
): () => void {
  socket.on("answer", cb as any);
  return () => socket.off("answer", cb as any);
}
export function onRtcCandidate(
  cb: (d: { from: string; candidate: any }) => void,
): () => void {
  socket.on("ice-candidate", cb as any);
  return () => socket.off("ice-candidate", cb as any);
}

/* ========= Profile ========= */
export function getMyProfile() {
  return emitAck<{ 
    ok: boolean; 
    profile?: { 
      nick?: string; 
      avatarUrl?: string;
      avatarB64?: string;
      avatarThumbB64?: string;
      avatarVer?: number;
    } 
  }>(
    "profile:me",
  );
}
export function updateProfile(patch: { nick?: string; avatar?: string }) {
  const clean: { nick?: string; avatar?: string } = {};
  if (typeof patch.nick === "string") clean.nick = patch.nick;
  if (typeof patch.avatar === "string") clean.avatar = patch.avatar;

  const promise = emitAck<{ ok: boolean; profile?: { nick?: string; avatar?: string }; error?: string }>(
    "profile:update",
    clean,
    5000
  );

  promise.then((result) => {
    if (result?.ok) {} else {
      console.error('[updateProfile] ❌ Server response error:', result?.error);
    }
  }).catch((error) => {
    console.error('[updateProfile] ❌ Request failed:', error);
  });

  return promise;
}

export async function getAvatar(userId: string) {
  if (!isOid(userId)) return { ok: false };
  return emitAck<{ ok: boolean; avatarB64?: string; avatarVer?: number }>(
    "user.getAvatar",
    { userId },
    8000,
    1
  );
}

/* ========= Identity ========= */
export function identityAttach(payload: {
  installId?: string;
  profile?: { nick?: string; avatarUrl?: string };
}) {
  return emitAck<{ ok: boolean; userId?: string; error?: string }>(
    "identity:attach",
    payload,
  );
}
export const attachIdentity = identityAttach;

/* ========= Service ========= */
export function getSocketId() {
  return socket.id;
}
export async function attachUserId(userId: string) {
  if (!isOid(userId)) return;
  console.log('[attachUserId] Attaching userId:', userId);
  currentUserId = userId;
  try {
    await AsyncStorage.setItem("userId", currentUserId);
  } catch {}
  if (socket.connected) {
    console.log('[socket] reauth — skip full disconnect');
    // Убираем избыточную проверку - reauth сам проверит существование пользователя
    socket.emit('reauth', { userId }); // мягкая переавторизация
    return;
  }
  await applyAuthAndConnect();
}

// Кэш для проверки существования пользователей
const userExistsCache = new Map<string, { result: boolean; timestamp: number }>();
const USER_EXISTS_CACHE_DURATION = 30000; // 30 секунд

// Функция для проверки существования пользователя с retry и кэшированием
export async function checkUserExists(userId: string): Promise<boolean | null> {
  // Проверяем кэш
  const cached = userExistsCache.get(userId);
  if (cached && Date.now() - cached.timestamp < USER_EXISTS_CACHE_DURATION) {
    console.log('[checkUserExists] Using cached result:', cached.result);
    return cached.result;
  }
  
  console.log('[checkUserExists] Checking user:', userId);
  
  // Retry до 2 раз с задержкой (уменьшили с 3 до 2)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`[checkUserExists] Attempt ${attempt}/2...`);
      
      const response = await fetch(`${API_BASE}/api/exists/${userId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (!response.ok) {
        console.warn(`[checkUserExists] Attempt ${attempt} failed, status:`, response.status);
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 500)); // Уменьшили задержку до 500мс
          continue;
        }
        // Если все попытки провалились - возвращаем null (неизвестно)
        return null;
      }
      
      const data = await response.json();
      if (data.ok) {
        console.log('[checkUserExists] User exists:', data.exists);
        // Сохраняем в кэш
        userExistsCache.set(userId, { result: data.exists, timestamp: Date.now() });
        return data.exists;
      }
    } catch (e) {
      console.warn(`[checkUserExists] Attempt ${attempt} error:`, e);
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 500)); // Уменьшили задержку до 500мс
        continue;
      }
    }
  }
  
  console.warn('[checkUserExists] All attempts failed, server not ready');
  return null; // null = неизвестно (сервер не готов)
}

// Функция для создания пользователя с retry
export async function createUser() {
  console.log('[createUser] Creating user...');
  
  // Защита от создания пользователя если уже есть currentUserId
  if (currentUserId) {
    console.log('[createUser] User already exists:', currentUserId, 'skipping creation');
    return currentUserId;
  }
  
  // Очищаем старый userId и все локальные данные из AsyncStorage
  try {
    await AsyncStorage.removeItem("userId");
    await AsyncStorage.removeItem('profile');
    await AsyncStorage.removeItem('livi.home.draft.v1');
    console.log('[createUser] Cleared old userId and all local data from AsyncStorage');
  } catch (e) {
    console.warn('[createUser] Failed to clear AsyncStorage:', e);
  }
  
  // Retry до 5 раз с задержкой
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`[createUser] Attempt ${attempt}/5...`);
      
      // Используем нормальную логику через identity:attach вместо create-test
      const installId = await getInstallId();
      await attachUserId(installId);
      
      // Проверяем, что пользователь был создан
      if (currentUserId) {
        console.log('[createUser] User created successfully:', currentUserId);
        return currentUserId;
      }
      
    } catch (e) {
      console.warn(`[createUser] Attempt ${attempt} error:`, e);
      if (attempt < 5) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 секунды задержка
        continue;
      }
    }
  }
  
  console.error('[createUser] All attempts failed');
  return null;
}

export function getCurrentUserId(): string | undefined {
  return currentUserId;
}

export function setCurrentUserId(userId: string) {
  // Логи setCurrentUserId убраны - показывают только рабочее состояние
  currentUserId = userId;
  // Сохраняем в AsyncStorage без переподключения
  AsyncStorage.setItem("userId", userId).catch(e => console.warn('Failed to save userId to storage:', e));
}

/* ========= REST API для получения userId (как в старой версии) ========= */
async function whoamiViaRest(): Promise<string | null> {
  try {
    const installId = await getInstallId();
    const r = await fetch(`${API_BASE}/whoami?installId=${encodeURIComponent(installId)}`);
    const j = await r.json();
    if (j?.ok && isOid(j?.userId)) {
      return String(j.userId);
    }
  } catch (e) {
    console.warn('whoamiViaRest failed:', e);
  }
  return null;
}

export async function getMyUserId(): Promise<string | null> {
  // Сначала пробуем из памяти
  if (currentUserId) {
    return currentUserId;
  }
  
  // Потом через REST API
  const userId = await whoamiViaRest();
  if (userId) {
    setCurrentUserId(userId);
    return userId;
  }
  
  // Если REST API не работает, попробуем через socket
  try {
    const resp = await emitAck<any>("whoami", undefined, 6000, 1);
    if (resp && resp._id) {
      setCurrentUserId(resp._id);
      return resp._id;
    }
  } catch (error) {
    console.warn("🔍 getMyUserId: whoami via socket failed:", error);
  }
  
  return null;
}

export function onFriendProfile(
  cb: (p: { userId: string; nick?: string; avatar?: string; avatarVer?: number }) => void,
): () => void {
  const h = (p: any) => cb(p);
  socket.on("friend:profile", h);
  socket.on("friend_profile", h);
  return () => {
    socket.off("friend:profile", h);
    socket.off("friend_profile", h);
  };
}

/* ========= Messages ========= */
export function sendMessage(payload: {
  to: string;
  text?: string;
  type: 'text' | 'image' | 'video' | 'document';
  uri?: string;
  name?: string;
  size?: number;
}) {
  // Ограничиваем типы сообщений для новой системы
  const messageType = payload.type === 'video' || payload.type === 'document' ? 'text' : payload.type;

  return emitAck<{ ok: boolean; messageId?: string; timestamp?: Date; delivered?: boolean; error?: string }>(
    "message:send",
    {
      to: payload.to,
      text: payload.text,
      type: messageType,
      uri: payload.uri
    }
  );
}

export function markMessagesAsRead(from: string) {
  return emitAck<{ ok: boolean; error?: string }>(
    "messages:mark_read",
    { from }
  );
}

export function sendReadReceipt(messageId: string, from: string) {
  socket.emit('message:read', { messageId, from });
}

// Новая функция для получения сообщений
export function fetchMessages(payload: {
  with: string;
  limit?: number;
  before?: string;
}) {
  return emitAck<{ 
    ok: boolean; 
    messages?: Array<{
      id: string;
      from: string;
      to: string;
      type: 'text' | 'image';
      text?: string;
      uri?: string;
      timestamp: string;
      read: boolean;
    }>;
    hasMore?: boolean;
    error?: string;
  }>("messages:fetch", payload);
}

// Новая функция для получения количества непрочитанных сообщений
export function getUnreadCount(from?: string) {
  return emitAck<{ 
    ok: boolean; 
    count?: number;
    error?: string;
  }>("messages:unread_count", { from });
}

export function onMessageReceived(
  cb: (message: {
    id: string;
    from: string;
    to: string;
    type: 'text' | 'image';
    text?: string;
    uri?: string;
    timestamp: string;
    read: boolean;
  }) => void
): () => void {
  const h = (message: any) => {
    cb(message);
  };
  socket.on("message:received", h);
  return () => { socket.off("message:received", h); };
}

export function onChatCleared(
  cb: (data: { by: string; with: string }) => void
): () => void {
  const h = (data: any) => cb(data);
  socket.on("message:chat_cleared", h);
  return () => { socket.off("message:chat_cleared", h); };
}

export function onMessageDeleted(
  cb: (data: { messageId: string; deletedBy: string }) => void
): () => void {
  const h = (data: any) => cb(data);
  socket.on("message:deleted", h);
  return () => { socket.off("message:deleted", h); };
}

export function onMessageReadReceipt(
  cb: (receipt: {
    messageId: string;
    readBy: string;
    timestamp: string;
  }) => void
): () => void {
  const h = (receipt: any) => cb(receipt);
  socket.on("message:read_receipt", h);
  return () => { socket.off("message:read_receipt", h); };
}

export function getUnreadMessageCount(fromUserId: string) {
  return emitAck<{ ok: boolean; count?: number; error?: string }>(
    "message:unread_count",
    { from: fromUserId }
  );
}

export function loadMessagesFromServer(fromUserId: string, limit?: number) {
  return emitAck<{ ok: boolean; messages?: any[]; error?: string }>(
    "message:load",
    { from: fromUserId, limit }
  );
}

/* ========= User Validation ========= */
export function checkUserExistsSocket(userId: string) {
  return emitAck<{ ok: boolean; exists: boolean; error?: string }>(
    "user:exists",
    { userId }
  );
}

/* ========= User Data Cleanup ========= */
export async function clearAllUserData(): Promise<{ success: boolean; error?: any }> {
  try {
    // Очищаем все данные из AsyncStorage
    const keys = await AsyncStorage.getAllKeys();
    const userDataKeys = keys.filter(key => 
      key.startsWith('user') || 
      key.startsWith('friends') || 
      key.startsWith('chat_messages_') || 
      key.startsWith('chat_statuses_') ||
      key.startsWith('profile_') ||
      key.startsWith('profile_draft_') ||
      key.startsWith('livi.profile') || // Добавляем livi.profile.v1
      key.startsWith('unread_') ||
      key.startsWith('message_') ||
      key === 'missed_calls_by_user_v1' ||
      key.includes('userId') ||
      key.includes('installId') ||
      key.includes('avatar') || // Добавляем кеш аватаров
      key.includes('cache') || // Добавляем общий кеш
      key.includes('draft') // Добавляем все черновики
    );
    
    if (userDataKeys.length > 0) {
      await AsyncStorage.multiRemove(userDataKeys);
    }
    
    // Очищаем кэш сообщений
    clearAllMessageCache();
    
    // Очищаем данные профиля
    try {
      const { clearProfileStorage } = await import('../utils/profileStorage');
      await clearProfileStorage();
    } catch (e) {
      console.warn('Failed to clear profile storage:', e);
    }
    
    // Очищаем кеш аватаров
    try {
      const { clearAvatarCache } = await import('../utils/avatarCache');
      await clearAvatarCache();
    } catch (e) {
      console.warn('Failed to clear avatar cache:', e);
    }
    
    // Сбрасываем текущий userId
    currentUserId = undefined;
    
    return { success: true };
  } catch (error) {
    console.error('Failed to clear user data:', error);
    return { success: false, error };
  }
}


// Server history REMOVED - using local storage only
export async function getChatHistory(peerId: string): Promise<any[]> {
  return [];
}

// Кэш для сообщений (избегаем повторной загрузки)
const messageCache = new Map<string, { messages: any[], timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 минут

// Очистка кэша для конкретного чата (при получении новых сообщений)
export function clearMessageCache(peerId: string, userId?: string) {
  const currentUser = userId || currentUserId;
  if (!currentUser || !peerId) return;

  const cacheKey = `${currentUser}-${peerId}`;
  messageCache.delete(cacheKey);
}

// Очистка всего кэша сообщений
export function clearAllMessageCache() {
  messageCache.clear();
}

// Очистить переписку с пользователем
export async function clearChatMessages(peerId: string, forAll: boolean = true): Promise<boolean> {
  try {
    const result = await emitAck('message:clear_chat', { with: peerId, forAll });
    if (result.ok) {
      // Очищаем локальный кэш
      clearMessageCache(peerId);
      
      // Очищаем AsyncStorage
      const currentUser = currentUserId;
      if (currentUser) {
        const chatKey = globalMessageStorage.getChatKey(currentUser, peerId);
        await AsyncStorage.removeItem(chatKey);
      }
      
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to clear chat messages:', error);
    return false;
  }
}

// Удалить одно сообщение
export async function deleteMessage(messageId: string): Promise<boolean> {
  try {
    const result = await emitAck('message:delete', { messageId });
    return result.ok;
  } catch (error) {
    console.error('Failed to delete message:', error);
    return false;
  }
}

// Загрузка всех сообщений для чата (с кэшированием)
export async function getChatMessages(peerId: string, userId?: string): Promise<any[]> {
  try {
    let currentUser = userId || currentUserId;

    // Если нет userId, принудительно получаем его
    if (!currentUser) {
      const fetchedUserId = await getMyUserId();
      if (!fetchedUserId) {
        console.warn('🔍 getChatMessages: still no userId after fetch');
        return [];
      }
      currentUser = fetchedUserId;
    }

    if (!currentUser || !peerId) return [];

    const cacheKey = `${currentUser}-${peerId}`;
    const now = Date.now();

    // Проверяем кэш
    const cached = messageCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < CACHE_DURATION) {
      return cached.messages;
    }

    // Сначала пытаемся загрузить из локального хранилища (быстрее)
    const chatKey = globalMessageStorage.getChatKey(currentUser, peerId);
    const savedMessages = await AsyncStorage.getItem(chatKey);

    if (savedMessages) {
      const parsed = JSON.parse(savedMessages);
      const messagesWithDates = parsed
        .filter((msg: any) => {
          // Фильтруем только сообщения между currentUser и peerId
          const isFromCurrentUser = msg.from === currentUser && msg.to === peerId;
          const isToCurrentUser = msg.from === peerId && msg.to === currentUser;
          return isFromCurrentUser || isToCurrentUser;
        })
        .map((msg: any) => {
          // Исправляем недостающие поля для старых сообщений
          let correctedMsg = { ...msg };
          
          if (!msg.from || !msg.to) {
            if (msg.sender === 'me') {
              correctedMsg.from = currentUser;
              correctedMsg.to = peerId;
            } else if (msg.sender === 'peer') {
              correctedMsg.from = peerId;
              correctedMsg.to = currentUser;
            }
          }
          
          return {
            ...correctedMsg,
            timestamp: new Date(msg.timestamp),
            sender: correctedMsg.from === currentUser ? 'me' : 'peer'
          };
        });

      // Кэшируем результат
      messageCache.set(cacheKey, { messages: messagesWithDates, timestamp: now });

      return messagesWithDates;
    }

    const response = await loadMessagesFromServer(peerId, 100);

    if (response.ok && response.messages && response.messages.length > 0) {
      const messagesWithSender = response.messages.map((msg: any) => ({
        ...msg,
        timestamp: new Date(msg.timestamp),
        sender: msg.from === currentUser ? 'me' : 'peer'
      }));

      // Сохраняем в локальное хранилище
      await AsyncStorage.setItem(chatKey, JSON.stringify(messagesWithSender));

      // Кэшируем результат
      messageCache.set(cacheKey, { messages: messagesWithSender, timestamp: now });

      return messagesWithSender;
    }

    return [];
  } catch (error) {
    console.warn('Failed to load chat messages:', error);
    return [];
  }
}

export default socket;

/* ========= Calls (direct video) ========= */
export function startCall(toUserId: string) {
  if (!isOid(toUserId)) return Promise.reject(new Error('invalid ObjectId'));
  return emitAck<{ ok: boolean; callId?: string; error?: string }>(
    'call:initiate',
    { to: toUserId },
    20000,
  );
}

export function cancelCall(callId: string) {
  socket.emit('call:cancel', { callId });
}

export function acceptCall(callId: string) {
  socket.emit('call:accept', { callId });
}

export function declineCall(callId: string) {
  socket.emit('call:decline', { callId });
}

export function onCallIncoming(cb: (d: { callId: string; from: string; fromNick?: string }) => void): () => void {
  const h = (d: any) => {
    logger.debug('Socket received call:incoming', { callId: d.callId, from: d.from, fromNick: d.fromNick });
    cb(d);
  };
  socket.on('call:incoming', h);
  return () => socket.off('call:incoming', h);
}

export function onCallAccepted(cb: (d: { callId: string; from: string }) => void): () => void {
  const h = (d: any) => {
    logger.debug('Socket received call:accepted', { callId: d.callId, from: d.from });
    cb(d);
  };
  socket.on('call:accepted', h);
  return () => socket.off('call:accepted', h);
}

export function onCallDeclined(cb: (d: { callId: string; from: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on('call:declined', h);
  return () => socket.off('call:declined', h);
}

// Отдельное событие для явной отмены звонком инициатора (дублирует call:declined на сервере, но даём отдельный listener для явности)
export function onCallCanceled(cb: (d: { callId: string; from: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on('call:cancel', h);
  return () => socket.off('call:cancel', h);
}

export function onCallTimeout(cb: (d: { callId: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on('call:timeout', h);
  return () => socket.off('call:timeout', h);
}

export function onCallRoomFull(cb: (d: { userId?: string }) => void): () => void {
  const h = (d: any) => cb(d || {});
  socket.on('call:room_full', h);
  return () => socket.off('call:room_full', h);
}

// Обработчики для системы бэйджа "Занято"
export function onRandomBusy(cb: (data: { userId: string; busy: boolean }) => void): () => void {
  const h = (data: any) => cb(data);
  socket.on('random:busy', h);
  return () => socket.off('random:busy', h);
}

export function onFriendsRoomState(cb: (data: { roomId: string; participants: string[] }) => void): () => void {
  const h = (data: any) => cb(data);
  socket.on('friends:room_state', h);
  return () => socket.off('friends:room_state', h);
}
