/** Send voice / single image / album from local assets. */

import React from "react";
import { sendMessage as sendSocketMessage } from "../../sockets/socket";
import { uploadMediaToServer } from "../../utils/mediaUpload";
import { CHAT_ALBUM_MAX } from "./chatAlbum";
import { outgoingStatusFromSendResult } from "./chatMessageIds";
import { keepVoiceRecording } from "./chatVoiceRecord";

type ReadStatusMap = Record<string, "sending" | "delivered" | "read" | "failed" | "sent">;

type Options = {
  peerId: string;
  currentUserId: string | null;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
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
  setUploadStatus,
  updateReadStatuses,
  resolveMediaUri,
  enqueueMediaOutboxId,
  dequeueMediaOutboxId,
  setVoiceRecordMs,
}: Options) {
  /**
   * Голосовое идёт через общую очередь сообщений: она на диске, сама загрузит файл и
   * отправит, когда будет сеть (даже если чат уже закрыт), и повторит после обрыва.
   * Без сети пузырь стоит с часами, а не мигает «ошибкой».
   */
  const sendVoiceMessageFromLocal = React.useCallback(async (localUri: string, durationMs: number, size?: number) => {
    if (!currentUserId || !peerId) return;

    const messageId = Date.now().toString();
    const durationSec = Math.max(1, Math.round(durationMs / 1000));
    const name = `voice_${messageId}.m4a`;
    // Кэш система может почистить раньше, чем вернётся сеть, — переносим запись к себе.
    const fileUri = await keepVoiceRecording(localUri, messageId);

    setMessages((prev) => [
      ...prev,
      {
        id: messageId,
        type: 'audio',
        uri: fileUri,
        name,
        size: size || 0,
        duration: durationSec,
        sender: 'me',
        from: currentUserId,
        to: peerId,
        timestamp: new Date(),
      },
    ]);
    updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));
    setUploadStatus((prev) => ({ ...prev, [messageId]: 'sending' }));
    setVoiceRecordMs(0);

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
  }, [currentUserId, peerId, setMessages, setUploadStatus, updateReadStatuses, setVoiceRecordMs]);

  const sendPickedImage = React.useCallback(async (asset: any): Promise<boolean> => {
    if (!currentUserId || !peerId) return false;

    const messageId = Date.now().toString();
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

    setMessages((prev) => {
      const existingMessage = prev.find((msg) => msg.id === messageId);
      if (existingMessage) return prev;
      return [...prev, newMessage];
    });

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
        setMessages((prev) => {
          const updated = prev.map((msg) =>
            msg.id === messageId ? { ...msg, id: socketResult.messageId!, uri: resolveMediaUri(uploadResult.url), from: currentUserId, to: peerId } : msg
          );
          return updated;
        });

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
  }, [currentUserId, peerId, updateReadStatuses, resolveMediaUri, enqueueMediaOutboxId, dequeueMediaOutboxId]);

  /** Send 2…10 photos as one album message. */
  const sendPickedAlbum = React.useCallback(async (assets: any[]): Promise<boolean> => {
    if (!currentUserId || !peerId) return false;
    const list = (Array.isArray(assets) ? assets : []).slice(0, CHAT_ALBUM_MAX);
    if (list.length < 2) {
      if (list[0]) return sendPickedImage(list[0]);
      return false;
    }

    const messageId = Date.now().toString();
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

    setMessages((prev) => {
      if (prev.find((msg) => msg.id === messageId)) return prev;
      return [...prev, newMessage];
    });
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
        setMessages((prev) =>
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
  }, [currentUserId, peerId, sendPickedImage, updateReadStatuses, resolveMediaUri, enqueueMediaOutboxId, dequeueMediaOutboxId]);

  return {
    sendVoiceMessageFromLocal,
    sendPickedImage,
    sendPickedAlbum,
  };
}
