import { Platform, Dimensions, StyleSheet } from 'react-native';
import {
  UI_ACCENT_SELECTED,
  UI_SURFACE_RAISED,
  WELCOME_HEADER_TITLE,
} from '../../../screens/home/constants';
import { CARD_BASE } from './constants';

/** Горизонталь: отступ от краёв и зазор между карточками. */
const LANDSCAPE_CARD_GAP = 8;

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    // padding не задаём тут: на Android safe-area + базовый отступ считаем во внутреннем контейнере (styles.content)
  },
  content: {
    flex: 1,
    width: '100%',
    alignItems: "center",
    // Важно: нижний ряд кнопок должен быть всегда внизу внутри safe-area
    justifyContent: 'space-between',
  },
  topSection: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
  },
  /** Горизонталь: карточки рядом, иначе каждая получает ~150 по высоте. */
  topSectionLandscape: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: LANDSCAPE_CARD_GAP,
    paddingHorizontal: LANDSCAPE_CARD_GAP,
  },
  /**
   * Горизонталь: карточка целиком, а не поверх styles.card. `width: undefined` в
   * накладываемом стиле RN (old arch) сбрасывал ширину и после поворота обратно не
   * возвращал '100%' из styles.card — карточки сжимались до ширины текста.
   */
  cardLandscape: {
    ...CARD_BASE,
    flex: 1,
    flexBasis: 0,
    minHeight: 0,
  },
  /** Горизонталь: кнопки остаются в углах карточки, только мельче. */
  iconBtnLandscape: {
    padding: 6,
    borderRadius: 18,
  },
  /** Каждая кнопка ровно под своей карточкой: те же отступы от краёв и тот же зазор. */
  bottomRowLandscape: {
    width: '100%',
    paddingHorizontal: LANDSCAPE_CARD_GAP,
    gap: LANDSCAPE_CARD_GAP,
    marginTop: 4,
    marginBottom: 4,
  },
  bigBtnLandscape: {
    height: 40,
  },
  card: {
    ...CARD_BASE,
    width: Platform.OS === 'android' ? '100%' : '94%',
    ...(Platform.OS === 'android'
      ? {
          flex: 1,
          flexBasis: 0,
          minHeight: 170,
        }
      : { height: Dimensions.get('window').height * 0.4 }),
  },
  rtc: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'black',
    // КРИТИЧНО: Отключаем оптимизации, которые могут блокировать обновление видео
    ...(Platform.OS === 'android' ? {
      // На Android не используем shouldRasterizeIOS, так как это iOS-специфичное свойство
    } : {
      // На iOS можно добавить дополнительные оптимизации если нужно
    }),
  },
  remoteStage: {
    flex: 1,
    width: '100%',
  },
  remoteBlack: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  overlayFill: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    // Important: the placeholder must include its own background, otherwise
    // the underlying video/black layer can change a frame earlier and looks like a "two-step" disappear.
    backgroundColor: '#000',
  },
  overlayCenter: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    // Loader must disappear as a single unit (background + spinner)
    backgroundColor: '#000',
  },
  networkOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 9999,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Модерация: полностью перекрывает видео при недоступности проверки или подтверждённой блокировке.
  moderationUnavailableOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10000,
    elevation: 10000,
    backgroundColor: 'rgba(0,0,0,0.96)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  /** Переподключение посреди разговора: последний кадр виден сквозь затемнение. */
  reconnectingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  reconnectingText: {
    marginTop: 12,
    color: 'rgba(237,234,234,0.85)',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  moderationUnavailableText: {
    marginTop: 12,
    color: 'rgba(237,234,234,0.85)',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  placeholder: {
    color: 'rgba(237,234,234,0.6)',
    fontSize: 22,
  },
  bottomRow: {
    // Вертикаль: края кнопок совпадают с краями карточек — та же ширина, без своих отступов
    // (на iOS 94%, на Android 100%).
    width: Platform.OS === 'android' ? '100%' : '94%',
    flexDirection: 'row',
    gap: Platform.OS === "android" ? 11 : 16,
    marginTop: Platform.OS === "android" ? 5 : 10,
    marginBottom: Platform.OS === "android" ? 4 : 32,
  },
  /** Обёртка кнопки: делит строку пополам и несёт масштаб нажатия. */
  bigBtnWrap: {
    flex: 1,
  },
  bigBtn: {
    height: Platform.OS === "android" ? 50 : 60,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  /** Подсветка нажатия поверх заливки; прозрачность ведёт нативная анимация. */
  bigBtnShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: UI_ACCENT_SELECTED,
  },
  bigBtnShadeDanger: {
    backgroundColor: '#5C1A28',
  },
  // Как надпись «Онлайн» на «Поиске»: тот же цвет, размер и насыщенность (шрифт — в RandomChat).
  bigBtnText: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 16,
    fontWeight: '400',
    letterSpacing: 0.1,
  },
  /** «Начать» и «Далее»: лёгкий тон акцента, без рамки. */
  btnPrimary: {
    backgroundColor: 'rgba(98, 176, 216, 0.16)',
  },
  btnDanger: {
    backgroundColor: '#7A2436',
  },
  disabled: {
    opacity: 1,
  },
  topRight: {
    position: 'absolute',
    top: 10,
    right: 10,
  },
  bottomRight: {
    position: 'absolute',
    bottom: 10,
    right: 10,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCard: {
    width: '86%',
    backgroundColor: UI_SURFACE_RAISED,
    padding: 16,
    borderRadius: 12,
  },
  modalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  modalText: {
    color: '#e5e7eb',
    fontSize: 14,
  },
  btnGlassBase: {
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    flex: 1,
  },
  btnGlassDanger: {
    backgroundColor: 'rgba(255,77,77,0.16)',
    borderColor: 'rgba(255,77,77,0.65)',
  },
  btnGlassTitan: {
    backgroundColor: 'rgba(138,143,153,0.16)',
    borderColor: 'rgba(138,143,153,0.65)',
  },
  modalBtnText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  toast: {
    position: 'absolute',
    bottom: 86,
    left: '7%',
    right: '7%',
    backgroundColor: 'rgba(54, 64, 76, 0.96)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastText: {
    color: '#B7C0CF',
    fontSize: 14,
    fontWeight: '600',
  },
  /** Модерация: нарушения правил, бан, предупреждение партнёру */
  toastTextModeration: {
    fontWeight: '400',
    fontSize: 15,
  },
  iconBtn: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 22,
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
    // Android: чтобы кнопки были выше видеовью (TextureView/обычные View)
    ...(Platform.OS === 'android' ? { elevation: 40 } : {}),
  },
  iconBtnDisabled: {
    opacity: 0.4,
  },
  topLeft: {
    position: 'absolute',
    top: 10,
    left: 10,
    zIndex: 40,
    ...(Platform.OS === 'android' ? { elevation: 40 } : {}),
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    zIndex: 40,
    ...(Platform.OS === 'android' ? { elevation: 40 } : {}),
  },
});
