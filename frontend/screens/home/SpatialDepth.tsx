import React from 'react';
import { Platform, StyleSheet, UIManager, View, type ViewProps } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { requireNativeComponentOnce } from '../../utils/requireNativeComponentOnce';
import { HOME_NAV_BG } from './constants';

/**
 * Пространственная глубина главного экрана (SpatialDepth.kt): сцена за стеклом
 * смещается вслед за глазом по гироскопу. Интерфейс — плоскость экрана и стоит на месте:
 * радар, кнопки и списки при наклоне не двигаются, иначе при входе в приложение с наклоном
 * было видно, как они сами доезжают на место. Весь расчёт и сдвиг — в нативе на одном
 * кадре Choreographer, JS только включает эффект. Сборка без менеджеров — сплошной фон.
 */
const NativeSpatialBackground =
  Platform.OS === 'android' && UIManager.hasViewManagerConfig('LiviSpatialBackground')
    ? requireNativeComponentOnce<ViewProps & { active: boolean }>('LiviSpatialBackground')
    : null;

const NativeSpatialGlass =
  Platform.OS === 'android' && UIManager.hasViewManagerConfig('LiviSpatialGlass')
    ? requireNativeComponentOnce<ViewProps & { radius: number; tint: string; fallbackColor: string; sheen?: boolean }>(
        'LiviSpatialGlass',
      )
    : null;

/** Блоки главного экрана — стекло над сценой (иначе сплошная заливка, как раньше). */
export const SPATIAL_GLASS_AVAILABLE = !!NativeSpatialGlass;

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

/**
 * Стеклянная подложка блока: первым ребёнком, блок — с прозрачным фоном и тем же
 * скруглением. Под собой показывает размытую сцену, сверху tint; без сцены (другой экран) —
 * сплошной fallbackColor, то есть прежний цвет блока.
 */
export function SpatialGlass({
  radius,
  tint,
  fallbackColor,
  sheen = true,
}: {
  radius: number;
  tint: string;
  fallbackColor: string;
  /** Блик по верху; false — блок одного тона сверху донизу. */
  sheen?: boolean;
}) {
  if (!NativeSpatialGlass) return null;
  return (
    <NativeSpatialGlass
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      radius={radius}
      tint={tint}
      fallbackColor={fallbackColor}
      sheen={sheen}
    />
  );
}

const styles = StyleSheet.create({
  fallback: { backgroundColor: HOME_NAV_BG },
});
