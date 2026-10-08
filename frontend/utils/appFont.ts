/**
 * Шрифт всего приложения — Exo 2, как у «Найти собеседника» и «Онлайн».
 *
 * Text и TextInput без своего шрифта получают Exo 2 нужного начертания: насыщенность
 * берём из fontWeight и подставляем файл этого начертания, а fontWeight сбрасываем —
 * иначе Android синтезирует жирность поверх Regular. Свои шрифты (значки, моноширинная
 * ссылка, логотип, ник над радаром) не трогаем. Системные семейства, которыми раньше
 * только подбирали насыщенность (sans-serif-medium / -light), тоже становятся Exo 2.
 * Вложенный Text без своего начертания наследует шрифт родителя — его не трогаем.
 *
 * Кириллица и латиница — в самом Exo 2; арабский, CJK, тайский, хинди и эмодзи
 * система дорисовывает своими шрифтами, как и раньше.
 */

import React from 'react';
import { StyleSheet, Text, TextInput, type TextStyle } from 'react-native';
import { Exo2_300Light } from '@expo-google-fonts/exo-2/300Light';
import { Exo2_400Regular } from '@expo-google-fonts/exo-2/400Regular';
import { Exo2_500Medium } from '@expo-google-fonts/exo-2/500Medium';
import { Exo2_600SemiBold } from '@expo-google-fonts/exo-2/600SemiBold';
import { Exo2_700Bold } from '@expo-google-fonts/exo-2/700Bold';

/** «Этот Text вложен в другой Text» — тот же контекст, по которому RN рисует вложенный текст спаном. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TextAncestorContext: React.Context<boolean> = require('react-native/Libraries/Text/TextAncestor').default;

/** Для useFonts в корне приложения: текст не рисуется, пока файлы не загружены. */
export const APP_FONT_FILES = {
  Exo2_300Light,
  Exo2_400Regular,
  Exo2_500Medium,
  Exo2_600SemiBold,
  Exo2_700Bold,
};

type Weight = 300 | 400 | 500 | 600 | 700;

/** Готовые стили: без новых объектов на каждый рендер текста. */
const FONT_BY_WEIGHT: Record<Weight, TextStyle> = {
  300: { fontFamily: 'Exo2_300Light', fontWeight: 'normal' },
  400: { fontFamily: 'Exo2_400Regular', fontWeight: 'normal' },
  500: { fontFamily: 'Exo2_500Medium', fontWeight: 'normal' },
  600: { fontFamily: 'Exo2_600SemiBold', fontWeight: 'normal' },
  700: { fontFamily: 'Exo2_700Bold', fontWeight: 'normal' },
};

/** Системные семейства — их заменяем; число — насыщенность, если fontWeight не задан. */
const SYSTEM_FAMILIES: Record<string, Weight> = {
  System: 400,
  'system-ui': 400,
  Roboto: 400,
  'sans-serif': 400,
  'sans-serif-condensed': 400,
  'sans-serif-thin': 300,
  'sans-serif-light': 300,
  'sans-serif-medium': 500,
};

const NAMED_WEIGHTS: Record<string, Weight> = {
  ultralight: 300,
  thin: 300,
  light: 300,
  normal: 400,
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  condensedBold: 700,
  condensed: 400,
  heavy: 700,
  black: 700,
};

function toWeight(weight: TextStyle['fontWeight'], fallback: Weight): Weight {
  if (weight == null) return fallback;
  const named = NAMED_WEIGHTS[String(weight)];
  if (named) return named;
  const n = Number(weight);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 300) return 300;
  if (n < 500) return 400;
  if (n < 600) return 500;
  if (n < 700) return 600;
  return 700;
}

/** Стиль шрифта приложения для текста, или null — оставить как есть. */
function appFontFor(style: unknown, nested: boolean): TextStyle | null {
  const flat = StyleSheet.flatten(style as TextStyle) as TextStyle | undefined;
  const family = flat?.fontFamily;
  const weight = flat?.fontWeight;
  if (family) {
    const systemWeight = SYSTEM_FAMILIES[family];
    if (systemWeight == null) return null;
    return FONT_BY_WEIGHT[toWeight(weight, systemWeight)];
  }
  // Вложенный текст без своей насыщенности наследует шрифт и начертание родителя.
  if (nested && weight == null) return null;
  return FONT_BY_WEIGHT[toWeight(weight, 400)];
}

type ForwardRefComponent = {
  render?: ((props: any, ref: any) => React.ReactNode) & { appFont?: boolean };
};

function patchRender(component: ForwardRefComponent, nestable: boolean) {
  const render = component.render;
  if (typeof render !== 'function' || render.appFont) return;
  const withFont = (props: any, nested: boolean) => {
    const font = appFontFor(props.style, nested);
    return font ? { ...props, style: [props.style, font] } : props;
  };
  // Две обёртки, а не хук под условием: у Text контекст вложенности читается
  // всегда, TextInput вложенным не бывает.
  const withAppFont: NonNullable<ForwardRefComponent['render']> = nestable
    ? function AppFontText(props: any, ref: any) {
        return render(withFont(props, React.useContext(TextAncestorContext)), ref);
      }
    : function AppFontTextInput(props: any, ref: any) {
        return render(withFont(props, false), ref);
      };
  withAppFont.appFont = true;
  component.render = withAppFont;
}

let installed = false;

/** Один раз до первого рендера (index.tsx). */
export function installAppFont() {
  if (installed) return;
  installed = true;
  patchRender(Text as unknown as ForwardRefComponent, true);
  patchRender(TextInput as unknown as ForwardRefComponent, false);
}
