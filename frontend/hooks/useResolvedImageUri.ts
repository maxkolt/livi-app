/**
 * На Android для data: URI возвращает file: URI (после асинхронного разрешения),
 * чтобы Glide не падал с "Expected URL scheme 'http' or 'https' but was 'data'".
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { resolveDataUriForAndroid } from '../utils/dataUriToFileUri';

const isDataUri = (uri: string) =>
  typeof uri === 'string' && uri.trim().toLowerCase().startsWith('data:');

/**
 * Возвращает URI, пригодный для ExpoImage: на Android для data: — file: URI после разрешения.
 * ready === false только когда идёт разрешение (data: на Android).
 */
export function useResolvedImageUri(uri: string): [resolvedUri: string, ready: boolean] {
  const needsResolve = Platform.OS === 'android' && isDataUri(uri);
  const [resolved, setResolved] = useState(needsResolve ? '' : uri);
  const [ready, setReady] = useState(!needsResolve);

  useEffect(() => {
    if (!needsResolve) {
      setResolved(uri);
      setReady(true);
      return;
    }
    let alive = true;
    setReady(false);
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
