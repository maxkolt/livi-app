/**
 * Стили экрана звонка.
 *
 * Вынесено из VideoCall.tsx как есть: это данные, поведение не меняется. Но 370 строк
 * таблицы стилей посреди логики мешали читать сам компонент.
 */

import { Dimensions, Platform, StyleSheet } from 'react-native';
import {
  WELCOME_HEADER_TITLE,
  WELCOME_NAV_ACTIVE_ACCENT,
  WELCOME_NAV_ACTIVE_ICON,
  WELCOME_STAGE_BG,
} from '../../../screens/home/constants';

/** Общая основа «карточек» поверх видео: тёмная подложка со скруглением. */
export const CARD_BASE = {
  backgroundColor: 'rgba(13,14,16,0.85)',
  borderRadius: 10,
  justifyContent: 'center' as const,
  alignItems: 'center' as const,
  overflow: 'hidden' as const,
  marginVertical: 2,
  position: 'relative' as const,
};

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    // padding не задаём тут: на Android safe-area + базовый отступ считаем во внутреннем контейнере (styles.content)
  },
  systemPiPContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  systemPiPAudioMatch: {
    backgroundColor: WELCOME_STAGE_BG,
  },
  systemPiPVideoFill: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: 'transparent',
  },
  systemPiPLocalInset: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    width: 48,
    height: 72,
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.18)',
    zIndex: 4,
  },
  unifiedCallStage: {
    flex: 1,
    width: '100%',
    position: 'relative',
  },
  unifiedRemoteFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },
  localHoldStageOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 25,
  },
  unifiedLocalPipDrag: {
    position: 'absolute',
    width: 112,
    height: 168,
    zIndex: 30,
  },
  unifiedLocalPip: {
    flex: 1,
    backgroundColor: '#000',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  unifiedLocalPipInner: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  unifiedFlipBtn: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 4,
    elevation: 12,
  },
  unifiedFlipBtnOnMain: {
    right: 18,
    bottom: 130,
    zIndex: 28,
  },
  audioCallContainer: {
    backgroundColor: WELCOME_STAGE_BG,
  },
  audioCallContent: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 48,
  },
  audioCallHeader: {
    width: '100%',
    alignItems: 'center',
    paddingTop: 56,
  },
  audioCallHeaderSpacer: {
    flex: 1,
    width: '100%',
  },
  audioCallName: {
    fontSize: 28,
    fontWeight: '500',
    letterSpacing: -0.3,
    lineHeight: 34,
    color: WELCOME_HEADER_TITLE,
    textAlign: 'center',
  },
  audioCallSubtitle: {
    marginTop: -4,
    fontSize: 12,
    lineHeight: 16,
    color: '#B0B0B0',
    textAlign: 'center',
  },
  audioCallSubtitleHold: {
    marginTop: 4,
    fontSize: 16,
    fontWeight: '600',
    color: WELCOME_HEADER_TITLE,
  },
  audioCallTimer: {
    marginTop: 6,
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    color: WELCOME_HEADER_TITLE,
    textAlign: 'center',
  },
  audioCallControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
    marginBottom: 16,
  },
  audioCallControlsLocked: {},
  audioRoundBtnLocked: {
    opacity: 0.35,
  },
  audioVideoBtnWrap: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioRoundBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Как `btn_decline_round` / OutgoingCallActivity `btn_cancel` (colors.xml). */
  audioRoundBtnDanger: {
    backgroundColor: '#CC4A1E2A',
    borderWidth: 1,
    borderColor: '#A33B4F',
  },
  audioCallPeerVideoHint: {
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 8,
  },
  audioRoundBtnDangerPressed: {
    backgroundColor: '#F06A2E3C',
    borderColor: '#C45A6E',
  },
  content: {
    flex: 1,
    width: '100%',
    alignItems: "center",
    justifyContent: 'space-between',
  },
  topSection: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    position: 'relative',
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
  eqWrapper: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  rtc: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'black',
  },
  placeholder: {
    color: 'rgba(237,234,234,0.6)',
    fontSize: 22,
  },
  bottomRow: {
    // Как в RandomChat: отступы от краёв экрана до кнопки — iOS 3% слева/справа + 16px, Android 2px
    width: Platform.OS === 'android' ? '100%' : '94%',
    flexDirection: 'row',
    gap: Platform.OS === "android" ? 14 : 16,
    marginTop: Platform.OS === "android" ? 5 : 10,
    marginBottom: Platform.OS === "android" ? 4 : 32,
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
  btnDanger: {
    backgroundColor: 'rgba(214, 46, 49, 0.34)',
  },
  btnDangerText: {
    color: '#C5C9CE',
  },
  endCallPhoneIcon: {
    width: 22,
    height: 16,
  },
  disabled: {
    opacity: 1,
  },
  topLeftAudio: {
    position: 'absolute',
    top: 8,
    left: 8,
  },
  iconBtn: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 22,
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconBtnDisabled: {
    opacity: 0.4,
  },
  incomingOverlayContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 10,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  incomingOverlayContent: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  incomingOverlayTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginTop: 10,
  },
  incomingOverlayName: {
    color: '#e5e7eb',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 4,
  },
  incomingOverlayButtons: {
    flexDirection: 'row',
    gap: 14,
    width: '100%',
    paddingHorizontal: 28,
    marginTop: 16,
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
  incomingTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 10,
  },
  incomingName: {
    color: '#e5e7eb',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 4,
    marginBottom: 14,
  },
  incomingButtons: {
    flexDirection: 'row',
    gap: 14,
    width: '100%',
    paddingHorizontal: 28,
    justifyContent: 'center',
  },
  btnGlassBase: {
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    flex: 1,
  },
  btnGlassSuccess: {
    backgroundColor: 'rgba(76, 175, 80, 0.16)',
    borderColor: 'rgba(76, 175, 80, 0.65)',
  },
  btnGlassDanger: {
    backgroundColor: 'rgba(255,77,77,0.16)',
    borderColor: 'rgba(255,77,77,0.65)',
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
    backgroundColor: WELCOME_NAV_ACTIVE_ACCENT.solid15,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: WELCOME_NAV_ACTIVE_ACCENT.solid30,
  },
  friendBadgeText: {
    color: WELCOME_NAV_ACTIVE_ICON,
    fontSize: 12,
    fontWeight: '600',
  },
});
