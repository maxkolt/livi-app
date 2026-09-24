import { useFonts } from 'expo-font';
import { Fredoka_600SemiBold } from '@expo-google-fonts/fredoka/600SemiBold';
import { BRAND_FONT_FAMILY } from './constants';

const BRAND_ROUNDED_FAMILY = 'Fredoka_600SemiBold';

export type BrandFont = { fontFamily: string; fontWeight: '600' | 'normal' };

/**
 * Шрифт логотипа LiVi: Fredoka SemiBold — заметно скруглены и окончания, и углы букв
 * (у Nunito вершина V оставалась почти острой). Только латиница, файл ~50 КБ.
 * Пока файл грузится, остаётся прежний системный шрифт. Насыщенность уже в
 * файле шрифта: fontWeight для него не задаём, иначе Android синтезирует жирность.
 */
export function useBrandFont(): BrandFont {
  const [loaded] = useFonts({ [BRAND_ROUNDED_FAMILY]: Fredoka_600SemiBold });
  return loaded
    ? { fontFamily: BRAND_ROUNDED_FAMILY, fontWeight: 'normal' }
    : { fontFamily: BRAND_FONT_FAMILY, fontWeight: '600' };
}
