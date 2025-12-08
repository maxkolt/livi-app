import { useCallback, useRef, useEffect } from 'react';
import { BackHandler, PanResponder } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { usePiP as usePiPContext } from '../../../src/pip/PiPContext';
import { logger } from '../../../utils/logger';
import socket from '../../../sockets/socket';

interface UsePiPProps {
  roomId: string | null;
  callId: string | null;
  partnerId: string | null;
  partnerUserId: string | null;
  isInactiveState: boolean;
  wasFriendCallEnded: boolean;
  micOn: boolean;
  remoteMuted: boolean;
  localStream: any;
  remoteStream: any;
  friends: any[];
  routeParams?: any;
  session?: any; // VideoCallSession
  acceptCallTimeRef: React.MutableRefObject<number>;
}

/**
 * Хук для управления PiP (Picture-in-Picture)
 * Обрабатывает вход/выход, блокировку в первые 30 секунд, работу с navigate(), восхождение стримов после выхода
 */
export const usePiP = ({
  roomId,
  callId,
  partnerId,
  partnerUserId,
  isInactiveState,
  wasFriendCallEnded,
  micOn,
  remoteMuted,
  localStream,
  remoteStream,
  friends,
  routeParams,
  session,
  acceptCallTimeRef,
}: UsePiPProps) => {
  const navigation = useNavigation();
  const pip = usePiPContext();
  const pipRef = useRef(pip);
  
  useEffect(() => {
    pipRef.current = pip;
  }, [pip]);

  // Функция для входа в PiP - ЗАКОММЕНТИРОВАНО
  const enterPiPMode = useCallback(() => {
    // ЗАКОММЕНТИРОВАНО: Логика входа в PiP отключена
    logger.info('[usePiP] enterPiPMode вызван, но ЗАКОММЕНТИРОВАНО', {
      roomId,
      callId,
      partnerId,
      isInactiveState,
      wasFriendCallEnded,
      pipVisible: pip.visible
    });
    return;
    
    /* ЗАКОММЕНТИРОВАНО
    // Не показываем PiP если звонок завершен
    const hasActiveCall = (!!roomId || !!callId || !!partnerId) && !isInactiveState && !wasFriendCallEnded;

    logger.info('[usePiP] enterPiPMode - hasActiveCall:', hasActiveCall);

    // Закрываем PiP если звонок завершен
    if ((isInactiveState || wasFriendCallEnded) && pip.visible) {
      logger.info('[usePiP] Закрываем PiP - звонок завершен');
      pip.hidePiP();
      if (session && session.exitPiP) {
        session.exitPiP();
      }
      return;
    }

    if (hasActiveCall && !pip.visible) {
      logger.info('[usePiP] Показываем PiP');
      // Показываем PiP
      const partner = partnerUserId 
        ? friends.find(f => String(f._id) === String(partnerUserId))
        : null;

      let avatarUrl: string | undefined = undefined;
      if (partner?.avatar && typeof partner.avatar === 'string' && partner.avatar.trim() !== '') {
        const SERVER_CONFIG = require('../../../src/config/server').SERVER_CONFIG;
        const serverUrl = SERVER_CONFIG.BASE_URL;
        avatarUrl = partner.avatar.startsWith('http') 
          ? partner.avatar 
          : `${serverUrl}${partner.avatar.startsWith('/') ? '' : '/'}${partner.avatar}`;
      }

      pip.showPiP({
        callId: callId || '',
        roomId: roomId || '',
        partnerName: partner?.nick || 'Друг',
        partnerAvatarUrl: avatarUrl,
        muteLocal: !micOn,
        muteRemote: remoteMuted,
        localStream: localStream || null,
        remoteStream: remoteStream || null,
        navParams: {
          ...routeParams,
          peerUserId: partnerUserId,
          partnerId: partnerId,
        } as any,
      });

      // При входе в PiP камера НЕ выключается - она остается в режиме ожидания/сна
      if (session && typeof session.enterPiP === 'function') {
        session.enterPiP();
      }

      logger.info('[usePiP] Вход в PiP через Swipe Left to Right или BackHandler - УСПЕШНО');
    } else {
      logger.info('[usePiP] enterPiPMode - НЕ показываем PiP', {
        hasActiveCall,
        pipVisible: pip.visible
      });
    }
    */
  }, [roomId, callId, partnerId, isInactiveState, wasFriendCallEnded, pip.visible, friends, partnerUserId, micOn, remoteMuted, localStream, remoteStream, routeParams, session]);

  // Обработка BackHandler - ЗАКОММЕНТИРОВАНО
  useEffect(() => {
    // ЗАКОММЕНТИРОВАНО: BackHandler для PiP отключен
    /* ЗАКОММЕНТИРОВАНО
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      const hasActiveCall = (!!roomId || !!callId || !!partnerId) && !isInactiveState && !wasFriendCallEnded;

      if (hasActiveCall && !pip.visible) {
        enterPiPMode();
        return true; // Предотвращаем закрытие
      }

      return false; // Разрешаем закрытие если нет активного звонка
    });

    return () => backHandler.remove();
    */
  }, [enterPiPMode, roomId, callId, partnerId, isInactiveState, wasFriendCallEnded, pip.visible]);

  // Обработка Swipe Left to Right для входа в PiP - ЗАКОММЕНТИРОВАНО
  const panResponder = useRef(
    PanResponder.create({
      // ЗАКОММЕНТИРОВАНО: PanResponder для PiP отключен
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: () => false, // Не реагируем на свайпы
      onPanResponderRelease: () => {}, // Пустой обработчик
      /* ЗАКОММЕНТИРОВАНО
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // Реагируем только на горизонтальные свайпы слева направо
        const { dx, dy } = gestureState;
        const shouldRespond = Math.abs(dx) > 10 && dx > 0 && Math.abs(dx) > Math.abs(dy);
        if (shouldRespond) {
          logger.debug('[usePiP] PanResponder Move detected - будет реагировать', { dx, dy, shouldRespond });
        }
        return shouldRespond;
      },
      onPanResponderRelease: (_, gestureState) => {
        const { dx, vx } = gestureState;
        logger.debug('[usePiP] PanResponder Release', { dx, vx, threshold: dx > 50 || vx > 0.5 });
        // Если свайп слева направо достаточно большой (больше 50px) или быстрый (vx > 0.5)
        if (dx > 50 || vx > 0.5) {
          logger.info('[usePiP] Swipe Left to Right detected, entering PiP', { dx, vx });
          enterPiPMode();
        }
      },
      */
    })
  ).current;

  return {
    enterPiPMode,
    panResponder,
    pip,
    pipRef,
  };
};
