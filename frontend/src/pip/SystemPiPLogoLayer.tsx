import React from 'react';
import { Image, Platform, StyleSheet, View } from 'react-native';
import { usePiP } from './PiPContext';

/**
 * Fallback для iOS / если нативный backdrop не поднялся.
 * На Android system PiP — нативный overlay в MainActivity (system_pip_backdrop.xml + livi_pip_placeholder).
 */
export default function SystemPiPLogoLayer() {
  const { inSystemPiPMode, pendingSystemPiP } = usePiP();
  if (Platform.OS === 'android') {
    return null;
  }
  let backdropRef = false;
  try {
    backdropRef = (global as any).__systemPiPLiViBackdropActiveRef?.current === true;
  } catch (_) {}
  if (!inSystemPiPMode && !pendingSystemPiP && !backdropRef) return null;

  return (
    <View style={styles.root} pointerEvents="none" collapsable={false}>
      <Image source={require('../../assets/splash-icon.png')} style={styles.logo} resizeMode="contain" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 9999,
    backgroundColor: '#0a0a0c',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 120,
    height: 120,
    opacity: 0.92,
  },
});
