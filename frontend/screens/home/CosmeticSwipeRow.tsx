import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, withTiming } from 'react-native-reanimated';
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
  const changeMode = useCallback((next: boolean) => {
    if (callbacks.current.disabled || mode.current === next) return;
    mode.current = next;
    setRevealed(next);
    if (handle.current) {
      if (next) callbacks.current.onReveal(handle.current);
      else callbacks.current.onClose(handle.current);
    }
  }, []);
  if (!handle.current) handle.current = { close: () => changeMode(false) };
  const pan = useMemo(() => Gesture.Pan()
    .enabled(!disabled)
    .activeOffsetX([-12, 12])
    .failOffsetY([-16, 16])
    .onEnd(event => {
      if (event.translationX < -28) runOnJS(changeMode)(true);
      else if (event.translationX > 28) runOnJS(changeMode)(false);
    }), [disabled, changeMode]);
  const tintMotion = useAnimatedStyle(() => ({ opacity: withTiming(revealed ? 1 : 0, { duration: 160 }) }));
  const contentMotion = useAnimatedStyle(() => ({ opacity: withTiming(revealed ? 0 : 1, { duration: 120 }) }));
  const actionMotion = useAnimatedStyle(() => ({
    opacity: withTiming(revealed ? 1 : 0, { duration: 140 }),
    transform: [{ translateX: withTiming(revealed ? 0 : 10, { duration: 140 }) }],
  }));
  return <GestureDetector gesture={pan}>
    <View collapsable={false} style={[styles.shell, revealed && styles.deleting]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, tintMotion]}>
        <LinearGradient colors={['rgba(255,90,103,0.025)', 'rgba(255,90,103,0.07)', 'rgba(255,90,103,0.13)']}
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
    </View>
  </GestureDetector>;
}

const styles = StyleSheet.create({
  shell: { backgroundColor: WELCOME_GLASS_SURFACE, borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent' },
  deleting: { borderColor: 'rgba(255,90,103,0.22)' },
  actions: { ...StyleSheet.absoluteFillObject, paddingHorizontal: 12, alignItems: 'flex-end', justifyContent: 'center' },
});
