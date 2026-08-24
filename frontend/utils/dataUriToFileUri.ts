/**
 * На Android Glide (expo-image) падает с "Expected URL scheme 'http' or 'https' but was 'data'"
 * при загрузке data: URI. Конвертируем data: в file: перед передачей в ExpoImage.
 */
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';

const DATA_URI_PREFIX = 'data:';
const isDataUri = (uri: string) =>
  typeof uri === 'string' && uri.trim().toLowerCase().startsWith(DATA_URI_PREFIX);

/** Простой хэш строки для имени файла (стабильный для одного и того же data URI) */
function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < Math.min(str.length, 2000); i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

const resolvedCache: Record<string, string> = {};

function cacheKeyForDataUri(uri: string): string {
  return uri.length > 500 ? simpleHash(uri) + uri.length : uri;
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
    const filename = `avatar_${simpleHash(base64)}_${base64.length}.${ext}`;
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
