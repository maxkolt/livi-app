import type { ChatMessage } from '../../screens/chat/chatMessageTypes';
import AsyncStorage from "@react-native-async-storage/async-storage";
import { logger } from "../../utils/logger";
import { shared } from "./shared";

// saveMessage делает read-modify-write одного ключа AsyncStorage. Без очереди пачка входящих
// (офлайн-очередь на reconnect) читала один и тот же массив, и последняя запись затирала остальные.
const chatWriteChains = new Map<string, Promise<unknown>>();
function withChatWriteLock<T>(chatKey: string, work: () => Promise<T>): Promise<T> {
  const prev = chatWriteChains.get(chatKey) ?? Promise.resolve();
  const next = prev.then(work, work);
  const settled = next.catch(() => undefined);
  chatWriteChains.set(chatKey, settled);
  void settled.then(() => {
    if (chatWriteChains.get(chatKey) === settled) chatWriteChains.delete(chatKey);
  });
  return next;
}

// Глобальное хранение сообщений
export const globalMessageStorage = {
  // Функция для получения ключа чата
  getChatKey: (userId1: string, userId2: string) => {
    const sortedIds = [userId1, userId2].sort();
    return `chat_messages_${sortedIds[0]}_${sortedIds[1]}`;
  },

  // Сохранение сообщения в AsyncStorage (+ сброс in-memory кэша, чтобы превью/список видели последнее).
  // true — сообщение лежит в хранилище (записано сейчас или уже было).
  saveMessage: async (message: ChatMessage, currentUserId: string): Promise<boolean> => {
    const me = String(currentUserId || "").trim();
    const from = String(message?.from || "").trim();
    const to = String(message?.to || "").trim();
    if (!me || !message?.id) return false;
    // peer = собеседник: для входящего from, для своего — to.
    const peerId = from === me ? to : from;
    if (!peerId) return false;

    const chatKey = globalMessageStorage.getChatKey(me, peerId);
    return withChatWriteLock(chatKey, async () => {
      try {
        const existingMessages = await AsyncStorage.getItem(chatKey);
        const messages: ChatMessage[] = existingMessages ? JSON.parse(existingMessages) : [];
        const isOwn = from === me;

        const replyToPayload =
          message.replyTo && message.replyTo.id
            ? {
                id: String(message.replyTo.id),
                text: message.replyTo.text,
                from: String(message.replyTo.from || ""),
                isOwn: String(message.replyTo.from || "") === me,
              }
            : null;

        const existingIdx = messages.findIndex((m) => String(m?.id) === String(message.id));
        let didWrite = false;
        if (existingIdx < 0) {
          const newMessage: ChatMessage = {
            id: message.id,
            text: message.text,
            type: message.type,
            uri: message.uri,
            name: message.name,
            size: message.size,
            duration: message.duration,
            stickerId: message.stickerId,
            stickerPackId: message.stickerPackId,
            stickerEmoji: message.stickerEmoji,
            stickerLabel: message.stickerLabel,
            ...(message.thumbUri ? { thumbUri: message.thumbUri } : {}),
            sender: isOwn ? "me" : "peer",
            from,
            to,
            timestamp: new Date(message.timestamp!),
          };
          if (message.callDirection) newMessage.callDirection = message.callDirection;
        if (message.e2eUndecryptable) newMessage.e2eUndecryptable = true;
          if (message.localOnly) newMessage.localOnly = true;
          if (Array.isArray(message.uris) && message.uris.length > 1) {
            newMessage.uris = message.uris.map((u) => String(u || "").trim()).filter(Boolean).slice(0, 10);
            if (!newMessage.uri) newMessage.uri = newMessage.uris[0];
          }
          if (replyToPayload) newMessage.replyTo = replyToPayload;
          messages.push(newMessage);
          didWrite = true;
        } else if (messages[existingIdx]?.e2eUndecryptable && !message.e2eUndecryptable && typeof message.text === "string") {
        // Ключ восстановили — заглушку заменяем расшифрованным текстом.
        const { e2eUndecryptable: _stale, ...prevMsg } = messages[existingIdx];
        messages[existingIdx] = { ...prevMsg, text: message.text, ...(replyToPayload ? { replyTo: replyToPayload } : {}) };
        didWrite = true;
      } else if (replyToPayload && !messages[existingIdx]?.replyTo?.id) {
          messages[existingIdx] = { ...messages[existingIdx], replyTo: replyToPayload };
          didWrite = true;
        }
        if (didWrite) {
          await AsyncStorage.setItem(chatKey, JSON.stringify(messages));
          // Иначе getChatMessagesLocal до 5 мин отдаёт старый кэш без входящего → превью «своё последнее».
          const cacheKey = `${me}-${peerId}`;
          shared.messageCache.delete(cacheKey);
        }
        return true;
      } catch (error) {
        logger.warn("Failed to save message globally:", error);
        return false;
      }
    });
  },
};
