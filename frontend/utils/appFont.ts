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
import { Dimensions, PixelRatio, StyleSheet, Text, TextInput, type TextStyle, type TextProps, type TextInputProps } from 'react-native';
import { Exo2_300Light } from '@expo-google-fonts/exo-2/300Light';
import { Exo2_400Regular } from '@expo-google-fonts/exo-2/400Regular';
import { Exo2_500Medium } from '@expo-google-fonts/exo-2/500Medium';
import { Exo2_600SemiBold } from '@expo-google-fonts/exo-2/600SemiBold';
import { Exo2_700Bold } from '@expo-google-fonts/exo-2/700Bold';
import { APP_INPUT_MAX_FONT_SIZE_MULTIPLIER, APP_TEXT_MAX_FONT_SIZE_MULTIPLIER } from './accessibilityTypography';
import { adaptiveTypeStyleScaleForSize, scaleFont, typeScaleWindowSize } from './adaptiveType';

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
function appFontFor(flat: TextStyle | undefined, nested: boolean): TextStyle | null {
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

/**
 * Масштабируем только обычный текст приложения. Иконочные и сторонние шрифты не трогаем:
 * иначе вместе с надписями начнут расти Ionicons/MaterialIcons.
 */
function adaptiveTextStyle(flat: TextStyle | undefined, scale: number): TextStyle | null {
  if (scale === 1 || !flat) return null;
  const family = flat.fontFamily;
  const usesAppFont = !family || SYSTEM_FAMILIES[family] != null || family.startsWith('Exo2_');
  if (!usesAppFont) return null;

  const next: TextStyle = {};
  let changed = false;
  if (typeof flat.fontSize === 'number') {
    next.fontSize = scaleFont(flat.fontSize, scale);
    changed = true;
  }
  if (typeof flat.lineHeight === 'number') {
    next.lineHeight = scaleFont(flat.lineHeight, scale);
    changed = true;
  }
  if (typeof flat.letterSpacing === 'number') {
    next.letterSpacing = Math.round(flat.letterSpacing * scale * 100) / 100;
    changed = true;
  }
  return changed ? next : null;
}

type ForwardRefComponent<Props, Instance> = {
  render?: ((props: Props, ref: React.ForwardedRef<Instance>) => React.ReactNode) & { appFont?: boolean };
};

function patchRender<Props extends Pick<TextProps, 'style' | 'maxFontSizeMultiplier'>, Instance>(
  component: ForwardRefComponent<Props, Instance>, nestable: boolean, maxFontSizeMultiplier: number,
) {
  const render = component.render;
  if (typeof render !== 'function' || render.appFont) return;
  const withFont = (props: Props, nested: boolean) => {
    const flat = StyleSheet.flatten(props.style as TextStyle) as TextStyle | undefined;
    const font = appFontFor(flat, nested);
    const { width, height } = typeScaleWindowSize(Dimensions.get('window'), Dimensions.get('screen'));
    const adaptive = adaptiveTextStyle(
      flat,
      adaptiveTypeStyleScaleForSize(width, height, PixelRatio.getFontScale() || 1),
    );
    // Потолок системного размера шрифта. React 19 не применяет defaultProps к функциональным
    // компонентам, поэтому Text.defaultProps молча не работал. Вложенный Text наследует потолок
    // родителя — свой не ставим, иначе он перебьёт более строгий (поле ввода чата).
    const capFontScale = !nested && props.maxFontSizeMultiplier === undefined;
    if (!font && !adaptive && !capFontScale) return props;
    return {
      ...props,
      ...(capFontScale ? { maxFontSizeMultiplier } : null),
      ...(font || adaptive ? { style: [props.style, adaptive, font] } : null),
    };
  };
  // Две обёртки, а не хук под условием: у Text контекст вложенности читается
  // всегда, TextInput вложенным не бывает.
  const withAppFont: NonNullable<ForwardRefComponent<Props, Instance>['render']> = nestable
    ? function AppFontText(props, ref) {
        return render(withFont(props, React.useContext(TextAncestorContext)), ref);
      }
    : function AppFontTextInput(props, ref) {
        return render(withFont(props, false), ref);
      };
  withAppFont.appFont = true;
  component.render = withAppFont;
}

/**
 * Кегль, которым Text приложения (верхнего уровня, без своего maxFontSizeMultiplier) реально
 * рисует fontSize: адаптивный масштаб из patchRender + системный размер шрифта под потолком.
 */
export function renderedAppFontSize(fontSize: number): number {
  const { width, height } = typeScaleWindowSize(Dimensions.get('window'), Dimensions.get('screen'));
  const fontScale = PixelRatio.getFontScale() || 1;
  const adaptive = scaleFont(fontSize, adaptiveTypeStyleScaleForSize(width, height, fontScale));
  return adaptive * Math.min(fontScale, APP_TEXT_MAX_FONT_SIZE_MULTIPLIER);
}

let installed = false;

/** Один раз до первого рендера (index.tsx). */
export function installAppFont() {
  if (installed) return;
  installed = true;
  patchRender(Text as typeof Text & ForwardRefComponent<TextProps, Text>, true, APP_TEXT_MAX_FONT_SIZE_MULTIPLIER);
  patchRender(TextInput as typeof TextInput & ForwardRefComponent<TextInputProps, TextInput>, false, APP_INPUT_MAX_FONT_SIZE_MULTIPLIER);
}
