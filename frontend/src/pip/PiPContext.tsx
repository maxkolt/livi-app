// src/pip/PiPContext.tsx
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { AppState, NativeModules, NativeEventEmitter, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { CommonActions } from '@react-navigation/native';
import socket, { onConnected, emitPresenceUpdateIfChanged } from '../../sockets/socket';
import { applyCallEndedGlobalRefsOnce } from '../../utils/globalEvents';
import { buildCallEndSocketPayload } from '../../utils/callEndPayload';
import { logger } from '../../utils/logger';
import { trackReleaseEvent } from '../../utils/telemetry';
import { requestExitSystemPiPSoft, dismissSystemPiPAfterCallEnded } from '../../utils/callKeep';
import { startActiveCallNotification, reenableAndroidSystemPiPLeaveHintAfterReturn, refreshAndroidActiveCallNotification, syncAndroidSystemPiPNativeFlags, isAndroidActiveCallEligibleForLeaveHint } from '../../utils/activeCallNotification';
import {
  shouldUsePipPlaceholderOnly,
  prepareDirectCallAudioReturnFromPiP,
  isInAudioOnlyCallUi,
  setPipInAppRtcFromAudioOnlySticky,
  shouldAllowRtcVideoRenderInInAppPiP,
} from './pipPlaceholderOnly';
import {
  scheduleReapplyPersistedCallAudioRoute,
  setPersistedCallAudioRoute,
} from '../../utils/callAudioRoutePersist';
import type { InCallAudioRoute } from '../../components/VideoChat/hooks/audioRouteTypes';
import { normalizeInCallRoute } from '../../components/VideoChat/hooks/audioRouteTypes';
import {
  beginHomePiPOutcomeWatch,
  installSystemPiPHomeTraceListener,
  logHomePiPTrace,
  noteHomePiPModeChanged,
  setActiveHomePiPTraceId,
} from '../../utils/systemPiPHomeTrace';

type MediaStreamLike = any; // из @livekit/react-native-webrtc

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
      logHomePiPTrace('js_mode_changed', { traceId, inPiP });
      noteHomePiPModeChanged(traceId, inPiP);
      const stableIds = resolveStablePiPIds();
      trackReleaseEvent('pip_enter_exit', {
        phase: inPiP ? 'enter' : 'exit',
        callId: stableIds.callId,
        roomId: stableIds.roomId,
      });
      const run = () => {
        const g = global as any;
        const now = Date.now();
        const returningUntil = Number(g.__returningFromSystemPiPUntilRef?.current || 0);
        const returnState = g.__systemPiPReturnStateRef?.current;
        const settledUntil =
          returnState && Number(returnState.token || 0) === Number(g.__systemPiPReturnTokenRef?.current || 0)
            ? Number(returnState.settledUntil || 0)
            : 0;
        // Не используем __disableSystemPiPUntilRef здесь: после Back с VideoCall usePiP ставит +2s,
        // пользователь уходит на Home и сразу жмёт Home → реальный system PiP, а мы обнуляли ref и
        // call:ended / PiPContext не закрывали окно (PiP «висит» без связи с JS).
        const shouldIgnoreLateEnter =
          inPiP &&
          (
            returnToCallInFlightRef.current ||
            now < returningUntil ||
            now < settledUntil ||
            g.__pipReturnToCallJustPressedRef?.current === true
          );
        if (shouldIgnoreLateEnter) {
          setInSystemPiPMode(false);
          setPendingSystemPiP(false);
          setSystemPiPCaptureActive(false);
          setSystemPiPCaptureRequestId(0);
          setDecorSizeForPiP(null);
          try {
            g.__pipInSystemModeRef = g.__pipInSystemModeRef || { current: false };
            // Ref должен совпадать с нативом (App/call:ended/requestExitSystemPiPSoft), иначе PiP остаётся в системе.
            g.__pipInSystemModeRef.current = inPiP;
          } catch (_) {}
          return;
        }
        setInSystemPiPMode(inPiP);
        if (!inPiP) {
          setDecorSizeForPiP(null);
          setSystemPiPCaptureActive(false);
          setSystemPiPCaptureRequestId(0);
          // Выход из системного PiP: сразу подавляем оверлей, чтобы он не мелькнул маленьким окном поверх экрана видеозвонка.
          setSuppressOverlayForReturn(true);
        }
        try {
          g.__pipInSystemModeRef = g.__pipInSystemModeRef || { current: false };
          g.__pipInSystemModeRef.current = inPiP;
        } catch (_) {}
        if (inPiP) {
          setPendingSystemPiP(false);
          setSystemPiPCaptureActive(false);
          setSystemPiPCaptureRequestId(0);
          try {
            g.__pipVisibleRef = g.__pipVisibleRef || { current: false };
            if (g.__pipVisibleRef.current === true) {
              g.__pipHidePiPRef?.current?.();
              g.__pipVisibleRef.current = false;
              NativeModules.LiviAppModule?.setInAppPiPVisibleForSystemPiP?.(false);
              logHomePiPTrace('js_hide_in_app_for_system', { traceId: g.__activeHomePiPTraceIdRef?.current });
            }
          } catch (_) {}
          try {
            g.__pendingSystemPiPSyncRef = g.__pendingSystemPiPSyncRef || { current: false };
            g.__pendingSystemPiPSyncRef.current = false;
          } catch (_) {}
          const session = g.__webrtcSessionRef?.current;
          if (session && typeof (session as any).enterPiP === 'function') (session as any).enterPiP();
          // КРИТИЧНО: В PiP система часто переключает звук с громкого динамика на разговорный (earpiece) — становится тихо.
          // Принудительно держим громкий динамик: переприменяем сразу и с задержками (на части устройств переключение с задержкой).
          const reapplyPiPAudio = () => {
            try {
              InCallManager.start({ media: 'video', ringback: '' });
              try { (InCallManager as any).requestAudioFocus?.(); } catch (_) {}
              try { (InCallManager as any).setForceSpeakerphoneOn?.(true); } catch (_) {}
              InCallManager.setSpeakerphoneOn(true);
            } catch (_) {}
          };
          if (Platform.OS === 'android') {
            reapplyPiPAudio();
            [300, 900, 1500, 2500].forEach((ms) => setTimeout(reapplyPiPAudio, ms));
          }
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
      const routeNorm = normalizeInCallRoute(p.audioOutputRoute || '');
      if (routeNorm) {
        setPersistedCallAudioRoute(routeNorm);
      }
      try {
        const gAudio = global as any;
        gAudio.__lastInAppPipAudioReapplyAtRef = gAudio.__lastInAppPipAudioReapplyAtRef || { current: 0 };
        const nowAudio = Date.now();
        if (nowAudio - Number(gAudio.__lastInAppPipAudioReapplyAtRef.current || 0) > 1200) {
          gAudio.__lastInAppPipAudioReapplyAtRef.current = nowAudio;
          scheduleReapplyPersistedCallAudioRoute('in_app_pip_from_audio', {
            media: 'audio',
            delaysMs: [0, 250],
          });
        }
      } catch {
        scheduleReapplyPersistedCallAudioRoute('in_app_pip_from_audio', {
          media: 'audio',
          delaysMs: [0, 250],
        });
      }
    }

    // КРИТИЧНО: Ставим флаг PiP синхронно (до setState), чтобы teardown логика (например, stopSpeaker в хуках)
    // могла увидеть, что PiP уже включен, даже если React effect еще не успел пробежать.
    try {
      (global as any).__pipForceHiddenRef = (global as any).__pipForceHiddenRef || { current: false };
      (global as any).__pipForceHiddenRef.current = false;
      (global as any).__pipVisibleRef = (global as any).__pipVisibleRef || { current: false };
      (global as any).__pipVisibleRef.current = true;
      if (Platform.OS === 'android') {
        NativeModules.LiviAppModule?.setInAppPiPVisibleForSystemPiP?.(true);
      }
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
    if (typeof p.muteLocal === 'boolean') setIsMuted(!!p.muteLocal);
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
    }
  }, []);

  const hidePiP = useCallback(() => {
    if (deferVisibleRafRef.current != null) {
      try {
        cancelAnimationFrame(deferVisibleRafRef.current);
      } catch {}
      deferVisibleRafRef.current = null;
    }
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

  // AboutToEnterSystemPiP: единый сценарий системного PiP.
  // При Home не показываем in-app PiP и не делаем reset на Home — входим напрямую в системный PiP,
  // чтобы окно PiP содержало видео собеседника с текущего экрана VideoCall.
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
      logHomePiPTrace('js_about_to_enter_skip', {
        traceId,
        reason: 'policy_no_system_pip_on_leave_hint',
      });
      return;
      // Не входить в PiP без нажатия пользователя: при завершении звонка (переход на Home) onUserLeaveHint может сработать раньше нативного флага.
      if (g.__endingCallInProgressRef?.current === true) {
        return;
      }
      if (g.__videoCallActiveRef?.current === false) {
        return;
      }
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
        g.__leavingVideoCallByHomeRef = g.__leavingVideoCallByHomeRef || { current: false };
        g.__leavingVideoCallByHomeRef.current = true;
        g.__systemPiPEntryInProgressUntilRef = g.__systemPiPEntryInProgressUntilRef || { current: 0 };
        g.__systemPiPEntryInProgressUntilRef.current = Date.now() + 6000;
        NativeModules.LiviAppModule?.clearSystemPiPReenterSuppress?.();
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
      const localEarly =
        paramsEarly?.localStream ??
        (session && typeof (session as any).getLocalStream === 'function'
          ? (session as any).getLocalStream()
          : null);
      if (
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
        if (g.__pipVisibleRef?.current === true) {
          g.__pipHidePiPRef?.current?.();
          g.__pipVisibleRef.current = false;
          NativeModules.LiviAppModule?.setInAppPiPVisibleForSystemPiP?.(false);
          logHomePiPTrace('js_hide_in_app_for_system', { traceId, reason: 'before_system_capture' });
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
        g.__pendingSystemPiPSyncRef = g.__pendingSystemPiPSyncRef || { current: false };
        g.__pendingSystemPiPSyncRef.current = true;
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
      const localCamForPlaceholder =
        params?.localCamOn ??
        (session && typeof (session as any).getIsCamOn === 'function'
          ? (session as any).getIsCamOn()
          : false);
      const remoteCamForPlaceholder =
        params?.remoteCamOn ??
        (session && typeof (session as any).getRemoteCamEnabled === 'function'
          ? (session as any).getRemoteCamEnabled()
          : false);
      const placeholderOnlyHome = shouldUsePipPlaceholderOnly({
        localCamOn: localCamForPlaceholder,
        remoteCamOn: remoteCamForPlaceholder,
        remoteStream: params?.remoteStream ?? remoteFromSessionForPlaceholder ?? null,
        localStream: params?.localStream ?? localFromSessionForPlaceholder ?? null,
      });
      logger.info('[PiPContext] AboutToEnterSystemPiP placeholder decision', {
        placeholderOnlyHome,
        localCamOn: params?.localCamOn,
        remoteCamOn: params?.remoteCamOn,
        hasRemoteStream: !!(params?.remoteStream ?? remoteFromSessionForPlaceholder),
        decorPayload: { w: payload?.width ?? 0, h: payload?.height ?? 0 },
      });
      try {
        NativeModules.LiviAppModule?.setSystemPiPCapturePlaceholderOnly?.(placeholderOnlyHome);
        NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(false);
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
        const localCamFromSession =
          session && typeof (session as any).getIsCamOn === 'function'
            ? (session as any).getIsCamOn()
            : undefined;
        const remoteCamFromSession =
          session && typeof (session as any).getRemoteCamEnabled === 'function'
            ? (session as any).getRemoteCamEnabled()
            : undefined;
        if (typeof updateFnEarly === 'function') {
          updateFnEarly({
            callId: params.callId,
            roomId: params.roomId,
            lastNavParams: params.navParams,
            remoteStream: params.remoteStream ?? remoteFromSession ?? null,
            localStream: params.localStream ?? localFromSession ?? null,
            localCamOn:
              typeof params?.localCamOn === 'boolean' ? params.localCamOn : localCamFromSession,
            remoteCamOn:
              typeof params?.remoteCamOn === 'boolean' ? params.remoteCamOn : remoteCamFromSession,
            preferVideoCallUi: params?.preferVideoCallUi,
            inAudioOnlyUi: params?.inAudioOnlyUi,
            allowVideoRender: !placeholderOnlyHome,
          });
        }
      }

      // Включаем отдельный fullscreen-host для system PiP capture (только Home).
      const requestId = Date.now();
      setPendingSystemPiP(true);
      setSystemPiPCaptureActive(true);
      setSystemPiPCaptureRequestId(requestId);
      setAllowVideoRender(!placeholderOnlyHome);
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
  const returnToCall = useCallback((opts?: { preferAudioOnlyUi?: boolean }) => {
    const g = (global as any);
    const nav = g.__navRef;
    const currentRouteName = nav?.getCurrentRoute?.()?.name as string | undefined;
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
            gGuard.__endingCallInProgressRef.current = false;
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
    if (Platform.OS === 'android') {
      try { NativeModules.LiviAppModule?.clearSystemPiPReenterSuppress?.(); } catch (_) {}
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

    const wasSystemPiP =
      inSystemPiPMode || g.__pipInSystemModeRef?.current === true;

    const finishReturnToCallAfterNav = () => {
      const tailMs = preferAudioOnlyUi ? 80 : 160;
      setTimeout(() => {
        setSuppressOverlayForReturn(false);
        releaseReturnToCallInFlight();
        reenableAndroidSystemPiPLeaveHintAfterReturn();
      }, tailMs);
    };

    const isOnVideoCallRoute = (): boolean => {
      try {
        return nav?.getCurrentRoute?.()?.name === 'VideoCall';
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
      if (preferAudioOnlyUi) {
        prepareDirectCallAudioReturnFromPiP();
      } else {
        g.__preferAudioOnlyUiOnNextVideoCallRef.current = false;
        g.__expandToVideoCallUiFromPiPRef.current = true;
      }
    } catch (_) {}
    syncSessionPiPState(false, preferAudioOnlyUi ? 'returnToAudioCall' : 'returnToCall');
    
    // Guard от двойной навигации
    if (navigatingRef.current) {
      releaseReturnToCallInFlight();
      return;
    }

    const doNavigate = (cid: string, rid: string, navParams?: any) => {
      const params = {
        ...(navParams ?? {}),
        resume: true,
        fromPiP: true,
        ...(preferAudioOnlyUi
          ? { audioOnlyPiPReturn: true, preferVideoCallUi: undefined }
          : { preferVideoCallUi: true }),
        systemPiPReturnToken: Number(g.__systemPiPReturnTokenRef?.current || Date.now()),
        directCall: true,
        directInitiator: undefined,
        callId: cid,
        roomId: rid,
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
        const currentRouteName = nav?.getCurrentRoute?.()?.name as string | undefined;
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
    g.__pipReturnToCallRef = { current: () => returnToCall({ preferAudioOnlyUi: false }) };
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
    if (patch.isMuted !== undefined) setIsMuted(patch.isMuted);
    if (patch.isRemoteMuted !== undefined) setIsRemoteMuted(patch.isRemoteMuted);
    if (patch.localCamOn !== undefined) setLocalCamOn(patch.localCamOn);
    if (patch.remoteCamOn !== undefined) {
      setRemoteCamOn(patch.remoteCamOn);
      if (patch.remoteCamOn === true) {
        setRemoteStreamVersion((v) => v + 1);
      }
    }
    if (patch.pipPos) setPipPos(patch.pipPos);
    if (patch.allowVideoRender !== undefined) setAllowVideoRender(!!patch.allowVideoRender);
    if (patch.inSystemPiPMode !== undefined) setInSystemPiPMode(!!patch.inSystemPiPMode);
    if (patch.pendingSystemPiP !== undefined) setPendingSystemPiP(!!patch.pendingSystemPiP);
    if (patch.systemPiPCaptureActive !== undefined) setSystemPiPCaptureActive(!!patch.systemPiPCaptureActive);
    if (patch.systemPiPCaptureRequestId !== undefined) setSystemPiPCaptureRequestId(Number(patch.systemPiPCaptureRequestId || 0));
    if (patch.decorSizeForPiP !== undefined) setDecorSizeForPiP(patch.decorSizeForPiP ?? null);
    if (patch.lastNavParams !== undefined) setLastNavParams(patch.lastNavParams);
    // потоки через ref:
    if (patch.localStream !== undefined) localStreamRef.current = patch.localStream;
    if (patch.remoteStream !== undefined) {
      remoteStreamRef.current = patch.remoteStream;
      setRemoteStreamVersion((v) => v + 1);
    }
    if (patch.pipRemoteViewKey !== undefined) {
      const k = Number(patch.pipRemoteViewKey) || 0;
      setPipRemoteViewKey(k);
      setRemoteStreamVersion((v) => v + 1);
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
