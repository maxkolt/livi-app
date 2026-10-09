// utils/fliqCollector.ts
// Сборщик ленты Fliq: по расписанию ищет YouTube Shorts по темам и языкам через
// YouTube Data API и складывает подходящие ролики в fliq_videos.
//
// Квота API по умолчанию — 10 000 единиц в сутки; поиск стоит до 100 единиц, детали
// роликов — 1. Поэтому поисков в сутки не больше FLIQ_DAILY_SEARCH_BUDGET (90), а пары
// «тема × язык» идут по очереди: самая давно не обновлявшаяся — первой.
import mongoose from 'mongoose';
import FliqVideo from '../models/FliqVideo';
import FliqCollectState from '../models/FliqCollectState';
import { logger } from './logger';

const API_KEY = String(process.env.YOUTUBE_API_KEY || '').trim();
const INTERVAL_MIN = Math.max(5, Number(process.env.FLIQ_COLLECT_INTERVAL_MIN || 60));
const SEARCHES_PER_RUN = Math.max(1, Number(process.env.FLIQ_SEARCHES_PER_RUN || 4));
const DAILY_SEARCH_BUDGET = Math.max(1, Number(process.env.FLIQ_DAILY_SEARCH_BUDGET || 90));
/** Пока ролик в языке меньше этого — за прогон ищем больше, чтобы лента быстрее наполнилась. */
const WARM_POOL_SIZE = 300;
const WARM_SEARCHES_PER_RUN = 12;

export const FLIQ_TOPICS = [
  'humor',
  'animals',
  'music',
  'sport',
  'games',
  'food',
  'science',
  'travel',
  'cars',
  'art',
  'technology',
  'politics',
  'history',
  'fishing',
  'hunting',
  'fitness',
  'fashion',
  'movies',
  'business',
  'nature',
] as const;
export type FliqTopic = (typeof FLIQ_TOPICS)[number];

/** Языковые корзины ленты. Остальные языки приложения смотрят английскую. */
export const FLIQ_LANGS: string[] = String(process.env.FLIQ_LANGS || 'ru,en')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function fliqLangBucket(lang: string): string {
  const base = String(lang || '').trim().toLowerCase().split(/[-_]/)[0] || 'en';
  if (FLIQ_LANGS.includes(base)) return base;
  return FLIQ_LANGS.includes('en') ? 'en' : FLIQ_LANGS[0] || 'en';
}

const QUERIES: Record<string, Record<FliqTopic, string[]>> = {
  ru: {
    humor: ['приколы', 'смешные видео', 'юмор скетч'],
    animals: ['котики', 'смешные животные', 'собаки'],
    music: ['кавер на гитаре', 'вокал', 'битбокс'],
    sport: ['футбол голы', 'спорт моменты', 'паркур трюки'],
    games: ['майнкрафт', 'игровые моменты', 'гейминг'],
    food: ['быстрый рецепт', 'готовим вкусно', 'выпечка'],
    science: ['научный эксперимент', 'интересные факты', 'опыты физика'],
    travel: ['путешествия', 'красивые места', 'природа'],
    cars: ['машины', 'тюнинг авто', 'дрифт'],
    art: ['рисование', 'своими руками', 'лайфхаки'],
    technology: ['технологии гаджеты', 'нейросети', 'обзор смартфона'],
    politics: ['новости политики', 'мировая политика', 'политический разбор'],
    history: ['история факты', 'исторические события', 'археология'],
    fishing: ['рыбалка', 'советы для рыбалки', 'большой улов'],
    hunting: ['охота', 'советы охотнику', 'охота в дикой природе'],
    fitness: ['фитнес тренировка', 'упражнения дома', 'воркаут'],
    fashion: ['мода и стиль', 'образы одежда', 'модные тренды'],
    movies: ['кино и фильмы', 'разбор фильма', 'сериалы'],
    business: ['бизнес идеи', 'финансы просто', 'предпринимательство'],
    nature: ['дикая природа', 'удивительная природа', 'животный мир'],
  },
  en: {
    humor: ['funny', 'comedy skit', 'try not to laugh'],
    animals: ['cute cats', 'funny animals', 'dogs'],
    music: ['guitar cover', 'singing', 'beatbox'],
    sport: ['football skills', 'sports highlights', 'parkour'],
    games: ['minecraft', 'gaming moments', 'fortnite'],
    food: ['easy recipe', 'cooking', 'street food'],
    science: ['science experiment', 'fun facts', 'physics'],
    travel: ['travel', 'beautiful places', 'nature'],
    cars: ['cars', 'supercars', 'drift'],
    art: ['drawing', 'diy', 'satisfying art'],
    technology: ['technology gadgets', 'artificial intelligence', 'smartphone review'],
    politics: ['political news', 'world politics', 'politics explained'],
    history: ['history facts', 'historical events', 'archaeology'],
    fishing: ['fishing', 'fishing tips', 'big catch'],
    hunting: ['hunting', 'hunting tips', 'wilderness hunting'],
    fitness: ['fitness workout', 'home exercises', 'calisthenics'],
    fashion: ['fashion style', 'outfit ideas', 'fashion trends'],
    movies: ['movies', 'film explained', 'tv series'],
    business: ['business ideas', 'finance explained', 'entrepreneurship'],
    nature: ['wild nature', 'amazing nature', 'wildlife'],
  },
};

/** Порядок выдачи поиска и окно свежести: так одна пара тем даёт разные ролики. */
const ORDERS: Array<{ order: string; days: number }> = [
  { order: 'relevance', days: 90 },
  { order: 'viewCount', days: 30 },
  { order: 'date', days: 7 },
];

type CollectStatus = {
  enabled: boolean;
  pausedUntil: number;
  day: string;
  searchesToday: number;
  lastRunAt: number;
  lastError: string;
};

const status: CollectStatus = {
  enabled: !!API_KEY,
  pausedUntil: 0,
  day: '',
  searchesToday: 0,
  lastRunAt: 0,
  lastError: '',
};

export function fliqCollectorStatus() {
  return { ...status, langs: FLIQ_LANGS, intervalMin: INTERVAL_MIN, dailyBudget: DAILY_SEARCH_BUDGET };
}

/** Сутки квоты YouTube: она сбрасывается в полночь по тихоокеанскому времени, а не по UTC. */
export function quotaDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
}

/** Списать один поиск из суточного бюджета. Счётчик в базе: перезапуск сервера его не обнуляет. */
async function takeSearchBudget(): Promise<boolean> {
  const day = quotaDay();
  const doc: any = await FliqCollectState.findOneAndUpdate(
    { key: `budget:${day}` },
    { $inc: { variant: 1 }, $set: { lastRunAt: new Date() } },
    { upsert: true, new: true }
  ).lean();
  const used = Number(doc?.variant || 0);
  status.day = day;
  status.searchesToday = used;
  return used <= DAILY_SEARCH_BUDGET;
}

class QuotaError extends Error {}

async function ytGet(path: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ ...params, key: API_KEY });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${qs.toString()}`, {
      signal: controller.signal,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = String(json?.error?.errors?.[0]?.reason || json?.error?.status || res.status);
      if (res.status === 403 && /quota|rateLimit|dailyLimit/i.test(reason)) throw new QuotaError(reason);
      throw new Error(`youtube_${path}_${res.status}_${reason}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** ISO 8601 (PT1M5S) → секунды. */
export function parseIsoDuration(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(iso || ''));
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(min || 0) * 60 + Number(s || 0);
}

/** Ранг: популярность (log просмотров) + бонус свежести. */
export function fliqScore(views: number, publishedAt: Date | null): number {
  const pop = Math.log10(Math.max(0, views) + 1);
  const ageDays = publishedAt ? (Date.now() - publishedAt.getTime()) / 86_400_000 : 365;
  const fresh = ageDays < 7 ? 1 : ageDays < 30 ? 0.5 : 0;
  return Math.round((pop + fresh) * 1000) / 1000;
}

/**
 * Подходит ли ролик для ленты: встраивается, публичный, не «для детей», без возрастного
 * ограничения, 5–180 с и вертикальный. Вертикальность — по размерам встроенного плеера
 * (API отдаёт их, когда в запросе есть maxWidth); если они неизвестны — только короткий
 * ролик с #shorts в названии.
 */
export function isFliqEligible(v: any): boolean {
  const st = v?.status || {};
  if (st.embeddable !== true || st.privacyStatus !== 'public' || st.madeForKids === true) return false;
  if (v?.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted') return false;
  if (String(v?.snippet?.liveBroadcastContent || 'none') !== 'none') return false;
  const dur = parseIsoDuration(v?.contentDetails?.duration);
  if (dur < 5 || dur > 180) return false;
  const w = Number(v?.player?.embedWidth || 0);
  const h = Number(v?.player?.embedHeight || 0);
  if (w > 0 && h > 0) return h > w;
  return dur <= 60 && /#shorts/i.test(String(v?.snippet?.title || ''));
}

async function collectPair(topic: FliqTopic, lang: string, variant: number): Promise<number> {
  const queries = (QUERIES[lang] || QUERIES.en)[topic];
  const query = queries[variant % queries.length];
  const { order, days } = ORDERS[Math.floor(variant / queries.length) % ORDERS.length];
  const publishedAfter = new Date(Date.now() - days * 86_400_000).toISOString();

  const params: Record<string, string> = {
    part: 'snippet',
    type: 'video',
    q: `${query} #shorts`,
    videoDuration: 'short',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    safeSearch: 'strict',
    maxResults: '50',
    order,
    publishedAfter,
    relevanceLanguage: lang,
  };
  const search = await ytGet('search', params);
  const ids: string[] = (Array.isArray(search?.items) ? search.items : [])
    .map((it: any) => String(it?.id?.videoId || ''))
    .filter((id: string) => /^[\w-]{11}$/.test(id));
  if (!ids.length) return 0;

  const details = await ytGet('videos', {
    part: 'snippet,contentDetails,status,statistics,player',
    id: ids.join(','),
    maxWidth: '480',
  });
  const now = new Date();
  let saved = 0;
  for (const v of Array.isArray(details?.items) ? details.items : []) {
    if (!isFliqEligible(v)) continue;
    const videoId = String(v.id);
    const views = Number(v?.statistics?.viewCount || 0);
    const publishedAt = v?.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null;
    await FliqVideo.updateOne(
      { videoId },
      {
        $set: {
          source: 'youtube',
          title: String(v?.snippet?.title || '').slice(0, 200),
          channelTitle: String(v?.snippet?.channelTitle || '').slice(0, 100),
          channelId: String(v?.snippet?.channelId || ''),
          durationSec: parseIsoDuration(v?.contentDetails?.duration),
          views,
          publishedAt,
          score: fliqScore(views, publishedAt),
          fetchedAt: now,
        },
        $addToSet: { langs: lang, topics: topic },
        $setOnInsert: { dead: false },
      },
      { upsert: true }
    );
    saved += 1;
  }
  return saved;
}

let running = false;
let indexesSynced = false;

async function runOnce(): Promise<void> {
  if (running || !API_KEY) return;
  if (mongoose.connection.readyState !== 1) return;
  if (Date.now() < status.pausedUntil) return;
  running = true;
  status.lastRunAt = Date.now();
  try {
    if (!indexesSynced) {
      // Индексы как в схеме: лишние (старый составной по двум массивам) удаляются.
      await FliqVideo.syncIndexes();
      indexesSynced = true;
    }
    // Молодой пул языка — ищем больше за прогон, пока лента не наполнится.
    let budget = SEARCHES_PER_RUN;
    for (const lang of FLIQ_LANGS) {
      const count = await FliqVideo.countDocuments({ langs: lang, dead: { $ne: true } });
      if (count < WARM_POOL_SIZE) budget = Math.max(budget, WARM_SEARCHES_PER_RUN);
    }

    const pairs = FLIQ_LANGS.flatMap((lang) => FLIQ_TOPICS.map((topic) => ({ lang, topic, key: `${lang}:${topic}` })));
    const states: any[] = await FliqCollectState.find({ key: { $in: pairs.map((p) => p.key) } }).lean();
    const byKey = new Map(states.map((s) => [String(s.key), s]));
    pairs.sort((a, b) => {
      const ta = new Date(byKey.get(a.key)?.lastRunAt || 0).getTime();
      const tb = new Date(byKey.get(b.key)?.lastRunAt || 0).getTime();
      return ta - tb;
    });

    for (const pair of pairs.slice(0, budget)) {
      if (!(await takeSearchBudget())) break;
      const variant = Number(byKey.get(pair.key)?.variant || 0);
      let found = 0;
      try {
        found = await collectPair(pair.topic, pair.lang, variant);
      } catch (e: any) {
        if (e instanceof QuotaError) throw e;
        status.lastError = String(e?.message || e);
        logger.warn('[fliq] collect pair failed', { key: pair.key, error: status.lastError });
      }
      await FliqCollectState.updateOne(
        { key: pair.key },
        { $set: { lastRunAt: new Date(), lastFound: found }, $inc: { variant: 1 } },
        { upsert: true }
      );
      logger.info('[fliq] collected', { key: pair.key, variant, found });
    }
  } catch (e: any) {
    status.lastError = String(e?.message || e);
    if (e instanceof QuotaError) {
      // Квота кончилась — до её сброса (полночь по Тихоокеанскому времени) не стучимся.
      status.pausedUntil = Date.now() + 6 * 60 * 60_000;
      logger.warn('[fliq] YouTube quota exhausted, pausing collector', { reason: status.lastError });
    } else {
      logger.warn('[fliq] collector run failed', { error: status.lastError });
    }
  } finally {
    running = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startFliqCollector(): void {
  if (timer) return;
  if (!API_KEY) {
    logger.info('[fliq] YOUTUBE_API_KEY is not set — Fliq collector disabled');
    return;
  }
  logger.info('[fliq] collector started', { langs: FLIQ_LANGS, intervalMin: INTERVAL_MIN });
  const first = setTimeout(() => void runOnce(), 20_000);
  first.unref?.();
  timer = setInterval(() => void runOnce(), INTERVAL_MIN * 60_000);
  timer.unref?.();
}

export function stopFliqCollector(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
