/** Активен экран «аудиозвонок» (ещё не перешли на video UI). */
import { Platform } from 'react-native';
import {
  armCallAudioRouteUiLock,
  armCallAudioNativeTransitionLock,
  armCallAudioPreservePriority,
} from '../../utils/callAudioRoutePersist';
import { finishDirectCallVideoExpandInFlight, isDirectCallVideoUiActive, clearDirectCallUserRequestedVideoExpand } from '../../utils/directCallVideoExpandGuard';

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
  clearStaleDirectCallVideoExpandGlobalHints,
  isStaleDirectCallVideoExpandGlobalHint,
  shouldBlockAutomatedDirectCallVideoExpand,
  isDirectCallVideoUiActive,
  shouldSuppressDirectCallAudioOnlyUiTransition,
  markFreshDirectCallAudioAcceptCall,
  isFreshDirectCallAudioAcceptCallActive,
  clearFreshDirectCallAudioAcceptCall,
  shouldBlockFreshDirectCallAudioAutomatedVideoExpand,
  markDirectCallAudioAcceptBootstrapped,
  isDirectCallAudioAcceptBootstrapped,
  clearDirectCallAudioAcceptBootstrapped,
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
    // Явный audio-return: сбросить sticky video-expand, иначе layout/focus
    // видят authenticIntent при preferVideoCallUi:false и шумят remount/cam.
    clearDirectCallUserRequestedVideoExpand();
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
      void session.enterDirectCallAudioOnlyMode({ forceUserReturn: true });
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
  // Peer/local video already on — don't force logo just because local UI is still audio-only.
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

/** In-app PiP: RTC в превью-слоте при выходе с video UI; с audio — аватар, пока peer не включил live video. */
export function shouldAllowRtcVideoInInAppPiPBar(opts?: {
  fromAudioOnlyUi?: boolean;
  remoteCamOn?: boolean;
  remoteStream?: unknown;
}): boolean {
  // Mid-PiP: peer включил камеру — показать RTC даже если ушли с audio UI.
  if (opts?.remoteCamOn === true && mediaStreamHasLiveVideo(opts?.remoteStream)) {
    return true;
  }
  if (opts?.fromAudioOnlyUi === true) return false;
  try {
    if (pipInAppBarEnteredFromAudioOnly()) {
      try {
        const session = (global as any).__webrtcSessionRef?.current;
        if (
          session?.getRemoteCamEnabled?.() === true &&
          mediaStreamHasLiveVideo(opts?.remoteStream ?? session?.getRemoteStream?.())
        ) {
          return true;
        }
      } catch {}
      return false;
    }
  } catch {}
  return true;
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
 * Куда развернуть звонок по тапу ongoing-уведомления.
 * Только живой call UI — без native audioOnly и без PiP-placeholder
 * (FGS обязан быть, но return должен быть «тупым» и надёжным).
 */
export function resolvePreferAudioOnlyUiOnActiveCallReturn(_opts?: {
  preferAudioOnlyFromNative?: boolean;
}): boolean {
  try {
    const g = global as any;
    const params = g.__currentCallPiPParamsRef?.current;
    if (g.__stayOnVideoCallUiRef?.current === true) return false;
    if (params?.preferVideoCallUi === true) return false;
    if (isDirectCallVideoUiActive()) return false;
    if (params?.inAudioOnlyUi === true) return true;
    if (isInAudioOnlyCallUi()) return true;
    return false;
  } catch {
    return false;
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
    if (isDirectCallVideoUiActive()) {
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
  /** Уход с аудио UI / audio-origin in-app — system PiP только лого, даже если peer потом включит камеру. */
  audioOrigin: boolean;
  /** Sticky UI at leave — never flipped by mid-PiP peer video. */
  leaveUi: 'audio' | 'video';
  restoreInAppPiP: boolean;
  routeName: string | null;
  capturedAt: number;
};

/**
 * Failed/cancelled system PiP enter или return из уведомления:
 * иначе VideoCall остаётся в systemPiPCompact (peer video без CallScreenChrome).
 */
export function clearStickySystemPiPCompactFlags(_reason?: string): void {
  try {
    const g = global as any;
    g.__pendingSystemPiPSyncRef = g.__pendingSystemPiPSyncRef || { current: false };
    g.__pendingSystemPiPSyncRef.current = false;
    g.__leavingVideoCallByHomeRef = g.__leavingVideoCallByHomeRef || { current: false };
    g.__leavingVideoCallByHomeRef.current = false;
    g.__systemPiPEntryInProgressUntilRef = g.__systemPiPEntryInProgressUntilRef || { current: 0 };
    g.__systemPiPEntryInProgressUntilRef.current = 0;
    g.__pipInSystemModeRef = g.__pipInSystemModeRef || { current: false };
    g.__pipInSystemModeRef.current = false;
    const upd = g.__pipUpdateStateRef?.current;
    if (typeof upd === 'function') {
      upd({
        pendingSystemPiP: false,
        systemPiPCaptureActive: false,
        systemPiPCaptureRequestId: 0,
        inSystemPiPMode: false,
      });
    }
  } catch (_) {}
}

/**
 * Accept с нативного Incoming: сбросить sticky «вернуть in-app PiP» и подавить
 * ложный Back/leaveHint от task-switch Incoming→Main (иначе Home+плашка вместо VideoCall).
 */
export function clearStaleInAppPiPRestoreForIncomingAnswer(ttlMs = 10_000): void {
  try {
    const g = global as any;
    const now = Date.now();
    g.__suppressInAppPiPUntilRef = g.__suppressInAppPiPUntilRef || { current: 0 };
    g.__suppressInAppPiPUntilRef.current = Math.max(
      Number(g.__suppressInAppPiPUntilRef.current || 0),
      now + ttlMs,
    );
    g.__disableSystemPiPUntilRef = g.__disableSystemPiPUntilRef || { current: 0 };
    g.__disableSystemPiPUntilRef.current = Math.max(
      Number(g.__disableSystemPiPUntilRef.current || 0),
      now + ttlMs,
    );
    g.__systemPiPNeedsInAppRestoreRef = g.__systemPiPNeedsInAppRestoreRef || { current: false };
    g.__systemPiPNeedsInAppRestoreRef.current = false;
    g.__pendingInAppPiPRestoreAfterSystemRef =
      g.__pendingInAppPiPRestoreAfterSystemRef || { current: false };
    g.__pendingInAppPiPRestoreAfterSystemRef.current = false;
    g.__restoringInAppPiPFromSystemRef = g.__restoringInAppPiPFromSystemRef || { current: false };
    g.__restoringInAppPiPFromSystemRef.current = false;
    g.__pipSuspendedForSystemPiPRef = g.__pipSuspendedForSystemPiPRef || { current: false };
    g.__pipSuspendedForSystemPiPRef.current = false;
    g.__leavingVideoCallByBackRef = g.__leavingVideoCallByBackRef || { current: false };
    g.__leavingVideoCallByBackRef.current = false;
    g.__leavingVideoCallByHomeRef = g.__leavingVideoCallByHomeRef || { current: false };
    g.__leavingVideoCallByHomeRef.current = false;
    g.__systemPiPEntryInProgressUntilRef = g.__systemPiPEntryInProgressUntilRef || { current: 0 };
    g.__systemPiPEntryInProgressUntilRef.current = 0;
    const snap = g.__systemPiPLeaveContextSnapshotRef as SystemPiPLeaveContext | undefined;
    if (snap && snap.restoreInAppPiP === true) {
      g.__systemPiPLeaveContextSnapshotRef = {
        ...snap,
        restoreInAppPiP: false,
        capturedAt: now,
      };
    }
  } catch {}
}

/** Sticky на всю сессию system PiP (ставится в AboutToEnter). */
export function markSystemPiPSessionAudioOrigin(fromAudio: boolean): void {
  try {
    const g = global as any;
    g.__systemPiPSessionAudioOriginRef = g.__systemPiPSessionAudioOriginRef || { current: false };
    g.__systemPiPSessionAudioOriginRef.current = !!fromAudio;
    g.__systemPiPSessionAudioOriginDecidedRef =
      g.__systemPiPSessionAudioOriginDecidedRef || { current: false };
    g.__systemPiPSessionAudioOriginDecidedRef.current = true;
  } catch {}
}

export function clearSystemPiPSessionAudioOrigin(): void {
  try {
    const g = global as any;
    if (g.__systemPiPSessionAudioOriginRef) g.__systemPiPSessionAudioOriginRef.current = false;
    if (g.__systemPiPSessionAudioOriginDecidedRef) {
      g.__systemPiPSessionAudioOriginDecidedRef.current = false;
    }
  } catch {}
}

export function isSystemPiPSessionAudioOrigin(): boolean {
  try {
    return (global as any).__systemPiPSessionAudioOriginRef?.current === true;
  } catch {
    return false;
  }
}

/**
 * Откуда уходим в system PiP: аудио-экран / audio in-app — не video UI.
 * После AboutToEnter sticky decided — источник правды на всю PiP-сессию
 * (video capture с audio UI не должен вечно считаться audio-origin).
 */
export function isSystemPiPLeaveAudioOrigin(): boolean {
  try {
    if ((global as any).__systemPiPSessionAudioOriginDecidedRef?.current === true) {
      return isSystemPiPSessionAudioOrigin();
    }
  } catch {}
  try {
    const g = global as any;
    if (g.__stayOnVideoCallUiRef?.current === true) return false;
    const params = g.__currentCallPiPParamsRef?.current;
    if (params?.preferVideoCallUi === true) return false;
    if (isDirectCallVideoUiActive()) return false;
    if (g.__pipVisibleRef?.current === true || g.__pipSuspendedForSystemPiPRef?.current === true) {
      return pipInAppBarEnteredFromAudioOnly();
    }
    if (params?.inAudioOnlyUi === true) return true;
    return isInAudioOnlyCallUi();
  } catch {
    return false;
  }
}

/**
 * System PiP: лого (native backdrop) vs peer RTC.
 * Product:
 * - enter с audio UI → лого (пока peer без video)
 * - уже в system PiP + peer cam/live → peer RTC (апгрейд, даже с audio UI)
 * - peer cam OFF / нет live → лого
 */
export function shouldUseSystemPiPPlaceholderOnly(opts?: {
  localCamOn?: boolean;
  remoteCamOn?: boolean;
  remoteStream?: unknown;
  localStream?: unknown;
}): boolean {
  try {
    const g = global as any;
    const params = g.__currentCallPiPParamsRef?.current;
    const session = g.__webrtcSessionRef?.current;
    const sessionRemoteStream =
      typeof session?.getRemoteStream === 'function' ? session.getRemoteStream() : null;
    const optsOrParamsStream = opts?.remoteStream ?? params?.remoteStream ?? null;
    const remoteStream =
      (mediaStreamHasLiveVideo(sessionRemoteStream) ? sessionRemoteStream : null) ??
      (mediaStreamHasLiveVideo(optsOrParamsStream) ? optsOrParamsStream : null) ??
      sessionRemoteStream ??
      optsOrParamsStream;
    const hasLiveRemote = mediaStreamHasLiveVideo(remoteStream);
    const sessionCam =
      typeof session?.getRemoteCamEnabled === 'function'
        ? session.getRemoteCamEnabled()
        : undefined;
    const remoteCamOn =
      typeof sessionCam === 'boolean'
        ? sessionCam
        : typeof opts?.remoteCamOn === 'boolean'
          ? opts.remoteCamOn
          : typeof params?.remoteCamOn === 'boolean'
            ? params.remoteCamOn
            : undefined;
    const peerVideo =
      hasLiveRemote || remoteCamOn === true || opts?.remoteCamOn === true;

    // Peer video уже есть → RTC в system PiP (и на enter с audio UI, и mid-PiP upgrade).
    // Раньше audio UI форсил logo раньше проверки live remote — собеседник не видел видео.
    if (peerVideo) return false;

    // Enter с audio-страницы без peer video → logo.
    if (isInAudioOnlyCallUi()) return true;

    if (isSystemPiPLeaveAudioOrigin()) return true;
    return true;
  } catch {
    return true;
  }
}

/**
 * Снимок leave-context для return из system PiP.
 * Product: leave с audio → return на audio, даже если в PiP уже показали peer video.
 *
 * Не наследуем sticky restoreInAppPiP / needsRestore с прошлого ухода:
 * иначе audio VideoCall → Home → system PiP → expand сначала показывает audio,
 * потом ошибочно уводит в in-app плашку.
 */
export function commitSystemPiPLeaveContextSnapshot(opts?: {
  placeholderOnly?: boolean;
  restoreInAppPiP?: boolean;
  routeName?: string | null;
}): void {
  try {
    const g = global as any;
    const params = g.__currentCallPiPParamsRef?.current;
    const existing = g.__systemPiPLeaveContextSnapshotRef as SystemPiPLeaveContext | undefined;
    const placeholderOnly =
      typeof opts?.placeholderOnly === 'boolean'
        ? opts.placeholderOnly
        : shouldUseSystemPiPPlaceholderOnly({
            localCamOn: params?.localCamOn,
            remoteCamOn: params?.remoteCamOn,
            remoteStream: params?.remoteStream,
            localStream: params?.localStream,
          });
    const uiPreferAudio = resolvePreferAudioOnlyUiOnPiPReturn({
      localCamOn: params?.localCamOn,
      remoteCamOn: params?.remoteCamOn,
      remoteStream: params?.remoteStream,
      localStream: params?.localStream,
    });
    // Только живая плашка / soft-hide — не stale needsRestore и не existing.restoreInAppPiP.
    const liveInAppPiP =
      g.__pipVisibleRef?.current === true ||
      g.__pipSuspendedForSystemPiPRef?.current === true;
    const inAppPiP =
      typeof opts?.restoreInAppPiP === 'boolean' ? opts.restoreInAppPiP : liveInAppPiP;
    const leaveUiFromLive: 'audio' | 'video' =
      isInAudioOnlyCallUi() || isSystemPiPLeaveAudioOrigin() || uiPreferAudio
        ? 'audio'
        : 'video';
    // Sticky leaveUi только mid-session (уже в system PiP / peer cam upgrade).
    // Новый AboutToEnter всегда берёт текущий UI — иначе audio leave травится старым video snap.
    const alreadyInSystemPiP =
      g.__pipInSystemModeRef?.current === true || g.__pendingSystemPiPSyncRef?.current === true;
    const leaveUi: 'audio' | 'video' =
      alreadyInSystemPiP && (existing?.leaveUi === 'audio' || existing?.leaveUi === 'video')
        ? existing.leaveUi
        : leaveUiFromLive;
    // Sticky audio leave не сбрасывается апгрейдом PiP logo→peer video (только mid-session).
    const preferAudioOnly = inAppPiP
      ? false
      : leaveUi === 'audio' ||
        isSystemPiPSessionAudioOrigin() ||
        (alreadyInSystemPiP &&
          (existing?.preferAudioOnly === true || existing?.audioOrigin === true)) ||
        (placeholderOnly && (uiPreferAudio || isInAudioOnlyCallUi()));
    if (inAppPiP) {
      g.__systemPiPNeedsInAppRestoreRef = g.__systemPiPNeedsInAppRestoreRef || { current: false };
      g.__systemPiPNeedsInAppRestoreRef.current = true;
    } else {
      // Fullscreen leave: не дать stale needsRestore вернуть in-app на expand.
      if (g.__systemPiPNeedsInAppRestoreRef) g.__systemPiPNeedsInAppRestoreRef.current = false;
      if (g.__pendingInAppPiPRestoreAfterSystemRef) {
        g.__pendingInAppPiPRestoreAfterSystemRef.current = false;
      }
      if (g.__restoringInAppPiPFromSystemRef) {
        g.__restoringInAppPiPFromSystemRef.current = false;
      }
    }
    // In-app leave: всегда актуальный route (не sticky VideoCall — иначе restore откроет полный экран).
    const liveRoute = readRootCurrentRouteName();
    const routeNameForSnap =
      opts?.routeName !== undefined
        ? opts.routeName
        : inAppPiP
          ? liveRoute && liveRoute !== 'VideoCall'
            ? liveRoute
            : 'Home'
          : liveRoute || existing?.routeName || null;
    g.__systemPiPLeaveContextSnapshotRef = {
      // In-app leave: не форсить full-screen audio return (иначе плашка не восстановится).
      preferAudioOnly: inAppPiP ? false : preferAudioOnly,
      audioOrigin: inAppPiP ? false : preferAudioOnly,
      leaveUi,
      restoreInAppPiP: inAppPiP,
      routeName: routeNameForSnap,
      capturedAt: Date.now(),
    };
  } catch {}
}

/** После успешного return из system PiP — сбросить снимок, чтобы не отравить следующий leave. */
export function clearSystemPiPLeaveContextSnapshot(): void {
  try {
    const g = global as any;
    g.__systemPiPLeaveContextSnapshotRef = null;
  } catch {}
}

/** Держим актуальный снимок UI до Home → system PiP (onUserLeaveHint раньше AppState background). */
export function refreshSystemPiPLeaveContextSnapshot(): void {
  commitSystemPiPLeaveContextSnapshot();
}

export function peekSystemPiPLeaveContextForReturn(): SystemPiPLeaveContext {
  try {
    const g = global as any;
    const snap = g.__systemPiPLeaveContextSnapshotRef as SystemPiPLeaveContext | undefined;
    const suspendedInApp = g.__pipSuspendedForSystemPiPRef?.current === true;
    if (snap && Date.now() - snap.capturedAt < 120_000) {
      // snap.restoreInAppPiP ставится только при live in-app leave (commit больше не sticky).
      const restoreInAppPiP =
        snap.restoreInAppPiP === true ||
        suspendedInApp ||
        g.__restoringInAppPiPFromSystemRef?.current === true ||
        g.__systemPiPNeedsInAppRestoreRef?.current === true;
      const leaveUi =
        snap.leaveUi === 'audio' || snap.leaveUi === 'video'
          ? snap.leaveUi
          : snap.preferAudioOnly || snap.audioOrigin
            ? 'audio'
            : 'video';
      // Полный audio return только если уходили НЕ с in-app плашки.
      const preferAudioOnly =
        !restoreInAppPiP &&
        (leaveUi === 'audio' || snap.preferAudioOnly === true || snap.audioOrigin === true);
      return {
        ...snap,
        leaveUi,
        preferAudioOnly,
        audioOrigin: preferAudioOnly,
        restoreInAppPiP,
      };
    }
    if (suspendedInApp) {
      return {
        preferAudioOnly: false,
        audioOrigin: false,
        leaveUi: 'video',
        restoreInAppPiP: true,
        routeName: readRootCurrentRouteName() || 'Home',
        capturedAt: Date.now(),
      };
    }
    if (g.__systemPiPNeedsInAppRestoreRef?.current === true) {
      return {
        preferAudioOnly: false,
        audioOrigin: false,
        leaveUi: snap?.leaveUi === 'audio' || snap?.leaveUi === 'video' ? snap.leaveUi : 'video',
        restoreInAppPiP: true,
        routeName: snap?.routeName || readRootCurrentRouteName() || 'Home',
        capturedAt: Date.now(),
      };
    }
  } catch {}
  const audioNow = isSystemPiPLeaveAudioOrigin() || resolvePreferAudioOnlyUiOnPiPReturn();
  return {
    preferAudioOnly: audioNow,
    audioOrigin: audioNow,
    leaveUi: audioNow ? 'audio' : 'video',
    restoreInAppPiP: false,
    routeName: null,
    capturedAt: Date.now(),
  };
}
