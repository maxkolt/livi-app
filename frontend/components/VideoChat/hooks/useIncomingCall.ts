import { useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { onCallIncoming, onCallCanceled, acceptCall, declineCall } from '../../../sockets/socket';
import socket from '../../../sockets/socket';
import { logger } from '../../../utils/logger';

interface UseIncomingCallProps {
  myUserId?: string;
  routeParams?: any;
  friendCallAccepted: boolean;
  currentCallIdRef: React.MutableRefObject<string | null>;
  session?: any; // VideoCallSession (может быть null при первом вызове)
  onAccept?: (callId: string, fromUserId: string) => void;
  onDecline?: (callId: string) => void;
}

/**
 * Хук для обработки входящих звонков
 * Обрабатывает listen socket events, accept/decline, флаги, таймауты
 */
export const useIncomingCall = ({
  myUserId,
  routeParams,
  friendCallAccepted,
  currentCallIdRef,
  session,
  onAccept,
  onDecline,
}: UseIncomingCallProps) => {
  const [incomingFriendCall, setIncomingFriendCall] = useState<{ from: string; nick?: string } | null>(null);
  const [incomingCall, setIncomingCall] = useState<{ callId: string; from: string; fromNick?: string } | null>(null);
  const [incomingOverlay, setIncomingOverlay] = useState<boolean>(false);
  const hadIncomingCallRef = useRef(false);
  const declinedBlockRef = useRef<{ userId: string; until: number } | null>(null);

  // Функция увеличения счетчика пропущенных звонков
  const incMissed = useCallback(async (userId?: string | null) => {
    try {
      const key = 'missed_calls_by_user_v1';
      const raw = await AsyncStorage.getItem(key);
      const map = raw ? JSON.parse(raw) : {};
      const uid = String(userId || incomingFriendCall?.from || '');
      if (uid) {
        map[uid] = (map[uid] || 0) + 1;
        await AsyncStorage.setItem(key, JSON.stringify(map));
      }
    } catch (e) {
      logger.warn('[useIncomingCall] Error incrementing missed calls:', e);
    }
  }, [incomingFriendCall]);

  // Функции для управления блокировкой отклоненных звонков
  const setDeclinedBlock = useCallback((userId: string, duration: number) => {
    declinedBlockRef.current = { userId, until: Date.now() + duration };
  }, []);

  const clearDeclinedBlock = useCallback(() => {
    declinedBlockRef.current = null;
  }, []);

  const getDeclinedBlock = useCallback(() => {
    const block = declinedBlockRef.current;
    if (block && Date.now() < block.until) {
      return block;
    }
    declinedBlockRef.current = null;
    return null;
  }, []);

  // Обработка входящих звонков через socket
  useEffect(() => {
    const offIncoming = onCallIncoming?.((d) => {
      // Фиксируем экран на момент входящего звонка, чтобы вернуть пользователя туда после завершения
      try {
        const nav = (global as any).__navRef;
        const state = nav?.getRootState?.();
        const idx = state?.index ?? 0;
        const routes = state?.routes || [];
        const cur = routes[idx];
        if (cur?.name) {
          // callOriginRef можно сохранить в родительском компоненте
        }
      } catch {}

      setIncomingCall(d);
      setIncomingOverlay(true);
      setIncomingFriendCall({ from: d.from, nick: d.fromNick });
      hadIncomingCallRef.current = true;
    });

    return () => {
      offIncoming?.();
    };
  }, []);

  // Обработка отмены звонка
  useEffect(() => {
    const offCancel = onCallCanceled?.(async (d) => {
      // ВАЖНО: Это событие ТОЛЬКО для звонков друзей, НЕ для рандомного чата
      const isFriendCall = !!routeParams?.directCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) {
        return;
      }

      // Отмена инициатором — закрыть оверлей и отметить пропущенный
      const from = d?.from ? String(d.from) : undefined;
      if (from && from !== String(myUserId || '')) {
        await incMissed(from);
      }

      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      setIncomingCall(null);
    });

    return () => {
      offCancel?.();
    };
  }, [routeParams?.directCall, friendCallAccepted, myUserId, incMissed, currentCallIdRef]);

  // Обработка таймаута звонка (call:timeout)
  useEffect(() => {
    const handleTimeout = () => {
      // ВАЖНО: Это событие ТОЛЬКО для звонков друзей, НЕ для рандомного чата
      const isFriendCall = !!routeParams?.directCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) {
        return;
      }

      // Очищаем WebRTC состояние
      if (session) {
        session.cleanupAfterFriendCallFailure?.('timeout');
      }

      const uid = incomingFriendCall?.from ? String(incomingFriendCall.from) : undefined;
      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      setIncomingCall(null);
      if (uid) {
        incMissed(uid);
      }
    };

    socket.on('call:timeout', handleTimeout);

    return () => {
      socket.off('call:timeout', handleTimeout);
    };
  }, [routeParams?.directCall, friendCallAccepted, incomingFriendCall, incMissed, session, currentCallIdRef]);

  // Обработка "занят" (call:busy)
  useEffect(() => {
    const handleBusy = () => {
      // ВАЖНО: Это событие ТОЛЬКО для звонков друзей, НЕ для рандомного чата
      const isFriendCall = !!routeParams?.directCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) {
        return;
      }

      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      setIncomingCall(null);

      // Очищаем WebRTC состояние при call:busy
      if (session) {
        session.cleanupAfterFriendCallFailure?.('busy');
      }
    };

    socket.on('call:busy', handleBusy);

    return () => {
      socket.off('call:busy', handleBusy);
    };
  }, [routeParams?.directCall, friendCallAccepted, session, currentCallIdRef]);

  // Обработка call:declined через socket
  useEffect(() => {
    const handleDeclined = () => {
      // ВАЖНО: Это событие ТОЛЬКО для звонков друзей, НЕ для рандомного чата
      const isFriendCall = !!routeParams?.directCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) {
        return;
      }

      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      setIncomingCall(null);
    };

    socket.on('call:declined', handleDeclined);

    return () => {
      socket.off('call:declined', handleDeclined);
    };
  }, [routeParams?.directCall, friendCallAccepted, currentCallIdRef]);

  // Обработка события incomingCall из session
  // Используем ref для session, чтобы не пересоздавать подписки при каждом изменении
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    const currentSession = sessionRef.current;
    if (!currentSession) return;

    const handleIncomingCall = ({ callId: incomingCallId, fromUser, fromNick }: { callId: string; fromUser: string; fromNick?: string }) => {
      setIncomingFriendCall({ from: fromUser, nick: fromNick });
      if (incomingCallId) {
        setIncomingCall({ callId: incomingCallId, from: fromUser, fromNick });
        currentCallIdRef.current = incomingCallId;
      }
      setIncomingOverlay(true);
      hadIncomingCallRef.current = true;
    };

    currentSession.on('incomingCall', handleIncomingCall);

    return () => {
      if (currentSession) {
        currentSession.off('incomingCall', handleIncomingCall);
      }
    };
  }, [session, currentCallIdRef]);

  // Функция принятия звонка
  const handleAccept = useCallback(async () => {
    const finalCallId = incomingCall?.callId || currentCallIdRef.current;
    const fromUserId = incomingCall?.from || incomingFriendCall?.from;

    if (!finalCallId || !fromUserId) {
      logger.warn('[useIncomingCall] Cannot accept call - missing callId or fromUserId');
      return;
    }

    // Принимаем вызов через session (используем ref для получения актуального session)
    const currentSession = sessionRef.current;
    if (currentSession) {
      try {
        await (currentSession as any).acceptCall?.(finalCallId, fromUserId);
        logger.info('[useIncomingCall] ✅ Звонок принят через session', { callId: finalCallId, fromUserId });
      } catch (e) {
        logger.error('[useIncomingCall] ❌ Ошибка принятия звонка через session:', e);
      }
    }

    // Также отправляем acceptCall через socket для совместимости
    if (finalCallId) {
      acceptCall(finalCallId);
      logger.info('[useIncomingCall] ✅ call:accept отправлен через socket', { callId: finalCallId });
    }

    // Уведомляем друзей что мы заняты
    try {
      socket.emit('presence:update', { status: 'busy', roomId: finalCallId });
    } catch (e) {
      logger.warn('[useIncomingCall] Failed to send presence update:', e);
    }

    // Сбрасываем счётчик пропущенных
    try {
      const key = 'missed_calls_by_user_v1';
      const raw = await AsyncStorage.getItem(key);
      const map = raw ? JSON.parse(raw) : {};
      const uid = String(fromUserId || '');
      if (uid) {
        map[uid] = 0;
        await AsyncStorage.setItem(key, JSON.stringify(map));
      }
    } catch {}

    // Закрываем оверлей
    setIncomingOverlay(false);
    setIncomingFriendCall(null);
    setIncomingCall(null);

    onAccept?.(finalCallId, fromUserId);
  }, [incomingCall, incomingFriendCall, currentCallIdRef, onAccept]);

  // Функция отклонения звонка
  const handleDecline = useCallback(() => {
    const callIdToDecline = incomingCall?.callId || currentCallIdRef.current;
    if (callIdToDecline) {
      declineCall(callIdToDecline);
    }
    setDeclinedBlock(incomingCall?.from || incomingFriendCall?.from || '', 12000);
    setIncomingFriendCall(null);
    setIncomingCall(null);
    setIncomingOverlay(false);

    onDecline?.(callIdToDecline || '');
  }, [incomingCall, incomingFriendCall, currentCallIdRef, setDeclinedBlock, onDecline]);

  return {
    incomingFriendCall,
    incomingCall,
    incomingOverlay,
    hadIncomingCallRef,
    setIncomingOverlay,
    setIncomingFriendCall,
    setIncomingCall,
    handleAccept,
    handleDecline,
    getDeclinedBlock,
    clearDeclinedBlock,
    setDeclinedBlock,
  };
};
