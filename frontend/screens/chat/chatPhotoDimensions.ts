import { Image } from 'react-native';
import { albumGridLayout, CHAT_ALBUM_INSET } from './chatAlbum';

export type ChatPhotoDimensions = { width: number; height: number };
const MAX_DIMENSION = 32768;
const CACHE_LIMIT = 256;
const dimensionsByUri = new Map<string, ChatPhotoDimensions>();
const pendingByUri = new Map<string, Promise<ChatPhotoDimensions | null>>();

export function validChatPhotoDimensions(width: unknown, height: unknown): ChatPhotoDimensions | null {
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return { width, height };
}

export function rememberChatPhotoDimensions(uri: string, width: unknown, height: unknown): ChatPhotoDimensions | null {
  const dimensions = validChatPhotoDimensions(width, height);
  if (!uri || !dimensions) return null;
  dimensionsByUri.delete(uri);
  dimensionsByUri.set(uri, dimensions);
  while (dimensionsByUri.size > CACHE_LIMIT) dimensionsByUri.delete(dimensionsByUri.keys().next().value!);
  return dimensions;
}

export function peekChatPhotoDimensions(uri: string): ChatPhotoDimensions | null {
  return dimensionsByUri.get(uri) || null;
}

/** Metadata avoids all probing; old messages share one native dimension lookup per URI. */
export function resolveChatPhotoDimensions(uri: string, width?: unknown, height?: unknown): Promise<ChatPhotoDimensions | null> {
  const known = rememberChatPhotoDimensions(uri, width, height) || peekChatPhotoDimensions(uri);
  if (known || !uri) return Promise.resolve(known);
  const pending = pendingByUri.get(uri);
  if (pending) return pending;
  const probe = (resolvedUri: string) => new Promise<ChatPhotoDimensions | null>(resolve => {
    try {
      Image.getSize(resolvedUri, (w, h) => {
        // A sender/server metadata update can arrive before an older native lookup finishes.
        resolve(peekChatPhotoDimensions(uri) || rememberChatPhotoDimensions(uri, w, h));
      }, () => resolve(peekChatPhotoDimensions(uri)));
    } catch {
      resolve(peekChatPhotoDimensions(uri));
    }
  });
  const lookup = (uri.includes('/uploads/media/') ? import('../../utils/protectedMedia').then(({ resolveProtectedMedia }) => resolveProtectedMedia(uri)).then(probe) : probe(uri)).catch(() => null).finally(() => pendingByUri.delete(uri));
  pendingByUri.set(uri, lookup);
  return lookup;
}

/** Border padding belongs outside the photo's natural content width. */
export function chatPhotoBubbleWidth(imageWidth: number, highlightInset = 0): number {
  return Math.max(120, imageWidth) + CHAT_ALBUM_INSET * 2 + highlightInset * 2;
}

/** Keep the established single-photo frame width while limiting its height. */
export function chatPhotoPreviewLayout(
  layoutWidth: number,
  dimensions?: ChatPhotoDimensions | null,
  viewportHeight = 780,
): { width: number; height: number; bubbleW: number } {
  const safeWidth = Number.isFinite(layoutWidth) && layoutWidth > 0 ? layoutWidth : 360;
  const maxWidth = albumGridLayout(safeWidth, 1).gridW;
  const valid = dimensions && validChatPhotoDimensions(dimensions.width, dimensions.height);
  if (!valid) return { width: maxWidth, height: Math.round(maxWidth * 3 / 4), bubbleW: chatPhotoBubbleWidth(maxWidth) };
  const safeHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 780;
  const establishedHeightLimit = Math.max(120, Math.min(480, safeHeight * 0.6));
  const scale = Math.min(maxWidth / valid.width, establishedHeightLimit / valid.height);
  const width = Math.max(1, Math.min(maxWidth, valid.width * scale));
  const maxHeight = Math.max(120, Math.min(300, safeHeight * 0.4));
  const height = Math.max(1, Math.min(maxHeight, valid.height * scale));
  return { width, height, bubbleW: chatPhotoBubbleWidth(width) };
}
