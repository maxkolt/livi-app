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
  useWindowDimensions,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type Lang, defaultLang } from '../utils/i18n';
import ChatStyleBackButton from './ChatStyleBackButton';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (code: Lang) => void;
  current?: Lang;
};

const LIVI = {
  border: 'rgba(255,255,255,0.12)',
  text2: '#9FA7B4',
  white: '#F4F5F7',
  titan: '#8A8F99',
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

const CARD_PADDING = 16;
const LIST_CONTENT_PAD_V = 4;
const VISIBLE_LANGUAGE_ROWS = 7;
/** paddingVertical×2 + lineHeights (native + name) */
const LANGUAGE_ROW_HEIGHT = 12 * 2 + 18 + 1 + 14;

const LanguagePicker: React.FC<Props> = ({
  visible,
  onClose,
  onSelect,
  current = defaultLang,
}) => {
  if (!visible) return null;

  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();

  const isRtlLang = (code: Lang) => code === 'ar';

  const V_PAD = Platform.OS === 'android' ? 12 : 16;
  const availableH = Math.max(0, winH - (V_PAD + insets.top) - (V_PAD + insets.bottom));
  const listViewportH =
    LIST_CONTENT_PAD_V * 2 + VISIBLE_LANGUAGE_ROWS * LANGUAGE_ROW_HEIGHT;
  const cardH = Math.min(availableH, CARD_PADDING * 2 + listViewportH);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.overlay} pointerEvents="box-none">
        {Platform.OS === 'android' ? (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.9)' }]} />
        ) : (
          <>
            <BlurView intensity={85} tint="dark" style={StyleSheet.absoluteFill} />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.35)' }]} />
          </>
        )}

        <ChatStyleBackButton
          onPress={onClose}
          iconColor={LIVI.titan}
          style={{
            position: 'absolute',
            zIndex: 10,
            top: insets.top + (Platform.OS === 'android' ? 35 : 16),
            left: Platform.OS === 'ios' ? 15 : 17,
          }}
        />

        <View style={[styles.card, { height: cardH, marginTop: 20 }]}>
          <ScrollView
            style={styles.list}
            contentContainerStyle={{ paddingVertical: 4 }}
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
                  {selected ? <View style={styles.radioOn} /> : <View style={styles.radioOff} />}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
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
    paddingHorizontal: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    width: '92%',
    backgroundColor: 'rgba(13,14,16,0.94)',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LIVI.border,
    padding: 16,
  },
  list: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: LIVI.border,
    backgroundColor: 'transparent',
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowNative: {
    color: LIVI.white,
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 18,
  },
  rowNativeSelected: {
    color: 'rgba(172, 220, 190, 0.95)',
  },
  rowName: {
    color: LIVI.text2,
    fontSize: 11,
    fontWeight: '300',
    marginTop: 1,
    lineHeight: 14,
  },
  rowNameSelected: {
    color: 'rgba(77, 228, 144, 0.75)',
  },
  radioOff: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: LIVI.text2,
    backgroundColor: 'transparent',
  },
  radioOn: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'rgba(77, 228, 144, 0.90)',
    backgroundColor: 'rgba(77, 228, 144, 0.35)',
  },
});

export default LanguagePicker;
