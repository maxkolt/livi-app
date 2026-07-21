import React from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { t } from '../../../utils/i18n';
import type { Lang } from '../../../utils/i18n';

type Props = {
  visible: boolean;
  isDark: boolean;
  lang: Lang;
  friendRequestDisplayName: string;
  L: (key: string) => string;
  onRequestClose: () => void;
  onDecline: () => void;
  onAccept: () => void;
  styles: {
    modalOverlay: ViewStyle;
    modalCard: ViewStyle;
    modalTitle: TextStyle;
    modalText: TextStyle;
    btnGlassBase: ViewStyle;
    btnGlassDanger: ViewStyle;
    btnGlassTitan: ViewStyle;
    modalBtnText: TextStyle;
  };
};

export function FriendRequestModal({
  visible,
  isDark,
  lang,
  friendRequestDisplayName,
  L,
  onRequestClose,
  onDecline,
  onAccept,
  styles,
}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onRequestClose}
    >
      <View style={styles.modalOverlay}>
        <BlurView intensity={60} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>{L('friend_request')}</Text>
          <Text style={styles.modalText}>
            {t('friend_request_text', lang).replace('{user}', friendRequestDisplayName)}
          </Text>
          <View style={{ flexDirection: "row", gap: 12, marginTop: 16 }}>
            <TouchableOpacity
              style={[styles.btnGlassBase, styles.btnGlassDanger]}
              onPress={onDecline}
            >
              <Text style={styles.modalBtnText}>{L('decline')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btnGlassBase, styles.btnGlassTitan]}
              onPress={onAccept}
            >
              <Text style={styles.modalBtnText}>{L('accept')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
