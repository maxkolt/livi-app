import React from 'react';
import { Platform, StyleSheet, UIManager, View, type ViewProps } from 'react-native';
import { requireNativeComponentOnce } from '../../utils/requireNativeComponentOnce';

/**
 * Мягкая тень «парящего» блока (онлайн-баннер, верхние сегменты вкладок, «Пригласить
 * друзей»). На iOS — нативная тень: WELCOME_FLOAT_SHADOW_IOS в стиль самого блока.
 * На Android elevation рисует жёсткую тень снизу, поэтому — свой слой вокруг блока:
 * <WelcomeFloatShadow radius={…} /> первым ребёнком блока без overflow: hidden.
 */
export const WELCOME_FLOAT_SHADOW_IOS = Platform.select({
  ios: {
    shadowColor: '#02080d',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.22,
    shadowRadius: 12,
  },
  default: null,
});

/**
 * Маленькая тень круглых кнопок шапки (поиск, корона): ближе к кнопке, чем у блоков, и чуть
 * плотнее снизу — кнопка приподнята над стеклом, но тень не расползается.
 */
export const WELCOME_CHROME_BTN_SHADOW = {
  spread: 5,
  soft: true,
  baseOpacity: 1.4,
  dropOffset: 1.5,
  dropOpacity: 0.8,
} as const;
export const WELCOME_CHROME_BTN_SHADOW_IOS = Platform.select({
  ios: {
    shadowColor: '#02080d',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.28,
    shadowRadius: 6,
  },
  default: null,
});

const LAYERS = [
  { inset: 8, color: 'rgba(2, 8, 13, 0.018)' },
  { inset: 5, color: 'rgba(2, 8, 13, 0.028)' },
  { inset: 2, color: 'rgba(2, 8, 13, 0.04)' },
] as const;
const DEFAULT_SPREAD = LAYERS[0].inset;

/**
 * Слои выше затемняют фон меньше чем на 1 уровень из 255, и после округления тень
 * выходила тремя резкими кольцами разного оттенка — на OLED рябило. Натив (FloatShadow.kt)
 * рисует тот же тон одним слоем с плавным спадом и blue-noise дизерингом альфы.
 * Сборка без менеджера — прежние слои.
 */
const NativeFloatShadow =
  Platform.OS === 'android' && UIManager.hasViewManagerConfig('LiviFloatShadow')
    ? requireNativeComponentOnce<NativeFloatShadowProps>('LiviFloatShadow')
    : null;

type NativeFloatShadowProps = ViewProps & {
  radius: number;
  spread: number;
  dropOffset: number;
  dropOpacity: number;
  sideOpacity: number;
  baseOpacity: number;
  soft: boolean;
  ringOffset: number;
  ringOpacity: number;
  ringDrop: number;
  ringRise: number;
  ringSoft: boolean;
};

type WelcomeFloatShadowProps = {
  radius: number;
  /** Насколько тень выходит за блок, dp. */
  spread?: number;
  /** Нижний акцент: вторая тень, сдвинутая вниз на dropOffset dp (только натив). */
  dropOffset?: number;
  /** Плотность нижнего акцента относительно основной тени; 0 — без него. */
  dropOpacity?: number;
  /** Плотность акцента у боковых сторон относительно основной тени (только натив). */
  sideOpacity?: number;
  /** Плотность самой основной тени: под стеклом блока и вокруг него (только натив, 1 — обычная). */
  baseOpacity?: number;
  /** Тень гаснет сразу от края — размытая, без ровной полосы у кромки (только натив). */
  soft?: boolean;
  /** Кольцевой акцент: как нижний, но со всех сторон, раздвинут на ringOffset dp (только натив). */
  ringOffset?: number;
  /** Плотность кольцевого акцента относительно основной тени; 0 — без него. */
  ringOpacity?: number;
  /** Насколько кольцо снизу шире, чем сверху и по бокам, dp (только натив). */
  ringDrop?: number;
  /** Насколько кольцо сверху шире, чем снизу и по бокам, dp (только натив). */
  ringRise?: number;
  /** Кольцо размытое: без тёмного обода по кромке блока (только натив). */
  ringSoft?: boolean;
};

export function WelcomeFloatShadow({
  radius,
  spread = DEFAULT_SPREAD,
  dropOffset = 0,
  dropOpacity = 0,
  sideOpacity = 0,
  baseOpacity = 1,
  soft = false,
  ringOffset = 0,
  ringOpacity = 0,
  ringDrop = 0,
  ringRise = 0,
  ringSoft = false,
}: WelcomeFloatShadowProps) {
  if (Platform.OS !== 'android') return null;
  if (NativeFloatShadow) {
    const pad = spread + Math.max(0, ringOffset);
    return (
      <View
        pointerEvents="none"
        style={[
          styles.layer,
          {
            left: -pad,
            right: -pad,
            top: -pad - Math.max(0, ringRise),
            bottom: -pad - dropOffset - Math.max(0, ringDrop),
          },
        ]}
      >
        <NativeFloatShadow
          radius={radius}
          spread={spread}
          dropOffset={dropOffset}
          dropOpacity={dropOpacity}
          sideOpacity={sideOpacity}
          baseOpacity={baseOpacity}
          soft={soft}
          ringOffset={ringOffset}
          ringOpacity={ringOpacity}
          ringDrop={ringDrop}
          ringRise={ringRise}
          ringSoft={ringSoft}
          style={StyleSheet.absoluteFill}
        />
      </View>
    );
  }
  const scale = spread / DEFAULT_SPREAD;
  return (
    <>
      {LAYERS.map(({ inset, color }) => (
        <View
          key={inset}
          pointerEvents="none"
          style={[
            styles.layer,
            {
              left: -inset * scale,
              right: -inset * scale,
              top: -inset * scale,
              bottom: -inset * scale,
              borderRadius: radius + inset * scale,
              backgroundColor: color,
            },
          ]}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
  },
});
