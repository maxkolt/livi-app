import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedStyle, withTiming, type SharedValue } from 'react-native-reanimated';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { AppDialogButton } from '../../components/AppDialog';
import { WELCOME_GLASS_SURFACE } from './constants';

export type CosmeticSwipeHandle = SwipeableMethods;

function DeleteAction({ progress, revealed, disabled, label, accessibilityLabel, onPress }: {
  progress: SharedValue<number>; revealed: boolean; disabled: boolean;
  label: string; accessibilityLabel: string; onPress: () => void;
}) {
  const motion = useAnimatedStyle(() => {
    const value = Math.max(0, Math.min(1, progress.value));
    return { opacity: value, transform: [{ translateX: (1 - value) * 12 }] };
  });
  return <Animated.View style={[styles.action, motion]}
    pointerEvents={revealed && !disabled ? 'auto' : 'none'}
    accessibilityElementsHidden={!revealed}
    importantForAccessibility={revealed ? 'auto' : 'no-hide-descendants'}>
    <AppDialogButton label={label} accessibilityLabel={accessibilityLabel}
      variant="danger" stretch={false} disabled={disabled || !revealed} onPress={onPress}
      iconSize={38}
      icon={<MaterialCommunityIcons name="trash-can-outline" size={20} color="#FF939D" />} />
  </Animated.View>;
}

/** Delete is revealed by a left swipe; a tap then opens the shared confirmation. */
export function CosmeticSwipeRow({ children, deleteLabel, accessibilityLabel, disabled, onDelete, onReveal, onClose }: {
  children: React.ReactNode; deleteLabel: string; accessibilityLabel: string; disabled: boolean;
  onDelete: () => void; onReveal: (handle: CosmeticSwipeHandle) => void;
  onClose: (handle: CosmeticSwipeHandle) => void;
}) {
  const swipe = useRef<SwipeableMethods>(null);
  const [revealed, setRevealed] = useState(false);
  const tintMotion = useAnimatedStyle(() => ({ opacity: withTiming(revealed ? 1 : 0, { duration: 160 }) }));
  const contentMotion = useAnimatedStyle(() => ({ opacity: withTiming(revealed ? 0 : 1, { duration: 120 }) }));
  return <View style={[styles.shell, revealed && styles.deleting]}>
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, tintMotion]}>
      <LinearGradient colors={['rgba(255,90,103,0.025)', 'rgba(255,90,103,0.07)', 'rgba(255,90,103,0.13)']}
        start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFillObject} />
    </Animated.View>
    <Swipeable ref={swipe} enabled={!disabled}
    friction={1.5} rightThreshold={38} dragOffsetFromRightEdge={12}
    overshootLeft={false} overshootRight={false}
    onSwipeableWillOpen={() => {
      setRevealed(true);
      if (swipe.current) onReveal(swipe.current);
    }}
    onSwipeableWillClose={() => {
      setRevealed(false);
      if (swipe.current) onClose(swipe.current);
    }}
    renderRightActions={progress => <DeleteAction progress={progress} revealed={revealed}
      disabled={disabled} label={deleteLabel} accessibilityLabel={accessibilityLabel}
      onPress={() => {
        if (disabled || !revealed) return;
        swipe.current?.close(); onDelete();
      }} />}
    >
      <Animated.View collapsable={false} style={contentMotion}
        pointerEvents={revealed ? 'none' : 'auto'}
        accessibilityElementsHidden={revealed}
        importantForAccessibility={revealed ? 'no-hide-descendants' : 'auto'}>
        {children}
      </Animated.View>
    </Swipeable>
  </View>;
}

const styles = StyleSheet.create({
  shell: { backgroundColor: WELCOME_GLASS_SURFACE, borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent' },
  deleting: { borderColor: 'rgba(255,90,103,0.22)' },
  action: { width: 62, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
});
