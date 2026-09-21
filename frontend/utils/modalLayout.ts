import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Геометрия модалок с учётом ориентации.
 *
 * В landscape высоты мало, а ширины много, поэтому правила зеркальные:
 * вертикальные отступы урезаем, содержимое делаем скроллящимся, а по
 * горизонтали наоборот — ограничиваем ширину, чтобы диалог не растягивался
 * на весь экран.
 */

const LANDSCAPE_RATIO = 1.05;
const TABLET_MIN_SHORT_SIDE = 600;

export type ModalLayout = {
  width: number;
  height: number;
  isLandscape: boolean;
  isTablet: boolean;
  /** Внешние отступы оверлея. */
  padH: number;
  padV: number;
  /** Потолок высоты карточки — всё, что выше, уходит в скролл. */
  maxCardHeight: number;
  /** Потолок ширины диалога. */
  dialogMaxWidth: number;
  /** Потолок высоты bottom sheet. */
  sheetMaxHeight: number;
  /** Ширина bottom sheet: во весь экран в портрете, ограниченная в landscape. */
  sheetWidth: number | '100%';
};

export function useModalLayout(): ModalLayout {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  return useMemo(() => {
    const isLandscape = width > 0 && height > 0 && width / height > LANDSCAPE_RATIO;
    const isTablet = Math.min(width, height) >= TABLET_MIN_SHORT_SIDE;

    // Планшет в landscape по высоте не стеснён — режем отступы только на телефоне.
    const tight = isLandscape && !isTablet;
    const padV = tight ? 10 : 24;
    const padH = isLandscape ? 24 : 20;

    const freeH = Math.max(0, height - insets.top - insets.bottom - padV * 2);
    const freeW = Math.max(0, width - insets.left - insets.right - padH * 2);

    const maxCardHeight = Math.max(160, freeH);
    const dialogMaxWidth = Math.max(260, Math.min(freeW, isLandscape ? 440 : 380));

    // В портрете лист занимает 72% высоты; в landscape столько места просто нет,
    // поэтому отдаём почти всё, оставив полоску фона для тапа «закрыть».
    const sheetMaxHeight = isLandscape
      ? Math.max(200, Math.min(Math.round(height * 0.94), height - insets.top - 8))
      : Math.max(200, Math.min(Math.round(height * 0.72), height - insets.top - 12));
    const sheetWidth: number | '100%' = isLandscape
      ? Math.max(320, Math.min(freeW + padH * 2, isTablet ? 620 : 540))
      : '100%';

    return {
      width,
      height,
      isLandscape,
      isTablet,
      padH,
      padV,
      maxCardHeight,
      dialogMaxWidth,
      sheetMaxHeight,
      sheetWidth,
    };
  }, [width, height, insets.top, insets.bottom, insets.left, insets.right]);
}
