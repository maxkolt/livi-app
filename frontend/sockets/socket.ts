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
          duration: message.duration,
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
// Dev-only: avoid log spam for typing events
const __devTypingLogState = new Map<string, boolean>();
import { Platform } from "react-native";
import { AppState, type AppStateStatus } from "react-native";
import { getInstallId } from "../utils/installId";

/* ========= Server URL ========= */
// Получаем BASE_URL из переменных окружения
// Приоритет: платформо-специфичная переменная > общая переменная > fallback
// КРИТИЧНО: В production используйте домены с HTTPS, не IP адреса!
const DEFAULT_URL = process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
const IOS_URL = process.env.EXPO_PUBLIC_SERVER_URL_IOS || process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
const ANDROID_URL = process.env.EXPO_PUBLIC_SERVER_URL_ANDROID || process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';

export const API_BASE = (Platform.OS === 'android' ? ANDROID_URL : IOS_URL).replace(/\/+$/, '');

/* ========= helpers ========= */
const isOid = (s?: string) => !!s && /^[a-f\d]{24}$/i.test(s);

/* ========= auth state ========= */
let currentUserId: string | undefined;
let bootInProgress = false; // Защита от повторного вызова boot()
let createUserPromise: Promise<string | null> | null = null; // Трекер параллельных createUser

// Notify UI when currentUserId changes (screens depend on it for profile/avatar).
type CurrentUserIdListener = (userId: string | undefined) => void;
const __currentUserIdListeners = new Set<CurrentUserIdListener>();
function __notifyCurrentUserId() {
  try {
    for (const cb of __currentUserIdListeners) {
      try { cb(currentUserId); } catch {}
    }
  } catch {}
}

// Subscribe to currentUserId changes (invoked immediately once).
export function onCurrentUserId(cb: CurrentUserIdListener): () => void {
  try { cb(currentUserId); } catch {}
  __currentUserIdListeners.add(cb);
  return () => {
    __currentUserIdListeners.delete(cb);
  };
}

/* ========= socket (singleton) ========= */
let socketInstance: Socket | null = null;
let reconnecting = false;
// Флаг: гарантировали ли мы, что handshake содержит installId (иначе сервер вернёт guest профиль {})
let __handshakeHasInstallId = false;
export const isReconnecting = () => reconnecting;
export const getSocket = (): Socket => {
  if (!socketInstance) {
    socketInstance = io(API_BASE, {
      path: "/socket.io",
      // IMPORTANT:
      // Many VPNs / captive portals / corporate networks block WebSocket.
      // Server supports polling fallback, so allow it on the client too.
      transports: ["websocket", "polling"],
      upgrade: true,
      forceNew: false, // не создаём новый, держим singleton
      // CRITICAL:
      // Do NOT auto-connect on module load. We must attach installId into handshake first,
      // otherwise server will treat us as guest and reauth can fail with "no_installId",
      // causing reconnect loops and even identity resets.
      // Connection is triggered via applyAuthAndConnect()/emitAck() when ready.
      autoConnect: false,
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
  try {
    const installId = await getInstallId();
    // @ts-ignore
    socket.auth = { installId, ...(currentUserId ? { userId: currentUserId } : {}) };

    // Если уже подключены, но handshake был без installId (типичный кейс из-за autoConnect),
    // сервер будет считать нас гостем и profile:me вернёт {}. В этом случае делаем 1 reconnect.
    if (socket.connected) {
      if (!__handshakeHasInstallId && installId) {
        try {
          const resp = await emitAck<{ ok: boolean; userId?: string; error?: string }>(
            'reauth',
            { userId: currentUserId },
            6000,
            0
          );
          if (resp?.ok) {
            __handshakeHasInstallId = true;
            return;
          }
          if (resp?.error === 'no_installId') {
            logger.warn('[applyAuthAndConnect] Connected without installId in handshake, forcing reconnect');
            try { socket.disconnect(); } catch {}
            __handshakeHasInstallId = false;
            socket.connect();
          } else {
            // Если иная ошибка — не делаем агрессивный reconnect, чтобы не ломать релиз-стабильность.
            return;
          }
        } catch (e) {
          // Если ack завис/упал — мягко пробуем переподключиться один раз.
          try { socket.disconnect(); } catch {}
          __handshakeHasInstallId = false;
          socket.connect();
        }
      } else {
        return;
      }
    }

    if (!socket.connected) {
      logger.debug("Connecting socket...");
      // Socket.connect() не возвращает промис, поэтому используем события
      socket.connect();
      
      // Ждем подключения с таймаутом
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.off('connect', onConnect);
          socket.off('connect_error', onError);
          reject(new Error('Socket connection timeout'));
        }, 10000); // 10 секунд таймаут
        
        const onConnect = () => {
          clearTimeout(timeout);
          socket.off('connect', onConnect);
          socket.off('connect_error', onError);
          logger.debug("Socket connected");
          resolve();
        };
        
        const onError = (err: any) => {
          clearTimeout(timeout);
          socket.off('connect', onConnect);
          socket.off('connect_error', onError);
          logger.warn("Socket connect error:", err);
          reject(err);
        };
        
        if (socket.connected) {
          clearTimeout(timeout);
          resolve();
        } else {
          socket.once('connect', onConnect);
          socket.once('connect_error', onError);
        }
      });
      if (installId) __handshakeHasInstallId = true;
    } else {
      logger.debug("Socket already connected, skip reconnect");
    }
  } catch (error) {
    logger.error('[applyAuthAndConnect] Connection failed:', error);
    // Не выбрасываем ошибку - приложение должно продолжить работу
    // Socket переподключится автоматически
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
      __notifyCurrentUserId();
      
      // Подключаемся к socket (и гарантируем installId в handshake)
      await applyAuthAndConnect();

      // ВАЖНО: гарантируем, что сервер "видит" userId (иначе profile:me вернёт гостевой профиль {})
      // Не пересоздаём пользователя на временных проблемах сети/авторизации — сначала пробуем reauth.
      try {
        if (socket.connected) {
          await emitAck<{ ok: boolean; userId?: string; error?: string }>('reauth', { userId: saved }, 6000, 1);
        }
      } catch (e) {
        // мягко игнорируем — может быть оффлайн, но userId локально сохраняем
        logger.warn('[boot] reauth failed (non-critical):', e);
      }
      
      // Проверяем профиль пользователя через getMyProfile
      // КРИТИЧНО: getMyProfile уже имеет таймаут 8 секунд
      try {
        const profileResponse = await getMyProfile();
        if (profileResponse?.ok) {
          // profile === undefined → userId не найден в БД (реальный кейс "пользователь удалён/сломана база")
          // profile === {} допустимо (пустой ник/аватар) и НЕ должно приводить к созданию нового userId
          if (profileResponse.profile === undefined) {
            logger.info('Profile is missing for saved userId (user not found), creating new user...');
            await createUser();
            return;
          }

          const profile = profileResponse.profile;
          logger.debug('Loaded profile from backend:', { nick: profile?.nick });

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
        // Если пользователь не найден на сервере - очищаем локальный userId и создаем нового
        if (reauthResponse?.error === 'user_not_found') {
          logger.warn('User not found on server, clearing local userId and creating new user...');
          clearCurrentUserId();
          await createUser();
        }
      }
    } catch (e) {
      logger.warn('Reauth error:', e);
    }
  }
  
  // Сбрасываем флаг завершения boot процесса
  bootInProgress = false;
  console.log('[boot] Boot process completed');
}

// КРИТИЧНО: Обертываем boot() в try-catch для предотвращения крашей
// Запускаем boot с задержкой, чтобы дать приложению время инициализироваться
setTimeout(() => {
  (async () => {
    try {
      await boot();
    } catch (error) {
      logger.error('[boot] Critical error during boot process:', error);
      // Не выбрасываем ошибку - приложение должно продолжить работу
      // Попробуем создать пользователя как fallback
      try {
        await createUser();
      } catch (createError) {
        logger.error('[boot] Failed to create user as fallback:', createError);
      }
    }
  })();
}, 100); // Небольшая задержка для инициализации модулей

/* ========= AppState -> presence ========= */
// Требование: статус online только когда пользователь в приложении.
// Самый надёжный способ без изменения сервера — отключать сокет при уходе в фон.
let __lastAppState: AppStateStatus = AppState.currentState;
let __realtimePaused = __lastAppState !== 'active';
/** Пока на нативном экране исходящего (OutgoingCallActivity) — не отключать сокет при «background», чтобы инициатор получил call:accepted. */
let __outgoingCallScreenVisible = false;
/** Пока на нативном экране входящего (IncomingCallActivity) — не отключать сокет при «background», чтобы получатель мог принять/отклонить по сокету. */
let __incomingCallScreenVisible = false;
/** Пока активен видеозвонок (подключение к LiveKit или комната connected) — не отключать сокет при «background», чтобы избежать negotiation disconnected / m-line errors. */
let __activeVideoCall = false;

export function setOutgoingCallScreenVisible(visible: boolean): void {
  __outgoingCallScreenVisible = visible;
  if (!visible && (__lastAppState !== 'active' && __lastAppState !== 'inactive')) {
    // Экран исходящего закрыт, а приложение в фоне — отключаем сокет
    __realtimePaused = true;
    try { (socket as any).io.opts.reconnection = false; } catch {}
    if (socket?.connected) socket.disconnect();
  }
}

export function setIncomingCallScreenVisible(visible: boolean): void {
  __incomingCallScreenVisible = visible;
  if (!visible && (__lastAppState !== 'active' && __lastAppState !== 'inactive')) {
    __realtimePaused = true;
    try { (socket as any).io.opts.reconnection = false; } catch {}
    if (socket?.connected) socket.disconnect();
  }
}

export function setActiveVideoCall(active: boolean): void {
  __activeVideoCall = active;
  if (!active && (__lastAppState !== 'active' && __lastAppState !== 'inactive')) {
    __realtimePaused = true;
    try { (socket as any).io.opts.reconnection = false; } catch {}
    if (socket?.connected) socket.disconnect();
  }
}

try {
  AppState.addEventListener('change', (nextState) => {
    try {
      // Treat 'inactive' as foreground to avoid disconnect/reconnect flicker while user is still in-app
      // (e.g. transient OS transitions). We only pause realtime when app actually goes to background.
      const wasForeground = __lastAppState === 'active' || __lastAppState === 'inactive';
      const isForeground = nextState === 'active' || nextState === 'inactive';
      __lastAppState = nextState;

      if (wasForeground && !isForeground) {
        // На нативном экране исходящего/входящего или во время видеозвонка не отключать сокет
        if (__outgoingCallScreenVisible || __incomingCallScreenVisible || __activeVideoCall) return;
        // App -> background => offline
        __realtimePaused = true;
        try {
          // IMPORTANT: prevent any auto-reconnect loops while app is in background.
          // socket.disconnect() is "manual" and should stop reconnects, but some edge cases
          // (race with reconnect attempt) are safer with reconnection=false.
          try { (socket as any).io.opts.reconnection = false; } catch {}
          if (socket?.connected) socket.disconnect();
        } catch {}
        return;
      }

      if (!wasForeground && isForeground) {
        // App -> foreground => online (reconnect)
        __realtimePaused = false;
        __outgoingCallScreenVisible = false;
        __incomingCallScreenVisible = false;
        __activeVideoCall = false;
        try { (socket as any).io.opts.reconnection = true; } catch {}
        // applyAuthAndConnect already sets installId/userId and connects with timeouts.
        applyAuthAndConnect().catch(() => {});
      }
    } catch {}
  });
} catch {}

/* ========= logging ========= */
socket.on("connect", async () => {
  reconnecting = false;
  console.log(`[socket] connected ${socket.id}`);
  // If we connected with installId in auth, handshake is considered valid.
  try {
    // @ts-ignore
    const auth = (socket as any)?.auth;
    if (auth?.installId) __handshakeHasInstallId = true;
  } catch {}
  
  // КРИТИЧНО: Если у нас есть userId, но socket подключился без него - отправляем reauth
  if (currentUserId && !(socket as any).data?.userId) {
    console.log('[socket] Connected without userId, sending reauth:', currentUserId);
    try {
      const reauthResponse = await emitAck<{ ok: boolean; userId?: string; error?: string }>('reauth', { userId: currentUserId });
      if (reauthResponse?.ok) {
        console.log('[socket] Reauth successful after connect');
      } else {
        console.warn('[socket] Reauth failed after connect:', reauthResponse?.error);
        // Если пользователь не найден на сервере - очищаем локальный userId и создаем нового
        if (reauthResponse?.error === 'user_not_found') {
          console.warn('[socket] User not found on server, clearing local userId and creating new user...');
          clearCurrentUserId();
          await createUser();
        }
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
  // На следующем коннекте снова гарантируем наличие installId в handshake
  __handshakeHasInstallId = false;
  const reason = String(r || '');
  const isExpectedUserBackgroundDisconnect = reason === 'io client disconnect';
  if (isExpectedUserBackgroundDisconnect) {
    const note = __realtimePaused ? 'app in background / screen locked' : 'user-initiated disconnect';
    logger.info(`[socket] temporary disconnect (${note}) reason=${reason || 'unknown'}`);
  } else if (transient.includes(reason)) {
    logger.warn(`[socket] disconnected (${reason}) reconnecting=${reconnecting}`);
  } else {
    logger.warn(`[socket] disconnected (${reason || 'unknown'}) reconnecting=${reconnecting}`);
  }
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
  // CRITICAL: ensure installId is attached before any implicit connect().
  // Some codepaths call waitForConnect() (emitAck) which triggers socket.connect().
  // Without installId in handshake server can treat client as guest and return empty profile/avatar.
  try {
    const installId = await getInstallId();
    // @ts-ignore
    const prevAuth =
      (socket as any)?.auth && typeof (socket as any).auth === 'object' ? (socket as any).auth : {};
    // @ts-ignore
    socket.auth = { ...prevAuth, installId, ...(currentUserId ? { userId: currentUserId } : {}) };
  } catch {}
  return new Promise((resolve, reject) => {
    const onOk = () => { cleanup(); resolve(); };
    const t = setTimeout(() => { cleanup(); reject(new Error("wait connect timeout")); }, ms);
    const cleanup = () => { clearTimeout(t); socket.off("connect", onOk); };
    socket.once("connect", onOk);
    // гарантируем попытку соединения
    try { socket.connect(); } catch {}
  });
}

/** Ждёт подключения сокета (с таймаутом). Нужно при отмене вызова из вне приложения, чтобы call:decline дошёл до сервера и caller получил call:declined. */
export async function ensureSocketConnected(ms = 5000): Promise<void> {
  if (socket.connected) return;
  try {
    await waitForConnect(ms);
  } catch {
    // Таймаут — всё равно вызываем declineCall ниже, emit может уйти в очередь
  }
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
  const viaSocket = () =>
    emitAck<{ ok: boolean; status?: string; error?: string }>('friends:add', { to: toUserId });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const url = `${API_BASE}/api/friends/add`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ to: toUserId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}
export const inviteFriend = addFriend;
export const requestFriend = addFriend; // Для обратной совместимости

export function respondFriend(fromUserId: string, accept: boolean, requestId?: string) {
  if (!isOid(fromUserId)) return Promise.reject(new Error("invalid ObjectId"));
  const viaSocket = () =>
    emitAck<{ ok: boolean; status?: string; error?: string }>('friends:respond', { from: fromUserId, accept, requestId });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const url = `${API_BASE}/api/friends/respond`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ from: fromUserId, accept }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}

export function acceptInvite(inviterId: string) {
  if (!isOid(inviterId)) return Promise.reject(new Error("invalid ObjectId"));
  const viaSocket = () =>
    emitAck<{ ok: boolean; status?: string; error?: string }>('friends:acceptInvite', { inviterId });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const url = `${API_BASE}/api/friends/acceptInvite`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ inviterId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}

export function fetchFriends(page: number = 1, limit: number = 50) {
  const viaSocket = () =>
    emitAck<{
      ok: boolean;
      list: FriendListItem[];
      pagination?: {
        page: number;
        limit: number;
        total: number;
        hasMore: boolean;
      };
      error?: string;
    }>('friends:fetch', { page, limit });

  // Fallback for networks/VPNs that break socket connectivity:
  // use REST endpoint that returns the same list shape.
  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    // Legacy/audit-only header (server does NOT trust it, but may log mismatch).
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    // "Fast but safe" strategy:
    // - first attempt: short timeout (good networks feel instant)
    // - second attempt: longer timeout (slow VPN still succeeds)
    const timeouts = [7000, 20000];
    let lastErr: any = null;
    const url = `${API_BASE}/api/friends?page=${encodeURIComponent(String(page))}&limit=${encodeURIComponent(String(limit))}`;

    for (const ms of timeouts) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          return { ok: false, list: [], error: `http_${res.status}${txt ? `:${txt}` : ''}` };
        }
        return await res.json();
      } catch (e: any) {
        lastErr = e;
        // If it's a timeout, just retry with the longer budget.
        // For other errors (DNS/VPN drop), retry once too — it can be transient.
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return { ok: false, list: [], error: lastErr?.message || String(lastErr || 'network_error') };
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch (e) {
      return await viaHttp();
    }
  })();
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
  const viaSocket = () => emitAck<{ ok: boolean; error?: string }>('friends:remove', { peerId });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const url = `${API_BASE}/api/friends/remove`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ peerId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}

// Проверка реферальной ссылки
export async function checkInviteLink(code: string): Promise<{
  ok: boolean;
  inviter?: {
    id: string;
    nick: string;
    avatar: string;
    avatarVer: number;
    avatarThumbB64: string;
  };
  areFriends?: boolean;
  hasPendingRequest?: boolean;
  canAdd?: boolean;
  error?: string;
}> {
  try {
    if (!isOid(code)) {
      return { ok: false, error: 'invalid_code' };
    }

    const userId = getCurrentUserId();
    const headers: Record<string, string> = {};
    // Prefer installId so backend can resolve user securely.
    try {
      const installId = await getInstallId();
      if (installId) headers['x-install-id'] = String(installId);
    } catch {}
    
    if (userId) {
      headers['x-user-id'] = userId;
    }

    const url = `${API_BASE}/api/invite/${code}`;
    logger.debug('Checking invite link:', { url, code, userId });
    
    const response = await fetch(url, {
      method: 'GET',
      headers,
    });

    // Проверяем статус ответа
    if (!response.ok) {
      const text = await response.text();
      logger.error('Invite link check failed:', { 
        status: response.status, 
        statusText: response.statusText,
        url,
        responseText: text.substring(0, 200) // Первые 200 символов для отладки
      });
      return { ok: false, error: `http_error_${response.status}` };
    }

    // Проверяем Content-Type
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      logger.error('Invite link check returned non-JSON:', { 
        contentType,
        url,
        responseText: text.substring(0, 200) // Первые 200 символов для отладки
      });
      return { ok: false, error: 'invalid_response_format' };
    }

    const data = await response.json();
    logger.debug('Invite link check success:', { code, hasInviter: !!data.inviter });
    return data;
  } catch (e: any) {
    logger.error('Failed to check invite link:', { 
      error: e?.message || e,
      code,
      stack: e?.stack 
    });
    return { ok: false, error: e?.message || 'network_error' };
  }
}

export function checkFriendship(userId: string) {
  if (!isOid(userId)) return Promise.reject(new Error("invalid ObjectId"));
  const viaSocket = () =>
    emitAck<{ ok: boolean; areFriends: boolean; error?: string }>('friends:check', { userId });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const timeouts = [5000, 12000];
    let lastErr: any = null;
    const url = `${API_BASE}/api/friends/check/${encodeURIComponent(String(userId))}`;

    for (const ms of timeouts) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          return { ok: false, areFriends: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
        }
        return await res.json();
      } catch (e: any) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return { ok: false, areFriends: false, error: lastErr?.message || String(lastErr || 'network_error') };
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch (e) {
      return await viaHttp();
    }
  })();
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
  // КРИТИЧНО: Добавляем таймаут 8 секунд для защиты от зависания MongoDB
  const viaSocket = () =>
    emitAck<{
      ok: boolean;
      profile?: {
        nick?: string;
        avatarUrl?: string;
        avatarB64?: string;
        avatarThumbB64?: string;
        avatarVer?: number;
      };
      error?: string;
    }>('profile:me', undefined, 8000);

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const timeouts = [5000, 12000];
    let lastErr: any = null;
    const url = `${API_BASE}/me`;

    for (const ms of timeouts) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
        }
        const data = await res.json();
        if (data?.ok && data?.user) {
          return {
            ok: true,
            profile: {
              nick: data.user.nick || '',
              avatarUrl: data.user.avatar || '',
              avatarVer: data.user.avatarVer || 0,
            },
          };
        }
        return { ok: false, error: 'invalid_response' };
      } catch (e: any) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return { ok: false, error: lastErr?.message || String(lastErr || 'network_error') };
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}
export function updateProfile(patch: { nick?: string; avatar?: string }) {
  const clean: { nick?: string; avatar?: string } = {};
  const hasNick = typeof patch.nick === "string";
  if (hasNick) clean.nick = patch.nick;

  // ⚠️ КРИТИЧНО:
  // На сервере `avatar: ''` трактуется как УДАЛЕНИЕ аватара.
  // Поэтому:
  // - отправляем avatar='' ТОЛЬКО если это явная операция удаления (нет nick в patch)
  // - отправляем avatar только если это http(s) URL
  // - data:/file:/content:/ph: и т.п. НЕ отправляем
  if (typeof patch.avatar === "string") {
    const a = patch.avatar.trim();
    if (a === "") {
      if (!hasNick) clean.avatar = "";
    } else if (/^https?:\/\//i.test(a)) {
      clean.avatar = a;
    }
  }

  const viaSocket = () =>
    emitAck<{ ok: boolean; profile?: { nick?: string; avatar?: string }; error?: string }>(
      'profile:update',
      clean,
      5000
    );

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const timeouts = [5000, 12000];
    let lastErr: any = null;
    const url = `${API_BASE}/api/me`;
    for (const ms of timeouts) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(url, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(clean),
          signal: controller.signal,
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
        }
        const data = await res.json();
        if (data?.ok && data?.user) {
          return { ok: true, profile: { nick: data.user.nick || '', avatar: data.user.avatar || '' } };
        }
        return data;
      } catch (e: any) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return { ok: false, error: lastErr?.message || String(lastErr || 'network_error') };
  };

  const promise = (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();

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
  __notifyCurrentUserId();
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
// ВАЖНО: отрицательный результат нельзя кэшировать надолго — иначе после восстановления/создания пользователя
// приложение будет зацикливаться на "user_not_found" и делать hard reset по старому кэшу.
const USER_EXISTS_CACHE_TTL_TRUE = 30000; // 30s
const USER_EXISTS_CACHE_TTL_FALSE = 1500; // 1.5s (почти "debounce")
// Чтобы не спамить логами при частых проверках (например, при resume/focus)
let __lastUserExistsCacheLogAt = 0;

// Защита от одновременных вызовов для одного userId
const pendingChecks = new Map<string, Promise<boolean | null>>();
// Чтобы не спамить "Waiting for pending check" при множественных параллельных вызовах
const pendingWaitLogged = new Set<string>();

// Функция для проверки существования пользователя с retry и кэшированием
export async function checkUserExists(userId: string): Promise<boolean | null> {
  // Проверяем кэш
  const cached = userExistsCache.get(userId);
  if (cached) {
    const ttl = cached.result ? USER_EXISTS_CACHE_TTL_TRUE : USER_EXISTS_CACHE_TTL_FALSE;
    if (Date.now() - cached.timestamp < ttl) {
    // Log at most once per ~10s to avoid noisy dev console spam
    const now = Date.now();
    if (__DEV__ && now - __lastUserExistsCacheLogAt > 10_000) {
      __lastUserExistsCacheLogAt = now;
      logger.debug('[checkUserExists] Using cached result', { result: cached.result });
    }
    return cached.result;
    }
  }
  
  // Защита от одновременных вызовов - если уже есть запрос для этого userId, ждем его
  const pending = pendingChecks.get(userId);
  if (pending) {
    if (!pendingWaitLogged.has(userId)) {
      pendingWaitLogged.add(userId);
      logger.debug('[checkUserExists] Waiting for pending check', { userId });
    }
    return pending;
  }
  
  // Создаем новый запрос
  const checkPromise = (async () => {
    try {
  logger.debug('[checkUserExists] Checking user', { userId });
  
      // ПРИОРИТЕТ: Используем socket.io если подключен, иначе HTTP
      if (socketInstance?.connected) {
        try {
          const socketResult = await checkUserExistsSocket(userId);
          // ВАЖНО: не интерпретируем ok=false как exists=false (например, когда БД временно недоступна).
          if (socketResult?.ok === true && typeof (socketResult as any).exists === 'boolean') {
            const exists = (socketResult as any).exists as boolean;
            userExistsCache.set(userId, { result: exists, timestamp: Date.now() });
            logger.debug('[checkUserExists] User exists (via socket)', { userId, exists });
            return exists;
          }
          // ok=false / нет exists -> fallback to HTTP
        } catch (socketError) {
          // Не логируем как warning - это нормально если socket временно недоступен
          logger.debug('[checkUserExists] Socket check failed, falling back to HTTP');
        }
      }
      
      // Fallback: HTTP запрос с retry (только если socket не работает)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
          // Логируем только первую попытку, чтобы не засорять логи
          if (attempt === 1) {
            logger.debug('[checkUserExists] Attempt (HTTP)', { attempt, maxAttempts: 2 });
          }
          
          // Создаем AbortController для timeout (fallback для старых версий)
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${API_BASE}/api/exists/${userId}`, {
        method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal
      });
          
          clearTimeout(timeoutId);
      
      if (!response.ok) {
            if (attempt === 2) {
              console.warn(`[checkUserExists] HTTP failed after ${attempt} attempts, status:`, response.status);
            }
        if (attempt < 2) {
              await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        return null;
      }
      
      const data = await response.json();
      if (data.ok) {
            logger.debug('[checkUserExists] User exists (via HTTP)', { userId, exists: data.exists });
        userExistsCache.set(userId, { result: data.exists, timestamp: Date.now() });
        return data.exists;
      }
        } catch (e: any) {
          // Логируем только финальную ошибку, не каждую попытку
          if (attempt === 2) {
            const errorMsg = e?.message || String(e);
            // Не логируем как warning если это просто network error - это нормально для мобильных
            if (errorMsg.includes('Network request failed') || errorMsg.includes('timeout')) {
              logger.debug('[checkUserExists] Network unavailable, will retry later', { attempt, maxAttempts: 2 });
            } else {
              console.warn(`[checkUserExists] HTTP error (attempt ${attempt}/2):`, errorMsg);
            }
          }
      if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
    }
  }
  
      // Не логируем как warning - это нормальная ситуация когда сервер временно недоступен
      logger.debug('[checkUserExists] All attempts failed, server temporarily unavailable');
  return null; // null = неизвестно (сервер не готов)
    } finally {
      // Удаляем из pending после завершения
      pendingChecks.delete(userId);
      pendingWaitLogged.delete(userId);
    }
  })();
  
  // Сохраняем promise для защиты от дубликатов
  pendingChecks.set(userId, checkPromise);
  
  return checkPromise;
}

async function createUserInternal(): Promise<string | null> {
  console.log('[createUser] Creating user...');
  
  // КРИТИЧНО: Проверяем существование пользователя на сервере перед пропуском создания
  if (currentUserId) {
    try {
      const exists = await checkUserExists(currentUserId);
      if (exists) {
        console.log('[createUser] User already exists on server:', currentUserId, 'skipping creation');
        return currentUserId;
      } else {
        console.warn('[createUser] User exists locally but not on server, clearing and creating new...');
        clearCurrentUserId();
      }
    } catch (e) {
      console.warn('[createUser] Failed to check user existence, clearing local userId:', e);
      clearCurrentUserId();
    }
  }
  
  // Очищаем старый userId и все локальные данные из AsyncStorage
  try {
    await AsyncStorage.removeItem("userId");
    // актуальные ключи
    await AsyncStorage.removeItem('livi.profile.v1');
    await AsyncStorage.removeItem('profile_draft_v1');
    // legacy keys (на случай старых версий)
    await AsyncStorage.removeItem('profile');
    await AsyncStorage.removeItem('livi.home.draft.v1');
    console.log('[createUser] Cleared old userId and all local data from AsyncStorage');
  } catch (e) {
    console.warn('[createUser] Failed to clear AsyncStorage:', e);
  }
  
  let installId = await getInstallId();

  // Retry до 5 раз с задержкой
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`[createUser] Attempt ${attempt}/5...`);
      
      // Используем identity:attach для создания пользователя
      const response = await identityAttach({ installId });
      
      if (response?.ok && response?.userId) {
        // ВАЖНО: сервер может вернуть userId, который уже удалён из БД (например, по старой связке installId→userId).
        // Поэтому подтверждаем существование перед тем как считать создание успешным.
        const candidateId = String(response.userId);
        const exists = await checkUserExists(candidateId);

        if (exists) {
          setCurrentUserId(candidateId);
          await applyAuthAndConnect();
          console.log('[createUser] User created successfully:', candidateId);
          return candidateId;
        }

        console.warn('[createUser] identity:attach returned non-existing userId, resetting installId and retrying...', {
          candidateId,
          exists,
        });
        const { resetInstallId } = await import('../utils/installId');
        await resetInstallId();
        clearCurrentUserId();
        installId = await getInstallId();
        continue;
      }
      
      if (response?.error === 'duplicate_request') {
        // КРИТИЧНО: Проверяем, существует ли пользователь на сервере
        // Если пользователь был удален из БД, getMyUserId может вернуть старый userId
        const existing = await getMyUserId();
        if (existing) {
          const exists = await checkUserExists(existing);
          if (exists) {
            // Пользователь существует на сервере - используем его
            setCurrentUserId(existing);
            await applyAuthAndConnect();
            console.log('[createUser] Existing user restored from installId:', existing);
            return existing;
          } else {
            // Пользователь не существует на сервере - очищаем installId и создаем нового
            console.warn('[createUser] User from duplicate_request does not exist on server, clearing installId and creating new user...');
            const { resetInstallId } = await import('../utils/installId');
            await resetInstallId();
            clearCurrentUserId();
            // Продолжаем цикл retry с новым installId
            const newInstallId = await getInstallId();
            continue;
          }
        } else {
          // Не удалось получить userId - ждем и повторяем
          console.warn('[createUser] duplicate_request but no userId found, retrying...');
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
      }
      
      // КРИТИЧНО: Если БД недоступна, не бросаем ошибку сразу - ждем и повторяем
      // Это позволяет приложению работать даже если БД временно недоступна
      if (response?.error === 'database_unavailable') {
        console.warn(`[createUser] Database unavailable on attempt ${attempt}, will retry...`);
        // Продолжаем цикл retry - следующая попытка будет через 2 секунды
        throw new Error('database_unavailable');
      }
      
      throw new Error(response?.error || 'Failed to create user');
      
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

// Функция для создания пользователя с retry
export async function createUser(): Promise<string | null> {
  if (createUserPromise) {
    console.log('[createUser] Creation already in progress, waiting for existing promise');
    return createUserPromise;
  }

  createUserPromise = (async () => {
    try {
      return await createUserInternal();
    } catch (error) {
      throw error;
    }
  })();

  try {
    return await createUserPromise;
  } finally {
    createUserPromise = null;
  }
}

export const isCreateUserInProgress = () => !!createUserPromise;
export async function waitForCreateUserCompletion(): Promise<string | null> {
  if (!createUserPromise) return null;
  return createUserPromise.catch((error) => { throw error; });
}

export function getCurrentUserId(): string | undefined {
  return currentUserId;
}

export function setCurrentUserId(userId: string) {
  // Логи setCurrentUserId убраны - показывают только рабочее состояние
  currentUserId = userId;
  __notifyCurrentUserId();
  // При смене userId — сбрасываем кэш существования, чтобы не залипать на старом false
  try { userExistsCache.delete(String(userId)); } catch {}
  // Сохраняем в AsyncStorage без переподключения
  AsyncStorage.setItem("userId", userId).catch(e => console.warn('Failed to save userId to storage:', e));
}

// КРИТИЧНО: Функция для сброса currentUserId (нужна после удаления профиля)
export function clearCurrentUserId() {
  currentUserId = undefined;
  __notifyCurrentUserId();
  // При сбросе identity — сбрасываем кэши проверок, чтобы новые попытки были "чистыми"
  try { userExistsCache.clear(); } catch {}
  try { pendingChecks.clear(); } catch {}
  AsyncStorage.removeItem("userId").catch(e => console.warn('Failed to remove userId from storage:', e));
  console.log('[clearCurrentUserId] Cleared currentUserId');
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
  type: 'text' | 'image' | 'audio' | 'video' | 'document';
  uri?: string;
  name?: string;
  size?: number;
  duration?: number;
}) {
  // Ограничиваем типы сообщений для новой системы
  const messageType = payload.type === 'video' || payload.type === 'document' ? 'text' : payload.type;

  const viaSocket = () =>
    emitAck<{ ok: boolean; messageId?: string; timestamp?: Date; delivered?: boolean; error?: string }>(
      'message:send',
      { to: payload.to, text: payload.text, type: messageType, uri: payload.uri, name: payload.name, size: payload.size, duration: payload.duration }
    );

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const url = `${API_BASE}/api/messages/send`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ to: payload.to, text: payload.text, type: messageType, uri: payload.uri, name: payload.name, size: payload.size, duration: payload.duration }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      const r = await viaSocket();
      // IMPORTANT: if socket responds with ok=false (no throw), fall back to HTTP.
      // This improves reliability (e.g. during transient auth/reauth timing or server hiccups),
      // and still supports offline recipients via backend persistence.
      if ((r as any)?.ok === true) return r;
      return await viaHttp();
    } catch {
      return await viaHttp();
    }
  })();
}

export function markMessagesAsRead(from: string) {
  const viaSocket = () => emitAck<{ ok: boolean; error?: string }>('messages:mark_read', { from });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const url = `${API_BASE}/api/messages/mark_read`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ from }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}

export function sendReadReceipt(messageId: string, from: string) {
  socket.emit('message:read', { messageId, from });
}

export function sendChatTyping(payload: { to: string; typing?: boolean; recording?: boolean }) {
  try {
    if (__DEV__) {
      try {
        // По умолчанию выключаем спам логов typing.
        // Если нужно включить — поставь true и получишь короткие логи только при смене состояния.
        const DEV_LOG_CHAT_TYPING = false;
        if (!DEV_LOG_CHAT_TYPING) {
          // всё равно продолжаем отправлять событие
          throw new Error('__skip_dev_typing_log__');
        }
        const to = String(payload.to || '');
        const typing = !!payload.typing;
        const key = `send:${to}`;
        const prev = __devTypingLogState.get(key);
        if (prev !== typing) {
          __devTypingLogState.set(key, typing);
          // Короткий формат: меньше шума в Metro
          console.log(`[chat:typing] send ${typing ? '1' : '0'} -> ${to}`);
        }
      } catch {}
    }
    socket.emit('chat:typing', {
      to: payload.to,
      typing: !!payload.typing,
      recording: payload.recording === undefined ? undefined : !!payload.recording,
    });
  } catch {}
}

export function onChatTyping(
  cb: (data: { from: string; to: string; typing: boolean; recording?: boolean; ts?: string }) => void
): () => void {
  const h = (data: any) => {
    if (__DEV__) {
      try {
        const DEV_LOG_CHAT_TYPING = false;
        if (!DEV_LOG_CHAT_TYPING) {
          throw new Error('__skip_dev_typing_log__');
        }
        const from = String(data?.from || '');
        const to = String(data?.to || '');
        const typing = !!data?.typing;
        const key = `recv:${from}->${to}`;
        const prev = __devTypingLogState.get(key);
        if (prev !== typing) {
          __devTypingLogState.set(key, typing);
          console.log(`[chat:typing] recv ${typing ? '1' : '0'} ${from} -> ${to}`);
        }
      } catch {}
    }
    cb(data);
  };
  socket.on('chat:typing', h);
  return () => {
    socket.off('chat:typing', h);
  };
}

// Новая функция для получения сообщений
export function fetchMessages(payload: {
  with: string;
  limit?: number;
  before?: string;
}) {
  const viaSocket = () =>
    emitAck<{
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
    }>('messages:fetch', payload);

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const url =
      `${API_BASE}/api/messages?with=${encodeURIComponent(String(payload.with))}` +
      `&limit=${encodeURIComponent(String(payload.limit ?? 50))}` +
      (payload.before ? `&before=${encodeURIComponent(String(payload.before))}` : '');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      const r: any = await viaSocket();
      // IMPORTANT: if socket returns ok=false (no throw), fall back to HTTP.
      // This is common right after device wake / reconnect when auth/reauth is still settling.
      if (r?.ok === true) return r;
      return await viaHttp();
    } catch {
      return await viaHttp();
    }
  })();
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

/** Поставить/снять реакцию на сообщение. with = peerId чата. */
export function sendMessageReaction(messageId: string, emoji: string, withPeerId: string) {
  return emitAck<{ ok: boolean; reactions?: { emoji: string; userId: string }[]; error?: string }>(
    "message:react",
    { messageId, emoji, with: withPeerId }
  );
}

export function onMessageReaction(
  cb: (data: { messageId: string; reactions: { emoji: string; userId: string }[] }) => void
): () => void {
  const h = (data: any) => cb(data);
  socket.on("message:reaction", h);
  return () => socket.off("message:reaction", h);
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
    const viaSocket = async () => {
      const result = await emitAck('message:clear_chat', { with: peerId, forAll });
      return !!result?.ok;
    };

    const viaHttp = async () => {
      const installId = await getInstallId().catch(() => '');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (installId) headers['x-install-id'] = String(installId);
      if (currentUserId) headers['x-user-id'] = String(currentUserId);

      const url = `${API_BASE}/api/messages/clear_chat`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ with: peerId, forAll }),
          signal: controller.signal,
        });
        if (!res.ok) return false;
        const data = await res.json().catch(() => null);
        return !!data?.ok;
      } finally {
        clearTimeout(timeoutId);
      }
    };

    let ok = false;
    try {
      ok = await viaSocket();
    } catch {
      ok = await viaHttp();
    }

    if (ok) {
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
    const viaSocket = async () => {
      return await emitAck('message:delete', { messageId });
    };

    const viaHttp = async () => {
      const installId = await getInstallId().catch(() => '');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (installId) headers['x-install-id'] = String(installId);
      if (currentUserId) headers['x-user-id'] = String(currentUserId);

      const url = `${API_BASE}/api/messages/delete`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ messageId }),
          signal: controller.signal,
        });
        if (!res.ok) return false;
        const data = await res.json().catch(() => null);
        return !!data?.ok;
      } finally {
        clearTimeout(timeoutId);
      }
    };

    try {
      const r: any = await viaSocket();
      // IMPORTANT: if socket responds with ok=false (no throw), fall back to HTTP for reliability.
      if (r?.ok === true) return true;
      return await viaHttp();
    } catch {
      return await viaHttp();
    }
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

/** Запросить payload call:accepted у сервера (после FCM call_accepted, когда приложение вывели на передний план). */
export function requestCallAccepted(callId: string) {
  socket.emit('call:getAccepted', { callId });
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
