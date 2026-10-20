/** Send voice / single image / album from local assets. */

import React from "react";
import { sendMessage as sendSocketMessage } from "../../sockets/socket";
import { uploadMediaToServer } from "../../utils/mediaUpload";
import { CHAT_ALBUM_MAX } from "./chatAlbum";
import { createOptimisticChatMessageId, outgoingStatusFromSendResult } from "./chatMessageIds";
import { keepVoiceRecording } from "./chatVoiceRecord";
import { keepVideoNoteRecording, makeVideoNoteThumb } from "./videoNoteFiles";
import { getChatMessagesKey } from "./chatStorageKeys";
import { patchStoredChatMessage } from "./chatMessageStorageWrite";

type ReadStatusMap = Record<string, "sending" | "delivered" | "read" | "failed" | "sent">;

type Options = {
  peerId: string;
  currentUserId: string | null;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  /** Синхронное зеркало нужно для flush при уходе из чата до следующего render. */
  latestMessagesForPersistRef: React.MutableRefObject<any[]>;
  enqueueMessagesPersist: (reason: string) => void;
  setUploadStatus: React.Dispatch<React.SetStateAction<Record<string, "sending" | "sent" | "failed">>>;
  updateReadStatuses: (updater: (prev: ReadStatusMap) => ReadStatusMap) => void;
  resolveMediaUri: (uri?: string) => string;
  enqueueMediaOutboxId: (id: string) => Promise<void>;
  dequeueMediaOutboxId: (id: string) => Promise<void>;
  setVoiceRecordMs: React.Dispatch<React.SetStateAction<number>>;
};

export function useChatSendMedia({
  peerId,
  currentUserId,
  setMessages,
  latestMessagesForPersistRef,
  enqueueMessagesPersist,
  setUploadStatus,
  updateReadStatuses,
  resolveMediaUri,
  enqueueMediaOutboxId,
  dequeueMediaOutboxId,
  setVoiceRecordMs,
}: Options) {
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Меняем React-ленту и её persist-снимок одним действием. Поэтому мгновенный
   * back после отправки не сохраняет старую ленту без нового сообщения.
   */
  const commitMessages = React.useCallback(
    (update: (prev: any[]) => any[], reason: string) => {
      // После unmount новый экземпляр ChatScreen уже может писать тот же чат. Старый
      // полный снимок нельзя сохранять поверх него; async-медиа ниже использует patch.
      if (!mountedRef.current) return;
      latestMessagesForPersistRef.current = update(latestMessagesForPersistRef.current || []);
      setMessages((prev) => update(prev));
      enqueueMessagesPersist(reason);
    },
    [enqueueMessagesPersist, latestMessagesForPersistRef, setMessages],
  );

  const commitMediaPatch = React.useCallback(
    (messageId: string, patch: Record<string, unknown>, reason: string) => {
      if (mountedRef.current) {
        commitMessages(
          (prev) => prev.map((m) => String(m?.id) === messageId ? { ...m, ...patch } : m),
          reason,
        );
        return;
      }
      const uid = String(currentUserId || "").trim();
      const pid = String(peerId || "").trim();
      if (!uid || !pid) return;
      void patchStoredChatMessage(getChatMessagesKey(uid, pid), messageId, patch);
    },
    [commitMessages, currentUserId, peerId],
  );

  /**
   * Голосовое идёт через общую очередь сообщений: она на диске, сама загрузит файл и
   * отправит, когда будет сеть (даже если чат уже закрыт), и повторит после обрыва.
   * Без сети пузырь стоит с часами, а не мигает «ошибкой».
   */
  const sendVoiceMessageFromLocal = React.useCallback(async (localUri: string, durationMs: number, size?: number) => {
    if (!currentUserId || !peerId) return;

    const messageId = createOptimisticChatMessageId();
    const durationSec = Math.max(1, Math.round(durationMs / 1000));
    const name = `voice_${messageId}.m4a`;
    const optimisticMessage = {
      id: messageId,
      type: 'audio',
      uri: localUri,
      name,
      size: size || 0,
      duration: durationSec,
      sender: 'me',
      from: currentUserId,
      to: peerId,
      timestamp: new Date(),
    };

    // Сначала пузырь. Перенос записи может быть заметным на больших файлах/медленном диске.
    commitMessages(
      (prev) => prev.some((m) => String(m?.id) === messageId) ? prev : [...prev, optimisticMessage],
      'voice_optimistic',
    );
    updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));
    setUploadStatus((prev) => ({ ...prev, [messageId]: 'sending' }));
    setVoiceRecordMs(0);

    // Кэш система может почистить раньше, чем вернётся сеть, — переносим запись к себе.
    const fileUri = await keepVoiceRecording(localUri, messageId);
    if (fileUri !== localUri) {
      commitMediaPatch(messageId, { uri: fileUri }, 'voice_kept_file');
    }

    const clearUploadStatus = () =>
      setUploadStatus((prev) => {
        if (!(messageId in prev)) return prev;
        const next = { ...prev };
        delete next[messageId];
        return next;
      });

    try {
      const result = await sendSocketMessage({
        to: peerId,
        type: 'audio',
        localUri: fileUri,
        name,
        size,
        duration: durationSec,
        clientUiMessageId: messageId,
      });
      if (result?.localCancelled) {
        updateReadStatuses((prev) => {
          const next = { ...prev };
          delete next[messageId];
          return next;
        });
        clearUploadStatus();
        return;
      }
      if (!result?.ok) {
        updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
        setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
        return;
      }
      // Доставлено или ждёт сети в очереди: адрес и галочки придут событием доставки,
      // а пока — только часы, без крутилки загрузки.
      clearUploadStatus();
    } catch {
      clearUploadStatus();
    }
  }, [currentUserId, peerId, commitMessages, commitMediaPatch, setUploadStatus, updateReadStatuses, setVoiceRecordMs]);

  /**
   * Видеокружок — тем же путём, что голосовое: пузырь сразу, файл и кадр-превью загрузит
   * очередь (и без сети — когда она появится).
   */
  const sendVideoNoteFromLocal = React.useCallback(async (localUri: string, durationMs: number) => {
    if (!currentUserId || !peerId) return;

    const messageId = createOptimisticChatMessageId();
    const durationSec = Math.max(1, Math.round(durationMs / 1000));
    const optimisticMessage = {
      id: messageId,
      type: 'video_note',
      uri: localUri,
      duration: durationSec,
      sender: 'me',
      from: currentUserId,
      to: peerId,
      timestamp: new Date(),
    };

    commitMessages(
      (prev) => prev.some((m) => String(m?.id) === messageId) ? prev : [...prev, optimisticMessage],
      'video_note_optimistic',
    );
    updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));
    setVoiceRecordMs(0);

    const fileUri = await keepVideoNoteRecording(localUri, messageId);
    if (fileUri !== localUri) {
      commitMediaPatch(messageId, { uri: fileUri }, 'video_note_kept_file');
    }

    // Кадр-превью — уже после пузыря: кружок в ленте появляется без задержки.
    const thumbUri = await makeVideoNoteThumb(fileUri, messageId);
    if (thumbUri) {
      commitMediaPatch(messageId, { thumbUri }, 'video_note_thumbnail');
    }

    try {
      const result = await sendSocketMessage({
        to: peerId,
        type: 'video_note',
        localUri: fileUri,
        ...(thumbUri ? { localThumbUri: thumbUri } : {}),
        name: `video_note_${messageId}.mp4`,
        duration: durationSec,
        clientUiMessageId: messageId,
      });
      if (result?.localCancelled) {
        updateReadStatuses((prev) => {
          const next = { ...prev };
          delete next[messageId];
          return next;
        });
        return;
      }
      if (!result?.ok) {
        updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
      }
    } catch {}
  }, [currentUserId, peerId, commitMessages, commitMediaPatch, updateReadStatuses, setVoiceRecordMs]);

  const sendPickedImage = React.useCallback(async (asset: any): Promise<boolean> => {
    if (!currentUserId || !peerId) return false;

    const messageId = createOptimisticChatMessageId();
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

    commitMessages((prev) => {
      const existingMessage = prev.find((msg) => msg.id === messageId);
      if (existingMessage) return prev;
      return [...prev, newMessage];
    }, 'image_optimistic');

    updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));

    try {
      setUploadStatus((prev) => ({ ...prev, [messageId]: 'sending' }));

      const uploadResult = await uploadMediaToServer(localUri, messageType, undefined, currentUserId, peerId);
      if (!uploadResult.success || !uploadResult.url) {
        console.error('❌ Media upload failed:', uploadResult.error);
        updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
        setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
        void enqueueMediaOutboxId(messageId);
        return false;
      }

      const socketResult: any = await sendSocketMessage({
        to: peerId,
        type: messageType,
        uri: uploadResult.url,
        name: fileName || undefined,
        size: fileSize || undefined,
        clientUiMessageId: messageId,
      });

      if (socketResult?.localCancelled) {
        updateReadStatuses((prev) => {
          const n = { ...prev };
          delete (n as any)[messageId];
          return n as any;
        });
        setUploadStatus((prev) => {
          const n = { ...prev };
          delete (n as any)[messageId];
          return n;
        });
        void dequeueMediaOutboxId(messageId);
        return false;
      }

      if (socketResult.ok && socketResult.messageId) {
        commitMessages((prev) => {
          const updated = prev.map((msg) =>
            msg.id === messageId ? { ...msg, id: socketResult.messageId!, uri: resolveMediaUri(uploadResult.url), from: currentUserId, to: peerId } : msg
          );
          return updated;
        }, 'image_delivered');

        setUploadStatus((prev) => {
          const newStatus = { ...prev };
          newStatus[socketResult.messageId!] = 'sent';
          delete newStatus[messageId];
          return newStatus;
        });

        updateReadStatuses((prev) => {
          const newStatuses = { ...prev };
          const delivery = outgoingStatusFromSendResult(socketResult);
          newStatuses[socketResult.messageId!] = delivery;
          delete newStatuses[messageId];
          return newStatuses;
        });
        return true;
      } else {
        console.warn('❌ Socket send failed:', socketResult);
        updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
        setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
        void enqueueMediaOutboxId(messageId);
        return false;
      }
    } catch (e) {
      console.error('Failed to upload and send media:', e);
      updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
      setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
      void enqueueMediaOutboxId(messageId);
      return false;
    }
  }, [currentUserId, peerId, commitMessages, updateReadStatuses, resolveMediaUri, enqueueMediaOutboxId, dequeueMediaOutboxId]);

  /** Send 2…10 photos as one album message. */
  const sendPickedAlbum = React.useCallback(async (assets: any[]): Promise<boolean> => {
    if (!currentUserId || !peerId) return false;
    const list = (Array.isArray(assets) ? assets : []).slice(0, CHAT_ALBUM_MAX);
    if (list.length < 2) {
      if (list[0]) return sendPickedImage(list[0]);
      return false;
    }

    const messageId = createOptimisticChatMessageId();
    const localUris = list.map((a) => String(a?.uri || '').trim()).filter(Boolean);
    if (localUris.length < 2) return false;

    const newMessage = {
      id: messageId,
      type: 'image' as const,
      uri: localUris[0],
      uris: localUris,
      name: list[0]?.fileName || `album_${Date.now()}`,
      size: list.reduce((s, a) => s + (Number(a?.fileSize) || 0), 0),
      sender: 'me',
      from: currentUserId,
      to: peerId,
      timestamp: new Date(),
    };

    commitMessages((prev) => {
      if (prev.find((msg) => msg.id === messageId)) return prev;
      return [...prev, newMessage];
    }, 'album_optimistic');
    updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));
    setUploadStatus((prev) => ({ ...prev, [messageId]: 'sending' }));

    try {
      const remoteUris: string[] = [];
      for (let i = 0; i < list.length; i++) {
        const localUri = String(list[i]?.uri || '').trim();
        if (!localUri) continue;
        const uploadResult = await uploadMediaToServer(localUri, 'image', undefined, currentUserId, peerId);
        if (!uploadResult.success || !uploadResult.url) {
          updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
          setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
          void enqueueMediaOutboxId(messageId);
          return false;
        }
        remoteUris.push(uploadResult.url);
      }
      if (remoteUris.length < 2) {
        updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
        setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
        return false;
      }

      const resolvedUris = remoteUris.map((u) => resolveMediaUri(u) || u);
      const socketResult: any = await sendSocketMessage({
        to: peerId,
        type: 'image',
        uri: remoteUris[0],
        uris: remoteUris,
        name: list[0]?.fileName || undefined,
        size: list.reduce((s, a) => s + (Number(a?.fileSize) || 0), 0) || undefined,
        clientUiMessageId: messageId,
      });

      if (socketResult?.localCancelled) {
        updateReadStatuses((prev) => {
          const n = { ...prev };
          delete (n as any)[messageId];
          return n as any;
        });
        setUploadStatus((prev) => {
          const n = { ...prev };
          delete (n as any)[messageId];
          return n;
        });
        void dequeueMediaOutboxId(messageId);
        return false;
      }

      if (socketResult.ok && socketResult.messageId) {
        commitMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId
              ? {
                  ...msg,
                  id: socketResult.messageId!,
                  uri: resolvedUris[0],
                  uris: resolvedUris,
                  from: currentUserId,
                  to: peerId,
                }
              : msg,
          ),
          'album_delivered',
        );
        setUploadStatus((prev) => {
          const newStatus = { ...prev };
          newStatus[socketResult.messageId!] = 'sent';
          delete newStatus[messageId];
          return newStatus;
        });
        updateReadStatuses((prev) => {
          const newStatuses = { ...prev };
          newStatuses[socketResult.messageId!] = outgoingStatusFromSendResult(socketResult);
          delete newStatuses[messageId];
          return newStatuses;
        });
        return true;
      }

      updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
      setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
      void enqueueMediaOutboxId(messageId);
      return false;
    } catch (e) {
      console.error('Failed to upload and send album:', e);
      updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
      setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
      void enqueueMediaOutboxId(messageId);
      return false;
    }
  }, [currentUserId, peerId, sendPickedImage, commitMessages, updateReadStatuses, resolveMediaUri, enqueueMediaOutboxId, dequeueMediaOutboxId]);

  return {
    sendVoiceMessageFromLocal,
    sendVideoNoteFromLocal,
    sendPickedImage,
    sendPickedAlbum,
  };
}
