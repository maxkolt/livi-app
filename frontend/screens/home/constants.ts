import { Platform } from 'react-native';
import { FRIEND_ACTION_BUTTON, FRIEND_ROW_ACTION_GAP } from '../../constants/uiTokens';

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

/** Горизонтальный padding списка друзей (sheet 12 + отступ «назад» 5). */
export const FRIENDS_LIST_HORIZONTAL_PAD = 17;

/** Толщина разделителя между строками друзей. */
export const FRIEND_ROW_DIVIDER_HEIGHT = 1;

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
export const BRAND_LETTER_GLOW_OVERLAP = 0.9;
export const CHROME_PERIMETER_GLOW_LAYERS = 5;
export const CHROME_PERIMETER_GLOW_SPREAD = 2.8;
/** Компенсация ширины ореола справа — кнопка меню на прежнем отступе. */
export const CHROME_PERIMETER_GLOW_LAYOUT_INSET =
  CHROME_PERIMETER_GLOW_LAYERS * CHROME_PERIMETER_GLOW_SPREAD;
export const ANIMATED_BORDER_WIDTH = 0.8;
export const ANDROID_SEG_RIPPLE = { color: 'rgba(255,255,255,0.14)', borderless: false as const };
export const FRIENDS_PAGE_SIZE = 50;
export const FRIENDS_MAX_PAGES_PER_LOAD = 10;

export const FRIEND_ACTION_BTN_SURFACE = {
  backgroundColor: '#2B2B2B',
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
