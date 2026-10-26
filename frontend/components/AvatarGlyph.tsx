import React from 'react';
import { PixelRatio, StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { renderedAppFontSize } from '../utils/appFont';

/**
 * Насколько поднять знак, в долях кегля. Text центрирует строку Exo 2 (ascent 0.999 +
 * descent 0.201 em, середина −0.399 em от базовой линии), а не сам знак: середина заглавной
 * −0.345 em, «—» −0.255 em, строчной −0.25 em. Эмодзи и другие письменности рисуют
 * системные шрифты — их не двигаем.
 */
function glyphRaiseEm(glyph: string): number {
  if (/^[—–-]+$/.test(glyph)) return 0.144;
  try {
    if (/^[\p{Lu}\p{Nd}?]$/u.test(glyph)) return 0.054;
    if (/^\p{Ll}$/u.test(glyph)) return 0.149;
  } catch {
    if (/^[A-ZА-ЯЁ0-9?]$/.test(glyph)) return 0.054;
  }
  return 0;
}

/** Буква / «—» / «?» аватара без картинки — по середине круга (родитель центрирует Text). */
export function AvatarGlyph({
  children,
  style,
}: {
  children: string;
  style?: StyleProp<TextStyle>;
}) {
  const flat = StyleSheet.flatten(style);
  const fontSize = typeof flat?.fontSize === 'number' ? flat.fontSize : 14;
  const raise = PixelRatio.roundToNearestPixel(glyphRaiseEm(children) * renderedAppFontSize(fontSize));
  return (
    <Text
      numberOfLines={1}
      style={[style, styles.glyph, raise ? { transform: [{ translateY: -raise }] } : null]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  // Без font padding строка — ровно ascent..descent; от неё и считаем подъём.
  glyph: {
    includeFontPadding: false,
    lineHeight: undefined,
    textAlign: 'center',
  },
});
