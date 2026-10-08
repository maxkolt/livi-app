// components/LanguagePicker.tsx
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type Lang, defaultLang, t } from '../utils/i18n';
import { useLang } from '../store/lang';
import { AppDialogModal } from './AppDialog';
import {
  WELCOME_GLASS_BORDER,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
  UI_ACCENT,
  UI_ACCENT_LIGHT,
} from '../screens/home/constants';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (code: Lang) => void;
  current?: Lang;
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

const LIST_CONTENT_PAD_V = 4;
/** paddingVertical×2 + lineHeights (native + name) */
const LANGUAGE_ROW_HEIGHT = 12 * 2 + 18 + 1 + 14;
/** Видно семь с половиной строк — половинка подсказывает, что список прокручивается. */
const LIST_MAX_HEIGHT = LIST_CONTENT_PAD_V * 2 + LANGUAGE_ROW_HEIGHT * 7.5;
const ACCENT = UI_ACCENT;

/** Выбор языка — диалог в общем виде модалок приложения. */
const LanguagePicker: React.FC<Props> = ({
  visible,
  onClose,
  onSelect,
  current = defaultLang,
}) => {
  const lang = useLang((st) => st.lang);
  const isRtlLang = (code: Lang) => code === 'ar';

  return (
    <AppDialogModal
      visible={visible}
      onRequestClose={onClose}
      title={t('chooseLanguage', lang)}
      scrollable={false}
      actions={[{ label: t('cancelAction', lang), onPress: onClose }]}
    >
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {LANGUAGES.map((lng, idx) => {
          const selected = normalize(current) === normalize(lng.code);
          const rtl = isRtlLang(lng.code);
          const isLast = idx === LANGUAGES.length - 1;
          return (
            <TouchableOpacity
              key={lng.code}
              activeOpacity={0.85}
              onPress={() => onSelect(lng.code)}
              style={[styles.row, isLast ? styles.rowLast : null]}
            >
              <View style={{ flex: 1 }}>
                <Text
                  style={[
                    styles.rowNative,
                    selected && styles.rowNativeSelected,
                    rtl && {
                      writingDirection: 'rtl',
                      textAlign: 'left',
                    },
                  ]}
                >
                  {lng.native}
                </Text>
                <Text style={[styles.rowName, selected && styles.rowNameSelected]}>
                  {lng.name}
                </Text>
              </View>
              {selected ? (
                <Ionicons name="checkmark" size={20} color={ACCENT} />
              ) : (
                <View style={styles.radioOff} />
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </AppDialogModal>
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
  list: {
    flexShrink: 1,
    maxHeight: LIST_MAX_HEIGHT,
  },
  listContent: {
    paddingVertical: LIST_CONTENT_PAD_V,
    paddingHorizontal: 18,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: WELCOME_GLASS_BORDER,
    backgroundColor: 'transparent',
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowNative: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 18,
  },
  rowNativeSelected: {
    color: ACCENT,
  },
  rowName: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 11,
    fontWeight: '300',
    marginTop: 1,
    lineHeight: 14,
  },
  rowNameSelected: {
    color: UI_ACCENT_LIGHT,
  },
  radioOff: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: WELCOME_MUTED_TEXT,
    backgroundColor: 'transparent',
  },
});

export default LanguagePicker;
