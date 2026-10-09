// routes/fliq.ts
// Лента Fliq: выдача роликов, события просмотра (досмотры/пролистывания → веса тем),
// пометка роликов, которые не играют во встроенном плеере.
import { Router } from 'express';
import mongoose from 'mongoose';
import FliqVideo from '../models/FliqVideo';
import FliqUserState from '../models/FliqUserState';
import { checkRateLimit } from '../utils/rateLimit';
import { logger } from '../utils/logger';
import { FLIQ_TOPICS, fliqCollectorStatus, fliqLangBucket } from '../utils/fliqCollector';

const router = Router();

const VIDEO_ID_RE = /^[\w-]{11}$/;
const SEEN_KEEP = 2000;
const WEIGHT_MIN = 0.2;
const WEIGHT_MAX = 5;
/** Ошибки IFrame-плеера, при которых ролик не встроится никогда (100 — удалён, 101/150 — запрет встраивания). */
const DEAD_ERROR_CODES = new Set([100, 101, 150]);

type FeedVideo = {
  videoId: string;
  title: string;
  channelTitle: string;
  durationSec: number;
  topics: string[];
  score: number;
  channelId: string;
};

function parseTopics(raw: unknown): string[] {
  const known = new Set<string>(FLIQ_TOPICS);
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => known.has(s));
}

function parseIds(raw: unknown, max: number): string[] {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => VIDEO_ID_RE.test(s))
    .slice(0, max);
}

/**
 * Взвешенная случайная выборка без повторов (ключ u^(1/w)): чаще берём популярные
 * ролики любимых тем, но лента не застывает. Потом разводим подряд идущие ролики
 * одного канала.
 */
export function pickFliqItems(
  candidates: FeedVideo[],
  limit: number,
  weights: Record<string, number>,
  selected: string[]
): FeedVideo[] {
  if (!candidates.length) return [];
  const maxScore = Math.max(...candidates.map((c) => c.score || 0), 1);
  const selectedSet = new Set(selected);
  const keyed = candidates.map((c) => {
    const topicW = Math.max(
      ...c.topics.filter((t) => !selectedSet.size || selectedSet.has(t)).map((t) => Number(weights[t] ?? 1)),
      0.5
    );
    const w = Math.max(0.05, topicW * (0.4 + (c.score || 0) / maxScore));
    return { c, key: Math.pow(Math.random(), 1 / w) };
  });
  keyed.sort((a, b) => b.key - a.key);
  const top = keyed.slice(0, Math.min(keyed.length, limit * 2)).map((k) => k.c);

  const out: FeedVideo[] = [];
  const rest = [...top];
  while (out.length < limit && rest.length) {
    const prevChannel = out.length ? out[out.length - 1].channelId : '';
    const idx = rest.findIndex((c) => !prevChannel || c.channelId !== prevChannel);
    out.push(rest.splice(idx === -1 ? 0 : idx, 1)[0]);
  }
  return out;
}

router.get('/fliq/feed', async (req, res) => {
  const userId = String((req as any).userId || '').trim();
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'database_unavailable' });

  const rl = await checkRateLimit(`fliq_feed:${userId}`, 240, 60 * 60_000);
  if (!rl.ok) return res.status(429).json({ ok: false, error: 'rate_limited', retryAfterSec: rl.retryAfterSec });

  try {
    const limit = Math.min(20, Math.max(1, Number(req.query.limit || 10)));
    const bucket = fliqLangBucket(String(req.query.lang || 'en'));
    const selected = parseTopics(req.query.topics);
    const topics = selected.length ? selected : [...FLIQ_TOPICS];
    // Ролики, которые уже лежат в ленте клиента, но ещё не досмотрены.
    const clientIds = parseIds(req.query.exclude, 80);

    const state: any = await FliqUserState.findOne({ user: userId }).select('seen topicWeights').lean();
    const seen: string[] = Array.isArray(state?.seen) ? state.seen : [];
    const weights: Record<string, number> = state?.topicWeights || {};
    const exclude = Array.from(new Set([...seen, ...clientIds]));
    const fields = 'videoId title channelTitle channelId durationSec topics score';

    const find = (filter: Record<string, unknown>, max: number): Promise<FeedVideo[]> =>
      FliqVideo.find({ dead: { $ne: true }, ...filter }).sort({ score: -1 }).limit(max).select(fields).lean();

    let candidates = await find({ langs: bucket, topics: { $in: topics }, videoId: { $nin: exclude } }, 400);
    // Темы выбраны узко и всё досмотрено — добираем остальными темами того же языка, потом английскими.
    if (candidates.length < limit * 2) {
      const have = new Set(candidates.map((c) => c.videoId));
      const more = await find({ langs: bucket, videoId: { $nin: [...exclude, ...have] } }, 200);
      candidates = candidates.concat(more);
    }
    if (candidates.length < limit && bucket !== 'en') {
      const have = new Set(candidates.map((c) => c.videoId));
      const more = await find({ langs: 'en', topics: { $in: topics }, videoId: { $nin: [...exclude, ...have] } }, 200);
      candidates = candidates.concat(more);
    }
    let items = pickFliqItems(candidates, limit, weights, selected);
    // Пул досмотрен целиком — лента не кончается: повторяем давно виденное.
    if (items.length < limit) {
      const have = new Set([...items.map((c) => c.videoId), ...clientIds]);
      const recent = new Set(seen.slice(-200));
      const again = await find({ langs: bucket, videoId: { $nin: [...have, ...recent] } }, 200);
      items = items.concat(pickFliqItems(again, limit - items.length, weights, selected));
    }

    res.json({
      ok: true,
      items: items.map((v) => ({
        id: v.videoId,
        source: 'youtube',
        title: v.title,
        author: v.channelTitle,
        durationSec: v.durationSec,
        topics: v.topics,
      })),
    });
  } catch (e: any) {
    logger.warn('[fliq] feed failed', { userId, error: e?.message || String(e) });
    res.status(500).json({ ok: false, error: 'feed_failed' });
  }
});

router.post('/fliq/events', async (req, res) => {
  const userId = String((req as any).userId || '').trim();
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'database_unavailable' });

  const rl = await checkRateLimit(`fliq_events:${userId}`, 600, 60 * 60_000);
  if (!rl.ok) return res.status(429).json({ ok: false, error: 'rate_limited' });

  try {
    const raw = Array.isArray(req.body?.events) ? req.body.events.slice(0, 50) : [];
    const events = raw
      .map((e: any) => ({
        id: String(e?.id || ''),
        watchedMs: Math.max(0, Number(e?.watchedMs || 0)),
        durationMs: Math.max(0, Number(e?.durationMs || 0)),
        shared: e?.shared === true,
      }))
      .filter((e: { id: string }) => VIDEO_ID_RE.test(e.id));
    if (!events.length) return res.json({ ok: true });

    const ids: string[] = Array.from(new Set(events.map((e: { id: string }) => e.id)));
    const videos: Array<{ videoId: string; topics: string[] }> = await FliqVideo.find({ videoId: { $in: ids } })
      .select('videoId topics')
      .lean();
    const topicsById = new Map(videos.map((v) => [v.videoId, v.topics || []]));

    const state: any = await FliqUserState.findOne({ user: userId }).select('topicWeights').lean();
    const weights: Record<string, number> = { ...(state?.topicWeights || {}) };
    for (const ev of events) {
      const ratio = ev.durationMs > 0 ? ev.watchedMs / ev.durationMs : 0;
      const delta = ev.shared ? 0.6 : ratio >= 0.8 ? 0.25 : ratio >= 0.4 ? 0.1 : ev.watchedMs < 2500 ? -0.15 : 0;
      if (!delta) continue;
      for (const topic of topicsById.get(ev.id) || []) {
        const next = Number(weights[topic] ?? 1) + delta;
        weights[topic] = Math.round(Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, next)) * 1000) / 1000;
      }
    }

    await FliqUserState.updateOne(
      { user: userId },
      { $push: { seen: { $each: ids, $slice: -SEEN_KEEP } }, $set: { topicWeights: weights } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e: any) {
    logger.warn('[fliq] events failed', { userId, error: e?.message || String(e) });
    res.status(500).json({ ok: false, error: 'events_failed' });
  }
});

router.post('/fliq/unplayable', async (req, res) => {
  const userId = String((req as any).userId || '').trim();
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const rl = await checkRateLimit(`fliq_unplayable:${userId}`, 30, 60 * 60_000);
  if (!rl.ok) return res.status(429).json({ ok: false, error: 'rate_limited' });

  const id = String(req.body?.id || '');
  const code = Number(req.body?.code);
  if (!VIDEO_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  try {
    if (DEAD_ERROR_CODES.has(code)) {
      await FliqVideo.updateOne({ videoId: id }, { $set: { dead: true } });
      logger.info('[fliq] video marked unplayable', { id, code, userId });
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'unplayable_failed' });
  }
});

router.get('/fliq/status', async (_req, res) => {
  try {
    const counts: Record<string, number> = {};
    if (mongoose.connection.readyState === 1) {
      for (const lang of fliqCollectorStatus().langs) {
        counts[lang] = await FliqVideo.countDocuments({ langs: lang, dead: { $ne: true } });
      }
    }
    res.json({ ok: true, collector: fliqCollectorStatus(), pool: counts });
  } catch {
    res.status(500).json({ ok: false });
  }
});

export default router;
