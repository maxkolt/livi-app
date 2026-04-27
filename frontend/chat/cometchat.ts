// cometchat.ts
import { CometChat } from "@cometchat/chat-sdk-react-native";
import { CometChatUIKit } from "@cometchat/chat-uikit-react-native";
import { getCurrentUserId } from "../sockets/socket";
import { emitCometChatStatus } from "../utils/globalEvents";
import { logger } from "../utils/logger";

const appID = process.env.EXPO_PUBLIC_COMETCHAT_APP_ID || '';
const region = process.env.EXPO_PUBLIC_COMETCHAT_REGION || '';
const authKey = process.env.EXPO_PUBLIC_COMETCHAT_AUTH_KEY || '';

// Проверка наличия обязательных переменных
if (!appID || !region || !authKey) {
  logger.warn('[CometChat] Variables not configured:', {
    hasAppID: !!appID,
    hasRegion: !!region,
    hasAuthKey: !!authKey
  });
}

let isInitialized = false;
let initPromise: Promise<void> | null = null;
let lastCometChatStatusKey: string | null = null;
let lastCometChatStatusAt = 0;
const COMETCHAT_STATUS_DEDUP_MS = 15_000;
const COMETCHAT_RETRY_DELAYS_MS = [250, 600, 1100];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * CometChatUIKit.getLoggedInUser() при отсутствии сессии бросает CometChatException
 * code NOT_FOUND / message "Login user not found" — это не ошибка подключения, а «ещё не залогинены».
 * Нельзя вызывать UIKit.getLoggedInUser без перехвата: иначе ложный toast «connection failed».
 */
async function safeGetLoggedInUser(): Promise<CometChat.User | null> {
  try {
    return await CometChatUIKit.getLoggedInUser();
  } catch (e: any) {
    const code = e?.code ?? e?.getCode?.();
    const msg = typeof e?.message === 'string' ? e.message : '';
    if (code === 'NOT_FOUND' || msg.includes('Login user not found')) {
      return null;
    }
    logger.debug('[CometChat] getLoggedInUser failed (treated as logged out)', e);
    return null;
  }
}

function emitCometChatProblem(source: string, title: string, message: string, uid?: string) {
  const key = [source, uid || '', title, message].join('|');
  const now = Date.now();
  if (lastCometChatStatusKey === key && now - lastCometChatStatusAt < COMETCHAT_STATUS_DEDUP_MS) {
    return;
  }
  lastCometChatStatusKey = key;
  lastCometChatStatusAt = now;
  logger.warn('[CometChat]', { source, title, message, uid });
  emitCometChatStatus({
    kind: 'error',
    title,
    message,
    userId: uid,
    source,
  });
}

/** ====== Init ====== */
export async function ensureCometChatReady(): Promise<void> {
  if (isInitialized) return;
  
  // Проверка наличия обязательных переменных перед инициализацией
  if (!appID || !region) {
    logger.warn('[CometChat] Not initialized: missing appID or region');
    return;
  }
  
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      await CometChatUIKit.init({
        appId: appID,
        region,
        ...(authKey ? { authKey } : {}),
      });
      isInitialized = true;
    } catch (error) {
      logger.warn('[CometChat] Initialization failed', error);
      // Не выбрасываем ошибку - приложение должно работать без CometChat
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/** ====== Создание пользователя в CometChat ====== */
export async function createCometChatUser(uid: string, name?: string, avatar?: string): Promise<CometChat.User> {
  await ensureCometChatReady();
  if (!authKey) {
    throw new Error('CometChat authKey is not configured');
  }

  const user = new CometChat.User(uid);
  user.setName(name || `User ${uid.slice(-4)}`);
  if (avatar) user.setAvatar(avatar);
  
  let lastError: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const createdUser = await CometChat.createUser(user, authKey);
      return createdUser;
    } catch (error: any) {
      lastError = error;
      if (error?.code === 'ERR_UID_ALREADY_EXISTS') {
        try {
          const existingUser = await CometChat.getUser(uid);
          return existingUser;
        } catch (getUserError) {
          lastError = getUserError;
        }
      }
      if (attempt < 3) {
        await sleep(COMETCHAT_RETRY_DELAYS_MS[attempt - 1]);
      }
    }
  }
  throw lastError;
}

/** CometChat SDK отдаёт ошибки по-разному: code на корне, вложенный объект, message-строка или JSON-строка. */
function isCometChatUserMissingError(err: any): boolean {
  if (err == null) return false;
  const code = err.code ?? err.errorCode ?? err?.error?.code;
  const codeStr = code != null ? String(code) : "";
  const msg =
    typeof err.message === "string"
      ? err.message
      : err.message != null
        ? String(err.message)
        : "";
  let blob = `${codeStr} ${msg}`;
  try {
    blob += JSON.stringify(err);
  } catch {
    blob += String(err);
  }
  const lower = blob.toLowerCase();
  return (
    codeStr === "NOT_FOUND" ||
    lower.includes("not_found") ||
    lower.includes("not found") ||
    lower.includes("login user not found") ||
    lower.includes("user not found")
  );
}

function cometChatErrorSummary(err: any): string {
  if (err == null) return "unknown";
  const code = err.code ?? err.errorCode ?? err?.error?.code;
  const msg = typeof err.message === "string" ? err.message : err.message != null ? String(err.message) : "";
  if (code != null && msg) return `${code}: ${msg}`;
  if (msg) return msg;
  if (code != null) return String(code);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** ====== Login ====== */
export async function loginCometChat(uid: string, name?: string, avatar?: string, authToken?: string): Promise<CometChat.User> {
  await ensureCometChatReady();
  if (!authToken && !authKey) {
    throw new Error('CometChat authKey is not configured');
  }

  const performLogin = () => {
    if (authToken) {
      // 🔑 через authToken (лучше для продакшна)
      return CometChatUIKit.login({ uid, authToken });
    }
    // 🔑 через authKey (только для тестов/разработки)
    return CometChat.login(uid, authKey);
  };

  let lastError: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await performLogin();
    } catch (error: any) {
      lastError = error;
      if (isCometChatUserMissingError(error)) {
        await retryCometChatOperation('create-user', () => createCometChatUser(uid, name, avatar), uid, 3);
        try {
          return await performLogin();
        } catch (retryError) {
          lastError = retryError;
          break;
        }
      }
      if (attempt < 3) {
        await sleep(COMETCHAT_RETRY_DELAYS_MS[attempt - 1]);
      }
    }
  }

  emitCometChatProblem('login', 'CometChat login failed', cometChatErrorSummary(lastError), uid);
  throw lastError;
}

/** ====== Logout ====== */
export async function logoutCometChat(): Promise<void> {
  try {
    await CometChatUIKit.logout();
  } catch (e) {
    logger.warn('[CometChat] Logout error', e);
  }
}

async function cometChatUpdateUserPayload(
  uid: string,
  name: string | undefined,
  avatar: string | undefined
): Promise<CometChat.User> {
  if (!authKey) {
    throw new Error('CometChat authKey is not configured');
  }
  return CometChat.updateUser({ uid, name, avatar }, authKey);
}

async function retryCometChatOperation<T>(
  source: string,
  fn: () => Promise<T>,
  uid?: string,
  attempts = 3
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(COMETCHAT_RETRY_DELAYS_MS[Math.min(attempt - 1, COMETCHAT_RETRY_DELAYS_MS.length - 1)]);
      }
    }
  }
  emitCometChatProblem(source, 'CometChat sync failed', cometChatErrorSummary(lastError), uid);
  throw lastError;
}

/** ====== Обновление профиля ====== */
export async function updateMyProfile(nick?: string, avatarUrl?: string) {
  try {
    if (!authKey) return;

    let user = await safeGetLoggedInUser();
    const uidFromSocket = getCurrentUserId();

    if (!user && uidFromSocket) {
      try {
        user = await loginCometChat(uidFromSocket, nick, avatarUrl);
        if (!user) user = await safeGetLoggedInUser();
      } catch {
        return;
      }
    }

    if (!user) return;

    const uid = user.getUid() || uidFromSocket;
    if (!uid) return;

    const name = nick || user.getName() || undefined;
    const avatar = avatarUrl || user.getAvatar() || undefined;

    try {
      return await cometChatUpdateUserPayload(uid, name, avatar);
    } catch (updateError: any) {
      if (!isCometChatUserMissingError(updateError)) {
        emitCometChatProblem('profile-update', 'CometChat profile update failed', cometChatErrorSummary(updateError), uid);
        return;
      }

      try {
        await createCometChatUser(uid, name, avatar);
        return await cometChatUpdateUserPayload(uid, name, avatar);
      } catch (afterCreate: any) {
        if (afterCreate?.code === "ERR_UID_ALREADY_EXISTS") {
          try {
            return await cometChatUpdateUserPayload(uid, name, avatar);
          } catch (e2: any) {
            emitCometChatProblem('profile-update', 'CometChat profile update failed', cometChatErrorSummary(e2), uid);
          }
        } else {
          try {
            await loginCometChat(uid, name, avatar);
            return await cometChatUpdateUserPayload(uid, name, avatar);
          } catch (e3: any) {
            emitCometChatProblem('profile-update', 'CometChat profile sync failed', cometChatErrorSummary(e3), uid);
          }
        }
      }
    }
  } catch (e: any) {
    emitCometChatProblem('profile-update', 'CometChat profile update skipped', cometChatErrorSummary(e), getCurrentUserId());
  }
}

// Типы для событий
export interface CometChatEvent {
  type: string;
  user?: { id: string };
  cid?: string;
  [key: string]: any;
}

// Глобальные переменные для управления состоянием
let eventListeners: Array<(event: CometChatEvent) => void> = [];
let isConnected = false;

/** Сериализация connect/login — параллельные вызовы гоняли UIKit и давали ложные ошибки. */
let connectChainTail: Promise<void> = Promise.resolve();

function runConnectExclusive(fn: () => Promise<void>): Promise<void> {
  const run = connectChainTail.then(() => fn());
  connectChainTail = run.then(
    () => {},
    () => {}
  );
  return run;
}

/** ====== Получить клиент CometChat ====== */
export function getClient(): any {
  return CometChat;
}

/** ====== Подключиться если еще не подключены ====== */
export async function connectStreamIfNeeded(userId?: string, userProfile?: { nick?: string; avatarUrl?: string }): Promise<void> {
  await runConnectExclusive(async () => {
    try {
      await ensureCometChatReady();

      let user = await safeGetLoggedInUser();
      const desiredUid = String(userId || getCurrentUserId() || '').trim();

      if (user && desiredUid && String(user?.getUid?.() || '').trim() !== desiredUid) {
        try {
          await CometChatUIKit.logout();
        } catch {}
        user = null;
      }

      if (!user && desiredUid) {
        try {
          user = await loginCometChat(desiredUid, userProfile?.nick, userProfile?.avatarUrl);
          if (!user) user = await safeGetLoggedInUser();
        } catch (error: any) {
          emitCometChatProblem('connect', 'CometChat login failed', cometChatErrorSummary(error), desiredUid);
          isConnected = false;
          return;
        }
      }

      if (user) {
        isConnected = true;
      } else {
        isConnected = false;
        if (desiredUid) {
          emitCometChatProblem('connect', 'CometChat user missing', 'no_logged_in_user', desiredUid);
        }
      }
    } catch (error) {
      emitCometChatProblem('connect', 'CometChat connection failed', cometChatErrorSummary(error), userId || getCurrentUserId());
      isConnected = false;
    }
  });
}

/** ====== Создать друзей в CometChat ====== */
export async function ensureFriendsInCometChat(friends: Array<{ _id: string; nick?: string; avatarUrl?: string }>): Promise<void> {
  try {
    for (const friend of friends) {
      try {
        await createCometChatUser(friend._id, friend.nick, friend.avatarUrl);
      } catch (error: any) {
        if (error?.code !== 'ERR_UID_ALREADY_EXISTS') {
          logger.warn(`[CometChat] Failed to create CometChat user for ${friend._id}`, error);
        }
      }
    }
  } catch (error) {
    logger.warn('[CometChat] Failed to ensure friends in CometChat', error);
  }
}

/** ====== Открыть DM чат с пользователем ====== */
export async function openDmWith(userId: string): Promise<void> {
  try {
    await connectStreamIfNeeded(getCurrentUserId());
  } catch (error) {
    emitCometChatProblem('open-dm', 'Failed to open CometChat DM', cometChatErrorSummary(error), getCurrentUserId());
    throw error;
  }
}

/** ====== Синхронизировать профиль ====== */
export async function syncMyStreamProfile(nick?: string, avatarUrl?: string): Promise<void> {
  try {
    const uid = getCurrentUserId();
    if (uid) {
      await connectStreamIfNeeded(uid, { nick, avatarUrl });
    }
    const loggedIn = await safeGetLoggedInUser();
    if (!loggedIn) return;
    await updateMyProfile(nick, avatarUrl);
  } catch (error) {
    // Не прерываем работу при ошибке синхронизации профиля
    // CometChat может быть не настроен, это не критично
    emitCometChatProblem('profile-sync', 'CometChat profile sync skipped', cometChatErrorSummary(error), getCurrentUserId());
  }
}

/** ====== Получить количество непрочитанных сообщений от пира ====== */
export async function unreadForPeer(peerId: string): Promise<number> {
  try {
    const user = await safeGetLoggedInUser();
    if (!user) return 0;

    // Получаем список бесед и ищем нужную
    try {
      const conversationRequest = new CometChat.ConversationsRequestBuilder()
        .setLimit(50)
        .setConversationType('user')
        .build();
      
      const conversations = await conversationRequest.fetchNext();
      const conversation = conversations.find((conv: any) => 
        conv.getConversationWith()?.getUid() === peerId
      );
      
      return conversation?.getUnreadMessageCount() || 0;
    } catch {
      return 0;
    }
  } catch (error) {
    logger.warn('[CometChat] Failed to get unread count for peer', { peerId, error });
    return 0;
  }
}

/** ====== Подписаться на события ====== */
export function onStreamEvent(callback: (event: CometChatEvent) => void): () => void {
  eventListeners.push(callback);
  
  // Подписываемся на события CometChat
  const messageListener = new CometChat.MessageListener({
    onTextMessageReceived: (message: any) => {
      callback({
        type: 'message.new',
        user: { id: message.getSender()?.getUid() },
        cid: `messaging:${message.getReceiverId()}`
      });
    },
    onMediaMessageReceived: (message: any) => {
      callback({
        type: 'message.new',
        user: { id: message.getSender()?.getUid() },
        cid: `messaging:${message.getReceiverId()}`
      });
    },
    onCustomMessageReceived: (message: any) => {
      callback({
        type: 'message.new',
        user: { id: message.getSender()?.getUid() },
        cid: `messaging:${message.getReceiverId()}`
      });
    },
    onMessagesRead: (receipt: any) => {
      callback({
        type: 'message.read',
        user: { id: receipt.getSender()?.getUid() },
        cid: `messaging:${receipt.getReceiverId()}`
      });
    }
  });

  const listenerId = `comet_listener_${Date.now()}`;
  CometChat.addMessageListener(listenerId, messageListener);
  
  // Возвращаем функцию для отписки
  return () => {
    const index = eventListeners.indexOf(callback);
    if (index > -1) {
      eventListeners.splice(index, 1);
    }
    CometChat.removeMessageListener(listenerId);
  };
}
