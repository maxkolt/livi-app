import type { ChatMessage } from './chatMessageTypes';

/** Selection-mode state for ChatScreen (message + album tiles). */

import React from "react";
import {
  allLoadedSelectionKeys,
  initialSelectionKeysForMessage,
  reconcileSelectionKeys,
  selectionHasAnyForwardable,
  toggleAlbumTileSelection,
  toggleMessageSelection,
} from "./chatSelection";

type Options = {
  messages: ChatMessage[];
  /** Called when entering selection (e.g. close actions sheet). */
  onEnter?: () => void;
};

export function useChatSelection({ messages, onEnter }: Options) {
  const [selectionMode, setSelectionMode] = React.useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = React.useState<Set<string>>(
    () => new Set(),
  );

  const exitSelectionMode = React.useCallback(() => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, []);

  const toggleSelectMessage = React.useCallback(
    (id: string) => {
      setSelectedMessageIds((prev) => toggleMessageSelection(prev, messages, id));
    },
    [messages],
  );

  const toggleSelectAlbumTile = React.useCallback(
    (messageId: string, index: number) => {
      setSelectedMessageIds((prev) =>
        toggleAlbumTileSelection(prev, messages, messageId, index),
      );
    },
    [messages],
  );

  const enterSelectionModeFromMessage = React.useCallback(
    (m: ChatMessage, focusIndex: number | null = null) => {
      setSelectionMode(true);
      setSelectedMessageIds(initialSelectionKeysForMessage(m, focusIndex));
      try {
        onEnter?.();
      } catch {}
    },
    [onEnter],
  );

  const enterEmptySelectionMode = React.useCallback(() => {
    setSelectionMode(true);
    setSelectedMessageIds(new Set());
    try {
      onEnter?.();
    } catch {}
  }, [onEnter]);

  const selectAllLoaded = React.useCallback(() => {
    const allKeys = allLoadedSelectionKeys(messages);
    const allSelected =
      allKeys.length > 0 && allKeys.every((k) => selectedMessageIds.has(k));
    if (allSelected) {
      setSelectedMessageIds(new Set());
    } else {
      setSelectedMessageIds(new Set(allKeys));
    }
  }, [messages, selectedMessageIds]);

  React.useEffect(() => {
    if (!selectionMode) return;
    // Пустой режим нужен при входе через меню чата: сначала показываем боксы,
    // затем пользователь отмечает нужные сообщения.
    if (selectedMessageIds.size === 0) return;
    const next = reconcileSelectionKeys(selectedMessageIds, messages);
    if (next.size === 0) {
      exitSelectionMode();
    } else if (next !== selectedMessageIds) {
      setSelectedMessageIds(next);
    }
  }, [selectionMode, selectedMessageIds, messages, exitSelectionMode]);

  const selectedCount = selectedMessageIds.size;
  const selectedHasAnyForwardable = React.useMemo(
    () =>
      selectionMode && selectionHasAnyForwardable(selectedMessageIds, messages),
    [selectionMode, selectedMessageIds, messages],
  );

  return {
    selectionMode,
    setSelectionMode,
    selectedMessageIds,
    setSelectedMessageIds,
    selectedCount,
    selectedHasAnyForwardable,
    exitSelectionMode,
    toggleSelectMessage,
    toggleSelectAlbumTile,
    enterEmptySelectionMode,
    enterSelectionModeFromMessage,
    selectAllLoaded,
  };
}
