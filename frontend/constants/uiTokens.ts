/**
 * Размеры кнопок чата и видеозвонка в списке друзей (`friendActionBtnSize` на Home).
 * Те же значения для «Назад» и аналогичных squircle-кнопок в шапках и модалках.
 */
export const FRIEND_ACTION_BUTTON = {
  width: 42,
  height: 42,
  borderRadius: 13,
} as const;

/** Ionicons — та же визуальная грубина, что у иконки видео на кнопке звонка (23). */
export const FRIEND_ACTION_ICON_SIZE = 23;

/** У соседних кнопок: большой hitSlop снаружи, маленький к соседу — меньше перехвата тапов. */
export const TOUCH_HIT_OUTER = 19;
export const TOUCH_HIT_INNER = 4;

/** Список друзей: видео слева, чат справа (между ними ~14px). */
export const FRIEND_ROW_HIT_VIDEO = {
  top: TOUCH_HIT_OUTER,
  bottom: TOUCH_HIT_OUTER,
  left: TOUCH_HIT_OUTER,
  right: TOUCH_HIT_INNER,
} as const;
export const FRIEND_ROW_HIT_CHAT = {
  top: TOUCH_HIT_OUTER,
  bottom: TOUCH_HIT_OUTER,
  left: TOUCH_HIT_INNER,
  right: TOUCH_HIT_OUTER,
} as const;

/** Композер чата: вложение | поле | мик | отправить. */
export const COMPOSER_HIT_ATTACH = {
  top: 14,
  bottom: 14,
  left: 14,
  right: TOUCH_HIT_INNER,
} as const;
export const COMPOSER_HIT_SEND = {
  top: 16,
  bottom: 16,
  left: TOUCH_HIT_INNER,
  right: 16,
} as const;
