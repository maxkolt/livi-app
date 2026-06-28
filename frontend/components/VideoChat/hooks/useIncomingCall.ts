import { useState, useEffect, useCallback, useRef } from 'react';
import { Keyboard, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { onCallIncoming, onCallCanceled, acceptCall, declineCall, warmCallSignaling, beginEarlyIncomingCallAccept } from '../../../sockets/socket';
import socket, { emitPresenceUpdateIfChanged } from '../../../sockets/socket';
import { logger } from '../../../utils/logger';
import { startIncomingCallAlert, stopIncomingCallAlert } from '../../../utils/incomingCallAlert';
import { syncAppBadgeFromMissedCount } from '../../../utils/pushNotifications';
import { emitMissedClear } from '../../../utils/globalEvents';
import { readRootNavigationState } from '../../../utils/safeRootNavigation';

interface UseIncomingCallProps {
  myUserId?: string;
  routeParams?: any;
  friendCallAccepted: boolean;
  currentCallIdRef: React.MutableRefObject<string | null>;
  session?: any; // VideoCallSession (может быть null при первом вызове)
  /** Текущий собеседник на экране видеозвонка; входящий от него при активном звонке игнорируем (дубликат после отмены на нативном экране у звонящего). */
  partnerUserId?: string | null;
  /** Есть активный звонок (комната/партнёр) — вместе с partnerUserId отфильтровываем дубликаты call:incoming. */
  hasActiveCallWithPartner?: boolean;
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
  partnerUserId,
  hasActiveCallWithPartner,
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
    // Android: входящий показываем нативным экраном (IncomingCallActivity) из App.tsx.
    // Внутри экрана видеозвонка/пира не рисуем кастомный RN-оверлей.
    if (Platform.OS === 'android') return;
    const offIncoming = onCallIncoming?.((d) => {
      // Не показывать входящий от того же собеседника, с которым уже идёт активный звонок (дубликат после отмены на нативном экране у звонящего)
      if (hasActiveCallWithPartner && partnerUserId && String(d?.from) === String(partnerUserId)) {
        logger.debug('[useIncomingCall] Ignoring incoming from current partner (active call)', { from: d?.from, partnerUserId });
        return;
      }

      // Фиксируем экран на момент входящего звонка, чтобы вернуть пользователя туда после завершения
      try {
        const state = readRootNavigationState();
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
      warmCallSignaling();
      void (sessionRef.current as any)?.prewarmLocalTracks?.();
    });

    return () => {
      offIncoming?.();
    };
  }, [hasActiveCallWithPartner, partnerUserId]);

  // 🔔 Рингтон/вибрация для входящего (когда входящий показывается внутри экрана звонка/пира)
  useEffect(() => {
    if (incomingOverlay && incomingCall && !friendCallAccepted) {
      // Если где-то открыт инпут (например чат) — убираем клавиатуру,
      // иначе она может перекрыть UI входящего.
      try { Keyboard.dismiss(); } catch {}
      startIncomingCallAlert();
    } else {
      stopIncomingCallAlert();
    }
    return () => {
      stopIncomingCallAlert();
    };
  }, [incomingOverlay, incomingCall, friendCallAccepted]);

  // Обработка отмены звонка (инкремент пропущенного делается централизованно в App.tsx — здесь только закрываем UI)
  useEffect(() => {
    const offCancel = onCallCanceled?.(async (d: any) => {
      const isFriendCall = !!routeParams?.directCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) return;

      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      setIncomingCall(null);
      stopIncomingCallAlert();
    });

    return () => {
      offCancel?.();
    };
  }, [routeParams?.directCall, friendCallAccepted, currentCallIdRef]);

  // Обработка таймаута звонка (инкремент пропущенного — централизованно в App.tsx, здесь только UI и cleanup)
  useEffect(() => {
    const handleTimeout = () => {
      const isFriendCall = !!routeParams?.directCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) return;

      if (session) {
        session.cleanupAfterFriendCallFailure?.('timeout');
      }

      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      setIncomingCall(null);
      stopIncomingCallAlert();
    };

    socket.on('call:timeout', handleTimeout);

    return () => {
      socket.off('call:timeout', handleTimeout);
    };
  }, [routeParams?.directCall, friendCallAccepted, session, currentCallIdRef]);

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
      stopIncomingCallAlert();

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

  // Обработка call:declined через socket (получатель — инициатор; отклонил тот, кому звонили)
  useEffect(() => {
    const handleDeclined = (d?: any) => {
      const isFriendCall = !!routeParams?.directCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) return;

      // Пропущенным не считаем: тот, кому звонили, явно отклонил — счётчик не увеличиваем
      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      setIncomingCall(null);
      stopIncomingCallAlert();
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
    // Android: входящий показываем нативным экраном (IncomingCallActivity) из App.tsx.
    // Внутри экрана видеозвонка не включаем RN-оверлей даже если session сообщает incomingCall.
    if (Platform.OS === 'android') return;
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
      warmCallSignaling();
      void (currentSession as any)?.prewarmLocalTracks?.();
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

    warmCallSignaling();
    beginEarlyIncomingCallAccept(finalCallId);

    // Принимаем вызов через session (используем ref для получения актуального session)
    // КРИТИЧНО: Вызываем ТОЛЬКО session.acceptCall(), который сам отправляет call:accept
    // Не вызываем acceptCall() напрямую, чтобы избежать двойной отправки
    const currentSession = sessionRef.current;
    if (currentSession) {
      try {
        await (currentSession as any).acceptCall?.(finalCallId, fromUserId);
        logger.info('[useIncomingCall] ✅ Звонок принят через session', { callId: finalCallId, fromUserId });
      } catch (e) {
        logger.error('[useIncomingCall] ❌ Ошибка принятия звонка через session:', e);
      }
    } else {
      // Fallback: если session нет (не должно происходить), отправляем напрямую
      if (finalCallId) {
        acceptCall(finalCallId);
        logger.info('[useIncomingCall] ✅ call:accept отправлен через socket (fallback)', { callId: finalCallId });
      }
    }

    // Уведомляем друзей что мы заняты
    try {
      emitPresenceUpdateIfChanged({ status: 'busy', roomId: String(finalCallId) });
    } catch (e) {
      logger.warn('[useIncomingCall] Failed to send presence update:', e);
    }

    // Сбрасываем счётчик пропущенных (AsyncStorage + состояние HomeScreen через emitMissedClear)
    try {
      const key = 'missed_calls_by_user_v1';
      const raw = await AsyncStorage.getItem(key);
      const map = raw ? JSON.parse(raw) : {};
      const uid = String(fromUserId || '');
      if (uid) {
        delete map[uid];
        await AsyncStorage.setItem(key, JSON.stringify(map));
        syncAppBadgeFromMissedCount().catch(() => {});
        emitMissedClear(uid);
      }
    } catch {}

    // Закрываем оверлей
    setIncomingOverlay(false);
    setIncomingFriendCall(null);
    setIncomingCall(null);
    stopIncomingCallAlert();

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
    stopIncomingCallAlert();

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
