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
  WELCOME_UNREAD_BADGE,
} from './constants';

/** Иконки и chevron в строках профиля — приглушённый серый. */
export const WELCOME_PROFILE_ROW_ICON = '#828A96';

const ROW_ICON_SIZE = 22;
const ROW_ICON_SIZE_COMPACT = 20;
const ROW_CHEVRON_SIZE = 20;
/**
 * Внутри glass-карточки — как padding у cardRow чатов/звонков.
 */
const ROW_PAD_H = 12;
const ROW_PAD_H_COMPACT = 12;
const ROW_ICON_GAP = 12;

/** Линия: от начала текста (после иконки) до начала стрелки. */
const DIVIDER_MARGIN_LEFT = ROW_PAD_H + ROW_ICON_SIZE + ROW_ICON_GAP;
const DIVIDER_MARGIN_RIGHT = ROW_PAD_H + ROW_CHEVRON_SIZE;
const DIVIDER_MARGIN_LEFT_COMPACT = ROW_PAD_H_COMPACT + ROW_ICON_SIZE_COMPACT + ROW_ICON_GAP;
const DIVIDER_MARGIN_RIGHT_COMPACT = ROW_PAD_H_COMPACT + ROW_CHEVRON_SIZE;
/** Строки без иконки (язык): от начала надписи. */
const DIVIDER_MARGIN_LEFT_TEXT_ONLY = ROW_PAD_H;
const DIVIDER_MARGIN_LEFT_TEXT_ONLY_COMPACT = ROW_PAD_H_COMPACT;

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
      <View style={styles.sectionBody}>{children}</View>
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
  /** Синий бейдж с числом справа у стрелки (например обновление). */
  badgeCount?: number;
  onPress?: () => void;
  disabled?: boolean;
  compact?: boolean;
  /** Уже строка по высоте, шрифты как обычно. */
  dense?: boolean;
  /** Ещё плотнее по высоте, шрифты как у dense (короткие телефоны). */
  tight?: boolean;
  /** Аккордеон: chevron вниз / вверх вместо вправо. */
  expandable?: boolean;
  expanded?: boolean;
  /** Разделитель под строкой (от текста до стрелки). */
  showDivider?: boolean;
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
  tight,
  expandable,
  expanded,
  badgeCount,
  showDivider = false,
}: WelcomeProfileRowProps) {
  const labelColor = destructive ? LIVI.red : WELCOME_HEADER_TITLE;
  const iconColor = destructive ? LIVI.red : WELCOME_PROFILE_ROW_ICON;
  const chevronName = expandable
    ? expanded
      ? 'chevron-up'
      : 'chevron-forward'
    : 'chevron-forward';
  return (
    <View>
      <Pressable
        onPress={onPress}
        disabled={disabled || !onPress}
        style={({ pressed }) => [
          styles.row,
          dense && styles.rowDense,
          tight && styles.rowTight,
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
          {typeof badgeCount === 'number' && badgeCount > 0 ? (
            <View style={styles.countBadge}>
              <Text style={styles.countBadgeText}>{badgeCount > 99 ? '99+' : String(badgeCount)}</Text>
            </View>
          ) : null}
          {showChevron && onPress ? (
            <Ionicons name={chevronName} size={ROW_CHEVRON_SIZE} color={WELCOME_PROFILE_ROW_ICON} />
          ) : null}
        </View>
      </Pressable>
      {showDivider ? <WelcomeProfileRowDivider compact={compact} /> : null}
    </View>
  );
}

export function WelcomeProfileRowDivider({
  compact,
  textOnly,
}: {
  compact?: boolean;
  /** Без иконки слева — линия от начала текста. */
  textOnly?: boolean;
}) {
  return (
    <View
      style={[
        styles.divider,
        textOnly
          ? compact
            ? styles.dividerTextOnlyCompact
            : styles.dividerTextOnly
          : compact
            ? styles.dividerCompact
            : null,
      ]}
    />
  );
}

type WelcomeProfileLanguageRowProps = {
  nativeName: string;
  englishName: string;
  selected?: boolean;
  rtl?: boolean;
  onPress: () => void;
  showDivider?: boolean;
  compact?: boolean;
};

/** Строка выбора языка (экран профиля, как «О приложении»). */
export function WelcomeProfileLanguageRow({
  nativeName,
  englishName,
  selected,
  rtl,
  onPress,
  showDivider = false,
  compact,
}: WelcomeProfileLanguageRowProps) {
  return (
    <View>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.row,
          compact && styles.rowCompact,
          pressed && styles.rowPressed,
        ]}
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
      {showDivider ? <WelcomeProfileRowDivider compact={compact} textOnly /> : null}
    </View>
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
  /** Glass-карточка секции (как раньше на hub профиля). */
  sectionBody: {
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
    paddingHorizontal: ROW_PAD_H,
    minHeight: 50,
  },
  rowCompact: {
    paddingVertical: 10,
    paddingHorizontal: ROW_PAD_H_COMPACT,
    minHeight: 42,
  },
  rowDense: {
    paddingVertical: 12,
    paddingHorizontal: ROW_PAD_H,
    minHeight: 48,
  },
  rowTight: {
    paddingVertical: 8,
    paddingHorizontal: ROW_PAD_H,
    minHeight: 40,
  },
  rowPressed: {
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_ICON_GAP,
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
  countBadge: {
    minWidth: 17,
    height: 17,
    paddingHorizontal: 5,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: WELCOME_UNREAD_BADGE,
    flexShrink: 0,
  },
  countBadgeText: {
    color: LIVI.white,
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 12,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: WELCOME_GLASS_BORDER,
    marginLeft: DIVIDER_MARGIN_LEFT,
    marginRight: DIVIDER_MARGIN_RIGHT,
  },
  dividerCompact: {
    marginLeft: DIVIDER_MARGIN_LEFT_COMPACT,
    marginRight: DIVIDER_MARGIN_RIGHT_COMPACT,
  },
  dividerTextOnly: {
    marginLeft: DIVIDER_MARGIN_LEFT_TEXT_ONLY,
    marginRight: DIVIDER_MARGIN_RIGHT,
  },
  dividerTextOnlyCompact: {
    marginLeft: DIVIDER_MARGIN_LEFT_TEXT_ONLY_COMPACT,
    marginRight: DIVIDER_MARGIN_RIGHT_COMPACT,
  },
});
