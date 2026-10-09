// Ссылки на короткие ролики (YouTube, TikTok, Instagram): разбор из текста сообщения,
// адреса встраиваемых плееров и подписи для карточки (oEmbed, кэш в памяти и на диске).
import AsyncStorage from '@react-native-async-storage/async-storage';

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

const resolved = new Map<string, FliqLink | null>();

/** Короткая ссылка TikTok → полная (с id ролика): идём по редиректу. */
export async function resolveFliqLink(link: FliqLink): Promise<FliqLink | null> {
  if (!link.short) return link;
  if (resolved.has(link.url)) return resolved.get(link.url) ?? null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(/^https?:\/\//i.test(link.url) ? link.url : `https://${link.url}`, {
      method: 'GET',
      signal: controller.signal,
    });
    const full = parseFliqLink(res.url || '');
    const out = full && !full.short ? full : null;
    resolved.set(link.url, out);
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const META_PREFIX = 'fliq_meta_v1:';
/** Подписанные ссылки на превью TikTok живут недолго — их кэш короче. */
const META_TTL_MS: Record<FliqSource, number> = {
  youtube: 7 * 86_400_000,
  tiktok: 12 * 3_600_000,
  instagram: 7 * 86_400_000,
};
const metaMemory = new Map<string, FliqMeta>();
const metaInflight = new Map<string, Promise<FliqMeta>>();

function metaKey(link: FliqLink): string {
  return `${link.source}:${link.id || link.url}`;
}

export function peekFliqMeta(link: FliqLink): FliqMeta | undefined {
  return metaMemory.get(metaKey(link));
}

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
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
  if (cached) return Promise.resolve(cached);
  const inflight = metaInflight.get(key);
  if (inflight) return inflight;

  const run = (async (): Promise<FliqMeta> => {
    try {
      const raw = await AsyncStorage.getItem(META_PREFIX + key);
      const saved = raw ? JSON.parse(raw) : null;
      if (saved?.meta && Date.now() - Number(saved.at || 0) < META_TTL_MS[link.source]) {
        metaMemory.set(key, saved.meta);
        return saved.meta as FliqMeta;
      }
    } catch {}

    let meta: FliqMeta = {};
    if (link.source === 'youtube') {
      const watch = encodeURIComponent(`https://www.youtube.com/watch?v=${link.id}`);
      const json = await fetchJson(`https://www.youtube.com/oembed?url=${watch}&format=json`, 8000);
      meta = { title: json?.title, author: json?.author_name, thumb: youtubeThumbUrl(link.id) };
    } else if (link.source === 'tiktok') {
      const json = await fetchJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(link.url)}`, 8000);
      meta = { title: json?.title, author: json?.author_name, thumb: json?.thumbnail_url };
    }
    metaMemory.set(key, meta);
    if (meta.title) {
      AsyncStorage.setItem(META_PREFIX + key, JSON.stringify({ at: Date.now(), meta })).catch(() => {});
    }
    return meta;
  })().finally(() => metaInflight.delete(key));
  metaInflight.set(key, run);
  return run;
}
