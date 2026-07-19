/** Forward/share send orchestration for chat. */

import React from "react";
import { Platform, Share } from "react-native";
import { sendMessage as sendSocketMessage } from "../../sockets/socket";
import { t, type Lang } from "../../utils/i18n";
import type { NoticeKind } from "./useChatDialogs";
import {
  buildOptimisticForwardRow,
  buildSystemShareContent,
  collectForwardPayloadsFromSelectedMessage,
  collectForwardPayloadsFromSelection,
  selectedMessageIsForwardable,
  selectionHasForwardableContent,
  type ForwardPayload,
} from "./chatForward";

type ReadStatusMap = Record<string, "sending" | "delivered" | "read" | "failed" | "sent">;

type Options = {
  peerId: string;
  currentUserId: string | null;
  lang: Lang;
  messages: any[];
  selectionMode: boolean;
  selectedCount: number;
  selectedHasAnyForwardable: boolean;
  selectedMessageIds: Set<string>;
  selectedMessage: any;
  forwardFriends: any[];
  forwardSelectedFriendIds: Set<string>;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  setSelectionMode: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedMessageIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setShowForwardPicker: React.Dispatch<React.SetStateAction<boolean>>;
  setForwardSelectedFriendIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  updateReadStatuses: (updater: (prev: ReadStatusMap) => ReadStatusMap) => void;
  resolveMediaUri: (uri?: string) => string;
  scrollToBottom: () => void;
  scheduleScrollToBottom: (delay?: number) => void;
  hideMessageActions: () => void;
  showForwardToastBadge: (ok: boolean, text: string) => void;
  showNotice: (kind: NoticeKind, title: string, message: string) => void;
  openForwardPicker: () => void | Promise<void>;
};

export function useChatForwardSend({
  peerId,
  currentUserId,
  lang,
  messages,
  selectionMode,
  selectedCount,
  selectedHasAnyForwardable,
  selectedMessageIds,
  selectedMessage,
  forwardFriends,
  forwardSelectedFriendIds,
  setMessages,
  setSelectionMode,
  setSelectedMessageIds,
  setShowForwardPicker,
  setForwardSelectedFriendIds,
  updateReadStatuses,
  resolveMediaUri,
  scrollToBottom,
  scheduleScrollToBottom,
  hideMessageActions,
  showForwardToastBadge,
  showNotice,
  openForwardPicker,
}: Options) {
  // Отправка выбранных сообщений одному получателю. Возвращает число успешно отправленных.
  const forwardToRecipient = React.useCallback(
    async (to: string): Promise<number> => {
      /** Сразу показать в текущем чате, если переслали собеседнику этого экрана (иначе ждём socket echo с задержкой). */
      const appendIfForwardedToThisPeer = (r: any, partial: ForwardPayload) => {
        const uid = String(currentUserId || '').trim();
        const pid = String(peerId || '').trim();
        const tTo = String(to || '').trim();
        if (!uid || !pid || tTo !== pid) return;
        if (!r?.ok || r?.localCancelled) return;
        const mid = String(r?.messageId || '').trim();
        if (!mid || mid.startsWith('outbox_')) return;
        const tsRaw = (r as any)?.timestamp;
        const ts = tsRaw ? new Date(tsRaw) : new Date();
        setMessages((prev) => {
          if (prev.some((m) => String(m?.id) === mid)) return prev;
          const row = buildOptimisticForwardRow(partial, {
            messageId: mid,
            currentUserId: uid,
            peerId: pid,
            timestamp: ts,
            lang,
            resolveMediaUri,
          });
          return [...prev, row];
        });
        updateReadStatuses((prev) => ({
          ...prev,
          [mid]: (r as any)?.delivered ? 'delivered' : 'sent',
        }));
        if (Platform.OS === 'android') {
          requestAnimationFrame(() => {
            scrollToBottom();
            setTimeout(() => scrollToBottom(), 90);
            setTimeout(() => scrollToBottom(), 220);
          });
        } else {
          scheduleScrollToBottom(0);
          setTimeout(() => scrollToBottom(), 60);
        }
      };

      const forwardables = selectionMode
        ? collectForwardPayloadsFromSelection(messages, selectedMessageIds, resolveMediaUri, lang)
        : collectForwardPayloadsFromSelectedMessage(selectedMessage, resolveMediaUri, lang);
      if (forwardables.length === 0) return 0;
      let okCount = 0;
      for (const payload of forwardables) {
        const r: any = await sendSocketMessage({ to, ...payload });
        if (r?.localCancelled) continue;
        if (r?.ok) {
          okCount += 1;
          appendIfForwardedToThisPeer(r, payload);
        }
      }
      return okCount;
    },
    [
      selectionMode,
      messages,
      selectedMessageIds,
      selectedMessage,
      resolveMediaUri,
      peerId,
      currentUserId,
      updateReadStatuses,
      scrollToBottom,
      scheduleScrollToBottom,
      lang,
    ]
  );

  const forwardToSelectedFriends = React.useCallback(async () => {
    const ids = Array.from(forwardSelectedFriendIds);
    if (ids.length === 0) return;
    const friends = forwardFriends.filter((f) => ids.includes(String(f?._id || '')));
    if (friends.length === 0) return;

    // Проверка «есть что пересылать» один раз (для режима выбора и одного сообщения)
    if (selectionMode) {
      if (!selectionHasForwardableContent(messages, selectedMessageIds, resolveMediaUri)) {
        showNotice('info', t('chatForwardTitle', lang), t('chatForwardNoSuitable', lang));
        return;
      }
    } else if (selectedMessage) {
      if (!selectedMessageIsForwardable(selectedMessage, resolveMediaUri)) return;
    }

    let totalOk = 0;
    try {
      for (const f of friends) {
        const to = String(f?._id || '').trim();
        if (!to) continue;
        totalOk += await forwardToRecipient(to);
      }
    } finally {
      setShowForwardPicker(false);
      hideMessageActions();
      setForwardSelectedFriendIds(new Set());
      if (selectionMode) {
        setSelectionMode(false);
        setSelectedMessageIds(new Set());
      }
      showForwardToastBadge(totalOk > 0, totalOk > 0 ? t('chatSent', lang) : t('chatSendFailed', lang));
    }
  }, [
    forwardSelectedFriendIds,
    forwardFriends,
    selectionMode,
    messages,
    selectedMessageIds,
    selectedMessage,
    forwardToRecipient,
    hideMessageActions,
    showForwardToastBadge,
    resolveMediaUri,
    setShowForwardPicker,
    setForwardSelectedFriendIds,
    setSelectionMode,
    setSelectedMessageIds,
    showNotice,
    lang,
  ]);

  // Переслать в системные приложения (WhatsApp, Telegram, Instagram и др.)
  const shareForwardToSystem = React.useCallback(async () => {
    const { shareText, shareUrl } = buildSystemShareContent({
      selectionMode,
      messages,
      selectedMessageIds,
      selectedMessage,
      resolveMediaUri,
      lang,
    });
    if (!shareText && !shareUrl) return;
    try {
      await Share.share({
        message: shareText || (shareUrl || ''),
        url: shareUrl && /^https?:\/\//i.test(shareUrl) ? shareUrl : undefined,
        title: t('chatActionForward', lang),
      });
    } catch (_) {}
  }, [selectionMode, messages, selectedMessageIds, selectedMessage, resolveMediaUri, lang]);

  const forwardSelectedMessageTo = React.useCallback(
    async (friend: any) => {
      const to = String(friend?._id || '').trim();
      if (!to) return;
      const count = await forwardToRecipient(to);
      setShowForwardPicker(false);
      hideMessageActions();
      if (selectionMode) {
        setSelectionMode(false);
        setSelectedMessageIds(new Set());
      }
      showForwardToastBadge(count > 0, count > 0 ? t('chatSent', lang) : t('chatSendFailed', lang));
    },
    [
      forwardToRecipient,
      hideMessageActions,
      showForwardToastBadge,
      selectionMode,
      setShowForwardPicker,
      setSelectionMode,
      setSelectedMessageIds,
      lang,
    ]
  );

  const startForwardSelected = React.useCallback(() => {
    if (selectedCount === 0) return;
    if (!selectedHasAnyForwardable) {
      showNotice('info', t('chatForwardTitle', lang), t('chatForwardOnlySupported', lang));
      return;
    }
    void openForwardPicker();
  }, [selectedCount, selectedHasAnyForwardable, showNotice, openForwardPicker, lang]);

  return {
    forwardToRecipient,
    forwardToSelectedFriends,
    shareForwardToSystem,
    forwardSelectedMessageTo,
    startForwardSelected,
  };
}
