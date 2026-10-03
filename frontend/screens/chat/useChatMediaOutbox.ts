/** Media outbox enqueue/retry/drain for failed image/audio sends. */

import React from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import socket, { sendMessage as sendSocketMessage } from "../../sockets/socket";
import { uploadMediaToServer } from "../../utils/mediaUpload";
import { getChatMediaOutboxKey } from "./chatStorageKeys";
import { outgoingStatusFromSendResult } from "./chatMessageIds";
import { stickerFieldsFromMessage } from "./chatMessageMeta";

type ReadStatusMap = Record<string, "sending" | "delivered" | "read" | "failed" | "sent">;

type Options = {
  peerId: string;
  currentUserId: string | null;
  /** История чата загружена: раньше «нет такого сообщения» не значит, что его нет. */
  historyReady: boolean;
  messages: any[];
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  uploadStatus: Record<string, "sending" | "sent" | "failed">;
  setUploadStatus: React.Dispatch<React.SetStateAction<Record<string, "sending" | "sent" | "failed">>>;
  readStatuses: ReadStatusMap;
  updateReadStatuses: (updater: (prev: ReadStatusMap) => ReadStatusMap) => void;
  resolveMediaUri: (uri?: string) => string;
};

export function useChatMediaOutbox({
  peerId,
  currentUserId,
  historyReady,
  messages,
  setMessages,
  uploadStatus,
  setUploadStatus,
  readStatuses,
  updateReadStatuses,
  resolveMediaUri,
}: Options) {
  const [retryUiForId, setRetryUiForId] = React.useState<string | null>(null);
  // Drain читает свежие значения из ref: он не должен пересоздаваться на каждое
  // изменение ленты, иначе без сети повтор шёл по кругу (часы ↔ ошибка без конца).
  const messagesRef = React.useRef(messages);
  messagesRef.current = messages;
  const uploadStatusRef = React.useRef(uploadStatus);
  uploadStatusRef.current = uploadStatus;
  const readStatusesRef = React.useRef(readStatuses);
  readStatusesRef.current = readStatuses;
  const drainInFlightRef = React.useRef(false);

  const enqueueMediaOutboxId = React.useCallback(
    async (id: string) => {
      try {
        const uid = String(currentUserId || "").trim();
        const pid = String(peerId || "").trim();
        const mid = String(id || "").trim();
        if (!uid || !pid || !mid) return;
        const key = getChatMediaOutboxKey(uid, pid);
        const raw = await AsyncStorage.getItem(key);
        const list = raw ? (JSON.parse(raw) as string[]) : [];
        const next = Array.isArray(list) ? list.map(String) : [];
        if (!next.includes(mid)) {
          next.push(mid);
          await AsyncStorage.setItem(key, JSON.stringify(next));
        }
      } catch {}
    },
    [currentUserId, peerId],
  );

  const dequeueMediaOutboxId = React.useCallback(
    async (id: string) => {
      try {
        const uid = String(currentUserId || "").trim();
        const pid = String(peerId || "").trim();
        const mid = String(id || "").trim();
        if (!uid || !pid || !mid) return;
        const key = getChatMediaOutboxKey(uid, pid);
        const raw = await AsyncStorage.getItem(key);
        const list = raw ? (JSON.parse(raw) as string[]) : [];
        const next = (Array.isArray(list) ? list.map(String) : []).filter((x) => x !== mid);
        if (next.length) {
          await AsyncStorage.setItem(key, JSON.stringify(next));
        } else {
          await AsyncStorage.removeItem(key);
        }
      } catch {}
    },
    [currentUserId, peerId],
  );

  const loadMediaOutboxIds = React.useCallback(async (): Promise<string[]> => {
    try {
      const uid = String(currentUserId || "").trim();
      const pid = String(peerId || "").trim();
      if (!uid || !pid) return [];
      const key = getChatMediaOutboxKey(uid, pid);
      const raw = await AsyncStorage.getItem(key);
      const list = raw ? (JSON.parse(raw) as string[]) : [];
      return Array.isArray(list) ? Array.from(new Set(list.map(String).filter(Boolean))) : [];
    } catch {
      return [];
    }
  }, [currentUserId, peerId]);

  const retryFailedOutgoingMessage = React.useCallback(
    async (m: any): Promise<boolean> => {
      try {
        if (!m?.id || !currentUserId || !peerId) return false;
        const mid = String(m.id);
        const type = String(m?.type || "").trim();
        if (!type) return false;

        setRetryUiForId(null);
        setUploadStatus((prev) => ({ ...prev, [mid]: "sending" }));
        updateReadStatuses((prev) => ({ ...prev, [mid]: "sending" }));

        if (type === "audio") {
          // Голосовое — в общую очередь: она загрузит файл и дошлёт, когда будет сеть.
          const uri = String(m?.uri || "").trim();
          const socketResult = await sendSocketMessage({
            to: peerId,
            type: "audio",
            ...(/^https?:\/\//i.test(uri) ? { uri } : { localUri: uri }),
            name: String(m?.name || `voice_${mid}.m4a`),
            size: Number(m?.size || 0) || 0,
            duration: Number(m?.duration || 0) || 0,
            clientUiMessageId: mid,
          });
          if (socketResult?.localCancelled) {
            await dequeueMediaOutboxId(mid);
            return true;
          }
          if (socketResult?.ok) {
            // Доставлено или ждёт сети: статус и адрес файла придут событием доставки.
            setUploadStatus((prev) => {
              if (!(mid in prev)) return prev;
              const next = { ...prev };
              delete next[mid];
              return next;
            });
            return true;
          }
          updateReadStatuses((prev) => ({ ...prev, [mid]: "failed" }));
          setUploadStatus((prev) => ({ ...prev, [mid]: "failed" }));
          return false;
        }

        if (type === "image") {
          const localUri = String(m?.uri || "").trim();
          const fileName = String(m?.name || `file_${Date.now()}`);
          const fileSize = Number(m?.size || 0) || 0;

          let remoteUrl = localUri;
          const looksRemote = /^https?:\/\//i.test(remoteUrl);
          if (!looksRemote) {
            const upload = await uploadMediaToServer(localUri, "image", undefined, currentUserId, peerId);
            if (!upload.success || !upload.url) {
              updateReadStatuses((prev) => ({ ...prev, [mid]: "failed" }));
              setUploadStatus((prev) => ({ ...prev, [mid]: "failed" }));
              return false;
            }
            remoteUrl = upload.url;
          }

          const socketResult: any = await sendSocketMessage({
            to: peerId,
            type: "image",
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
                  : msg,
              );
              return updated;
            });

            setUploadStatus((prev) => {
              const next = { ...prev };
              next[newId] = "sent";
              delete next[mid];
              return next;
            });

            updateReadStatuses((prev) => {
              const next = { ...prev };
              const delivery = outgoingStatusFromSendResult(socketResult);
              next[newId] = delivery;
              delete next[mid];
              return next;
            });
            return true;
          }

          updateReadStatuses((prev) => ({ ...prev, [mid]: "failed" }));
          setUploadStatus((prev) => ({ ...prev, [mid]: "failed" }));
          return false;
        }

        if (type === "text" || type === "sticker") {
          // Тот же id: если первая попытка всё же дошла, сервер не задвоит сообщение.
          const replyTo = m?.replyTo?.id
            ? {
                id: String(m.replyTo.id),
                text: m.replyTo.text,
                from: String(m.replyTo.from || ""),
                isOwn: m.replyTo.isOwn,
              }
            : undefined;
          const socketResult = await sendSocketMessage({
            to: peerId,
            type,
            text: m?.text,
            ...(type === "sticker" ? stickerFieldsFromMessage(m) : {}),
            ...(replyTo ? { replyTo } : {}),
            clientUiMessageId: mid,
          });
          if (socketResult?.localCancelled) return true;
          if (socketResult?.ok) {
            setUploadStatus((prev) => {
              const next = { ...prev };
              delete next[mid];
              return next;
            });
            updateReadStatuses((prev) => ({ ...prev, [mid]: outgoingStatusFromSendResult(socketResult) }));
            return true;
          }
          updateReadStatuses((prev) => ({ ...prev, [mid]: "failed" }));
          setUploadStatus((prev) => ({ ...prev, [mid]: "failed" }));
          return false;
        }

        updateReadStatuses((prev) => ({ ...prev, [mid]: "failed" }));
        setUploadStatus((prev) => ({ ...prev, [mid]: "failed" }));
        return false;
      } catch {
        try {
          const mid = String(m?.id || "");
          if (mid) {
            updateReadStatuses((prev) => ({ ...prev, [mid]: "failed" }));
            setUploadStatus((prev) => ({ ...prev, [mid]: "failed" }));
          }
        } catch {}
        return false;
      }
    },
    [currentUserId, peerId, resolveMediaUri, updateReadStatuses, setMessages, setUploadStatus, dequeueMediaOutboxId],
  );

  const drainMediaOutbox = React.useCallback(async () => {
    // До загрузки истории сообщения ещё нет в ленте — иначе удалили бы его из очереди.
    if (!historyReady || drainInFlightRef.current) return;
    drainInFlightRef.current = true;
    try {
      const ids = await loadMediaOutboxIds();
      for (const id of ids) {
        const msg = messagesRef.current.find((x: any) => String(x?.id) === String(id));
        if (!msg) {
          await dequeueMediaOutboxId(id);
          continue;
        }
        const uri = String(msg?.uri || "").trim();
        const type = String(msg?.type || "").trim();
        const isMedia = type === "image" || type === "audio";
        const canRetry =
          !!uri &&
          (!/^https?:\/\//i.test(uri) ||
            uploadStatusRef.current[id] === "failed" ||
            readStatusesRef.current[id] === "failed");
        if (!isMedia || !canRetry) continue;
        const ok = await retryFailedOutgoingMessage(msg);
        if (ok) await dequeueMediaOutboxId(id);
      }
    } finally {
      drainInFlightRef.current = false;
    }
  }, [dequeueMediaOutboxId, historyReady, loadMediaOutboxIds, retryFailedOutgoingMessage]);

  // Повторяем, когда есть шанс: сокет подключился, вернулась сеть, приложение открыли.
  React.useEffect(() => {
    const run = () => {
      void drainMediaOutbox();
    };
    socket.on("connect", run);
    socket.on("reconnect", run);
    const offNet = NetInfo.addEventListener((state) => {
      if (state.isConnected === true && state.isInternetReachable !== false) run();
    });
    const appSub = AppState.addEventListener("change", (state) => {
      if (state === "active") run();
    });
    run();
    return () => {
      socket.off("connect", run);
      socket.off("reconnect", run);
      offNet();
      appSub.remove();
    };
  }, [drainMediaOutbox]);

  return {
    retryUiForId,
    setRetryUiForId,
    enqueueMediaOutboxId,
    dequeueMediaOutboxId,
    retryFailedOutgoingMessage,
  };
}
