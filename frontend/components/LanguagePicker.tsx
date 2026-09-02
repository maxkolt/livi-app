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
  Pressable,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type Lang, defaultLang } from '../utils/i18n';
import {
  LIVI,
  WELCOME_BRAND_VI_FILL_GRADIENT,
  WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS,
  WELCOME_GLASS_BORDER,
  WELCOME_GLASS_SURFACE,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
} from '../screens/home/constants';

const OVERLAY_DIM = 'rgba(0, 0, 0, 0.62)';

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

const CARD_PADDING = 16;
const LIST_CONTENT_PAD_V = 4;
const VISIBLE_LANGUAGE_ROWS = 7;
/** paddingVertical×2 + lineHeights (native + name) */
const LANGUAGE_ROW_HEIGHT = 12 * 2 + 18 + 1 + 14;
const ACCENT = WELCOME_BRAND_VI_FILL_GRADIENT[1];

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
        <View style={[StyleSheet.absoluteFill, { backgroundColor: OVERLAY_DIM }]} />

        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          hitSlop={10}
          style={({ pressed }) => [
            styles.backBtn,
            {
              top: insets.top + (Platform.OS === 'android' ? 12 : 8),
              left: 12,
            },
            pressed && styles.backBtnPressed,
          ]}
        >
          <Ionicons name="chevron-back" size={22} color={LIVI.white} />
        </Pressable>

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
                  {selected ? (
                    <Ionicons name="checkmark" size={20} color={ACCENT} />
                  ) : (
                    <View style={styles.radioOff} />
                  )}
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
  backBtn: {
    position: 'absolute',
    zIndex: 10,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnPressed: {
    opacity: 0.72,
  },
  card: {
    width: '92%',
    backgroundColor: WELCOME_GLASS_SURFACE,
    borderRadius: WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
    padding: CARD_PADDING,
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
    color: WELCOME_BRAND_VI_FILL_GRADIENT[2],
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
