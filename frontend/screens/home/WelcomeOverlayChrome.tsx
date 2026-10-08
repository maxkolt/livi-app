import { Platform, StyleSheet } from 'react-native';
import {
  WELCOME_GLASS_RIM,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
  WELCOME_TAB_BLOCK_SURFACE,
  UI_ACCENT_DEEP,
} from './constants';

/**
 * Содержимое диалогов главной (ссылка-приглашение, заявка в друзья). Сами окна —
 * AppDialogModal (components/AppDialog): один фон и один вид у всех модалок.
 */
export const WELCOME_OVERLAY_ACCENT = UI_ACCENT_DEEP;

export const welcomeOverlayText = StyleSheet.create({
  title: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 13,
    fontWeight: '400',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 18,
  },
  label: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 8,
  },
  body: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  strong: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  /** Поле ссылки утоплено в карточку: темнее неё, со светлой кромкой. */
  linkField: {
    backgroundColor: 'rgba(0, 0, 0, 0.18)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_RIM,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  linkText: {
    flex: 1,
    color: WELCOME_HEADER_TITLE,
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  copyBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: WELCOME_TAB_BLOCK_SURFACE,
  },
  hint: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 16,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  avatarFallback: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: WELCOME_OVERLAY_ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
});
