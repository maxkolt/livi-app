// src/pip/PiPContext.tsx
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { AppState, NativeModules, NativeEventEmitter, Platform } from 'react-native';
import { CommonActions } from '@react-navigation/native';
import socket, { onConnected } from '../../sockets/socket';

type MediaStreamLike = any; // из @livekit/react-native-webrtc

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
    muteLocal?: boolean;
    muteRemote?: boolean;
    navParams?: any; // ← кто нас вызвал (для корректного возврата)
    /**
     * When true, delays making overlay visible by a couple frames.
     * Used on Android BackHandler to avoid PiP flashing before navigation.
     */
    deferVisible?: boolean;
  }) => void;

  hidePiP: () => void;
  updatePiPPosition: (x: number, y: number) => void;

  returnToCall: () => void;
  endCall: () => void;

  /** Разрешать рендер RTCView в PiP только после задержки (экран звонка успел размонтироваться). */
  allowVideoRender: boolean;

  /** true = системный PiP (главный экран): только видео + системная кнопка X, без наших кнопок. false = in-app PiP: верхняя панель + видео. */
  inSystemPiPMode: boolean;
  /** true = скоро войдём в системный PiP (VideoCall рисует компактный вид перед входом). */
  pendingSystemPiP: boolean;
  /** При возврате из системного PiP скрываем оверлей на 1 кадр, чтобы он не мелькнул поверх экрана видеозвонка. */
  suppressOverlayForReturn: boolean;
  /** Размеры decorView с натива для совпадения overlay 9:16 с sourceRect (без чёрных полос в системном PiP). */
  decorSizeForPiP: { width: number; height: number } | null;

  // служебное
  updatePiPState: (patch: Partial<PiPState>) => void;
};

export const PiPContext = createContext<PiPState | null>(null);

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
  // хранит реальный ник партнёра (если есть); фоллбек-лейбл вычисляем в UI по текущему языку
  const [partnerName, setPartnerName] = useState<string>('');
  const [partnerAvatarUrl, setPartnerAvatarUrl] = useState<string | undefined>(undefined);

  const [isMuted, setIsMuted] = useState(false);
  const [isRemoteMuted, setIsRemoteMuted] = useState(false);
  const [inSystemPiPMode, setInSystemPiPMode] = useState(false);
  const [pendingSystemPiP, setPendingSystemPiP] = useState(false);
  // Эквалайзер отключен

  const localStreamRef = useRef<MediaStreamLike | null>(null);
  const remoteStreamRef = useRef<MediaStreamLike | null>(null);
  const [localCamOn, setLocalCamOn] = useState<boolean | undefined>(undefined);
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
  /** Размеры decorView для системного PiP layout (синхрон с buildSystemPiPSourceRect на нативе). */
  const [decorSizeForPiP, setDecorSizeForPiP] = useState<{ width: number; height: number } | null>(null);

  // guard от двойной навигации
  const navigatingRef = useRef(false);

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
  const sendPresenceBusyFromPiP = useCallback(() => {
    if (!visible) return;
    const rid = String(roomId || callId || '').trim();
    if (!rid) return;
    try {
      socket.emit('presence:update', { status: 'busy', roomId: rid });
    } catch {}
  }, [visible, roomId, callId]);

  useEffect(() => {
    if (!visible) return;
    // первичная отправка при показе PiP + при изменении callId/roomId
    sendPresenceBusyFromPiP();
    // переотправка при реконнекте сокета (часто в PiP/фон в релизе)
    const off = onConnected(() => sendPresenceBusyFromPiP());
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
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => setAllowVideoRender(true));
      } else {
        setAllowVideoRender(true);
      }
      return;
    }
    allowVideoRenderTimeoutRef.current = setTimeout(() => {
      allowVideoRenderTimeoutRef.current = null;
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
  // КРИТИЧНО: Обновление state в том же тике, что и нативный переход в PiP, приводит к "forEach of null"
  // (Animated/React при смене transform или перестроении дерева). Откладываем на следующий тик.
  useEffect(() => {
    if (Platform.OS !== 'android') return () => {};
    const emitter = new NativeEventEmitter();
    const sub = emitter.addListener('SystemPiPModeChanged', (payload: { isInPiP?: boolean }) => {
      const inPiP = !!payload?.isInPiP;
      const run = () => {
        setInSystemPiPMode(inPiP);
        if (!inPiP) {
          setDecorSizeForPiP(null);
          // Выход из системного PiP: сразу подавляем оверлей, чтобы он не мелькнул маленьким окном поверх экрана видеозвонка.
          setSuppressOverlayForReturn(true);
        }
        try {
          (global as any).__pipInSystemModeRef = (global as any).__pipInSystemModeRef || { current: false };
          (global as any).__pipInSystemModeRef.current = inPiP;
          console.log('[PiPContext] SystemPiPModeChanged: __pipInSystemModeRef.current =', inPiP);
        } catch (_) {}
        if (inPiP) {
          setPendingSystemPiP(false);
          const session = (global as any).__webrtcSessionRef?.current;
          if (session && typeof (session as any).enterPiP === 'function') (session as any).enterPiP();
        }
      };
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => run());
      } else {
        setTimeout(run, 0);
      }
    });
    return () => sub.remove();
  }, []);

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
    muteLocal?: boolean;
    muteRemote?: boolean;
    navParams?: any; // ← кто нас вызвал (для корректного возврата)
    deferVisible?: boolean;
  }) => {
    console.log('[PiPContext] 🔥 showPiP вызван', {
      callId: p.callId,
      roomId: p.roomId,
      partnerName: p.partnerName,
      hasLocalStream: !!p.localStream,
      hasRemoteStream: !!p.remoteStream,
      muteLocal: p.muteLocal,
      muteRemote: p.muteRemote
    });

    // КРИТИЧНО: Ставим флаг PiP синхронно (до setState), чтобы teardown логика (например, stopSpeaker в хуках)
    // могла увидеть, что PiP уже включен, даже если React effect еще не успел пробежать.
    try {
      (global as any).__pipVisibleRef = (global as any).__pipVisibleRef || { current: false };
      (global as any).__pipVisibleRef.current = true;
    } catch {}
    
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
    setPartnerName(p.partnerName || '');
    // Убеждаемся, что partnerAvatarUrl сохраняется правильно
    // Используем строгую проверку: сохраняем только если это непустая строка
    if (p.partnerAvatarUrl && typeof p.partnerAvatarUrl === 'string' && p.partnerAvatarUrl.trim() !== '') {
      setPartnerAvatarUrl(p.partnerAvatarUrl.trim());
    } else {
      setPartnerAvatarUrl(undefined);
    }
    if (p.localStream !== undefined) localStreamRef.current = p.localStream ?? null;
    if (p.remoteStream !== undefined) {
      remoteStreamRef.current = p.remoteStream ?? null;
      setRemoteStreamVersion((v) => v + 1);
    }
    // При deferVisible (обычно Android Back → навигация назад) можно включать видео сразу:
    // VideoCall уже уходит, поэтому риска "двух RTCView на один stream" практически нет,
    // и PiP появляется сразу с видео собеседника (без мигания плейсхолдера).
    if (Platform.OS === 'android' && p.deferVisible && p.remoteStream) {
      try {
        if (allowVideoRenderTimeoutRef.current) {
          clearTimeout(allowVideoRenderTimeoutRef.current);
          allowVideoRenderTimeoutRef.current = null;
        }
      } catch {}
      setAllowVideoRender(true);
    }
    // localCamOn — источник истины для восстановления после PiP.
    // Если явно не передали, пытаемся вычислить из localStream (best-effort).
    if (typeof p.localCamOn === 'boolean') {
      setLocalCamOn(p.localCamOn);
    } else {
      try {
        const t = (p.localStream as any)?.getVideoTracks?.()?.[0];
        const enabled = t?.enabled;
        if (typeof enabled === 'boolean') {
          setLocalCamOn(enabled);
        }
      } catch {}
    }
    if (typeof p.muteLocal === 'boolean') setIsMuted(!!p.muteLocal);
    if (typeof p.muteRemote === 'boolean') setIsRemoteMuted(!!p.muteRemote);
    // Не затираем navParams undefined-ом: это ломает returnToCall (нечем восстановить экран звонка).
    setLastNavParams((prev: any) => (p.navParams !== undefined ? p.navParams : prev));

    // By default show immediately. On Android BackHandler, defer visibility so navigation can happen first.
    if (p.deferVisible) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Android Back → сначала навигация назад, затем показываем PiP.
          // ВАЖНО: включаем allowVideoRender В ТОТ ЖЕ КАДР, что и visible=true,
          // чтобы PiP не "мигнул" аватаркой/плейсхолдером перед первым кадром видео.
          if (Platform.OS === 'android' && remoteStreamRef.current) {
            try {
              if (allowVideoRenderTimeoutRef.current) {
                clearTimeout(allowVideoRenderTimeoutRef.current);
                allowVideoRenderTimeoutRef.current = null;
              }
            } catch {}
            setAllowVideoRender(true);
          }
          setVisible(true);
          console.log('[PiPContext] ✅ PiP состояние установлено (deferred), visible=true');
        });
      });
    } else {
      setVisible(true);
      console.log('[PiPContext] ✅ PiP состояние установлено, visible=true');
    }
  }, []);

  const hidePiP = useCallback(() => {
    // Сбрасываем флаг синхронно (эффект ниже тоже продублирует)
    try {
      (global as any).__pipVisibleRef = (global as any).__pipVisibleRef || { current: false };
      (global as any).__pipVisibleRef.current = false;
    } catch {}
    setVisible(false);
  }, []);

  // __pipLastContextRef — последний валидный callId/roomId/lastNavParams. Нужен, когда returnToCall вызывается
  // из App по SystemPiPExpanded: на части устройств state (callId, roomId) в этот момент ещё null (системный PiP
  // мог включиться без вызова showPiP). returnToCall использует effectiveCallId = callId || paramsRef?.callId || lastCtx?.callId.
  useEffect(() => {
    try {
      const g = (global as any);
      g.__pipLastContextRef = g.__pipLastContextRef || { current: null };
      g.__pipLastContextRef.current = {
        callId,
        roomId,
        navParams: lastNavParams,
      };
    } catch {}
  }, [callId, roomId, lastNavParams]);

  // AboutToEnterSystemPiP: единый сценарий системного PiP.
  // При Home не показываем in-app PiP и не делаем reset на Home — входим напрямую в системный PiP,
  // чтобы окно PiP содержало видео собеседника с текущего экрана VideoCall.
  useEffect(() => {
    if (Platform.OS !== 'android') return () => {};
    const emitter = new NativeEventEmitter();
    const sub = emitter.addListener('AboutToEnterSystemPiP', () => {
      const g = (global as any);
      // Не входить в PiP без нажатия пользователя: при завершении звонка (переход на Home) onUserLeaveHint может сработать раньше нативного флага.
      if (g.__endingCallInProgressRef?.current === true) return;
      const session = g.__webrtcSessionRef?.current;
      if (session && typeof (session as any).isEnded === 'function' && (session as any).isEnded()) return;

      // До входа в системный PiP переводим VideoCall в компактный режим (только удалённое видео),
      // чтобы избежать "чёрных блоков" от лишних SurfaceView/RTCView при захвате окна PiP.
      const apply = (decorSize: { width: number; height: number } | null) => {
        console.log('[PiPContext] AboutToEnterSystemPiP apply', { decorSize });
        setPendingSystemPiP(true);
        if (decorSize) setDecorSizeForPiP(decorSize);
      };
      NativeModules.LiviAppModule?.getDecorViewSize?.()?.then?.(apply)?.catch?.(() => apply(null));
      if (!NativeModules.LiviAppModule?.getDecorViewSize) apply(null);
      setTimeout(() => {
        setPendingSystemPiP(false);
        setDecorSizeForPiP(null);
      }, 1500);

      let params = g.__currentCallPiPParamsRef?.current;
      if (!params && session) {
        const cid = typeof (session as any).getCallId === 'function' ? (session as any).getCallId() : null;
        const rid = typeof (session as any).getRoomId === 'function' ? (session as any).getRoomId() : null;
        if (cid || rid) params = { callId: cid || '', roomId: rid || '', partnerName: '', partnerAvatarUrl: undefined, localStream: null, remoteStream: null, localCamOn: true, navParams: undefined };
      }
      if (params?.callId && params?.roomId) {
        if (NativeModules.LiviAppModule?.setPiPEndCallParams) {
          try { NativeModules.LiviAppModule.setPiPEndCallParams(params.callId, params.roomId); } catch (_) {}
        }
        // Чтобы returnToCall не получал null: синхронно кладём callId/roomId в контекст при входе в системный PiP.
        const updateFn = g.__pipUpdateStateRef?.current;
        if (typeof updateFn === 'function') updateFn({ callId: params.callId, roomId: params.roomId, lastNavParams: params.navParams });
      }
    });
    return () => sub.remove();
  }, []);

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

  // returnToCall вызывается из App.tsx по событию SystemPiPExpanded (кнопка «развернуть» в системном PiP).
  // Параметры для навигации берутся из state (callId, roomId, lastNavParams), при null — из __currentCallPiPParamsRef
  // и __pipLastContextRef (см. комментарий выше), чтобы возврат работал даже при гонках.
  const returnToCall = useCallback(() => {
    // Сразу подавляем оверлей (чтобы не мелькнул поверх экрана видеозвонка при навигации).
    // ВАЖНО: не оставляем его включённым навсегда — иначе in-app PiP может не показаться на Home на некоторых девайсах.
    setSuppressOverlayForReturn(true);
    const clearSuppressLater = () => {
      // Даем навигации/перерисовке 1-2 кадра и отпускаем подавление.
      setTimeout(() => setSuppressOverlayForReturn(false), 800);
    };
    // Флаг для App: при выходе из PiP по SystemPiPModeChanged не завершать звонок (пользователь тапнул «вернуться», а не системную X).
    try {
      const r = (global as any).__pipReturnToCallJustPressedRef;
      if (r && typeof r === 'object') r.current = true;
    } catch (_) {}
    console.log('🔥🔥🔥 [PiPContext] returnToCall вызван', { callId, roomId, lastNavParams });

    // Если звонок уже завершён (партнёр положил трубку), не переходим на экран звонка — только скрываем PiP
    const session = (global as any).__webrtcSessionRef?.current;
    if (session && typeof session.isEnded === 'function' && session.isEnded()) {
      console.log('[PiPContext] returnToCall: call already ended, closing PiP only');
      hidePiP();
      clearSuppressLater();
      return;
    }

    // КРИТИЧНО: Сбрасываем флаги системного PiP до навигации, чтобы VideoCall при монтировании
    // рендерил обычный двухкарточный layout (собеседник сверху, вы снизу), а не компактный вид
    // «только удалённое видео на весь экран» — иначе после тапа по PiP экран выглядит «другое».
    setInSystemPiPMode(false);
    setPendingSystemPiP(false);

    // КРИТИЧНО: Сразу отправляем pip:state=false партнеру при возврате из PiP
    // Это гарантирует, что партнер получит уведомление даже если экран еще не получил фокус
    const g = (global as any);
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

    const roomIdForPipeState = effectiveRoomId;
    if (sessionForPipeState && sessionForPipeState.exitPiP && typeof sessionForPipeState.exitPiP === 'function') {
      sessionForPipeState.exitPiP();
      console.log('[PiPContext] ✅ Вызван session.exitPiP() при returnToCall');
    } else if (roomIdForPipeState) {
      // Fallback: отправляем напрямую если метод недоступен
      try {
        socket.emit('pip:state', {
          inPiP: false,
          from: socket.id,
          roomId: roomIdForPipeState,
        });
        console.log('[PiPContext] ✅ Отправлено pip:state=false напрямую при returnToCall');
      } catch (e) {
        console.warn('[PiPContext] Ошибка отправки pip:state при returnToCall:', e);
      }
    }
    
    // Guard от двойной навигации
    if (navigatingRef.current) {
      console.log('[PiPContext] returnToCall blocked - already navigating');
      clearSuppressLater();
      return;
    }

    // КРИТИЧНО: Используем навигацию напрямую через глобальную ссылку (как в эталонном файле)
    // Это гарантирует правильную навигацию с параметрами resume и fromPiP
    const nav = g.__navRef;

    const doNavigate = (cid: string, rid: string, navParams?: any) => {
      // Сразу скрываем PiP, чтобы не показывать «приветствие с PiP» перед переходом на VideoCall
      // Скрываем in-app PiP ДО навигации, иначе при открытии экрана VideoCall pip.visible
      // ещё true один кадр — и на экране видеозвонка показывается оверлей PiP поверх всего.
      hidePiP();

      if (!nav || !nav.isReady || !nav.isReady()) {
        console.warn('[PiPContext] returnToCall: Navigation not ready, using onReturnToCall fallback');
        onReturnToCall?.(cid, rid);
        clearSuppressLater();
        return;
      }

      navigatingRef.current = true;
      const params = {
        ...(navParams ?? {}),
        resume: true,
        fromPiP: true,
        directCall: true,
        directInitiator: undefined,
        callId: cid,
        roomId: rid,
      };
      try {
        nav.dispatch(
          CommonActions.reset({
            index: 1,
            routes: [{ name: 'Home' as any }, { name: 'VideoCall' as any, params }],
          })
        );
        console.log('[PiPContext] ✅ Navigated to VideoCall with resume params', { params });
      } catch (e) {
        console.error('[PiPContext] Navigation error:', e);
        onReturnToCall?.(cid, rid);
      } finally {
        navigatingRef.current = false;
        clearSuppressLater();
      }
    };

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
                console.log('[PiPContext] returnToCall: native params missing', { cid, rid });
                clearSuppressLater();
                return;
              }
              doNavigate(cid, rid, effectiveNavParams);
            })
            .catch(() => clearSuppressLater());
          return;
        }
      } catch (_) {}
    }

    console.log('[PiPContext] returnToCall: missing nav/callId/roomId', {
      hasNav: !!nav,
      callId: effectiveCallId,
      roomId: effectiveRoomId,
    });
    clearSuppressLater();
  }, [callId, roomId, lastNavParams, onReturnToCall, hidePiP]);

  // Чтобы по кнопке «развернуть» в системном PiP возвращать на экран видеозвонка (App слушает SystemPiPExpanded и дергает этот ref).
  useEffect(() => {
    (global as any).__pipReturnToCallRef = { current: returnToCall };
    return () => {
      delete (global as any).__pipReturnToCallRef;
    };
  }, [returnToCall]);

  const endCall = useCallback(() => {
    console.log('🔥🔥🔥 [PiPContext] endCall вызван', { callId, roomId });
    
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
        console.log('🔥 [PiPContext] Вызываем session.endCall(callId, roomId) напрямую (onEndCall не установлен)');
        session.endCall(callId ?? undefined, roomId ?? undefined);
      } else if (callId || roomId) {
        try {
          socket.emit('call:end', { callId: callId ?? undefined, roomId: roomId ?? undefined });
          console.log('[PiPContext] Отправлен call:end на сервер (fallback)');
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
  }, [callId, roomId, onEndCall]);

  // Обработчик завершения звонка для пользователя в PiP (в т.ч. когда собеседник завершил из системного PiP).
  // Задержка закрытия у того, кто не нажимал «Завершить»: в системном PiP сокет часто отключён (app in background),
  // поэтому call:ended приходит только после реконнекта; PiP также закрывается по LiveKit (ParticipantDisconnected / Room Disconnected) и при socket reconnect в App.
  useEffect(() => {
    const onCallEnded = (data?: any) => {
      // Закрываем PiP при call:ended и когда in-app PiP виден, и когда в системном PiP (inSystemPiPMode), чтобы у второго пользователя PiP закрывался сразу.
      const shouldClosePiP = (visible || inSystemPiPMode) && (callId || roomId);
      if (!shouldClosePiP) return;

      console.log('[PiPContext] Call ended event received, closing PiP:', {
        data,
        currentCallId: callId,
        currentRoomId: roomId,
        receivedCallId: data?.callId,
        receivedRoomId: data?.roomId,
        inSystemPiPMode,
      });
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
      }
      // Сначала закрываем системный PiP, чтобы окно исчезло быстрее у того, кто получил call:ended.
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.requestExitSystemPiP?.(); } catch (_) {}
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
    if (patch.pendingSystemPiP !== undefined || patch.decorSizeForPiP !== undefined) {
      console.log('[PiPContext] updatePiPState pip', {
        pendingSystemPiP: patch.pendingSystemPiP,
        decorSizeForPiP: patch.decorSizeForPiP ?? null,
      });
    }
    if (patch.callId !== undefined) setCallId(patch.callId);
    if (patch.roomId !== undefined) setRoomId(patch.roomId);
    if (patch.partnerName !== undefined) setPartnerName(patch.partnerName);
    if (patch.partnerAvatarUrl !== undefined) setPartnerAvatarUrl(patch.partnerAvatarUrl);
    if (patch.visible !== undefined) setVisible(patch.visible);
    if (patch.isMuted !== undefined) setIsMuted(patch.isMuted);
    if (patch.isRemoteMuted !== undefined) setIsRemoteMuted(patch.isRemoteMuted);
    if (patch.localCamOn !== undefined) setLocalCamOn(patch.localCamOn);
    if (patch.pipPos) setPipPos(patch.pipPos);
    if (patch.allowVideoRender !== undefined) setAllowVideoRender(!!patch.allowVideoRender);
    if (patch.inSystemPiPMode !== undefined) setInSystemPiPMode(!!patch.inSystemPiPMode);
    if (patch.pendingSystemPiP !== undefined) setPendingSystemPiP(!!patch.pendingSystemPiP);
    if (patch.decorSizeForPiP !== undefined) setDecorSizeForPiP(patch.decorSizeForPiP ?? null);
    if (patch.lastNavParams !== undefined) setLastNavParams(patch.lastNavParams);
    // потоки через ref:
    if (patch.localStream !== undefined) localStreamRef.current = patch.localStream;
    if (patch.remoteStream !== undefined) {
      remoteStreamRef.current = patch.remoteStream;
      setRemoteStreamVersion((v) => v + 1);
    }
  }, []);

  // КРИТИЧНО: Делаем updatePiPState доступным глобально, чтобы WebRTC session могла обновлять PiP,
  // даже когда экран VideoCall размонтирован (PiP работает поверх приложения).
  useEffect(() => {
    (global as any).__pipUpdateStateRef = (global as any).__pipUpdateStateRef || { current: null };
    (global as any).__pipVisibleRef = (global as any).__pipVisibleRef || { current: false };
    (global as any).__pipUpdateStateRef.current = updatePiPState;
    (global as any).__pipVisibleRef.current = visible;
    return () => {
      try { (global as any).__pipUpdateStateRef.current = null; } catch {}
      try { (global as any).__pipVisibleRef.current = false; } catch {}
    };
  }, [updatePiPState, visible]);

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
    suppressOverlayForReturn,
    decorSizeForPiP,
    updatePiPState,
  }), [
    visible, callId, roomId, partnerName, partnerAvatarUrl,
    isMuted, isRemoteMuted, localCamOn, pipPos, allowVideoRender, inSystemPiPMode, pendingSystemPiP, suppressOverlayForReturn, decorSizeForPiP, remoteStreamVersion,
    showPiP, hidePiP, updatePiPPosition, returnToCall, endCall, updatePiPState
  ]);

  // Не передаём null как children — иначе при обновлении контекста React может вызвать Children.forEach(children) и получить "forEach of null".
  return (
    <PiPContext.Provider value={value}>
      {children ?? <></>}
    </PiPContext.Provider>
  );
}
