import React, { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CROWN_GOLD, WELCOME_CHROME_BTN_BG } from './constants';

type WelcomeCrownButtonProps = {
  /** @deprecated Decorative for now — ignored. */
  onPress?: () => void;
  /** @deprecated Decorative for now — ignored. */
  onLongPress?: () => void;
  /** @deprecated Badge hidden while decorative. */
  showBadge?: boolean;
  /** Чуть меньше круг (экран «Друзья»). */
  compact?: boolean;
};

/** Корона в welcome chrome — пока только декор, без тапа и без бейджа. */
function WelcomeCrownButtonInner({ compact }: WelcomeCrownButtonProps) {
  const btnSize = compact ? 36 : 40;
  const iconSize = compact ? 20 : 22;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.btn,
        { width: btnSize, height: btnSize, borderRadius: btnSize / 2 },
      ]}
    >
      <MaterialCommunityIcons name="crown" size={iconSize} color={CROWN_GOLD} />
    </View>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: WELCOME_CHROME_BTN_BG,
  },
});

export const WelcomeCrownButton = memo(WelcomeCrownButtonInner);
