/** Активен экран «аудиозвонок» (ещё не перешли на video UI). */
import { Platform } from 'react-native';
import {
  armCallAudioRouteUiLock,
  armCallAudioNativeTransitionLock,
  armCallAudioPreservePriority,
} from '../../utils/callAudioRoutePersist';
import { finishDirectCallVideoExpandInFlight } from '../../utils/directCallVideoExpandGuard';

export {
  touchDirectCallVideoExpandGuard,
  isDirectCallVideoExpandGuardActive,
  tryBeginDirectCallVideoExpand,
  finishDirectCallVideoExpandInFlight,
  runDirectCallVideoExpandOnce,
  prepareDirectCallVideoReturnFromPiP,
  markDirectCallUserRequestedVideoExpand,
  clearDirectCallUserRequestedVideoExpand,
  isDirectCallUserRequestedVideoExpand,
  clearStaleDirectCallVideoExpandFlags,
  shouldBlockAutomatedDirectCallVideoExpand,
} from '../../utils/directCallVideoExpandGuard';
import {
  isExternalHeadsetRoute,
  normalizeInCallRoute,
  type InCallAudioRoute,
} from '../../components/VideoChat/hooks/audioRouteTypes';
import {
  clearBuiltinPinForExternalHeadsetConnect,
  markUserSelectedExternalCallAudioRoute,
} from '../../utils/activeCallSession';
import { readConnectedExternalCallAudioRoute } from '../../utils/callConnectedExternalAudioRoute';
import { isInAudioOnlyCallUi, setPipAudioOnlyPlaceholderSticky } from '../../utils/callAudioOnlyUiContext';
import { readRootCurrentRouteName } from '../../utils/safeRootNavigation';
import { readNativeProbedExternalRoute } from '../../utils/nativeCallAudioProbe';

export {
  isInAudioOnlyCallUi,
  setPipAudioOnlyPlaceholderSticky,
} from '../../utils/callAudioOnlyUiContext';

/**
 * In-app PiP → «Аудиозвонок» с Home: до navigate выставить audio UI и запустить WebRTC,
 * чтобы первый кадр VideoCall уже был audio, а не видео + remount.
 */
export function prepareDirectCallAudioReturnFromPiP(): void {
  try {
    const g = global as any;
    finishDirectCallVideoExpandInFlight();
    g.__directCallVideoExpandUntilRef = g.__directCallVideoExpandUntilRef || { current: 0 };
    g.__directCallVideoExpandUntilRef.current = 0;
    g.__preferAudioOnlyUiOnNextVideoCallRef = g.__preferAudioOnlyUiOnNextVideoCallRef || { current: false };
    g.__preferAudioOnlyUiOnNextVideoCallRef.current = true;
    g.__expandToVideoCallUiFromPiPRef = g.__expandToVideoCallUiFromPiPRef || { current: false };
    g.__expandToVideoCallUiFromPiPRef.current = false;
    g.__inAudioOnlyUiRef = g.__inAudioOnlyUiRef || { current: false };
    g.__inAudioOnlyUiRef.current = true;
    setPipAudioOnlyPlaceholderSticky(true);
    try {
      g.__stayOnVideoCallUiRef = g.__stayOnVideoCallUiRef || { current: false };
      g.__stayOnVideoCallUiRef.current = false;
    } catch {}
    const session = g.__webrtcSessionRef?.current;
    const callId =
      session && typeof session.getCallId === 'function' ? session.getCallId() : null;
    g.__directCallAudioOnlyMountKeyRef = g.__directCallAudioOnlyMountKeyRef || { current: null };
    if (callId) g.__directCallAudioOnlyMountKeyRef.current = String(callId);
    g.__directCallAudioOnlyPreparedAtRef = g.__directCallAudioOnlyPreparedAtRef || { current: 0 };
    g.__directCallAudioOnlyPreparedAtRef.current = Date.now();
    if (session && typeof session.enterDirectCallAudioOnlyMode === 'function' && !session.isEnded?.()) {
      void session.enterDirectCallAudioOnlyMode();
    }
    const paramsRef = g.__currentCallPiPParamsRef?.current;
    const rawRoute =
      (paramsRef && typeof paramsRef === 'object' ? paramsRef.audioOutputRoute : null) ||
      g.__persistedCallAudioRouteRef?.current ||
      g.__userSelectedCallAudioRouteRef?.current;
    const rawNorm = normalizeInCallRoute(String(rawRoute || ''));
    let audioRoute: InCallAudioRoute = 'EARPIECE';
    if (rawNorm === 'SPEAKER_PHONE' || rawNorm === 'EARPIECE') {
      audioRoute = rawNorm;
    } else if (isExternalHeadsetRoute(rawNorm)) {
      audioRoute = rawNorm;
    } else {
      const ext =
        readNativeProbedExternalRoute() ||
        readConnectedExternalCallAudioRoute(rawNorm || undefined);
      if (ext && isExternalHeadsetRoute(ext)) {
        audioRoute = ext;
      }
    }
    if (paramsRef && typeof paramsRef === 'object') {
      paramsRef.inAudioOnlyUi = true;
      paramsRef.preferVideoCallUi = false;
      paramsRef.localCamOn = false;
      paramsRef.audioOutputRoute = audioRoute;
    }
    g.__persistedCallAudioRouteRef = g.__persistedCallAudioRouteRef || { current: null };
    g.__persistedCallAudioRouteRef.current = audioRoute;
    g.__userSelectedCallAudioRouteRef = g.__userSelectedCallAudioRouteRef || { current: null };
    g.__userSelectedCallAudioRouteRef.current = audioRoute;
    g.__lastAppliedCallAudioRouteRef = g.__lastAppliedCallAudioRouteRef || { current: null };
    g.__lastAppliedCallAudioRouteRef.current = audioRoute;
    if (isExternalHeadsetRoute(audioRoute)) {
      clearBuiltinPinForExternalHeadsetConnect();
      markUserSelectedExternalCallAudioRoute(audioRoute, 20_000);
    }
    if (Platform.OS === 'android') {
      armCallAudioNativeTransitionLock(900);
    }
    armCallAudioPreservePriority(5000);
    if (audioRoute === 'SPEAKER_PHONE' || audioRoute === 'EARPIECE') {
      armCallAudioRouteUiLock(audioRoute);
    }
    if (g.__audioCallHomeSpeakerPinRef) {
      g.__audioCallHomeSpeakerPinRef.current = false;
    }
  } catch {}
}

export function mediaStreamHasLiveVideo(stream: unknown): boolean {
  try {
    const t = (stream as any)?.getVideoTracks?.()?.[0];
    return !!t && t.readyState === 'live' && t.enabled !== false;
  } catch {
    return false;
  }
}

export function getPipPlaceholderOnlyDebug(opts?: {
  localCamOn?: boolean;
  remoteCamOn?: boolean;
  remoteStream?: unknown;
  localStream?: unknown;
}): { placeholderOnly: boolean; reason: string; flags: Record<string, boolean> } {
  const g = global as any;
  const flags = {
    inAudioOnlyUiRef: g.__inAudioOnlyUiRef?.current === true,
    pipAudioOnlySticky: g.__pipAudioOnlyPlaceholderRef?.current === true,
    liveRemoteVideo: mediaStreamHasLiveVideo(opts?.remoteStream),
    liveLocalVideo: mediaStreamHasLiveVideo(opts?.localStream),
    localCamOn: opts?.localCamOn === true,
    remoteCamOn: opts?.remoteCamOn === true,
  };
  if (g.__stayOnVideoCallUiRef?.current === true) {
    return { placeholderOnly: false, reason: 'stay_on_video_ui', flags };
  }
  const paramsPref = g.__currentCallPiPParamsRef?.current;
  if (paramsPref?.preferVideoCallUi === true) {
    return { placeholderOnly: false, reason: 'params_prefer_video_ui', flags };
  }
  if (flags.inAudioOnlyUiRef) {
    return { placeholderOnly: true, reason: 'inAudioOnlyUiRef', flags };
  }
  if (flags.pipAudioOnlySticky) {
    const sessionSticky = g.__webrtcSessionRef?.current;
    const callLiveSticky =
      sessionSticky && typeof sessionSticky.isEnded === 'function'
        ? !sessionSticky.isEnded()
        : !!sessionSticky;
    if (callLiveSticky) {
      return { placeholderOnly: true, reason: 'pipAudioOnlySticky', flags };
    }
  }
  if (opts?.localCamOn === true || opts?.remoteCamOn === true) {
    return { placeholderOnly: false, reason: 'cam_on', flags };
  }
  if (flags.liveRemoteVideo) {
    return { placeholderOnly: false, reason: 'live_remote_video', flags };
  }
  if (flags.liveLocalVideo) {
    return { placeholderOnly: false, reason: 'live_local_video', flags };
  }
  try {
    const session = g.__webrtcSessionRef?.current;
    if (session?.getIsCamOn?.()) {
      return { placeholderOnly: false, reason: 'session_local_cam', flags };
    }
    if (session?.getRemoteCamEnabled?.()) {
      return { placeholderOnly: false, reason: 'session_remote_cam', flags };
    }
  } catch (_) {}
  try {
    const session = g.__webrtcSessionRef?.current;
    if (session && typeof session.shouldUsePlaceholderPiP === 'function') {
      const sessionPlaceholder = session.shouldUsePlaceholderPiP();
      return {
        placeholderOnly: !!sessionPlaceholder,
        reason: sessionPlaceholder ? 'session_shouldUsePlaceholderPiP' : 'session_no_placeholder',
        flags,
      };
    }
  } catch {}
  return { placeholderOnly: false, reason: 'default_false', flags };
}

/** С какого UI ушли в in-app PiP: аудио → иконка возврата «аудио», видео → «видео». */
export function pipInAppBarEnteredFromAudioOnly(): boolean {
  try {
    const g = global as any;
    const sticky = g.__pipInAppRtcFromAudioOnlyRef?.current;
    if (sticky === true) return true;
    if (sticky === false) return false;
    return isInAudioOnlyCallUi();
  } catch {
    return false;
  }
}

/** In-app PiP-плашка: без RTCView, только аватар (и для видео-, и для аудио-звонка). */
export function shouldAllowRtcVideoInInAppPiPBar(_opts?: { fromAudioOnlyUi?: boolean }): boolean {
  return false;
}

export function setPipInAppRtcFromAudioOnlySticky(fromAudioOnlyUi: boolean): void {
  try {
    const g = global as any;
    g.__pipInAppRtcFromAudioOnlyRef = g.__pipInAppRtcFromAudioOnlyRef || { current: false };
    g.__pipInAppRtcFromAudioOnlyRef.current = !!fromAudioOnlyUi;
  } catch {}
}

/** Разрешить allowVideoRender / RTC в in-app PiP (с учётом audio-only и placeholder). */
export function shouldAllowRtcVideoRenderInInAppPiP(opts?: {
  fromAudioOnlyUi?: boolean;
  localCamOn?: boolean;
  remoteCamOn?: boolean;
  remoteStream?: unknown;
  localStream?: unknown;
}): boolean {
  if (!shouldAllowRtcVideoInInAppPiPBar({ fromAudioOnlyUi: opts?.fromAudioOnlyUi })) {
    return false;
  }
  if (shouldUsePipPlaceholderOnly(opts)) {
    return false;
  }
  return !!(opts?.remoteStream && mediaStreamHasLiveVideo(opts.remoteStream));
}

/** System / in-app PiP: не монтировать RTCView, показывать заглушку LiVi. */
export function shouldUsePipPlaceholderOnly(opts?: {
  localCamOn?: boolean;
  remoteCamOn?: boolean;
  remoteStream?: unknown;
  localStream?: unknown;
}): boolean {
  return getPipPlaceholderOnlyDebug(opts).placeholderOnly;
}

/**
 * Куда развернуть звонок по тапу ongoing-уведомления / return from Home.
 * Video UI (params + stayOnVideo) важнее устаревшего audio-sticky; нативный audioOnly — подсказка при равных.
 */
export function resolvePreferAudioOnlyUiOnActiveCallReturn(opts?: {
  preferAudioOnlyFromNative?: boolean;
}): boolean {
  try {
    const g = global as any;
    const params = g.__currentCallPiPParamsRef?.current;
    if (g.__stayOnVideoCallUiRef?.current === true) return false;
    if (params?.preferVideoCallUi === true) return false;
    if (params?.inAudioOnlyUi === true) return true;
    const native = opts?.preferAudioOnlyFromNative;
    if (native === false) return false;
    if (native === true) return true;
    if (isInAudioOnlyCallUi()) return true;
    return resolvePreferAudioOnlyUiOnPiPReturn();
  } catch {
    return opts?.preferAudioOnlyFromNative === true;
  }
}

/**
 * Куда развернуть звонок из PiP по центральному тапу: audio UI, если пользователь ушёл с аудио-экрана.
 * Логика согласована с invokeReturnToVideoCallFromNotification в App.tsx.
 */
export function resolvePreferAudioOnlyUiOnPiPReturn(opts?: {
  localCamOn?: boolean;
  remoteCamOn?: boolean;
  remoteStream?: unknown;
  localStream?: unknown;
}): boolean {
  try {
    if (isInAudioOnlyCallUi()) {
      return true;
    }
    const g = global as any;
    if (g.__stayOnVideoCallUiRef?.current === true) {
      return false;
    }
    const params = g.__currentCallPiPParamsRef?.current;
    if (params?.preferVideoCallUi === true) {
      return false;
    }
    if (params?.inAudioOnlyUi === true) {
      return true;
    }
    const session = g.__webrtcSessionRef?.current;
    const remoteStream =
      opts?.remoteStream ??
      params?.remoteStream ??
      (typeof session?.getRemoteStream === 'function' ? session.getRemoteStream() : null);
    const localStream =
      opts?.localStream ??
      params?.localStream ??
      (typeof session?.getLocalStream === 'function' ? session.getLocalStream() : null);
    return shouldUsePipPlaceholderOnly({
      localCamOn: opts?.localCamOn ?? params?.localCamOn,
      remoteCamOn: opts?.remoteCamOn ?? params?.remoteCamOn,
      remoteStream,
      localStream,
    });
  } catch {
    return false;
  }
}

export type SystemPiPLeaveContext = {
  preferAudioOnly: boolean;
  restoreInAppPiP: boolean;
  routeName: string | null;
  capturedAt: number;
};

/** Держим актуальный снимок UI до Home → system PiP (onUserLeaveHint раньше AppState background). */
export function refreshSystemPiPLeaveContextSnapshot(): void {
  try {
    const g = global as any;
    const params = g.__currentCallPiPParamsRef?.current;
    const preferAudioOnly = resolvePreferAudioOnlyUiOnPiPReturn({
      localCamOn: params?.localCamOn,
      remoteCamOn: params?.remoteCamOn,
      remoteStream: params?.remoteStream,
      localStream: params?.localStream,
    });
    const inAppPiP = g.__pipVisibleRef?.current === true;
    g.__systemPiPLeaveContextSnapshotRef = {
      preferAudioOnly,
      // Любой in-app PiP (в т.ч. с аудио-экрана) — при развороте system PiP возвращаем на Home + overlay, не на полный VideoCall.
      restoreInAppPiP: inAppPiP,
      routeName: readRootCurrentRouteName() || null,
      capturedAt: Date.now(),
    };
  } catch {}
}

export function peekSystemPiPLeaveContextForReturn(): SystemPiPLeaveContext {
  try {
    const snap = (global as any).__systemPiPLeaveContextSnapshotRef as SystemPiPLeaveContext | undefined;
    if (snap && Date.now() - snap.capturedAt < 120_000) {
      return snap;
    }
  } catch {}
  return {
    preferAudioOnly: resolvePreferAudioOnlyUiOnPiPReturn(),
    restoreInAppPiP: false,
    routeName: null,
    capturedAt: Date.now(),
  };
}
