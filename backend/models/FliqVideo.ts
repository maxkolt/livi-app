// models/FliqVideo.ts
// Ролики ленты Fliq (YouTube Shorts), собранные через YouTube Data API.
// Правила YouTube API: данные хранятся не дольше 30 дней — TTL по fetchedAt,
// сборщик освежает fetchedAt, когда находит ролик снова.
import { Schema, model, models } from 'mongoose';

export interface IFliqVideo {
  videoId: string;
  source: 'youtube';
  title: string;
  channelTitle: string;
  channelId: string;
  durationSec: number;
  /** Языковые корзины, в которых ролик нашёлся (ru, en, …). */
  langs: string[];
  topics: string[];
  views: number;
  publishedAt: Date | null;
  /** Ранг для выдачи: популярность + свежесть. */
  score: number;
  /** Не играет во встроенном плеере (ошибки 100/101/150) — в ленту не отдаём. */
  dead: boolean;
  fetchedAt: Date;
}

const FliqVideoSchema = new Schema<IFliqVideo>(
  {
    videoId: { type: String, required: true, unique: true },
    source: { type: String, default: 'youtube' },
    title: { type: String, default: '' },
    channelTitle: { type: String, default: '' },
    channelId: { type: String, default: '' },
    durationSec: { type: Number, default: 0 },
    langs: { type: [String], default: [] },
    topics: { type: [String], default: [] },
    views: { type: Number, default: 0 },
    publishedAt: { type: Date, default: null },
    score: { type: Number, default: 0 },
    dead: { type: Boolean, default: false },
    fetchedAt: { type: Date, default: () => new Date() },
  },
  { collection: 'fliq_videos' }
);

// Только одно поле-массив: составной индекс по двум массивам (langs + topics) MongoDB не строит
// и отклоняет запись («cannot index parallel arrays»). Тема фильтруется уже по выборке языка.
FliqVideoSchema.index({ langs: 1, score: -1 });
FliqVideoSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export default (models.FliqVideo as any) || model<IFliqVideo>('FliqVideo', FliqVideoSchema);
