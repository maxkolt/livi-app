import { sha256 } from '@noble/hashes/sha2';
import { NativeModules } from 'react-native';
import { fromBase64, toBase64, utf8Encode } from '../sockets/modules/e2eCrypto';
import { ExpiringLruCache } from './expiringLruCache';
import { MediaRequestQueue } from './mediaRequestQueue';
import { subscribeMemoryPressure } from './memoryPressure';

const apiBase = () => (require('../sockets/modules/constants') as typeof import('../sockets/modules/constants')).API_BASE;
const currentOwner = () => (require('../sockets/modules/authState') as typeof import('../sockets/modules/authState')).getCurrentUserId();
const MARKER = '#livi-media=';
export type MediaKey = { v: 1; k: string; e: string };

export function isPrivateMedia(uri: string): boolean {
  if (!uri.includes('/uploads/media/')) return false;
  try { const u = new URL(uri, apiBase()); return u.origin === new URL(apiBase()).origin && u.pathname.startsWith('/uploads/media/'); }
  catch { return false; }
}
export function parseMediaKey(uri: string): MediaKey | null {
  const i = uri.indexOf(MARKER);
  if (i < 0) return null;
  try {
    const value = JSON.parse(decodeURIComponent(uri.slice(i + MARKER.length))) as MediaKey;
    const key = fromBase64(value.k);
    if (value.v !== 1 || key?.length !== 32 || !/^[a-z0-9]{1,8}$/.test(value.e)) return null;
    return { v: 1, k: toBase64(key), e: value.e };
  } catch { return null; }
}
export function attachMediaKey(uri: string, key: MediaKey): string {
  if (!isPrivateMedia(uri) || !parseMediaKey(uri.split('#')[0] + MARKER + encodeURIComponent(JSON.stringify(key)))) throw new Error('invalid_encrypted_media');
  return uri.split('#')[0] + MARKER + encodeURIComponent(JSON.stringify(key));
}
export function mediaWireUrl(uri: string): string {
  if (uri.includes(MARKER) && !parseMediaKey(uri)) throw new Error('invalid_encrypted_media');
  return uri.split('#')[0];
}

const ready = new ExpiringLruCache<string, string>({
  maxEntries: 128, maxCost: 256 * 1024, ttlMs: 5 * 60 * 1000,
  cost: (value, key) => (value.length + key.length) * 2 + 128,
});
const requests = new MediaRequestQueue();
subscribeMemoryPressure(() => ready.clear());
export const protectedMediaCacheKey = (uri: string) => `${currentOwner() || ''}:${uri}`;
const cacheKey = protectedMediaCacheKey;
export function peekProtectedMedia(uri: string): string | undefined { return ready.get(cacheKey(uri)); }

/** Credentials are sent only to our HTTPS API, never to an external media URL. */
export async function resolveProtectedMedia(uri: string): Promise<string> {
  if (!isPrivateMedia(uri)) return uri;
  const FileSystem = await import('expo-file-system');
  const { getInstallAuthHeaders } = await import('./installId');
  const owner = currentOwner();
  if (!owner) throw new Error('unauthorized');
  const identityKey = cacheKey(uri);
  return requests.run(identityKey, async (isCurrent, onExpire) => {
    const cached = ready.get(identityKey);
    if (cached && (await FileSystem.getInfoAsync(cached)).exists) {
      if (currentOwner() !== owner || !isCurrent()) throw new Error('media_request_cancelled');
      return cached;
    }
    const key = parseMediaKey(uri);
    if (uri.includes(MARKER) && !key) throw new Error('invalid_encrypted_media');
    if (!FileSystem.cacheDirectory) throw new Error('media_cache_unavailable');
    const hash = Array.from(sha256(utf8Encode(identityKey))).map(v => v.toString(16).padStart(2, '0')).join('');
    const extension = new URL(uri, apiBase()).pathname.split('.').pop() || '';
    const localFile = FileSystem.cacheDirectory + 'private-' + hash + '.' + (key?.e || (/^[a-z0-9]{1,8}$/.test(extension) ? extension : 'media'));
    // Deterministic owner/key-specific disk files survive RAM eviction and avoid
    // repeatedly downloading/decrypting the same attachment after cache expiry.
    if ((await FileSystem.getInfoAsync(localFile)).exists) {
      if (currentOwner() !== owner || !isCurrent()) throw new Error('media_request_cancelled');
      ready.set(identityKey, localFile);
      return localFile;
    }
    const destination = localFile + '.download';
    let decrypted: string | undefined;
    try {
      const headers = await getInstallAuthHeaders();
      if (currentOwner() !== owner || !isCurrent()) throw new Error('media_request_cancelled');
      const download = FileSystem.createDownloadResumable(new URL(mediaWireUrl(uri), apiBase()).toString(), destination, { headers });
      onExpire(() => { void download.cancelAsync().catch(() => {}); });
      const result = await download.downloadAsync();
      if (!result) throw new Error('media_request_cancelled');
      if (result.status !== 200) throw new Error('media_access_denied');
      if (!isCurrent()) throw new Error('media_request_timeout');
      const resolved: string = key
        ? await NativeModules.LiviCrypto.decryptMedia(result.uri, key.k, key.e)
        : result.uri;
      if (key) decrypted = resolved;
      if (currentOwner() !== owner || !isCurrent()) {
        await FileSystem.deleteAsync(resolved, { idempotent: true }).catch(() => {});
        throw new Error(currentOwner() !== owner ? 'identity_changed' : 'media_request_timeout');
      }
      await FileSystem.moveAsync({ from: resolved, to: localFile });
      if (currentOwner() !== owner || !isCurrent()) {
        await FileSystem.deleteAsync(localFile, { idempotent: true }).catch(() => {});
        throw new Error('media_request_cancelled');
      }
      ready.set(identityKey, localFile);
      return localFile;
    } finally {
      await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
      if (decrypted) await FileSystem.deleteAsync(decrypted, { idempotent: true }).catch(() => {});
    }
  });
}

export async function encryptMediaForUpload(uri: string, type: 'image' | 'audio' | 'video'): Promise<{ uri: string; key: MediaKey }> {
  if (typeof NativeModules.LiviCrypto?.encryptMedia !== 'function') throw new Error('media_encryption_requires_update');
  const encrypted = await NativeModules.LiviCrypto.encryptMedia(uri) as { uri: string; key: string };
  const ext = uri.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
  const extension = ext && /^[a-z0-9]{1,8}$/.test(ext) ? ext : type === 'image' ? 'jpg' : type === 'audio' ? 'm4a' : 'mp4';
  return { uri: encrypted.uri, key: { v: 1, k: encrypted.key, e: extension } };
}
