/** Hold-to-record voice constants / trash-zone helpers. */

export const VOICE_MAX_MS = 60_000;
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
