import type { ChatMessage, PickedChatImage } from './chatMessageTypes';
/** Incoming share-to-chat send + one-shot route effect. */

import React from "react";
import * as FileSystem from "expo-file-system";
import { sendMessage as sendSocketMessage } from "../../sockets/socket";
import { API_BASE } from "../../sockets/socket";
import { getInstallAuthHeaders } from "../../utils/installId";
import type { IncomingShareItem } from "../../utils/incomingShare";
import { t, type Lang } from "../../utils/i18n";
import { outgoingStatusFromSendResult } from "./chatMessageIds";

type ReadStatusMap = Record<string, "sending" | "delivered" | "read" | "failed" | "sent">;

type Options = {
  peerId: string;
  currentUserId: string | null;
  route: { params?: { incomingShareItems?: IncomingShareItem[] } };
  navigation: { setParams: (params: { incomingShareItems?: IncomingShareItem[] }) => void };
  lang: Lang;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  latestMessagesForPersistRef: React.MutableRefObject<ChatMessage[]>;
  enqueueMessagesPersist: (reason: string) => void;
  setUploadStatus: React.Dispatch<React.SetStateAction<Record<string, "sending" | "sent" | "failed">>>;
  updateReadStatuses: (updater: (prev: ReadStatusMap) => ReadStatusMap) => void;
  resolveMediaUri: (uri?: string) => string;
  sendPickedImage: (asset: PickedChatImage) => Promise<boolean>;
  showForwardToastBadge: (ok: boolean, text: string) => void;
  scheduleScrollToBottom: (delay?: number) => void;
  scrollToBottom: () => void;
};

export function useChatIncomingShare({
  peerId,
  currentUserId,
  route,
  navigation,
  lang,
  setMessages,
  latestMessagesForPersistRef,
  enqueueMessagesPersist,
  setUploadStatus,
  updateReadStatuses,
  resolveMediaUri,
  sendPickedImage,
  showForwardToastBadge,
  scheduleScrollToBottom,
  scrollToBottom,
}: Options) {
  const incomingShareHandledRef = React.useRef<string>("");

  const commitMessages = React.useCallback(
    (update: (prev: ChatMessage[]) => ChatMessage[], reason: string) => {
      latestMessagesForPersistRef.current = update(latestMessagesForPersistRef.current || []);
      setMessages((prev) => update(prev));
      enqueueMessagesPersist(reason);
    },
    [enqueueMessagesPersist, latestMessagesForPersistRef, setMessages],
  );

  const uploadRawShareFile = React.useCallback(async (localUri: string) => {
    const authHeaders = await getInstallAuthHeaders();
    const normalizedUri = localUri.startsWith('file://') ? localUri : `file://${localUri}`;
    try {
      const mpUrl = `${API_BASE}/api/upload/media/multipart`;
      const mpRes = await FileSystem.uploadAsync(mpUrl, normalizedUri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'file',
        headers: {
          ...authHeaders,
        },
      });
      if (mpRes.status >= 200 && mpRes.status < 300) {
        let json: { ok?: boolean; url?: string; secure_url?: string } | null = null;
        try {
          json = JSON.parse(mpRes.body || '{}');
        } catch {
          json = null;
        }
        if (json?.ok && (json.url || json.secure_url)) {
          return json.url || json.secure_url || '';
        }
      }
    } catch {
      // ignore
    }
    return '';
  }, []);

  const sendIncomingShareInChat = React.useCallback(
    async (items: IncomingShareItem[]): Promise<number> => {
      if (!currentUserId || !peerId || !items?.length) return 0;
      let sent = 0;
      for (const item of items) {
        if (item.kind === 'image' && item.uri) {
          const ok = await sendPickedImage({
            uri: item.uri,
            fileName: item.name || `file_${Date.now()}`,
            fileSize: item.size || 0,
          });
          if (ok) sent += 1;
          continue;
        }
        if (item.kind === 'text') {
          const text = String(item.text || '').trim();
          if (!text) continue;
          const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          commitMessages(
            (prev) =>
              prev.some((m) => String(m?.id) === messageId)
                ? prev
                : [
                    ...prev,
                    {
                      id: messageId,
                      text,
                      sender: 'me',
                      from: currentUserId,
                      to: peerId,
                      timestamp: new Date(),
                      type: 'text',
                    },
                  ],
            'share_text_optimistic',
          );
          updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));
          const result = await sendSocketMessage({
            to: peerId,
            text,
            type: 'text',
            clientUiMessageId: messageId,
          });
          if (result?.localCancelled) continue;
          if (result?.ok) {
            sent += 1;
            const deliveryStatus = outgoingStatusFromSendResult(result);
            if (result.messageId && result.messageId !== messageId) {
              commitMessages(
                (prev) =>
                  prev.map((msg) =>
                    msg.id === messageId
                      ? { ...msg, id: result.messageId, from: currentUserId, to: peerId }
                      : msg,
                  ),
                'share_text_server_id',
              );
              updateReadStatuses((prev) => {
                const next = { ...prev };
                next[result.messageId!] = deliveryStatus;
                delete next[messageId];
                return next;
              });
            } else {
              updateReadStatuses((prev) => ({ ...prev, [messageId]: deliveryStatus }));
            }
          } else {
            updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
          }
          continue;
        }
        const localUri = String(item.uri || '').trim();
        if (!localUri) continue;
        if (item.kind === 'audio') {
          const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          const fileName = item.name || `voice_${Date.now()}.m4a`;
          const fileSize = item.size || 0;
          commitMessages(
            (prev) =>
              prev.some((m) => String(m?.id) === messageId)
                ? prev
                : [
                    ...prev,
                    {
                      id: messageId,
                      type: 'audio',
                      uri: localUri,
                      name: fileName,
                      size: fileSize,
                      sender: 'me',
                      from: currentUserId,
                      to: peerId,
                      timestamp: new Date(),
                    },
                  ],
            'share_audio_optimistic',
          );
          updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));
          setUploadStatus((prev) => ({ ...prev, [messageId]: 'sending' }));
          // Без сети — очередь сама загрузит файл (как голосовое из рекордера).
          const socketResult = await sendSocketMessage({
            to: peerId,
            type: 'audio',
            localUri,
            name: fileName,
            size: fileSize,
            clientUiMessageId: messageId,
          });
          if (socketResult?.localCancelled) continue;
          if (socketResult?.ok) {
            sent += 1;
            setUploadStatus((prev) => {
              if (!(messageId in prev)) return prev;
              const next = { ...prev };
              delete next[messageId];
              return next;
            });
            updateReadStatuses((prev) => ({
              ...prev,
              [messageId]: outgoingStatusFromSendResult(socketResult),
            }));
          } else {
            updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
            setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
          }
          continue;
        }
        if (item.kind === 'document') {
          const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          const label = item.name ? `📎 ${item.name}` : '📎';
          commitMessages(
            (prev) =>
              prev.some((m) => String(m?.id) === messageId)
                ? prev
                : [
                    ...prev,
                    {
                      id: messageId,
                      text: label,
                      sender: 'me',
                      from: currentUserId,
                      to: peerId,
                      timestamp: new Date(),
                      type: 'text',
                    },
                  ],
            'share_doc_optimistic',
          );
          updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));
          const remoteUrl = await uploadRawShareFile(localUri);
          if (!remoteUrl) {
            updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
            continue;
          }
          const text = `${label}\n${remoteUrl}`;
          commitMessages(
            (prev) => prev.map((msg) => (msg.id === messageId ? { ...msg, text } : msg)),
            'share_doc_url',
          );
          const result = await sendSocketMessage({
            to: peerId,
            type: 'text',
            text,
            clientUiMessageId: messageId,
          });
          if (result?.ok) {
            sent += 1;
            const deliveryStatus = outgoingStatusFromSendResult(result);
            if (result.messageId && result.messageId !== messageId) {
              commitMessages(
                (prev) =>
                  prev.map((msg) =>
                    msg.id === messageId
                      ? { ...msg, id: result.messageId, text, from: currentUserId, to: peerId }
                      : msg,
                  ),
                'share_doc_server_id',
              );
              updateReadStatuses((prev) => {
                const next = { ...prev };
                next[result.messageId!] = deliveryStatus;
                delete next[messageId];
                return next;
              });
            } else {
              updateReadStatuses((prev) => ({ ...prev, [messageId]: deliveryStatus }));
            }
          } else {
            updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
          }
        }
      }
      return sent;
    },
    [currentUserId, peerId, sendPickedImage, updateReadStatuses, uploadRawShareFile, commitMessages, setUploadStatus],
  );

  React.useEffect(() => {
    const items = route?.params?.incomingShareItems;
    if (!items?.length || !currentUserId || !peerId) return;
    const key = `${peerId}:${items.length}:${items[0]?.uri || items[0]?.text || ''}`;
    if (incomingShareHandledRef.current === key) return;
    incomingShareHandledRef.current = key;
    let cancelled = false;
    (async () => {
      const sent = await sendIncomingShareInChat(items);
      if (cancelled) return;
      try {
        navigation.setParams({ incomingShareItems: undefined });
      } catch {
        // ignore
      }
      showForwardToastBadge(sent > 0, sent > 0 ? t('chatSent', lang) : t('chatSendFailed', lang));
      if (sent > 0) {
        scheduleScrollToBottom(0);
        setTimeout(() => scrollToBottom(), 80);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    route?.params?.incomingShareItems,
    currentUserId,
    peerId,
    navigation,
    sendIncomingShareInChat,
    showForwardToastBadge,
    lang,
    scheduleScrollToBottom,
    scrollToBottom,
  ]);

  return { sendIncomingShareInChat };
}
