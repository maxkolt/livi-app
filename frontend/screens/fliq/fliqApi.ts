// Запросы ленты Fliq к нашему API: выдача роликов, события просмотра (пачкой), «не играет».
import { API_BASE } from '../../sockets/modules/constants';
import { getCurrentUserId } from '../../sockets/modules/authState';
import { getInstallId } from '../../utils/installId';
import { Image as ExpoImage } from 'expo-image';
import { logger } from '../../utils/logger';
import { youtubeThumbUrl } from './fliqLinks';
import { useFliqTopics } from './fliqTopics';

export type FliqItem = {
  id: string;
  source: 'youtube';
  title: string;
  author: string;
  durationSec: number;
  topics: string[];
};

export type FliqEvent = {
  id: string;
  watchedMs: number;
  durationMs: number;
  shared?: boolean;
};

async function authHeaders(): Promise<Record<string, string>> {
  const installId = await getInstallId().catch(() => '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (installId) headers['x-install-id'] = String(installId);
  const userId = getCurrentUserId();
  if (userId) headers['x-user-id'] = String(userId);
  return headers;
}

async function request(path: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...(await authHeaders()), ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: json?.error || `http_${res.status}` };
    return json ?? { ok: false, error: 'bad_json' };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchFliqFeed(opts: {
  lang: string;
  topics: string[];
  exclude: string[];
  limit?: number;
}): Promise<{ ok: boolean; items: FliqItem[]; error?: string }> {
  const qs = [
    `lang=${encodeURIComponent(opts.lang)}`,
    `limit=${opts.limit ?? 10}`,
    opts.topics.length ? `topics=${encodeURIComponent(opts.topics.join(','))}` : '',
    opts.exclude.length ? `exclude=${encodeURIComponent(opts.exclude.slice(-80).join(','))}` : '',
  ]
    .filter(Boolean)
    .join('&');
  try {
    const json = await request(`/api/fliq/feed?${qs}`, { method: 'GET' }, 12_000);
    const items: FliqItem[] = Array.isArray(json?.items)
      ? json.items.filter((it: any) => it && typeof it.id === 'string')
      : [];
    return { ok: !!json?.ok, items, error: json?.error };
  } catch (e: any) {
    return { ok: false, items: [], error: e?.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

const pendingEvents: FliqEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Событие просмотра: копим и отправляем пачкой — не дёргаем сеть на каждый свайп. */
export function queueFliqEvent(ev: FliqEvent): void {
  pendingEvents.push(ev);
  if (pendingEvents.length >= 10) {
    void flushFliqEvents();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushFliqEvents();
    }, 15_000);
  }
}

export async function flushFliqEvents(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pendingEvents.length) return;
  const batch = pendingEvents.splice(0, 50);
  try {
    const json = await request('/api/fliq/events', { method: 'POST', body: JSON.stringify({ events: batch }) }, 10_000);
    if (!json?.ok) logger.warn('[fliq] events rejected', { error: json?.error, count: batch.length });
  } catch {
    // Нет сети — события не критичны, просто теряем пачку.
  }
}

export function reportFliqUnplayable(id: string, code: number): void {
  request('/api/fliq/unplayable', { method: 'POST', body: JSON.stringify({ id, code }) }, 10_000).catch(() => {});
}

type FeedCache = { key: string; items: FliqItem[]; at: number };
let feedCache: FeedCache | null = null;
let prefetchInflight: Promise<void> | null = null;
/** Заранее загруженная лента годится столько — потом пул на сервере уже другой. */
const FEED_CACHE_TTL_MS = 10 * 60_000;

function feedKey(lang: string, topics: string[]): string {
  return `${lang}|${[...topics].sort().join(',')}`;
}

/**
 * Первая страница ленты заранее (через несколько секунд после запуска приложения): вкладка
 * открывается сразу с роликами, без ожидания сети. Превью первых роликов — сразу в кэш картинок.
 * Пока человек не выбрал темы, не грузим: сначала он увидит выбор тем.
 */
export async function warmFliqFeed(lang: string): Promise<void> {
  const store = useFliqTopics.getState();
  await store.hydrate();
  const { onboarded, topics } = useFliqTopics.getState();
  if (!onboarded) return;
  const key = feedKey(lang, topics);
  if (feedCache && feedCache.key === key && Date.now() - feedCache.at < FEED_CACHE_TTL_MS) return;
  if (prefetchInflight) return prefetchInflight;
  prefetchInflight = (async () => {
    const res = await fetchFliqFeed({ lang, topics, exclude: [], limit: 10 });
    if (!res.ok || !res.items.length) return;
    feedCache = { key, items: res.items, at: Date.now() };
    ExpoImage.prefetch(res.items.slice(0, 3).map((it) => youtubeThumbUrl(it.id)), 'memory-disk').catch(() => {});
  })().finally(() => {
    prefetchInflight = null;
  });
  return prefetchInflight;
}

/** Забрать заранее загруженную ленту (один раз): дальше лента живёт своей жизнью. */
export async function takeWarmFliqFeed(lang: string, topics: string[]): Promise<FliqItem[] | null> {
  // Ранняя загрузка ещё в пути — дождаться её, а не слать второй такой же запрос.
  if (prefetchInflight) await prefetchInflight.catch(() => {});
  const c = feedCache;
  feedCache = null;
  if (!c || c.key !== feedKey(lang, topics) || Date.now() - c.at >= FEED_CACHE_TTL_MS) return null;
  return c.items;
}
