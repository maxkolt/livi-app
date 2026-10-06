/**
 * UI accent (тёмная тема): приглушённый ледяной голубой — общий акцент приложения
 * (UI_ACCENT в screens/home/constants.ts).
 * Светлая палитра удалена — `isDark` игнорируется (совместимость вызовов).
 */
export type UiAccent = {
  solid: string;
  bright: string;
  softText: string;
  vivid8: string;
  vivid10: string;
  vivid12: string;
  vivid16: string;
  vivid22: string;
  vivid45: string;
  solid10: string;
  solid15: string;
  solid22: string;
  solid28: string;
  solid34: string;
  forwardSendBg: string;
  forwardSendBorder: string;
  forwardSendText: string;
  /** Подложка заметки в модалке */
  noteTintBg: string;
};

const DARK: UiAccent = {
  solid: '#62B0D8',
  bright: '#8CC6E6',
  softText: '#B2DCF0',
  vivid8: 'rgba(98,176,216,0.08)',
  vivid10: 'rgba(98,176,216,0.10)',
  vivid12: 'rgba(98,176,216,0.12)',
  vivid16: 'rgba(98,176,216,0.16)',
  vivid22: 'rgba(98,176,216,0.22)',
  vivid45: 'rgba(98,176,216,0.45)',
  solid10: 'rgba(98,176,216,0.1)',
  solid15: 'rgba(98,176,216,0.15)',
  solid22: 'rgba(98,176,216,0.22)',
  solid28: 'rgba(98,176,216,0.28)',
  solid34: 'rgba(98,176,216,0.34)',
  forwardSendBg: 'rgba(98,176,216,0.1)',
  forwardSendBorder: '#62B0D8',
  forwardSendText: '#B2DCF0',
  noteTintBg: '#2B3442',
};

export function uiAccent(_isDark?: boolean): UiAccent {
  return DARK;
}
