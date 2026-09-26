import React, { memo } from 'react';
import { type StyleProp, type TextProps, type TextStyle } from 'react-native';
import AdaptiveText from './AdaptiveText';
import { APP_COMPACT_TEXT_MAX_FONT_SIZE_MULTIPLIER } from '../utils/accessibilityTypography';

type FitTextProps = TextProps & {
  style?: StyleProp<TextStyle>;
  /** Нижняя граница сжатия (0–1). По умолчанию 0.72. */
  minimumFontScale?: number;
};

/**
 * Однострочный UI-текст: не переносится, при нехватке места сжимается + адаптив к экрану.
 */
function FitTextInner({
  style,
  minimumFontScale = 0.72,
  maxFontSizeMultiplier = APP_COMPACT_TEXT_MAX_FONT_SIZE_MULTIPLIER,
  children,
  ...rest
}: FitTextProps) {
  return (
    <AdaptiveText
      fit
      numberOfLines={1}
      minimumFontScale={minimumFontScale}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={style}
      {...rest}
    >
      {children}
    </AdaptiveText>
  );
}

export const FitText = memo(FitTextInner);
export default FitText;
