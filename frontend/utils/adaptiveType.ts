import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { SEARCH_CTA_TABLET_MIN_WIDTH } from '../screens/home/constants';

/**
 * Масштаб UI-шрифта от ширины экрана (не системный accessibility scale —
 * тот уже выключен в App/index).
 * Узкий телефон чуть меньше, планшет чуть крупнее.
 */
export function useAdaptiveTypeScale(): number {
  const { width, height } = useWindowDimensions();
  return useMemo(() => {
    const short = Math.min(width, height);
    const long = Math.max(width, height);
    const isTablet = short >= SEARCH_CTA_TABLET_MIN_WIDTH || (width >= SEARCH_CTA_TABLET_MIN_WIDTH && long / short < 1.6);
    if (isTablet) {
      if (short >= 900) return 1.12;
      if (short >= 700) return 1.08;
      return 1.05;
    }
    if (width > 0 && width < 340) return 0.9;
    if (width > 0 && width < 380) return 0.94;
    if (height > 0 && height < 640 && width > height) return 0.92; // phone landscape
    return 1;
  }, [width, height]);
}

export function scaleFont(size: number, scale: number): number {
  return Math.round(size * scale * 10) / 10;
}
