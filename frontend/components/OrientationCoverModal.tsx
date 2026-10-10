import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Portal } from 'react-native-paper';
import { HOME_NAV_BG } from '../screens/home/constants';

/**
 * Шторка поворота в том же окне (Paper Portal), без RN Modal.
 * Modal открывает Dialog и включает contrast-скрим у системных кнопок —
 * тёмная полупрозрачная полоса и мерцание при появлении/снятии.
 */
export function OrientationCoverModal({ covering }: { covering: boolean }) {
  if (!covering) return null;
  return (
    <Portal>
      <View style={styles.fill} pointerEvents="none" collapsable={false} />
    </Portal>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: HOME_NAV_BG,
    zIndex: 99999,
    elevation: 99999,
  },
});
