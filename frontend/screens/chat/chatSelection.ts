/** Pure selection-mode helpers for chat (message + album tile keys). */

import {
  albumSelectionKey,
  albumSelectionKeysForMessage,
  getMessageImageUris,
  isImageAlbumMessage,
  parseAlbumSelectionKey,
  selectedAlbumIndices,
} from "./chatAlbum";

export function initialSelectionKeysForMessage(
  m: any,
  focusIndex: number | null = null,
): Set<string> {
  const next = new Set<string>();
  const mid = String(m?.id || "").trim();
  if (!mid) return next;
  if (isImageAlbumMessage(m)) {
    const uris = getMessageImageUris(m);
    const idx =
      focusIndex != null && focusIndex >= 0 && focusIndex < uris.length ? focusIndex : 0;
    next.add(albumSelectionKey(mid, idx));
  } else {
    next.add(mid);
  }
  return next;
}

export function toggleMessageSelection(
  prev: Set<string>,
  messages: any[],
  id: string,
): Set<string> {
  const mid = String(id || "").trim();
  if (!mid) return prev;
  const msg = messages.find((m) => String(m?.id || "").trim() === mid);
  const next = new Set(prev);
  if (msg && isImageAlbumMessage(msg)) {
    const keys = albumSelectionKeysForMessage(msg);
    next.delete(mid);
    const allOn = keys.length > 0 && keys.every((k) => next.has(k));
    if (allOn) {
      for (const k of keys) next.delete(k);
    } else {
      for (const k of keys) next.add(k);
    }
    return next;
  }
  if (next.has(mid)) next.delete(mid);
  else next.add(mid);
  return next;
}

export function toggleAlbumTileSelection(
  prev: Set<string>,
  messages: any[],
  messageId: string,
  index: number,
): Set<string> {
  const mid = String(messageId || "").trim();
  if (!mid || index < 0) return prev;
  const key = albumSelectionKey(mid, index);
  const next = new Set(prev);
  if (next.has(mid)) {
    next.delete(mid);
    const msg = messages.find((m) => String(m?.id || "") === mid);
    const n = getMessageImageUris(msg).length;
    for (let i = 0; i < n; i++) {
      if (i !== index) next.add(albumSelectionKey(mid, i));
    }
    return next;
  }
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function allLoadedSelectionKeys(messages: any[]): string[] {
  const allKeys: string[] = [];
  for (const m of messages) {
    const mid = String(m?.id || "").trim();
    if (!mid) continue;
    if (isImageAlbumMessage(m)) {
      allKeys.push(...albumSelectionKeysForMessage(m));
    } else {
      allKeys.push(mid);
    }
  }
  return allKeys;
}

export function selectionHasAnyValidKey(
  selectedKeys: Set<string>,
  messages: any[],
): boolean {
  const byId = new Map(
    messages.map((m) => [String(m?.id || "").trim(), m] as const).filter(([id]) => !!id),
  );
  for (const key of selectedKeys) {
    const parsed = parseAlbumSelectionKey(key);
    if (parsed) {
      const msg = byId.get(parsed.messageId);
      if (msg && parsed.index < getMessageImageUris(msg).length) return true;
      continue;
    }
    if (byId.has(key)) return true;
  }
  return false;
}

export function selectionHasAnyForwardable(
  selectedKeys: Set<string>,
  messages: any[],
): boolean {
  if (selectedKeys.size === 0) return false;
  for (const m of messages) {
    const id = String(m?.id || "").trim();
    if (!id) continue;
    const type = String(m?.type || "").trim();
    if (type === "image" && isImageAlbumMessage(m)) {
      if (selectedAlbumIndices(m, selectedKeys).length > 0) return true;
      continue;
    }
    if (!selectedKeys.has(id)) continue;
    if (type === "text" && String(m?.text || "").trim()) return true;
    if (type === "image" && String(m?.uri || "").trim()) return true;
    if (type === "audio" && String(m?.uri || "").trim()) return true;
    if (type === "sticker" && String(m?.stickerId || "").trim()) return true;
  }
  return false;
}

export type AlbumDeletePlan = {
  fullDeleteIds: Set<string>;
  albumPartials: Array<{ messageId: string; message: any; removeIndices: number[] }>;
};

/** Expand selection keys into full message deletes vs partial album photo removals. */
export function planAlbumSelectionDeletes(
  rawKeys: string[],
  messages: any[],
  currentUserId: string | null | undefined,
): AlbumDeletePlan {
  const byId = new Map(
    messages.map((m) => [String(m?.id || "").trim(), m] as const).filter(([id]) => !!id),
  );
  const fullDeleteIds = new Set<string>();
  const albumPartials: AlbumDeletePlan["albumPartials"] = [];
  const albumRemoveByMsg = new Map<string, Set<number>>();

  for (const key of rawKeys) {
    const parsed = parseAlbumSelectionKey(key);
    if (parsed) {
      let set = albumRemoveByMsg.get(parsed.messageId);
      if (!set) {
        set = new Set();
        albumRemoveByMsg.set(parsed.messageId, set);
      }
      set.add(parsed.index);
      continue;
    }
    fullDeleteIds.add(key);
  }

  for (const [messageId, removeSet] of albumRemoveByMsg) {
    const message = byId.get(messageId);
    if (!message) continue;
    const uris = getMessageImageUris(message);
    const removeIndices = Array.from(removeSet).filter((i) => i >= 0 && i < uris.length);
    if (!removeIndices.length) continue;
    const isOwn = message?.from === currentUserId || message?.sender === "me";
    if (!isOwn || removeIndices.length >= uris.length) {
      fullDeleteIds.add(messageId);
    } else {
      albumPartials.push({ messageId, message, removeIndices });
    }
  }

  return { fullDeleteIds, albumPartials };
}
