/** Android avatars share a content-addressed file between their visible and warm image sources. */
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const DATA_URI_PREFIX = 'data:';
const isDataUri = (uri: string) =>
  typeof uri === 'string' && uri.trim().toLowerCase().startsWith(DATA_URI_PREFIX);

const resolvedCache: Record<string, string> = {};
const pendingConversions = new Map<string, Promise<string>>();

function cacheKeyForDataUri(uri: string): string {
  // JPEGs often share their entire header. Hash all image data so a different
  // photo of the same length never reuses the previous photo's file.
  return bytesToHex(sha256(uri));
}

/** Синхронно: уже разрешённый file: URI для этого data: (без записи на диск). */
export function peekResolvedDataUriCache(uri: string): string | null {
  if (!uri || Platform.OS !== 'android' || !isDataUri(uri)) return null;
  return resolvedCache[cacheKeyForDataUri(uri)] || null;
}

/**
 * На Android для data: URI записывает base64 в кэш и возвращает file: URI.
 * На iOS и для не-data URI возвращает uri без изменений.
 */
export async function resolveDataUriForAndroid(uri: string): Promise<string> {
  if (!uri || typeof uri !== 'string') return uri;
  if (Platform.OS !== 'android' || !isDataUri(uri)) return uri;

  const cacheKey = cacheKeyForDataUri(uri);
  if (resolvedCache[cacheKey]) return resolvedCache[cacheKey];

  const pending = pendingConversions.get(cacheKey);
  if (pending) return pending;

  const conversion = (async () => {
    let temporaryUri = '';
    try {
      const comma = uri.indexOf(',');
      if (comma === -1 || !FileSystem.cacheDirectory) return uri;
      const base64 = uri.slice(comma + 1).replace(/\s/g, '');
      if (!base64) return uri;
      const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
      const expectedBytes = Math.floor(base64.length * 3 / 4) - padding;
      const mimeMatch = /^data:([^;,]+)/i.exec(uri);
      const ext = mimeMatch?.[1]?.includes('png') ? 'png' : 'jpg';
      const filename = `avatar_${cacheKey}.${ext}`;
      const fileUri = `${FileSystem.cacheDirectory}glide_data_uri_${filename}`;

      // Older processes wrote the final path directly. Reject their empty or
      // truncated leftovers instead of publishing them as a ready avatar.
      const info = await FileSystem.getInfoAsync(fileUri, { size: true }).catch(() => null);
      const complete = info?.exists === true && !info.isDirectory && info.size === expectedBytes;
      if (!complete) {
        temporaryUri = `${fileUri}.pending`;
        await FileSystem.writeAsStringAsync(temporaryUri, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        // The sibling file is invisible to other rows until the write has
        // finished. Same-directory rename publishes the complete image at once.
        await FileSystem.moveAsync({ from: temporaryUri, to: fileUri });
        temporaryUri = '';
      }
      resolvedCache[cacheKey] = fileUri;
      return fileUri;
    } catch {
      if (temporaryUri) await FileSystem.deleteAsync(temporaryUri, { idempotent: true }).catch(() => {});
      return uri;
    }
  })().finally(() => {
    pendingConversions.delete(cacheKey);
  });
  pendingConversions.set(cacheKey, conversion);
  return conversion;
}
