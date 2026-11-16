import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { AppDialogButton } from '../../components/AppDialog';
import { WELCOME_GLASS_SURFACE } from './constants';

export type CosmeticSwipeHandle = { close: () => void };

/** The gesture stays on the whole row, including when its content is hidden. */
export function CosmeticSwipeRow({ children, deleteLabel, accessibilityLabel, disabled, onDelete, onReveal, onClose }: {
  children: React.ReactNode; deleteLabel: string; accessibilityLabel: string; disabled: boolean;
  onDelete: () => void; onReveal: (handle: CosmeticSwipeHandle) => void;
  onClose: (handle: CosmeticSwipeHandle) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const mode = useRef(false);
  const callbacks = useRef({ disabled, onDelete, onReveal, onClose });
  callbacks.current = { disabled, onDelete, onReveal, onClose };
  const handle = useRef<CosmeticSwipeHandle | null>(null);
  const progress = useSharedValue(0);
  const dragOrigin = useSharedValue(0);
  const settledOpen = useSharedValue(false);
  const changeMode = useCallback((next: boolean, animate = true) => {
    if (callbacks.current.disabled) return;
    if (animate) {
      settledOpen.value = next;
      progress.value = withTiming(next ? 1 : 0, { duration: 160 });
    }
    if (mode.current === next) return;
    mode.current = next;
    setRevealed(next);
    if (handle.current) {
      if (next) callbacks.current.onReveal(handle.current);
      else callbacks.current.onClose(handle.current);
    }
  }, [progress, settledOpen]);
  if (!handle.current) handle.current = { close: () => changeMode(false) };
  const pan = useMemo(() => Gesture.Pan()
    .enabled(!disabled)
    .activeOffsetX([-12, 12])
    .failOffsetY([-16, 16])
    .onStart(() => {
      cancelAnimation(progress);
      dragOrigin.value = progress.value;
    })
    .onUpdate(event => {
      progress.value = Math.max(0, Math.min(1, dragOrigin.value - event.translationX / 96));
    })
    .onEnd(event => {
      const next = event.translationX < -28 ? true : event.translationX > 28 ? false : settledOpen.value;
      settledOpen.value = next;
      progress.value = withTiming(next ? 1 : 0, { duration: 160 });
      runOnJS(changeMode)(next, false);
    })
    .onFinalize((_event, success) => {
      if (!success) progress.value = withTiming(settledOpen.value ? 1 : 0, { duration: 160 });
    }), [disabled, changeMode, dragOrigin, progress, settledOpen]);
  const borderMotion = useAnimatedStyle(() => ({ borderColor: `rgba(255,90,103,${progress.value * 0.14})` }));
  const tintMotion = useAnimatedStyle(() => ({ opacity: progress.value }));
  const contentMotion = useAnimatedStyle(() => ({
    opacity: 1 - progress.value,
    transform: [{ translateX: -48 * progress.value }],
  }));
  const actionMotion = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateX: (1 - progress.value) * 16 }],
  }));
  return <GestureDetector gesture={pan}>
    <Animated.View collapsable={false} style={[styles.shell, borderMotion]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, tintMotion]}>
        <LinearGradient colors={['rgba(255,90,103,0.02)', 'rgba(255,90,103,0.045)', 'rgba(255,90,103,0.085)']}
          start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFillObject} />
      </Animated.View>
      <Animated.View style={contentMotion} pointerEvents={revealed ? 'none' : 'auto'}
        accessibilityElementsHidden={revealed}
        importantForAccessibility={revealed ? 'no-hide-descendants' : 'auto'}>
        {children}
      </Animated.View>
      <Animated.View style={[styles.actions, actionMotion]}
        pointerEvents={revealed && !disabled ? 'box-none' : 'none'}
        accessibilityElementsHidden={!revealed}
        importantForAccessibility={revealed ? 'auto' : 'no-hide-descendants'}>
        <Pressable style={StyleSheet.absoluteFillObject} onPress={() => changeMode(false)} accessible={false} />
        <AppDialogButton label={deleteLabel} accessibilityLabel={accessibilityLabel}
          variant="danger" stretch={false} disabled={disabled || !revealed} iconSize={38}
          icon={<MaterialCommunityIcons name="trash-can-outline" size={20} color="#FF939D" />}
          onPress={() => {
            if (callbacks.current.disabled || !mode.current) return;
            changeMode(false);
            callbacks.current.onDelete();
          }} />
      </Animated.View>
    </Animated.View>
  </GestureDetector>;
}

const styles = StyleSheet.create({
  shell: { backgroundColor: WELCOME_GLASS_SURFACE, borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent' },
  actions: { ...StyleSheet.absoluteFillObject, paddingHorizontal: 12, alignItems: 'flex-end', justifyContent: 'center' },
});
