/**
 * Геометрия листа пересылки. Отдельный модуль без импортов —
 * чтобы логика высоты была тестируемой в отрыве от RN и ассетов.
 */

export function computeForwardPickerLayout(opts: {
  maxSheet: number;
  padBottom: number;
  forwardLoading: boolean;
  friendsCount: number;
  /** В landscape кнопки футера идут в строку, а не стопкой. */
  landscape?: boolean;
}): { sheetHeight: number } {
  const { maxSheet, padBottom, forwardLoading, friendsCount, landscape = false } = opts;
  const padTop = landscape ? 22 : 30;
  const headerAndSep = landscape ? 70 : 86;
  const footerBlock = landscape ? 70 : 140;
  const maxList = Math.max(110, maxSheet - padTop - padBottom - headerAndSep - footerBlock);
  const rowApprox = 62;
  const listPadding = 16;
  let listNeed: number;
  if (forwardLoading) {
    listNeed = Math.min(168, maxList);
  } else if (friendsCount === 0) {
    listNeed = Math.min(96, maxList);
  } else {
    const contentH = friendsCount * rowApprox + listPadding;
    listNeed = Math.min(Math.max(contentH, 72), maxList);
  }
  const sheetHeight = Math.min(maxSheet, padTop + headerAndSep + listNeed + footerBlock + padBottom);
  return { sheetHeight };
}
