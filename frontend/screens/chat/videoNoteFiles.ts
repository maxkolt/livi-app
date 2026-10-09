/** Видеокружки: лимиты записи, сохранение файла до отправки и кадр-превью. */

import * as FileSystem from "expo-file-system";
import { createVideoPlayer } from "expo-video";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { logger } from "../../utils/logger";

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
export async function makeVideoNoteThumb(videoUri: string, id: string): Promise<string | null> {
  const player = createVideoPlayer({ uri: videoUri });
  try {
    const thumbs = await withTimeout(player.generateThumbnailsAsync([0.15], { maxWidth: 360, maxHeight: 360 }), 4000);
    const thumb = thumbs?.[0];
    if (!thumb) return null;
    const rendered = await ImageManipulator.manipulate(thumb).renderAsync();
    const saved = await rendered.saveAsync({ compress: 0.72, format: SaveFormat.JPEG });
    if (!VIDEO_NOTE_OUTBOX_DIR || !saved?.uri) return saved?.uri || null;
    const dest = `${VIDEO_NOTE_OUTBOX_DIR}${id}.jpg`;
    try {
      await FileSystem.moveAsync({ from: saved.uri, to: dest });
      return dest;
    } catch {
      return saved.uri;
    }
  } catch (e) {
    logger.warn("[video-note] thumbnail failed", { error: String((e as Error)?.message ?? e) });
    return null;
  } finally {
    try {
      player.release();
    } catch {}
  }
}
