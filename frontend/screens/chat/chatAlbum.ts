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
  const rawUris = message?.uris;
  const list = Array.isArray(rawUris)
    ? rawUris
    : typeof rawUris === 'string' && rawUris.trim().startsWith('[')
      ? (() => {
          try {
            const parsed = JSON.parse(rawUris);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];
  for (const u of list) {
    push(u);
    if (out.length >= CHAT_ALBUM_MAX) break;
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

/**
 * Inner pixel width of the album grid (inside bubble padding).
 * Matches ChatMessageItem: row maxWidth 92% + margin 16, bubble maxWidth 80%.
 * Slightly conservative so tiles never wrap on the first Yoga pass.
 */
export function albumInnerWidth(windowWidth: number): number {
  const listW = Math.max(1, Math.round(windowWidth));
  const rowW = Math.min(Math.floor(listW * 0.92), listW - 32);
  const bubbleW = Math.floor(rowW * 0.8);
  return Math.max(120, bubbleW - CHAT_ALBUM_INSET * 2 - 2);
}

export type AlbumGridLayout = {
  cols: number;
  tile: number;
  rowH: number;
  gridW: number;
  gridH: number;
  bubbleW: number;
};

/** Locked pixel layout for an album — no onLayout resize. */
export function albumGridLayout(windowWidth: number, count: number): AlbumGridLayout {
  const n = Math.max(1, Math.min(CHAT_ALBUM_MAX, count | 0));
  const cols = albumGridColumns(n);
  const innerW = albumInnerWidth(windowWidth);
  const tile = Math.max(1, Math.floor((innerW - CHAT_ALBUM_GAP * (cols - 1)) / cols));
  const gridW = tile * cols + CHAT_ALBUM_GAP * (cols - 1);
  const rowH = n === 1 ? Math.round(tile * 0.78) : tile;
  const rows = Math.ceil(n / cols);
  const gridH = rowH * rows + CHAT_ALBUM_GAP * Math.max(0, rows - 1);
  return {
    cols,
    tile,
    rowH,
    gridW,
    gridH,
    bubbleW: gridW + CHAT_ALBUM_INSET * 2,
  };
}
