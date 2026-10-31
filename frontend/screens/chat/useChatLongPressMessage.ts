import type { ChatMessage } from './chatMessageTypes';

/** Long-press message actions (iOS ActionSheet / Android sheet). */

import React from "react";
import { ActionSheetIOS, Platform } from "react-native";
import { t, type Lang } from "../../utils/i18n";
import { getChatReplyPreviewText } from "./chatMessageMeta";

type Layout = { x: number; y: number; width: number; height: number };

type ReplyTo = { id: string; text: string; from?: string | null; isOwn?: boolean } | null;

type Options = {
  currentUserId: string | null;
  lang: Lang;
  messageTextRef: React.MutableRefObject<string>;
  setMessageText: React.Dispatch<React.SetStateAction<string>>;
  setEditingMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  setReplyingToMessage: React.Dispatch<React.SetStateAction<ReplyTo>>;
  setSelectedMessage: React.Dispatch<React.SetStateAction<ChatMessage | null>>;
  setAlbumFocusIndex: React.Dispatch<React.SetStateAction<number | null>>;
  copySelectedMessage: (m: ChatMessage) => void | Promise<void>;
  showMessageActionsSheet: (layout: Layout | null) => void;
  clearAndroidLayoutIfNeeded: (layout?: Layout) => void;
  enterSelectionModeFromMessage: (m: ChatMessage, focusIndex: number | null) => void;
  requestImageAction: (kind: "save" | "forward" | "delete", m: ChatMessage, focusIndex: number | null) => void;
  forwardSelectedMessage: (m: ChatMessage) => void | Promise<void>;
  deleteSelectedMessage: (m: ChatMessage) => void;
  /** true = облако ≥½ под шапкой/композером — long-press запрещён. */
  isLayoutBlockedByChrome?: (layout: Layout) => boolean;
};

export function useChatLongPressMessage({
  currentUserId,
  lang,
  messageTextRef,
  setMessageText,
  setEditingMessageId,
  setReplyingToMessage,
  setSelectedMessage,
  setAlbumFocusIndex,
  copySelectedMessage,
  showMessageActionsSheet,
  clearAndroidLayoutIfNeeded,
  enterSelectionModeFromMessage,
  requestImageAction,
  forwardSelectedMessage,
  deleteSelectedMessage,
  isLayoutBlockedByChrome,
}: Options) {
  const handleLongPressMessage = React.useCallback(
    (m: ChatMessage, layout?: { x: number; y: number; width: number; height: number }, focusIndex: number | null = null) => {
      if (layout && isLayoutBlockedByChrome?.(layout)) return;

      setSelectedMessage(m);
      setAlbumFocusIndex(focusIndex);
      clearAndroidLayoutIfNeeded(layout);

      const isOwn = m?.from === currentUserId || m?.sender === 'me';
      const isText = String(m?.type || '') === 'text';
      const isImage = String(m?.type || '') === 'image';
      const isCall = String(m?.type || '') === 'call';
      const showEdit = isOwn && isText;

      const actionIds: string[] = [];
      const options: string[] = [];
      const push = (id: string, label: string) => {
        actionIds.push(id);
        options.push(label);
      };

      if (isCall) {
        push('select', t('chatActionSelect', lang));
        push('delete', t('delete', lang));
        push('cancel', t('cancelAction', lang));
      } else if (isText || String(m?.stickerId || '').trim()) {
        push('copy', t('chatActionCopy', lang));
        if (isImage) {
          push('save', t('save', lang));
          push('forward', t('chatActionForward', lang));
        } else {
          push('forward', t('chatActionForward', lang));
        }
        push('select', t('chatActionSelect', lang));
        push('reply', t('chatActionReply', lang));
        if (showEdit) push('edit', t('chatActionEdit', lang));
        push('delete', t('delete', lang));
        push('cancel', t('cancelAction', lang));
      } else {
        if (isImage) {
          push('save', t('save', lang));
          push('forward', t('chatActionForward', lang));
        } else {
          push('forward', t('chatActionForward', lang));
        }
        push('select', t('chatActionSelect', lang));
        push('reply', t('chatActionReply', lang));
        if (showEdit) push('edit', t('chatActionEdit', lang));
        push('delete', t('delete', lang));
        push('cancel', t('cancelAction', lang));
      }
      const cancelButtonIndex = actionIds.length - 1;
      const destructiveButtonIndex = actionIds.indexOf('delete');

      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options,
            cancelButtonIndex,
            destructiveButtonIndex,
            userInterfaceStyle: 'dark',
          },
          (buttonIndex) => {
            const action = actionIds[buttonIndex] || 'cancel';
            if (action === 'cancel') {
              setAlbumFocusIndex(null);
              return;
            }
            if (action === 'reply') {
              setEditingMessageId(null);
              messageTextRef.current = '';
              setMessageText('');
              setReplyingToMessage({
                id: String(m?.id ?? ''),
                text: getChatReplyPreviewText(m, lang),
                from: m?.from,
                isOwn: isOwn,
              });
              setAlbumFocusIndex(null);
              return;
            }
            if (action === 'edit') {
              const text = String(m?.text ?? '');
              messageTextRef.current = text;
              setMessageText(text);
              setEditingMessageId(m?.id ?? null);
              setReplyingToMessage(null);
              setAlbumFocusIndex(null);
              return;
            }
            if (action === 'copy') {
              void copySelectedMessage(m);
              setAlbumFocusIndex(null);
              return;
            }
            if (action === 'select') {
              void enterSelectionModeFromMessage(m, focusIndex);
              setAlbumFocusIndex(null);
              return;
            }
            if (action === 'save' || (isImage && (action === 'forward' || action === 'delete'))) {
              requestImageAction(action, m, focusIndex);
              return;
            }
            if (action === 'forward') {
              void forwardSelectedMessage(m);
              setAlbumFocusIndex(null);
              return;
            }
            if (action === 'delete') {
              deleteSelectedMessage(m);
              setAlbumFocusIndex(null);
              return;
            }
          }
        );
        return;
      }

      // Android: штатное меню действий (без Alert)
      showMessageActionsSheet(layout ?? null);
    },
    [
      currentUserId,
      copySelectedMessage,
      showMessageActionsSheet,
      clearAndroidLayoutIfNeeded,
      enterSelectionModeFromMessage,
      requestImageAction,
      forwardSelectedMessage,
      deleteSelectedMessage,
      isLayoutBlockedByChrome,
      lang,
      messageTextRef,
      setMessageText,
      setEditingMessageId,
      setReplyingToMessage,
      setSelectedMessage,
      setAlbumFocusIndex,
    ]
  );

  const handleLongPressAlbumTile = React.useCallback(
    (m: ChatMessage, index: number, layout?: { x: number; y: number; width: number; height: number }) => {
      handleLongPressMessage(m, layout, index);
    },
    [handleLongPressMessage],
  );

  return { handleLongPressMessage, handleLongPressAlbumTile };
}
