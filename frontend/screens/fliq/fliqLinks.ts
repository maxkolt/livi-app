// Ссылки на короткие ролики (YouTube, TikTok, Instagram): разбор из текста сообщения,
// адреса встраиваемых плееров и подписи для карточки (oEmbed, кэш в памяти и на диске).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ExpiringLruCache } from '../../utils/expiringLruCache';
import { MediaRequestQueue } from '../../utils/mediaRequestQueue';
import { subscribeMemoryPressure } from '../../utils/memoryPressure';

export type FliqSource = 'youtube' | 'tiktok' | 'instagram';

export type FliqLink = {
  source: FliqSource;
  /** YouTube — videoId; TikTok — числовой id (у короткой ссылки пусто до resolve); Instagram — shortcode. */
  id: string;
  /** Ссылка как в сообщении — её открываем в приложении источника. */
  url: string;
  /** Короткая ссылка TikTok (vm.tiktok.com/…): id известен только после редиректа. */
  short?: boolean;
  /** Instagram: reel или пост — от этого зависит адрес встраивания. */
  igKind?: 'reel' | 'p';
};

export type FliqMeta = { title?: string; author?: string; thumb?: string };

const URL_RE = /(https?:\/\/[^\s<>"\]]+|www\.[^\s<>"\]]+)/gi;
const YT_ID_RE = /^[\w-]{11}$/;

function stripTrailingPunct(url: string): string {
  return url.replace(/[)\].,!?;:'"»]+$/, '');
}

/**
 * Хост, путь и параметры ссылки. Без `URL`: в React Native у него не реализованы
 * hostname/pathname/searchParams (бросают «not implemented»).
 */
export function splitUrl(raw: string): { host: string; parts: string[]; query: Record<string, string> } | null {
  const m = /^(?:https?:\/\/)?([^/?#:\s]+)(?::\d+)?([^?#\s]*)(?:\?([^#\s]*))?/i.exec(String(raw || '').trim());
  if (!m) return null;
  const query: Record<string, string> = {};
  for (const pair of (m[3] || '').split('&')) {
    const eq = pair.indexOf('=');
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    if (!key) continue;
    try {
      query[decodeURIComponent(key)] = decodeURIComponent(eq >= 0 ? pair.slice(eq + 1) : '');
    } catch {}
  }
  return { host: m[1].toLowerCase(), parts: (m[2] || '').split('/').filter(Boolean), query };
}

export function parseFliqLink(raw: string): FliqLink | null {
  const cleaned = stripTrailingPunct(String(raw || '').trim());
  if (!cleaned) return null;
  const u = splitUrl(cleaned);
  if (!u) return null;
  const host = u.host.replace(/^(www\.|m\.)/, '');
  const parts = u.parts;

  if (host === 'youtu.be') {
    const id = parts[0] || '';
    return YT_ID_RE.test(id) ? { source: 'youtube', id, url: cleaned } : null;
  }
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    let id = '';
    if (parts[0] === 'shorts' || parts[0] === 'embed') id = parts[1] || '';
    else if (parts[0] === 'watch') id = u.query.v || '';
    return YT_ID_RE.test(id) ? { source: 'youtube', id, url: cleaned } : null;
  }
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') {
    return parts[0] ? { source: 'tiktok', id: '', url: cleaned, short: true } : null;
  }
  if (host === 'tiktok.com') {
    if (parts[0] === 't' && parts[1]) return { source: 'tiktok', id: '', url: cleaned, short: true };
    const videoIdx = parts.indexOf('video');
    const id = videoIdx >= 0 ? parts[videoIdx + 1] || '' : parts[0] === 'v' ? (parts[1] || '').replace(/\.html$/, '') : '';
    return /^\d{8,25}$/.test(id) ? { source: 'tiktok', id, url: cleaned } : null;
  }
  if (host === 'instagram.com') {
    const kind = parts[0];
    const code = parts[1] || '';
    if (!/^[\w-]{5,40}$/.test(code)) return null;
    if (kind === 'reel' || kind === 'reels') return { source: 'instagram', id: code, url: cleaned, igKind: 'reel' };
    if (kind === 'p' || kind === 'tv') return { source: 'instagram', id: code, url: cleaned, igKind: 'p' };
  }
  return null;
}

/** Первая поддерживаемая ссылка на ролик в тексте сообщения. */
export function findFliqLink(text: string): FliqLink | null {
  const matches = String(text || '').match(URL_RE) || [];
  for (const m of matches) {
    const link = parseFliqLink(m);
    if (link) return link;
  }
  return null;
}

/** В сообщении только ссылка (переслали из Fliq или «Поделиться») — текст под карточкой не нужен. */
export function isOnlyFliqLink(text: string, link: FliqLink): boolean {
  return String(text || '').trim() === link.url;
}

export function youtubeShareUrl(id: string): string {
  return `https://youtube.com/shorts/${id}`;
}

/**
 * Превью YouTube 4:3 с вертикальным кадром Shorts посередине: при contentFit="cover"
 * в вертикальной карточке видно ровно этот кадр.
 */
export function youtubeThumbUrl(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

export function fliqSourceLabel(source: FliqSource): string {
  return source === 'youtube' ? 'YouTube' : source === 'tiktok' ? 'TikTok' : 'Instagram';
}

/** Адрес встраиваемого плеера TikTok / Instagram (YouTube играет через IFrame API, см. FliqPlayer). */
export function fliqEmbedUrl(link: FliqLink): string {
  if (link.source === 'tiktok') {
    return `https://www.tiktok.com/player/v1/${link.id}?autoplay=1&loop=1&music_info=1&description=1&rel=0`;
  }
  if (link.source === 'instagram') {
    return `https://www.instagram.com/${link.igKind === 'p' ? 'p' : 'reel'}/${link.id}/embed/`;
  }
  return `https://www.youtube.com/embed/${link.id}`;
}

const RAM_TTL_MS = 30 * 60_000;
const RETRY_TTL_MS = 30_000;
const resolved = new ExpiringLruCache<string, { link: FliqLink | null; until: number }>({
  maxEntries: 128, maxCost: 128 * 1024, ttlMs: RAM_TTL_MS,
  cost: (value, key) => (key.length + (value.link?.url.length || 0) + (value.link?.id.length || 0)) * 2 + 32,
  expiresAt: value => value.until,
});
const redirects = new MediaRequestQueue<FliqLink | null>({
  concurrency: 2, maxPending: 8, maxCost: 64 * 1024, timeoutMs: 15_000,
});
let cacheGeneration = 0;

/** Короткая ссылка TikTok → полная (с id ролика): идём по редиректу. */
export async function resolveFliqLink(link: FliqLink): Promise<FliqLink | null> {
  if (!link.short) return link;
  const cached = resolved.get(link.url);
  if (cached) return cached.link;
  const generation = cacheGeneration;
  return redirects.run(link.url, async (current, onExpire) => {
    const controller = new AbortController();
    onExpire(() => controller.abort());
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(/^https?:\/\//i.test(link.url) ? link.url : `https://${link.url}`, {
        method: 'GET', signal: controller.signal,
      });
      if (!current() || controller.signal.aborted) return null;
      const full = parseFliqLink(res.url || '');
      const out = full && !full.short ? full : null;
      if (generation === cacheGeneration) {
        resolved.set(link.url, { link: out, until: Date.now() + (out ? RAM_TTL_MS : RETRY_TTL_MS) });
      }
      return out;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }, link.url.length * 2).catch(() => null);
}

const META_PREFIX = 'fliq_meta_v1:';
/** Подписанные ссылки на превью TikTok живут недолго — их кэш короче. */
const META_TTL_MS: Record<FliqSource, number> = {
  youtube: 7 * 86_400_000,
  tiktok: 12 * 3_600_000,
  instagram: 7 * 86_400_000,
};
type CachedMeta = { meta: FliqMeta; until: number };
const metaCost = (value: FliqMeta, key: string) =>
  (key.length + (value.title?.length || 0) + (value.author?.length || 0) + (value.thumb?.length || 0)) * 2 + 32;
const metaMemory = new ExpiringLruCache<string, CachedMeta>({
  maxEntries: 128, maxCost: 512 * 1024, ttlMs: RAM_TTL_MS,
  cost: (value, key) => metaCost(value.meta, key), expiresAt: value => value.until,
});
const metadata = new MediaRequestQueue<FliqMeta>({
  concurrency: 4, maxPending: 24, maxCost: 64 * 1024, timeoutMs: 15_000,
});
subscribeMemoryPressure(() => {
  cacheGeneration++;
  resolved.clear(); metaMemory.clear();
  // Keep bounded in-flight consumers: mounted cards can still use their result.
});

function metaKey(link: FliqLink): string {
  return `${link.source}:${link.id || link.url}`;
}

export function peekFliqMeta(link: FliqLink): FliqMeta | undefined {
  return metaMemory.get(metaKey(link))?.meta;
}

function normalizeMeta(value: FliqMeta): FliqMeta {
  return {
    ...(typeof value?.title === 'string' ? { title: value.title } : {}),
    ...(typeof value?.author === 'string' ? { author: value.author } : {}),
    ...(typeof value?.thumb === 'string' ? { thumb: value.thumb } : {}),
  };
}

type OEmbedMetadata = { title?: string; author_name?: string; thumbnail_url?: string };

async function fetchJson(url: string, controller: AbortController, timeoutMs: number): Promise<OEmbedMetadata | null> {
  if (controller.signal.aborted) return null;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || controller.signal.aborted) return null;
    const json = await res.json();
    return controller.signal.aborted ? null : json;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Название, автор и превью ролика для карточки в чате. Instagram без токена Meta
 * ничего не отдаёт — карточка показывается без превью.
 */
export function fetchFliqMeta(link: FliqLink): Promise<FliqMeta> {
  const key = metaKey(link);
  const cached = metaMemory.get(key);
  if (cached) return Promise.resolve(cached.meta);
  const generation = cacheGeneration;
  return metadata.run(key, async (current, onExpire) => {
    const controller = new AbortController();
    onExpire(() => controller.abort());
    try {
      const raw = await AsyncStorage.getItem(META_PREFIX + key);
      const saved = raw ? JSON.parse(raw) : null;
      if (!current()) return {};
      const at = Number(saved?.at || 0);
      const until = at + META_TTL_MS[link.source];
      if (saved?.meta && at > 0 && at <= Date.now() && until > Date.now()) {
        const meta = normalizeMeta(saved.meta);
        if (generation === cacheGeneration) {
          metaMemory.set(key, { meta, until: Math.min(until, Date.now() + RAM_TTL_MS) });
        }
        return meta;
      }
    } catch {}
    if (!current()) return {};

    let meta: FliqMeta = {};
    if (link.source === 'youtube') {
      const watch = encodeURIComponent(`https://www.youtube.com/watch?v=${link.id}`);
      const json = await fetchJson(`https://www.youtube.com/oembed?url=${watch}&format=json`, controller, 8000);
      meta = { title: json?.title, author: json?.author_name, thumb: youtubeThumbUrl(link.id) };
    } else if (link.source === 'tiktok') {
      const json = await fetchJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(link.url)}`, controller, 8000);
      meta = { title: json?.title, author: json?.author_name, thumb: json?.thumbnail_url };
    }
    meta = normalizeMeta(meta);
    if (!current() || controller.signal.aborted) return meta;
    if (generation === cacheGeneration) {
      metaMemory.set(key, { meta, until: Date.now() + (meta.title ? RAM_TTL_MS : RETRY_TTL_MS) });
    }
    if (meta.title && metaCost(meta, key) <= 512 * 1024) {
      AsyncStorage.setItem(META_PREFIX + key, JSON.stringify({ at: Date.now(), meta })).catch(() => {});
    }
    return meta;
  }, (key.length + link.url.length) * 2);
}
