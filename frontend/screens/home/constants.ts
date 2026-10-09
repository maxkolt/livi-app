import { Platform, StyleSheet } from 'react-native';

/** Фон welcome-экрана (макет). */
export const WELCOME_STAGE_BG = '#0A0C14';
/**
 * Фон страниц с таб-баром (Поиск, Друзья, Звонки, Чат, Профиль): сплошной серо-синий.
 * Почти чёрный градиент на солнце сливался в одно пятно. Нативные экраны — прежний фон.
 */
export const HOME_NAV_BG = '#252B34';

/**
 * Палитра всего приложения (с 2026-10-05, от экрана «Поиск»). Блоки — того же
 * серо-синего тона, что фон HOME_NAV_BG, только на ступень светлее: без бирюзы,
 * которая спорила с фоном. Цвет даёт один акцент — приглушённый ледяной голубой.
 * Старые имена ниже (HOME_NAV_*, WELCOME_*) ссылаются на эти значения.
 */
/** Блоки, карточки, строки списков, навбар, шапки. */
export const UI_SURFACE = '#2E3540';
/** Элемент поверх блока или над затемнением: попапы, меню, кнопки в строках. */
export const UI_SURFACE_RAISED = '#36404C';
/** Утопленная подложка внутри блока (квадрат под иконкой) — темнее блока. */
export const UI_SURFACE_SUNKEN = '#262D37';
/** Кромка блоков: едва заметный светлый край отделяет блок от фона. */
export const UI_RIM = 'rgba(255, 255, 255, 0.07)';
/**
 * Единственный акцент: иконки активного, галочки, выбранный текст, ссылки.
 * Контраст 5,1:1 на UI_SURFACE — читается сразу.
 */
export const UI_ACCENT = '#62B0D8';
/** Нажатый акцент — светлее. */
export const UI_ACCENT_PRESSED = '#8CC6E6';
/** Светлая подсветка акцента: кромка луча радара, мелкий текст на тёмном акценте. */
export const UI_ACCENT_LIGHT = '#B2DCF0';
/** Плотная заливка кнопки с белым текстом (5,5:1). */
export const UI_ACCENT_DEEP = '#3D6E8C';
/** Подложка активного: «таблетка» вкладки, выбранный сегмент, заливка CTA. */
export const UI_ACCENT_SOFT = 'rgba(98, 176, 216, 0.14)';
/** То же, но непрозрачное поверх UI_SURFACE: выбранная строка, нажатая кнопка. */
export const UI_ACCENT_SELECTED = '#364959';
/** Неактивные иконки и подписи — тусклее акцента, но 4:1 на блоке. */
export const UI_INACTIVE = '#8B95A3';
/** Строки списков (чаты, друзья, звонки) — тише блоков: между фоном и UI_SURFACE. */
export const UI_ROW_SURFACE = '#2A313B';
/**
 * Кнопки, поле поиска и блок фильтров на стекле шапки вкладок — непрозрачные, на ступень
 * светлее стекла: строки под ними не просвечивают.
 */
export const UI_GLASS_CONTROL = UI_SURFACE_RAISED;
/**
 * Источники стекла главной (BackdropBlur, Android 12+): сплошной фон — под стеклом как есть,
 * списки вкладок — размытыми. Шапка вкладки и навбар берут список видимой вкладки.
 */
export const HOME_BLUR_BG_SOURCE = 'home-bg';
export const HOME_BLUR_LIST_SOURCE = {
  friends: 'home-list-friends',
  calls: 'home-list-calls',
  chat: 'home-list-chat',
  profile: 'home-list-profile',
  fliq: 'home-list-fliq',
} as const;
/**
 * Источники стекла экрана звонка: фон экрана и главное видео. Видео — TextureView (патч
 * @livekit/react-native-webrtc, проп textureView): SurfaceView стекло не видит.
 */
export const CALL_BLUR_BG_SOURCE = 'call-bg';
export const CALL_BLUR_VIDEO_SOURCE = 'call-video';

/** Непрозрачная заливка блоков поверх HOME_NAV_BG: таб-бар, «Онлайн», фильтры списков. */
export const HOME_NAV_SURFACE = UI_SURFACE;
/** Кнопка «Найти собеседника»: лёгкий тон акцента. */
export const HOME_NAV_CTA_SURFACE = 'rgba(98, 176, 216, 0.16)';
/** Верхняя и нижняя панель «Поиска». */
export const WELCOME_SEARCH_CHROME_SURFACE = UI_SURFACE;
/**
 * Блоки и круглые кнопки на «Друзьях», «Чатах» и «Звонках»: фильтры,
 * «Пригласить друзей», поиск, корона; кнопки «Начать» / «Далее» в рандомном чате.
 */
export const WELCOME_TAB_BLOCK_SURFACE = UI_SURFACE;
/** Кромка всплывающих карточек и стекла чата — блик на грани. */
export const WELCOME_GLASS_RIM = 'rgba(255, 255, 255, 0.08)';
/**
 * Непрозрачная карточка поверх затемнения (меню сообщения, реакции, листы):
 * на ступень светлее блоков — карточка приподнята над чатом.
 */
export const WELCOME_POPUP_SURFACE = UI_SURFACE_RAISED;
/** Нажатый пункт в такой карточке. */
export const WELCOME_POPUP_PRESSED = 'rgba(98, 176, 216, 0.12)';
/** Акцент на такой карточке (выбрано, кнопка подтверждения). Шестизначный hex: к нему дописывают альфу. */
export const WELCOME_POPUP_ACCENT = UI_ACCENT;
/** Лист снизу (переслать, вложения): та же карточка, кромка по скруглённому верху. */
export const WELCOME_POPUP_SHEET_CHROME = {
  backgroundColor: WELCOME_POPUP_SURFACE,
  borderWidth: StyleSheet.hairlineWidth,
  borderBottomWidth: 0,
  borderColor: WELCOME_GLASS_RIM,
} as const;
/** Выбранный пункт / нажатая кнопка на блоке — непрозрачный тон акцента. */
export const HOME_NAV_SEGMENT_ACTIVE = UI_ACCENT_SELECTED;
export const HOME_NAV_ACTIVE = UI_ACCENT;
/** Активная вкладка нижнего навбара и акцентные иконки блоков. */
export const HOME_NAV_TAB_ACTIVE = UI_ACCENT;
/** Подложка выбранной кнопки внутри фильтров вкладок («Все» / «Онлайн»), вкладки эмодзи. */
export const WELCOME_FILTER_ACTIVE = 'rgba(98, 176, 216, 0.30)';
export const HOME_NAV_ACTIVE_PRESSED = UI_ACCENT_PRESSED;
/** Квадрат под иконкой в карточке — темнее карточки, чтобы иконка читалась. */
export const HOME_NAV_ICON_WELL = UI_SURFACE_SUNKEN;
/** Accent gradient (aura) — вместо фиолетового на макете. */
export const AURA_GRADIENT = ['#14b8a6', '#3b82f6', '#00b5ff'] as const;
export const AURA_GLOW = '#3b82f6';
/**
 * Тон радара «Поиска» — общий акцент. Насыщенно горят только луч и цели, кольца
 * и шкала идут им же, но приглушённо (альфы в welcomeRadarScene).
 */
export const SEARCH_RADAR_HUD = UI_ACCENT;
/** Заливка кнопки «Сохранить» в профиле и активных сегментных кнопок — тон акцента. */
export const WELCOME_SEARCH_CTA_BORDER = 'rgba(98, 176, 216, 0.24)';
/** Подсветка того же тона: кромка луча, засветка шкалы, ядро цели. */
export const SEARCH_RADAR_HUD_LIGHT = UI_ACCENT_LIGHT;
/** Unread / missed count badge on welcome chats and friend action buttons. */
export const WELCOME_UNREAD_BADGE = '#2158c0';
/** Значок «есть обновление»: краповый, как точка на вкладке «Профиль» в навбаре. */
export const WELCOME_UPDATE_BADGE = '#A63A48';
export const CROWN_GOLD = '#E4C065';
/** Диалоги поверх затемнения (подтверждения в чате) — приподнятая поверхность. */
export const WELCOME_CARD_BG = UI_SURFACE_RAISED;
/** Скругление «полки» tab bar / шапки и композера чата по краям к контенту. */
export const WELCOME_CHROME_EDGE_RADIUS = 24;
/**
 * Зазор между системной строкой и шапкой страницы (поверх insets.top): контент не прилипает
 * к часам и значкам. Все страницы, кроме «Поиска» и «Профиля» — у них свои отступы.
 */
export const APP_TOP_CONTENT_GAP = 8;
export const WELCOME_MUTED_TEXT = '#8B949E';
/** Подписи кнопок в блоках-фильтрах вкладок («Все / Онлайн»…): чуть ярче приглушённого текста. */
export const WELCOME_SEGMENT_LABEL = '#A3AAB2';
/** Заголовки welcome (например «Друзья») — мягче чистого white. */
export const WELCOME_HEADER_TITLE = 'rgba(244, 245, 247, 0.86)';
/** Круглые кнопки шапок экрана звонка — лёгкий тон акцента поверх видео/сцены. */
export const WELCOME_CHROME_BTN_BG = 'rgba(98, 176, 216, 0.16)';
/** Подложка карточек (покупки в профиле, карточки модалок). */
export const WELCOME_GLASS_SURFACE = UI_SURFACE;
/** Карточки списков и блоки с кнопками во вкладках (друзья, звонки, чаты, профиль). */
export const WELCOME_LIST_SURFACE = UI_SURFACE;
/** Кромка карточек и разделители внутри них. */
export const WELCOME_GLASS_BORDER = UI_RIM;
/** Фон пустых аватаров в верхнем блоке «Онлайн». */
export const WELCOME_ONLINE_PLACEHOLDER_BG = UI_ACCENT_SOFT;

export const LIVI = {
  bg: HOME_NAV_BG,
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

/** Активная иконка / подсветка speaker & peer-video на audio UI и in-app PiP — общий акцент. */
export const WELCOME_NAV_ACTIVE_ICON = UI_ACCENT;
export const WELCOME_NAV_ACTIVE_ACCENT = {
  solid: WELCOME_NAV_ACTIVE_ICON,
  softText: WELCOME_NAV_ACTIVE_ICON,
  solid15: 'rgba(98, 176, 216, 0.15)',
  solid30: 'rgba(98, 176, 216, 0.30)',
} as const;

/** Активный Bluetooth на кнопке маршрута звонка — приглушённый фиолет (чуть ярче fill/рамка). */
export const CALL_BLUETOOTH_ACCENT = {
  solid: '#9B82C4',
  softText: '#C9B6E8',
  solid15: 'rgba(155, 130, 196, 0.24)',
  solid30: 'rgba(155, 130, 196, 0.48)',
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
/** Высота welcome-карточки (контент) — компактная, в масштаб сжатой стеклянной шапки. */
export const WELCOME_FRIEND_CARD_ROW_HEIGHT = 54;
/** Зазор между welcome-карточками. */
export const WELCOME_FRIEND_CARD_GAP = 5;
/** Шаг для getItemLayout (высота + зазор). */
export const WELCOME_FRIEND_ROW_STRIDE = WELCOME_FRIEND_CARD_ROW_HEIGHT + WELCOME_FRIEND_CARD_GAP;
/** Диаметр аватара в welcome-карточке. */
export const WELCOME_FRIEND_AVATAR_SIZE = 38;
/** Компактные размеры списков только для горизонтальной ориентации. */
export const WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE = 46;
export const WELCOME_FRIEND_CARD_GAP_LANDSCAPE = 3;
export const WELCOME_FRIEND_ROW_STRIDE_LANDSCAPE =
  WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE + WELCOME_FRIEND_CARD_GAP_LANDSCAPE;
export const WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE = 34;
/** Слегка увеличенные размеры списков на планшетах в обеих ориентациях. */
export const WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET = 60;
export const WELCOME_FRIEND_CARD_GAP_TABLET = 7;
export const WELCOME_FRIEND_ROW_STRIDE_TABLET =
  WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET + WELCOME_FRIEND_CARD_GAP_TABLET;
export const WELCOME_FRIEND_AVATAR_SIZE_TABLET = 42;
/** Скругление внешней оболочки сегментов «Все / Онлайн» (не pill). */
export const WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS = 14;
/**
 * Высота карточки «Пригласить друзей» (и блока фильтров в горизонтали) — как блок фильтров
 * в шапке (GLASS_SEGMENT_HEIGHT), чтобы карточка не выбивалась среди компактных строк.
 */
export const WELCOME_FRIENDS_SEGMENT_HEIGHT = { phone: 60, landscape: 44, tablet: 64 } as const;
/** Отступ под блоком «Все / Онлайн» — от него считается и надпись пустого списка. */
export const WELCOME_FRIENDS_SEGMENT_GAP = { phone: 12, landscape: 6, tablet: 14 } as const;
/**
 * Android: тень блока «Все / …» плотнее обычной, у кромки одного тона со всех сторон.
 * Чуть темнее сам блок (baseOpacity), вокруг — размытый ореол (soft) и кольцевой акцент:
 * вторая тень, раздвинутая на 1 dp, а снизу ещё на 3 dp — там она чуть длиннее и ложится
 * на строки, которые уходят под блок. Сверху и по бокам ~8 dp, снизу ~11 dp.
 */
export const WELCOME_FRIENDS_SEGMENT_SHADOW = {
  spread: 7,
  soft: true,
  baseOpacity: 1.3,
  ringOffset: 1,
  ringDrop: 3,
  ringOpacity: 1.2,
} as const;

/** Отступ над карточкой «Пригласить друзей» (футер списка друзей). */
export const WELCOME_FRIENDS_INVITE_GAP = { phone: 8, landscape: 4, tablet: 8 } as const;
/** Кнопки звонка/чата в welcome-строке — скругление (круг при 42×42). */
export const WELCOME_FRIEND_ACTION_BTN_RADIUS = 21;
/** Иконки звонка/чата welcome — общий акцент. */
export const WELCOME_FRIEND_ACTION_ICON = UI_ACCENT;
export const WELCOME_FRIEND_ACTION_ICON_PRESSED = UI_ACCENT_PRESSED;

/** Кнопки звонка/чата в строке: заметно светлее строки (UI_ROW_SURFACE), чтобы читались кнопками. */
export const WELCOME_FRIEND_ACTION_BTN_SURFACE = {
  backgroundColor: '#3D4857',
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: UI_RIM,
  justifyContent: 'center' as const,
  alignItems: 'center' as const,
};

export const WELCOME_FRIEND_ACTION_BTN_PRESSED_SURFACE = {
  backgroundColor: HOME_NAV_SEGMENT_ACTIVE,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: UI_RIM,
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

/** Align brand row height with crown / top-bar controls. */
export const WELCOME_TOP_BAR_CONTROL_SIZE = 42;
/**
 * Боковые отступы верхней панели вкладок. На «Поиске» слева логотип «LiVi», справа корона;
 * на «Друзьях», «Звонках» и «Чате» кнопка поиска и корона стоят на тех же местах.
 */
export const WELCOME_TOP_BAR_SIDE_PAD = 26;
/** Телефон в landscape: верхней панели почти не остаётся высоты. */
export const WELCOME_TOP_BAR_SIDE_PAD_TIGHT = 18;
/** «L» логотипа видна правее края его SVG (обводка + поле буквы) — кнопку поиска ставим вровень с ней. */
export const WELCOME_BRAND_GLYPH_INSET = 4;
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
/** Компенсация ширины ореола справа у chrome-контролов. */
export const CHROME_PERIMETER_GLOW_LAYOUT_INSET =
  CHROME_PERIMETER_GLOW_LAYERS * CHROME_PERIMETER_GLOW_SPREAD;
export const ANIMATED_BORDER_WIDTH = StyleSheet.hairlineWidth;
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

export const DRAFT_KEY = 'profile_draft_v1';
export const MISSED_CALLS_KEY = 'missed_calls_by_user_v1';
export const UNREAD_BY_USER_KEY = 'unread_by_user_v1';
/** Пиры, у которых чат очищен «для себя» — не поднимать строку из server lastMessage. */
export const CHAT_CLEARED_FOR_ME_KEY = 'chat_cleared_for_me_v1';
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

/**
 * Радар Поиска в портрете телефона. До 384 dp (A35, S25 по умолчанию) — как было:
 * 88% ширины, не больше 328. На более широких телефонах (Pixel, Pro Max, уменьшенный
 * «Масштаб экрана») растёт вместе с шириной, иначе вокруг остаётся пустота.
 */
export const SEARCH_RADAR_PHONE_BASE = 328;
const SEARCH_RADAR_PHONE_BASE_WIDTH = 384;
const SEARCH_RADAR_PHONE_MAX = 440;

export function searchPhoneRadarPreferred(width: number, compact = false): number {
  return Math.min(
    width * (compact ? 0.84 : 0.88),
    SEARCH_RADAR_PHONE_BASE * Math.max(1, width / SEARCH_RADAR_PHONE_BASE_WIDTH),
    SEARCH_RADAR_PHONE_MAX,
  );
}

/** Во сколько раз содержимое крупнее базового на широком телефоне (1 — до 384 dp). */
export function searchPhoneScale(width: number): number {
  if (!(width > 0)) return 1;
  return Math.max(1, searchPhoneRadarPreferred(width) / SEARCH_RADAR_PHONE_BASE);
}

/**
 * Ширина первой (внутренней) орбиты радара вокруг аватара. Орбиты не сжимаем
 * дополнительным коэффициентом: радар и так ограничен высотой сцены, а лишнее
 * сжатие склеивало полосы вокруг крупного аватара.
 */
export function welcomeRadarFirstRingWidth(radarSize: number, avatarBase: number): number {
  const half = radarSize / 2;
  const avatarOuter = Math.round(avatarBase / 2) + 2;
  const stepTotal = 0.56 + 0.86 + 1.18 + 1.14;
  const g = Math.max(half * 0.078, (half * 0.85 - avatarOuter) / stepTotal);
  return g * 0.56;
}

/**
 * Аватар Поиска в вертикали телефона — эталон для всех раскладок: Поиск и
 * Профиль в обеих ориентациях показывают аватар ровно этого размера. Считается
 * от короткой стороны окна (ширины в вертикали), поэтому при повороте не меняется.
 *
 * base — фото без захода на орбиту (от него строятся кольца и аватар с рамкой),
 * outer — внешний диаметр: фото заходит на 2/3 первой орбиты,
 * frameOutset — вынос купленной рамки за край фото.
 */
export function welcomePhoneAvatarMetrics(shortSide: number): {
  base: number;
  outer: number;
  frameOutset: number;
} {
  const radar = searchPhoneRadarPreferred(shortSide);
  const base = Math.round(
    Math.min((shortSide < 400 ? 112 : 124) * searchPhoneScale(shortSide), radar * 0.42),
  );
  const ring = welcomeRadarFirstRingWidth(radar, base);
  return {
    base,
    outer: Math.round(base + (ring * 2) / 3),
    // Рамка начинается у края фото, проходит служебный зазор 2 px и перекрывает
    // только внутреннюю часть первой орбиты.
    frameOutset: 2 + ring * 0.22,
  };
}

/** Телефон в landscape не становится планшетом только из-за большой длинной стороны. */
export function isWelcomeTabletLayout(width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0)) return false;
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  return (
    shortSide >= SEARCH_CTA_TABLET_MIN_WIDTH ||
    (width >= SEARCH_CTA_TABLET_MIN_WIDTH && longSide / shortSide < 1.6)
  );
}
