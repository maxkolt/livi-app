import { Platform, StyleSheet } from 'react-native';
import { FRIEND_ACTION_BUTTON, FRIEND_ROW_ACTION_GAP } from '../../constants/uiTokens';

/** Фон welcome-экрана (макет). */
export const WELCOME_STAGE_BG = '#0A0C14';
/**
 * Вертикальный градиент сцены — aura «запечена» в непрозрачные stops.
 * Без полупрозрачных wash-слоёв: на Android они дают banding (полосы).
 */
export const WELCOME_STAGE_GRADIENT = ['#0B141A', '#0A0C14', '#0A1016', '#0A141A'] as const;
/** Accent gradient (aura) — вместо фиолетового на макете. */
export const AURA_GRADIENT = ['#14b8a6', '#3b82f6', '#00b5ff'] as const;
export const AURA_GLOW = '#3b82f6';
/** Unread / missed count badge on welcome chats and friend action buttons. */
export const WELCOME_UNREAD_BADGE = '#2158c0';
/** Надписи welcome / активный tab — в тон aura-рамки CTA. */
export const WELCOME_AURA_TEXT = AURA_GRADIENT[2];
export const CROWN_GOLD = '#E4C065';
export const WELCOME_CARD_BG = '#161B22';
export const WELCOME_NAV_BG = '#151921';
/** Скругление «полки» tab bar / шапки и композера чата по краям к контенту. */
export const WELCOME_CHROME_EDGE_RADIUS = 24;
export const WELCOME_MUTED_TEXT = '#8B949E';
/** Заголовки welcome (например «Друзья») — мягче чистого white. */
export const WELCOME_HEADER_TITLE = 'rgba(244, 245, 247, 0.86)';
export const WELCOME_CHROME_BTN_BG = '#1C2129';
/** Полупрозрачная «стеклянная» подложка (онлайн-баннер, tab bar). */
export const WELCOME_GLASS_SURFACE = 'rgba(22, 27, 34, 0.52)';
export const WELCOME_GLASS_BORDER = 'rgba(255,255,255,0.06)';

export const LIVI = {
  bg: '#151F33',
  surface: '#0D0E10',
  glass: 'rgba(255,255,255,0.06)',
  border: 'rgba(255,255,255,0.12)',
  text: '#AEB6C6',
  text2: '#9FA7B4',
  titan: '#8A8F99',
  white: '#F4F5F7',
  green: '#2ECC71',
  red: '#FF5A67',
  darkText: '#151515',
  textThemeWhite: '#444444',
};

/** Заливка «Vi» — тёмный chrome с бирюзово-синими оттенками (aura). */
export const WELCOME_BRAND_VI_FILL_GRADIENT = [
  '#1a3640',
  '#2a5868',
  '#4a7a8c',
] as const;

/** Активная иконка навбара / подсветка speaker & peer-video на audio UI и in-app PiP. */
export const WELCOME_NAV_ACTIVE_ICON = WELCOME_BRAND_VI_FILL_GRADIENT[2];
export const WELCOME_NAV_ACTIVE_ACCENT = {
  solid: WELCOME_NAV_ACTIVE_ICON,
  softText: WELCOME_NAV_ACTIVE_ICON,
  solid15: 'rgba(74, 122, 140, 0.15)',
} as const;

/** Обводка «Vi» — teal → blue. */
export const WELCOME_BRAND_VI_STROKE_GRADIENT = [
  '#134e4a',
  '#2a6f7a',
  '#3b82f6',
] as const;

/** Горизонтальный inset списка друзей на welcome (карточки уже экрана). */
export const WELCOME_FRIENDS_LIST_INSET = 22;
/** Отступ справа у кнопок звонка/чата в welcome-карточке. */
export const WELCOME_FRIEND_ROW_TRAILING_PAD = 12;
/** Высота welcome-карточки (контент). */
export const WELCOME_FRIEND_CARD_ROW_HEIGHT = 66;
/** Зазор между welcome-карточками. */
export const WELCOME_FRIEND_CARD_GAP = 6;
/** Шаг для getItemLayout (высота + зазор). */
export const WELCOME_FRIEND_ROW_STRIDE = WELCOME_FRIEND_CARD_ROW_HEIGHT + WELCOME_FRIEND_CARD_GAP;
/** Диаметр аватара в welcome-карточке. */
export const WELCOME_FRIEND_AVATAR_SIZE = 44;
/** Скругление внешней оболочки сегментов «Все / Онлайн» (не pill). */
export const WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS = 14;
/** Кнопки звонка/чата в welcome-строке — скругление (круг при 42×42). */
export const WELCOME_FRIEND_ACTION_BTN_RADIUS = 21;
/** Иконки звонка/чата welcome — чуть светлее активных иконок tab bar (Vi). */
export const WELCOME_FRIEND_ACTION_ICON = '#6aa3b5';
export const WELCOME_FRIEND_ACTION_ICON_PRESSED = '#7eb8cc';

/** Welcome: та же заливка, что у menu, без рамки. */
export const WELCOME_FRIEND_ACTION_BTN_SURFACE = {
  backgroundColor: 'rgba(255,255,255,0.06)',
  borderWidth: 0,
  justifyContent: 'center' as const,
  alignItems: 'center' as const,
};

export const WELCOME_FRIEND_ACTION_BTN_PRESSED_SURFACE = {
  backgroundColor: 'rgba(255,255,255,0.28)',
  borderWidth: 0,
  transform: [{ scale: 0.92 }],
} as const;

/** Горизонтальный padding списка друзей (sheet 12 + отступ «назад» 5). */
export const FRIENDS_LIST_HORIZONTAL_PAD = 17;

/** Толщина разделителя между строками друзей. */
export const FRIEND_ROW_DIVIDER_HEIGHT = StyleSheet.hairlineWidth;

export const FRIEND_ROW_LAYOUT_HEIGHT = 72;

/** Фон списка друзей — только контейнер FlatList/шита; ячейки строк прозрачные. */
export const FRIEND_LIST_ROW_BG = LIVI.surface;

/** Android: неактивная кнопка видео в списке друзей. */
export const ANDROID_VIDEO_CALL_DISABLED_BG = '#1C1C1E';
export const ANDROID_VIDEO_CALL_DISABLED_ICON = '#48484A';

/** Android: instant touch feedback (no opacity fade delay). */
export const ANDROID_INSTANT_TOUCH =
  Platform.OS === 'android'
    ? ({ activeOpacity: 1 as const, delayPressIn: 0, delayPressOut: 0 })
    : ({} as const);

export const ANDROID_FRIEND_ACTION_HIT_SLOP = { top: 14, bottom: 14, left: 14, right: 14 };
export const ANDROID_MENU_HIT_SLOP = { top: 12, bottom: 12, left: 12, right: 12 };

export const MENU_BTN_RADIUS = 12;
export const MENU_BTN_SIZE = 42;
/** Высота контролов вкладки «Ещё» (язык и т.п.): pad 14+14 + текст 14/line 20. */
export const MORE_TAB_CONTROL_HEIGHT = 48;
export const BRAND_OUTLINE_STROKE = 1.35;
export const BRAND_FONT_FAMILY = Platform.OS === 'ios' ? 'System' : 'sans-serif-medium';
export const BRAND_3D_LAYERS = 5;
export const BRAND_3D_STEP_X = 0.55;
export const BRAND_3D_STEP_Y = 0.62;
export const BRAND_LETTER_GLOW_LAYERS = 3;
export const BRAND_LETTER_GLOW_SPREAD = 1.2;
export const BRAND_LETTER_GLOW_INSET = BRAND_LETTER_GLOW_LAYERS * BRAND_LETTER_GLOW_SPREAD;
export const BRAND_LETTER_GLOW_INTENSITY = 0.58;
/** Доля inset для перекрытия ореолов между буквами. */
export const BRAND_LETTER_GLOW_OVERLAP = 1.2;
export const CHROME_PERIMETER_GLOW_LAYERS = 5;
export const CHROME_PERIMETER_GLOW_SPREAD = 2.8;
/** Компенсация ширины ореола справа — кнопка меню на прежнем отступе. */
export const CHROME_PERIMETER_GLOW_LAYOUT_INSET =
  CHROME_PERIMETER_GLOW_LAYERS * CHROME_PERIMETER_GLOW_SPREAD;
export const ANIMATED_BORDER_WIDTH = StyleSheet.hairlineWidth;
/** Рамка аватара на вкладке «Профиль» — толще, чем у CTA/меню. */
export const PROFILE_AVATAR_BORDER_WIDTH = 1;
export const ANDROID_SEG_RIPPLE = { color: 'rgba(255,255,255,0.14)', borderless: false as const };
export const FRIENDS_PAGE_SIZE = 50;
export const FRIENDS_MAX_PAGES_PER_LOAD = 10;

export const FRIEND_ACTION_BTN_SURFACE = {
  backgroundColor: 'rgba(255,255,255,0.06)',
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.12)',
  justifyContent: 'center' as const,
  alignItems: 'center' as const,
};

/** Одинаковый оттенок иконки чата и видео при удержании пальца. */
export const FRIEND_ACTION_ICON_PRESSED = '#FFFFFF';
export const FRIEND_ACTION_BTN_PRESSED_SURFACE = {
  backgroundColor: 'rgba(255,255,255,0.28)',
  borderColor: 'rgba(255,255,255,0.45)',
  transform: [{ scale: 0.92 }],
} as const;

export const FRIEND_ROW_HEIGHT = FRIEND_ROW_LAYOUT_HEIGHT;
export const SHEET_CONTENT_PAD_H = 12;
/** Совпадает с sheetTopBar paddingHorizontal + marginLeft у ChatStyleBackButton (5). */
export const FRIENDS_LIST_PAD_H = SHEET_CONTENT_PAD_H + 5;
export const FRIEND_SWIPE_DELETE_WIDTH = FRIEND_ROW_ACTION_GAP + FRIEND_ACTION_BUTTON.width;

export const DRAFT_KEY = 'profile_draft_v1';
export const MISSED_CALLS_KEY = 'missed_calls_by_user_v1';
export const UNREAD_BY_USER_KEY = 'unread_by_user_v1';
export const CHAT_FAVORITES_KEY = 'welcome_chat_favorites_v1';
export const CALL_LOG_KEY = 'welcome_call_log_v1';
export const PROFILE_KEY = 'livi.profile.v1';
export const INSTALL_ID_KEY = 'livi.installId';
export const USER_ID_KEY = 'userId';
export const FRIENDS_CACHE_KEY_LEGACY = 'friends_cache_v1';
export const FRIENDS_CACHE_PREFIX = 'friends_cache_v1';

export const CHAT_OPEN_DEBOUNCE_MS = 220;

/** CTA «Начать поиск»: на телефоне компактнее, на планшете шире (но не edge-to-edge). */
export const SEARCH_CTA_MAX_WIDTH = 360;
export const SEARCH_CTA_TABLET_MAX_WIDTH = 520;
export const SEARCH_CTA_TABLET_MIN_WIDTH = 600;
