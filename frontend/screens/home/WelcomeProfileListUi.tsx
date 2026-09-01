import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  LIVI,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS,
  WELCOME_GLASS_BORDER,
  WELCOME_GLASS_SURFACE,
  WELCOME_HEADER_TITLE,
  WELCOME_BRAND_VI_FILL_GRADIENT,
} from './constants';

/** Иконки и chevron в строках профиля — приглушённый серый. */
export const WELCOME_PROFILE_ROW_ICON = '#828A96';

const ROW_ICON_SIZE = 22;
const ROW_ICON_SIZE_COMPACT = 20;
const ROW_CHEVRON_SIZE = 20;

export function WelcomeProfileSection({
  title,
  compact,
  dense,
  children,
}: {
  title?: string;
  compact?: boolean;
  /** Меньше отступы между блоками (hub профиля). */
  dense?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.sectionWrap, compact && styles.sectionWrapCompact, dense && styles.sectionWrapDense]}>
      {title ? <Text style={styles.sectionTitle}>{title}</Text> : null}
      <View style={styles.card}>{children}</View>
    </View>
  );
}

type WelcomeProfileRowProps = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value?: string;
  /** Крупнее value (ник в списке). */
  largeValue?: boolean;
  destructive?: boolean;
  showChevron?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  compact?: boolean;
  /** Уже строка по высоте, шрифты как обычно. */
  dense?: boolean;
  /** Аккордеон: chevron вниз / вверх вместо вправо. */
  expandable?: boolean;
  expanded?: boolean;
};

export function WelcomeProfileRow({
  icon,
  label,
  value,
  largeValue,
  destructive,
  showChevron = true,
  onPress,
  disabled,
  compact,
  dense,
  expandable,
  expanded,
}: WelcomeProfileRowProps) {
  const labelColor = destructive ? LIVI.red : WELCOME_HEADER_TITLE;
  const iconColor = destructive ? LIVI.red : WELCOME_PROFILE_ROW_ICON;
  const chevronName = expandable
    ? expanded
      ? 'chevron-up'
      : 'chevron-forward'
    : 'chevron-forward';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      style={({ pressed }) => [
        styles.row,
        dense && styles.rowDense,
        compact && styles.rowCompact,
        pressed && onPress ? styles.rowPressed : null,
      ]}
      accessibilityRole="button"
    >
      <View style={styles.rowLeft}>
        <Ionicons name={icon} size={compact ? ROW_ICON_SIZE_COMPACT : ROW_ICON_SIZE} color={iconColor} />
        <Text
          style={[styles.rowLabel, compact && styles.rowLabelCompact, { color: labelColor }]}
          numberOfLines={1}
        >
          {label}
        </Text>
      </View>
      <View style={styles.rowRight}>
        {value ? (
          <Text style={[styles.rowValue, largeValue && styles.rowValueLarge]} numberOfLines={1}>
            {value}
          </Text>
        ) : null}
        {showChevron && onPress ? (
          <Ionicons name={chevronName} size={ROW_CHEVRON_SIZE} color={WELCOME_PROFILE_ROW_ICON} />
        ) : null}
      </View>
    </Pressable>
  );
}

export function WelcomeProfileRowDivider({ compact }: { compact?: boolean }) {
  return <View style={[styles.divider, compact && styles.dividerCompact]} />;
}

type WelcomeProfileLanguageRowProps = {
  nativeName: string;
  englishName: string;
  selected?: boolean;
  rtl?: boolean;
  onPress: () => void;
};

/** Строка выбора языка (экран профиля, как «О приложении»). */
export function WelcomeProfileLanguageRow({
  nativeName,
  englishName,
  selected,
  rtl,
  onPress,
}: WelcomeProfileLanguageRowProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
    >
      <View style={[styles.rowLeft, styles.rowLeftLanguage]}>
        <Text
          style={[
            styles.rowLabel,
            { color: WELCOME_HEADER_TITLE },
            rtl && styles.rowLabelRtl,
          ]}
          numberOfLines={1}
        >
          {nativeName}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.rowValue} numberOfLines={1}>
          {englishName}
        </Text>
        {selected ? (
          <Ionicons
            name="checkmark"
            size={ROW_CHEVRON_SIZE}
            color={WELCOME_BRAND_VI_FILL_GRADIENT[1]}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sectionWrap: {
    marginHorizontal: WELCOME_FRIENDS_LIST_INSET,
    marginBottom: 12,
  },
  sectionWrapCompact: {
    marginBottom: 7,
  },
  sectionWrapDense: {
    marginBottom: 0,
  },
  sectionTitle: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 8,
    marginLeft: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  card: {
    borderRadius: WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS,
    backgroundColor: WELCOME_GLASS_SURFACE,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 14,
    minHeight: 50,
  },
  rowCompact: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    minHeight: 42,
  },
  rowDense: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    minHeight: 47,
  },
  rowPressed: {
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
    minWidth: 0,
    paddingRight: 8,
  },
  rowLeftLanguage: {
    gap: 0,
  },
  rowLabel: {
    fontSize: 15,
    fontWeight: '500',
    flexShrink: 1,
  },
  rowLabelRtl: {
    writingDirection: 'rtl',
    textAlign: 'left',
  },
  rowLabelCompact: {
    fontSize: 14,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
    maxWidth: '46%',
  },
  rowValue: {
    color: WELCOME_PROFILE_ROW_ICON,
    fontSize: 13,
    fontWeight: '400',
  },
  rowValueLarge: {
    color: WELCOME_PROFILE_ROW_ICON,
    fontSize: 14,
    fontWeight: '400',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: WELCOME_GLASS_BORDER,
    marginLeft: 14,
  },
  dividerCompact: {
    marginLeft: 12,
  },
});
