import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Lang } from '../../utils/i18n';
import { fliqT } from './fliqI18n';

/** The same surface as the friend-request toast. */
export function FliqAccessNotice({ visible, lang, bottom, onClose }: {
  visible: boolean; lang: Lang; bottom: number; onClose: () => void;
}) {
  if (!visible) return null;
  return (
    <View testID="fliq-access-notice" accessibilityLiveRegion="polite" style={[styles.notice, { bottom }]}>
      <Text style={styles.text}>{fliqT('youtubeAccessNotice', lang)}</Text>
      <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={fliqT('close', lang)} hitSlop={12}>
        <Ionicons name="close" size={20} color="#B7C0CF" />
      </Pressable>
    </View>
  );
}
const styles = StyleSheet.create({
  notice: {
    position: 'absolute', left: '7%', right: '7%', zIndex: 20,
    backgroundColor: 'rgba(54, 64, 76, 0.96)', borderRadius: 12,
    paddingVertical: 10, paddingHorizontal: 14, borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)', flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  text: { flex: 1, color: '#B7C0CF', fontSize: 14, fontWeight: '500' },
});
