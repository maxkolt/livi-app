import React, { memo } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { ANDROID_MENU_HIT_SLOP, CROWN_GOLD, WELCOME_CHROME_BTN_BG } from './constants';

type WelcomeCrownButtonProps = {
  onPress: () => void;
  onLongPress?: () => void;
  showBadge?: boolean;
  /** Чуть меньше круг (экран «Друзья»). */
  compact?: boolean;
};

function WelcomeCrownButtonInner({ onPress, onLongPress, showBadge, compact }: WelcomeCrownButtonProps) {
  const btnSize = compact ? 36 : 40;
  const iconSize = compact ? 20 : 22;
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={420}
        hitSlop={
          Platform.OS === 'android'
            ? ANDROID_MENU_HIT_SLOP
            : { top: 10, bottom: 10, left: 10, right: 10 }
        }
        accessibilityRole="button"
        accessibilityLabel="Profile"
        style={({ pressed }) => [
          styles.btn,
          { width: btnSize, height: btnSize, borderRadius: btnSize / 2 },
          pressed && styles.btnPressed,
        ]}
      >
        <MaterialCommunityIcons name="crown" size={iconSize} color={CROWN_GOLD} />
      </Pressable>
      {showBadge ? <View style={[styles.badge, compact && styles.badgeCompact]} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
    flexShrink: 0,
  },
  btn: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: WELCOME_CHROME_BTN_BG,
  },
  btnPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.96 }],
  },
  badge: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#FF5A67',
    borderWidth: 1.5,
    borderColor: 'rgba(10,12,20,0.95)',
  },
  badgeCompact: {
    top: 1,
    right: 1,
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});

export const WelcomeCrownButton = memo(WelcomeCrownButtonInner);
