import React, { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LIVI, WELCOME_CHROME_BTN_BG, WELCOME_HEADER_TITLE } from './constants';
import { WELCOME_SEGMENT_ACTIVE } from './FriendsListCore';

type WelcomeSelectModeHeaderProps = {
  selectedCount: number;
  visibleCount: number;
  allSelected: boolean;
  deleting?: boolean;
  cancelA11y: string;
  selectAllLabel: string;
  selectAllA11y: string;
  deleteA11y: string;
  onCancel: () => void;
  onToggleSelectAll: () => void;
  onDelete: () => void;
};

function WelcomeSelectModeHeaderInner({
  selectedCount,
  visibleCount,
  allSelected,
  deleting = false,
  cancelA11y,
  selectAllLabel,
  selectAllA11y,
  deleteA11y,
  onCancel,
  onToggleSelectAll,
  onDelete,
}: WelcomeSelectModeHeaderProps) {
  const canSelectAll = visibleCount > 0 && !deleting;
  const canDelete = selectedCount > 0 && !deleting;

  return (
    <>
      <Pressable
        style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
        accessibilityRole="button"
        accessibilityLabel={cancelA11y}
        onPress={onCancel}
      >
        <Ionicons name="close" size={22} color={LIVI.white} />
      </Pressable>

      <Text style={styles.selectTitle} numberOfLines={1}>
        {String(selectedCount)}
      </Text>

      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [
            styles.selectAllPill,
            allSelected && styles.selectAllPillActive,
            !canSelectAll && styles.iconBtnDisabled,
            pressed && canSelectAll && styles.iconBtnPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={selectAllA11y}
          accessibilityState={{ selected: allSelected, disabled: !canSelectAll }}
          disabled={!canSelectAll}
          onPress={onToggleSelectAll}
        >
          <Ionicons
            name={allSelected ? 'checkmark-circle' : 'ellipse-outline'}
            size={16}
            color={allSelected ? WELCOME_SEGMENT_ACTIVE : LIVI.white}
          />
          <Text style={[styles.selectAllLabel, allSelected && styles.selectAllLabelActive]}>
            {selectAllLabel}
          </Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.iconBtn,
            !canDelete && styles.iconBtnDisabled,
            pressed && canDelete && styles.iconBtnPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={deleteA11y}
          disabled={!canDelete}
          onPress={onDelete}
        >
          <Ionicons name="trash-outline" size={20} color={LIVI.red} />
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  selectTitle: {
    flex: 1,
    minWidth: 0,
    color: WELCOME_HEADER_TITLE,
    fontSize: 20,
    fontWeight: '500',
    letterSpacing: -0.3,
    textAlign: 'center',
    marginHorizontal: 8,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: WELCOME_CHROME_BTN_BG,
  },
  iconBtnPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.96 }],
  },
  iconBtnDisabled: {
    opacity: 0.4,
  },
  selectAllPill: {
    height: 40,
    paddingHorizontal: 12,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: WELCOME_CHROME_BTN_BG,
  },
  selectAllPillActive: {
    backgroundColor: 'rgba(42, 88, 104, 0.45)',
  },
  selectAllLabel: {
    color: LIVI.white,
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  selectAllLabelActive: {
    color: WELCOME_SEGMENT_ACTIVE,
  },
});

export const WelcomeSelectModeHeader = memo(WelcomeSelectModeHeaderInner);
