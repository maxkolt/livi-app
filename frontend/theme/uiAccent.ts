/**
 * UI accent: фиолетовый в светлой теме, бирюзовый в тёмной (одна роль — разный оттенок).
 * Тона/прозрачности повторяют прежние фиолетовые шаги.
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
  /** Подложка заметки в модалке (тёмная тема) — вместо фиолетового тинта */
  noteTintBg: string;
};

const LIGHT: UiAccent = {
  solid: '#715BA8',
  bright: '#7B61FF',
  softText: '#B8A9E8',
  vivid8: 'rgba(123,97,255,0.08)',
  vivid10: 'rgba(123,97,255,0.10)',
  vivid12: 'rgba(123,97,255,0.12)',
  vivid16: 'rgba(123,97,255,0.16)',
  vivid22: 'rgba(123,97,255,0.22)',
  vivid45: 'rgba(123,97,255,0.45)',
  solid10: 'rgba(113,91,168,0.1)',
  solid15: 'rgba(113,91,168,0.15)',
  solid22: 'rgba(113,91,168,0.22)',
  solid28: 'rgba(113,91,168,0.28)',
  solid34: 'rgba(113,91,168,0.34)',
  forwardSendBg: 'rgba(113, 91, 168, 0.14)',
  forwardSendBorder: '#715BA8',
  forwardSendText: '#715BA8',
  noteTintBg: '#F2EEF9',
};

const DARK: UiAccent = {
  solid: '#2EC4B6',
  bright: '#5EEAD4',
  softText: '#9EE5DC',
  vivid8: 'rgba(46,196,182,0.08)',
  vivid10: 'rgba(46,196,182,0.10)',
  vivid12: 'rgba(46,196,182,0.12)',
  vivid16: 'rgba(46,196,182,0.16)',
  vivid22: 'rgba(46,196,182,0.22)',
  vivid45: 'rgba(46,196,182,0.45)',
  solid10: 'rgba(46,196,182,0.1)',
  solid15: 'rgba(46,196,182,0.15)',
  solid22: 'rgba(46,196,182,0.22)',
  solid28: 'rgba(46,196,182,0.28)',
  solid34: 'rgba(46,196,182,0.34)',
  forwardSendBg: 'rgba(46,196,182,0.1)',
  forwardSendBorder: '#2EC4B6',
  forwardSendText: '#9EE5DC',
  noteTintBg: '#0F2428',
};

export function uiAccent(isDark: boolean): UiAccent {
  return isDark ? DARK : LIGHT;
}
