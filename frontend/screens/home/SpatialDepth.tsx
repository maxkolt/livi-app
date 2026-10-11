import React from 'react';
import { Platform, StyleSheet, UIManager, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { requireNativeComponentOnce } from '../../utils/requireNativeComponentOnce';
import { HOME_NAV_BG } from './constants';

/**
 * Пространственная глубина главного экрана (SpatialDepth.kt): сцена за стеклом
 * смещается вслед за глазом по гироскопу, интерфейс парит перед ним и смещается
 * навстречу. Весь расчёт и сдвиг — в нативе на одном кадре Choreographer, JS только
 * включает эффект. Сборка без менеджеров — сплошной фон и неподвижные слои.
 */
const NativeSpatialBackground =
  Platform.OS === 'android' && UIManager.hasViewManagerConfig('LiviSpatialBackground')
    ? requireNativeComponentOnce<ViewProps & { active: boolean }>('LiviSpatialBackground')
    : null;

const NativeSpatialGlass =
  Platform.OS === 'android' && UIManager.hasViewManagerConfig('LiviSpatialGlass')
    ? requireNativeComponentOnce<ViewProps & { radius: number; tint: string; fallbackColor: string }>('LiviSpatialGlass')
    : null;

/** Блоки главного экрана — стекло над сценой (иначе сплошная заливка, как раньше). */
export const SPATIAL_GLASS_AVAILABLE = !!NativeSpatialGlass;

const NativeSpatialLayer =
  Platform.OS === 'android' && UIManager.hasViewManagerConfig('LiviSpatialLayer')
    ? requireNativeComponentOnce<ViewProps & { depth: number; layerEnabled: boolean }>('LiviSpatialLayer')
    : null;

/** Насколько парят слои интерфейса при полном наклоне, dp (сцена за стеклом — 5…14 dp). */
export const SPATIAL_DEPTH = {
  /** Содержимое вкладок: аватар, радар, карточки, списки. */
  content: 6,
  /** Навбар — чуть ближе к стеклу, чем содержимое под ним. */
  tabBar: 4,
} as const;

/**
 * Дальний слой главного экрана. Датчик работает, только пока экран в фокусе и
 * enabled (на вкладке с видео во весь экран сцены не видно — незачем).
 */
export function SpatialStageBackground({ enabled = true }: { enabled?: boolean }) {
  const focused = useIsFocused();
  if (!NativeSpatialBackground) {
    return <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.fallback]} />;
  }
  return (
    <NativeSpatialBackground
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      active={focused && enabled}
    />
  );
}

/** Слой интерфейса над сценой. enabled=false — плавно встаёт на место. */
export function SpatialLayer({
  depth,
  enabled = true,
  style,
  children,
  ...rest
}: ViewProps & { depth: number; enabled?: boolean; style?: StyleProp<ViewStyle> }) {
  if (!NativeSpatialLayer) {
    return (
      <View style={style} {...rest}>
        {children}
      </View>
    );
  }
  return (
    <NativeSpatialLayer style={style} depth={depth} layerEnabled={enabled} {...rest}>
      {children}
    </NativeSpatialLayer>
  );
}

/**
 * Стеклянная подложка блока: первым ребёнком, блок — с прозрачным фоном и тем же
 * скруглением. Под собой показывает размытую сцену, сверху tint; без сцены (другой экран) —
 * сплошной fallbackColor, то есть прежний цвет блока.
 */
export function SpatialGlass({
  radius,
  tint,
  fallbackColor,
}: {
  radius: number;
  tint: string;
  fallbackColor: string;
}) {
  if (!NativeSpatialGlass) return null;
  return (
    <NativeSpatialGlass
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      radius={radius}
      tint={tint}
      fallbackColor={fallbackColor}
    />
  );
}

const styles = StyleSheet.create({
  fallback: { backgroundColor: HOME_NAV_BG },
});
