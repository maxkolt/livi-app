// cometchat.ts
import { CometChat } from "@cometchat/chat-sdk-react-native";
import { CometChatUIKit } from "@cometchat/chat-uikit-react-native";
import { getCurrentUserId } from "../sockets/socket";

const appID = process.env.EXPO_PUBLIC_COMETCHAT_APP_ID || '';
const region = process.env.EXPO_PUBLIC_COMETCHAT_REGION || '';
const authKey = process.env.EXPO_PUBLIC_COMETCHAT_AUTH_KEY || '';

// Проверка наличия обязательных переменных
if (!appID || !region || !authKey) {
  console.warn('⚠️ CometChat variables not configured:', {
    hasAppID: !!appID,
    hasRegion: !!region,
    hasAuthKey: !!authKey
  });
}

let isInitialized = false;

/** ====== Init ====== */
export async function ensureCometChatReady(): Promise<void> {
  if (isInitialized) return;
  
  // Проверка наличия обязательных переменных перед инициализацией
  if (!appID || !region) {
    console.warn('⚠️ CometChat not initialized: missing appID or region');
    return;
  }
  
  try {
    await CometChatUIKit.init({ appId: appID, region });
    isInitialized = true;
  } catch (error) {
    console.error('❌ CometChat initialization failed:', error);
    // Не выбрасываем ошибку - приложение должно работать без CometChat
  }
}

/** ====== Создание пользователя в CometChat ====== */
export async function createCometChatUser(uid: string, name?: string, avatar?: string): Promise<CometChat.User> {
  await ensureCometChatReady();

  const user = new CometChat.User(uid);
  user.setName(name || `User ${uid.slice(-4)}`);
  if (avatar) user.setAvatar(avatar);
  
  try {
    const createdUser = await CometChat.createUser(user, authKey);
    return createdUser;
  } catch (error: any) {
    if (error?.code === 'ERR_UID_ALREADY_EXISTS') {
      const existingUser = await CometChat.getUser(uid);
      return existingUser;
    }
    throw error;
  }
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

  try {
    if (authToken) {
      // 🔑 через authToken (лучше для продакшна)
      const user = await CometChatUIKit.login({ uid, authToken });
      return user;
    } else {
      // 🔑 через authKey (только для тестов/разработки)
      const user = await CometChat.login(uid, authKey);
      return user;
    }
  } catch (error: any) {
    if (isCometChatUserMissingError(error)) {
      await createCometChatUser(uid, name, avatar);
      // Повторная попытка логина после создания
      const user = await CometChat.login(uid, authKey);
      return user;
    }
    throw error;
  }
}

/** ====== Logout ====== */
export async function logoutCometChat(): Promise<void> {
  try {
    await CometChatUIKit.logout();
  } catch (e) {
    console.error("Logout error", e);
  }
}

async function cometChatUpdateUserPayload(
  uid: string,
  name: string | undefined,
  avatar: string | undefined
): Promise<CometChat.User> {
  return CometChat.updateUser({ uid, name, avatar }, authKey);
}

/** ====== Обновление профиля ====== */
export async function updateMyProfile(nick?: string, avatarUrl?: string) {
  try {
    if (!authKey) return;

    let user = await CometChatUIKit.getLoggedInUser();
    const uidFromSocket = getCurrentUserId();

    if (!user && uidFromSocket) {
      try {
        await loginCometChat(uidFromSocket, nick, avatarUrl);
        user = await CometChatUIKit.getLoggedInUser();
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
        console.log("ℹ️ CometChat profile update skipped:", cometChatErrorSummary(updateError));
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
            console.log("ℹ️ CometChat profile update after existing uid:", cometChatErrorSummary(e2));
          }
        } else {
          try {
            await loginCometChat(uid, name, avatar);
            return await cometChatUpdateUserPayload(uid, name, avatar);
          } catch (e3: any) {
            console.log("ℹ️ CometChat profile sync failed:", cometChatErrorSummary(e3));
          }
        }
      }
    }
  } catch (e: any) {
    console.log("ℹ️ CometChat profile update skipped:", cometChatErrorSummary(e));
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

/** ====== Получить клиент CometChat ====== */
export function getClient(): any {
  return CometChat;
}

/** ====== Подключиться если еще не подключены ====== */
export async function connectStreamIfNeeded(userId?: string, userProfile?: { nick?: string; avatarUrl?: string }): Promise<void> {
  try {
    await ensureCometChatReady();
    
    // Проверяем, есть ли уже залогиненный пользователь
    let user = await CometChatUIKit.getLoggedInUser();
    
    if (!user && userId) {
      // Если пользователя нет, но передан userId, пытаемся залогинить
      try {
        await loginCometChat(userId, userProfile?.nick, userProfile?.avatarUrl);
        user = await CometChatUIKit.getLoggedInUser();
      } catch (error: any) {
        console.error('❌ CometChat login failed:', error);
        // Не выбрасываем ошибку - пусть чат работает без CometChat авторизации
        console.warn('⚠️ Continuing without CometChat login');
        return;
      }
    }
    
    if (user) {
      isConnected = true;
    } else {
      console.warn('⚠️ No CometChat user available, but continuing');
    }
  } catch (error) {
    console.error('❌ CometChat connection failed:', error);
    isConnected = false;
    // Не выбрасываем ошибку - пусть чат работает без CometChat
    console.warn('⚠️ Continuing without CometChat connection');
  }
}

/** ====== Создать друзей в CometChat ====== */
export async function ensureFriendsInCometChat(friends: Array<{ _id: string; nick?: string; avatarUrl?: string }>): Promise<void> {
  try {
    for (const friend of friends) {
      try {
        await createCometChatUser(friend._id, friend.nick, friend.avatarUrl);
      } catch (error: any) {
        if (error?.code !== 'ERR_UID_ALREADY_EXISTS') {
          console.warn(`Failed to create CometChat user for ${friend._id}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('❌ Failed to ensure friends in CometChat:', error);
  }
}

/** ====== Открыть DM чат с пользователем ====== */
export async function openDmWith(userId: string): Promise<void> {
  try {
    await connectStreamIfNeeded();
  } catch (error) {
    console.error('❌ Failed to open DM:', error);
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
    await updateMyProfile(nick, avatarUrl);
  } catch (error) {
    // Не прерываем работу при ошибке синхронизации профиля
    // CometChat может быть не настроен, это не критично
    console.log("ℹ️ CometChat profile sync skipped (not configured)");
  }
}

/** ====== Получить количество непрочитанных сообщений от пира ====== */
export async function unreadForPeer(peerId: string): Promise<number> {
  try {
    const user = await CometChatUIKit.getLoggedInUser();
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
    console.warn('Failed to get unread count for peer:', peerId, error);
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
