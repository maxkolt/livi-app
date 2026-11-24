type Listener = (userId?: string) => void;
const listeners = new Set<Listener>();

export function subscribeAvatarCacheInvalidation(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function invalidateAvatarCaches(userId?: string): void {
  for (const listener of listeners) {
    try { listener(userId); } catch { /* Continue clearing the other optional caches. */ }
  }
}
