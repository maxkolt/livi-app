/**
 * На Android Glide (expo-image) падает с "Expected URL scheme 'http' or 'https' but was 'data'"
 * при загрузке data: URI. Конвертируем data: в file: перед передачей в ExpoImage.
 */
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const DATA_URI_PREFIX = 'data:';
const isDataUri = (uri: string) =>
  typeof uri === 'string' && uri.trim().toLowerCase().startsWith(DATA_URI_PREFIX);

const resolvedCache: Record<string, string> = {};

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

  try {
    const comma = uri.indexOf(',');
    if (comma === -1) return uri;
    const base64 = uri.slice(comma + 1).trim();
    const mimeMatch = /^data:([^;,]+)/i.exec(uri);
    const ext = mimeMatch?.[1]?.includes('png') ? 'png' : 'jpg';
    const filename = `avatar_${cacheKey}.${ext}`;
    const fileUri = `${FileSystem.cacheDirectory}glide_data_uri_${filename}`;

    const exists = await FileSystem.getInfoAsync(fileUri, { size: false }).then(
      (i) => i?.exists === true
    ).catch(() => false);
    if (!exists) {
      await FileSystem.writeAsStringAsync(fileUri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }
    resolvedCache[cacheKey] = fileUri;
    return fileUri;
  } catch {
    return uri;
  }
}
