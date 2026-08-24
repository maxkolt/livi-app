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
  const [resolved, setResolved] = useState(() => initialResolved(uri).resolved);
  const [ready, setReady] = useState(() => initialResolved(uri).ready);

  useEffect(() => {
    if (!uri) {
      setResolved('');
      setReady(true);
      return;
    }
    if (!needsResolve) {
      setResolved(uri);
      setReady(true);
      return;
    }
    const cached = peekResolvedDataUriCache(uri);
    if (cached) {
      setResolved(cached);
      setReady(true);
      return;
    }
    let alive = true;
    resolveDataUriForAndroid(uri).then((fileUri) => {
      if (alive) {
        setResolved(fileUri);
        setReady(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [uri, needsResolve]);

  return [resolved, ready];
}
