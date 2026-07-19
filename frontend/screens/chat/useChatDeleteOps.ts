/** Single-message and batch delete for chat selection. */

import React from "react";
import {
  clearMessageCache,
  deleteMessage,
  deleteMessages,
  removeQueuedEditsMatching,
  removeQueuedMessagesMatching,
  updateMessageUris,
} from "../../sockets/socket";
import { t, type Lang } from "../../utils/i18n";
import type { NoticeKind } from "./useChatDialogs";
import { getMessageImageUris } from "./chatAlbum";
import {
  filterRemoveMessageAndOutgoingDupes,
  isDeletableOnServerMessageId,
  isHardDeleteBatchError,
  resolveServerMessageIdForDelete,
} from "./chatMessageOps";
import { planAlbumSelectionDeletes } from "./chatSelection";
import {
  mapMessagesAfterAlbumUrisUpdate,
  urisWithoutIndices,
} from "./chatAlbumActions";

type ReadStatusMap = Record<string, "sending" | "delivered" | "read" | "failed" | "sent">;

type Options = {
  peerId: string;
  currentUserId: string | null;
  lang: Lang;
  selectedMessageIds: Set<string>;
  messagesRef: React.MutableRefObject<any[]>;
  outboxLocalIdToServerIdRef: React.MutableRefObject<Map<string, string>>;
  latestMessagesForPersistRef: React.MutableRefObject<any[]>;
  batchDeleteSelectedRef: React.MutableRefObject<
    ((forBoth: boolean, idsOverride?: string[]) => Promise<void>) | null
  >;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  setUploadStatus: React.Dispatch<React.SetStateAction<Record<string, "sending" | "sent" | "failed">>>;
  setSelectedMessage: React.Dispatch<React.SetStateAction<any>>;
  setSelectionMode: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedMessageIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  updateReadStatuses: (updater: (prev: ReadStatusMap) => ReadStatusMap) => void;
  enqueueMessagesPersist: (reason: string) => void;
  dequeueMediaOutboxId: (id: string) => Promise<void>;
  rememberDeletedServerMessageId: (id: string) => void;
  rememberHiddenForMeMessageId: (id: string) => Promise<void>;
  rememberHiddenForMeMessageIds: (ids: string[]) => Promise<void>;
  hideMessageActions: () => void;
  exitSelectionMode: () => void;
  showForwardToastBadge: (ok: boolean, text: string) => void;
  showNotice: (kind: NoticeKind, title: string, message: string) => void;
};

export function useChatDeleteOps({
  peerId,
  currentUserId,
  lang,
  selectedMessageIds,
  messagesRef,
  outboxLocalIdToServerIdRef,
  latestMessagesForPersistRef,
  batchDeleteSelectedRef,
  setMessages,
  setUploadStatus,
  setSelectedMessage,
  setSelectionMode,
  setSelectedMessageIds,
  updateReadStatuses,
  enqueueMessagesPersist,
  dequeueMediaOutboxId,
  rememberDeletedServerMessageId,
  rememberHiddenForMeMessageId,
  rememberHiddenForMeMessageIds,
  hideMessageActions,
  exitSelectionMode,
  showForwardToastBadge,
  showNotice,
}: Options) {
  const deleteSingleMessage = async (messageId: string, forBoth: boolean = true) => {
    let mid = String(messageId || '').trim();
    if (!mid) return;
    void removeQueuedEditsMatching([mid]).catch(() => {});

    const snap = Array.isArray(messagesRef.current) ? messagesRef.current : [];
    if (!isDeletableOnServerMessageId(mid) && forBoth) {
      const resolved = resolveServerMessageIdForDelete(
        mid,
        snap,
        outboxLocalIdToServerIdRef.current,
      );
      if (isDeletableOnServerMessageId(resolved)) {
        mid = resolved;
      }
    }

    // Только outbox_* ещё не на сервере. Id вида timestamp-random — clientMessageId в Mongo.
    if (!isDeletableOnServerMessageId(mid)) {
      void removeQueuedMessagesMatching([mid]).catch(() => {});
      void dequeueMediaOutboxId(mid);
      setMessages((prev) => {
        const next = filterRemoveMessageAndOutgoingDupes(prev, mid);
        latestMessagesForPersistRef.current = next;
        clearMessageCache(peerId, currentUserId || undefined);
        queueMicrotask(() => enqueueMessagesPersist('delete_local_message'));
        const nextIds = new Set(next.map((m: any) => String(m?.id || '')));
        const dropped = prev
          .map((m: any) => String(m?.id || ''))
          .filter((id) => id && !nextIds.has(id));
        if (dropped.length) {
          queueMicrotask(() => {
            updateReadStatuses((rs) => {
              const n = { ...rs };
              for (const d of dropped) delete (n as any)[d];
              return n as any;
            });
            setUploadStatus((up) => {
              const n = { ...up };
              for (const d of dropped) delete (n as any)[d];
              return n;
            });
            void removeQueuedMessagesMatching(dropped).catch(() => {});
            dropped.forEach((d) => dequeueMediaOutboxId(d));
          });
        }
        return next;
      });
      showForwardToastBadge(false, t('chatDeleted', lang));
      return;
    }

    if (!forBoth) {
      await rememberHiddenForMeMessageId(mid);
      clearMessageCache(peerId, currentUserId || undefined);
      setMessages((prev) => {
        const next = filterRemoveMessageAndOutgoingDupes(prev, mid);
        latestMessagesForPersistRef.current = next;
        queueMicrotask(() => enqueueMessagesPersist('delete_message_for_me'));
        const nextIds = new Set(next.map((m: any) => String(m?.id || '')));
        const dropped = prev
          .map((m: any) => String(m?.id || ''))
          .filter((id) => id && !nextIds.has(id));
        if (dropped.length) {
          queueMicrotask(() => {
            updateReadStatuses((rs) => {
              const n = { ...rs };
              for (const d of dropped) delete (n as any)[d];
              return n as any;
            });
            setUploadStatus((up) => {
              const n = { ...up };
              for (const d of dropped) delete (n as any)[d];
              return n;
            });
            void removeQueuedMessagesMatching(dropped).catch(() => {});
            dropped.forEach((d) => dequeueMediaOutboxId(d));
          });
        }
        return next;
      });
      showForwardToastBadge(false, t('chatDeleted', lang));
      return;
    }

    const success = await deleteMessage(mid);
    if (success) {
      rememberDeletedServerMessageId(mid);
      clearMessageCache(peerId, currentUserId || undefined);
      setMessages((prev) => {
        const next = filterRemoveMessageAndOutgoingDupes(prev, mid);
        latestMessagesForPersistRef.current = next;
        queueMicrotask(() => enqueueMessagesPersist('delete_server_message'));
        const nextIds = new Set(next.map((m: any) => String(m?.id || '')));
        const dropped = prev
          .map((m: any) => String(m?.id || ''))
          .filter((id) => id && !nextIds.has(id));
        if (dropped.length) {
          queueMicrotask(() => {
            updateReadStatuses((rs) => {
              const n = { ...rs };
              for (const d of dropped) delete (n as any)[d];
              return n as any;
            });
            setUploadStatus((up) => {
              const n = { ...up };
              for (const d of dropped) delete (n as any)[d];
              return n;
            });
            void removeQueuedMessagesMatching(dropped).catch(() => {});
            dropped.forEach((d) => dequeueMediaOutboxId(d));
          });
        }
        return next;
      });
    } else {
      showNotice('error', t('errorTitle', lang), t('chatDeleteMessageFailed', lang));
    }
  };

  const batchDeleteSelected = React.useCallback(async (forBoth: boolean = true, idsOverride?: string[]) => {
    const rawKeys = Array.from(new Set(
      (idsOverride || Array.from(selectedMessageIds))
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    ));
    if (rawKeys.length === 0) return;

    const snapForPlan = Array.isArray(messagesRef.current) ? [...messagesRef.current] : [];
    // Expand selection: album tile keys → full delete or partial URI update
    const { fullDeleteIds, albumPartials } = planAlbumSelectionDeletes(
      rawKeys,
      snapForPlan,
      currentUserId,
    );

    // Partial album edits (own messages): remove only selected photos
    for (const edit of albumPartials) {
      const uris = getMessageImageUris(edit.message);
      const next = urisWithoutIndices(uris, edit.removeIndices);
      if (next.length === 0) {
        fullDeleteIds.add(edit.messageId);
        continue;
      }
      const r = await updateMessageUris(String(edit.messageId), next);
      if (r?.ok) {
        if (r.deleted) {
          fullDeleteIds.add(edit.messageId);
        } else {
          setMessages((prev) =>
            mapMessagesAfterAlbumUrisUpdate(prev, edit.messageId, next, r),
          );
        }
      }
    }

    const ids = Array.from(fullDeleteIds);
    if (ids.length === 0) {
      try { hideMessageActions(); } catch {}
      setSelectedMessage(null);
      exitSelectionMode();
      return;
    }

    const idSet = new Set(ids.map((x) => String(x)));
    const snapForResolve = Array.isArray(messagesRef.current) ? [...messagesRef.current] : [];
    const localToServer = outboxLocalIdToServerIdRef.current;

    let serverIds: string[] = [];
    let localOnlyIds: string[] = [];
    if (forBoth) {
      const resolvedServer = new Set<string>();
      localOnlyIds = [];
      for (const uiId of ids) {
        const resolved = resolveServerMessageIdForDelete(uiId, snapForResolve, localToServer);
        if (isDeletableOnServerMessageId(resolved)) {
          resolvedServer.add(resolved);
        } else {
          localOnlyIds.push(String(uiId));
        }
      }
      serverIds = Array.from(resolvedServer);
    } else {
      localOnlyIds = [...ids];
    }
    if (!forBoth) {
      await rememberHiddenForMeMessageIds(ids);
    }

    // Optimistic UI: remove all selected messages at once (no sequential "one-by-one" deletion).
    // Keep a snapshot of removed messages so we can restore only the ones that actually failed.
    const removedById = new Map<string, any>();
    const prevSnap = Array.isArray(messagesRef.current) ? [...messagesRef.current] : [];
    try {
      for (const mm of prevSnap) {
        const mid = String(mm?.id || '').trim();
        if (mid && idSet.has(mid)) removedById.set(mid, mm);
      }
    } catch {}
    let nextMessages = prevSnap;
    for (const id of ids) {
      const delId = String(id || '').trim();
      if (!delId) continue;
      nextMessages = filterRemoveMessageAndOutgoingDupes(nextMessages, delId);
    }
    const nextIds = new Set(nextMessages.map((m: any) => String(m?.id || '').trim()).filter(Boolean));
    const droppedAll = prevSnap
      .map((m: any) => String(m?.id || '').trim())
      .filter((mid) => mid && !nextIds.has(mid));
    latestMessagesForPersistRef.current = nextMessages;
    clearMessageCache(peerId, currentUserId || undefined);
    setMessages(nextMessages);
    queueMicrotask(() => {
      enqueueMessagesPersist('delete_selected_messages');
      void removeQueuedMessagesMatching(droppedAll).catch(() => {});
      droppedAll.forEach((d) => dequeueMediaOutboxId(d));
    });
    // UI уже очистили оптимистично, поэтому режим выбора закрываем сразу.
    try { hideMessageActions(); } catch {}
    setSelectedMessage(null);
    exitSelectionMode();

    const batchResult = forBoth && serverIds.length > 0
      ? await deleteMessages(serverIds)
      : { deletedIds: [], failedIds: [], error: undefined as string | undefined };
    const deletedOnServer = new Set(
      (Array.isArray(batchResult?.deletedIds) ? batchResult.deletedIds : []).map(String),
    );
    const notFoundOrGone = forBoth
      ? (Array.isArray(batchResult?.failedIds) ? batchResult.failedIds.map(String) : [])
      : [];
    const hardFailure = forBoth && serverIds.length > 0 && isHardDeleteBatchError(batchResult?.error);

    // На сервере уже нет (not_found) — снимаем локально, не восстанавливаем «призраков».
    const failedServer = hardFailure
      ? serverIds.filter((id) => !deletedOnServer.has(String(id)))
      : [];

    // local-only deletions are always considered successful (client-side only)
    const successServerIds = serverIds.filter((id) => deletedOnServer.has(String(id)));
    const goneServerIds = hardFailure ? [] : notFoundOrGone;
    for (const sid of [...successServerIds, ...goneServerIds]) {
      rememberDeletedServerMessageId(String(sid));
    }

    // cleanup status maps for successful deletions (both server + local-only)
    const deletedOk = new Set<string>([...localOnlyIds, ...successServerIds, ...goneServerIds].map(String));
    if (deletedOk.size > 0) {
      updateReadStatuses((prev) => {
        const next: any = { ...prev };
        for (const id of deletedOk) delete next[id];
        return next;
      });
      setUploadStatus((prev) => {
        const next: any = { ...prev };
        for (const id of deletedOk) delete next[id];
        return next;
      });
    }

    if (failedServer.length === 0) {
      showForwardToastBadge(false, t('chatDeleted', lang));
      return;
    }

    // Restore ONLY failed server items (keep successful deletions applied).
    // Also preserve any new messages that might have arrived while we were deleting.
    const failedSet = new Set(failedServer.map(String));
    setMessages((prev) => {
      const toRestore: any[] = [];
      for (const id of failedSet) {
        const mm = removedById.get(String(id));
        if (mm) toRestore.push(mm);
      }
      const merged = [...prev, ...toRestore];
      merged.sort((a: any, b: any) => {
        const ta = +new Date(a?.timestamp || 0);
        const tb = +new Date(b?.timestamp || 0);
        return ta - tb;
      });
      return merged;
    });

    // Оставляем выделенными только те, что не удалились (можно повторить)
    setSelectionMode(true);
    setSelectedMessageIds(new Set(failedServer));
    showNotice(
      'error',
      t('errorTitle', lang),
      t('chatDeleteFailedCount', lang).replace('{count}', String(failedServer.length))
    );
  }, [
    selectedMessageIds,
    exitSelectionMode,
    currentUserId,
    showForwardToastBadge,
    showNotice,
    lang,
    deleteMessages,
    updateReadStatuses,
    setUploadStatus,
    hideMessageActions,
    rememberDeletedServerMessageId,
    rememberHiddenForMeMessageIds,
  ]);

  batchDeleteSelectedRef.current = batchDeleteSelected;

  return { deleteSingleMessage, batchDeleteSelected };
}
