import type { PickedChatImage } from '../screens/chat/chatMessageTypes';
import { normalizeChatImageMetadata } from './chatImageMetadata';

export type PhotoComposeSelection = { assets: PickedChatImage[]; caption: string };
export type PhotoSizeReader = (uri: string) => Promise<{ width: number; height: number }>;

export function photoComposeMessageFields(assets: PickedChatImage[], caption: string) {
  const first = assets[0];
  const imageSizes = assets.map(asset => ({ width: asset.width, height: asset.height }));
  return {
    ...(caption.trim() ? { text: caption } : {}),
    ...normalizeChatImageMetadata('image', {
      imageWidth: first?.width,
      imageHeight: first?.height,
      ...(assets.length > 1 ? { imageSizes } : {}),
    }, assets.map(asset => asset.uri)),
  };
}

/** Resolve edited dimensions before the optimistic row, rather than resizing it after paint. */
export async function preparePhotoComposeSelection(
  uris: string[],
  originalAssets: PickedChatImage[],
  caption: string,
  readSize: PhotoSizeReader,
): Promise<PhotoComposeSelection> {
  const assets = await Promise.all(uris.map(async (uri, index): Promise<PickedChatImage> => {
    const original = originalAssets[index];
    if (original?.uri === uri && Number(original.width) > 0 && Number(original.height) > 0) {
      return { ...original, uri };
    }
    const { width: _oldWidth, height: _oldHeight, fileSize: _oldFileSize, ...metadata } = original || { uri };
    try {
      const size = await readSize(uri);
      if (Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0) {
        return { ...metadata, uri, width: Math.round(size.width), height: Math.round(size.height) };
      }
    } catch { /* A legacy source can still be sent and resolved by the receiver. */ }
    return { ...metadata, uri };
  }));
  return { assets, caption: caption.trim() ? caption : '' };
}
