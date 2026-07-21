import { Platform, Dimensions, StyleSheet } from 'react-native';
import { CARD_BASE } from './constants';

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
  placeholder: {
    color: 'rgba(237,234,234,0.6)',
    fontSize: 22,
  },
  bottomRow: {
    // Ширина как у карточек (блок «Вы»): на iOS 94%, на Android 100%
    width: Platform.OS === 'android' ? '100%' : '94%',
    flexDirection: 'row',
    gap: Platform.OS === "android" ? 11 : 16,
    marginTop: Platform.OS === "android" ? 5 : 10,
    marginBottom: Platform.OS === "android" ? 4 : 32,
    // Смещаем кнопки к центру: «Начать» от левого края, «Далее» от правого
    paddingHorizontal: Platform.OS === "android" ? 2 : 16,
  },
  bigBtn: {
    flex: 1,
    height: Platform.OS === "android" ? 50 : 60,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigBtnText: {
    color: '#333333',
    fontSize: 16,
    fontWeight: '600',
  },
  btnTitan: {
    backgroundColor: '#8a8f99',
  },
  btnDanger: {
    backgroundColor: '#ff4d4d',
  },
  disabled: {
    opacity: 1,
  },
  topRight: {
    position: 'absolute',
    top: 10,
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
    backgroundColor: '#1f2937',
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
  friendBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,255,0,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,255,0,0.3)',
  },
  friendBadgeText: {
    color: '#0f0',
    fontSize: 12,
    fontWeight: '600',
  },
  toast: {
    position: 'absolute',
    bottom: 86,
    left: '7%',
    right: '7%',
    backgroundColor: 'rgba(13,14,16,0.92)',
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
