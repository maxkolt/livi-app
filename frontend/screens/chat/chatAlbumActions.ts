/** Pure album save/forward/delete helpers for chat image actions. */

import { getMessageImageUris } from "./chatAlbum";

export type AlbumScopeKind = "save" | "forward" | "delete";

/** Keep URIs whose indices are NOT in removeIndices. */
export function urisWithoutIndices(
  uris: string[],
  removeIndices: Iterable<number>,
): string[] {
  const removeSet = new Set(
    Array.from(removeIndices).filter((i) => Number.isFinite(i) && i >= 0),
  );
  return uris.filter((_, i) => !removeSet.has(i));
}

/** Patch fields after partial album URI update (local or server response). */
export function albumMessageFieldsAfterUrisUpdate(
  nextUris: string[],
  serverUri?: string | null,
): { uri: string; uris?: string[] } {
  const uri = String(serverUri || nextUris[0] || "").trim() || nextUris[0];
  return {
    uri,
    uris: nextUris.length > 1 ? nextUris : undefined,
  };
}

/** Apply server/local album URI update onto a messages array. */
export function mapMessagesAfterAlbumUrisUpdate(
  prev: any[],
  messageId: string,
  nextUris: string[],
  result: { ok?: boolean; deleted?: boolean; uri?: string } | null | undefined,
): any[] {
  const mid = String(messageId || "").trim();
  if (!mid || !result?.ok) return prev;
  if (result.deleted) {
    return prev.filter((x) => String(x?.id) !== mid);
  }
  const fields = albumMessageFieldsAfterUrisUpdate(nextUris, result.uri);
  return prev.map((x) => (String(x?.id) === mid ? { ...x, ...fields } : x));
}

/** Shape selectedMessage for forward after album multi-pick. */
export function buildAlbumForwardSelectedMessage(
  message: any,
  pickedUris: string[],
): any {
  if (!pickedUris.length) return message;
  if (pickedUris.length === 1) {
    return {
      ...message,
      uri: pickedUris[0],
      uris: undefined,
      __albumForwardOne: true,
    };
  }
  return {
    ...message,
    uri: pickedUris[0],
    uris: pickedUris,
    __albumForwardOne: false,
  };
}

/** Focus index used when opening album scope from a menu action. */
export function albumScopeInitialFocus(
  uris: string[],
  focusIndex: number | null,
): number | null {
  const isAlbum = uris.length > 1;
  const hasFocus =
    isAlbum && focusIndex != null && focusIndex >= 0 && focusIndex < uris.length;
  if (hasFocus) return focusIndex;
  if (isAlbum) return 0;
  return null;
}

export function albumPickInitialIndices(
  uris: string[],
  focusIndex: number | null,
): number[] {
  if (focusIndex != null && focusIndex >= 0 && focusIndex < uris.length) {
    return [focusIndex];
  }
  return [0];
}

export function filterValidAlbumPickIndices(
  uris: string[],
  indices: number[],
): { pickedIdx: number[]; picked: string[] } {
  const pickedIdx = indices.filter((i) => i >= 0 && i < uris.length);
  const picked = pickedIdx.map((i) => uris[i]).filter(Boolean);
  return { pickedIdx, picked };
}

/** Whether delete of picked album photos should become a full-message delete. */
export function albumPickRequiresFullDelete(
  message: any,
  currentUserId: string | null | undefined,
  uris: string[],
  picked: string[],
  nextAfterRemove: string[],
): boolean {
  const isOwn = message?.from === currentUserId || message?.sender === "me";
  if (!isOwn) return true;
  if (picked.length >= uris.length) return true;
  if (nextAfterRemove.length === 0) return true;
  return false;
}

export function resolveOneAlbumUri(
  message: any,
  focusIndex: number | null,
): { uris: string[]; isAlbum: boolean; idx: number | null; oneUri: string | undefined } {
  const uris = getMessageImageUris(message);
  const isAlbum = uris.length > 1;
  const idx =
    focusIndex != null && focusIndex >= 0 && focusIndex < uris.length ? focusIndex : null;
  const oneUri = idx != null ? uris[idx] : uris[0];
  return { uris, isAlbum, idx, oneUri };
}
