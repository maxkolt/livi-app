/** Видеокружки: лимиты записи, сохранение файла до отправки и кадр-превью. */

import * as FileSystem from "expo-file-system";
import { createVideoPlayer } from "expo-video";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { logger } from "../../utils/logger";
import { isVideoNoteThumbUsable } from "./videoNoteThumbValidation";

/** Как в Telegram: кружок до минуты. */
export const VIDEO_NOTE_MAX_MS = 60_000;
/** Короче — случайное касание, такой кружок не отправляем. */
export const VIDEO_NOTE_MIN_MS = 1_000;

/** Неотправленные кружки: в documentDirectory их не тронет очистка кэша. */
const VIDEO_NOTE_OUTBOX_DIR = FileSystem.documentDirectory ? `${FileSystem.documentDirectory}video-note-outbox/` : null;

/** Перенести запись из кэша камеры в постоянную папку. Не вышло — оставляем как есть. */
export async function keepVideoNoteRecording(uri: string, id: string): Promise<string> {
  if (!VIDEO_NOTE_OUTBOX_DIR || !uri) return uri;
  try {
    await FileSystem.makeDirectoryAsync(VIDEO_NOTE_OUTBOX_DIR, { intermediates: true });
    const dest = `${VIDEO_NOTE_OUTBOX_DIR}${id}.mp4`;
    await FileSystem.moveAsync({ from: uri, to: dest });
    return dest;
  } catch {
    return uri;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Кадр-превью кружка (jpeg рядом с видео): его видят в ленте до запуска. Не вышло — null,
 * кружок уйдёт без превью.
 */
export async function makeVideoNoteThumb(videoUri: string, id: string, durationSec?: number): Promise<string | null> {
  let expired = false;
  const task = generateValidatedVideoNoteThumb(videoUri, id, durationSec, () => expired);
  const result = await withTimeout(task, 4000);
  if (!result) {
    expired = true;
    // A timed-out native decode/save may finish later. Never leave its JPEG in the outbox.
    void task.then(uri => { if (uri) return discardVideoNoteThumb(uri); }).catch(() => {});
  }
  return result;
}

async function discardVideoNoteThumb(uri: string): Promise<void> {
  try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
}

async function generateValidatedVideoNoteThumb(
  videoUri: string,
  id: string,
  durationSec: number | undefined,
  isExpired: () => boolean,
): Promise<string | null> {
  let player: ReturnType<typeof createVideoPlayer> | null = null;
  try {
    player = createVideoPlayer({ uri: videoUri });
    const duration = durationSec ?? player.duration;
    const lastTime = Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - 0.05) : 1.5;
    const times = [...new Set([0.15, 0.6, 1.5].map(time => Math.min(time, lastTime)))];
    for (const time of times) {
      if (isExpired()) return null;
      let thumbs: Awaited<ReturnType<typeof player.generateThumbnailsAsync>> = [];
      let context: ReturnType<typeof ImageManipulator.manipulate> | undefined;
      let rendered: Awaited<ReturnType<NonNullable<typeof context>["renderAsync"]>> | undefined;
      let temporaryUri: string | undefined;
      try {
        thumbs = await player.generateThumbnailsAsync([time], { maxWidth: 360, maxHeight: 360 });
        if (isExpired()) return null;
        const thumb = thumbs[0];
        if (!thumb) continue;
        context = ImageManipulator.manipulate(thumb);
        rendered = await context.renderAsync();
        if (isExpired()) return null;
        const saved = await rendered.saveAsync({ compress: 0.72, format: SaveFormat.JPEG });
        temporaryUri = saved.uri;
        if (isExpired() || !await isVideoNoteThumbUsable(saved.uri)) continue;
        if (isExpired()) return null;
        let acceptedUri = saved.uri;
        if (VIDEO_NOTE_OUTBOX_DIR) {
          const dest = `${VIDEO_NOTE_OUTBOX_DIR}${id}.jpg`;
          try {
            await FileSystem.moveAsync({ from: saved.uri, to: dest });
            acceptedUri = dest;
            temporaryUri = dest;
          } catch {}
        }
        if (isExpired()) return null;
        temporaryUri = undefined;
        return acceptedUri;
      } catch (e) {
        logger.warn("[video-note] thumbnail candidate failed", { time, error: String((e as Error)?.message ?? e) });
      } finally {
        if (temporaryUri) await discardVideoNoteThumb(temporaryUri);
        try { rendered?.release(); } catch {}
        try { context?.release(); } catch {}
        for (const thumb of thumbs) {
          try { thumb.release(); } catch {}
        }
      }
    }
    return null;
  } catch (e) {
    logger.warn("[video-note] thumbnail failed", { error: String((e as Error)?.message ?? e) });
    return null;
  } finally {
    try {
      player?.release();
    } catch {}
  }
}
