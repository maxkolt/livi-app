// components/LanguagePicker.tsx
import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { t, type Lang, defaultLang } from '../utils/i18n';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (code: Lang) => void;
  current?: Lang;
};

const LIVI = {
  bg: '#151F33',
  surface: 'rgba(13,14,16,0.92)',
  glass: 'rgba(255,255,255,0.06)',
  border: 'rgba(255,255,255,0.12)',
  text: '#AEB6C6',
  text2: '#9FA7B4',
  white: '#F4F5F7',
  green: '#2ECC71',
};

const LANGUAGES: Array<{ code: Lang; name: string; native: string }> = [
  { code: 'ru',    name: 'Russian',               native: 'Русский' },
  { code: 'en',    name: 'English',               native: 'English' },
  { code: 'es',    name: 'Spanish',               native: 'Español' },
  { code: 'de',    name: 'German',                native: 'Deutsch' },
  { code: 'fr',    name: 'French',                native: 'Français' },
  { code: 'it',    name: 'Italian',               native: 'Italiano' },
  { code: 'pt',    name: 'Portuguese',            native: 'Português' },
  { code: 'tr',    name: 'Turkish',               native: 'Türkçe' },
  { code: 'ar',    name: 'Arabic',                native: 'العربية' },
  { code: 'ja',    name: 'Japanese',              native: '日本語' },
  { code: 'ko',    name: 'Korean',                native: '한국어' },
  { code: 'zh',    name: 'Chinese (Simplified)',  native: '简体中文' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', native: '繁體中文' },
  { code: 'hi',    name: 'Hindi',                 native: 'हिन्दी' },
  { code: 'vi',    name: 'Vietnamese',            native: 'Tiếng Việt' },
  { code: 'th',    name: 'Thai',                  native: 'ไทย' },
  { code: 'id',    name: 'Indonesian',            native: 'Bahasa Indonesia' },
];

const LanguagePicker: React.FC<Props> = ({
  visible,
  onClose,
  onSelect,
  current = defaultLang,
}) => {
  if (!visible) return null;

  const headerTitle = t('chooseLanguage', current);
  const cancelLbl   = t('cancel', current);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />

        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>{headerTitle}</Text>
          </View>

          <ScrollView
            contentContainerStyle={{ paddingVertical: 4 }}
            showsVerticalScrollIndicator={false}
          >
            {LANGUAGES.map((lng) => {
              const selected = normalize(current) === normalize(lng.code);
              return (
                <TouchableOpacity
                  key={lng.code}
                  activeOpacity={0.85}
                  onPress={() => onSelect(lng.code)}
                  style={[
                    styles.row,
                    selected && {
                      borderColor: 'rgba(77, 228, 144, 0.70)',
                      backgroundColor: 'rgba(46, 204, 113, 0.08)',
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowNative}>{lng.native}</Text>
                    <Text style={styles.rowName}>{lng.name}</Text>
                  </View>
                  {selected ? <View style={styles.radioOn} /> : <View style={styles.radioOff} />}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <TouchableOpacity activeOpacity={0.85} onPress={onClose} style={styles.footerBtn}>
            <Text style={styles.footerBtnText}>{cancelLbl}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

function normalize(code?: string): string {
  if (!code) return '';
  const c = code.toLowerCase();
  if (c.startsWith('zh-tw')) return 'zh-tw';
  if (c.startsWith('zh')) return 'zh';
  return c;
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'transparent',
    paddingHorizontal: 18,
    paddingVertical: 24,
    justifyContent: 'center',
  },
  card: {
    alignSelf: 'center',
    width: '92%',
    maxHeight: '78%',
    backgroundColor: LIVI.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LIVI.border,
    padding: 12,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    ...Platform.select({ android: { elevation: 8 } }),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingBottom: 8,
  },
  headerTitle: {
    flex: 1,
    color: LIVI.white,
    fontSize: 18,
    fontWeight: '800',
  },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: LIVI.glass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeTxt: { color: LIVI.white, fontSize: 16, fontWeight: '800' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginVertical: 6,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LIVI.border,
  },
  rowNative: {
    color: LIVI.white,
    fontSize: 16,
    fontWeight: '700',
  },
  rowName: {
    color: LIVI.text2,
    fontSize: 12,
    marginTop: 2,
  },
  radioOff: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: LIVI.text2,
    backgroundColor: 'transparent',
  },
  radioOn: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: 'rgba(77, 228, 144, 0.90)',
    backgroundColor: 'rgba(77, 228, 144, 0.35)',
  },

  footerBtn: {
    marginTop: 8,
    backgroundColor: LIVI.glass,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LIVI.border,
  },
  footerBtnText: {
    color: LIVI.white,
    fontWeight: '800',
    fontSize: 15,
  },
});

export default LanguagePicker;
