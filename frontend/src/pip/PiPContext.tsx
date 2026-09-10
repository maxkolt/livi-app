// src/pip/PiPContext.tsx
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { AppState, DeviceEventEmitter, NativeModules, NativeEventEmitter, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { CommonActions } from '@react-navigation/native';
import socket, { onConnected, emitPresenceUpdateIfChanged } from '../../sockets/socket';
import { applyCallEndedGlobalRefsOnce } from '../../utils/globalEvents';
import { clearEndingCallInProgress, captureSystemPiPReturnMediaSnapshot, resolvePiPLocalMutedState, markDirectCallVideoMediaActive, ongoingCallPrefersVideoMedia, resolveActiveCallInCallMedia, readInAppPiPAudioOutputRoute, readAuthoritativeCallAudioRouteAfterPiP, readLastAppliedCallAudioRoute, readActiveExternalCallAudioRoute, readConnectedExternalCallAudioRoute, setUserSelectedCallAudioRoute, readUserSelectedCallAudioRoute, readUserSelectedExternalCallAudioRoute, rememberManualBuiltinCallAudioRoute, readUserLockedBuiltinCallAudioRoute, clearBuiltinPinForExternalHeadsetConnect, markUserSelectedExternalCallAudioRoute } from '../../utils/activeCallSession';
import { buildCallEndSocketPayload } from '../../utils/callEndPayload';
import { logger } from '../../utils/logger';
import { readRootCurrentRouteName } from '../../utils/safeRootNavigation';
import { trackReleaseEvent } from '../../utils/telemetry';
import { requestExitSystemPiPSoft, dismissSystemPiPAfterCallEnded } from '../../utils/callKeep';
import { startActiveCallNotification, reenableAndroidSystemPiPLeaveHintAfterReturn, refreshAndroidActiveCallNotification, syncAndroidSystemPiPNativeFlags, syncAndroidLeaveHintForOngoingCall, isAndroidActiveCallEligibleForLeaveHint, shouldUseSystemPiPControlsCaptureOnly, forceAndroidSystemPiPPeerVideoVisible } from '../../utils/activeCallNotification';
import {
  shouldUsePipPlaceholderOnly,
  shouldUseSystemPiPPlaceholderOnly,
  prepareDirectCallAudioReturnFromPiP,
  isInAudioOnlyCallUi,
  setPipInAppRtcFromAudioOnlySticky,
  shouldAllowRtcVideoRenderInInAppPiP,
  peekSystemPiPLeaveContextForReturn,
  refreshSystemPiPLeaveContextSnapshot,
  commitSystemPiPLeaveContextSnapshot,
  isSystemPiPLeaveAudioOrigin,
  isSystemPiPSessionAudioOrigin,
  markSystemPiPSessionAudioOrigin,
  clearSystemPiPSessionAudioOrigin,
  mediaStreamHasLiveVideo,
} from './pipPlaceholderOnly';
import {
  pinLoudSpeakerForAudioCallLeavingToBackground,
  persistVideoInAppPiPAudioRoute,
  restoreCallMediaAfterSystemPiPReturn,
  scheduleReapplyPersistedCallAudioRoute,
  setPersistedCallAudioRoute,
  resolveVideoInAppPiPAudioRoute,
  resolveVideoInAppPiPPreserveRoute,
  getPersistedCallAudioRoute,
  restoreCallAudioForInAppPiPPlaque,
  armCallAudioPreservePriority,
  scheduleInAppPiPAudioTransitionReapply,
  shouldApplyHomeLoudSpeakerPin,
  prepareSystemPiPEnterCallAudioRoute,
  isInAppPiPContextIncludingSuspended,
  prepareDirectCallVideoExpandFromInAppPiP,
  clearCallAudioRouteUiLock,
  applyCallAudioOutputRouteNow,
  resolveReapplyMediaInCallContext,
  cancelScheduledCallAudioRouteReappliesMatching,
} from '../../utils/callAudioRoutePersist';
import { armCallAudioRouteUiLock, shouldSkipScheduledReturnToAudioUiReapply } from '../../utils/callAudioRouteTransitionGuards';
import {
  preferSpeakerAfterHeadsetDisconnect,
  rememberVideoUiSpeakerAfterHeadsetDisconnect,
  resolveCallRouteAfterHeadsetDisconnect,
} from '../../utils/callHeadsetAudioFallback';
import { mergeNativeProbeIntoGlobal, probeNativeCallAudioRoutes, clearNativeProbeBluetoothRoute, clearNativeProbeWiredHeadsetRoute, isBluetoothHeadsetActiveForCall, setCallBluetoothHeadsetConnectedCache } from '../../utils/nativeCallAudioProbe';
import {
  applyInAppPiPHeadsetConnectRoute,
  shouldAutoBtConnectFromDeviceList,
  isInAppPiPExplicitBuiltinRouteChoiceActive,
  isInAppPiPManualRouteLockActive,
} from '../../utils/inAppPiPHeadsetConnect';
import { notifyInAppPiPAudioRouteUi } from '../../utils/callInAppPiPAudioRouteUi';
import type { InCallAudioRoute } from '../../components/VideoChat/hooks/audioRouteTypes';
import { isExternalHeadsetRoute, normalizeInCallRoute } from '../../components/VideoChat/hooks/audioRouteTypes';
import {
  beginHomePiPOutcomeWatch,
  installSystemPiPHomeTraceListener,
  logHomePiPTrace,
  noteHomePiPModeChanged,
  setActiveHomePiPTraceId,
} from '../../utils/systemPiPHomeTrace';
import { mergeActiveVideoCallParams } from '../../utils/appNavigationGuard';

type MediaStreamLike = any; // из @livekit/react-native-webrtc

function readAvailableAudioDeviceListFromGlobal(): string[] {
  try {
    const av = (global as any).__inCallAvailableAudioRoutesRef?.current;
    return Array.isArray(av) ? av.map((s: unknown) => String(s)) : [];
  } catch {
    return [];
  }
}

function readNativePreferredExternalRoute(): InCallAudioRoute | null {
  try {
    const preferred = normalizeInCallRoute(
      (global as any).__nativeCallAudioRoutesRef?.current?.preferred || '',
    );
    return preferred && isExternalHeadsetRoute(preferred) ? preferred : null;
  } catch {
    return null;
  }
}

function resolvePiPExternalAudioRoute(hint?: InCallAudioRoute | string | null): InCallAudioRoute | null {
  const lockedExternal = readUserSelectedExternalCallAudioRoute();
  if (lockedExternal) return lockedExternal;
  const nativePreferred = readNativePreferredExternalRoute();
  if (nativePreferred) return nativePreferred;
  const activeExternal = readActiveExternalCallAudioRoute(hint);
  if (activeExternal) return activeExternal;
  const connectedExternal = readConnectedExternalCallAudioRoute(hint);
  if (connectedExternal) return connectedExternal;
  const lastApplied = readLastAppliedCallAudioRoute();
  if (lastApplied && isExternalHeadsetRoute(lastApplied)) {
    const available = readAvailableAudioDeviceListFromGlobal();
    if (!available.length || available.includes(lastApplied)) return lastApplied;
  }
  return null;
}

function shouldSkipSuppressOverlayWhenLeavingSystemPiP(): boolean {
  try {
    const g = global as any;
    if (g.__restoringInAppPiPFromSystemRef?.current === true) return true;
    if (g.__pipSuspendedForSystemPiPRef?.current === true) return true;
    if (g.__systemPiPNeedsInAppRestoreRef?.current === true) return true;
    if (g.__pipReturnToCallInFlightRef?.current === true) return true;
    return peekSystemPiPLeaveContextForReturn().restoreInAppPiP;
  } catch {
    return false;
  }
}

/** Скрыть in-app оверлей на время system PiP без hidePiP — visible остаётся true для мгновенного возврата плашки. */
function suspendInAppOverlayForSystemPiPEnter(): void {
  try {
    const g = global as any;
    if (g.__pipVisibleRef?.current !== true) return;
    g.__pipSuspendedForSystemPiPRef = g.__pipSuspendedForSystemPiPRef || { current: false };
    g.__pipSuspendedForSystemPiPRef.current = true;
    // Sticky: OEM bounce enter→exit может снять suspend до restore — плашку всё равно вернуть.
    g.__systemPiPNeedsInAppRestoreRef = g.__systemPiPNeedsInAppRestoreRef || { current: false };
    g.__systemPiPNeedsInAppRestoreRef.current = true;
    NativeModules.LiviAppModule?.setInAppPiPVisibleForSystemPiP?.(false);
  } catch (_) {}
}

function clearInAppPiPSystemSuspendFlags(): void {
  try {
    const g = global as any;
    if (g.__pipSuspendedForSystemPiPRef) g.__pipSuspendedForSystemPiPRef.current = false;
    if (g.__restoringInAppPiPFromSystemRef) g.__restoringInAppPiPFromSystemRef.current = false;
    try {
      NativeModules.LiviAppModule?.setInAppPiPVisibleForSystemPiP?.(true);
    } catch (_) {}
  } catch (_) {}
}

function markSystemPiPNeedsInAppRestore(): void {
  try {
    const g = global as any;
    g.__systemPiPNeedsInAppRestoreRef = g.__systemPiPNeedsInAppRestoreRef || { current: false };
    g.__systemPiPNeedsInAppRestoreRef.current = true;
  } catch (_) {}
}

function clearSystemPiPNeedsInAppRestore(): void {
  try {
    const g = global as any;
    if (g.__systemPiPNeedsInAppRestoreRef) g.__systemPiPNeedsInAppRestoreRef.current = false;
  } catch (_) {}
}

function isSystemPiPNeedsInAppRestore(): boolean {
  try {
    return (global as any).__systemPiPNeedsInAppRestoreRef?.current === true;
  } catch {
    return false;
  }
}

/**
 * In-app PiP: `visible` из React context обновляется после ре-рендера, а `showPiP`/`hidePiP`
 * выставляют `__pipVisibleRef` синхронно. Для проверок в том же тике (навигация, BackHandler)
 * используйте эту функцию вместе с `pip.visible` / `pipRef.current.visible`.
 */
export function isPipOverlayVisibleSync(): boolean {
  try {
    return (global as any).__pipVisibleRef?.current === true;
  } catch {
    return false;
  }
}

type PiPState = {
  visible: boolean;
  callId: string | null;
  roomId: string | null;

  partnerName: string;
  partnerAvatarUrl?: string;

  isMuted: boolean;         // мой микрофон (локальный)
  isRemoteMuted: boolean;   // глушим аудио собеседника

  localStream: MediaStreamLike | null;
  remoteStream: MediaStreamLike | null;

  // Состояние камеры на момент входа в PiP (нужно для точного восстановления при возврате)
  localCamOn?: boolean;
  /** Камера собеседника включена — для отображения заглушки «Отошел» в PiP при выключении. */
  remoteCamOn?: boolean;

  // позиция in-app PiP (маленькое окно)
  pipPos: { x: number; y: number };

  // для возврата
  lastNavParams?: any;

  // Управление
  showPiP: (params: {
    callId: string;
    roomId: string;
    partnerName?: string;
    partnerAvatarUrl?: string;
    localStream?: MediaStreamLike | null;
    remoteStream?: MediaStreamLike | null;
    localCamOn?: boolean;
    remoteCamOn?: boolean;
    muteLocal?: boolean;
    muteRemote?: boolean;
    navParams?: any; // ← кто нас вызвал (для корректного возврата)
    /**
     * When true, delays making overlay visible by a couple frames.
     * Used on Android BackHandler to avoid PiP flashing before navigation.
     */
    deferVisible?: boolean;
    fromAudioOnlyUi?: boolean;
    audioOutputRoute?: import('../../components/VideoChat/hooks/audioRouteTypes').InCallAudioRoute;
  }) => void;

  hidePiP: () => void;
  updatePiPPosition: (x: number, y: number) => void;

  returnToCall: (opts?: { preferAudioOnlyUi?: boolean }) => void;
  endCall: () => void;

  /** Разрешать рендер RTCView в PiP только после задержки (экран звонка успел размонтироваться). */
  allowVideoRender: boolean;

  /** true = системный PiP (главный экран): только видео + системная кнопка X, без наших кнопок. false = in-app PiP: верхняя панель + видео. */
  inSystemPiPMode: boolean;
  /** true = скоро войдём в системный PiP (VideoCall рисует компактный вид перед входом). */
  pendingSystemPiP: boolean;
  /** Выделенный fullscreen-host для system PiP capture. */
  systemPiPCaptureActive: boolean;
  /** Уникальный id запроса system PiP capture, чтобы вход выполнялся ровно один раз на подготовку. */
  systemPiPCaptureRequestId: number;
  /** При возврате из системного PiP скрываем оверлей на 1 кадр, чтобы он не мелькнул поверх экрана видеозвонка. */
  suppressOverlayForReturn: boolean;
  /** Размеры decorView с натива для совпадения overlay 9:16 с sourceRect (без чёрных полос в системном PiP). */
  decorSizeForPiP: { width: number; height: number } | null;

  /** Инкремент при смене remoteStream / появлении видеотрека — remount RTCView в PiP. */
  remoteStreamVersion: number;
  pipRemoteViewKey: number;

  // служебное
  updatePiPState: (patch: Partial<PiPState> & { pipRemoteViewKey?: number }) => void;
};

export const PiPContext = createContext<PiPState | null>(null);

function pickNonEmptyPiPString(...values: (string | undefined | null)[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') {
      return v.trim();
    }
  }
  return undefined;
}

export const usePiP = () => {
  const ctx = useContext(PiPContext);
  if (!ctx) throw new Error('usePiP must be used inside PiPProvider');
  return ctx;
};

type Props = PropsWithChildren<{
  onReturnToCall?: (callId: string, roomId: string | null) => void;
  onEndCall?: (callId: string | null, roomId: string | null) => void;
}>;

export function PiPProvider({ children, onReturnToCall, onEndCall }: Props) {
  // базовое состояние
  const [visible, setVisible] = useState(false);
  const [callId, setCallId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const callIdRef = useRef<string | null>(null);
  const roomIdRef = useRef<string | null>(null);
  // хранит реальный ник партнёра (если есть); фоллбек-лейбл вычисляем в UI по текущему языку
  const [partnerName, setPartnerName] = useState<string>('');
  const [partnerAvatarUrl, setPartnerAvatarUrl] = useState<string | undefined>(undefined);
  const partnerNameRef = useRef(partnerName);
  const partnerAvatarUrlRef = useRef<string | undefined>(partnerAvatarUrl);

  useEffect(() => {
    partnerNameRef.current = partnerName;
  }, [partnerName]);

  useEffect(() => {
    partnerAvatarUrlRef.current = partnerAvatarUrl;
  }, [partnerAvatarUrl]);

  const [isMuted, setIsMuted] = useState(false);
  const [isRemoteMuted, setIsRemoteMuted] = useState(false);
  const [inSystemPiPMode, setInSystemPiPMode] = useState(false);
  const [pendingSystemPiP, setPendingSystemPiP] = useState(false);
  const [systemPiPCaptureActive, setSystemPiPCaptureActive] = useState(false);
  const [systemPiPCaptureRequestId, setSystemPiPCaptureRequestId] = useState(0);
  // Эквалайзер отключен

  const localStreamRef = useRef<MediaStreamLike | null>(null);
  const remoteStreamRef = useRef<MediaStreamLike | null>(null);
  const localCamOnRef = useRef<boolean | undefined>(undefined);
  const remoteCamOnRef = useRef<boolean>(true);
  const [localCamOn, setLocalCamOn] = useState<boolean | undefined>(undefined);
  const [remoteCamOn, setRemoteCamOn] = useState<boolean>(true);
  const [pipPos, setPipPos] = useState({ x: 12, y: 120 });

  // для возврата
  const [lastNavParams, setLastNavParams] = useState<any>(undefined);

  /** Рендер видео в PiP включаем с задержкой, чтобы не было двух RTCView одновременно. */
  const [allowVideoRender, setAllowVideoRender] = useState(false);
  const allowVideoRenderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** При возврате из системного PiP — скрыть in-app оверлей, чтобы не мелькал поверх экрана видеозвонка. */
  const [suppressOverlayForReturn, setSuppressOverlayForReturn] = useState(false);
  /** Инкремент при установке стрима в showPiP — чтобы value контекста обновился и PiPOverlay получил remoteStream. */
  const [remoteStreamVersion, setRemoteStreamVersion] = useState(0);
  const [pipRemoteViewKey, setPipRemoteViewKey] = useState(0);
  const pipRemoteViewKeyRef = useRef(0);
  /** Размеры decorView для системного PiP layout (синхрон с buildSystemPiPSourceRect на нативе). */
  const [decorSizeForPiP, setDecorSizeForPiP] = useState<{ width: number; height: number } | null>(null);

  // guard от двойной навигации
  const navigatingRef = useRef(false);
  const returnToCallInFlightRef = useRef(false);
  const pipSessionSyncRef = useRef<{ key: string; at: number }>({ key: '', at: 0 });
  /** iOS deferVisible: setVisible(true) в следующем кадре — отменяем в hidePiP, иначе PiP всплывёт после закрытия. */
  const deferVisibleRafRef = useRef<number | null>(null);

  useEffect(() => {
    callIdRef.current = callId;
    roomIdRef.current = roomId;
  }, [callId, roomId]);

  const resolveStablePiPIds = useCallback((): { callId: string | null; roomId: string | null } => {
    try {
      const g = global as any;
      const paramsRef = g.__currentCallPiPParamsRef?.current;
      const lastCtx = g.__pipLastContextRef?.current;
      const session = g.__webrtcSessionRef?.current;
      const sessionCallId =
        session && typeof (session as any).getCallId === 'function'
          ? (session as any).getCallId()
          : null;
      const sessionRoomId =
        session && typeof (session as any).getRoomId === 'function'
          ? (session as any).getRoomId()
          : null;
      const cid = String(callIdRef.current || paramsRef?.callId || lastCtx?.callId || sessionCallId || '').trim();
      const rid = String(roomIdRef.current || paramsRef?.roomId || lastCtx?.roomId || sessionRoomId || '').trim();
      return { callId: cid || null, roomId: rid || null };
    } catch {
      return { callId: callIdRef.current, roomId: roomIdRef.current };
    }
  }, []);

  // suppressOverlayForReturn сбрасывается только при размонтировании экрана VideoCall (см. VideoCall.tsx),
  // чтобы in-app PiP не показывался поверх полноэкранного видеозвонка после возврата из системного PiP.

  /**
   * КРИТИЧНО (фикс): когда VideoCall экран размонтирован (мы ушли в меню/друзья, а звонок продолжает жить в PiP),
   * при реконнекте сокета `socket.data.busy` на сервере сбрасывается в дефолт (false), и друзья видят пользователя
   * как НЕ занятого. Поэтому, пока PiP видим и у нас есть call/room id, поддерживаем presence busy из PiPContext
   * и переотправляем его при connect.
   *
   * Важно: здесь НЕ отправляем status:'online' при hidePiP(), чтобы не "мигать" статусом при возврате на экран звонка.
   * Снятие busy происходит на сервере при завершении звонка (call:end/call:ended) и/или экраном звонка.
   */
  const sendPresenceBusyFromPiP = useCallback((opts?: { force?: boolean }) => {
    if (!visible) return;
    const rid = String(roomId || callId || '').trim();
    if (!rid) return;
    try {
      emitPresenceUpdateIfChanged({ status: 'busy', roomId: rid }, opts);
    } catch {}
  }, [visible, roomId, callId]);

  useEffect(() => {
    if (!visible) return;
    // первичная отправка при показе PiP + при изменении callId/roomId
    sendPresenceBusyFromPiP();
    // переотправка при реконнекте сокета (часто в PiP/фон в релизе)
    const off = onConnected(() => sendPresenceBusyFromPiP({ force: true }));
    return () => { try { off?.(); } catch {} };
  }, [visible, callId, roomId, sendPresenceBusyFromPiP]);



  // Разрешаем рендер видео в PiP с небольшой задержкой, чтобы экран VideoCall успел "уйти" с экрана
  // и не было двух RTCView одновременно на один remoteStream (Android может показать чёрный экран/мерцание).
  // Важно: если allowVideoRender уже включён (например, при deferVisible), эффект не должен его выключать.
  const PIP_VIDEO_DELAY_MS = 160;
  const PIP_VIDEO_DELAY_SYSTEM_PIP_MS = 0;
  const delayMs = pendingSystemPiP ? PIP_VIDEO_DELAY_SYSTEM_PIP_MS : PIP_VIDEO_DELAY_MS;
  useEffect(() => {
    if (!visible) {
      // Важно: showPiP() ставит __pipVisibleRef.current=true СИНХРОННО до setVisible(true),
      // а сам visible при deferVisible включается позже (через rAF). В этот промежуток мы НЕ должны
      // сбрасывать allowVideoRender=false — иначе in-app PiP всегда "мигнёт" плейсхолдером.
      const preparing =
        (global as any).__pipVisibleRef?.current === true;
      if (!preparing) {
        setAllowVideoRender(false);
      }
      if (allowVideoRenderTimeoutRef.current) {
        clearTimeout(allowVideoRenderTimeoutRef.current);
        allowVideoRenderTimeoutRef.current = null;
      }
      return;
    }
    if (allowVideoRender) return;
    if (allowVideoRenderTimeoutRef.current) {
      clearTimeout(allowVideoRenderTimeoutRef.current);
      allowVideoRenderTimeoutRef.current = null;
    }
    if (delayMs <= 0) {
      const enable = () => {
        if (
          !shouldAllowRtcVideoRenderInInAppPiP({
            localCamOn: localCamOnRef.current,
            remoteCamOn: remoteCamOnRef.current,
            remoteStream: remoteStreamRef.current,
            localStream: localStreamRef.current,
          })
        ) {
          return;
        }
        setAllowVideoRender(true);
      };
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(enable);
      } else {
        enable();
      }
      return;
    }
    allowVideoRenderTimeoutRef.current = setTimeout(() => {
      allowVideoRenderTimeoutRef.current = null;
      if (
        !shouldAllowRtcVideoRenderInInAppPiP({
          localCamOn: localCamOnRef.current,
          remoteCamOn: remoteCamOnRef.current,
          remoteStream: remoteStreamRef.current,
          localStream: localStreamRef.current,
        })
      ) {
        return;
      }
      setAllowVideoRender(true);
    }, delayMs);
    return () => {
      if (allowVideoRenderTimeoutRef.current) {
        clearTimeout(allowVideoRenderTimeoutRef.current);
        allowVideoRenderTimeoutRef.current = null;
      }
    };
  }, [visible, remoteStreamVersion, delayMs, allowVideoRender, pendingSystemPiP]);

  // Системный PiP (Android): только видео + системная кнопка X. In-app PiP: верхняя панель + видео.
  useEffect(() => {
    installSystemPiPHomeTraceListener();
    return () => {};
  }, []);

  // КРИТИЧНО: Обновление state в том же тике, что и нативный переход в PiP, приводит к "forEach of null"
  // (Animated/React при смене transform или перестроении дерева). Откладываем на следующий тик.
  useEffect(() => {
    if (Platform.OS !== 'android') return () => {};
    const emitter = new NativeEventEmitter(NativeModules.LiviAppModule);
    const sub = emitter.addListener('SystemPiPModeChanged', (payload: { isInPiP?: boolean }) => {
      const inPiP = !!payload?.isInPiP;
      const traceId = (global as any).__activeHomePiPTraceIdRef?.current as string | null;
      logHomePiPTrace('js_mode_changed', { traceId: traceId ?? undefined, inPiP });
      noteHomePiPModeChanged(traceId, inPiP);
      const stableIds = resolveStablePiPIds();
      // OEM bounce: ModeChanged(true)→false за сотни ms пока app ещё в background —
      // не трактовать как реальный exit (иначе pip:state=false + audio return).
      try {
        const g = global as any;
        g.__lastSystemPiPModeChangedAtRef = g.__lastSystemPiPModeChangedAtRef || { current: 0 };
        g.__lastSystemPiPEnteredAtRef = g.__lastSystemPiPEnteredAtRef || { current: 0 };
        const now = Date.now();
        if (inPiP) {
          g.__lastSystemPiPEnteredAtRef.current = now;
        } else {
          const enteredAt = Number(g.__lastSystemPiPEnteredAtRef.current || 0);
          const returnInFlight =
            returnToCallInFlightRef.current ||
            g.__pipReturnToCallJustPressedRef?.current === true ||
            g.__pipReturnToCallInFlightRef?.current === true;
          if (
            !returnInFlight &&
            enteredAt > 0 &&
            now - enteredAt < 900 &&
            AppState.currentState === 'background'
          ) {
            logger.info('[PiPContext] Ignore OEM SystemPiPModeChanged(false) bounce', {
              sinceEnterMs: now - enteredAt,
            });
            logHomePiPTrace('js_mode_changed_bounce_ignored', {
              traceId: traceId ?? undefined,
              sinceEnterMs: now - enteredAt,
            });
            g.__lastSystemPiPModeChangedAtRef.current = now;
            return;
          }
        }
        g.__lastSystemPiPModeChangedAtRef.current = now;
      } catch (_) {}
      trackReleaseEvent('pip_enter_exit', {
        phase: inPiP ? 'enter' : 'exit',
        callId: stableIds.callId,
        roomId: stableIds.roomId,
      });
      // SYNC до rAF: TrackSubscribed в том же кадре иначе remount CaptureHost (peer video fullscreen поверх audio).
      if (!inPiP) {
        try {
          const g = global as any;
          const now = Date.now();
          g.__blockSystemPiPCaptureHostUntilRef =
            g.__blockSystemPiPCaptureHostUntilRef || { current: 0 };
          g.__blockSystemPiPCaptureHostUntilRef.current = Math.max(
            Number(g.__blockSystemPiPCaptureHostUntilRef.current || 0),
            now + 10000,
          );
          g.__returningFromSystemPiPUntilRef = g.__returningFromSystemPiPUntilRef || { current: 0 };
          g.__returningFromSystemPiPUntilRef.current = Math.max(
            Number(g.__returningFromSystemPiPUntilRef.current || 0),
            now + 12000,
          );
          g.__pendingSystemPiPSyncRef = g.__pendingSystemPiPSyncRef || { current: false };
          g.__pendingSystemPiPSyncRef.current = false;
          g.__pipInSystemModeRef = g.__pipInSystemModeRef || { current: false };
          g.__pipInSystemModeRef.current = false;
          g.__systemPiPEntryInProgressUntilRef =
            g.__systemPiPEntryInProgressUntilRef || { current: 0 };
          g.__systemPiPEntryInProgressUntilRef.current = 0;
          // Не дать late AboutToEnter / enter_preserve перебить return_to_audio.
          cancelScheduledCallAudioRouteReappliesMatching([
            'system_pip_enter_',
            'audio_home_preserve',
            'audio_home_loud_speaker',
          ]);
          g.__pipUpdateStateRef?.current?.({
            systemPiPCaptureActive: false,
            systemPiPCaptureRequestId: 0,
            pendingSystemPiP: false,
            inSystemPiPMode: false,
          });
          // Stale optimistic enter из AboutToEnter — не оставить pending для late activate.
          g.__pendingSystemPiPSyncRef.current = false;
          g.__pipInSystemModeRef.current = false;
          // SYNC: leaveUi может быть 'audio' даже при in-app leave — prepare убивает плашку (exitPiP).
          const leaveCtxSync = peekSystemPiPLeaveContextForReturn();
          const restoreInAppSync =
            leaveCtxSync.restoreInAppPiP === true ||
            g.__systemPiPNeedsInAppRestoreRef?.current === true ||
            g.__pipSuspendedForSystemPiPRef?.current === true;
          if (
            !restoreInAppSync &&
            (leaveCtxSync.preferAudioOnly ||
              leaveCtxSync.audioOrigin ||
              (leaveCtxSync.leaveUi === 'audio' && !leaveCtxSync.restoreInAppPiP) ||
              isSystemPiPSessionAudioOrigin())
          ) {
            prepareDirectCallAudioReturnFromPiP();
          }
        } catch (_) {}
      } else {
        // SYNC enter: cam-toggle / TrackSubscribed до rAF должны видеть in-PiP (mid-PiP peer video).
        // Снимаем returning/block с прошлого expand — иначе shouldIgnoreLateEnter глушит реальный enter.
        try {
          const g = global as any;
          g.__pipInSystemModeRef = g.__pipInSystemModeRef || { current: false };
          g.__pipInSystemModeRef.current = true;
          g.__blockSystemPiPCaptureHostUntilRef =
            g.__blockSystemPiPCaptureHostUntilRef || { current: 0 };
          g.__blockSystemPiPCaptureHostUntilRef.current = 0;
          g.__returningFromSystemPiPUntilRef = g.__returningFromSystemPiPUntilRef || { current: 0 };
          g.__returningFromSystemPiPUntilRef.current = 0;
          g.__pendingSystemPiPSyncRef = g.__pendingSystemPiPSyncRef || { current: false };
          g.__pendingSystemPiPSyncRef.current = true;
        } catch (_) {}
      }
      const run = () => {
        const g = global as any;
        const now = Date.now();
        const returningUntil = Number(g.__returningFromSystemPiPUntilRef?.current || 0);
        const returnState = g.__systemPiPReturnStateRef?.current;
        const settledUntil =
          returnState && Number(returnState.token || 0) === Number(g.__systemPiPReturnTokenRef?.current || 0)
            ? Number(returnState.settledUntil || 0)
            : 0;
        // Только in-flight return / justPressed — НЕ длинный returningUntil (глушил mid-PiP peer video).
        const shouldIgnoreLateEnter =
          inPiP &&
          (
            returnToCallInFlightRef.current ||
            g.__pipReturnToCallJustPressedRef?.current === true ||
            (now < settledUntil && now < returningUntil)
          );
        if (shouldIgnoreLateEnter) {
          setInSystemPiPMode(false);
          setPendingSystemPiP(false);
          setSystemPiPCaptureActive(false);
          setSystemPiPCaptureRequestId(0);
          setDecorSizeForPiP(null);
          try {
            g.__pipInSystemModeRef = g.__pipInSystemModeRef || { current: false };
            // Не поднимаем ref=true при ignored late enter — иначе activate CaptureHost после expand.
            g.__pipInSystemModeRef.current = false;
          } catch (_) {}
          return;
        }
        setInSystemPiPMode(inPiP);
        if (!inPiP) {
          try {
            g.__systemPiPLiViBackdropActiveRef = g.__systemPiPLiViBackdropActiveRef || { current: false };
            g.__systemPiPLiViBackdropActiveRef.current = false;
          } catch (_) {}
          // Повторно (после sync) — на случай если rAF пришёл позже TrackSubscribed.
          try {
            g.__blockSystemPiPCaptureHostUntilRef =
              g.__blockSystemPiPCaptureHostUntilRef || { current: 0 };
            g.__blockSystemPiPCaptureHostUntilRef.current = Math.max(
              Number(g.__blockSystemPiPCaptureHostUntilRef.current || 0),
              Date.now() + 10000,
            );
            g.__returningFromSystemPiPUntilRef = g.__returningFromSystemPiPUntilRef || { current: 0 };
            g.__returningFromSystemPiPUntilRef.current = Math.max(
              Number(g.__returningFromSystemPiPUntilRef.current || 0),
              Date.now() + 12000,
            );
            g.__pendingSystemPiPSyncRef = g.__pendingSystemPiPSyncRef || { current: false };
            g.__pendingSystemPiPSyncRef.current = false;
            g.__pipInSystemModeRef = g.__pipInSystemModeRef || { current: false };
            g.__pipInSystemModeRef.current = false;
          } catch (_) {}
          setPendingSystemPiP(false);
          setDecorSizeForPiP(null);
          setSystemPiPCaptureActive(false);
          setSystemPiPCaptureRequestId(0);
          // Выход из системного PiP.
          // In-app leave: никогда audio-return/exitPiP — только снять suspend + гарантировать showPiP.
          const leaveCtxExit = peekSystemPiPLeaveContextForReturn();
          const restoreInAppExit =
            leaveCtxExit.restoreInAppPiP === true || shouldSkipSuppressOverlayWhenLeavingSystemPiP();
          if (restoreInAppExit) {
            setSuppressOverlayForReturn(false);
            clearInAppPiPSystemSuspendFlags();
            try {
              const gRestore = global as any;
              gRestore.__pendingInAppPiPRestoreAfterSystemRef =
                gRestore.__pendingInAppPiPRestoreAfterSystemRef || { current: false };
              gRestore.__pendingInAppPiPRestoreAfterSystemRef.current = true;
              const runRestore = () => {
                try {
                  if (gRestore.__pendingInAppPiPRestoreAfterSystemRef?.current !== true) return;
                  if (
                    gRestore.__endingCallInProgressRef?.current === true ||
                    gRestore.__callEndedFromPiPNoOpenRef?.current === true
                  ) {
                    gRestore.__pendingInAppPiPRestoreAfterSystemRef.current = false;
                    return;
                  }
                  // Даже если __pipVisibleRef=true (soft-hide), нужен showPiP/re-render —
                  // иначе overlay остаётся скрыт по __pipSuspended (ref без setState).
                  const fn = gRestore.__pipReturnToCallRef?.current;
                  if (typeof fn === 'function') {
                    gRestore.__restoringInAppPiPFromSystemRef =
                      gRestore.__restoringInAppPiPFromSystemRef || { current: false };
                    gRestore.__restoringInAppPiPFromSystemRef.current = true;
                    fn({ restoreInAppPiP: true });
                    return;
                  }
                  if (gRestore.__pipVisibleRef?.current === true) {
                    gRestore.__pendingInAppPiPRestoreAfterSystemRef.current = false;
                    clearSystemPiPNeedsInAppRestore();
                    try {
                      gRestore.__pipUpdateStateRef?.current?.({
                        suppressOverlayForReturn: false,
                      });
                    } catch (_) {}
                    restoreCallAudioForInAppPiPPlaque('system_pip_exit_in_app_already_visible');
                  }
                } catch (_) {}
              };
              if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => setTimeout(runRestore, 32));
              } else {
                setTimeout(runRestore, 48);
              }
            } catch (_) {}
          } else {
            setSuppressOverlayForReturn(true);
            try {
              if (
                leaveCtxExit.leaveUi === 'audio' ||
                leaveCtxExit.preferAudioOnly ||
                leaveCtxExit.audioOrigin ||
                isSystemPiPSessionAudioOrigin()
              ) {
                prepareDirectCallAudioReturnFromPiP();
              }
            } catch (_) {}
          }
        }
        try {
          g.__pipInSystemModeRef = g.__pipInSystemModeRef || { current: false };
          g.__pipInSystemModeRef.current = inPiP;
        } catch (_) {}
        if (inPiP) {
          // Новый вход в PiP — снять block с прошлого expand, иначе mid-PiP peer video не поднимется.
          try {
            g.__blockSystemPiPCaptureHostUntilRef =
              g.__blockSystemPiPCaptureHostUntilRef || { current: 0 };
            g.__blockSystemPiPCaptureHostUntilRef.current = 0;
          } catch (_) {}
          armCallAudioPreservePriority(6000);
          setPendingSystemPiP(false);
          // Audio/logo origin: CaptureHost всегда mounted (тихий fill под native logo) —
          // иначе mid-PiP peer cam не успевает remount RTC до expand.
          // Полный video UI на VideoCall → compact RemoteVideo, без dual RTC.
          const onVideoCallRoute = readRootCurrentRouteName() === 'VideoCall';
          const audioUi = isInAudioOnlyCallUi();
          const audioOrigin = isSystemPiPLeaveAudioOrigin() || isSystemPiPSessionAudioOrigin();
          const peerLiveNow = !shouldUseSystemPiPPlaceholderOnly();
          const videoUiOwnsCapture =
            onVideoCallRoute && !audioUi && !audioOrigin && peerLiveNow;
          if (videoUiOwnsCapture) {
            setSystemPiPCaptureActive(false);
            setSystemPiPCaptureRequestId(0);
            setAllowVideoRender(true);
            try {
              forceAndroidSystemPiPPeerVideoVisible();
            } catch (_) {}
          } else {
            setSystemPiPCaptureActive(true);
            setAllowVideoRender(peerLiveNow);
            if (peerLiveNow) {
              try {
                forceAndroidSystemPiPPeerVideoVisible();
              } catch (_) {}
            }
          }
          try {
            g.__pipVisibleRef = g.__pipVisibleRef || { current: false };
            if (g.__pipVisibleRef.current === true) {
              suspendInAppOverlayForSystemPiPEnter();
              logHomePiPTrace('js_soft_hide_in_app_for_system', { traceId: g.__activeHomePiPTraceIdRef?.current });
            }
          } catch (_) {}
          try {
            g.__pendingSystemPiPSyncRef = g.__pendingSystemPiPSyncRef || { current: false };
            g.__pendingSystemPiPSyncRef.current = false;
          } catch (_) {}
          const session = g.__webrtcSessionRef?.current;
          if (session && typeof (session as any).enterPiP === 'function') (session as any).enterPiP();
          // КРИТИЧНО: В PiP система часто переключает звук — переприменяем сохранённый маршрут (BT / динамик).
          const reapplyPiPAudio = () => {
            prepareSystemPiPEnterCallAudioRoute();
          };
          if (Platform.OS === 'android') {
            reapplyPiPAudio();
          }
        } else {
          try {
            const g = global as any;
            g.__returningFromSystemPiPUntilRef = g.__returningFromSystemPiPUntilRef || { current: 0 };
            g.__returningFromSystemPiPUntilRef.current = Math.max(
              Number(g.__returningFromSystemPiPUntilRef.current || 0),
              Date.now() + 4500,
            );
            armCallAudioPreservePriority(4500);
          } catch (_) {}
          try {
            cancelScheduledCallAudioRouteReappliesMatching([
              'system_pip_enter_',
              'audio_home_preserve',
              'audio_home_loud_speaker',
              'app_state_foreground',
            ]);
            if (shouldSkipSuppressOverlayWhenLeavingSystemPiP() || peekSystemPiPLeaveContextForReturn().restoreInAppPiP) {
              restoreCallAudioForInAppPiPPlaque('system_pip_exit_to_in_app_plaque');
            } else {
              const leaveCtx = peekSystemPiPLeaveContextForReturn();
              const audioLeave =
                leaveCtx.leaveUi === 'audio' ||
                leaveCtx.preferAudioOnly ||
                leaveCtx.audioOrigin ||
                isSystemPiPSessionAudioOrigin() ||
                isInAudioOnlyCallUi() ||
                shouldSkipScheduledReturnToAudioUiReapply();
              // Audio leave: sync prepare + App restoreCallMedia — без exit_preserve churn.
              if (!audioLeave) {
                const userBuiltin = readUserSelectedCallAudioRoute();
                const honorBuiltin =
                  userBuiltin === 'SPEAKER_PHONE' || userBuiltin === 'EARPIECE';
                scheduleReapplyPersistedCallAudioRoute('system_pip_exit_preserve_route', {
                  media: resolveReapplyMediaInCallContext(),
                  delaysMs: [0, 400],
                  honorUserRoute: honorBuiltin,
                  skipInCallRestart: honorBuiltin,
                });
              }
            }
          } catch (_) {}
        }
      };
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => run());
      } else {
        setTimeout(run, 0);
      }
    });
    return () => sub.remove();
  }, [resolveStablePiPIds]);

  // SystemPiPExpanded обрабатывается только в App.tsx через __pipReturnToCallRef.current().
  // Подписка здесь не нужна — иначе событие обрабатывается дважды: второй вызов идёт с уже очищенным state (hidePiP) и ломает переход.

  // ====== API управления ======
  const showPiP = useCallback((p: {
    callId: string;
    roomId: string;
    partnerName?: string;
    partnerAvatarUrl?: string;
    localStream?: MediaStreamLike | null;
    remoteStream?: MediaStreamLike | null;
    localCamOn?: boolean;
    remoteCamOn?: boolean;
    muteLocal?: boolean;
    muteRemote?: boolean;
    navParams?: any; // ← кто нас вызвал (для корректного возврата)
    deferVisible?: boolean;
    fromAudioOnlyUi?: boolean;
    audioOutputRoute?: InCallAudioRoute;
  }) => {
    const fromAudioOnlyUi =
      typeof p.fromAudioOnlyUi === 'boolean' ? p.fromAudioOnlyUi : isInAudioOnlyCallUi();
    setPipInAppRtcFromAudioOnlySticky(fromAudioOnlyUi);

    if (fromAudioOnlyUi) {
      const userSel = readUserSelectedCallAudioRoute();
      const lockedExternal = readUserSelectedExternalCallAudioRoute();
      const externalRoute = resolvePiPExternalAudioRoute(p.audioOutputRoute || userSel);
      const authoritativeBuiltin = readAuthoritativeCallAudioRouteAfterPiP();
      let routeNorm =
        externalRoute ||
        lockedExternal ||
        userSel ||
        authoritativeBuiltin ||
        readLastAppliedCallAudioRoute() ||
        getPersistedCallAudioRoute() ||
        normalizeInCallRoute(p.audioOutputRoute || '') ||
        readInAppPiPAudioOutputRoute() ||
        'EARPIECE';
      if (!userSel) {
        const availableNow = readAvailableAudioDeviceListFromGlobal();
        const connectedExt = readConnectedExternalCallAudioRoute(p.audioOutputRoute || routeNorm);
        if (
          connectedExt &&
          routeNorm !== 'SPEAKER_PHONE' &&
          routeNorm !== 'EARPIECE'
        ) {
          routeNorm = connectedExt;
        }
        const lastApplied = readLastAppliedCallAudioRoute();
        if (
          !isExternalHeadsetRoute(routeNorm) &&
          lastApplied &&
          isExternalHeadsetRoute(lastApplied) &&
          availableNow.includes(lastApplied)
        ) {
          routeNorm = lastApplied;
        }
      }
      setPersistedCallAudioRoute(routeNorm);
      setUserSelectedCallAudioRoute(routeNorm);
      if (routeNorm === 'SPEAKER_PHONE' || routeNorm === 'EARPIECE') {
        rememberManualBuiltinCallAudioRoute(routeNorm);
        try {
          const gExp = global as any;
          gExp.__explicitBuiltInCallAudioRouteRef =
            gExp.__explicitBuiltInCallAudioRouteRef || { current: false };
          gExp.__explicitBuiltInCallAudioRouteRef.current = true;
          gExp.__pipBuiltinRouteLockUntilRef = gExp.__pipBuiltinRouteLockUntilRef || { current: 0 };
          gExp.__pipBuiltinRouteLockUntilRef.current = Date.now() + 6500;
          gExp.__inAppPiPExplicitToggleRouteRef =
            gExp.__inAppPiPExplicitToggleRouteRef || { current: null };
          gExp.__inAppPiPExplicitToggleRouteRef.current = routeNorm;
        } catch {}
      }
      try {
        const gParams = global as any;
        gParams.__currentCallPiPParamsRef = gParams.__currentCallPiPParamsRef || { current: null };
        const existing = gParams.__currentCallPiPParamsRef.current;
        if (existing && typeof existing === 'object') {
          existing.audioOutputRoute = routeNorm;
        }
        gParams.__lastAppliedCallAudioRouteRef = { current: routeNorm };
        gParams.__onInAppPiPAudioRouteChanged?.(routeNorm);
        gParams.__pipUpdateStateRef?.current?.({ audioOutputRoute: routeNorm });
      } catch {}
      const audioBuiltin =
        routeNorm === 'SPEAKER_PHONE' || routeNorm === 'EARPIECE';
      try {
        const gAudio = global as any;
        gAudio.__lastInAppPipAudioReapplyAtRef = gAudio.__lastInAppPipAudioReapplyAtRef || { current: 0 };
        const nowAudio = Date.now();
        const lastAppliedEnter = readLastAppliedCallAudioRoute();
        const skipFromAudioReapply =
          isInAppPiPExplicitBuiltinRouteChoiceActive() ||
          (!!lastAppliedEnter && routeNorm === lastAppliedEnter);
        if (
          !skipFromAudioReapply &&
          nowAudio - Number(gAudio.__lastInAppPipAudioReapplyAtRef.current || 0) > 1200
        ) {
          gAudio.__lastInAppPipAudioReapplyAtRef.current = nowAudio;
          scheduleInAppPiPAudioTransitionReapply('from_audio', {
            media: 'audio',
            skipInCallRestart: true,
            honorUserRoute: audioBuiltin,
          });
        }
      } catch {
        if (
          !isInAppPiPExplicitBuiltinRouteChoiceActive() &&
          routeNorm !== readLastAppliedCallAudioRoute()
        ) {
          scheduleInAppPiPAudioTransitionReapply('from_audio', {
            media: 'audio',
            skipInCallRestart: true,
            honorUserRoute: audioBuiltin,
          });
        }
      }
    } else {
      const lockedExternal = readUserSelectedExternalCallAudioRoute();
      const externalRoute = resolvePiPExternalAudioRoute(p.audioOutputRoute || readUserSelectedCallAudioRoute());
      let videoRouteNorm =
        externalRoute ||
        lockedExternal ||
        readUserSelectedCallAudioRoute() ||
        normalizeInCallRoute(p.audioOutputRoute || '') ||
        readInAppPiPAudioOutputRoute();
      const videoAvailable = readAvailableAudioDeviceListFromGlobal();
      const videoLastApplied = readLastAppliedCallAudioRoute();
      const activeVideoExternal =
        resolvePiPExternalAudioRoute(videoRouteNorm);
      if (activeVideoExternal) {
        videoRouteNorm = activeVideoExternal;
      }
      if (
        !activeVideoExternal &&
        !readUserSelectedCallAudioRoute() &&
        !isExternalHeadsetRoute(videoRouteNorm) &&
        videoLastApplied &&
        isExternalHeadsetRoute(videoLastApplied) &&
        videoAvailable.includes(videoLastApplied)
      ) {
        videoRouteNorm = videoLastApplied;
      }
      if (!isExternalHeadsetRoute(videoRouteNorm)) {
        videoRouteNorm = resolveVideoInAppPiPPreserveRoute();
      }
      if (isExternalHeadsetRoute(videoRouteNorm)) {
        setUserSelectedCallAudioRoute(videoRouteNorm);
      } else if (videoRouteNorm === 'SPEAKER_PHONE' || videoRouteNorm === 'EARPIECE') {
        // Video→PiP: громкая (или явный earpiece) должна пережить возврат на audio.
        setUserSelectedCallAudioRoute(videoRouteNorm);
        rememberManualBuiltinCallAudioRoute(videoRouteNorm);
        armCallAudioRouteUiLock(videoRouteNorm);
        try {
          const gPin = global as any;
          gPin.__explicitBuiltInCallAudioRouteRef =
            gPin.__explicitBuiltInCallAudioRouteRef || { current: false };
          gPin.__explicitBuiltInCallAudioRouteRef.current = true;
          // Как audio→PiP: lock + explicit, чтобы плашка/auto-poll не откатывали на EARPIECE.
          gPin.__pipBuiltinRouteLockUntilRef = gPin.__pipBuiltinRouteLockUntilRef || { current: 0 };
          gPin.__pipBuiltinRouteLockUntilRef.current = Date.now() + 6500;
          gPin.__inAppPiPExplicitToggleRouteRef =
            gPin.__inAppPiPExplicitToggleRouteRef || { current: null };
          gPin.__inAppPiPExplicitToggleRouteRef.current = videoRouteNorm;
        } catch {}
      } else {
        setUserSelectedCallAudioRoute(null);
      }
      persistVideoInAppPiPAudioRoute(videoRouteNorm, { mapForEnterVideoUi: false });
      try {
        const gVideoUi = global as any;
        gVideoUi.__currentCallPiPParamsRef = gVideoUi.__currentCallPiPParamsRef || { current: null };
        const existingVideo = gVideoUi.__currentCallPiPParamsRef.current;
        if (existingVideo && typeof existingVideo === 'object') {
          existingVideo.audioOutputRoute = videoRouteNorm;
        }
        gVideoUi.__lastAppliedCallAudioRouteRef = { current: videoRouteNorm };
        notifyInAppPiPAudioRouteUi(videoRouteNorm);
      } catch {}
      if (Platform.OS === 'android') {
        void probeNativeCallAudioRoutes().then((probe) => {
          mergeNativeProbeIntoGlobal(probe);
        });
      }
      try {
        const gVideo = global as any;
        gVideo.__lastInAppPipAudioReapplyAtRef = gVideo.__lastInAppPipAudioReapplyAtRef || { current: 0 };
        const nowVideo = Date.now();
        if (nowVideo - Number(gVideo.__lastInAppPipAudioReapplyAtRef.current || 0) > 1200) {
          gVideo.__lastInAppPipAudioReapplyAtRef.current = nowVideo;
          scheduleInAppPiPAudioTransitionReapply('from_video', {
            media: 'video',
            skipInCallRestart: true,
            honorUserRoute: true,
          });
        }
      } catch {
        scheduleInAppPiPAudioTransitionReapply('from_video', {
          media: 'video',
          skipInCallRestart: true,
          honorUserRoute: true,
        });
      }
    }

    if (Platform.OS === 'android') {
      void probeNativeCallAudioRoutes()
        .then((probe) => {
          mergeNativeProbeIntoGlobal(probe);
          const externalRoute = resolvePiPExternalAudioRoute(p.audioOutputRoute);
          if (!externalRoute) return;
          if (
            externalRoute === 'BLUETOOTH' &&
            (!probe.available.includes('BLUETOOTH') || !isBluetoothHeadsetActiveForCall())
          ) {
            clearNativeProbeBluetoothRoute();
            return;
          }
          if (
            externalRoute === 'WIRED_HEADSET' &&
            !probe.available.includes('WIRED_HEADSET')
          ) {
            clearNativeProbeWiredHeadsetRoute();
            return;
          }
          setUserSelectedCallAudioRoute(externalRoute);
          setPersistedCallAudioRoute(externalRoute);
          try {
            const gAudio = global as any;
            gAudio.__currentCallPiPParamsRef = gAudio.__currentCallPiPParamsRef || { current: null };
            const params = gAudio.__currentCallPiPParamsRef.current;
            if (params && typeof params === 'object') {
              params.audioOutputRoute = externalRoute;
            }
            gAudio.__lastAppliedCallAudioRouteRef = { current: externalRoute };
            gAudio.__onInAppPiPAudioRouteChanged?.(externalRoute);
            gAudio.__pipUpdateStateRef?.current?.({ audioOutputRoute: externalRoute });
          } catch {}
          try {
            const gOrch = global as any;
            gOrch.__lastInAppPipExternalOrchestratorAtRef =
              gOrch.__lastInAppPipExternalOrchestratorAtRef || { current: 0 };
            const nowExt = Date.now();
            if (nowExt - Number(gOrch.__lastInAppPipExternalOrchestratorAtRef.current || 0) > 600) {
              gOrch.__lastInAppPipExternalOrchestratorAtRef.current = nowExt;
              scheduleInAppPiPAudioTransitionReapply(fromAudioOnlyUi ? 'from_audio' : 'from_video', {
                media: fromAudioOnlyUi ? 'audio' : 'video',
                skipInCallRestart: true,
                honorUserRoute: true,
              });
            }
          } catch {}
        })
        .catch(() => {});
    }

    // КРИТИЧНО: Ставим флаг PiP синхронно
    try {
      (global as any).__pipForceHiddenRef = (global as any).__pipForceHiddenRef || { current: false };
      (global as any).__pipForceHiddenRef.current = false;
      (global as any).__pipVisibleRef = (global as any).__pipVisibleRef || { current: false };
      (global as any).__pipVisibleRef.current = true;
      if (Platform.OS === 'android') {
        NativeModules.LiviAppModule?.setInAppPiPVisibleForSystemPiP?.(true);
      }
      refreshSystemPiPLeaveContextSnapshot();
    } catch {}

    let remoteStreamForPiP = p.remoteStream;
    const sessionEarly = (global as any).__webrtcSessionRef?.current;
    const placeholderOnlyEarly = shouldUsePipPlaceholderOnly({
      localCamOn: p.localCamOn,
      remoteCamOn: p.remoteCamOn,
      remoteStream: p.remoteStream,
    });
    try {
      const session = sessionEarly;
      if (
        fromAudioOnlyUi &&
        !placeholderOnlyEarly &&
        session &&
        typeof (session as any).ensureRemoteVideoForPiP === 'function'
      ) {
        (session as any).ensureRemoteVideoForPiP();
      }
      const streamFromSession =
        session && typeof (session as any).getRemoteStream === 'function'
          ? (session as any).getRemoteStream()
          : null;
      if (streamFromSession) {
        remoteStreamForPiP = streamFromSession;
      }
    } catch (_) {}
    
    callIdRef.current = p.callId || null;
    roomIdRef.current = p.roomId || null;
    setCallId(p.callId);
    setRoomId(p.roomId);
    // Если показываем PiP — это нормальный режим, оверлей не должен быть подавлен.
    // suppressOverlayForReturn нужен только для краткого окна возврата из системного PiP.
    setSuppressOverlayForReturn(false);
    if (Platform.OS === 'android' && p.callId && p.roomId) {
      try {
        const Livi = NativeModules.LiviAppModule;
        if (Livi?.setPiPEndCallParams) Livi.setPiPEndCallParams(p.callId, p.roomId);
      } catch (_) {}
    }
    const pipParamsRef = (global as any).__currentCallPiPParamsRef?.current;
    const resolvedPartnerName = pickNonEmptyPiPString(
      p.partnerName,
      pipParamsRef?.partnerName,
      partnerNameRef.current,
    );
    if (resolvedPartnerName) {
      setPartnerName(resolvedPartnerName);
    }
    const resolvedPartnerAvatar = pickNonEmptyPiPString(
      p.partnerAvatarUrl,
      pipParamsRef?.partnerAvatarUrl,
      partnerAvatarUrlRef.current,
    );
    if (resolvedPartnerAvatar) {
      setPartnerAvatarUrl(resolvedPartnerAvatar);
    }
    if (p.localStream !== undefined) localStreamRef.current = p.localStream ?? null;
    if (p.remoteStream !== undefined || remoteStreamForPiP) {
      remoteStreamRef.current = remoteStreamForPiP ?? null;
      setRemoteStreamVersion((v) => v + 1);
    }
    // При deferVisible (обычно Android Back → навигация назад) можно включать видео сразу:
    // VideoCall уже уходит, поэтому риска "двух RTCView на один stream" практически нет,
    // и PiP появляется сразу с видео собеседника (без мигания плейсхолдера).
    if (Platform.OS === 'android' && p.deferVisible) {
      try {
        if (allowVideoRenderTimeoutRef.current) {
          clearTimeout(allowVideoRenderTimeoutRef.current);
          allowVideoRenderTimeoutRef.current = null;
        }
      } catch {}
      if (
        shouldAllowRtcVideoRenderInInAppPiP({
          fromAudioOnlyUi,
          localCamOn: p.localCamOn,
          remoteCamOn: p.remoteCamOn,
          remoteStream: remoteStreamForPiP,
          localStream: p.localStream,
        })
      ) {
        setAllowVideoRender(true);
      } else {
        setAllowVideoRender(false);
      }
    }
    // localCamOn — источник истины для восстановления после PiP.
    // Если явно не передали, пытаемся вычислить из localStream (best-effort).
    if (typeof p.localCamOn === 'boolean') {
      setLocalCamOn(p.localCamOn);
      localCamOnRef.current = p.localCamOn;
    } else {
      try {
        const t = (p.localStream as any)?.getVideoTracks?.()?.[0];
        const enabled = t?.enabled;
        if (typeof enabled === 'boolean') {
          setLocalCamOn(enabled);
          localCamOnRef.current = enabled;
        }
      } catch {}
    }
    // КРИТИЧНО: remoteCamOn берём из сессии, если есть — она обновляется синхронно при cam-toggle;
    // иначе при быстром выходе в PiP после выключения камеры партнёра React state ещё не обновился и заглушка «Отошел» не показывалась.
    try {
      const session = (global as any).__webrtcSessionRef?.current;
      if (session && typeof (session as any).getRemoteCamEnabled === 'function') {
        const remoteCam = (session as any).getRemoteCamEnabled();
        setRemoteCamOn(remoteCam);
        remoteCamOnRef.current = remoteCam;
      } else if (typeof p.remoteCamOn === 'boolean') {
        setRemoteCamOn(p.remoteCamOn);
        remoteCamOnRef.current = p.remoteCamOn;
      }
    } catch (_) {
      if (typeof p.remoteCamOn === 'boolean') {
        setRemoteCamOn(p.remoteCamOn);
        remoteCamOnRef.current = p.remoteCamOn;
      }
    }
    setIsMuted(
      typeof p.muteLocal === 'boolean' ? p.muteLocal : resolvePiPLocalMutedState(),
    );
    if (typeof p.muteRemote === 'boolean') setIsRemoteMuted(!!p.muteRemote);
    // Не затираем navParams undefined-ом: это ломает returnToCall (нечем восстановить экран звонка).
    setLastNavParams((prev: any) => (p.navParams !== undefined ? p.navParams : prev));

    // By default show immediately. For Android Back we now also reveal PiP immediately,
    // so the overlay appears without an extra frame of waiting.
    if (p.deferVisible) {
      if (Platform.OS === 'android') {
        if (Platform.OS === 'android' && remoteStreamRef.current) {
          try {
            if (allowVideoRenderTimeoutRef.current) {
              clearTimeout(allowVideoRenderTimeoutRef.current);
              allowVideoRenderTimeoutRef.current = null;
            }
          } catch {}
          if (
            shouldAllowRtcVideoRenderInInAppPiP({
              fromAudioOnlyUi,
              localCamOn: localCamOnRef.current,
              remoteCamOn: remoteCamOnRef.current,
              remoteStream: remoteStreamRef.current,
              localStream: localStreamRef.current,
            })
          ) {
            setAllowVideoRender(true);
          } else {
            setAllowVideoRender(false);
          }
        }
        setVisible(true);
      } else {
        try {
          const g = global as any;
          g.__pipDeferVisiblePendingRef = g.__pipDeferVisiblePendingRef || { current: false };
          g.__pipDeferVisiblePendingRef.current = true;
        } catch {}
        if (deferVisibleRafRef.current != null) {
          cancelAnimationFrame(deferVisibleRafRef.current);
        }
        deferVisibleRafRef.current = requestAnimationFrame(() => {
          deferVisibleRafRef.current = null;
          if (Platform.OS === 'android' && remoteStreamRef.current) {
            try {
              if (allowVideoRenderTimeoutRef.current) {
                clearTimeout(allowVideoRenderTimeoutRef.current);
                allowVideoRenderTimeoutRef.current = null;
              }
            } catch {}
            if (
              shouldAllowRtcVideoRenderInInAppPiP({
                fromAudioOnlyUi,
                localCamOn: localCamOnRef.current,
                remoteCamOn: remoteCamOnRef.current,
                remoteStream: remoteStreamRef.current,
                localStream: localStreamRef.current,
              })
            ) {
              setAllowVideoRender(true);
            } else {
              setAllowVideoRender(false);
            }
          }
          setVisible(true);
        });
      }
    } else {
      setVisible(true);
    }
    if (Platform.OS === 'android' && p.callId && p.roomId) {
      startActiveCallNotification(p.partnerName);
      // Back → in-app: leave-hint остаётся armed, чтобы Home штатно дал system PiP.
      try {
        syncAndroidLeaveHintForOngoingCall();
      } catch (_) {}
    }
  }, []);

  const hidePiP = useCallback(() => {
    if (deferVisibleRafRef.current != null) {
      try {
        cancelAnimationFrame(deferVisibleRafRef.current);
      } catch {}
      deferVisibleRafRef.current = null;
    }
    clearInAppPiPSystemSuspendFlags();
    try {
      const g = global as any;
      g.__pipForceHiddenRef = g.__pipForceHiddenRef || { current: false };
      g.__pipForceHiddenRef.current = true;
      g.__pipDeferVisiblePendingRef = g.__pipDeferVisiblePendingRef || { current: false };
      g.__pipDeferVisiblePendingRef.current = false;
      g.__pipVisibleRef = g.__pipVisibleRef || { current: false };
      g.__pipVisibleRef.current = false;
      g.__pipInSystemModeRef = g.__pipInSystemModeRef || { current: false };
      g.__pipInSystemModeRef.current = false;
      if (Platform.OS === 'android') {
        NativeModules.LiviAppModule?.setInAppPiPVisibleForSystemPiP?.(false);
      }
      setPipInAppRtcFromAudioOnlySticky(false);
    } catch {}
    setVisible(false);
    setPendingSystemPiP(false);
    setSystemPiPCaptureActive(false);
    setSystemPiPCaptureRequestId(0);
    try {
      clearSystemPiPSessionAudioOrigin();
    } catch {}
  }, []);

  useEffect(() => {
    const g = global as any;
    g.__pipReturnToCallInFlightRef = g.__pipReturnToCallInFlightRef || { current: false };
    g.__pipReturnToCallInFlightRef.current = returnToCallInFlightRef.current;
    return () => {
      try {
        if ((global as any).__pipReturnToCallInFlightRef) {
          (global as any).__pipReturnToCallInFlightRef.current = false;
        }
      } catch (_) {}
    };
  }, []);

  /** System PiP: peer включил камеру уже в PiP → RTC (в т.ч. после enter с audio UI). */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!inSystemPiPMode && !pendingSystemPiP && !systemPiPCaptureActive) return;
    try {
      const g = global as any;
      const now = Date.now();
      const inSys =
        inSystemPiPMode === true ||
        g.__pipInSystemModeRef?.current === true ||
        pendingSystemPiP === true;
      // Block/returning только вне PiP — иначе mid-PiP peer video не поднимется.
      if (!inSys) {
        if (now < Number(g.__returningFromSystemPiPUntilRef?.current || 0)) return;
        if (now < Number(g.__blockSystemPiPCaptureHostUntilRef?.current || 0)) return;
        return;
      }
    } catch (_) {}
    let sessionRemoteStream: unknown = null;
    let sessionRemoteCam = false;
    let sessionEnded = false;
    try {
      const session = (global as any).__webrtcSessionRef?.current;
      if (!session) {
        sessionEnded = true;
      } else {
        sessionRemoteStream =
          typeof session?.getRemoteStream === 'function' ? session.getRemoteStream() : null;
        if (typeof session?.getRemoteCamEnabled === 'function') {
          sessionRemoteCam = !!session.getRemoteCamEnabled();
        }
      }
    } catch (_) {}
    const hasLive =
      mediaStreamHasLiveVideo(sessionRemoteStream) ||
      mediaStreamHasLiveVideo(remoteStreamRef.current);
    const peerLive = hasLive || remoteCamOn === true || sessionRemoteCam;
    try {
      // Снимаем native logo когда peer cam on / live — CaptureHost покажет RTC или тихий fill.
      if (peerLive) {
        forceAndroidSystemPiPPeerVideoVisible();
      } else {
        NativeModules.LiviAppModule?.setSystemPiPCapturePlaceholderOnly?.(true);
      }
    } catch (_) {}
    if (!peerLive) {
      setAllowVideoRender((prev) => (prev === false ? prev : false));
      return;
    }
    setAllowVideoRender((prev) => (prev === true ? prev : true));
    setPendingSystemPiP((prev) => (prev ? prev : true));
    if (!sessionEnded && !hasLive && (remoteCamOn === true || sessionRemoteCam)) {
      try {
        const session = (global as any).__webrtcSessionRef?.current;
        if (session && typeof session.ensureRemoteVideoForSystemPiPCapture === 'function') {
          session.ensureRemoteVideoForSystemPiPCapture();
        }
      } catch (_) {}
    }
    // Audio/logo enter → peer video: CaptureHost обязателен (audio UI не рисует RemoteVideo).
    // Полный video UI на VideoCall → compact RemoteVideo, без dual RTC.
    const onVideoCallRoute = readRootCurrentRouteName() === 'VideoCall';
    const audioUi = isInAudioOnlyCallUi();
    let stayOnVideo = false;
    try {
      stayOnVideo = (global as any).__stayOnVideoCallUiRef?.current === true;
    } catch (_) {}
    const audioOrigin = isSystemPiPLeaveAudioOrigin() || isSystemPiPSessionAudioOrigin();
    const videoUiOwnsCapture =
      onVideoCallRoute && stayOnVideo && !audioUi && !audioOrigin && hasLive;
    if (!videoUiOwnsCapture) {
      setSystemPiPCaptureActive((prev) => (prev ? prev : true));
      if (hasLive) {
        setSystemPiPCaptureRequestId((id) => id + 1);
      }
    } else {
      setSystemPiPCaptureActive((prev) => (prev ? false : prev));
    }
  }, [
    inSystemPiPMode,
    pendingSystemPiP,
    systemPiPCaptureActive,
    remoteCamOn,
    remoteStreamVersion,
  ]);

  /** In-app / system PiP без VideoCall: снятие BT/провода → разговорный или громкий (video-path). */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!visible && !inSystemPiPMode) return;

    const parseList = (raw: unknown): string[] => {
      if (Array.isArray(raw)) return raw.map((s) => String(s));
      if (typeof raw === 'string') {
        try {
          const j = JSON.parse(raw);
          if (Array.isArray(j)) return j.map((s) => String(s));
        } catch {}
      }
      return [];
    };

    let unplugConfirmTimer: ReturnType<typeof setTimeout> | null = null;

    const handler = (data: { availableAudioDeviceList?: unknown; selectedAudioDevice?: unknown }) => {
      try {
        const available = parseList(data?.availableAudioDeviceList);
        const selected = normalizeInCallRoute(String(data?.selectedAudioDevice || ''));
        const g = global as any;
        const prevRaw = g.__inCallAvailableAudioRoutesRef?.current;
        const prev = Array.isArray(prevRaw) ? prevRaw.map((s: unknown) => String(s)) : [];
        g.__inCallAvailableAudioRoutesRef = g.__inCallAvailableAudioRoutesRef || { current: [] };
        g.__inCallAvailableAudioRoutesRef.current = available;
        if (!available.includes('BLUETOOTH')) {
          setCallBluetoothHeadsetConnectedCache(false);
        }

        const plaqueRouteSync = normalizeInCallRoute(
          String(g.__currentCallPiPParamsRef?.current?.audioOutputRoute || ''),
        );
        if (
          g.__pipVisibleRef?.current === true &&
          (selected === 'EARPIECE' ||
            selected === 'SPEAKER_PHONE' ||
            (plaqueRouteSync === 'BLUETOOTH' && !available.includes('BLUETOOTH')) ||
            (plaqueRouteSync === 'WIRED_HEADSET' && !available.includes('WIRED_HEADSET')))
        ) {
          const userOnPlaque = readUserSelectedCallAudioRoute();
          const paramsStillShowExternal =
            plaqueRouteSync === 'BLUETOOTH' ||
            plaqueRouteSync === 'WIRED_HEADSET' ||
            userOnPlaque === 'BLUETOOTH' ||
            userOnPlaque === 'WIRED_HEADSET';
          if (paramsStillShowExternal) {
            const uiRoute =
              selected === 'EARPIECE' || selected === 'SPEAKER_PHONE'
                ? selected
                : plaqueRouteSync === 'BLUETOOTH' && !available.includes('BLUETOOTH')
                  ? 'EARPIECE'
                  : plaqueRouteSync === 'WIRED_HEADSET' && !available.includes('WIRED_HEADSET')
                    ? 'EARPIECE'
                    : selected || 'EARPIECE';
            g.__inCallSelectedAudioRouteRef = { current: uiRoute };
            setUserSelectedCallAudioRoute(uiRoute);
            setPersistedCallAudioRoute(uiRoute);
            if (plaqueRouteSync === 'BLUETOOTH' && !available.includes('BLUETOOTH')) {
              clearNativeProbeBluetoothRoute();
            }
            if (plaqueRouteSync === 'WIRED_HEADSET' && !available.includes('WIRED_HEADSET')) {
              clearNativeProbeWiredHeadsetRoute();
            }
            try {
              g.__userSelectedExternalCallAudioRouteRef = { current: null };
            } catch {}
            const media =
              g.__pipInAppRtcFromAudioOnlyRef?.current === true || isInAudioOnlyCallUi()
                ? 'audio'
                : resolveActiveCallInCallMedia();
            void applyCallAudioOutputRouteNow(uiRoute, { media, forceBuiltIn: true });
            notifyInAppPiPAudioRouteUi(uiRoute);
          }
        }

        const gainedBt = available.includes('BLUETOOTH') && !prev.includes('BLUETOOTH');
        const gainedWired = available.includes('WIRED_HEADSET') && !prev.includes('WIRED_HEADSET');
        if (selected && isExternalHeadsetRoute(selected) && available.includes(selected)) {
          setUserSelectedCallAudioRoute(selected);
          setPersistedCallAudioRoute(selected);
          if (selected === 'BLUETOOTH' || selected === 'WIRED_HEADSET') {
            markUserSelectedExternalCallAudioRoute(selected);
          }
          const params = g.__currentCallPiPParamsRef?.current;
          if (params && typeof params === 'object') {
            params.audioOutputRoute = selected;
          }
          g.__inCallSelectedAudioRouteRef = { current: selected };
          const media =
            g.__pipInAppRtcFromAudioOnlyRef?.current === true || isInAudioOnlyCallUi()
              ? 'audio'
              : resolveActiveCallInCallMedia();
          void applyCallAudioOutputRouteNow(selected, { media, forceBuiltIn: false });
          notifyInAppPiPAudioRouteUi(selected);
        } else if (gainedBt || gainedWired) {
          if (isInAppPiPManualRouteLockActive() || isInAppPiPExplicitBuiltinRouteChoiceActive()) {
            return;
          }
          clearBuiltinPinForExternalHeadsetConnect();
          clearCallAudioRouteUiLock();
          const route =
            gainedWired && available.includes('WIRED_HEADSET') ? 'WIRED_HEADSET' : 'BLUETOOTH';
          if (available.includes(route)) {
            void applyInAppPiPHeadsetConnectRoute(
              route as 'BLUETOOTH' | 'WIRED_HEADSET',
              gainedBt ? 'pip_device_changed_gained_bt' : 'pip_device_changed_gained_wired',
            );
          }
        } else if (
          shouldAutoBtConnectFromDeviceList(available, prev) &&
          available.includes('BLUETOOTH')
        ) {
          if (isInAppPiPManualRouteLockActive() || isInAppPiPExplicitBuiltinRouteChoiceActive()) {
            return;
          }
          void applyInAppPiPHeadsetConnectRoute('BLUETOOTH', 'pip_device_changed_bt_present');
        }

        const paramsRoute = normalizeInCallRoute(
          String(g.__currentCallPiPParamsRef?.current?.audioOutputRoute || ''),
        );
        const userSel = readUserSelectedCallAudioRoute();
        const btAbsent = !available.includes('BLUETOOTH');
        const wiredAbsent = !available.includes('WIRED_HEADSET');
        const lostBt = prev.includes('BLUETOOTH') && btAbsent;
        const lostWired = prev.includes('WIRED_HEADSET') && wiredAbsent;
        const routingOnBt =
          paramsRoute === 'BLUETOOTH' ||
          userSel === 'BLUETOOTH' ||
          selected === 'BLUETOOTH' ||
          readUserSelectedExternalCallAudioRoute() === 'BLUETOOTH';
        const routingOnWired =
          paramsRoute === 'WIRED_HEADSET' ||
          userSel === 'WIRED_HEADSET' ||
          selected === 'WIRED_HEADSET' ||
          readUserSelectedExternalCallAudioRoute() === 'WIRED_HEADSET';
        const needBtUnplug = btAbsent && (lostBt || routingOnBt);
        const needWiredUnplug = wiredAbsent && (lostWired || routingOnWired);
        if (
          needBtUnplug &&
          routingOnBt &&
          !lostBt &&
          isBluetoothHeadsetActiveForCall()
        ) {
          return;
        }
        if (!needBtUnplug && !needWiredUnplug) return;
        if (isInAppPiPManualRouteLockActive()) return;

        const resolveUnplugFallbackRoute = (): InCallAudioRoute => {
          if (available.includes('WIRED_HEADSET') && needBtUnplug && !needWiredUnplug) {
            return 'WIRED_HEADSET';
          }
          const fromAudioPiP =
            g.__pipInAppRtcFromAudioOnlyRef?.current === true || isInAudioOnlyCallUi();
          if (fromAudioPiP && !preferSpeakerAfterHeadsetDisconnect()) {
            return 'EARPIECE';
          }
          return resolveCallRouteAfterHeadsetDisconnect();
        };

        const applyUnplugUiNow = (route: InCallAudioRoute) => {
          if (needBtUnplug) clearNativeProbeBluetoothRoute();
          if (needWiredUnplug) clearNativeProbeWiredHeadsetRoute();
          try {
            g.__userSelectedExternalCallAudioRouteRef = { current: null };
          } catch {}
          setUserSelectedCallAudioRoute(route);
          setPersistedCallAudioRoute(route);
          g.__inCallSelectedAudioRouteRef = { current: route };
          const media =
            g.__pipInAppRtcFromAudioOnlyRef?.current === true || isInAudioOnlyCallUi()
              ? 'audio'
              : resolveActiveCallInCallMedia();
          void applyCallAudioOutputRouteNow(route, { media, forceBuiltIn: true });
          notifyInAppPiPAudioRouteUi(route);
        };

        let previewRoute = resolveUnplugFallbackRoute();
        if (previewRoute === 'SPEAKER_PHONE' && preferSpeakerAfterHeadsetDisconnect()) {
          rememberVideoUiSpeakerAfterHeadsetDisconnect();
        } else if (previewRoute === 'EARPIECE') {
          armCallAudioRouteUiLock('EARPIECE');
        }
        applyUnplugUiNow(previewRoute);

        if (unplugConfirmTimer) clearTimeout(unplugConfirmTimer);
        unplugConfirmTimer = setTimeout(() => {
          unplugConfirmTimer = null;
          try {
            const latestList = readAvailableAudioDeviceListFromGlobal();
            const stillNeedBt =
              needBtUnplug && !latestList.includes('BLUETOOTH');
            const stillNeedWired =
              needWiredUnplug && !latestList.includes('WIRED_HEADSET');
            if (!stillNeedBt && !stillNeedWired) return;
            if (stillNeedBt && isBluetoothHeadsetActiveForCall()) return;

            let route = resolveUnplugFallbackRoute();
            if (route === 'SPEAKER_PHONE' && preferSpeakerAfterHeadsetDisconnect()) {
              rememberVideoUiSpeakerAfterHeadsetDisconnect();
            } else if (route === 'EARPIECE') {
              armCallAudioRouteUiLock('EARPIECE');
            }

            setUserSelectedCallAudioRoute(route);
            setPersistedCallAudioRoute(route);
            g.__inCallSelectedAudioRouteRef = { current: route };
            notifyInAppPiPAudioRouteUi(route);
            scheduleReapplyPersistedCallAudioRoute('in_app_pip_headset_unplug', {
              media: resolveReapplyMediaInCallContext(),
              delaysMs: [0],
              skipInCallRestart: true,
              honorUserRoute: true,
            });
          } catch (_) {}
        }, 650);
      } catch (_) {}
    };

    const sub = DeviceEventEmitter.addListener('onAudioDeviceChanged', handler);
    return () => {
      if (unplugConfirmTimer) clearTimeout(unplugConfirmTimer);
      try {
        sub.remove();
      } catch (_) {}
    };
  }, [visible, inSystemPiPMode]);

  const syncSessionPiPState = useCallback((nextInPiP: boolean, reason: string): boolean => {
    try {
      const g = global as any;
      const session = g.__webrtcSessionRef?.current;
      const paramsRef = g.__currentCallPiPParamsRef?.current;
      const lastCtx = g.__pipLastContextRef?.current;
      const sessionRoomId =
        session && typeof (session as any).getRoomId === 'function'
          ? (session as any).getRoomId()
          : null;
      const effectiveRoomId = roomId || paramsRef?.roomId || lastCtx?.roomId || sessionRoomId || null;
      const key = `${nextInPiP ? 'enter' : 'exit'}:${String(effectiveRoomId || 'none')}`;
      const now = Date.now();
      if (pipSessionSyncRef.current.key === key && now - pipSessionSyncRef.current.at < 1500) {
        logger.debug('[PiPContext] Skip duplicate PiP session sync', { nextInPiP, reason, roomId: effectiveRoomId });
        return false;
      }
      pipSessionSyncRef.current = { key, at: now };

      const methodName = nextInPiP ? 'enterPiP' : 'exitPiP';
      const method = session?.[methodName];
      if (typeof method === 'function') {
        method.call(session);
        return true;
      }

      if (!effectiveRoomId) {
        return false;
      }

      socket.emit('pip:state', {
        inPiP: nextInPiP,
        from: socket.id,
        roomId: effectiveRoomId,
      });
      return true;
    } catch (e) {
      logger.warn('[PiPContext] Failed to sync PiP session state', { nextInPiP, reason, error: e });
      return false;
    }
  }, [roomId]);

  // __pipLastContextRef — последний валидный callId/roomId/lastNavParams. Нужен, когда returnToCall вызывается
  // из App по SystemPiPExpanded: на части устройств state (callId, roomId) в этот момент ещё null (системный PiP
  // мог включиться без вызова showPiP). returnToCall использует effectiveCallId = callId || paramsRef?.callId || lastCtx?.callId.
  useEffect(() => {
    try {
      const g = (global as any);
      g.__pipLastContextRef = g.__pipLastContextRef || { current: null };
      if (callId || roomId || lastNavParams) {
        g.__pipLastContextRef.current = {
          callId: callId || g.__pipLastContextRef.current?.callId || null,
          roomId: roomId || g.__pipLastContextRef.current?.roomId || null,
          navParams: lastNavParams ?? g.__pipLastContextRef.current?.navParams,
        };
      }
    } catch {}
  }, [callId, roomId, lastNavParams]);

  useEffect(() => {
    if (!visible) return;
    setIsMuted(resolvePiPLocalMutedState());
  }, [visible, callId, roomId]);

  // AboutToEnterSystemPiP: системный PiP с заглушкой LiVi (без RTC/capture), с любого экрана активного звонка.
  useEffect(() => {
    if (Platform.OS !== 'android') return () => {};
    const emitter = new NativeEventEmitter(NativeModules.LiviAppModule);
    const sub = emitter.addListener('AboutToEnterSystemPiP', (payload: { width?: number; height?: number; traceId?: string } | null) => {
      const g = (global as any);
      const traceId = payload?.traceId ? String(payload.traceId) : `hp_js_${Date.now()}`;
      setActiveHomePiPTraceId(traceId);
      beginHomePiPOutcomeWatch(traceId);
      logHomePiPTrace('js_about_to_enter', {
        traceId,
        decorW: payload?.width ?? 0,
        decorH: payload?.height ?? 0,
      });
      // Не входить в PiP без нажатия пользователя: при завершении звонка (переход на Home) onUserLeaveHint может сработать раньше нативного флага.
      if (g.__endingCallInProgressRef?.current === true) {
        return;
      }
      if (g.__videoCallActiveRef?.current === false) {
        return;
      }
      // После expand/exit: late AboutToEnter не должен ставить enter_preserve / CaptureHost.
      // Back пока app active → in-app PiP. Home/фон (inactive|background) → system PiP.
      try {
        const now = Date.now();
        const leavingByBack = g.__leavingVideoCallByBackRef?.current === true;
        const leavingByHome = g.__leavingVideoCallByHomeRef?.current === true;
        const appLeavingToBackground =
          AppState.currentState === 'background' || AppState.currentState === 'inactive';
        if (leavingByBack && !leavingByHome && !appLeavingToBackground) {
          logger.info('[PiPContext] AboutToEnterSystemPiP skipped — Back uses in-app PiP');
          logHomePiPTrace('js_about_to_enter_skip', { traceId, reason: 'leaving_by_back_in_app' });
          try {
            NativeModules.LiviAppModule?.cancelPendingSystemPiPEnter?.();
            cancelScheduledCallAudioRouteReappliesMatching([
              'audio_home_preserve',
              'audio_home_loud_speaker',
              'system_pip_enter_',
            ]);
          } catch (_) {}
          return;
        }
        if (leavingByHome || appLeavingToBackground) {
          g.__leavingVideoCallByBackRef = g.__leavingVideoCallByBackRef || { current: false };
          g.__leavingVideoCallByBackRef.current = false;
          g.__returningFromSystemPiPUntilRef = g.__returningFromSystemPiPUntilRef || { current: 0 };
          g.__returningFromSystemPiPUntilRef.current = 0;
          g.__blockSystemPiPCaptureHostUntilRef =
            g.__blockSystemPiPCaptureHostUntilRef || { current: 0 };
          g.__blockSystemPiPCaptureHostUntilRef.current = 0;
          g.__disableSystemPiPUntilRef = g.__disableSystemPiPUntilRef || { current: 0 };
          g.__disableSystemPiPUntilRef.current = 0;
        } else if (
          now < Number(g.__returningFromSystemPiPUntilRef?.current || 0) ||
          now < Number(g.__blockSystemPiPCaptureHostUntilRef?.current || 0) ||
          now < Number(g.__disableSystemPiPUntilRef?.current || 0) ||
          g.__pipReturnToCallInFlightRef?.current === true
        ) {
          logger.info('[PiPContext] AboutToEnterSystemPiP skipped — returning from system PiP');
          logHomePiPTrace('js_about_to_enter_skip', { traceId, reason: 'returning_from_system_pip' });
          try {
            NativeModules.LiviAppModule?.cancelPendingSystemPiPEnter?.();
            cancelScheduledCallAudioRouteReappliesMatching([
              'audio_home_preserve',
              'audio_home_loud_speaker',
              'system_pip_enter_',
            ]);
          } catch (_) {}
          return;
        }
      } catch (_) {}
      if (!isAndroidActiveCallEligibleForLeaveHint()) {
        logger.info('[PiPContext] AboutToEnterSystemPiP skipped — not on active VideoCall');
        logHomePiPTrace('js_about_to_enter_skip', { traceId, reason: 'not_on_video_call' });
        return;
      }
      const session = g.__webrtcSessionRef?.current;
      if (session && typeof (session as any).isEnded === 'function' && (session as any).isEnded()) {
        return;
      }

      try {
        captureSystemPiPReturnMediaSnapshot();
      } catch (_) {}

      try {
        g.__leavingVideoCallByHomeRef = g.__leavingVideoCallByHomeRef || { current: false };
        g.__leavingVideoCallByHomeRef.current = true;
        g.__systemPiPEntryInProgressUntilRef = g.__systemPiPEntryInProgressUntilRef || { current: 0 };
        g.__systemPiPEntryInProgressUntilRef.current = Date.now() + 6000;
      } catch (_) {}

      let paramsEarly = g.__currentCallPiPParamsRef?.current;
      if (!paramsEarly && session) {
        const cid = typeof (session as any).getCallId === 'function' ? (session as any).getCallId() : null;
        const rid = typeof (session as any).getRoomId === 'function' ? (session as any).getRoomId() : null;
        if (cid || rid) {
          paramsEarly = {
            localCamOn:
              typeof (session as any).getIsCamOn === 'function' ? (session as any).getIsCamOn() : false,
            remoteCamOn:
              typeof (session as any).getRemoteCamEnabled === 'function'
                ? (session as any).getRemoteCamEnabled()
                : false,
            remoteStream:
              typeof (session as any).getRemoteStream === 'function'
                ? (session as any).getRemoteStream()
                : null,
          };
        }
      }
      const remoteEarly =
        session && typeof (session as any).getRemoteStream === 'function'
          ? (session as any).getRemoteStream()
          : null;
      const localCamEarly =
        paramsEarly?.localCamOn ??
        (session && typeof (session as any).getIsCamOn === 'function'
          ? (session as any).getIsCamOn()
          : false);
      const remoteCamEarly =
        paramsEarly?.remoteCamOn ??
        (session && typeof (session as any).getRemoteCamEnabled === 'function'
          ? (session as any).getRemoteCamEnabled()
          : false);
      if (localCamEarly || remoteCamEarly || ongoingCallPrefersVideoMedia()) {
        markDirectCallVideoMediaActive();
      }
      const localEarly =
        paramsEarly?.localStream ??
        (session && typeof (session as any).getLocalStream === 'function'
          ? (session as any).getLocalStream()
          : null);
      if (
        !shouldUseSystemPiPControlsCaptureOnly() &&
        shouldUsePipPlaceholderOnly({
          localCamOn: localCamEarly,
          remoteCamOn: remoteCamEarly,
          remoteStream: paramsEarly?.remoteStream ?? remoteEarly ?? null,
          localStream: localEarly,
        })
      ) {
        logger.info('[PiPContext] AboutToEnterSystemPiP skipped — audio call uses status notification');
        logHomePiPTrace('js_about_to_enter_skip', { traceId, reason: 'audio_placeholder' });
        try {
          armCallAudioPreservePriority(6000);
          g.__systemPiPEntryInProgressUntilRef = g.__systemPiPEntryInProgressUntilRef || { current: 0 };
          g.__systemPiPEntryInProgressUntilRef.current = Date.now() + 6000;
          if (resolveActiveCallInCallMedia() === 'audio') {
            if (isInAppPiPContextIncludingSuspended()) {
              prepareSystemPiPEnterCallAudioRoute();
            } else {
              const pipRoute = readInAppPiPAudioOutputRoute();
              const external = readActiveExternalCallAudioRoute(pipRoute);
              if (isExternalHeadsetRoute(pipRoute) || external || !shouldApplyHomeLoudSpeakerPin()) {
                scheduleReapplyPersistedCallAudioRoute('in_app_pip_preserve_headset', {
                  media: 'audio',
                  delaysMs: [0, 500, 1200],
                });
              } else {
                pinLoudSpeakerForAudioCallLeavingToBackground();
                scheduleReapplyPersistedCallAudioRoute('audio_home_loud_speaker', {
                  media: 'audio',
                  delaysMs: [0, 250, 800, 1500],
                });
              }
            }
          }
          NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false);
          NativeModules.LiviAppModule?.setSystemPiPCapturePlaceholderOnly?.(true);
          NativeModules.LiviAppModule?.cancelPendingSystemPiPEnter?.();
          g.__leavingVideoCallByHomeRef.current = false;
          refreshAndroidActiveCallNotification();
        } catch (_) {}
        return;
      }

      try {
        syncAndroidSystemPiPNativeFlags();
      } catch (_) {}

      try {
        refreshSystemPiPLeaveContextSnapshot();
      } catch (_) {}

      try {
        if (g.__pipVisibleRef?.current === true) {
          suspendInAppOverlayForSystemPiPEnter();
          logHomePiPTrace('js_soft_hide_in_app_for_system', { traceId, reason: 'before_system_capture' });
        }
      } catch (_) {}

      try {
        g.__systemPiPEntryInProgressUntilRef = g.__systemPiPEntryInProgressUntilRef || { current: 0 };
        g.__systemPiPEntryInProgressUntilRef.current = Date.now() + 4500;
      } catch (_) {}
      const stableIds = resolveStablePiPIds();
      trackReleaseEvent('pip_enter_exit', {
        phase: 'about_to_enter',
        callId: stableIds.callId,
        roomId: stableIds.roomId,
      });
      try {
        prepareSystemPiPEnterCallAudioRoute();
      } catch (_) {}

      try {
        g.__pendingSystemPiPSyncRef = g.__pendingSystemPiPSyncRef || { current: false };
        g.__pendingSystemPiPSyncRef.current = false;
        NativeModules.LiviAppModule?.setInAppPiPVisibleForSystemPiP?.(false);
      } catch (_) {}

      let params = g.__currentCallPiPParamsRef?.current;
      if (!params && session) {
        const cid = typeof (session as any).getCallId === 'function' ? (session as any).getCallId() : null;
        const rid = typeof (session as any).getRoomId === 'function' ? (session as any).getRoomId() : null;
        if (cid || rid) {
          const localCam =
            typeof (session as any).getIsCamOn === 'function' ? (session as any).getIsCamOn() : false;
          const remoteCam =
            typeof (session as any).getRemoteCamEnabled === 'function'
              ? (session as any).getRemoteCamEnabled()
              : false;
          params = {
            callId: cid || '',
            roomId: rid || '',
            partnerName: '',
            partnerAvatarUrl: undefined,
            localStream: null,
            remoteStream: null,
            localCamOn: localCam,
            remoteCamOn: remoteCam,
            navParams: undefined,
          };
        }
      }
      const remoteFromSessionForPlaceholder =
        session && typeof (session as any).getRemoteStream === 'function'
          ? (session as any).getRemoteStream()
          : null;
      const localFromSessionForPlaceholder =
        session && typeof (session as any).getLocalStream === 'function'
          ? (session as any).getLocalStream()
          : null;
      const localCamFromSession =
        session && typeof (session as any).getIsCamOn === 'function'
          ? (session as any).getIsCamOn()
          : undefined;
      const remoteCamFromSession =
        session && typeof (session as any).getRemoteCamEnabled === 'function'
          ? (session as any).getRemoteCamEnabled()
          : undefined;
      const sessionHasLiveRemoteVideo = mediaStreamHasLiveVideo(remoteFromSessionForPlaceholder);
      // Prefer session / live track over stale params after in-app PiP.
      const remoteStreamForPlaceholder = sessionHasLiveRemoteVideo
        ? remoteFromSessionForPlaceholder
        : params?.remoteStream ?? remoteFromSessionForPlaceholder ?? null;
      const localCamForPlaceholder =
        typeof localCamFromSession === 'boolean' ? localCamFromSession : !!params?.localCamOn;
      const remoteCamForPlaceholder = sessionHasLiveRemoteVideo
        ? true
        : typeof remoteCamFromSession === 'boolean'
          ? remoteCamFromSession
          : !!params?.remoteCamOn;
      // Sticky audio-origin только если реально уходим в logo-PiP.
      // Иначе peer cam on с audio UI помечался audioOrigin → вечный placeholder.
      const placeholderOnlyHome = shouldUseSystemPiPPlaceholderOnly({
        localCamOn: localCamForPlaceholder,
        remoteCamOn: remoteCamForPlaceholder,
        remoteStream: remoteStreamForPlaceholder,
        localStream: params?.localStream ?? localFromSessionForPlaceholder ?? null,
      });
      try {
        // Новый system-PiP session: origin только от текущего UI.
        // Sticky прошлого audio-leave ломал video Home (return-to-audio / pip:state=false).
        markSystemPiPSessionAudioOrigin(isInAudioOnlyCallUi());
      } catch (_) {}
      try {
        commitSystemPiPLeaveContextSnapshot({ placeholderOnly: placeholderOnlyHome });
      } catch (_) {}
      // Audio UI часто defer'ит remote video — для video system PiP подтянем track без смены UI.
      if (!placeholderOnlyHome && !sessionHasLiveRemoteVideo && remoteCamForPlaceholder) {
        try {
          if (session && typeof (session as any).ensureRemoteVideoForSystemPiPCapture === 'function') {
            (session as any).ensureRemoteVideoForSystemPiPCapture();
          }
        } catch (_) {}
      }
      logger.info('[PiPContext] AboutToEnterSystemPiP placeholder decision', {
        placeholderOnlyHome,
        audioOrigin: isSystemPiPSessionAudioOrigin(),
        leavePreferAudio: peekSystemPiPLeaveContextForReturn().preferAudioOnly,
        localCamOn: localCamForPlaceholder,
        remoteCamOn: remoteCamForPlaceholder,
        paramsRemoteCamOn: params?.remoteCamOn,
        sessionRemoteCamOn: remoteCamFromSession,
        sessionHasLiveRemoteVideo,
        hasRemoteStream: !!remoteStreamForPlaceholder,
        decorPayload: { w: payload?.width ?? 0, h: payload?.height ?? 0 },
      });
      try {
        // Keep params in sync so leave-hint / CaptureHost don't re-read stale remoteCamOn:false.
        if (params && g.__currentCallPiPParamsRef) {
          g.__currentCallPiPParamsRef.current = {
            ...params,
            localCamOn: localCamForPlaceholder,
            remoteCamOn: remoteCamForPlaceholder,
            remoteStream: remoteStreamForPlaceholder ?? params.remoteStream ?? null,
            localStream: params.localStream ?? localFromSessionForPlaceholder ?? null,
          };
          params = g.__currentCallPiPParamsRef.current;
        }
      } catch (_) {}
      try {
        NativeModules.LiviAppModule?.setSystemPiPCapturePlaceholderOnly?.(placeholderOnlyHome);
        if (!placeholderOnlyHome) {
          // Не сбрасывать pre-armed frameReady при live video — иначе leave-hint
          // снова ждёт и промахивает OEM-окно enter.
          if (sessionHasLiveRemoteVideo || remoteCamForPlaceholder) {
            NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(true);
          } else {
            NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(false);
          }
        } else {
          NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(true);
        }
      } catch (_) {}
      if (params?.callId && params?.roomId) {
        if (NativeModules.LiviAppModule?.setPiPEndCallParams) {
          try { NativeModules.LiviAppModule.setPiPEndCallParams(params.callId, params.roomId); } catch (_) {}
        }
        const remoteFromSession =
          session && typeof (session as any).getRemoteStream === 'function'
            ? (session as any).getRemoteStream()
            : null;
        const localFromSession =
          session && typeof (session as any).getLocalStream === 'function'
            ? (session as any).getLocalStream()
            : null;
        const updateFnEarly = g.__pipUpdateStateRef?.current;
        if (typeof updateFnEarly === 'function') {
          updateFnEarly({
            callId: params.callId,
            roomId: params.roomId,
            lastNavParams: params.navParams,
            remoteStream: remoteStreamForPlaceholder ?? params.remoteStream ?? remoteFromSession ?? null,
            localStream: params.localStream ?? localFromSession ?? null,
            localCamOn: localCamForPlaceholder,
            remoteCamOn: remoteCamForPlaceholder,
            preferVideoCallUi: params?.preferVideoCallUi,
            inAudioOnlyUi: params?.inAudioOnlyUi,
            allowVideoRender: !placeholderOnlyHome,
          });
        }
      }

      if (placeholderOnlyHome) {
        // Logo-only: native backdrop сверху; CaptureHost уже mounted (тихий fill) —
        // mid-PiP peer cam только снимает backdrop + bind RTC, без remount.
        try {
          if (g.__pipVisibleRef?.current === true) {
            suspendInAppOverlayForSystemPiPEnter();
          }
        } catch (_) {}
        try {
          g.__pipInSystemModeRef = g.__pipInSystemModeRef || { current: false };
          // Optimistic: cam-toggle / TrackSubscribed до ModeChanged всё равно mid-PiP path.
          g.__pipInSystemModeRef.current = true;
          g.__blockSystemPiPCaptureHostUntilRef =
            g.__blockSystemPiPCaptureHostUntilRef || { current: 0 };
          g.__blockSystemPiPCaptureHostUntilRef.current = 0;
          g.__pendingSystemPiPSyncRef = g.__pendingSystemPiPSyncRef || { current: false };
          g.__pendingSystemPiPSyncRef.current = true;
        } catch (_) {}
        setPendingSystemPiP(true);
        setSystemPiPCaptureActive(true);
        setSystemPiPCaptureRequestId((id) => id + 1);
        setAllowVideoRender(false);
        try {
          NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(true);
        } catch (_) {}
      } else {
        // Peer cam on → video. На VideoCall — compact RemoteVideo (TextureView).
        // CaptureHost только вне VideoCall / на audio shell, иначе dual RTCView → чёрный кадр.
        const onVideoCallRoute = readRootCurrentRouteName() === 'VideoCall';
        const audioUi = isInAudioOnlyCallUi();
        setPendingSystemPiP(true);
        setAllowVideoRender(true);
        if (onVideoCallRoute && !audioUi) {
          setSystemPiPCaptureActive(false);
          setSystemPiPCaptureRequestId(0);
        } else {
          setSystemPiPCaptureActive(true);
          setSystemPiPCaptureRequestId((id) => id + 1);
        }
        try {
          g.__pendingSystemPiPSyncRef = g.__pendingSystemPiPSyncRef || { current: false };
          g.__pendingSystemPiPSyncRef.current = true;
        } catch (_) {}
      }
      const apply = (decorSize: { width: number; height: number } | null) => {
        // Не применять размер окна PiP (типично ~334x594) — иначе при повторном входе layout/зум ломается.
        if (decorSize && decorSize.width > 400 && decorSize.height > 400) setDecorSizeForPiP(decorSize);
      };
      // Натив передаёт размер экрана в payload до входа в PiP; иначе getDecorViewSize() после перехода вернёт размер окна PiP (334x594) и при повторном входе будет «зум».
      const pw = payload?.width ?? 0;
      const ph = payload?.height ?? 0;
      if (pw > 400 && ph > 400) {
        apply({ width: pw, height: ph });
      } else {
        NativeModules.LiviAppModule?.getDecorViewSize?.()?.then?.(apply)?.catch?.(() => apply(null));
        if (!NativeModules.LiviAppModule?.getDecorViewSize) apply(null);
      }
      setTimeout(() => {
        try {
          const inPiP = g.__pipInSystemModeRef?.current === true;
          const until = g.__systemPiPEntryInProgressUntilRef?.current;
          if (inPiP) {
            return;
          }
          if (typeof until === 'number' && until > Date.now()) {
            return;
          }
          setPendingSystemPiP(false);
          setSystemPiPCaptureActive(false);
          setSystemPiPCaptureRequestId(0);
          setDecorSizeForPiP(null);
          try {
            g.__pendingSystemPiPSyncRef = g.__pendingSystemPiPSyncRef || { current: false };
            g.__pendingSystemPiPSyncRef.current = false;
          } catch (_) {}
          if (typeof until === 'number') {
            g.__systemPiPEntryInProgressUntilRef.current = 0;
          }
        } catch (_) {}
      }, 4500);

    });
    return () => sub.remove();
  }, [resolveStablePiPIds]);

  // Для системного PiP: натив шлёт AboutToEnterSystemPiP, App вызывает __pipShowPiPRef.current(params)
  useEffect(() => {
    const g = (global as any);
    g.__pipShowPiPRef = g.__pipShowPiPRef || { current: null };
    g.__pipShowPiPRef.current = showPiP;
    return () => { g.__pipShowPiPRef.current = null; };
  }, [showPiP]);

  // При call:ended (другой участник завершил) App вызывает __pipHidePiPRef.current(), чтобы у того, кто не был в PiP, не появлялся оверлей PiP и не было перехода «приветствие + PiP».
  useEffect(() => {
    const g = (global as any);
    g.__pipHidePiPRef = g.__pipHidePiPRef || { current: null };
    g.__pipHidePiPRef.current = hidePiP;
    return () => { g.__pipHidePiPRef.current = null; };
  }, [hidePiP]);

  useEffect(() => {
    const g = global as any;
    g.__pipSyncSessionStateRef = g.__pipSyncSessionStateRef || { current: null };
    g.__pipSyncSessionStateRef.current = syncSessionPiPState;
    return () => {
      if (g.__pipSyncSessionStateRef) g.__pipSyncSessionStateRef.current = null;
    };
  }, [syncSessionPiPState]);

  // returnToCall вызывается из App.tsx по событию SystemPiPExpanded (кнопка «развернуть» в системном PiP).
  // Параметры для навигации берутся из state (callId, roomId, lastNavParams), при null — из __currentCallPiPParamsRef
  // и __pipLastContextRef (см. комментарий выше), чтобы возврат работал даже при гонках.
  const returnToCall = useCallback((opts?: { preferAudioOnlyUi?: boolean; restoreInAppPiP?: boolean }) => {
    const g = (global as any);
    const nav = g.__navRef;
    const currentRouteName = readRootCurrentRouteName() || undefined;
    const preferAudioOnlyUiEarly = opts?.preferAudioOnlyUi === true;
    try {
      g.__lastReturnToCallAtRef = g.__lastReturnToCallAtRef || { current: 0 };
      const now = Date.now();
      const debounceMs = preferAudioOnlyUiEarly ? 100 : 280;
      if (now - Number(g.__lastReturnToCallAtRef.current || 0) < debounceMs) {
        return;
      }
      g.__lastReturnToCallAtRef.current = now;
    } catch (_) {}
    try {
      const gGuard = (global as any);
      const endingFromPiPButton = gGuard.__endingFromPiPButtonRef?.current === true;
      let endingCall =
        gGuard.__endingCallInProgressRef?.current === true ||
        gGuard.__callEndedFromPiPNoOpenRef?.current === true ||
        endingFromPiPButton;
      if (endingCall) {
        const sessionCheck = gGuard.__webrtcSessionRef?.current;
        const callLive =
          sessionCheck &&
          typeof sessionCheck.isEnded === 'function' &&
          !sessionCheck.isEnded();
        if (callLive && !endingFromPiPButton) {
          logger.info('[PiPContext] returnToCall: active call — ignore stale teardown guards');
          try {
            clearEndingCallInProgress();
            gGuard.__callEndedFromPiPNoOpenRef.current = false;
          } catch (_) {}
          endingCall = false;
        }
      }
      if (endingCall) {
        logger.info('[PiPContext] returnToCall ignored: call teardown in progress');
        hidePiP();
        if (Platform.OS === 'android') {
          try { requestExitSystemPiPSoft(); } catch (_) {}
        }
        return;
      }
    } catch (_) {}
    if (returnToCallInFlightRef.current) {
      return;
    }
    returnToCallInFlightRef.current = true;
    try {
      g.__pipReturnToCallInFlightRef = g.__pipReturnToCallInFlightRef || { current: false };
      g.__pipReturnToCallInFlightRef.current = true;
    } catch (_) {}

    const releaseReturnToCallInFlight = () => {
      returnToCallInFlightRef.current = false;
      try {
        const g2 = global as any;
        g2.__pipReturnToCallInFlightRef = g2.__pipReturnToCallInFlightRef || { current: false };
        g2.__pipReturnToCallInFlightRef.current = false;
      } catch (_) {}
    };

    /** Навигация не удалась — PiP должен остаться на экране (не скрывать overlay заранее). */
    const abortReturnToCallKeepPiP = () => {
      setSuppressOverlayForReturn(false);
      releaseReturnToCallInFlight();
    };

    const preferAudioOnlyUi = opts?.preferAudioOnlyUi === true;
    const restoreInAppPiP = opts?.restoreInAppPiP === true;

    if (restoreInAppPiP) {
      try {
        g.__restoringInAppPiPFromSystemRef = g.__restoringInAppPiPFromSystemRef || { current: false };
        g.__restoringInAppPiPFromSystemRef.current = true;
      } catch (_) {}
      setSuppressOverlayForReturn(false);
    }

    const wasSystemPiP =
      inSystemPiPMode || g.__pipInSystemModeRef?.current === true;

    if (wasSystemPiP) {
      try {
        restoreCallMediaAfterSystemPiPReturn({ preferAudioOnly: preferAudioOnlyUi });
      } catch (_) {}
    }

    const finishReturnToCallAfterNav = () => {
      const tailMs = preferAudioOnlyUi ? 80 : 160;
      setTimeout(() => {
        setSuppressOverlayForReturn(false);
        clearInAppPiPSystemSuspendFlags();
        releaseReturnToCallInFlight();
        reenableAndroidSystemPiPLeaveHintAfterReturn();
      }, tailMs);
    };

    const isOnVideoCallRoute = (): boolean => {
      try {
        return readRootCurrentRouteName() === 'VideoCall';
      } catch {
        return false;
      }
    };
    // Флаг для App: при выходе из PiP по SystemPiPModeChanged не завершать звонок (пользователь тапнул «вернуться», а не системную X).
    try {
      const r = (global as any).__pipReturnToCallJustPressedRef;
      if (r && typeof r === 'object') r.current = true;
    } catch (_) {}
    try {
      const g = global as any;
      const returnToken = Number(g.__systemPiPReturnTokenRef?.current || Date.now());
      g.__systemPiPReturnTokenRef = g.__systemPiPReturnTokenRef || { current: 0 };
      g.__systemPiPReturnTokenRef.current = returnToken;
      g.__systemPiPReturnStateRef = g.__systemPiPReturnStateRef || { current: null };
      g.__systemPiPReturnStateRef.current = {
        token: returnToken,
        owner: null,
        restoredAt: 0,
        settledUntil: 0,
      };
      g.__returningFromSystemPiPUntilRef = g.__returningFromSystemPiPUntilRef || { current: 0 };
      g.__returningFromSystemPiPUntilRef.current = Date.now() + (wasSystemPiP ? 4000 : 1200);
      g.__systemPiPEntryInProgressUntilRef = g.__systemPiPEntryInProgressUntilRef || { current: 0 };
      g.__systemPiPEntryInProgressUntilRef.current = 0;
      g.__enterSystemPiPAfterVideoCallRef = g.__enterSystemPiPAfterVideoCallRef || { current: null };
      g.__enterSystemPiPAfterVideoCallRef.current = null;
      g.__suppressAbortDuringSystemPiPReturnUntilRef =
        g.__suppressAbortDuringSystemPiPReturnUntilRef || { current: 0 };
      g.__suppressAbortDuringSystemPiPReturnUntilRef.current = Math.max(
        Number(g.__suppressAbortDuringSystemPiPReturnUntilRef.current || 0),
        Date.now() + (wasSystemPiP ? 12000 : 2500)
      );
    } catch (_) {}
    // Если звонок уже завершён (партнёр положил трубку), не переходим на экран звонка — только скрываем PiP
    const session = (global as any).__webrtcSessionRef?.current;
    if (session && typeof session.isEnded === 'function' && session.isEnded()) {
      hidePiP();
      releaseReturnToCallInFlight();
      return;
    }

    // КРИТИЧНО: Сбрасываем флаги системного PiP до навигации, чтобы VideoCall при монтировании
    // рендерил обычный двухкарточный layout (собеседник сверху, вы снизу), а не компактный вид
    // «только удалённое видео на весь экран» — иначе после тапа по PiP экран выглядит «другое».
    setInSystemPiPMode(false);
    setPendingSystemPiP(false);
    setSystemPiPCaptureActive(false);
    setSystemPiPCaptureRequestId(0);
    try {
      clearSystemPiPSessionAudioOrigin();
    } catch (_) {}
    if (Platform.OS === 'android' && wasSystemPiP) {
      try { requestExitSystemPiPSoft(); } catch (_) {}
    }

    const sessionForPipeState = g.__webrtcSessionRef?.current;
    const paramsRef = g.__currentCallPiPParamsRef?.current;
    const lastCtx = g.__pipLastContextRef?.current;
    const sessionCallId =
      sessionForPipeState && typeof (sessionForPipeState as any).getCallId === 'function'
        ? (sessionForPipeState as any).getCallId()
        : null;
    const sessionRoomId =
      sessionForPipeState && typeof (sessionForPipeState as any).getRoomId === 'function'
        ? (sessionForPipeState as any).getRoomId()
        : null;

    const effectiveCallId = callId || paramsRef?.callId || lastCtx?.callId || sessionCallId || null;
    const effectiveRoomId = roomId || paramsRef?.roomId || lastCtx?.roomId || sessionRoomId || null;
    const effectiveNavParams = lastNavParams ?? paramsRef?.navParams ?? lastCtx?.navParams;
    try {
      g.__preferAudioOnlyUiOnNextVideoCallRef = g.__preferAudioOnlyUiOnNextVideoCallRef || { current: false };
      g.__expandToVideoCallUiFromPiPRef = g.__expandToVideoCallUiFromPiPRef || { current: false };
      if (restoreInAppPiP) {
        g.__preferAudioOnlyUiOnNextVideoCallRef.current = false;
        g.__expandToVideoCallUiFromPiPRef.current = false;
        g.__pipForceHiddenRef = g.__pipForceHiddenRef || { current: false };
        g.__pipForceHiddenRef.current = false;
      } else if (preferAudioOnlyUi) {
        prepareDirectCallAudioReturnFromPiP();
      } else {
        prepareDirectCallVideoExpandFromInAppPiP();
        g.__preferAudioOnlyUiOnNextVideoCallRef.current = false;
        g.__expandToVideoCallUiFromPiPRef.current = true;
      }
    } catch (_) {}
    syncSessionPiPState(
      false,
      restoreInAppPiP ? 'returnToCall' : preferAudioOnlyUi ? 'returnToAudioCall' : 'returnToCall',
    );
    
    // Guard от двойной навигации
    if (navigatingRef.current) {
      releaseReturnToCallInFlight();
      return;
    }

    const doNavigate = (cid: string, rid: string, navParams?: any) => {
      const partnerNickFromCtx = String(
        navParams?.partnerNick ||
          partnerNameRef.current ||
          (global as any).__currentCallPiPParamsRef?.current?.partnerName ||
          '',
      ).trim();
      const peerFromCtx = String(
        navParams?.peerUserId ||
          navParams?.partnerId ||
          (global as any).__videoCallPartnerUserIdRef?.current ||
          '',
      ).trim();
      const params = {
        ...(navParams ?? {}),
        resume: true,
        fromPiP: true,
        ...(preferAudioOnlyUi
          ? { audioOnlyPiPReturn: true, preferVideoCallUi: false }
          : { audioOnlyPiPReturn: false, preferVideoCallUi: true }),
        systemPiPReturnToken: Number(g.__systemPiPReturnTokenRef?.current || Date.now()),
        directCall: true,
        directInitiator: undefined,
        callId: cid,
        roomId: rid,
        ...(peerFromCtx ? { peerUserId: peerFromCtx } : {}),
        ...(partnerNickFromCtx ? { partnerNick: partnerNickFromCtx } : {}),
      };

      const completeAfterNavAttempt = (source: string) => {
        const finalize = () => {
          if (!isOnVideoCallRoute()) {
            abortReturnToCallKeepPiP();
            logger.warn('[PiPContext] returnToCall: navigation did not reach VideoCall, keeping PiP visible', {
              source,
            });
            return;
          }
          setSuppressOverlayForReturn(true);
          hidePiP();
          finishReturnToCallAfterNav();
        };
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(finalize);
        } else {
          setTimeout(finalize, 16);
        }
      };

      if (!nav || !nav.isReady || !nav.isReady()) {
        console.warn('[PiPContext] returnToCall: Navigation not ready, using onReturnToCall fallback');
        try {
          onReturnToCall?.(cid, rid);
        } catch (e) {
          console.error('[PiPContext] returnToCall onReturnToCall error:', e);
          abortReturnToCallKeepPiP();
          return;
        }
        completeAfterNavAttempt('onReturnToCall');
        return;
      }

      navigatingRef.current = true;
      setSuppressOverlayForReturn(true);
      try {
        const currentRouteName = readRootCurrentRouteName() || undefined;
        const liveSession = (global as any).__webrtcSessionRef?.current;
        const callStillLive =
          liveSession &&
          typeof liveSession.isEnded === 'function' &&
          !liveSession.isEnded();
        const useStackNavigate =
          callStillLive &&
          (currentRouteName === 'Home' || currentRouteName === 'VideoCall');

        hidePiP();
        if (useStackNavigate) {
          nav.dispatch(
            CommonActions.navigate({
              name: 'VideoCall' as any,
              params,
              merge: true,
            }),
          );
        } else {
          nav.dispatch(
            CommonActions.reset({
              index: 1,
              routes: [{ name: 'Home' as any }, { name: 'VideoCall' as any, params }],
            }),
          );
        }
        finishReturnToCallAfterNav();
      } catch (e) {
        console.error('[PiPContext] Navigation error:', e);
        setSuppressOverlayForReturn(false);
        try {
          onReturnToCall?.(cid, rid);
        } catch (fallbackErr) {
          console.error('[PiPContext] returnToCall fallback after dispatch error:', fallbackErr);
          abortReturnToCallKeepPiP();
          return;
        }
        completeAfterNavAttempt('dispatch-catch-fallback');
      } finally {
        navigatingRef.current = false;
      }
    };

    if (
      preferAudioOnlyUi &&
      !restoreInAppPiP &&
      currentRouteName === 'VideoCall' &&
      typeof g.__returnToAudioCallRef?.current === 'function'
    ) {
      hidePiP();
      try {
        void g.__returnToAudioCallRef.current({ skipNavigation: true, fromPiP: true });
      } catch (e) {
        logger.warn('[PiPContext] returnToCall audio fast-path failed', e);
      }
      finishReturnToCallAfterNav();
      return;
    }

    // Уже на VideoCall → video UI: merge params без reset (меньше remount).
    if (!preferAudioOnlyUi && !restoreInAppPiP && currentRouteName === 'VideoCall') {
      hidePiP();
      try {
        mergeActiveVideoCallParams({
          resume: true,
          fromPiP: true,
          audioOnlyPiPReturn: false,
          preferVideoCallUi: true,
          systemPiPReturnToken: Number(g.__systemPiPReturnTokenRef?.current || Date.now()),
        });
      } catch (e) {
        logger.warn('[PiPContext] returnToCall video fast-path merge failed', e);
      }
      finishReturnToCallAfterNav();
      return;
    }

    if (restoreInAppPiP) {
      const leaveSnap = peekSystemPiPLeaveContextForReturn();
      const liveRoute = readRootCurrentRouteName();
      // Никогда не открывать VideoCall при restore плашки — только Home / текущий non-call экран.
      const rawTarget = leaveSnap.routeName || liveRoute || 'Home';
      const targetRoute =
        rawTarget === 'VideoCall'
          ? liveRoute && liveRoute !== 'VideoCall'
            ? liveRoute
            : 'Home'
          : rawTarget;
      const showInAppFromParams = (): boolean => {
        const params = g.__currentCallPiPParamsRef?.current;
        const showFn = g.__pipShowPiPRef?.current;
        const cid = params?.callId || effectiveCallId;
        const rid = params?.roomId || effectiveRoomId;
        if (!cid || !rid || typeof showFn !== 'function') return false;
        const fromAudioOnlyUi = params?.inAudioOnlyUi === true;
        const audioRoute =
          normalizeInCallRoute(params?.audioOutputRoute || '') ||
          readInAppPiPAudioOutputRoute();
        showFn({
          callId: String(cid),
          roomId: String(rid),
          partnerName: params?.partnerName,
          partnerAvatarUrl: params?.partnerAvatarUrl,
          localStream: params?.localStream ?? null,
          remoteStream: params?.remoteStream ?? null,
          muteLocal: params?.muteLocal,
          muteRemote: params?.muteRemote,
          localCamOn: params?.localCamOn,
          remoteCamOn: params?.remoteCamOn,
          navParams: params?.navParams ?? effectiveNavParams,
          deferVisible: false,
          fromAudioOnlyUi: !!fromAudioOnlyUi,
          audioOutputRoute: audioRoute,
        });
        try {
          const sess = g.__webrtcSessionRef?.current;
          if (sess?.enterPiP && typeof sess.enterPiP === 'function') {
            sess.enterPiP();
          }
        } catch (_) {}
        return true;
      };
      const completeRestore = () => {
        if (!showInAppFromParams()) {
          abortReturnToCallKeepPiP();
          return;
        }
        try {
          restoreCallAudioForInAppPiPPlaque('restore_in_app_pip_from_system');
        } catch (_) {}
        clearInAppPiPSystemSuspendFlags();
        clearSystemPiPNeedsInAppRestore();
        try {
          const g2 = global as any;
          if (g2.__pendingInAppPiPRestoreAfterSystemRef) {
            g2.__pendingInAppPiPRestoreAfterSystemRef.current = false;
          }
        } catch (_) {}
        setSuppressOverlayForReturn(false);
        finishReturnToCallAfterNav();
      };
      if (!nav?.isReady?.()) {
        abortReturnToCallKeepPiP();
        return;
      }
      try {
        const curRoute = readRootCurrentRouteName();
        if (curRoute === targetRoute) {
          completeRestore();
        } else {
          nav.dispatch(CommonActions.navigate({ name: targetRoute as any }));
          setTimeout(completeRestore, 100);
        }
      } catch (e) {
        logger.warn('[PiPContext] restoreInAppPiP navigation failed', e);
        abortReturnToCallKeepPiP();
      }
      return;
    }

    if (nav && effectiveCallId && effectiveRoomId) {
      doNavigate(String(effectiveCallId), String(effectiveRoomId), effectiveNavParams);
      return;
    }

    // Последний шанс (Android): берём параметры из нативного хранилища PiP (setPiPEndCallParams).
    if (Platform.OS === 'android') {
      try {
        const Livi = NativeModules.LiviAppModule;
        if (Livi?.getPiPEndCallParams) {
          Livi.getPiPEndCallParams()
            .then((p: { callId?: string | null; roomId?: string | null } | null) => {
              const cid = p?.callId ? String(p.callId) : '';
              const rid = p?.roomId ? String(p.roomId) : '';
              if (!cid || !rid) {
                abortReturnToCallKeepPiP();
                return;
              }
              doNavigate(cid, rid, effectiveNavParams);
            })
            .catch(() => abortReturnToCallKeepPiP());
          return;
        }
      } catch (_) {}
    }

    console.log('[PiPContext] returnToCall: missing nav/callId/roomId', {
      hasNav: !!nav,
      callId: effectiveCallId,
      roomId: effectiveRoomId,
    });
    abortReturnToCallKeepPiP();
  }, [callId, roomId, lastNavParams, onReturnToCall, hidePiP, syncSessionPiPState, inSystemPiPMode]);

  // Чтобы по кнопке «развернуть» в системном PiP возвращать на экран видеозвонка (App слушает SystemPiPExpanded и дергает этот ref).
  useEffect(() => {
    const g = global as any;
    g.__pipReturnToCallRef = {
      current: (inner?: { restoreInAppPiP?: boolean }) =>
        returnToCall({ preferAudioOnlyUi: false, restoreInAppPiP: inner?.restoreInAppPiP }),
    };
    g.__pipReturnToAudioCallRef = { current: () => returnToCall({ preferAudioOnlyUi: true }) };
    return () => {
      delete g.__pipReturnToCallRef;
      delete g.__pipReturnToAudioCallRef;
    };
  }, [returnToCall]);

  const endCall = useCallback(() => {
    // КРИТИЧНО: Вызываем onEndCall (который вызовет session.endCall() через __endCallCleanupRef)
    // Это гарантирует правильное завершение звонка через WebRTC session
    // и отправку call:end на сервер, чтобы завершить звонок у обоих участников
    // session.endCall() уже остановит локальные стримы и отправит событие на сервер
    if (onEndCall) {
      onEndCall(callId, roomId);
    } else {
      // Fallback: если onEndCall не установлен, вызываем session.endCall(callId, roomId) напрямую (завершение у обоих)
      const session = (global as any).__webrtcSessionRef?.current;
      if (session && typeof session.endCall === 'function') {
        session.endCall(callId ?? undefined, roomId ?? undefined);
      } else if (callId || roomId) {
        try {
          socket.emit('call:end', buildCallEndSocketPayload(callId, roomId));
        } catch (e) {
          console.warn('[PiPContext] Session not available and onEndCall not set', e);
        }
      }
    }
    
    // Затем очищаем состояние PiP
    setVisible(false);
    setCallId(null);
    setRoomId(null);
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    setIsMuted(false);
    setIsRemoteMuted(false);
    setPartnerAvatarUrl(undefined);
    setLastNavParams(undefined);
    setLocalCamOn(undefined);
    setPendingSystemPiP(false);
    setSystemPiPCaptureActive(false);
    setSystemPiPCaptureRequestId(0);
  }, [callId, roomId, onEndCall]);

  // Обработчик завершения звонка для пользователя в PiP (в т.ч. когда собеседник завершил из системного PiP).
  // Задержка закрытия у того, кто не нажимал «Завершить»: в системном PiP сокет часто отключён (app in background),
  // поэтому call:ended приходит только после реконнекта; PiP также закрывается по LiveKit (ParticipantDisconnected / Room Disconnected) и при socket reconnect в App.
  useEffect(() => {
    const onCallEnded = (data?: any) => {
      const receivedCallId = String(data?.callId || '').trim();
      const receivedRoomId = String(data?.roomId || '').trim();
      const currentCallId = String(callId || '').trim();
      const currentRoomId = String(roomId || '').trim();
      const matchedByCallId = !!receivedCallId && !!currentCallId && receivedCallId === currentCallId;
      const matchedByRoomId = !!receivedRoomId && !!currentRoomId && receivedRoomId === currentRoomId;
      // Если прилетел call:ended без id — оставляем старое поведение (закрываем активный PiP).
      const hasNoIdsInPayload = !receivedCallId && !receivedRoomId;
      if (!hasNoIdsInPayload && !matchedByCallId && !matchedByRoomId) {
        return;
      }
      // Закрываем PiP при call:ended: in-app, state системного PiP или ref (после shouldIgnoreLateEnter state мог остаться false).
      let inSystemByRef = false;
      try {
        inSystemByRef = (global as any).__pipInSystemModeRef?.current === true;
      } catch (_) {}
      const shouldClosePiP = (visible || inSystemPiPMode || inSystemByRef) && (callId || roomId);
      // Идемпотентно с App и VideoCallSession (один socket — несколько слушателей call:ended).
      applyCallEndedGlobalRefsOnce(receivedCallId || undefined, receivedRoomId || undefined);
      if (!shouldClosePiP) {
        try {
          const g2 = global as any;
          if (g2.__pipCallEndedWasInSystemRef) g2.__pipCallEndedWasInSystemRef.current = false;
        } catch (_) {}
        return;
      }
      // Слушатель PiPContext обычно идёт раньше App: hidePiP() обнулит __pipInSystemModeRef до того, как App
      // прочитает inSystem. Снимок — чтобы App и VideoCall применили ту же ветку «завершение из PiP».
      try {
        const g2 = global as any;
        g2.__pipCallEndedWasInSystemRef = g2.__pipCallEndedWasInSystemRef || { current: false };
        g2.__pipCallEndedWasInSystemRef.current =
          inSystemPiPMode === true || inSystemByRef === true;
        g2.__pipCallEndedWasInAppRef = g2.__pipCallEndedWasInAppRef || { current: false };
        g2.__pipCallEndedWasInAppRef.current =
          !inSystemPiPMode && !inSystemByRef;
      } catch (_) {}
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
      }
      // Сначала закрываем системный PiP, чтобы окно исчезло быстрее у того, кто получил call:ended.
      if (Platform.OS === 'android') {
        try { dismissSystemPiPAfterCallEnded(); } catch (_) {}
      }
      hidePiP();
      setCallId(null);
      setRoomId(null);
      localStreamRef.current = null;
      remoteStreamRef.current = null;
      setIsMuted(false);
      setIsRemoteMuted(false);
      setPartnerAvatarUrl(undefined);
      setLastNavParams(undefined);
      setLocalCamOn(undefined);
    };

    socket.on('call:ended', onCallEnded);
    return () => {
      socket.off('call:ended', onCallEnded);
    };
  }, [visible, callId, roomId, onEndCall, endCall, hidePiP, inSystemPiPMode]);

  const updatePiPState = useCallback((patch: Partial<PiPState>) => {
    if (patch.callId !== undefined) {
      callIdRef.current = patch.callId;
      setCallId(patch.callId);
    }
    if (patch.roomId !== undefined) {
      roomIdRef.current = patch.roomId;
      setRoomId(patch.roomId);
    }
    if (patch.partnerName !== undefined) setPartnerName(patch.partnerName);
    if (patch.partnerAvatarUrl !== undefined) setPartnerAvatarUrl(patch.partnerAvatarUrl);
    if (patch.visible !== undefined) setVisible(patch.visible);
    if (patch.isMuted !== undefined) {
      setIsMuted(patch.isMuted);
      try {
        const params = (global as any).__currentCallPiPParamsRef?.current;
        if (params && typeof params === 'object') {
          params.muteLocal = patch.isMuted;
        }
      } catch {}
    }
    if (patch.isRemoteMuted !== undefined) setIsRemoteMuted(patch.isRemoteMuted);
    if (patch.localCamOn !== undefined) setLocalCamOn(patch.localCamOn);
    if (patch.remoteCamOn !== undefined) {
      setRemoteCamOn((prev) => (prev === patch.remoteCamOn ? prev : !!patch.remoteCamOn));
      // Не бампим remoteStreamVersion только из-за cam flag — это крутило ensure→flush loop.
    }
    if (patch.pipPos) setPipPos(patch.pipPos);
    if (patch.allowVideoRender !== undefined) {
      setAllowVideoRender((prev) => (prev === !!patch.allowVideoRender ? prev : !!patch.allowVideoRender));
    }
    if (patch.inSystemPiPMode !== undefined) {
      setInSystemPiPMode((prev) => (prev === !!patch.inSystemPiPMode ? prev : !!patch.inSystemPiPMode));
    }
    if (patch.pendingSystemPiP !== undefined) {
      setPendingSystemPiP((prev) => (prev === !!patch.pendingSystemPiP ? prev : !!patch.pendingSystemPiP));
    }
    if (patch.systemPiPCaptureActive !== undefined) {
      setSystemPiPCaptureActive((prev) =>
        prev === !!patch.systemPiPCaptureActive ? prev : !!patch.systemPiPCaptureActive,
      );
    }
    if (patch.systemPiPCaptureRequestId !== undefined) setSystemPiPCaptureRequestId(Number(patch.systemPiPCaptureRequestId || 0));
    if (patch.decorSizeForPiP !== undefined) setDecorSizeForPiP(patch.decorSizeForPiP ?? null);
    if (patch.lastNavParams !== undefined) setLastNavParams(patch.lastNavParams);
    // потоки через ref:
    if (patch.localStream !== undefined) localStreamRef.current = patch.localStream;
    if (patch.remoteStream !== undefined) {
      const prev = remoteStreamRef.current as any;
      const next = patch.remoteStream as any;
      const prevId = prev?.id;
      const nextId = next?.id;
      const liveChanged =
        mediaStreamHasLiveVideo(prev) !== mediaStreamHasLiveVideo(next);
      let videoCountChanged = false;
      try {
        const prevN = prev?.getVideoTracks?.()?.length ?? 0;
        const nextN = next?.getVideoTracks?.()?.length ?? 0;
        videoCountChanged = prevN !== nextN;
      } catch (_) {}
      const identityChanged = prevId !== nextId || (!!next && !prev) || (!!prev && !next);
      remoteStreamRef.current = patch.remoteStream;
      if (identityChanged || liveChanged || videoCountChanged) {
        setRemoteStreamVersion((v) => v + 1);
      }
    }
    if (patch.pipRemoteViewKey !== undefined) {
      const k = Number(patch.pipRemoteViewKey) || 0;
      if (pipRemoteViewKeyRef.current !== k) {
        pipRemoteViewKeyRef.current = k;
        setPipRemoteViewKey(k);
        setRemoteStreamVersion((v) => v + 1);
      }
    }
    if (patch.suppressOverlayForReturn !== undefined) {
      setSuppressOverlayForReturn(!!patch.suppressOverlayForReturn);
    }
  }, []);

  // КРИТИЧНО: Делаем updatePiPState доступным глобально, чтобы WebRTC session могла обновлять PiP,
  // даже когда экран VideoCall размонтирован (PiP работает поверх приложения).
  useEffect(() => {
    const g = global as any;
    g.__pipUpdateStateRef = g.__pipUpdateStateRef || { current: null };
    g.__pipUpdateStateRef.current = updatePiPState;
    g.__pipVisibleRef = g.__pipVisibleRef || { current: false };
    g.__pipDeferVisiblePendingRef = g.__pipDeferVisiblePendingRef || { current: false };
    g.__pipForceHiddenRef = g.__pipForceHiddenRef || { current: false };
    // Нельзя делать __pipVisibleRef = visible пока visible ещё false, а showPiP уже выставил ref=true для iOS deferVisible (rAF).
    // Иначе VideoCall размонтируется после goBack(), cleanup видит pipVisible=false и шлёт call:end.
    if (g.__pipForceHiddenRef.current === true) {
      g.__pipVisibleRef.current = false;
      g.__pipDeferVisiblePendingRef.current = false;
    } else if (visible) {
      g.__pipVisibleRef.current = true;
      g.__pipDeferVisiblePendingRef.current = false;
    } else if (g.__pipDeferVisiblePendingRef.current === true) {
      // оставляем __pipVisibleRef как после showPiP (true)
    } else {
      g.__pipVisibleRef.current = false;
    }
    return () => {
      try { (global as any).__pipUpdateStateRef.current = null; } catch {}
    };
  }, [updatePiPState, visible]);

  useEffect(() => {
    if (Platform.OS !== 'android') return () => {};
    const g = global as any;
    const inAppFromContext = visible && !inSystemPiPMode && !pendingSystemPiP;
    const inAppFromSyncRef =
      g.__pipForceHiddenRef?.current !== true &&
      g.__pipVisibleRef?.current === true &&
      !inSystemPiPMode &&
      !pendingSystemPiP;
    const inAppPiPVisible = inAppFromContext || inAppFromSyncRef;
    try {
      NativeModules.LiviAppModule?.setInAppPiPVisibleForSystemPiP?.(inAppPiPVisible);
    } catch (_) {}
    return () => {
      try {
        NativeModules.LiviAppModule?.setInAppPiPVisibleForSystemPiP?.(false);
      } catch (_) {}
    };
  }, [visible, inSystemPiPMode, pendingSystemPiP]);

  // Сбрасываем __pipVisibleRef только при размонтировании провайдера, а не на каждом re-run эффекта.
  useEffect(() => {
    return () => {
      try { (global as any).__pipVisibleRef.current = false; } catch {}
    };
  }, []);

  const updatePiPPosition = useCallback((x: number, y: number) => setPipPos({ x, y }), []);

  const value = useMemo<PiPState>(() => ({
    visible,
    callId,
    roomId,
    partnerName,
    partnerAvatarUrl,
    isMuted,
    isRemoteMuted,
    localStream: localStreamRef.current,
    remoteStream: remoteStreamRef.current,
    localCamOn,
    remoteCamOn,
    pipPos,
    lastNavParams,

    showPiP,
    hidePiP,
    updatePiPPosition,
    returnToCall,
    endCall,
    allowVideoRender,
    inSystemPiPMode,
    pendingSystemPiP,
    systemPiPCaptureActive,
    systemPiPCaptureRequestId,
    suppressOverlayForReturn,
    decorSizeForPiP,
    remoteStreamVersion,
    pipRemoteViewKey,
    updatePiPState,
  }), [
    visible, callId, roomId, partnerName, partnerAvatarUrl,
    isMuted, isRemoteMuted, localCamOn, remoteCamOn, pipPos, allowVideoRender, inSystemPiPMode, pendingSystemPiP, systemPiPCaptureActive, systemPiPCaptureRequestId, suppressOverlayForReturn, decorSizeForPiP, remoteStreamVersion, pipRemoteViewKey,
    showPiP, hidePiP, updatePiPPosition, returnToCall, endCall, updatePiPState
  ]);

  // Не передаём null как children — иначе при обновлении контекста React может вызвать Children.forEach(children) и получить "forEach of null".
  return (
    <PiPContext.Provider value={value}>
      {children ?? <></>}
    </PiPContext.Provider>
  );
}
