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

  // позиция PiP
  pipPos: { x: number; y: number };

  // VAD (отключен, всегда 0)
  remoteLevel: number;

  // Эквалайзер отключен

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

  toggleMic: () => void;
  toggleRemoteAudio: () => void;
  toggleCam: () => void;

  returnToCall: () => void;
  endCall: () => void;

  /** Разрешать рендер RTCView в PiP только после задержки (экран звонка успел размонтироваться). */
  allowVideoRender: boolean;

  /** true = системный PiP (главный экран): только видео + системная кнопка X, без наших кнопок. false = in-app PiP: верхняя панель + видео. */
  inSystemPiPMode: boolean;
  /** true = скоро войдём в системный PiP (VideoCall рисует компактный вид перед входом). */
  pendingSystemPiP: boolean;

  // VAD API (отключен, пустые функции)
  startRemoteVAD: (pc: any, intervalMs?: number) => void;
  stopRemoteVAD: () => void;

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
  /** Инкремент при установке стрима в showPiP — чтобы value контекста обновился и PiPOverlay получил remoteStream. */
  const [remoteStreamVersion, setRemoteStreamVersion] = useState(0);

  // guard от двойной навигации
  const navigatingRef = useRef(false);

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
        try {
          (global as any).__pipInSystemModeRef = (global as any).__pipInSystemModeRef || { current: false };
          (global as any).__pipInSystemModeRef.current = inPiP;
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

  // ====== VAD отключен ======
  // VAD полностью отключен для уменьшения нагрузки
  const remoteLevel = 0; // Всегда 0, визуализация отключена

  const stopRemoteVAD = useCallback(() => {
    // Пустая функция, VAD отключен
  }, []);

  const startRemoteVAD = useCallback((pc: any, intervalMs?: number) => {
    // Пустая функция, VAD отключен
  }, []);


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
    setLastNavParams(p.navParams); // сохраняем navParams для возврата

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

  // AboutToEnterSystemPiP: единый сценарий системного PiP.
  // При Home не показываем in-app PiP и не делаем reset на Home — входим напрямую в системный PiP,
  // чтобы окно PiP содержало видео собеседника с текущего экрана VideoCall.
  useEffect(() => {
    if (Platform.OS !== 'android') return () => {};
    const emitter = new NativeEventEmitter();
    const sub = emitter.addListener('AboutToEnterSystemPiP', () => {
      const g = (global as any);
      const session = g.__webrtcSessionRef?.current;
      if (session && typeof (session as any).isEnded === 'function' && (session as any).isEnded()) return;

      // До входа в системный PiP переводим VideoCall в компактный режим (только удалённое видео),
      // чтобы избежать "чёрных блоков" от лишних SurfaceView/RTCView при захвате окна PiP.
      setPendingSystemPiP(true);
      // Fallback: если по какой-то причине в PiP не вошли, вернём UI обратно.
      setTimeout(() => {
        setPendingSystemPiP(false);
      }, 1500);

      let params = g.__currentCallPiPParamsRef?.current;
      if (!params && session) {
        const cid = typeof (session as any).getCallId === 'function' ? (session as any).getCallId() : null;
        const rid = typeof (session as any).getRoomId === 'function' ? (session as any).getRoomId() : null;
        if (cid || rid) params = { callId: cid || '', roomId: rid || '', partnerName: '', partnerAvatarUrl: undefined, localStream: null, remoteStream: null, localCamOn: true, navParams: undefined };
      }
      if (params?.callId && params?.roomId && NativeModules.LiviAppModule?.setPiPEndCallParams) {
        try { NativeModules.LiviAppModule.setPiPEndCallParams(params.callId, params.roomId); } catch (_) {}
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

  const updatePiPPosition = useCallback((x: number, y: number) => setPipPos({ x, y }), []);

  const toggleMic = useCallback(() => {
    // ✅ Приоритет: дергаем WebRTC session напрямую (работает даже когда экран звонка размонтирован).
    // Это важно для PiP: пользователь уже ушёл с VideoCall экрана, но звонок и аудио продолжаются.
    try {
      const session = (global as any).__webrtcSessionRef?.current;
      if (session && typeof session.toggleMic === 'function') {
        session.toggleMic();
        // UI в PiP обновляем локально (не полагаемся на callbacks из размонтированного экрана)
        setIsMuted((prev) => !prev);
        return;
      }
    } catch {}

    // Второй приоритет: если экран ещё жив и выставил глобальную функцию
    try {
      const toggleMicFn = (global as any).__toggleMicRef?.current;
      if (toggleMicFn && typeof toggleMicFn === 'function') {
        toggleMicFn();
        setIsMuted((prev) => !prev);
        return;
      }
    } catch {}

    // Fallback: переключаем локально через mediaStreamTrack
    try {
      const audioTrack = localStreamRef.current?.getAudioTracks?.()?.[0];
      if (audioTrack) {
        const next = !audioTrack.enabled;
        audioTrack.enabled = next;
        setIsMuted(!next);
      } else {
        setIsMuted((prev) => !prev);
      }
    } catch {
      setIsMuted((prev) => !prev);
    }
  }, []);

  const toggleCam = useCallback(() => {
    try {
      const session = (global as any).__webrtcSessionRef?.current;
      if (session && typeof session.toggleCam === 'function') {
        session.toggleCam();
        setLocalCamOn((prev) => (typeof prev === 'boolean' ? !prev : false));
        return;
      }
    } catch {}
    try {
      const toggleCamFn = (global as any).__toggleCamRef?.current;
      if (toggleCamFn && typeof toggleCamFn === 'function') {
        toggleCamFn();
        setLocalCamOn((prev) => (typeof prev === 'boolean' ? !prev : false));
        return;
      }
    } catch {}
    try {
      const videoTrack = localStreamRef.current?.getVideoTracks?.()?.[0];
      if (videoTrack) {
        const next = !videoTrack.enabled;
        videoTrack.enabled = next;
        setLocalCamOn(next);
      } else {
        setLocalCamOn((prev) => (typeof prev === 'boolean' ? !prev : false));
      }
    } catch {
      setLocalCamOn((prev) => (typeof prev === 'boolean' ? !prev : false));
    }
  }, []);

  const toggleRemoteAudio = useCallback(() => {
    try {
      // ✅ Приоритет: дергаем WebRTC session напрямую (работает когда VideoCall экран размонтирован).
      const session = (global as any).__webrtcSessionRef?.current;
      if (session && typeof session.toggleRemoteAudio === 'function') {
        session.toggleRemoteAudio();
        setIsRemoteMuted((prev) => !prev);
        return;
      }

      // Второй приоритет: если экран ещё жив и выставил глобальную функцию
      const toggleRemoteAudioFn = (global as any).__toggleRemoteAudioRef?.current;
      if (toggleRemoteAudioFn && typeof toggleRemoteAudioFn === 'function') {
        toggleRemoteAudioFn();
        setIsRemoteMuted((prev) => !prev);
        return;
      }

      // Fallback: переключаем локально через MediaStream audio tracks
      const raw = remoteStreamRef.current?.getAudioTracks?.();
      const list: any[] = raw == null ? [] : Array.isArray(raw) ? raw : (raw != null ? [raw] : []);
      setIsRemoteMuted((prev) => {
        const nextMuted = !prev;
        try {
          if (list && typeof list.forEach === 'function') {
            list.forEach((t: any) => {
              try { if (t && typeof t.enabled !== 'undefined') t.enabled = !nextMuted; } catch (_) {}
            });
          }
        } catch (_) {}
        return nextMuted;
      });
    } catch (_) {
      setIsRemoteMuted((prev) => !prev);
    }
  }, [isRemoteMuted]);

  const returnToCall = useCallback(() => {
    // Флаг для App: при выходе из PiP по SystemPiPModeChanged не завершать звонок (пользователь тапнул «вернуться», а не системную X).
    try {
      const r = (global as any).__pipReturnToCallJustPressedRef;
      if (r && typeof r === 'object') r.current = true;
    } catch (_) {}
    console.log('🔥🔥🔥 [PiPContext] returnToCall вызван', { callId, roomId, lastNavParams });

    // Сразу скрываем PiP, чтобы не показывать «приветствие с PiP» перед переходом на VideoCall
    hidePiP();

    // КРИТИЧНО: Сбрасываем флаги системного PiP до навигации, чтобы VideoCall при монтировании
    // рендерил обычный двухкарточный layout (собеседник сверху, вы снизу), а не компактный вид
    // «только удалённое видео на весь экран» — иначе после тапа по PiP экран выглядит «другое».
    setInSystemPiPMode(false);
    setPendingSystemPiP(false);

    // КРИТИЧНО: Сразу отправляем pip:state=false партнеру при возврате из PiP
    // Это гарантирует, что партнер получит уведомление даже если экран еще не получил фокус
    const session = (global as any).__webrtcSessionRef?.current;
    if (session && session.exitPiP && typeof session.exitPiP === 'function') {
      session.exitPiP();
      console.log('[PiPContext] ✅ Вызван session.exitPiP() при returnToCall');
    } else if (roomId) {
      // Fallback: отправляем напрямую если метод недоступен
      try {
        const socket = require('../sockets/socket').default;
        socket.emit('pip:state', {
          inPiP: false,
          from: socket.id,
          roomId: roomId,
        });
        console.log('[PiPContext] ✅ Отправлено pip:state=false напрямую при returnToCall');
      } catch (e) {
        console.warn('[PiPContext] Ошибка отправки pip:state при returnToCall:', e);
      }
    }
    
    // Guard от двойной навигации
    if (navigatingRef.current) {
      console.log('[PiPContext] returnToCall blocked - already navigating');
      return;
    }

    // КРИТИЧНО: Используем навигацию напрямую через глобальную ссылку (как в эталонном файле)
    // Это гарантирует правильную навигацию с параметрами resume и fromPiP
    const nav = (global as any).__navRef;
    if (!nav || !callId || !roomId) {
      console.log('[PiPContext] returnToCall: missing nav/callId/roomId', { hasNav: !!nav, callId, roomId });
      // Fallback: используем onReturnToCall если navRef недоступен
      if (callId && roomId) {
        onReturnToCall?.(callId, roomId);
        hidePiP();
      }
      return;
    }

    // КРИТИЧНО: Проверяем что навигация готова перед использованием
    if (!nav.isReady || !nav.isReady()) {
      console.warn('[PiPContext] returnToCall: Navigation not ready, using onReturnToCall fallback');
      if (callId && roomId) {
        onReturnToCall?.(callId, roomId);
        hidePiP();
      }
      return;
    }

    navigatingRef.current = true;

    // КРИТИЧНО: Используем параметры из lastNavParams для правильного восстановления звонка
    // Это гарантирует, что все параметры (peerUserId, partnerId и т.д.) будут восстановлены
    const params = {
      ...lastNavParams,
      resume: true,
      fromPiP: true,
      directCall: true,
      directInitiator: undefined,
      callId: callId,
      roomId: roomId,
    };

    // КРИТИЧНО: Используем CommonActions.reset для навигации (как в эталонном файле)
    // стек: [Home, VideoCall], активен VideoCall
    try {
      nav.dispatch(
        CommonActions.reset({
          index: 1,
          routes: [{ name: 'Home' as any }, { name: 'VideoCall' as any, params }],
        })
      );
      console.log('[PiPContext] ✅ Navigated to VideoCall with resume params', { params });
      
      // КРИТИЧНО: Скрываем PiP сразу после навигации, чтобы он не оставался видимым на странице видеозвонка
      // Навигация уже произошла синхронно через nav.dispatch(), поэтому можно скрывать PiP сразу
      hidePiP();
      navigatingRef.current = false;
    } catch (e) {
      console.error('[PiPContext] Navigation error:', e);
      navigatingRef.current = false;
      // Fallback на onReturnToCall при ошибке
      if (callId && roomId) {
        onReturnToCall?.(callId, roomId);
      }
      hidePiP();
      return;
    }
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
      // Fallback: если onEndCall не установлен, вызываем session.endCall() напрямую
      const session = (global as any).__webrtcSessionRef?.current;
      if (session && typeof session.endCall === 'function') {
        console.log('🔥 [PiPContext] Вызываем session.endCall() напрямую (onEndCall не установлен)');
        session.endCall();
      } else {
        console.warn('[PiPContext] Session not available and onEndCall not set');
      }
    }
    
    // Затем очищаем состояние PiP
    stopRemoteVAD();
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
  }, [callId, roomId, onEndCall, stopRemoteVAD]);

  // Обработчик завершения звонка для пользователя в PiP
  useEffect(() => {
    const onCallEnded = (data?: any) => {
      // КРИТИЧНО: Проверяем что это НАШ звонок (строгое совпадение callId или roomId)
      // НЕ закрываем PiP при любом call:ended - только если это наш звонок
      const receivedIds = new Set<string>();
      if (typeof data?.callId === 'string' && data.callId) receivedIds.add(data.callId);
      if (typeof data?.roomId === 'string' && data.roomId) receivedIds.add(data.roomId);
      if (typeof data?.resolvedRoomId === 'string' && data.resolvedRoomId) receivedIds.add(data.resolvedRoomId);

      // Backward/forward compatibility:
      // - older backend versions could send callId=roomId (room id only)
      // - newer backend sends callId as the real callId (timestamp) and roomId as room_...
      const callMatches =
        visible &&
        ((callId && receivedIds.has(callId)) ||
          (roomId && receivedIds.has(roomId)));

      if (callMatches) {
        console.log('[PiPContext] Call ended event received, closing PiP:', { 
          data, 
          currentCallId: callId, 
          currentRoomId: roomId,
          receivedCallId: data?.callId,
          receivedRoomId: data?.roomId
        });
        // КРИТИЧНО: Отключаем системный PiP у собеседника, чтобы не выскакивало окно PiP при уходе с экрана
        if (Platform.OS === 'android') {
          try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
        }
        // КРИТИЧНО: Сначала hidePiP() — синхронно сбрасывает __pipVisibleRef и убирает оверлей, чтобы не оставался чёрный экран/замороженное PiP поверх главного
        hidePiP();
        // КРИТИЧНО: Когда приходит call:ended от сервера (другой участник завершил звонок),
        // нужно только очистить PiP и состояние, НЕ вызывать onEndCall
        // так как звонок уже завершен на сервере и session.endCall() уже был вызван другим участником
        // или будет вызван через handleExternalCallEnded в session.ts
        stopRemoteVAD();
        setCallId(null);
        setRoomId(null);
        localStreamRef.current = null;
        remoteStreamRef.current = null;
        setIsMuted(false);
        setIsRemoteMuted(false);
        setPartnerAvatarUrl(undefined);
        setLastNavParams(undefined);
        setLocalCamOn(undefined);
        // Закрыть системное PiP-окно на Android (чёрный прямоугольник + замороженное окно поверх главного экрана)
        if (Platform.OS === 'android') {
          try { NativeModules.LiviAppModule?.requestExitSystemPiP?.(); } catch (_) {}
        }
      } else if (visible && (callId || roomId)) {
        // Логируем, но не обрабатываем, если это не наш звонок
        console.log('[PiPContext] Call ended event received but not for our call, ignoring:', {
          data,
          currentCallId: callId,
          currentRoomId: roomId,
          receivedCallId: data?.callId,
          receivedRoomId: data?.roomId
        });
      }
    };

    // Подписываемся на событие call:ended
    socket.on('call:ended', onCallEnded);

    return () => {
      socket.off('call:ended', onCallEnded);
    };
  }, [visible, callId, roomId, onEndCall, endCall, hidePiP]);

  const updatePiPState = useCallback((patch: Partial<PiPState>) => {
    if (patch.callId !== undefined) setCallId(patch.callId);
    if (patch.roomId !== undefined) setRoomId(patch.roomId);
    if (patch.partnerName !== undefined) setPartnerName(patch.partnerName);
    if (patch.partnerAvatarUrl !== undefined) setPartnerAvatarUrl(patch.partnerAvatarUrl);
    if (patch.visible !== undefined) setVisible(patch.visible);
    if (patch.isMuted !== undefined) setIsMuted(patch.isMuted);
    if (patch.isRemoteMuted !== undefined) setIsRemoteMuted(patch.isRemoteMuted);
    if (patch.pipPos) setPipPos(patch.pipPos);
    if (patch.localCamOn !== undefined) setLocalCamOn(patch.localCamOn);
    if (patch.allowVideoRender !== undefined) setAllowVideoRender(!!patch.allowVideoRender);
    if (patch.inSystemPiPMode !== undefined) setInSystemPiPMode(!!patch.inSystemPiPMode);
    if (patch.pendingSystemPiP !== undefined) setPendingSystemPiP(!!patch.pendingSystemPiP);
    // потоки через ref:
    if (patch.localStream !== undefined) localStreamRef.current = patch.localStream;
    if (patch.remoteStream !== undefined) remoteStreamRef.current = patch.remoteStream;
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

  const value = useMemo<PiPState>(() => ({
    // state
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
    remoteLevel,
    // Эквалайзер отключен
    lastNavParams,

    // actions
    showPiP,
    hidePiP,
    updatePiPPosition,
    toggleMic,
    toggleRemoteAudio,
    toggleCam,
    returnToCall,
    endCall,
    allowVideoRender,
    inSystemPiPMode,
    pendingSystemPiP,
    startRemoteVAD,
    stopRemoteVAD,
    updatePiPState,
  }), [
    visible, callId, roomId, partnerName, partnerAvatarUrl,
    isMuted, isRemoteMuted, localCamOn, pipPos, remoteLevel, allowVideoRender, inSystemPiPMode, pendingSystemPiP, remoteStreamVersion,
    showPiP, hidePiP, updatePiPPosition, toggleMic, toggleRemoteAudio, toggleCam,
    returnToCall, endCall, startRemoteVAD, stopRemoteVAD, updatePiPState
  ]);

  // Не передаём null как children — иначе при обновлении контекста React может вызвать Children.forEach(children) и получить "forEach of null".
  return (
    <PiPContext.Provider value={value}>
      {children ?? <></>}
    </PiPContext.Provider>
  );
}
