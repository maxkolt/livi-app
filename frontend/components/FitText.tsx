import React, { memo } from 'react';
import { type StyleProp, type TextProps, type TextStyle } from 'react-native';
import AdaptiveText from './AdaptiveText';

type FitTextProps = TextProps & {
  style?: StyleProp<TextStyle>;
  /** Нижняя граница сжатия (0–1). По умолчанию 0.72. */
  minimumFontScale?: number;
};

/**
 * Однострочный UI-текст: не переносится, при нехватке места сжимается + адаптив к экрану.
 */
function FitTextInner({ style, minimumFontScale = 0.72, children, ...rest }: FitTextProps) {
  return (
    <AdaptiveText fit minimumFontScale={minimumFontScale} style={style} {...rest}>
      {children}
    </AdaptiveText>
  );
}

export const FitText = memo(FitTextInner);
export default FitText;
