// src/pip/PiPContext.tsx
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { CommonActions } from '@react-navigation/native';
import socket from '../../sockets/socket';

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

  // позиция PiP
  pipPos: { x: number; y: number };

  // VAD (отключен, всегда 0)
  remoteLevel: number;

  // Уровень микрофона для эквалайзера
  micLevel: number;
  // Частотные полосы для эквалайзера (как в видеочате)
  micFrequencyLevels?: number[];

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
    muteLocal?: boolean;
    muteRemote?: boolean;
    navParams?: any; // ← кто нас вызвал (для корректного возврата)
  }) => void;

  hidePiP: () => void;
  updatePiPPosition: (x: number, y: number) => void;

  toggleMic: () => void;
  toggleRemoteAudio: () => void;

  returnToCall: () => void;
  endCall: () => void;

  // VAD API (отключен, пустые функции)
  startRemoteVAD: (pc: any, intervalMs?: number) => void;
  stopRemoteVAD: () => void;

  // служебное
  updatePiPState: (patch: Partial<PiPState>) => void;
};

const PiPContext = createContext<PiPState | null>(null);

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
  const [partnerName, setPartnerName] = useState<string>('Друг');
  const [partnerAvatarUrl, setPartnerAvatarUrl] = useState<string | undefined>(undefined);

  const [isMuted, setIsMuted] = useState(false);
  const [isRemoteMuted, setIsRemoteMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micFrequencyLevels, setMicFrequencyLevels] = useState<number[]>(() => new Array(21).fill(0));

  const localStreamRef = useRef<MediaStreamLike | null>(null);
  const remoteStreamRef = useRef<MediaStreamLike | null>(null);

  const [pipPos, setPipPos] = useState({ x: 12, y: 120 });

  // для возврата
  const [lastNavParams, setLastNavParams] = useState<any>(undefined);

  // guard от двойной навигации
  const navigatingRef = useRef(false);

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
    muteLocal?: boolean;
    muteRemote?: boolean;
    navParams?: any; // ← кто нас вызвал (для корректного возврата)
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
    
    setCallId(p.callId);
    setRoomId(p.roomId);
    setPartnerName(p.partnerName || 'Друг');
    // Убеждаемся, что partnerAvatarUrl сохраняется правильно
    // Используем строгую проверку: сохраняем только если это непустая строка
    if (p.partnerAvatarUrl && typeof p.partnerAvatarUrl === 'string' && p.partnerAvatarUrl.trim() !== '') {
      setPartnerAvatarUrl(p.partnerAvatarUrl.trim());
    } else {
      setPartnerAvatarUrl(undefined);
    }
    if (p.localStream !== undefined) localStreamRef.current = p.localStream ?? null;
    if (p.remoteStream !== undefined) remoteStreamRef.current = p.remoteStream ?? null;
    if (typeof p.muteLocal === 'boolean') setIsMuted(!!p.muteLocal);
    if (typeof p.muteRemote === 'boolean') setIsRemoteMuted(!!p.muteRemote);
    setLastNavParams(p.navParams); // сохраняем navParams для возврата
    setVisible(true);
    
    console.log('[PiPContext] ✅ PiP состояние установлено, visible=true');
  }, []);

  const hidePiP = useCallback(() => {
    setVisible(false);
  }, []);

  const updatePiPPosition = useCallback((x: number, y: number) => setPipPos({ x, y }), []);

  const toggleMic = useCallback(() => {
    // КРИТИЧНО: Вызываем функцию toggleMic из VideoCall напрямую
    // VideoCall.toggleMic переключит трек и обновит состояние PiP
    // Это нужно чтобы избежать конфликта между локальным переключением и переключением в VideoCall
    try {
      const toggleMicFn = (global as any).__toggleMicRef?.current;
      if (toggleMicFn && typeof toggleMicFn === 'function') {
        toggleMicFn();
        // Состояние isMuted обновится через pip.updatePiPState в VideoCall.toggleMic
      } else {
        // Fallback: переключаем локально если функция не зарегистрирована
        const audioTrack = localStreamRef.current?.getAudioTracks?.()?.[0];
        if (audioTrack) {
          const next = !audioTrack.enabled;
          audioTrack.enabled = next;
          setIsMuted(!next);
        } else {
          setIsMuted(prev => !prev);
        }
      }
    } catch (e) {
      console.warn('[PiPContext] Error calling VideoCall toggleMic:', e);
      // Fallback при ошибке
      const audioTrack = localStreamRef.current?.getAudioTracks?.()?.[0];
      if (audioTrack) {
        const next = !audioTrack.enabled;
        audioTrack.enabled = next;
        setIsMuted(!next);
      } else {
        setIsMuted(prev => !prev);
      }
    }
  }, []);

  const toggleRemoteAudio = useCallback(() => {
    // КРИТИЧНО: Вызываем функцию toggleRemoteAudio из VideoCall напрямую (как в эталонном файле)
    // VideoCall.toggleRemoteAudio переключит трек и обновит состояние PiP
    // Это нужно чтобы избежать конфликта между локальным переключением и переключением в VideoCall
    try {
      const toggleRemoteAudioFn = (global as any).__toggleRemoteAudioRef?.current;
      if (toggleRemoteAudioFn && typeof toggleRemoteAudioFn === 'function') {
        toggleRemoteAudioFn();
        // Состояние isRemoteMuted обновится через pip.updatePiPState в VideoCall.toggleRemoteAudio
      } else {
        // Fallback: переключаем локально если функция не зарегистрирована
        const audioTracks = remoteStreamRef.current?.getAudioTracks?.() ?? [];
        const nextMuted = !isRemoteMuted;
        audioTracks.forEach((t: any) => (t.enabled = !nextMuted));
        setIsRemoteMuted(nextMuted);
      }
    } catch (e) {
      console.warn('[PiPContext] Error calling VideoCall toggleRemoteAudio:', e);
      // Fallback при ошибке
      const audioTracks = remoteStreamRef.current?.getAudioTracks?.() ?? [];
      const nextMuted = !isRemoteMuted;
      audioTracks.forEach((t: any) => (t.enabled = !nextMuted));
      setIsRemoteMuted(nextMuted);
    }
  }, [isRemoteMuted]);

  const returnToCall = useCallback(() => {
    console.log('🔥🔥🔥 [PiPContext] returnToCall вызван', { callId, roomId, lastNavParams });
    
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
      // Fallback: используем onReturnToCall если navRef недоступен
      if (callId && roomId) {
        onReturnToCall?.(callId, roomId);
        hidePiP();
      }
      return;
    }

    // КРИТИЧНО: Проверяем что навигация готова перед использованием
    if (!nav.isReady || !nav.isReady()) {
      console.warn('[PiPContext] Navigation not ready, using onReturnToCall fallback');
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
  }, [callId, roomId, onEndCall, stopRemoteVAD]);

  // Обработчик завершения звонка для пользователя в PiP
  useEffect(() => {
    const onCallEnded = (data?: any) => {
      // КРИТИЧНО: Проверяем что это НАШ звонок (строгое совпадение callId или roomId)
      // НЕ закрываем PiP при любом call:ended - только если это наш звонок
      const callMatches = visible && (
        (data?.callId && callId && callId === data.callId) ||
        (data?.roomId && roomId && roomId === data.roomId)
      );

      if (callMatches) {
        console.log('[PiPContext] Call ended event received, closing PiP:', { 
          data, 
          currentCallId: callId, 
          currentRoomId: roomId,
          receivedCallId: data?.callId,
          receivedRoomId: data?.roomId
        });
        // КРИТИЧНО: Когда приходит call:ended от сервера (другой участник завершил звонок),
        // нужно только очистить PiP и состояние, НЕ вызывать onEndCall
        // так как звонок уже завершен на сервере и session.endCall() уже был вызван другим участником
        // или будет вызван через handleExternalCallEnded в session.ts
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
  }, [visible, callId, roomId, onEndCall, endCall]);

  const updatePiPState = useCallback((patch: Partial<PiPState>) => {
    if (patch.callId !== undefined) setCallId(patch.callId);
    if (patch.roomId !== undefined) setRoomId(patch.roomId);
    if (patch.partnerName !== undefined) setPartnerName(patch.partnerName);
    if (patch.partnerAvatarUrl !== undefined) setPartnerAvatarUrl(patch.partnerAvatarUrl);
    if (patch.visible !== undefined) setVisible(patch.visible);
    if (patch.isMuted !== undefined) setIsMuted(patch.isMuted);
    if (patch.isRemoteMuted !== undefined) setIsRemoteMuted(patch.isRemoteMuted);
    if (patch.micLevel !== undefined) setMicLevel(patch.micLevel);
    if (patch.micFrequencyLevels !== undefined) setMicFrequencyLevels(patch.micFrequencyLevels ?? new Array(21).fill(0));
    if (patch.pipPos) setPipPos(patch.pipPos);
    // потоки через ref:
    if (patch.localStream !== undefined) localStreamRef.current = patch.localStream;
    if (patch.remoteStream !== undefined) remoteStreamRef.current = patch.remoteStream;
  }, []);

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
    pipPos,
    remoteLevel,
    micLevel,
    micFrequencyLevels,
    lastNavParams,

    // actions
    showPiP,
    hidePiP,
    updatePiPPosition,
    toggleMic,
    toggleRemoteAudio,
    returnToCall,
    endCall,
    startRemoteVAD,
    stopRemoteVAD,
    updatePiPState,
  }), [
    visible, callId, roomId, partnerName, partnerAvatarUrl,
    isMuted, isRemoteMuted, pipPos, remoteLevel, micLevel, micFrequencyLevels,
    showPiP, hidePiP, updatePiPPosition, toggleMic, toggleRemoteAudio,
    returnToCall, endCall, startRemoteVAD, stopRemoteVAD, updatePiPState
  ]);

  return (
    <PiPContext.Provider value={value}>
      {children}
    </PiPContext.Provider>
  );
}
