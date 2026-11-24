import { ExpiringLruCache } from './expiringLruCache';
import { subscribeMemoryPressure } from './memoryPressure';
import { subscribeAvatarCacheInvalidation } from './avatarCacheInvalidation';

/** File locks are optional first-frame hints, scoped to the user and avatar version. */
export const searchAvatarFileByKey = new ExpiringLruCache<string, string>({
  maxEntries: 128, maxCost: 128 * 1024, ttlMs: 30 * 60 * 1000,
  cost: (value, key) => (value.length + key.length) * 2,
});

export function clearAvatarFileCache(userId?: string): void {
  if (userId === undefined) searchAvatarFileByKey.clear();
  else for (const key of searchAvatarFileByKey.keys()) {
    if (key.startsWith(`${userId}_v`)) searchAvatarFileByKey.delete(key);
  }
}
subscribeMemoryPressure(() => clearAvatarFileCache());
subscribeAvatarCacheInvalidation(clearAvatarFileCache);
