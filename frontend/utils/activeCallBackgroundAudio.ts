import { AppState, Platform, type AppStateStatus, NativeModules } from 'react-native';
import { captureCallAudioRouteFromUi, isOngoingCallSession, peekSystemPiPReturnMediaSnapshot, resolveActiveCallInCallMedia, readActiveExternalCallAudioRoute, isDirectAudioEarpieceStabilizeWindow, isIncomingAnswerTransitionActive } from './activeCallSession';
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
import { peekSystemPiPLeaveContextForReturn, isSystemPiPSessionAudioOrigin } from '../src/pip/pipPlaceholderOnly';
import { armAndroidLeaveHintForVideoCallHome, syncAndroidLeaveHintForOngoingCall } from './activeCallNotification';
import { readNativeProbedExternalRoute } from './nativeCallAudioProbe';
import { readRootCurrentRouteName } from './safeRootNavigation';
import { isExternalCallHoldActive } from './externalCallHold';

const BACKGROUND_REAPPLY_DELAYS_MS = [0, 450];
const FOREGROUND_REAPPLY_DELAYS_MS = [0];
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
  if (isExternalCallHoldActive()) return;
  try {
    const session = (global as any).__webrtcSessionRef?.current;
    if (session && typeof session.restoreMicrophoneAfterAppBackground === 'function') {
      void session.restoreMicrophoneAfterAppBackground();
    }
  } catch {}
}

function nativeMaintainCallVoiceAudio(force = false): void {
  if (Platform.OS !== 'android') return;
  if (isExternalCallHoldActive()) return;
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
  if (isExternalCallHoldActive()) return;
  const media = resolveActiveCallInCallMedia();
  if (media === 'audio' && shouldApplyHomeLoudSpeakerPin()) {
    pinLoudSpeakerForAudioCallLeavingToBackground();
  } else if (media === 'audio') {
    armCallAudioPreservePriority();
  }
  captureCallAudioRouteFromUi();
  nativeMaintainCallVoiceAudio(reason === 'app_state_background');
  if (reason === 'app_state_background' && isCallAudioPiPTransitionWindow()) {
    return;
  }
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

  // Android Home: inactive часто раньше leave-hint — сразу peer-only compact.
  if (
    Platform.OS === 'android' &&
    (next === 'inactive' || next === 'background') &&
    prev === 'active'
  ) {
    armAndroidLeaveHintForVideoCallHome({ allowFromInAppPiP: true });
    try {
      syncAndroidLeaveHintForOngoingCall();
    } catch (_) {}
  }

  if (next === 'background') {
    // Home/Back: arm ASAP — onUserLeaveHint часто раньше JS, auto-enter + FGS подстраховывают.
    armAndroidLeaveHintForVideoCallHome({ allowFromInAppPiP: true });
    try {
      syncAndroidLeaveHintForOngoingCall();
    } catch (_) {}
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
    // Вернулись на передний план, так и не войдя в system PiP — снять "уходим по Home".
    // Иначе флаги остаются sticky на весь звонок: у инициатора bringMainActivityToFront
    // после accept даёт короткий background→active блип (~13мс), он взводит их, PiP не
    // происходит, и VideoCall потом считает, что мы уходим в PiP (compact без кнопок).
    try {
      const g = global as any;
      const inSystemPiP = g.__pipInSystemModeRef?.current === true;
      const pendingEnter = g.__pendingSystemPiPSyncRef?.current === true;
      const entryUntil = Number(g.__systemPiPEntryInProgressUntilRef?.current || 0);
      if (!inSystemPiP && entryUntil <= Date.now()) {
        if (g.__leavingVideoCallByHomeRef) g.__leavingVideoCallByHomeRef.current = false;
        if (pendingEnter && g.__pendingSystemPiPSyncRef) {
          g.__pendingSystemPiPSyncRef.current = false;
        }
      }
    } catch (_) {}
    syncAndroidLeaveHintForOngoingCall();
    try {
      const g = global as any;
      const returningFromPiP = Date.now() < Number(g.__returningFromSystemPiPUntilRef?.current || 0);
      const hasPendingSnap = !!peekSystemPiPReturnMediaSnapshot();
      const plaqueVisible = g.__pipVisibleRef?.current === true;
      if (returningFromPiP || hasPendingSnap) {
        const leaveCtx = peekSystemPiPLeaveContextForReturn();
        const restoreInApp = leaveCtx.restoreInAppPiP === true;
        const preferAudioOnly =
          !restoreInApp &&
          (leaveCtx.preferAudioOnly ||
            leaveCtx.audioOrigin ||
            leaveCtx.leaveUi === 'audio' ||
            isSystemPiPSessionAudioOrigin() ||
            g.__preferAudioOnlyUiOnNextVideoCallRef?.current === true);
        restoreCallMediaAfterSystemPiPReturn({ preferAudioOnly });
      } else if (!plaqueVisible && !isCallAudioPiPTransitionWindow()) {
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
        const plaqueVisible = g.__pipVisibleRef?.current === true;
        const onHomeWithPlaque =
          plaqueVisible &&
          readRootCurrentRouteName() !== 'VideoCall';
        const returningFromPiP =
          Date.now() < Number(g.__returningFromSystemPiPUntilRef?.current || 0);
        const external =
          readActiveExternalCallAudioRoute() || readNativeProbedExternalRoute();
        // Страховка: ModeChanged/Expanded могли промахнуться — вернуть in-app плашку.
        // Но только если мы НЕ на полноэкранном экране звонка: после разворота из системного
        // PiP пользователь уже на VideoCall, и sticky-флаг здесь сворачивал его обратно в
        // плашку через пару секунд (restore_in_app_pip_from_system поверх успешного возврата).
        const needsInAppRestore =
          !plaqueVisible &&
          readRootCurrentRouteName() !== 'VideoCall' &&
          !isIncomingAnswerTransitionActive() &&
          (g.__systemPiPNeedsInAppRestoreRef?.current === true ||
            g.__pendingInAppPiPRestoreAfterSystemRef?.current === true ||
            peekSystemPiPLeaveContextForReturn().restoreInAppPiP === true);
        const endingCall =
          g.__endingCallInProgressRef?.current === true ||
          g.__callEndedFromPiPNoOpenRef?.current === true ||
          g.__endingFromPiPButtonRef?.current === true;
        if (needsInAppRestore && !endingCall) {
          try {
            g.__pendingInAppPiPRestoreAfterSystemRef =
              g.__pendingInAppPiPRestoreAfterSystemRef || { current: false };
            g.__pendingInAppPiPRestoreAfterSystemRef.current = true;
            const fn = g.__pipReturnToCallRef?.current;
            if (typeof fn === 'function') {
              g.__restoringInAppPiPFromSystemRef =
                g.__restoringInAppPiPFromSystemRef || { current: false };
              g.__restoringInAppPiPFromSystemRef.current = true;
              setTimeout(() => {
                try {
                  if (g.__pipVisibleRef?.current === true) {
                    g.__pendingInAppPiPRestoreAfterSystemRef.current = false;
                    return;
                  }
                  if (
                    g.__endingCallInProgressRef?.current === true ||
                    g.__callEndedFromPiPNoOpenRef?.current === true
                  ) {
                    return;
                  }
                  fn({ restoreInAppPiP: true });
                } catch {}
              }, 60);
            }
          } catch {}
        }
        if (onHomeWithPlaque) {
          restoreCallAudioForInAppPiPPlaque('app_state_foreground_in_app_pip');
        } else if (returningFromPiP || isCallAudioPiPTransitionWindow() || plaqueVisible) {
          restoreCallAudioForInAppPiPPlaque('app_state_foreground_pip_transition');
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
      if (
        session &&
        typeof session.restoreCameraAfterAppBackground === 'function' &&
        !returningFromPiP
      ) {
        void session.restoreCameraAfterAppBackground();
      }
      // System PiP return is owned by the focused VideoCall. AppState can fire
      // before navigation settles and must not open Camera2 in parallel.
    } catch {}
  }
}

export function installActiveCallBackgroundAudioHandlers(): void {
  if (installed) return;
  installed = true;
  lastAppState = AppState.currentState;
  AppState.addEventListener('change', onAppStateChange);
}
