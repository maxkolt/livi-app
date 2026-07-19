/** Chat image album helpers (1…10 photos in one message). */

export const CHAT_ALBUM_MAX = 10;
export const CHAT_ALBUM_GAP = 2;
/** Visible padding from bubble edges (left / right / top). */
export const CHAT_ALBUM_INSET = 4;

/** Selection-mode key for one photo inside an album: `${messageId}::album::${index}`. */
export const ALBUM_SEL_MARK = '::album::';

export function albumSelectionKey(messageId: string, index: number): string {
  return `${String(messageId || '').trim()}${ALBUM_SEL_MARK}${index | 0}`;
}

export function parseAlbumSelectionKey(
  key: string,
): { messageId: string; index: number } | null {
  const s = String(key || '');
  const at = s.indexOf(ALBUM_SEL_MARK);
  if (at <= 0) return null;
  const messageId = s.slice(0, at).trim();
  const index = Number(s.slice(at + ALBUM_SEL_MARK.length));
  if (!messageId || !Number.isFinite(index) || index < 0) return null;
  return { messageId, index: index | 0 };
}

export function isAlbumSelectionKey(key: string): boolean {
  return parseAlbumSelectionKey(key) != null;
}

/** Normalize message image URIs: prefers `uris[]`, falls back to single `uri`. */
export function getMessageImageUris(message: any): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    const s = String(raw || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(message?.uris)) {
    for (const u of message.uris) {
      push(u);
      if (out.length >= CHAT_ALBUM_MAX) break;
    }
  }
  if (out.length === 0) push(message?.uri);
  return out;
}

export function isImageAlbumMessage(message: any): boolean {
  return String(message?.type || '') === 'image' && getMessageImageUris(message).length > 1;
}

/** All selection keys for an album message (one per photo). */
export function albumSelectionKeysForMessage(message: any): string[] {
  const mid = String(message?.id || '').trim();
  if (!mid || !isImageAlbumMessage(message)) return mid ? [mid] : [];
  return getMessageImageUris(message).map((_, i) => albumSelectionKey(mid, i));
}

/** Selected photo indices for an album message from the selection set. */
export function selectedAlbumIndices(
  message: any,
  selectedKeys: Set<string> | Iterable<string>,
): number[] {
  const mid = String(message?.id || '').trim();
  if (!mid) return [];
  const set = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys);
  if (set.has(mid)) {
    // Whole-message id still means “all photos”
    return getMessageImageUris(message).map((_, i) => i);
  }
  const out: number[] = [];
  const n = getMessageImageUris(message).length;
  for (let i = 0; i < n; i++) {
    if (set.has(albumSelectionKey(mid, i))) out.push(i);
  }
  return out;
}

/** Columns for album grid (Telegram-like equal tiles). */
export function albumGridColumns(count: number): number {
  const n = Math.max(1, Math.min(CHAT_ALBUM_MAX, count | 0));
  if (n <= 1) return 1;
  if (n === 2 || n === 4) return 2;
  return 3;
}
