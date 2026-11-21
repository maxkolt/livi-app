import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/** The badge sits at 45 degrees, with only its inner edge overlapping the circle. */
export function profileAvatarDeleteInset(diameter: number, buttonSize: number): number {
  const radius = diameter / 2;
  const buttonRadius = buttonSize / 2;
  return radius - (radius + buttonRadius * 0.55) / Math.SQRT2 - buttonRadius;
}

type Props = {
  children: React.ReactNode;
  diameter: number;
  buttonSize: number;
  disabled: boolean;
  active: boolean;
  saveSuccessId: number;
  savedLabel: string;
  deleteLabel: string;
  deleteColor: string;
  onPress?: () => void;
  onDelete?: () => void;
};

export function ProfileAvatar({
  children, diameter, buttonSize, disabled, active, saveSuccessId,
  savedLabel, deleteLabel, deleteColor, onPress, onDelete,
}: Props) {
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.7)).current;
  const consumedSuccess = useRef(saveSuccessId);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    const fresh = saveSuccessId > consumedSuccess.current;
    consumedSuccess.current = saveSuccessId;
    setShowSaved(false);
    opacity.setValue(0);
    if (!fresh || !active || disabled) return;

    setShowSaved(true);
    scale.setValue(0.7);
    const animation = Animated.parallel([
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
        Animated.delay(1350),
        Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.spring(scale, { toValue: 1.08, friction: 7, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]),
    ]);
    animation.start(({ finished }) => { if (finished) setShowSaved(false); });
    return () => animation.stop();
  }, [active, disabled, opacity, saveSuccessId, scale]);

  const inset = profileAvatarDeleteInset(diameter, buttonSize);
  const checkSize = Math.round(Math.max(27, diameter * 0.29));
  return (
    <View testID="profile-avatar" style={{ width: diameter, height: diameter, position: 'relative' }}>
      <Pressable
        testID="profile-avatar-picker"
        onPress={onPress}
        disabled={disabled}
        style={styles.photo}
      >
        {children}
      </Pressable>
      {showSaved ? (
        <Animated.View
          testID="profile-avatar-saved"
          pointerEvents="none"
          accessible
          accessibilityLabel={savedLabel}
          style={[styles.saved, { opacity, transform: [{ scale }] }]}
        >
          <View style={[styles.check, { width: checkSize + 5, height: checkSize + 5, borderRadius: (checkSize + 5) / 2 }]}>
            <Ionicons name="checkmark" size={checkSize} color="#34D399" />
          </View>
        </Animated.View>
      ) : null}
      {onDelete ? (
        <Pressable
          testID="profile-avatar-delete"
          style={[styles.delete, {
            right: inset, bottom: Math.max(0, inset), width: buttonSize, height: buttonSize,
            borderRadius: buttonSize / 2,
          }]}
          onPress={onDelete}
          disabled={disabled}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={deleteLabel}
        >
          <Ionicons name="trash-outline" size={Math.round(buttonSize / 2)} color={deleteColor} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  photo: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  delete: {
    position: 'absolute', backgroundColor: 'rgba(0, 0, 0, 0.52)',
    alignItems: 'center', justifyContent: 'center',
  },
  saved: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  check: { backgroundColor: 'rgba(9, 29, 22, 0.82)', alignItems: 'center', justifyContent: 'center' },
});
