import React, { memo, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  type StyleProp,
  type TextProps,
  type TextStyle,
} from 'react-native';
import { scaleFont, useAdaptiveTypeScale } from '../utils/adaptiveType';

type AdaptiveTextProps = TextProps & {
  style?: StyleProp<TextStyle>;
  /**
   * Однострочный режим: не переносить, сжимать шрифт под ширину.
   * Включается также при numberOfLines={1}.
   */
  fit?: boolean;
  minimumFontScale?: number;
};

function scaleTextStyle(style: StyleProp<TextStyle>, scale: number): TextStyle | null {
  const flat = StyleSheet.flatten(style);
  if (!flat) return null;
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
  if (typeof flat.letterSpacing === 'number' && scale !== 1) {
    next.letterSpacing = Math.round(flat.letterSpacing * scale * 100) / 100;
    changed = true;
  }
  return changed ? next : null;
}

/**
 * Текст с адаптивным размером под телефон/планшет.
 * Системный accessibility fontScale уже выключен глобально.
 */
function AdaptiveTextInner({
  style,
  fit,
  numberOfLines,
  minimumFontScale = 0.72,
  children,
  ...rest
}: AdaptiveTextProps) {
  const scale = useAdaptiveTypeScale();
  const scaled = useMemo(() => scaleTextStyle(style, scale), [style, scale]);
  const singleLine = fit === true || numberOfLines === 1;

  return (
    <Text
      {...rest}
      numberOfLines={singleLine ? 1 : numberOfLines}
      allowFontScaling={false}
      maxFontSizeMultiplier={1}
      adjustsFontSizeToFit={singleLine ? true : rest.adjustsFontSizeToFit}
      minimumFontScale={singleLine ? minimumFontScale : rest.minimumFontScale}
      ellipsizeMode={singleLine ? rest.ellipsizeMode ?? 'tail' : rest.ellipsizeMode}
      style={scaled ? [style, scaled] : style}
    >
      {children}
    </Text>
  );
}

export const AdaptiveText = memo(AdaptiveTextInner);
export default AdaptiveText;
