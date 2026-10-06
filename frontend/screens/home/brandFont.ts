import { useFonts } from 'expo-font';
import { Fredoka_600SemiBold } from '@expo-google-fonts/fredoka/600SemiBold';
import { Exo2_400Regular } from '@expo-google-fonts/exo-2/400Regular';
import { Exo2_500Medium } from '@expo-google-fonts/exo-2/500Medium';
import { Exo2_600SemiBold } from '@expo-google-fonts/exo-2/600SemiBold';
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

const NICK_DIGITAL_FAMILY = 'Exo2_500Medium';

/**
 * Ник над радаром: Exo 2 Medium — «цифровой» техно-шрифт в тон HUD радара, с кириллицей
 * (ники часто русские). Пока файл грузится — системный шрифт.
 */
export function useNickDigitalFont(): BrandFont {
  const [loaded] = useFonts({ [NICK_DIGITAL_FAMILY]: Exo2_500Medium });
  return loaded
    ? { fontFamily: NICK_DIGITAL_FAMILY, fontWeight: 'normal' }
    : { fontFamily: BRAND_FONT_FAMILY, fontWeight: '600' };
}

const DIGITAL_SEMIBOLD_FAMILY = 'Exo2_600SemiBold';

/**
 * Подписи навбара тем же «цифровым» Exo 2: обычные — Medium, активная — SemiBold.
 * Насыщенность в самих файлах: fontWeight не задаём, иначе Android синтезирует жирность.
 */
export function useTabLabelFonts(): { regular: BrandFont; active: BrandFont } | null {
  const [loaded] = useFonts({
    [NICK_DIGITAL_FAMILY]: Exo2_500Medium,
    [DIGITAL_SEMIBOLD_FAMILY]: Exo2_600SemiBold,
  });
  // Пока файлы грузятся — прежние системные подписи (null: ничего не переопределяем).
  return loaded
    ? {
        regular: { fontFamily: NICK_DIGITAL_FAMILY, fontWeight: 'normal' },
        active: { fontFamily: DIGITAL_SEMIBOLD_FAMILY, fontWeight: 'normal' },
      }
    : null;
}

const DIGITAL_REGULAR_FAMILY = 'Exo2_400Regular';

/**
 * Exo 2 Regular для подписей обычной насыщенности («Онлайн», «Найти собеседника»):
 * меняется только шрифт, размеры остаются. Пока файл грузится — null (прежний шрифт).
 */
const DIGITAL_REGULAR: BrandFont = { fontFamily: DIGITAL_REGULAR_FAMILY, fontWeight: 'normal' };

export function useDigitalRegularFont(): BrandFont | null {
  const [loaded] = useFonts({ [DIGITAL_REGULAR_FAMILY]: Exo2_400Regular });
  // Один и тот же объект: годится в зависимости useMemo.
  return loaded ? DIGITAL_REGULAR : null;
}

/** Exo 2 Medium для подписей насыщенности 500 (фильтры «Все / Онлайн» и т. п.); null — пока грузится. */
const DIGITAL_MEDIUM: BrandFont = { fontFamily: NICK_DIGITAL_FAMILY, fontWeight: 'normal' };

export function useDigitalMediumFont(): BrandFont | null {
  const [loaded] = useFonts({ [NICK_DIGITAL_FAMILY]: Exo2_500Medium });
  return loaded ? DIGITAL_MEDIUM : null;
}
