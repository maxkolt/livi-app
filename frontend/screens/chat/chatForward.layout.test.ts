import { computeForwardPickerLayout } from './chatForwardLayout';

/** Служебная высота листа вокруг списка друзей (см. computeForwardPickerLayout). */
const LANDSCAPE_CHROME = 22 + 70 + 70; // padTop + шапка + футер в строку
const PORTRAIT_CHROME = 30 + 86 + 140; // padTop + шапка + футер стопкой
const PAD_BOTTOM = 24;
const MIN_LIST_ROOM = 110;

describe('computeForwardPickerLayout', () => {
  // Телефон 800x360: лист занимает 94% высоты = 338.
  const LANDSCAPE_MAX_SHEET = 338;
  // Телефон 360x800: лист занимает 72% высоты = 576.
  const PORTRAIT_MAX_SHEET = 576;

  it('в landscape оставляет списку друзей рабочую высоту', () => {
    const { sheetHeight } = computeForwardPickerLayout({
      maxSheet: LANDSCAPE_MAX_SHEET,
      padBottom: PAD_BOTTOM,
      forwardLoading: false,
      friendsCount: 12,
      landscape: true,
    });

    const listRoom = sheetHeight - LANDSCAPE_CHROME - PAD_BOTTOM;
    expect(listRoom).toBeGreaterThanOrEqual(MIN_LIST_ROOM);
  });

  it('без landscape-флага на той же высоте список схлопывается', () => {
    const { sheetHeight } = computeForwardPickerLayout({
      maxSheet: LANDSCAPE_MAX_SHEET,
      padBottom: PAD_BOTTOM,
      forwardLoading: false,
      friendsCount: 12,
    });

    const listRoom = sheetHeight - PORTRAIT_CHROME - PAD_BOTTOM;
    expect(listRoom).toBeLessThan(MIN_LIST_ROOM);
  });

  it('портретная раскладка не изменилась', () => {
    const { sheetHeight } = computeForwardPickerLayout({
      maxSheet: PORTRAIT_MAX_SHEET,
      padBottom: PAD_BOTTOM,
      forwardLoading: false,
      friendsCount: 12,
    });

    expect(sheetHeight).toBe(PORTRAIT_MAX_SHEET);
  });

  it('лист не перерастает потолок ни в одной ориентации', () => {
    for (const landscape of [true, false]) {
      const maxSheet = landscape ? LANDSCAPE_MAX_SHEET : PORTRAIT_MAX_SHEET;
      for (const friendsCount of [0, 1, 5, 40]) {
        const { sheetHeight } = computeForwardPickerLayout({
          maxSheet,
          padBottom: PAD_BOTTOM,
          forwardLoading: false,
          friendsCount,
          landscape,
        });
        expect(sheetHeight).toBeLessThanOrEqual(maxSheet);
      }
    }
  });
});
