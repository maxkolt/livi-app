import Redis from 'ioredis';
import { logger } from './logger';

type Entry = { count: number; resetAt: number };
type RateLimitResult = { ok: boolean; retryAfterSec?: number };
type RateLimitFallbackMode = 'bounded_memory' | 'fail_closed';
type RateLimitOptions = {
  fallbackMode?: RateLimitFallbackMode;
  sensitive?: boolean;
};

const REDIS_URL = (process.env.REDIS_URL || process.env.REDIS_URI || '').trim();
const REDIS_RATE_LIMIT_ENABLED = String(process.env.REDIS_RATE_LIMIT || '1').trim() !== '0';
const RATE_LIMIT_PREFIX = 'livi:rateLimit:';
const REDIS_FALLBACK_LOG_INTERVAL_MS = 30_000;
const MEMORY_CLEANUP_INTERVAL_MS = Math.max(5_000, Number(process.env.RATE_LIMIT_MEMORY_CLEANUP_MS || 60_000));
const MEMORY_MAX_KEYS = Math.max(100, Number(process.env.RATE_LIMIT_MEMORY_MAX_KEYS || 20_000));
const SENSITIVE_FALLBACK_MODE: RateLimitFallbackMode =
  String(process.env.RATE_LIMIT_SENSITIVE_FALLBACK || '').trim() === 'fail_closed'
    ? 'fail_closed'
    : 'bounded_memory';

const redisRateLimitScript = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  return { current, tonumber(ARGV[1]) }
end

local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end

return { current, ttl }
`;

// Fallback for local dev or Redis outages. In multi-instance deployments this is not distributed,
// so Redis should be configured for sensitive endpoints such as uploads.
const memoryStore = new Map<string, Entry>();

let redisClient: Redis | null = null;
let lastRedisFallbackLogAt = 0;
let lastRedisFallbackReason = '';
let lastRedisFallbackAt = 0;
let redisFallbackCount = 0;
let failClosedCount = 0;

if (REDIS_URL && REDIS_RATE_LIMIT_ENABLED) {
  redisClient = new Redis(REDIS_URL, {
    lazyConnect: false,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    commandTimeout: 1000,
    retryStrategy(times) {
      return Math.min(times * 100, 3000);
    },
  });

  redisClient.on('connect', () => logger.info('[rateLimit:redis] connected'));
  redisClient.on('ready', () => logger.info('[rateLimit:redis] ready'));
  redisClient.on('error', (err) => {
    logger.warn('[rateLimit:redis] error', { message: err?.message ?? String(err) });
  });
} else if (!REDIS_URL) {
  logger.info('[rateLimit] using in-memory store (no REDIS_URL)');
} else {
  logger.info('[rateLimit] Redis disabled by env, using in-memory store');
}

const cleanupTimer = setInterval(() => {
  cleanupMemoryStore(Date.now());
}, MEMORY_CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

function cleanupMemoryStore(now = Date.now()) {
  for (const [key, entry] of memoryStore.entries()) {
    if (entry.resetAt <= now) memoryStore.delete(key);
  }

  if (memoryStore.size <= MEMORY_MAX_KEYS) return;

  const overflow = memoryStore.size - MEMORY_MAX_KEYS;
  const oldest = [...memoryStore.entries()]
    .sort((a, b) => a[1].resetAt - b[1].resetAt)
    .slice(0, overflow);
  for (const [key] of oldest) memoryStore.delete(key);

  logger.warn('[rateLimit] in-memory fallback store evicted old keys', {
    evicted: oldest.length,
    remaining: memoryStore.size,
    maxKeys: MEMORY_MAX_KEYS,
  });
}

function resolveFallbackMode(options?: RateLimitOptions): RateLimitFallbackMode {
  return options?.fallbackMode || (options?.sensitive ? SENSITIVE_FALLBACK_MODE : 'bounded_memory');
}

function logRedisFallback(reason: string, options?: RateLimitOptions) {
  redisFallbackCount += 1;
  lastRedisFallbackAt = Date.now();
  lastRedisFallbackReason = reason;
  const now = Date.now();
  if (now - lastRedisFallbackLogAt < REDIS_FALLBACK_LOG_INTERVAL_MS) return;
  lastRedisFallbackLogAt = now;
  logger.warn('[rateLimit] Redis unavailable for rate limit', {
    reason,
    fallbackMode: resolveFallbackMode(options),
    sensitive: !!options?.sensitive,
    memoryKeys: memoryStore.size,
    maxKeys: MEMORY_MAX_KEYS,
  });
}

function checkMemoryRateLimit(key: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  cleanupMemoryStore(now);
  const cur = memoryStore.get(key);
  if (!cur || cur.resetAt <= now) {
    memoryStore.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: max >= 1, retryAfterSec: max >= 1 ? undefined : Math.max(1, Math.ceil(windowMs / 1000)) };
  }

  cur.count += 1;
  if (cur.count <= max) return { ok: true };
  const retryAfterSec = Math.max(1, Math.ceil((cur.resetAt - now) / 1000));
  return { ok: false, retryAfterSec };
}

function checkFallbackRateLimit(key: string, max: number, windowMs: number, reason: string, options?: RateLimitOptions): RateLimitResult {
  logRedisFallback(reason, options);
  if (resolveFallbackMode(options) === 'fail_closed') {
    failClosedCount += 1;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(windowMs / 1000)) };
  }
  return checkMemoryRateLimit(key, max, windowMs);
}

export async function checkRateLimit(
  key: string,
  max: number,
  windowMs: number,
  options: RateLimitOptions = {}
): Promise<RateLimitResult> {
  const safeWindowMs = Math.max(1, Math.floor(windowMs));
  const safeMax = Math.floor(max);
  const redis = redisClient;

  if (!redis) {
    return checkMemoryRateLimit(key, safeMax, safeWindowMs);
  }

  if (redis.status !== 'ready') {
    return checkFallbackRateLimit(key, safeMax, safeWindowMs, `redis_${redis.status || 'not_ready'}`, options);
  }

  try {
    const redisKey = `${RATE_LIMIT_PREFIX}${key}`;
    const result = (await redis.eval(redisRateLimitScript, 1, redisKey, String(safeWindowMs))) as [number | string, number | string];
    const count = Number(result?.[0] ?? 0);
    const ttlMs = Number(result?.[1] ?? safeWindowMs);
    if (count <= safeMax) return { ok: true };
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(ttlMs / 1000)) };
  } catch (e: any) {
    return checkFallbackRateLimit(key, safeMax, safeWindowMs, e?.message || String(e), options);
  }
}

export function getRateLimitHealth() {
  return {
    redisConfigured: !!REDIS_URL && REDIS_RATE_LIMIT_ENABLED,
    redisStatus: redisClient?.status || 'disabled',
    sensitiveFallbackMode: SENSITIVE_FALLBACK_MODE,
    memoryKeys: memoryStore.size,
    memoryMaxKeys: MEMORY_MAX_KEYS,
    redisFallbackCount,
    failClosedCount,
    lastRedisFallbackAt,
    lastRedisFallbackReason,
  };
}

export async function close(): Promise<void> {
  clearInterval(cleanupTimer);
  if (!redisClient) return;
  const redis = redisClient;
  redisClient = null;
  await redis.quit();
  logger.info('[rateLimit:redis] connection closed');
}

