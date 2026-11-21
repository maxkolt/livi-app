import { sha256 } from '@noble/hashes/sha2';
import { fromBase64, toBase64, utf8Encode } from '../sockets/modules/e2eCrypto';

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

const ready = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
export const protectedMediaCacheKey = (uri: string) => `${currentOwner() || ''}:${uri}`;
const cacheKey = protectedMediaCacheKey;
export function peekProtectedMedia(uri: string): string | undefined { return ready.get(cacheKey(uri)); }

/** Credentials are sent only to our HTTPS API, never to an external media URL. */
export async function resolveProtectedMedia(uri: string): Promise<string> {
  if (!isPrivateMedia(uri)) return uri;
  const FileSystem = await import('expo-file-system');
  const { NativeModules } = await import('react-native');
  const { getInstallAuthHeaders } = await import('./installId');
  const owner = currentOwner();
  if (!owner) throw new Error('unauthorized');
  const identityKey = cacheKey(uri);
  if (pending.has(identityKey)) return pending.get(identityKey)!;
  const task = (async () => {
    const cached = ready.get(identityKey);
    if (cached && (await FileSystem.getInfoAsync(cached)).exists) return cached;
    const key = parseMediaKey(uri);
    if (uri.includes(MARKER) && !key) throw new Error('invalid_encrypted_media');
    if (!FileSystem.cacheDirectory) throw new Error('media_cache_unavailable');
    const hash = Array.from(sha256(utf8Encode(identityKey))).map(v => v.toString(16).padStart(2, '0')).join('');
    const extension = new URL(uri, apiBase()).pathname.split('.').pop() || '';
    const destination = FileSystem.cacheDirectory + 'private-' + hash + (key ? '.livi' : /^[a-z0-9]{1,8}$/.test(extension) ? '.' + extension : '.media');
    try {
      const headers = await getInstallAuthHeaders();
      const result = await FileSystem.downloadAsync(new URL(mediaWireUrl(uri), apiBase()).toString(), destination, { headers });
      if (result.status !== 200) throw new Error('media_access_denied');
      const resolved: string = key
        ? await NativeModules.LiviCrypto.decryptMedia(result.uri, key.k, key.e)
        : result.uri;
      if (currentOwner() !== owner) {
        await FileSystem.deleteAsync(resolved, { idempotent: true }).catch(() => {});
        throw new Error('identity_changed');
      }
      ready.set(identityKey, resolved);
      return resolved;
    } finally { if (key) await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {}); }
  })().finally(() => pending.delete(identityKey));
  pending.set(identityKey, task);
  return task;
}

export async function encryptMediaForUpload(uri: string, type: 'image' | 'audio' | 'video'): Promise<{ uri: string; key: MediaKey }> {
  const { NativeModules } = await import('react-native');
  if (typeof NativeModules.LiviCrypto?.encryptMedia !== 'function') throw new Error('media_encryption_requires_update');
  const encrypted = await NativeModules.LiviCrypto.encryptMedia(uri) as { uri: string; key: string };
  const ext = uri.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
  const extension = ext && /^[a-z0-9]{1,8}$/.test(ext) ? ext : type === 'image' ? 'jpg' : type === 'audio' ? 'm4a' : 'mp4';
  return { uri: encrypted.uri, key: { v: 1, k: encrypted.key, e: extension } };
}
