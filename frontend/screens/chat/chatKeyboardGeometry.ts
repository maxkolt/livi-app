export type KeyboardFrameLike = {
  screenY?: number;
  height?: number;
};

/**
 * Высота, на которую нужно поднять контент внутри SafeAreaView.
 * Считаем по frame, а не по фиксированной высоте: prediction/
 * clipboard/emoji-панели меняют его, пока клавиатура уже открыта.
 */
export function resolveKeyboardAvoidance(
  frame: KeyboardFrameLike | null | undefined,
  screenHeightRaw: number,
  safeAreaBottomRaw: number,
): number {
  const screenHeight = Math.max(0, Number(screenHeightRaw) || 0);
  const safeAreaBottom = Math.max(0, Number(safeAreaBottomRaw) || 0);
  const height = Math.max(0, Number(frame?.height) || 0);
  if (!screenHeight || !height) return 0;

  const rawScreenY = Number(frame?.screenY);
  const screenY = Number.isFinite(rawScreenY) && rawScreenY > 0
    ? rawScreenY
    : screenHeight - height;
  const keyboardBottom = screenY + height;
  const usableBottom = Math.max(0, screenHeight - safeAreaBottom);

  // Floating/split keyboard above the composer does not cover the bottom edge.
  if (keyboardBottom < usableBottom - 1) return 0;

  return Math.max(0, Math.min(screenHeight, Math.round(usableBottom - screenY)));
}
