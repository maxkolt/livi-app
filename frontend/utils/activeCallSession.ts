import { NativeModules, Platform } from 'react-native';
import { normalizeInCallRoute } from '../components/VideoChat/hooks/audioRouteTypes';

/** Сброс JS + native «завершение звонка» (блокирует system PiP в onUserLeaveHint). */
export function clearEndingCallInProgress(): void {
  try {
    const g = global as any;
    g.__endingCallInProgressRef = g.__endingCallInProgressRef || { current: false };
    g.__endingCallInProgressRef.current = false;
  } catch {}
  if (Platform.OS === 'android') {
    try {
      NativeModules.LiviAppModule?.setEndingCallInProgress?.(false);
    } catch {}
  }
}

/** Активный direct / VideoCall (не teardown, сессия не ended). */
export function isOngoingCallSession(): boolean {
  try {
    const g = global as any;
    if (g.__endingCallInProgressRef?.current === true) return false;
    if (g.__callEndedFromPiPNoOpenRef?.current === true) return false;
    if (g.__videoCallActiveRef?.current === false) return false;
    const session = g.__webrtcSessionRef?.current;
    if (session && typeof session.isEnded === 'function' && session.isEnded()) return false;
    if (session) return true;
    return g.__videoCallActiveRef?.current === true;
  } catch {
    return false;
  }
}

export function resolveActiveCallInCallMedia(): 'audio' | 'video' {
  try {
    const g = global as any;
    if (g.__inAudioOnlyUiRef?.current === true) return 'audio';
    const params = g.__currentCallPiPParamsRef?.current;
    if (params?.inAudioOnlyUi === true) return 'audio';
    if (params?.preferVideoCallUi === false) return 'audio';
    const session = g.__webrtcSessionRef?.current;
    if (session && typeof session.isCameraSuspendedForAppBackground === 'function') {
      if (session.isCameraSuspendedForAppBackground()) return 'audio';
    }
    if (g.__pipInSystemModeRef?.current === true) {
      const localCamOn = params?.localCamOn;
      if (localCamOn === false) return 'audio';
    }
  } catch {}
  return 'video';
}

/** Сохранить маршрут из PiP params / persisted перед уходом в фон. */
export function captureCallAudioRouteFromUi(): void {
  try {
    const g = global as any;
    const fromParams = normalizeInCallRoute(g.__currentCallPiPParamsRef?.current?.audioOutputRoute || '');
    if (fromParams) {
      g.__persistedCallAudioRouteRef = g.__persistedCallAudioRouteRef || { current: null };
      g.__persistedCallAudioRouteRef.current = fromParams;
    }
  } catch {}
}
