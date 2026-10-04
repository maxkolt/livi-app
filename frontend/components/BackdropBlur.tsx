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
 * Список между блоками с тенью: строки, уезжая под блок сверху (top) или под навбар снизу
 * (bottom), темнеют к его краю — как в тени. Темнеет только содержимое (фон между строками
 * нет), и только когда за краем ещё есть что прокручивать. Без натива — просто обёртка.
 */
export function ListEdgeShade({
  top = 0,
  bottom = 0,
  opacity,
  style,
  children,
}: {
  /** Высота полосы у верхнего края, dp; 0 — без неё. */
  top?: number;
  /** Высота полосы у нижнего края, dp; 0 — без неё. */
  bottom?: number;
  opacity: number;
  style?: ViewProps['style'];
  children: React.ReactNode;
}) {
  if (!NativeBlurSource) return <View style={style}>{children}</View>;
  return (
    <NativeBlurSource style={style} shadeTop={top} shadeBottom={bottom} shadeOpacity={opacity}>
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
