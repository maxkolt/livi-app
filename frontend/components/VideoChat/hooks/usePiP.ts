import { useCallback, useRef, useEffect } from 'react';
import { BackHandler, PanResponder, Platform, Dimensions } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { usePiP as usePiPContext } from '../../../src/pip/PiPContext';
import { logger } from '../../../utils/logger';
import socket from '../../../sockets/socket';

// КРИТИЧНО: Логирование переходов между состояниями для отладки
const logStateTransition = (from: string, to: string, details?: any) => {
  logger.info(`[usePiP] 🔄 Переход состояния: ${from} → ${to}`, {
    timestamp: Date.now(),
    ...details
  });
};

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

  // Функция для входа в PiP
  const enterPiPMode = useCallback(() => {
    // КРИТИЧНО: Получаем актуальные значения из session если они null в пропсах
    // Это решает проблему когда roomId/callId еще не установлены в state, но есть в session
    // Также проверяем глобальную ссылку на session как fallback
    const currentSession = session || (global as any).__webrtcSessionRef?.current;
    const actualRoomId = roomId || currentSession?.getRoomId?.() || null;
    const actualCallId = callId || currentSession?.getCallId?.() || null;
    const actualPartnerId = partnerId || currentSession?.getPartnerId?.() || null;
    
    logger.info('[usePiP] enterPiPMode вызван', {
      roomId,
      callId,
      partnerId,
      actualRoomId,
      actualCallId,
      actualPartnerId,
      isInactiveState,
      wasFriendCallEnded,
      pipVisible: pip.visible
    });

    // Не показываем PiP если звонок завершен
    // КРИТИЧНО: Используем актуальные значения из session
    const hasActiveCall = (!!actualRoomId || !!actualCallId || !!actualPartnerId) && !isInactiveState && !wasFriendCallEnded;

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
      
      // Выключаем видео локально для экономии (как в эталоне)
      try {
        const stream = localStream;
        stream?.getVideoTracks()?.forEach((t: any) => {
          t.enabled = false;
          logger.info('[usePiP] Disabled local video track for PiP');
        });
      } catch (e) {
        logger.warn('[usePiP] Error disabling local video:', e);
      }
      
      // Показываем PiP
      const partner = partnerUserId 
        ? friends.find(f => String(f._id) === String(partnerUserId))
        : null;

      let avatarUrl: string | undefined = undefined;
      if (partner?.avatar && typeof partner.avatar === 'string' && partner.avatar.trim() !== '') {
        // Получаем BASE_URL из переменных окружения
        // Приоритет: платформо-специфичная переменная > общая переменная > fallback
        const DEFAULT_URL = process.env.EXPO_PUBLIC_SERVER_URL || 'http://192.168.1.12:3000';
        const IOS_URL = process.env.EXPO_PUBLIC_SERVER_URL_IOS || process.env.EXPO_PUBLIC_SERVER_URL || 'http://192.168.1.12:3000';
        const ANDROID_URL = process.env.EXPO_PUBLIC_SERVER_URL_ANDROID || process.env.EXPO_PUBLIC_SERVER_URL || 'http://192.168.1.12:3000';
        const serverUrl = (Platform.OS === 'android' ? ANDROID_URL : IOS_URL).replace(/\/+$/, '');
        avatarUrl = partner.avatar.startsWith('http') 
          ? partner.avatar 
          : `${serverUrl}${partner.avatar.startsWith('/') ? '' : '/'}${partner.avatar}`;
      }

      // КРИТИЧНО: Используем актуальные значения из session
      const finalCallId = actualCallId || callId || '';
      const finalRoomId = actualRoomId || roomId || '';
      
      logger.info('[usePiP] Показываем PiP с актуальными значениями', {
        finalCallId,
        finalRoomId,
        actualPartnerId,
        partnerName: partner?.nick || 'Друг'
      });
      
      pip.showPiP({
        callId: finalCallId,
        roomId: finalRoomId,
        partnerName: partner?.nick || 'Друг',
        partnerAvatarUrl: avatarUrl,
        muteLocal: !micOn,
        muteRemote: remoteMuted,
        localStream: localStream || null,
        remoteStream: remoteStream || null,
        navParams: {
          ...routeParams,
          peerUserId: partnerUserId,
          partnerId: actualPartnerId || partnerId,
        } as any,
      });

      // КРИТИЧНО: Вызываем session.enterPiP() который уже отправляет cam-toggle(false) через PiPManager
      // НЕ дублируем отправку cam-toggle здесь - это делает PiPManager.enterPiP()
      const currentSession = session || (global as any).__webrtcSessionRef?.current;
      if (currentSession && typeof currentSession.enterPiP === 'function') {
        logStateTransition('active_call', 'pip_mode', { roomId: finalRoomId, callId: finalCallId, partnerId: actualPartnerId });
        // PiPManager.enterPiP() уже отправляет cam-toggle(false) и pip:state
        // Не нужно дублировать отправку здесь
        currentSession.enterPiP();
        logger.info('[usePiP] ✅ Вызван session.enterPiP() - PiPManager отправит cam-toggle(false) и pip:state');
      } else {
        logger.warn('[usePiP] ⚠️ Session или enterPiP недоступны', {
          hasSession: !!currentSession,
          hasEnterPiP: !!(currentSession && typeof currentSession.enterPiP === 'function'),
          hasGlobalSession: !!(global as any).__webrtcSessionRef?.current
        });
      }

      logger.info('[usePiP] ✅ Вход в PiP через Swipe Left to Right или BackHandler - УСПЕШНО');
    } else {
      logger.info('[usePiP] enterPiPMode - НЕ показываем PiP', {
        hasActiveCall,
        pipVisible: pip.visible
      });
    }
  }, [roomId, callId, partnerId, isInactiveState, wasFriendCallEnded, pip.visible, friends, partnerUserId, micOn, remoteMuted, localStream, remoteStream, routeParams, session]);

  // Обработка BackHandler для входа в PiP (только для Android)
  // На iOS навигация назад обрабатывается через PanResponder (свайп слева направо)
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      // КРИТИЧНО: Получаем актуальные значения из session (включая глобальную ссылку)
      const currentSession = session || (global as any).__webrtcSessionRef?.current;
      const actualRoomId = roomId || currentSession?.getRoomId?.() || null;
      const actualCallId = callId || currentSession?.getCallId?.() || null;
      const actualPartnerId = partnerId || currentSession?.getPartnerId?.() || null;
      const hasActiveCall = (!!actualRoomId || !!actualCallId || !!actualPartnerId) && !isInactiveState && !wasFriendCallEnded;

      if (hasActiveCall && !pip.visible) {
        logger.info('[usePiP] BackHandler (Android): вход в PiP и возврат назад', {
          actualRoomId,
          actualCallId,
          actualPartnerId
        });
        // Показываем PiP и возвращаемся на предыдущую страницу
        enterPiPMode();
        setTimeout(() => {
          if (navigation.canGoBack && navigation.canGoBack()) {
            navigation.goBack();
          } else {
            navigation.navigate('Home' as never);
          }
        }, 100);
        return true; // Предотвращаем стандартное поведение кнопки назад
      }

      return false; // Разрешаем закрытие если нет активного звонка
    });

    return () => backHandler.remove();
  }, [enterPiPMode, roomId, callId, partnerId, isInactiveState, wasFriendCallEnded, pip.visible, session, navigation]);

  // Обработка Swipe Left to Right для входа в PiP и возврата на предыдущую страницу
  // Порог: 25% ширины экрана для iOS (уменьшено для более чувствительного свайпа)
  const screenWidth = Dimensions.get('window').width;
  const swipeThreshold = Platform.OS === 'ios' ? screenWidth * 0.25 : 50;
  const velocityThreshold = 0.5;
  
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        const { dx, dy } = gestureState;
        // Уменьшаем минимальный порог для более раннего начала обработки жеста
        const minDx = Platform.OS === 'ios' ? screenWidth * 0.05 : 10;
        return Math.abs(dx) > minDx && dx > 0 && Math.abs(dx) > Math.abs(dy);
      },
      onPanResponderRelease: (_, gestureState) => {
        const { dx, vx } = gestureState;
        const shouldTrigger = dx > swipeThreshold || vx > velocityThreshold;
        
        if (shouldTrigger) {
          // КРИТИЧНО: Получаем актуальные значения из session для проверки активного звонка
          const currentSession = session || (global as any).__webrtcSessionRef?.current;
          const actualRoomId = roomId || currentSession?.getRoomId?.() || null;
          const actualCallId = callId || currentSession?.getCallId?.() || null;
          const actualPartnerId = partnerId || currentSession?.getPartnerId?.() || null;
          const hasActiveCall = (!!actualRoomId || !!actualCallId || !!actualPartnerId) && !isInactiveState && !wasFriendCallEnded;

          // Используем requestAnimationFrame для плавности анимации навигации
          requestAnimationFrame(() => {
            if (hasActiveCall && !pip.visible) {
              // Показываем PiP и возвращаемся на предыдущую страницу
              enterPiPMode();
              // Добавляем небольшую задержку для плавности перехода
              requestAnimationFrame(() => {
                setTimeout(() => {
                  if (navigation.canGoBack && navigation.canGoBack()) {
                    navigation.goBack();
                  } else {
                    navigation.navigate('Home' as never);
                  }
                }, 50);
              });
            } else {
              // Нет активного звонка - просто возвращаемся назад
              requestAnimationFrame(() => {
                if (navigation.canGoBack && navigation.canGoBack()) {
                  navigation.goBack();
                } else {
                  navigation.navigate('Home' as never);
                }
              });
            }
          });
        }
      },
    })
  ).current;

  return {
    enterPiPMode,
    panResponder,
    pip,
    pipRef,
  };
};
