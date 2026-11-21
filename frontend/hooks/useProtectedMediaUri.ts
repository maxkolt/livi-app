import { useEffect, useState } from 'react';
import { isPrivateMedia, peekProtectedMedia, protectedMediaCacheKey, resolveProtectedMedia } from '../utils/protectedMedia';

export function useProtectedMediaUri(uri: string): string {
  const privateMedia = isPrivateMedia(uri);
  const identity = privateMedia ? protectedMediaCacheKey(uri) : uri;
  const [result, setResult] = useState({ source: identity, uri: privateMedia ? peekProtectedMedia(uri) || '' : uri });
  useEffect(() => {
    if (!isPrivateMedia(uri)) return;
    let alive = true;
    void resolveProtectedMedia(uri).then(local => { if (alive) setResult({ source: identity, uri: local }); }).catch(() => {});
    return () => { alive = false; };
  }, [uri, identity]);
  if (!isPrivateMedia(uri)) return uri;
  return peekProtectedMedia(uri) || (result.source === identity ? result.uri : '');
}
