/** Text/sticker composer send + emoji panel helpers. */

import React from "react";
import { Keyboard, Vibration } from "react-native";
import * as Haptics from "expo-haptics";
import type { EmojiType } from "rn-emoji-keyboard";
import {
  clearMessageCache,
  editMessage,
  sendMessage as sendSocketMessage,
} from "../../sockets/socket";
import {
  getStickerFallbackText,
  type BuiltInSticker,
} from "../../components/chatStickers";
import { type Lang } from "../../utils/i18n";

type ReadStatusMap = Record<string, "sending" | "delivered" | "read" | "failed" | "sent">;

type ReplyTo = { id: string; text: string; from?: string; isOwn?: boolean } | null;

type Options = {
  peerId: string;
  currentUserId: string | null;
  lang: Lang;
  voiceIsRecording: boolean;
  editingMessageId: string | null;
  setEditingMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  replyingToMessage: ReplyTo;
  setReplyingToMessage: React.Dispatch<React.SetStateAction<ReplyTo>>;
  messageTextRef: React.MutableRefObject<string>;
  setMessageText: React.Dispatch<React.SetStateAction<string>>;
  setEmojiPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  setUploadStatus: React.Dispatch<React.SetStateAction<Record<string, "sending" | "sent" | "failed">>>;
  updateReadStatuses: (updater: (prev: ReadStatusMap) => ReadStatusMap) => void;
  stopVoiceRecording: (cancelled?: boolean, skipSend?: boolean) => void | Promise<void>;
  stopLocalTyping: () => void;
  signalLocalTyping: () => void;
  rememberOutboxLocalToServerId: (localId: string, serverId: string) => void;
};

export function useChatComposer({
  peerId,
  currentUserId,
  lang,
  voiceIsRecording,
  editingMessageId,
  setEditingMessageId,
  replyingToMessage,
  setReplyingToMessage,
  messageTextRef,
  setMessageText,
  setEmojiPanelOpen,
  setMessages,
  setUploadStatus,
  updateReadStatuses,
  stopVoiceRecording,
  stopLocalTyping,
  signalLocalTyping,
  rememberOutboxLocalToServerId,
}: Options) {
  const sendMessage = async () => {
    if (!currentUserId) return;
    setEmojiPanelOpen(false);

    // Во время записи голоса «Отправить» сразу завершает запись и уходит в чат (как отпускание микрофона)
    if (voiceIsRecording) {
      await stopVoiceRecording(false, false);
      return;
    }

    const composerText = messageTextRef.current;
    if (!composerText.trim()) return;

    // Редактирование существующего сообщения
    if (editingMessageId) {
      const newText = composerText.trim();
      messageTextRef.current = '';
      setMessageText('');
      setEditingMessageId(null);
      const result = await editMessage(editingMessageId, newText);
      if (result.ok || result.queued) {
        setMessages((prev) => {
          const updated = prev.map((m) =>
            m.id === editingMessageId ? { ...m, text: newText } : m
          );
          return updated;
        });
      } else {
        messageTextRef.current = newText;
        setMessageText(newText);
        setEditingMessageId(editingMessageId);
      }
      return;
    }

    const messageToSend = composerText.trim();
    const replyTo = replyingToMessage ? { id: replyingToMessage.id, text: replyingToMessage.text, from: replyingToMessage.from, isOwn: replyingToMessage.isOwn } : undefined;
    messageTextRef.current = '';
    setMessageText(""); // Очищаем поле сразу
    setReplyingToMessage(null);
    // Если отправили сообщение — прекращаем "typing"
    stopLocalTyping();
    
    // Добавляем сообщение локально
    const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const newMessage = {
      id: messageId,
      text: messageToSend,
      sender: 'me',
      from: currentUserId,
      to: peerId,
      timestamp: new Date(),
      type: 'text',
      ...(replyTo ? { replyTo } : {}),
    };
    
    setMessages((prev) => {
      const updatedMessages = [...prev, newMessage];
      return updatedMessages;
    });
    
    // Статус "отправляется" (пока нет птичек)
    updateReadStatuses(prev => ({ ...prev, [messageId]: 'sending' }));
    
    // Сеть в фоне — UI не ждёт ack (избегаем «зависания» и лишних повторных нажатий)
    void (async () => {
      try {
        const result = await sendSocketMessage({
          to: peerId,
          text: messageToSend,
          type: 'text',
          clientUiMessageId: messageId,
          ...(replyTo
            ? {
                replyTo: {
                  id: replyTo.id,
                  text: replyTo.text,
                  from: replyTo.from ?? '',
                  isOwn: replyTo.isOwn,
                },
              }
            : {}),
        });

        if ((result as any)?.localCancelled) {
          return;
        }
        
        if (result.ok) {
          clearMessageCache(peerId, currentUserId);

          const deliveryStatus = result.delivered ? 'delivered' : 'sent';

          updateReadStatuses(prev => ({
            ...prev,
            [messageId]: deliveryStatus
          }));

          if (result.messageId) {
            if (result.messageId !== messageId) {
              setMessages(prev => {
                const updated = prev.map(msg => 
                  msg.id === messageId 
                    ? { ...msg, id: result.messageId!, from: currentUserId, to: peerId }
                    : msg
                );
                return updated;
              });
              
              updateReadStatuses(prev => {
                const newStatuses = { ...prev };
                newStatuses[result.messageId!] = deliveryStatus;
                delete newStatuses[messageId];
                return newStatuses;
              });
            } else {
              updateReadStatuses(prev => ({
                ...prev,
                [messageId]: deliveryStatus
              }));
            }
          } else {
            updateReadStatuses(prev => ({
              ...prev,
              [messageId]: deliveryStatus
            }));
          }
        } else {
          throw new Error((result as any).error || 'Failed to send message');
        }
        
      } catch (e) {
        console.error('❌ Failed to send via socket:', e);
        updateReadStatuses(prev => ({
          ...prev,
          [messageId]: 'failed'
        }));
        setUploadStatus(prev => ({ ...prev, [messageId]: 'failed' }));
      }
    })();
  };

  const onPressSendButton = React.useCallback(() => {
    if (!messageTextRef.current.trim() && !voiceIsRecording) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      Vibration.vibrate(10);
    }
    setEmojiPanelOpen(false);
    void sendMessage();
  }, [voiceIsRecording, sendMessage]);

  const toggleEmojiPanel = React.useCallback(() => {
    setEmojiPanelOpen((open) => {
      const next = !open;
      if (next) {
        try {
          Keyboard.dismiss();
        } catch {}
      }
      return next;
    });
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      Vibration.vibrate(10);
    }
  }, []);

  /** Тап по пустой области списка / скролл — закрыть клавиатуру и панель эмодзи. */
  const dismissComposerKeyboard = React.useCallback(() => {
    try {
      Keyboard.dismiss();
    } catch {}
    setEmojiPanelOpen(false);
  }, []);

  const handleComposerEmojiSelected = React.useCallback(
    (emoji: EmojiType) => {
      const ch = String(emoji?.emoji || '');
      if (!ch) return;
      setMessageText((prev) => {
        const next = prev + ch;
        messageTextRef.current = next;
        return next;
      });
      signalLocalTyping();
    },
    [signalLocalTyping],
  );

  const handleComposerStickerSelected = React.useCallback(
    (sticker: BuiltInSticker) => {
      if (!sticker?.id) return;
      const replyTo = replyingToMessage
        ? { id: replyingToMessage.id, text: replyingToMessage.text, from: replyingToMessage.from, isOwn: replyingToMessage.isOwn }
        : undefined;
      const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const fallbackText = getStickerFallbackText(sticker, lang);
      setReplyingToMessage(null);
      stopLocalTyping();

      const newMessage = {
        id: messageId,
        text: fallbackText,
        sender: 'me',
        from: currentUserId,
        to: peerId,
        timestamp: new Date(),
        type: 'sticker',
        stickerId: sticker.id,
        stickerPackId: sticker.packId,
        stickerEmoji: sticker.emoji,
        stickerLabel: sticker.label,
        ...(replyTo ? { replyTo } : {}),
      };

      setMessages((prev) => [...prev, newMessage]);
      updateReadStatuses((prev) => ({ ...prev, [messageId]: 'sending' }));

      void (async () => {
        try {
          const result = await sendSocketMessage({
            to: peerId,
            text: fallbackText,
            type: 'sticker',
            stickerId: sticker.id,
            stickerPackId: sticker.packId,
            stickerEmoji: sticker.emoji,
            stickerLabel: sticker.label,
            clientUiMessageId: messageId,
            ...(replyTo
              ? {
                  replyTo: {
                    id: replyTo.id,
                    text: replyTo.text,
                    from: replyTo.from ?? '',
                    isOwn: replyTo.isOwn,
                  },
                }
              : {}),
          });

          if ((result as any)?.localCancelled) return;
          if (!result.ok) throw new Error((result as any).error || 'Failed to send sticker');

          if (currentUserId) clearMessageCache(peerId, currentUserId);
          const deliveryStatus: 'delivered' | 'sent' = result.delivered ? 'delivered' : 'sent';
          updateReadStatuses((prev) => ({ ...prev, [messageId]: deliveryStatus }));

          const serverMessageId = String(result.messageId || '');
          if (serverMessageId && serverMessageId !== messageId) {
            rememberOutboxLocalToServerId(messageId, serverMessageId);
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === messageId
                  ? { ...msg, id: serverMessageId, from: currentUserId, to: peerId }
                  : msg,
              ),
            );
            updateReadStatuses((prev) => {
              const next: Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'> = { ...prev, [serverMessageId]: deliveryStatus };
              delete next[messageId];
              return next;
            });
          }
        } catch (e) {
          console.error('❌ Failed to send sticker via socket:', e);
          updateReadStatuses((prev) => ({ ...prev, [messageId]: 'failed' }));
          setUploadStatus((prev) => ({ ...prev, [messageId]: 'failed' }));
        }
      })();
    },
    [currentUserId, peerId, replyingToMessage, lang, stopLocalTyping, updateReadStatuses],
  );

  return {
    sendMessage,
    onPressSendButton,
    toggleEmojiPanel,
    dismissComposerKeyboard,
    handleComposerEmojiSelected,
    handleComposerStickerSelected,
  };
}
