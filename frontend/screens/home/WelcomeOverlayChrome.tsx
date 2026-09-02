import React from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  LIVI,
  WELCOME_BRAND_VI_FILL_GRADIENT,
  WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS,
  WELCOME_GLASS_BORDER,
  WELCOME_GLASS_SURFACE,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
} from './constants';

/** Спокойное затемнение без тяжёлого Blur (стабильнее на Android). */
export const WELCOME_OVERLAY_DIM = 'rgba(0, 0, 0, 0.62)';

export const WELCOME_OVERLAY_ACCENT = WELCOME_BRAND_VI_FILL_GRADIENT[1];

export function WelcomeOverlayDim() {
  return <View style={styles.dim} pointerEvents="none" />;
}

type WelcomeOverlayBackProps = {
  onPress: () => void;
};

/** Простой chevron без круга — как в profile sub-screens. */
export function WelcomeOverlayBack({ onPress }: WelcomeOverlayBackProps) {
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      hitSlop={10}
      style={({ pressed }) => [
        styles.backBtn,
        {
          top: insets.top + (Platform.OS === 'android' ? 12 : 8),
          left: 12,
        },
        pressed && styles.backBtnPressed,
      ]}
    >
      <Ionicons name="chevron-back" size={22} color={LIVI.white} />
    </Pressable>
  );
}

type WelcomeOverlayCardProps = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function WelcomeOverlayCard({ children, style }: WelcomeOverlayCardProps) {
  return <View style={[styles.card, style]}>{children}</View>;
}

type WelcomeOverlayPillProps = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  leading?: React.ReactNode;
};

export function WelcomeOverlayPill({
  label,
  onPress,
  variant = 'primary',
  disabled,
  style,
  leading,
}: WelcomeOverlayPillProps) {
  const tone =
    variant === 'danger'
      ? styles.pillDanger
      : variant === 'secondary'
        ? styles.pillSecondary
        : styles.pillPrimary;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.pill,
        tone,
        disabled && styles.pillDisabled,
        pressed && !disabled && styles.pillPressed,
        style,
      ]}
    >
      {leading}
      <Text
        style={[
          styles.pillLabel,
          variant === 'secondary' && styles.pillLabelSecondary,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  dim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: WELCOME_OVERLAY_DIM,
  },
  backBtn: {
    position: 'absolute',
    zIndex: 10,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnPressed: {
    opacity: 0.72,
  },
  card: {
    width: '92%',
    maxWidth: 400,
    minWidth: 280,
    backgroundColor: WELCOME_GLASS_SURFACE,
    borderRadius: WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
    padding: 18,
  },
  pill: {
    minHeight: 46,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  pillPrimary: {
    backgroundColor: WELCOME_OVERLAY_ACCENT,
  },
  pillSecondary: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
  },
  pillDanger: {
    backgroundColor: 'rgba(255, 90, 103, 0.88)',
  },
  pillDisabled: {
    opacity: 0.55,
  },
  pillPressed: {
    opacity: 0.88,
    transform: [{ scale: 0.99 }],
  },
  pillLabel: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 15,
    fontWeight: '600',
  },
  pillLabelSecondary: {
    color: WELCOME_HEADER_TITLE,
  },
});

export const welcomeOverlayText = StyleSheet.create({
  title: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 13,
    fontWeight: '400',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 18,
  },
  label: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 8,
  },
  body: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  strong: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  linkField: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  linkText: {
    flex: 1,
    color: WELCOME_HEADER_TITLE,
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  copyBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(42, 88, 104, 0.45)',
  },
  hint: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 16,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  avatarFallback: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: WELCOME_OVERLAY_ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
});
