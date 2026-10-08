import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { WELCOME_HEADER_TITLE } from '../../../screens/home/constants';
import { AppDialogModal, appDialogStyles } from '../../AppDialog';

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
  busy: boolean;
  L: (key: string) => string;
  onSelect: (reason: ReportReason) => void;
  onRequestClose: () => void;
};

export function ReportPartnerModal({ visible, busy, L, onSelect, onRequestClose }: Props) {
  return (
    <AppDialogModal
      visible={visible}
      // Жалоба уходит — окно держим, пока не придёт ответ.
      onRequestClose={busy ? undefined : onRequestClose}
      dismissOnBackdrop={!busy}
      title={L('reportPartnerTitle')}
      message={L('reportPartnerText')}
      actions={[{ label: L('reportCancel'), onPress: onRequestClose, busy }]}
    >
      <View style={[appDialogStyles.section, local.list]}>
        {REASONS.map((reason) => (
          <Pressable
            key={reason.id}
            disabled={busy}
            onPress={() => onSelect(reason.id)}
            accessibilityRole="button"
            style={({ pressed }) => [
              appDialogStyles.option,
              pressed && appDialogStyles.optionPressed,
              busy && local.rowBusy,
            ]}
          >
            <MaterialIcons name={reason.icon} size={20} color={WELCOME_HEADER_TITLE} />
            <Text style={appDialogStyles.optionText}>{L(reason.labelKey)}</Text>
          </Pressable>
        ))}
      </View>
    </AppDialogModal>
  );
}

const local = StyleSheet.create({
  list: {
    gap: 8,
  },
  rowBusy: {
    opacity: 0.5,
  },
});
