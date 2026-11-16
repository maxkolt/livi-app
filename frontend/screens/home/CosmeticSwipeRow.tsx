import React, { useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
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
      variant="danger" stretch={false} disabled={disabled || !revealed} onPress={onPress} />
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
  return <Swipeable ref={swipe} enabled={!disabled}
    friction={1.5} rightThreshold={38} dragOffsetFromRightEdge={12}
    overshootLeft={false} overshootRight={false}
    childrenContainerStyle={styles.content}
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
  >{children}</Swipeable>;
}

const styles = StyleSheet.create({
  content: { backgroundColor: WELCOME_GLASS_SURFACE },
  action: { width: 124, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
});
