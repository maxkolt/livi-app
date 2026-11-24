// utils/imageOptimization.ts
import { Image as ExpoImage, type ImageRef } from 'expo-image';
import { Platform } from 'react-native';
import { logger } from './logger';
import { resolveDataUriForAndroid } from './dataUriToFileUri';
import { subscribeMemoryPressure } from './memoryPressure';
import { ExpiringLruCache } from './expiringLruCache';
import { MediaRequestQueue } from './mediaRequestQueue';
import { subscribeAvatarCacheInvalidation } from './avatarCacheInvalidation';

// Keep decoded, content-addressed avatar files available for a newly mounted row.
// A raw picker file may be overwritten, so only our full-hash filenames are reusable.
const decodedAvatars = new ExpiringLruCache<string, { image: ImageRef; pixels: number }>({
  maxEntries: 48, maxCost: 4 * 1024 * 1024, ttlMs: 5 * 60 * 1000, cost: value => value.pixels,
});
const warmups = new MediaRequestQueue<void>({
  concurrency: 2, maxPending: 32, maxCost: 8 * 1024 * 1024, timeoutMs: 15000,
});
const localWarmups = new Map<string, Promise<void>>();
let cacheGeneration = 0;
export function clearImageWarmupMemory(): void {
  cacheGeneration++;
  warmups.clear();
  decodedAvatars.clear();
}
subscribeAvatarCacheInvalidation(userId => { if (userId === undefined) clearImageWarmupMemory(); });
subscribeMemoryPressure(() => {
  clearImageWarmupMemory();
  // Keep disk files and visible image references. Only evict reconstructible RAM caches.
  void ExpoImage.clearMemoryCache().catch(() => {});
});

function isImmutableAvatarFile(uri: string): boolean {
  return /^file:.*\/glide_data_uri_avatar_[a-f0-9]{64}\.(?:jpg|png)$/i.test(uri);
}

function rememberDecodedAvatar(uri: string, image: ImageRef): void {
  if (!isImmutableAvatarFile(uri)) return;
  const scale = image.scale || 1;
  const pixels = image.width * image.height * scale * scale;
  if (!Number.isFinite(pixels) || pixels <= 0) return;
  decodedAvatars.set(uri, { image, pixels });
}

/**
 * Специальные настройки для аватаров на Android
 * Максимально оптимизированы против мерцания.
 * На Android используем разрешённый file: URI, чтобы видимый аватар и его
 * предзагрузка ссылались на один файл. Вызывающий код использует useResolvedImageUri.
 */
export const getAvatarImageProps = (uri: string, key: string, options: { useDecodedSource?: boolean } = {}) => {
  const safeUri = Platform.OS === 'android' && /^data:/i.test(uri) ? '' : uri;
  return {
    source: (options.useDecodedSource !== false && decodedAvatars.get(safeUri)?.image) || { uri: safeUri },
    contentFit: 'cover' as const,
    cachePolicy: 'memory-disk' as const,
    transition: 0,
    recyclingKey: key,
    allowDownscaling: false,
    placeholder: null,
    priority: 'high' as const,
    ...(Platform.OS === 'android' && {
      blurRadius: 0,
      tintColor: undefined,
    }),
  };
};

/** Match the exact thumbnail URI passed to friend/chat rows before warming a full-photo fallback. */
export function selectFriendAvatarWarmSources(
  friends: ReadonlyArray<{ avatarThumbB64?: string; avatar?: string }>,
): string[] {
  return [...new Set(friends.map(friend => friend.avatarThumbB64 || friend.avatar || '').filter(Boolean))];
}

/**
 * Expo's Android prefetch wraps every string in GlideUrl, which accepts HTTP(S)
 * only. Local images must go through loadAsync's normal source-model selection.
 * Decode content-addressed avatars once and keep bounded native references so
 * the first frame of another list can use the already decoded bitmap.
 */
async function warmImage(uri: string, diskOnly: boolean, isCurrent: () => boolean): Promise<void> {
  const source = uri.trim();
  if (!source) return;
  if (/^https?:\/\//i.test(source)) {
    await ExpoImage.prefetch(source, diskOnly ? 'disk' : 'memory-disk');
    return;
  }
  // Local/protected files are already on disk. Decoding a full photo here only
  // allocates a bitmap which the visible, downscaled image will replace.
  if (diskOnly) return;
  const resolved = await resolveDataUriForAndroid(source);
  if (!isCurrent()) return;
  const localScheme = Platform.OS === 'android'
    ? /^(?:file:|data:|content:|android\.resource:|res:)/i
    : /^(?:file:|data:|content:|asset:|ph:|assets-library:|android\.resource:|res:)/i;
  if (!localScheme.test(resolved)) return;
  if (decodedAvatars.get(resolved)) return;
  const pending = localWarmups.get(resolved);
  if (pending) return pending;
  const load = ExpoImage.loadAsync({ uri: resolved }, { maxWidth: 1024, maxHeight: 1024 })
    .then(image => { if (isCurrent()) rememberDecodedAvatar(resolved, image); })
    .finally(() => localWarmups.delete(resolved));
  localWarmups.set(resolved, load);
  return load;
}

function queueWarmup(uri: string, mode: 'memory' | 'disk' | 'resolve'): Promise<void> {
  const generation = cacheGeneration;
  // Count both source and prefixed key conservatively. Admission happens before
  // allocating a key; a full optional queue must not scan/hash a whole friends list.
  const cost = (uri.length * 2 + mode.length + 1) * 2;
  if (!warmups.hasCapacity(cost)) return Promise.resolve();
  const key = `${mode}:${uri}`;
  return warmups.run(key, async current => {
    const isCurrent = () => current() && generation === cacheGeneration;
    if (!isCurrent()) return;
    if (mode === 'resolve') {
      await resolveDataUriForAndroid(uri);
      return;
    }
    const { isPrivateMedia, resolveProtectedMedia } = await import('./protectedMedia');
    if (!isCurrent()) return;
    const source = isPrivateMedia(uri) ? await resolveProtectedMedia(uri) : uri;
    if (isCurrent()) await warmImage(source, mode === 'disk', isCurrent);
  }, cost).catch(error => {
    if (!/^media_(?:queue_full|request_(?:timeout|busy|cleared))$/.test(String(error?.message))) {
      logger.warn('Image warmup failed:', error);
    }
  });
}

/** Optional first-frame acceleration. Visible images still resolve normally if this queue is full. */
export function warmAndroidAvatarFile(uri: string): void {
  if (Platform.OS === 'android' && /^data:/i.test(uri)) void queueWarmup(uri, 'resolve');
}

export const prefetchImages = (urls: string[], options: { diskOnly?: boolean } = {}): Promise<void> => {
  const pending: Promise<void>[] = [];
  for (const input of urls) {
    const uri = input.trim();
    if (uri) pending.push(queueWarmup(uri, options.diskOnly ? 'disk' : 'memory'));
  }
  return Promise.all(pending).then(() => {});
};

/**
 * Принудительное обновление изображения (для Android)
 */
export const forceImageRefresh = async () => {
  if (Platform.OS === 'android') {
    try {
      // Очищаем кэш памяти и диска
      clearImageWarmupMemory();
      await ExpoImage.clearMemoryCache();
      await ExpoImage.clearDiskCache();
    } catch (error) {
      console.warn('[ImageOptimization] Force refresh failed:', error);
    }
  }
};
