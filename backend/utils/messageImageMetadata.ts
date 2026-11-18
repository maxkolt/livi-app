/** Image geometry is optional; old messages keep their existing layout fallback. */
export type MessageImageSize = { width: number; height: number };
export type MessageImageMetadata = {
  imageWidth?: number;
  imageHeight?: number;
  imageSizes?: Array<MessageImageSize | null>;
};
export const MAX_MESSAGE_IMAGE_DIMENSION = 32768;

function validSize(width: unknown, height: unknown): MessageImageSize | null {
  return typeof width === 'number' && typeof height === 'number' &&
    Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= MAX_MESSAGE_IMAGE_DIMENSION && height <= MAX_MESSAGE_IMAGE_DIMENSION
    ? { width, height } : null;
}

/** Keep album sizes aligned when empty/duplicate URIs are removed or photos are deleted. */
export function normalizeMessageImageMetadata(
  type: unknown,
  payload: { imageWidth?: unknown; imageHeight?: unknown; imageSizes?: unknown; uri?: unknown; uris?: unknown },
  imageUris: readonly string[],
): MessageImageMetadata {
  if (type !== 'image' || imageUris.length === 0) return {};
  const rawUris = Array.isArray(payload.uris) && payload.uris.length
    ? payload.uris.map(uri => String(uri || '').trim()) : payload.uri ? [String(payload.uri).trim()] : [];
  const rawSizes = Array.isArray(payload.imageSizes) ? payload.imageSizes : [];
  const sizes = imageUris.slice(0, 10).map((uri, index) => {
    const sourceIndex = rawUris.length ? rawUris.indexOf(uri) : index;
    const raw = sourceIndex >= 0 ? rawSizes[sourceIndex] : null;
    return raw && typeof raw === 'object'
      ? validSize((raw as MessageImageSize).width, (raw as MessageImageSize).height) : null;
  });
  const sameFirstPhoto = !rawUris.length || rawUris[0] === imageUris[0];
  const first = sizes[0] || (sameFirstPhoto ? validSize(payload.imageWidth, payload.imageHeight) : null);
  if (first) sizes[0] = first;
  return {
    ...(first ? { imageWidth: first.width, imageHeight: first.height } : {}),
    ...(imageUris.length > 1 && sizes.some(Boolean) ? { imageSizes: sizes } : {}),
  };
}
