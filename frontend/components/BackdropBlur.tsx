import React from 'react';
import { Platform, StyleSheet, UIManager, View, type ColorValue, type ViewProps } from 'react-native';
import { requireNativeComponentOnce } from '../utils/requireNativeComponentOnce';

/**
 * Android: стекло без программной перерисовки окна (BackdropBlur.kt).
 *
 * expo-blur (Dimezis) на каждом кадре прокрутки рисовал всё окно на CPU — дважды, для шапки
 * и композера чата: ~75 fps вместо 120 на A35. Здесь источник записывает своих детей в
 * RenderNode, а стекло размывает тот же RenderNode на GPU.
 */
type BlurSourceProps = ViewProps & {
  sourceId?: string;
  /** Растворение краёв (dp): сверху — от прозрачного к видимому, снизу — наоборот. */
  fadeTop?: number;
  fadeBottom?: number;
  /** Строки темнеют к верхнему краю на высоте shadeTop (dp): уходят в тень блока над списком. */
  shadeTop?: number;
  /** То же у нижнего края (dp): строки уходят в тень навбара под списком. */
  shadeBottom?: number;
  /** Затемнение строк у самого края, 0–1. */
  shadeOpacity?: number;
};

type BlurBackdropProps = ViewProps & {
  /** Рисуются под стеклом как есть (основной фон, обои). */
  backgroundSources?: readonly string[];
  /** Рисуются под стеклом размытыми (лента). */
  blurSources?: readonly string[];
  /** Как у expo-blur на Android: intensity / blurReductionFactor. */
  blurRadius?: number;
  overlayColor?: ColorValue;
  matteColor?: ColorValue;
  fadeColors?: readonly ColorValue[];
  fadeLocations?: readonly number[];
  mirror?: boolean;
};

const androidApi = Platform.OS === 'android' ? Number(Platform.Version) : 0;

/** RenderNode — Android 10+. */
export const NativeBlurSource =
  androidApi >= 29 && UIManager.hasViewManagerConfig('LiviBlurSource')
    ? requireNativeComponentOnce<BlurSourceProps>('LiviBlurSource')
    : null;

/** RenderEffect — Android 12+. */
export const NativeBlurBackdrop =
  NativeBlurSource && androidApi >= 31 && UIManager.hasViewManagerConfig('LiviBlurBackdrop')
    ? requireNativeComponentOnce<BlurBackdropProps>('LiviBlurBackdrop')
    : null;

/** Источники для стекла chrome: фон без размытия, лента — с размытием. */
export type BackdropSources = {
  background: readonly string[];
  blur: readonly string[];
};

/**
 * Всё приложение под модалками: обёртка навигатора в App.tsx. Модалки (порталы Paper)
 * лежат вне неё, поэтому их стекло размывает экран под собой, а не само себя.
 */
export const APP_BLUR_SOURCE = 'app-root';
export const APP_BACKDROP: BackdropSources = { background: [], blur: [APP_BLUR_SOURCE] };

/**
 * Список под стеклом (шапка вкладки, навбар): строки пишутся в RenderNode, стекло размывает
 * их на GPU. Без нативного стекла — обычная обёртка.
 */
export function BlurListSource({
  sourceId,
  style,
  fadeBottom,
  children,
}: {
  sourceId: string;
  style?: ViewProps['style'];
  /** Растворение нижнего края, dp. */
  fadeBottom?: number;
  children: React.ReactNode;
}) {
  if (!NativeBlurBackdrop || !NativeBlurSource) return <View style={style}>{children}</View>;
  return (
    <NativeBlurSource sourceId={sourceId} style={style} fadeBottom={fadeBottom}>
      {children}
    </NativeBlurSource>
  );
}

/** Фоновый источник на весь экран; без нативного стекла — просто дети. */
export function BlurSourceFill({ sourceId, children }: { sourceId: string; children: React.ReactNode }) {
  if (!NativeBlurBackdrop || !NativeBlurSource) return <>{children}</>;
  return (
    <NativeBlurSource sourceId={sourceId} style={StyleSheet.absoluteFill} pointerEvents="none">
      {children}
    </NativeBlurSource>
  );
}
