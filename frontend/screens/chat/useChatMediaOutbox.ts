/** Media outbox enqueue/retry/drain for failed image/audio sends. */

import React from "react";
import * as FileSystem from "expo-file-system";
import AsyncStorage from "@react-native-async-storage/async-storage";
import socket, { sendMessage as sendSocketMessage } from "../../sockets/socket";
import { uploadMediaToServer } from "../../utils/mediaUpload";
import { getChatMediaOutboxKey } from "./chatStorageKeys";

type ReadStatusMap = Record<string, "sending" | "delivered" | "read" | "failed" | "sent">;

type Options = {
  peerId: string;
  currentUserId: string | null;
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
  messages,
  setMessages,
  uploadStatus,
  setUploadStatus,
  readStatuses,
  updateReadStatuses,
  resolveMediaUri,
}: Options) {
  const [retryUiForId, setRetryUiForId] = React.useState<string | null>(null);
  const mediaOutboxRetryInFlightRef = React.useRef<Set<string>>(new Set());

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
          const localUri = String(m?.uri || "").trim();
          const name = String(m?.name || `voice_${Date.now()}.m4a`);
          const size = Number(m?.size || 0) || 0;
          const durationSec = Number(m?.duration || 0) || 0;

          let remoteUrl = localUri;
          const looksRemote = /^https?:\/\//i.test(remoteUrl);
          if (!looksRemote) {
            const upload = await uploadMediaToServer(localUri, "audio", undefined, currentUserId, peerId);
            if (!upload.success || !upload.url) {
              updateReadStatuses((prev) => ({ ...prev, [mid]: "failed" }));
              setUploadStatus((prev) => ({ ...prev, [mid]: "failed" }));
              return false;
            }
            remoteUrl = upload.url;
          }

          const socketResult: any = await sendSocketMessage({
            to: peerId,
            type: "audio",
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
              const delivery = socketResult.delivered ? "delivered" : "sent";
              next[newId] = delivery;
              delete next[mid];
              return next;
            });

            try {
              if (!looksRemote) await FileSystem.deleteAsync(localUri, { idempotent: true });
            } catch {}
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
              const delivery = socketResult.delivered ? "delivered" : "sent";
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
    const ids = await loadMediaOutboxIds();
    if (!ids.length) return;
    for (const id of ids) {
      if (mediaOutboxRetryInFlightRef.current.has(id)) continue;
      const msg = messages.find((x: any) => String(x?.id) === String(id));
      if (!msg) {
        await dequeueMediaOutboxId(id);
        continue;
      }
      const uri = String(msg?.uri || "").trim();
      const type = String(msg?.type || "").trim();
      const isMedia = type === "image" || type === "audio";
      const canRetry =
        !!uri &&
        (!/^https?:\/\//i.test(uri) || uploadStatus[id] === "failed" || readStatuses[id] === "failed");
      if (!isMedia || !canRetry) continue;
      mediaOutboxRetryInFlightRef.current.add(id);
      try {
        const ok = await retryFailedOutgoingMessage(msg);
        if (ok) await dequeueMediaOutboxId(id);
      } finally {
        mediaOutboxRetryInFlightRef.current.delete(id);
      }
    }
  }, [
    dequeueMediaOutboxId,
    loadMediaOutboxIds,
    messages,
    readStatuses,
    retryFailedOutgoingMessage,
    uploadStatus,
  ]);

  React.useEffect(() => {
    const run = () => {
      void drainMediaOutbox();
    };
    socket.on("connect", run);
    socket.on("reconnect", run);
    run();
    return () => {
      socket.off("connect", run);
      socket.off("reconnect", run);
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
