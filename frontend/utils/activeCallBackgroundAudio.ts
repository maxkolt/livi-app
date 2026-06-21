import { AppState, Platform, type AppStateStatus, NativeModules } from 'react-native';
import { captureCallAudioRouteFromUi, isOngoingCallSession, peekSystemPiPReturnMediaSnapshot, resolveActiveCallInCallMedia, readActiveExternalCallAudioRoute, isDirectAudioEarpieceStabilizeWindow } from './activeCallSession';
import {
  pinLoudSpeakerForAudioCallLeavingToBackground,
  reapplyPersistedCallAudioRoute,
  restoreAudioCallEarpieceAfterHomeReturn,
  restoreCallMediaAfterSystemPiPReturn,
  scheduleReapplyPersistedCallAudioRoute,
  restoreCallAudioForInAppPiPPlaque,
  shouldApplyHomeLoudSpeakerPin,
  armCallAudioPreservePriority,
  isCallAudioPiPTransitionWindow,
  setPersistedCallAudioRoute,
} from './callAudioRoutePersist';
import { armAndroidLeaveHintForVideoCallHome, syncAndroidLeaveHintForOngoingCall } from './activeCallNotification';
import { readNativeProbedExternalRoute } from './nativeCallAudioProbe';

const BACKGROUND_REAPPLY_DELAYS_MS = [0, 450, 1200];
const FOREGROUND_REAPPLY_DELAYS_MS = [0, 350];
const BACKGROUND_INTERVAL_MS = 12_000;
const NATIVE_VOICE_MAINTAIN_MIN_MS = 12_000;

let installed = false;
let bgInterval: ReturnType<typeof setInterval> | null = null;
let lastNativeVoiceMaintainAt = 0;
let lastAppState: AppStateStatus = AppState.currentState;

function clearBackgroundInterval(): void {
  if (bgInterval) {
    clearInterval(bgInterval);
    bgInterval = null;
  }
}

function restoreSessionMicrophoneIfNeeded(): void {
  try {
    const session = (global as any).__webrtcSessionRef?.current;
    if (session && typeof session.restoreMicrophoneAfterAppBackground === 'function') {
      void session.restoreMicrophoneAfterAppBackground();
    }
  } catch {}
}

function nativeMaintainCallVoiceAudio(force = false): void {
  if (Platform.OS !== 'android') return;
  const now = Date.now();
  if (!force && now - lastNativeVoiceMaintainAt < NATIVE_VOICE_MAINTAIN_MIN_MS) return;
  lastNativeVoiceMaintainAt = now;
  try {
    NativeModules.LiviAppModule?.maintainActiveCallVoiceAudio?.();
  } catch {}
}

/** Переприменить incall-маршрут и focus (Home, навигатор, другое приложение поверх). */
export function maintainCallAudioForActiveCall(reason = 'maintain_active_call'): void {
  if (!isOngoingCallSession()) return;
  const media = resolveActiveCallInCallMedia();
  if (media === 'audio' && shouldApplyHomeLoudSpeakerPin()) {
    pinLoudSpeakerForAudioCallLeavingToBackground();
  } else if (media === 'audio') {
    armCallAudioPreservePriority();
  }
  captureCallAudioRouteFromUi();
  nativeMaintainCallVoiceAudio(reason === 'app_state_background');
  scheduleReapplyPersistedCallAudioRoute(reason, {
    media,
    delaysMs: BACKGROUND_REAPPLY_DELAYS_MS,
  });
}

function onAppStateChange(next: AppStateStatus): void {
  const prev = lastAppState;
  lastAppState = next;

  if (!isOngoingCallSession()) {
    clearBackgroundInterval();
    return;
  }

  if (next === 'background') {
    armAndroidLeaveHintForVideoCallHome();
    if (prev !== 'background') {
      maintainCallAudioForActiveCall('app_state_background');
    }
    if (Platform.OS !== 'android') return;
    clearBackgroundInterval();
    const media = resolveActiveCallInCallMedia();
    bgInterval = setInterval(() => {
      if (AppState.currentState !== 'background' || !isOngoingCallSession()) {
        clearBackgroundInterval();
        return;
      }
      captureCallAudioRouteFromUi();
      void reapplyPersistedCallAudioRoute('app_state_background_interval', { media });
      nativeMaintainCallVoiceAudio(false);
    }, BACKGROUND_INTERVAL_MS);
    return;
  }

  if (next === 'active') {
    clearBackgroundInterval();
    lastNativeVoiceMaintainAt = 0;
    syncAndroidLeaveHintForOngoingCall();
    try {
      const g = global as any;
      const returningFromPiP = Date.now() < Number(g.__returningFromSystemPiPUntilRef?.current || 0);
      const hasPendingSnap = !!peekSystemPiPReturnMediaSnapshot();
      if (returningFromPiP || hasPendingSnap) {
        restoreCallMediaAfterSystemPiPReturn();
      } else {
        restoreAudioCallEarpieceAfterHomeReturn();
      }
    } catch {
      restoreAudioCallEarpieceAfterHomeReturn();
    }
    const foregroundExternal =
      readActiveExternalCallAudioRoute() || readNativeProbedExternalRoute();
    const stabilizeEarpiece = isDirectAudioEarpieceStabilizeWindow() && !foregroundExternal;
    if (foregroundExternal) {
      setPersistedCallAudioRoute(foregroundExternal);
      try {
        (global as any).__lastAppliedCallAudioRouteRef = { current: foregroundExternal };
      } catch {}
    } else if (stabilizeEarpiece) {
      setPersistedCallAudioRoute('EARPIECE');
      try {
        (global as any).__lastAppliedCallAudioRouteRef = { current: 'EARPIECE' };
      } catch {}
    } else {
      captureCallAudioRouteFromUi();
    }
    if (prev !== 'active') {
      armCallAudioPreservePriority(isCallAudioPiPTransitionWindow() ? 5000 : 3500);
      try {
        const g = global as any;
        const onHomeWithPlaque =
          g.__pipVisibleRef?.current === true &&
          g.__navRef?.getCurrentRoute?.()?.name !== 'VideoCall';
        const external =
          readActiveExternalCallAudioRoute() || readNativeProbedExternalRoute();
        if (onHomeWithPlaque) {
          restoreCallAudioForInAppPiPPlaque('app_state_foreground_in_app_pip');
        } else if (stabilizeEarpiece) {
          // Маршрут уже зафиксирован на earpiece в окне после accept — без цепочки reapply.
        } else if (external) {
          setPersistedCallAudioRoute(external);
          scheduleReapplyPersistedCallAudioRoute('app_state_foreground_headset', {
            media: resolveActiveCallInCallMedia(),
            delaysMs: [0, 450],
            skipInCallRestart: true,
          });
        } else {
          scheduleReapplyPersistedCallAudioRoute('app_state_foreground', {
            media: isDirectAudioEarpieceStabilizeWindow() ? 'audio' : resolveActiveCallInCallMedia(),
            delaysMs: FOREGROUND_REAPPLY_DELAYS_MS,
          });
        }
      } catch {
        if (!isDirectAudioEarpieceStabilizeWindow()) {
          scheduleReapplyPersistedCallAudioRoute('app_state_foreground', {
            media: resolveActiveCallInCallMedia(),
            delaysMs: FOREGROUND_REAPPLY_DELAYS_MS,
          });
        }
      }
      restoreSessionMicrophoneIfNeeded();
    }
    try {
      const g = global as any;
      const returningFromPiP = Date.now() < Number(g.__returningFromSystemPiPUntilRef?.current || 0);
      const session = g.__webrtcSessionRef?.current;
      if (returningFromPiP && session && typeof session.restoreLocalCameraAfterPiPReturn === 'function') {
        void session.restoreLocalCameraAfterPiPReturn();
        return;
      }
      if (
        session &&
        typeof session.restoreCameraAfterAppBackground === 'function' &&
        !returningFromPiP
      ) {
        void session.restoreCameraAfterAppBackground();
      }
    } catch {}
  }
}

export function installActiveCallBackgroundAudioHandlers(): void {
  if (installed) return;
  installed = true;
  lastAppState = AppState.currentState;
  AppState.addEventListener('change', onAppStateChange);
}
