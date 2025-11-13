// cometchat.ts
import { CometChat } from "@cometchat/chat-sdk-react-native";
import { CometChatUIKit } from "@cometchat/chat-uikit-react-native";

const appID = process.env.EXPO_PUBLIC_COMETCHAT_APP_ID!;
const region = process.env.EXPO_PUBLIC_COMETCHAT_REGION!;
const authKey = process.env.EXPO_PUBLIC_COMETCHAT_AUTH_KEY!;

let isInitialized = false;

/** ====== Init ====== */
export async function ensureCometChatReady(): Promise<void> {
  if (isInitialized) return;
  await CometChatUIKit.init({ appId: appID, region });
  isInitialized = true;
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
    if (error?.code === 'NOT_FOUND') {
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

/** ====== Обновление профиля ====== */
export async function updateMyProfile(nick?: string, avatarUrl?: string) {
  try {
    const user = await CometChatUIKit.getLoggedInUser(); // CometChat.User | null
    if (!user) return;

    const uid = user.getUid();
    if (!uid) return;

    try {
      const updated = await CometChat.updateUser(
        {
          uid,
          name: nick || user.getName() || undefined,
          avatar: avatarUrl || user.getAvatar() || undefined,
        },
        authKey
      );
      return updated;
    } catch (updateError: any) {
      // Если пользователь не найден, попробуем создать его
      if (updateError?.code === 'NOT_FOUND' || updateError?.message?.includes('not found')) {
        try {
          const newUser = await createCometChatUser(uid, nick || user.getName(), avatarUrl || user.getAvatar());
          return newUser;
        } catch (createError: any) {
          // Если создание тоже не удалось, логируем как информационное сообщение
          console.log("ℹ️ CometChat user not found, skipping profile sync");
        }
      } else {
        // Для других ошибок логируем как информационное сообщение
        console.log("ℹ️ CometChat profile update skipped:", updateError?.message || 'Unknown error');
      }
    }
  } catch (e) {
    console.log("ℹ️ CometChat profile update skipped:", e);
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
    await updateMyProfile(nick, avatarUrl);
  } catch (error) {
    // Не прерываем работу при ошибке синхронизации профиля
    // CometChat может быть не настроен, это не критично
    console.log('ℹ️ CometChat profile sync skipped (not configured)');
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
