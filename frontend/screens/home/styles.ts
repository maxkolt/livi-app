import { Platform, StyleSheet, type ViewStyle } from 'react-native';
import {
  FRIEND_ACTION_BUTTON,
  FRIEND_ROW_ACTION_GAP,
  FRIEND_ROW_TRAILING_PAD,
} from '../../constants/uiTokens';
import {
  ANIMATED_BORDER_WIDTH,
  BRAND_FONT_FAMILY,
  FRIEND_LIST_ROW_BG,
  FRIEND_ROW_DIVIDER_HEIGHT,
  FRIEND_ROW_LAYOUT_HEIGHT,
  FRIENDS_LIST_HORIZONTAL_PAD,
  LIVI,
  MENU_BTN_RADIUS,
  MENU_BTN_SIZE,
} from './constants';

export const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: LIVI.bg, paddingHorizontal: 14, paddingBottom: 10, justifyContent: 'center' },
  topBar: { height: 100, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',   paddingHorizontal: Platform.OS === "android" ? 0 : 10, },
  brandOutlineWrap: {
    position: 'relative',
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    minHeight: MENU_BTN_SIZE + ANIMATED_BORDER_WIDTH * 2,
  },
  brandMeasureProbe: {
    position: 'absolute',
    opacity: 0,
    left: 0,
    top: 0,
    zIndex: -1,
  },
  brand: {
    color: LIVI.text,
    fontSize: 41,
    lineHeight: 40,
    fontWeight: '600',
    letterSpacing: 0.3,
    fontFamily: BRAND_FONT_FAMILY,
  },
  menuBtnInner: {
    borderRadius: MENU_BTN_RADIUS,
    overflow: 'hidden',
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuBtnPressed: { opacity: 0.9 },
  menuBtnIconWrap: { margin: 0, backgroundColor: 'transparent', justifyContent: 'center', alignItems: 'center' },
  // Симметричные отступы: левый padding у FlatList; правый — paddingRight у блока кнопок.
  // Swipeable только на аватар+ник; звонок/чат в отдельной колонке справа.
  friendsList: {
    flex: 1,
    backgroundColor: FRIEND_LIST_ROW_BG,
  },
  friendsListContent: {
    paddingBottom: 24,
    paddingHorizontal: FRIENDS_LIST_HORIZONTAL_PAD,
    backgroundColor: FRIEND_LIST_ROW_BG,
  },
  friendsTabHost: {
    flex: 1,
    backgroundColor: FRIEND_LIST_ROW_BG,
  },
  listRowWrap: {
    position: 'relative',
    overflow: 'visible' as const,
    flexDirection: 'row',
    alignItems: 'stretch',
    height: FRIEND_ROW_LAYOUT_HEIGHT,
    backgroundColor: 'transparent',
  },
  /** Линия между строками — сверху текущей ячейки, чтобы RecyclerView не перекрывал нижний border. */
  friendRowDivider: {
    position: 'absolute',
    top: 0,
    left: 4,
    right: 4,
    height: FRIEND_ROW_DIVIDER_HEIGHT,
    backgroundColor: LIVI.border,
    zIndex: 2,
  },
  friendRowSwipeColumn: {
    flex: 1,
    minWidth: 0,
    backgroundColor: 'transparent',
  },
  listRow: {
    backgroundColor: FRIEND_LIST_ROW_BG,
    paddingVertical: 10,
    paddingRight: 0,
  },
  listRowAligned: {
    flexDirection: 'row',
    width: '100%',
    alignItems: 'center',
    paddingLeft: 0,
    paddingRight: 0,
    minHeight: 72,
    flex: 1,
    alignSelf: 'stretch' as const,
    position: 'relative' as const,
  },
  /** Чтобы бейджи на углу кнопок (translate 50%/-50%) не обрезались TouchableRipple / строкой */
  listRowOverflowVisible: { overflow: 'visible' as const },
  listRowContainerOverflowVisible: { overflow: 'visible' as const },
  nameCol: { marginLeft: 16, justifyContent: 'center' },
  friendRowNameFlex: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  friendName: {
    color: LIVI.white,
    fontWeight: '700',
    fontSize: Platform.OS === "android" ? 16 : 20,
    lineHeight: Platform.OS === "android" ? 18 : 30,
  },
  friendStatus: {
    marginTop: 2,
    fontSize: Platform.OS === "android" ? 11 : 13,
    fontWeight: '300',
    ...(Platform.OS === 'android' && { fontFamily: 'sans-serif-light' }),
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  centerAvatarWrap: {
    width: Platform.OS === "ios" ? 136 : 120,
    height: Platform.OS === "ios" ? 136 : 120,
    borderRadius: Platform.OS === "ios" ? 68 : 60,
    overflow: 'hidden' as ViewStyle['overflow'],
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  
  centerAvatarImg: { width: '100%', height: '100%' },
  title: {
    color: LIVI.text,
    fontSize: Platform.OS === 'android' ? 24 : 26,
    fontWeight: '400',
    letterSpacing: 0.3,
    textAlign: 'center',
    lineHeight: Platform.OS === 'android' ? 28 : 30,
    maxWidth: '100%',
  },
  subtitle: {
    color: LIVI.text2,
    fontSize: Platform.OS === 'android' ? 13 : 16,
    lineHeight: Platform.OS === 'android' ? 17 : 20,
    textAlign: 'center',
    marginTop: 2,
  },
  subtitleNik: { color: LIVI.text2, fontSize: 18, textAlign: 'center' },

  button: {
    borderRadius: 12,
    paddingVertical: Platform.OS === "ios" ? 18 : 16,
    paddingHorizontal: 32,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
    elevation: 6,
    backgroundColor: LIVI.titan,
  },
  buttonLabel: { color: '#151515', fontSize: 16, fontWeight: '700', letterSpacing: 0.4 },

  // IMPORTANT: do NOT use fixed screenWidth/screenHeight here.
  overlayMenu: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent', zIndex: 999 },
  overlayModal: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent', zIndex: 999, alignItems: 'center', justifyContent: 'center' },

  sheetFull: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Platform.OS === "android"
      ? "#0D0E10"
      : "rgba(13,14,16,0.88)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LIVI.border,
  },
  sheetTopBar: { height: 56, flexDirection: 'row', marginTop: Platform.OS === "android" ? 26 : 12, alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 },
  sheetTitle: { color: LIVI.white, fontSize: 16, fontWeight: '700' },
  sheetCornerIconBtn: {
    width: FRIEND_ACTION_BUTTON.width,
    height: FRIEND_ACTION_BUTTON.height,
    borderRadius: FRIEND_ACTION_BUTTON.borderRadius,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetCornerIconBtnDanger: {
    backgroundColor: 'rgba(255,90,103,0.1)',
  },
  modalFloatingCornerBtn: {
    position: 'absolute',
    width: FRIEND_ACTION_BUTTON.width,
    height: FRIEND_ACTION_BUTTON.height,
    borderRadius: FRIEND_ACTION_BUTTON.borderRadius,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },

  segmentCapsule: {
    flexDirection: 'row', alignItems: 'stretch', margin: Platform.OS === "android" ? 12 : 12,
    backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 114,
    borderWidth: StyleSheet.hairlineWidth, borderColor: LIVI.border, overflow: 'hidden', minHeight: 44,
  },
  segItem: { flex: 1, justifyContent: 'center' },
  segLeft: { borderTopLeftRadius: 114, borderBottomLeftRadius: 114 },
  segRight: { borderTopRightRadius: 114, borderBottomRightRadius: 114 },
  segContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 44 },
  segLabel: {
    color: LIVI.white,
    fontWeight: '400',
    fontSize: Platform.OS === 'android' ? 14 : 16,
  },
  segDivider: { width: StyleSheet.hairlineWidth, backgroundColor: LIVI.border, marginVertical: 8 },
  segActiveBg: { backgroundColor: 'rgba(157, 161, 169, 0.11)' },
  segTopShadow: { position: 'absolute', top: 0, left: 0, right: 0, height: 0 },

  rowRightActionsTray: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: FRIEND_ROW_TRAILING_PAD,
    overflow: 'visible' as const,
    flexShrink: 0,
    backgroundColor: 'transparent',
  },
  friendRowSwipeContainer: { flex: 1, alignSelf: 'stretch' as const, overflow: 'hidden' as const },

  actionBtn: { backgroundColor: LIVI.glass, borderRadius: 12 },
  friendActionBtnSize: {
    width: FRIEND_ACTION_BUTTON.width,
    height: FRIEND_ACTION_BUTTON.height,
    borderRadius: FRIEND_ACTION_BUTTON.borderRadius,
  },
  /** Отступ между видео и чатом — снаружи якоря кнопки, чтобы hitSlop-зоны не пересекались. */
  chatBtnOuter: { marginLeft: FRIEND_ROW_ACTION_GAP },
  friendActionBadgeAnchor: {
    width: FRIEND_ACTION_BUTTON.width,
    height: FRIEND_ACTION_BUTTON.height,
    position: 'relative' as const,
    overflow: 'visible' as const,
  },
  friendCallActionsAnchor: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    position: 'relative' as const,
    overflow: 'visible' as const,
  },


  menuDot: {
    position: 'absolute',
    top: -2,
    right: 2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,90,103,0.95)',
  },

  // Центр круга на вершине правого верхнего угла кнопки (половина снаружи кнопки) — как в макете.
  badgeBubble: {
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 30,
    minWidth: 11,
    minHeight: 11,
    height: 11,
    paddingHorizontal: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(255,90,103,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'android' ? { elevation: 12 } : {}),
    transform: [{ translateX: 4.5 }, { translateY: -3.5 }],
  },
  badgeBubbleText: { color: '#fff', fontSize: 8, fontWeight: '800', lineHeight: 8 },

  // Полоска «Прочитано / Просмотрено» — без фона и без elevation (только чип).
  markReadMenuOverlay: {
    position: 'absolute',
    left: Platform.OS === 'ios' ? 72 : 64,
    right: 0,
    top: 0,
    height: FRIEND_ROW_LAYOUT_HEIGHT,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingRight: FRIEND_ROW_TRAILING_PAD,
  },

  rightWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    overflow: 'visible' as const,
    gap: 6,
  },
  busyBadge: {
    backgroundColor: 'rgba(255,90,103,0.25)',
    borderRadius: 8,
    paddingVertical: 2,
    paddingHorizontal: 6,
    marginRight: 12,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,90,103,0.6)',
  },
  busyText: {
    color: '#FF5A67',
    fontWeight: '400',
    fontSize: 11,
  },

  input: { marginBottom: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12 },
  fieldLabel: { color: LIVI.text2, fontSize: 14, fontWeight: '500', marginBottom: 8, marginTop: 16 },

  swipeRight: { justifyContent: 'center' },

  // SettingsTab needs
  avatarCircle: {
    width: 64, height: 64, borderRadius: 32, overflow: 'hidden' as ViewStyle['overflow'],
    backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center',
  },
  avatarImg: { width: '100%', height: '100%' },
  deleteBadge: { position: 'absolute', right: -6, bottom: -6, backgroundColor: 'rgba(0,0,0,0.5)' },

  // дефолт «—»

  // friend avatar
  avatarBox: {
    width: Platform.OS === "ios" ? 52 : 44,       // iOS больше, Android меньше
    height: Platform.OS === "ios" ? 52 : 44, 
    borderRadius: 24, overflow: 'hidden' as ViewStyle['overflow'],
    backgroundColor: 'rgba(132, 135, 140, 0.17)', alignItems: 'center', justifyContent: 'center',
  },
  avatarImgFull: { width: '100%', height: '100%' },

  // Блок приветствия: заголовок по центру (как раньше), слот для бейджа между подзаголовком и кнопкой, кнопка «Начать поиск»
  welcomeBlock: { flex: 1, alignItems: 'center' },
  welcomeTextBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: 35,
    minHeight: 0,
    width: '100%',
    paddingHorizontal: 4,
  },
  // Резерв высоты как раньше — чтобы аватар/тексты не съезжали; сами бейджи рисуются absolute поверх.
  noticeSlot: {
    minHeight: 72,
    marginBottom: 24,
    width: '100%',
  },
  // notice (бейдж «Вызов завершён» и др.): по центру между подзаголовком и кнопкой
  notice: {
    borderRadius: 12,
    paddingVertical: 7,
    paddingHorizontal: 9,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    maxWidth: '60%',
  },
  noticeText: { color: LIVI.text2, fontSize: 12, fontWeight: '400', textAlign: 'center' },

  confirmCard: {
    width: '92%', backgroundColor: 'rgba(13,14,16,0.94)', borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth, borderColor: LIVI.border, padding: 16,
  },
  confirmTitle: { color: LIVI.white, fontSize: 18, fontWeight: '700', marginBottom: 6 },
  confirmMsg: { color: LIVI.text2, fontSize: 14 },
  confirmBtns: { flexDirection: 'row', gap: 10, marginTop: 16 },
  confirmBtn: {
    height: 46,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    alignSelf: 'stretch',
    flex: 1,
    backgroundColor: 'rgb(255, 90, 103)',
    borderWidth: 1,
    borderColor: 'rgb(200, 50, 65)',
  },
  confirmBtnText: { fontSize: 15, fontWeight: '700' },
});
export type HomeStyles = typeof styles;
