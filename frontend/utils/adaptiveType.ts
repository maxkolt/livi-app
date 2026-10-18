import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { SEARCH_CTA_TABLET_MIN_WIDTH } from '../screens/home/constants';

/**
 * Базовый масштаб UI-шрифта от ширины экрана.
 * Системный accessibility scale React Native применит поверх него.
 * Узкий телефон чуть меньше, широкий телефон и планшет — чуть крупнее.
 */
export function useAdaptiveTypeScale(): number {
  const { width, height } = useWindowDimensions();
  return useMemo(() => adaptiveTypeScaleForSize(width, height), [width, height]);
}

/** Чистая версия расчёта — также используется глобальным слоем Text/TextInput. */
export function adaptiveTypeScaleForSize(width: number, height: number): number {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const isTablet = short >= SEARCH_CTA_TABLET_MIN_WIDTH || (width >= SEARCH_CTA_TABLET_MIN_WIDTH && long / short < 1.6);
  if (isTablet) {
    if (short >= 900) return 1.12;
    if (short >= 700) return 1.08;
    return 1.05;
  }
  if (width > 0 && width < 340) return 0.94;
  if (width > 0 && width < 360) return 0.97;
  if (height > 0 && height < 640 && width > height) return 0.92; // phone landscape

  // На широких телефонах (Ultra / Pro Max) те же sp визуально теряются в большем поле.
  // После базовых 384 dp растём плавно и останавливаемся на мягких +6%.
  if (short > 384) {
    return Math.min(1.06, Math.round((1 + (short - 384) / 560) * 1000) / 1000);
  }
  return 1;
}

/**
 * Android некоторых Samsung по умолчанию сообщает fontScale=0.9 даже при обычном размере
 * текста. Не даём базовому UI становиться мельче макета, но увеличенные a11y-настройки
 * по-прежнему полностью применяет сам React Native.
 */
export function adaptiveTypeStyleScaleForSize(width: number, height: number, fontScale: number): number {
  const layoutScale = adaptiveTypeScaleForSize(width, height);
  const safeFontScale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return safeFontScale < 1 ? layoutScale / Math.max(0.9, safeFontScale) : layoutScale;
}

export function scaleFont(size: number, scale: number): number {
  return Math.round(size * scale * 10) / 10;
}
