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

/** Squircle «назад» в шапках — один вид в светлой и тёмной теме (как в dark). */
export const CHAT_BACK_BUTTON_SURFACE = {
  backgroundColor: 'rgba(255,255,255,0.06)',
  borderColor: 'rgba(255,255,255,0.12)',
  borderWidth: 1,
} as const;

/** У соседних кнопок: большой hitSlop снаружи, маленький к соседу — меньше перехвата тапов. */
export const TOUCH_HIT_OUTER = 26;
export const TOUCH_HIT_INNER = 6;

/** Горизонтальный зазор между кнопками в строке друга (звонок ↔ чат ↔ удаление). */
export const FRIEND_ROW_ACTION_GAP = 18;

/** Отступ от правого края кнопки сообщения до правого края строки. */
export const FRIEND_ROW_TRAILING_PAD = 1;

/** Лёгкое касание: не срывать onPress при микродвижении пальца. */
export const FRIEND_ACTION_PRESS_RETENTION = {
  top: 22,
  bottom: 22,
  left: 22,
  right: 22,
} as const;

/** Список друзей: видео слева, чат справа (между ними ~14px). */
export const FRIEND_ROW_HIT_VIDEO = {
  top: TOUCH_HIT_OUTER,
  bottom: TOUCH_HIT_OUTER,
  left: TOUCH_HIT_OUTER,
  right: TOUCH_HIT_INNER,
} as const;
/** Между аудио и видео — узкий зазор hitSlop. */
export const FRIEND_ROW_HIT_AUDIO = {
  top: TOUCH_HIT_OUTER,
  bottom: TOUCH_HIT_OUTER,
  left: TOUCH_HIT_INNER,
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
