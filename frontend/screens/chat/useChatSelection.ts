/** Selection-mode state for ChatScreen (message + album tiles). */

import React from "react";
import {
  allLoadedSelectionKeys,
  initialSelectionKeysForMessage,
  selectionHasAnyForwardable,
  selectionHasAnyValidKey,
  toggleAlbumTileSelection,
  toggleMessageSelection,
} from "./chatSelection";

type Options = {
  messages: any[];
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
    (m: any, focusIndex: number | null = null) => {
      setSelectionMode(true);
      setSelectedMessageIds(initialSelectionKeysForMessage(m, focusIndex));
      try {
        onEnter?.();
      } catch {}
    },
    [onEnter],
  );

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
    if (selectedMessageIds.size === 0) {
      exitSelectionMode();
      return;
    }
    if (!selectionHasAnyValidKey(selectedMessageIds, messages)) {
      exitSelectionMode();
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
    enterSelectionModeFromMessage,
    selectAllLoaded,
  };
}
