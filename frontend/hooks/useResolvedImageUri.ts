/**
 * На Android для data: URI возвращает file: URI (после асинхронного разрешения),
 * чтобы Glide не падал с "Expected URL scheme 'http' or 'https' but was 'data'".
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { peekResolvedDataUriCache, resolveDataUriForAndroid } from '../utils/dataUriToFileUri';

const isDataUri = (uri: string) =>
  typeof uri === 'string' && uri.trim().toLowerCase().startsWith('data:');

function initialResolved(uri: string): { resolved: string; ready: boolean } {
  if (!uri) return { resolved: '', ready: true };
  if (Platform.OS !== 'android' || !isDataUri(uri)) {
    return { resolved: uri, ready: true };
  }
  const cached = peekResolvedDataUriCache(uri);
  if (cached) return { resolved: cached, ready: true };
  return { resolved: '', ready: false };
}

/**
 * Возвращает URI, пригодный для ExpoImage: на Android для data: — file: URI после разрешения.
 * При смене uri не гасит предыдущий кадр (stale-while-revalidate) — меньше мерцания в шапке чата.
 */
export function useResolvedImageUri(uri: string): [resolvedUri: string, ready: boolean] {
  const needsResolve = Platform.OS === 'android' && isDataUri(uri);
  const [result, setResult] = useState(() => ({ source: uri, ...initialResolved(uri) }));

  useEffect(() => {
    if (!uri) {
      setResult({ source: uri, resolved: '', ready: true });
      return;
    }
    if (!needsResolve) {
      setResult({ source: uri, resolved: uri, ready: true });
      return;
    }
    const cached = peekResolvedDataUriCache(uri);
    if (cached) {
      setResult({ source: uri, resolved: cached, ready: true });
      return;
    }
    let alive = true;
    resolveDataUriForAndroid(uri).then((fileUri) => {
      if (alive) {
        setResult({ source: uri, resolved: fileUri, ready: true });
      }
    });
    return () => {
      alive = false;
    };
  }, [uri, needsResolve]);

  // Effects run after render: the previous file must never be reported as ready
  // for a new data URI, or AvatarImage will cache it under the new avatar version.
  const immediate = initialResolved(uri);
  if (immediate.ready) return [immediate.resolved, true];
  return [result.resolved, result.source === uri && result.ready];
}
