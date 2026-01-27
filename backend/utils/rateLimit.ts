type Entry = { count: number; resetAt: number };

// In-memory rate limiter (single-process).
// Good enough to reduce abuse; for multi-instance deployments use Redis.
const store = new Map<string, Entry>();

export function checkRateLimit(key: string, max: number, windowMs: number): { ok: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const cur = store.get(key);
  if (!cur || cur.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }

  cur.count += 1;
  if (cur.count <= max) return { ok: true };
  const retryAfterSec = Math.max(1, Math.ceil((cur.resetAt - now) / 1000));
  return { ok: false, retryAfterSec };
}

