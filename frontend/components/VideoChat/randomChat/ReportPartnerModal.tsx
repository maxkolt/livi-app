import React from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';
import { WELCOME_HEADER_TITLE } from '../../../screens/home/constants';

/** Совпадает с backend/models/UserReport USER_REPORT_REASONS. */
export type ReportReason = 'nudity' | 'minor' | 'harassment' | 'spam' | 'other';

const REASONS: ReadonlyArray<{
  id: ReportReason;
  labelKey: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
}> = [
  { id: 'nudity', labelKey: 'reportReasonNudity', icon: 'no-adult-content' },
  { id: 'minor', labelKey: 'reportReasonMinor', icon: 'child-care' },
  { id: 'harassment', labelKey: 'reportReasonHarassment', icon: 'report' },
  { id: 'spam', labelKey: 'reportReasonSpam', icon: 'campaign' },
  { id: 'other', labelKey: 'reportReasonOther', icon: 'more-horiz' },
];

type Props = {
  visible: boolean;
  isDark: boolean;
  busy: boolean;
  L: (key: string) => string;
  onSelect: (reason: ReportReason) => void;
  onRequestClose: () => void;
  styles: {
    modalOverlay: ViewStyle;
    modalCard: ViewStyle;
    modalTitle: TextStyle;
    modalText: TextStyle;
    btnGlassBase: ViewStyle;
    btnGlassTitan: ViewStyle;
    modalBtnText: TextStyle;
  };
};

export function ReportPartnerModal({ visible, isDark, busy, L, onSelect, onRequestClose, styles }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose}>
      <View style={styles.modalOverlay}>
        <BlurView intensity={60} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]}
          onPress={busy ? undefined : onRequestClose}
        />
        <View style={[styles.modalCard, local.card]}>
          <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
            <Text style={styles.modalTitle}>{L('reportPartnerTitle')}</Text>
            <Text style={styles.modalText}>{L('reportPartnerText')}</Text>
            <View style={local.list}>
              {REASONS.map((reason) => (
                <Pressable
                  key={reason.id}
                  disabled={busy}
                  onPress={() => onSelect(reason.id)}
                  accessibilityRole="button"
                  style={({ pressed }) => [local.row, pressed && local.rowPressed, busy && local.rowBusy]}
                >
                  <MaterialIcons name={reason.icon} size={20} color={WELCOME_HEADER_TITLE} />
                  <Text style={local.rowText}>{L(reason.labelKey)}</Text>
                </Pressable>
              ))}
            </View>
            <TouchableOpacity
              style={[styles.btnGlassBase, styles.btnGlassTitan, local.cancel]}
              onPress={onRequestClose}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.modalBtnText}>{L('reportCancel')}</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const local = StyleSheet.create({
  /** В landscape карточка иначе растягивается на всю ширину и не влезает по высоте. */
  card: {
    maxWidth: 420,
    maxHeight: '90%',
  },
  list: {
    marginTop: 14,
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  rowPressed: {
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  rowBusy: {
    opacity: 0.5,
  },
  rowText: {
    flex: 1,
    color: '#ffffff',
    fontSize: 15,
  },
  cancel: {
    flex: 0,
    marginTop: 14,
  },
});
