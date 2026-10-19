import React, { memo } from 'react';
import {
  Text,
  useWindowDimensions,
  type StyleProp,
  type TextProps,
  type TextStyle,
} from 'react-native';
import { APP_TEXT_MAX_FONT_SIZE_MULTIPLIER } from '../utils/accessibilityTypography';

type AdaptiveTextProps = TextProps & {
  style?: StyleProp<TextStyle>;
  /**
   * Однострочный режим: не переносить, сжимать шрифт под ширину.
   * По умолчанию включается при numberOfLines={1}.
   * Передайте fit={false}, чтобы оставить размер шрифта и обрезать хвост (ellipsis).
   */
  fit?: boolean;
  minimumFontScale?: number;
};

/**
 * Текст с адаптивным базовым размером под телефон/планшет.
 * Базовый масштаб централизован в appFont и применяется ко всему тексту приложения;
 * поверх него React Native применяет системный accessibility font scale.
 */
function AdaptiveTextInner({
  style,
  fit,
  numberOfLines,
  minimumFontScale = 0.72,
  allowFontScaling = true,
  maxFontSizeMultiplier = APP_TEXT_MAX_FONT_SIZE_MULTIPLIER,
  children,
  ...rest
}: AdaptiveTextProps) {
  // fit={false} — одна строка без сжатия шрифта (обрезка ellipsis).
  const autoFit = fit ?? numberOfLines === 1;
  const clampOneLine = autoFit || numberOfLines === 1;
  // RN Android: adjustsFontSizeToFit ужимает шрифт в закэшированном тексте и при расширении
  // назад не растит. После системного PiP (окно в разы уже) подписи навбара и CTA оставались
  // мелкими, а «1 пользователь онлайн» — «...». Другое окно — новый узел текста, мерится заново.
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const fitKey = autoFit ? `${Math.round(windowWidth)}:${fontScale}` : undefined;

  return (
    <Text
      key={fitKey}
      {...rest}
      numberOfLines={clampOneLine ? 1 : numberOfLines}
      allowFontScaling={allowFontScaling}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      adjustsFontSizeToFit={autoFit ? true : rest.adjustsFontSizeToFit}
      {...(autoFit ? { minimumFontScale } : null)}
      ellipsizeMode={clampOneLine ? rest.ellipsizeMode ?? 'tail' : rest.ellipsizeMode}
      style={style}
    >
      {children}
    </Text>
  );
}

export const AdaptiveText = memo(AdaptiveTextInner);
export default AdaptiveText;
