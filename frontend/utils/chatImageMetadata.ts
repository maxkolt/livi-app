import type { ChatImageMetadata, ChatImageSize } from '../screens/chat/chatMessageTypes';

/** Normalize untrusted picker/cache metadata without changing album positions. */
export function normalizeChatImageMetadata(
  type: unknown,
  payload: { imageWidth?: unknown; imageHeight?: unknown; imageSizes?: unknown; uri?: unknown; uris?: unknown },
  imageUris: readonly string[],
): ChatImageMetadata {
  if (type !== 'image' || !imageUris.length) return {};
  const validSize = (value: unknown): ChatImageSize | null => {
    if (!value || typeof value !== 'object') return null;
    const { width, height } = value as ChatImageSize;
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
      width <= 32768 && height <= 32768 ? { width, height } : null;
  };
  const rawUris = Array.isArray(payload.uris) && payload.uris.length
    ? payload.uris.map(uri => String(uri || '').trim()) : payload.uri ? [String(payload.uri).trim()] : [];
  const rawSizes = Array.isArray(payload.imageSizes) ? payload.imageSizes : [];
  const sizes = imageUris.slice(0, 10).map((uri, index) => {
    const sourceIndex = rawUris.length ? rawUris.indexOf(uri) : index;
    return validSize(sourceIndex >= 0 ? rawSizes[sourceIndex] : null);
  });
  const sameFirstPhoto = !rawUris.length || rawUris[0] === imageUris[0];
  const first = sizes[0] || (sameFirstPhoto ? validSize({ width: payload.imageWidth, height: payload.imageHeight }) : null);
  if (first) sizes[0] = first;
  return {
    ...(first ? { imageWidth: first.width, imageHeight: first.height } : {}),
    ...(imageUris.length > 1 && sizes.some(Boolean) ? { imageSizes: sizes } : {}),
  };
}
