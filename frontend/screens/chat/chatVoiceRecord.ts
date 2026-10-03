/** Hold-to-record voice constants / trash-zone helpers. */

import * as FileSystem from "expo-file-system";

export const VOICE_MAX_MS = 60_000;
/**
 * Отпустили микрофон раньше — это тап: запись продолжается без пальца, до «Отправить»,
 * повторного нажатия на микрофон или корзины. Дольше — удержание: отпустил и отправил.
 */
export const VOICE_TAP_MAX_MS = 450;
/** Swipe-left cancel: sensitive arm threshold. */
export const VOICE_CANCEL_ARM_DX = -12;
export const VOICE_CANCEL_DISARM_DX = -4;
export const VOICE_TRASH_PAD = 34;

export type TrashZone = { x: number; y: number; w: number; h: number };

export function isPointInTrashZone(
  zone: TrashZone | null | undefined,
  moveX: number,
  moveY: number,
  pad: number = VOICE_TRASH_PAD,
): boolean {
  if (!zone) return false;
  return (
    moveX >= zone.x - pad &&
    moveX <= zone.x + zone.w + pad &&
    moveY >= zone.y - pad &&
    moveY <= zone.y + zone.h + pad
  );
}

/** Записи, которые ещё не ушли на сервер: в documentDirectory их не тронет очистка кэша. */
const VOICE_OUTBOX_DIR = FileSystem.documentDirectory ? `${FileSystem.documentDirectory}voice-outbox/` : null;

/** Перенести запись из кэша в постоянную папку. Не вышло — оставляем как есть. */
export async function keepVoiceRecording(uri: string, id: string): Promise<string> {
  if (!VOICE_OUTBOX_DIR || !uri) return uri;
  try {
    await FileSystem.makeDirectoryAsync(VOICE_OUTBOX_DIR, { intermediates: true });
    const dest = `${VOICE_OUTBOX_DIR}${id}.m4a`;
    await FileSystem.moveAsync({ from: uri, to: dest });
    return dest;
  } catch {
    return uri;
  }
}
