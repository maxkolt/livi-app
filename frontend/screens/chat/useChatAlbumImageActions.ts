/** Save / forward / delete actions for image & album messages. */

import React from "react";
import * as FileSystem from "expo-file-system";
import { updateMessageUris } from "../../sockets/socket";
import { saveImageToGallery } from "../../utils/saveToGallery";
import { t, type Lang } from "../../utils/i18n";
import type { NoticeKind } from "./useChatDialogs";
import { getMessageImageUris } from "./chatAlbum";
import {
  albumPickRequiresFullDelete,
  albumScopeInitialFocus,
  buildAlbumForwardSelectedMessage,
  filterValidAlbumPickIndices,
  mapMessagesAfterAlbumUrisUpdate,
  resolveOneAlbumUri,
  urisWithoutIndices,
  type AlbumScopeKind,
} from "./chatAlbumActions";

type Options = {
  currentUserId: string | null;
  lang: Lang;
  resolveMediaUri: (uri?: string) => string;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  setSelectedMessage: React.Dispatch<React.SetStateAction<any>>;
  setAlbumFocusIndex: React.Dispatch<React.SetStateAction<number | null>>;
  openForwardPicker: () => void | Promise<void>;
  openAlbumScope: (kind: AlbumScopeKind, m: any, focus: number | null) => void;
  consumeAlbumScope: () => { message: any; kind: AlbumScopeKind };
  confirmDeleteSelectedMessage: (m: any) => void;
  showForwardToastBadge: (ok: boolean, text: string) => void;
  showNotice: (kind: NoticeKind, title: string, message: string) => void;
};

export function useChatAlbumImageActions({
  currentUserId,
  lang,
  resolveMediaUri,
  setMessages,
  setSelectedMessage,
  setAlbumFocusIndex,
  openForwardPicker,
  openAlbumScope,
  consumeAlbumScope,
  confirmDeleteSelectedMessage,
  showForwardToastBadge,
  showNotice,
}: Options) {
  // Stable handler to avoid re-rendering all MessageItem rows on parent re-renders
  const downloadUriToCache = React.useCallback(async (uri: string): Promise<string> => {
    const resolved = resolveMediaUri(uri) || uri;
    if (!resolved) return '';
    if (/^file:\/\//i.test(resolved) || /^content:\/\//i.test(resolved)) return resolved;
    try {
      const ext = resolved.toLowerCase().includes('.png') ? 'png' : 'jpg';
      const target = `${FileSystem.cacheDirectory}livi_save_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const res = await FileSystem.downloadAsync(resolved, target);
      return res?.uri || '';
    } catch {
      return '';
    }
  }, [resolveMediaUri]);

  const saveAlbumUris = React.useCallback(async (uris: string[]) => {
    let ok = 0;
    let permDenied = false;
    for (const u of uris) {
      const local = await downloadUriToCache(u);
      if (!local) continue;
      try {
        await saveImageToGallery(local);
        ok += 1;
      } catch (e) {
        if (/permission|Photos|gallery/i.test(String((e as any)?.message || e))) {
          permDenied = true;
        }
      }
    }
    if (ok > 0) {
      showForwardToastBadge(true, t('chatAlbumSaved', lang));
      if (ok < uris.length) showNotice('error', t('errorTitle', lang), t('chatAlbumSavePartialFail', lang));
    } else {
      showNotice(
        'error',
        t('errorTitle', lang),
        permDenied ? t('chatAlbumSaveNoPermission', lang) : t('saveFailed', lang),
      );
    }
  }, [downloadUriToCache, showForwardToastBadge, showNotice, lang]);

  const runSelectedImageAction = React.useCallback(
    async (action: string, m: any, focusIndex: number | null) => {
      if (!m) return;
      const { uris, isAlbum, idx, oneUri } = resolveOneAlbumUri(m, focusIndex);
      const isOwn = m?.from === currentUserId || m?.sender === 'me';

      if (action === 'save' || action === 'save_one') {
        if (oneUri) await saveAlbumUris([oneUri]);
        return;
      }
      if (action === 'save_all') {
        await saveAlbumUris(uris);
        return;
      }
      if (action === 'forward' || action === 'forward_all') {
        setSelectedMessage(m);
        await openForwardPicker();
        return;
      }
      if (action === 'forward_one') {
        if (!oneUri) return;
        setSelectedMessage(buildAlbumForwardSelectedMessage(m, [oneUri]));
        await openForwardPicker();
        return;
      }
      if (action === 'delete_one' && isOwn && isAlbum && idx != null) {
        const next = urisWithoutIndices(uris, [idx]);
        if (next.length === 0) {
          confirmDeleteSelectedMessage(m);
          return;
        }
        const r = await updateMessageUris(String(m.id), next);
        if (r?.ok) {
          setMessages((prev) => mapMessagesAfterAlbumUrisUpdate(prev, String(m.id), next, r));
          showForwardToastBadge(true, t('chatDeleted', lang));
        } else {
          showNotice('error', t('errorTitle', lang), t('saveFailed', lang));
        }
        return;
      }
      if (action === 'delete' || action === 'delete_all') {
        confirmDeleteSelectedMessage(m);
      }
    },
    [
      currentUserId,
      saveAlbumUris,
      openForwardPicker,
      confirmDeleteSelectedMessage,
      showForwardToastBadge,
      showNotice,
      lang,
    ],
  );

  /** Single menu entry → run now, or open multi-select for albums. */
  const requestImageAction = React.useCallback(
    (kind: 'save' | 'forward' | 'delete', m: any, focusIndex: number | null) => {
      if (!m) return;
      const uris = getMessageImageUris(m);
      const isAlbum = uris.length > 1;
      const focusForOne = albumScopeInitialFocus(uris, focusIndex);
      const isOwn = m?.from === currentUserId || m?.sender === 'me';

      if (kind === 'delete') {
        if (isAlbum && isOwn) {
          openAlbumScope('delete', m, focusForOne);
          return;
        }
        void runSelectedImageAction('delete', m, focusIndex);
        return;
      }
      if (isAlbum) {
        openAlbumScope(kind, m, focusForOne);
        return;
      }
      if (kind === 'save') {
        void runSelectedImageAction('save', m, focusIndex);
        return;
      }
      void runSelectedImageAction('forward', m, focusIndex);
    },
    [currentUserId, openAlbumScope, runSelectedImageAction],
  );

  const applyAlbumPick = React.useCallback(
    async (indices: number[]) => {
      const { message: m, kind } = consumeAlbumScope();
      setAlbumFocusIndex(null);
      const uris = getMessageImageUris(m);
      const { pickedIdx, picked } = filterValidAlbumPickIndices(uris, indices);
      if (!m || !picked.length) return;

      if (kind === 'save') {
        await saveAlbumUris(picked);
        return;
      }
      if (kind === 'forward') {
        setSelectedMessage(buildAlbumForwardSelectedMessage(m, picked));
        await openForwardPicker();
        return;
      }

      // delete
      const next = urisWithoutIndices(uris, pickedIdx);
      if (albumPickRequiresFullDelete(m, currentUserId, uris, picked, next)) {
        confirmDeleteSelectedMessage(m);
        return;
      }
      const r = await updateMessageUris(String(m.id), next);
      if (r?.ok) {
        setMessages((prev) => mapMessagesAfterAlbumUrisUpdate(prev, String(m.id), next, r));
        showForwardToastBadge(true, t('chatDeleted', lang));
      } else {
        showNotice('error', t('errorTitle', lang), t('saveFailed', lang));
      }
    },
    [
      consumeAlbumScope,
      saveAlbumUris,
      openForwardPicker,
      currentUserId,
      confirmDeleteSelectedMessage,
      showForwardToastBadge,
      showNotice,
      lang,
    ],
  );

  return {
    downloadUriToCache,
    saveAlbumUris,
    runSelectedImageAction,
    requestImageAction,
    applyAlbumPick,
  };
}
