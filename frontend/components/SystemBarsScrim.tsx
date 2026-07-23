import React, { useEffect, useState } from 'react';
import { Keyboard, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Matches android colors.xml navigationBarColor / expo-navigation-bar (#B3000000). */
const SCRIM = 'rgba(0, 0, 0, 0.7)';

/**
 * Edge-to-edge (targetSdk 36): system bar colors are ignored by the OS.
 * Draw translucent black strips over the status bar and nav / gesture inset
 * so icons stay readable against scrolling content.
 *
 * Hide the bottom scrim while the IME is open — otherwise on some OEMs it
 * shows as a black seam between the chat composer and the keyboard.
 */
export default function SystemBarsScrim() {
  const insets = useSafeAreaInsets();
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  if (Platform.OS !== 'android') return null;

  return (
    <>
      {insets.top > 0 ? (
        <View
          pointerEvents="none"
          style={[styles.scrim, styles.top, { height: insets.top }]}
        />
      ) : null}
      {!keyboardVisible && insets.bottom > 0 ? (
        <View
          pointerEvents="none"
          style={[styles.scrim, styles.bottom, { height: insets.bottom }]}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: SCRIM,
    zIndex: 100000,
  },
  top: {
    top: 0,
  },
  bottom: {
    bottom: 0,
  },
});
