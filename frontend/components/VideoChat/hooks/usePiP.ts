import { useCallback, useRef, useEffect } from 'react';
import { BackHandler, PanResponder, Platform, Dimensions, NativeModules } from 'react-native';
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
  camOn: boolean;
  micOn: boolean;
  remoteMuted: boolean;
  localStream: any;
  remoteStream: any;
  friends: any[];
  routeParams?: any;
  session?: any; // VideoCallSession
  acceptCallTimeRef: React.MutableRefObject<number>;
  enableAndroidBackHandler?: boolean;
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
  camOn,
  micOn,
  remoteMuted,
  localStream,
  remoteStream,
  friends,
  routeParams,
  session,
  acceptCallTimeRef,
  enableAndroidBackHandler = true,
}: UsePiPProps) => {
  const navigation = useNavigation();
  const pip = usePiPContext();
  const pipRef = useRef(pip);
  const pipVisibleRef = useRef(pip.visible);
  const pipShownDuringSwipeRef = useRef(false); // Флаг, что PiP уже показан во время текущего свайпа
  const startXRef = useRef<number | null>(null);
  
  // КРИТИЧНО: Используем ref для хранения актуальных значений состояния звонка
  // Это нужно для PanResponder, который создается один раз и может иметь устаревшие значения в замыкании
  const isInactiveStateRef = useRef(isInactiveState);
  const wasFriendCallEndedRef = useRef(wasFriendCallEnded);
  
  useEffect(() => {
    pipRef.current = pip;
    pipVisibleRef.current = pip.visible;
  }, [pip, pip.visible]);
  
  useEffect(() => {
    isInactiveStateRef.current = isInactiveState;
  }, [isInactiveState]);
  
  useEffect(() => {
    wasFriendCallEndedRef.current = wasFriendCallEnded;
  }, [wasFriendCallEnded]);

  // Функция для входа в PiP
  const enterPiPMode = useCallback((opts?: { deferVisible?: boolean }) => {
    // КРИТИЧНО: Сначала проверяем, завершен ли звонок - если да, НЕ показываем PiP
    // Это предотвращает появление PiP при свайпе назад после завершения звонка
    if (isInactiveState || wasFriendCallEnded) {
      logger.info('[usePiP] enterPiPMode - звонок завершен, НЕ показываем PiP', {
        isInactiveState,
        wasFriendCallEnded
      });
      
      // Закрываем PiP если он был открыт
      if (pip.visible) {
        logger.info('[usePiP] Закрываем PiP - звонок завершен');
        pip.hidePiP();
        const currentSession = session || (global as any).__webrtcSessionRef?.current;
        if (currentSession && currentSession.exitPiP) {
          currentSession.exitPiP();
        }
      }
      return;
    }
    
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

    // КРИТИЧНО: Показываем PiP если есть активный звонок, даже если он уже видим
    // Это позволяет показывать PiP повторно при свайпе назад после возврата из PiP
    if (hasActiveCall) {
      logger.info('[usePiP] Показываем PiP', {
        pipVisibleBefore: pip.visible,
        willUpdate: pip.visible
      });
      
      // НЕ отключаем локальный видеотрек при входе в in-app PiP: иначе собеседник перестаёт
      // получать кадры и видео у него зависает. Поток должен продолжать идти (камера была включена).
      
      // Показываем PiP: партнёр из friends по partnerUserId; имя — fallback из routeParams (на случай если friends ещё не загружен)
      const partner = partnerUserId
        ? friends.find(f => String(f._id) === String(partnerUserId))
        : null;
      const partnerNameFromParams = (routeParams as any)?.partnerNick ?? (routeParams as any)?.partnerName ?? '';

      // КРИТИЧНО: Используем avatarThumbB64 (data URI) для аватара в PiP
      // Это соответствует тому, как аватары используются в других частях приложения
      let avatarUrl: string | undefined = undefined;
      if (partner?.avatarThumbB64 && typeof partner.avatarThumbB64 === 'string' && partner.avatarThumbB64.trim() !== '') {
        // Преобразуем base64 в data URI если нужно (для Android Glide требуется data: префикс)
        const thumbB64 = partner.avatarThumbB64.trim();
        avatarUrl = thumbB64.startsWith('data:') ? thumbB64 : `data:image/jpeg;base64,${thumbB64}`;
      } else if (partner?.avatarB64 && typeof partner.avatarB64 === 'string' && partner.avatarB64.trim() !== '') {
        // Fallback: используем полный аватар если миниатюры нет
        // Преобразуем base64 в data URI если нужно (для Android Glide требуется data: префикс)
        const avatarB64 = partner.avatarB64.trim();
        avatarUrl = avatarB64.startsWith('data:') ? avatarB64 : `data:image/jpeg;base64,${avatarB64}`;
      } else if (partner?.avatar && typeof partner.avatar === 'string' && partner.avatar.trim() !== '') {
        // Fallback: используем URL аватара если нет base64
        // КРИТИЧНО: В production используйте домен с HTTPS, не IP адреса!
        const DEFAULT_URL = process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
        const IOS_URL = process.env.EXPO_PUBLIC_SERVER_URL_IOS || process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
        const ANDROID_URL = process.env.EXPO_PUBLIC_SERVER_URL_ANDROID || process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
        const serverUrl = (Platform.OS === 'android' ? ANDROID_URL : IOS_URL).replace(/\/+$/, '');
        avatarUrl = partner.avatar.startsWith('http') 
          ? partner.avatar 
          : `${serverUrl}${partner.avatar.startsWith('/') ? '' : '/'}${partner.avatar}`;
      }
      
      logger.info('[usePiP] Аватар для PiP', {
        hasPartner: !!partner,
        hasAvatarThumbB64: !!(partner?.avatarThumbB64),
        hasAvatarB64: !!(partner?.avatarB64),
        hasAvatar: !!(partner?.avatar),
        hasAvatarUrl: !!avatarUrl,
        partnerId: partner?._id
      });

      // КРИТИЧНО: Используем актуальные значения из session
      const finalCallId = actualCallId || callId || '';
      const finalRoomId = actualRoomId || roomId || '';
      
      logger.info('[usePiP] Показываем PiP с актуальными значениями', {
        finalCallId,
        finalRoomId,
        actualPartnerId,
        partnerName: partner?.nick || ''
      });
      
      logger.info('[usePiP] Вызываем pip.showPiP', {
        finalCallId,
        finalRoomId,
        partnerName: partner?.nick || '',
        hasLocalStream: !!localStream,
        hasRemoteStream: !!remoteStream,
        pipVisibleBefore: pip.visible
      });
      
      pip.showPiP({
        callId: finalCallId,
        roomId: finalRoomId,
        partnerName: (partner?.nick && partner.nick.trim()) ? partner.nick.trim() : (partnerNameFromParams && String(partnerNameFromParams).trim()) ? String(partnerNameFromParams).trim() : '',
        partnerAvatarUrl: avatarUrl,
        muteLocal: !micOn,
        muteRemote: remoteMuted,
        localStream: localStream || null,
        remoteStream: remoteStream || null,
        localCamOn: camOn,
        deferVisible: !!opts?.deferVisible,
        navParams: {
          ...routeParams,
          peerUserId: partnerUserId,
          partnerId: actualPartnerId || partnerId,
        } as any,
      });
      
      // КРИТИЧНО: Проверяем, что PiP действительно показался
      logger.info('[usePiP] pip.showPiP вызван, проверяем результат', {
        pipVisibleAfter: pip.visible,
        pipRefVisible: pipRef.current?.visible
      });

      // КРИТИЧНО: Вызываем session.enterPiP() для отправки pip:state партнеру
      const currentSession = session || (global as any).__webrtcSessionRef?.current;
      if (currentSession) {
        logStateTransition('active_call', 'pip_mode', { roomId: finalRoomId, callId: finalCallId, partnerId: actualPartnerId });
        // Вызываем enterPiP если метод доступен (может быть опциональным)
        if (currentSession.enterPiP && typeof currentSession.enterPiP === 'function') {
          currentSession.enterPiP();
          logger.info('[usePiP] ✅ Вызван session.enterPiP() - отправлено pip:state=true партнеру');
        } else {
          // Fallback: отправляем pip:state напрямую если метод недоступен
          const currentRoomId = finalRoomId || currentSession.getRoomId?.() || null;
          if (currentRoomId) {
            try {
              socket.emit('pip:state', {
                inPiP: true,
                from: socket.id,
                roomId: currentRoomId,
              });
              logger.info('[usePiP] ✅ Отправлено pip:state=true напрямую (fallback)', { roomId: currentRoomId });
            } catch (e) {
              logger.warn('[usePiP] Ошибка отправки pip:state:', e);
            }
          }
        }
      } else {
        logger.warn('[usePiP] ⚠️ Session недоступна', {
          hasSession: !!currentSession,
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
  }, [roomId, callId, partnerId, isInactiveState, wasFriendCallEnded, pip.visible, friends, partnerUserId, camOn, micOn, remoteMuted, localStream, remoteStream, routeParams, session]);

  // Обработка BackHandler для Android:
  // при уходе со страницы внутри приложения показываем in-app PiP.
  // Системный PiP должен включаться только при РЕАЛЬНОМ выходе из приложения (Home/Recents/Back на корне),
  // это обрабатывается нативным onUserLeaveHint() и глобальными обработчиками корневого Back.
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    if (!enableAndroidBackHandler) {
      return;
    }
    
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      // КРИТИЧНО: Проверяем актуальное состояние звонка через ref
      // Если звонок завершён — сами делаем шаг назад (goBack/navigate Home) и потребляем событие.
      // Иначе при return false на части устройств Back доходит до Activity и вызывает finish() → при следующем открытии приложения показывается заглушка (холодный старт).
      if (isInactiveStateRef.current || wasFriendCallEndedRef.current) {
        logger.info('[usePiP] BackHandler (Android): звонок завершен — шаг назад вручную', {
          isInactiveState: isInactiveStateRef.current,
          wasFriendCallEnded: wasFriendCallEndedRef.current
        });
        requestAnimationFrame(() => {
          if (navigation.canGoBack && navigation.canGoBack()) {
            navigation.goBack();
          } else {
            navigation.navigate('Home' as never);
          }
        });
        return true; // Потребляем Back — не даём Activity завершиться
      }
      
      // КРИТИЧНО: Получаем актуальные значения из session (включая глобальную ссылку)
      const currentSession = session || (global as any).__webrtcSessionRef?.current;
      const actualRoomId = roomId || currentSession?.getRoomId?.() || null;
      const actualCallId = callId || currentSession?.getCallId?.() || null;
      const actualPartnerId = partnerId || currentSession?.getPartnerId?.() || null;
      const hasActiveCall = (!!actualRoomId || !!actualCallId || !!actualPartnerId) && !isInactiveStateRef.current && !wasFriendCallEndedRef.current;

      if (hasActiveCall) {
        logger.info('[usePiP] BackHandler (Android): активный звонок — показываем in-app PiP и возвращаемся назад', {
          actualRoomId,
          actualCallId,
          actualPartnerId,
        });
        try {
          const g = global as any;
          g.__leavingVideoCallByBackRef = g.__leavingVideoCallByBackRef || { current: false };
          g.__leavingVideoCallByBackRef.current = true;
          g.__disableSystemPiPUntilRef = g.__disableSystemPiPUntilRef || { current: 0 };
          g.__disableSystemPiPUntilRef.current = Date.now() + 1000;
        } catch {}
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch {}
        enterPiPMode({ deferVisible: true });
        const returnTo = (routeParams as any)?.returnTo;
        if (navigation.canGoBack && navigation.canGoBack()) {
          navigation.goBack();
        } else if (returnTo?.name) {
          (navigation as any).navigate(returnTo.name, returnTo.params);
        } else {
          navigation.navigate('Home' as never);
        }
        return true;
      }

      return false; // Разрешаем закрытие если нет активного звонка
    });

    return () => backHandler.remove();
  }, [enableAndroidBackHandler, enterPiPMode, roomId, callId, partnerId, isInactiveState, wasFriendCallEnded, pip.visible, session, navigation]);

  // Обработка Swipe Left to Right для входа в PiP и возврата на предыдущую страницу
  // Порог: 25% ширины экрана для iOS (уменьшено для более чувствительного свайпа)
  const screenWidth = Dimensions.get('window').width;
  const swipeThreshold = Platform.OS === 'ios' ? screenWidth * 0.25 : 50;
  const velocityThreshold = 0.5;
  const edgeCaptureWidth = 28;
  
  const panResponder = useRef(
    PanResponder.create({
      // КРИТИЧНО: На iOS используем Capture фазу для самого раннего перехвата жеста
      // Это позволяет перехватить жест ДО нативной навигации
      onStartShouldSetPanResponderCapture: (evt) => {
        if (Platform.OS === 'ios') {
          startXRef.current = evt.nativeEvent.locationX;
          // Проверяем, есть ли активный звонок, используя refs для актуальных значений
          const currentSession = session || (global as any).__webrtcSessionRef?.current;
          const actualRoomId = roomId || currentSession?.getRoomId?.() || null;
          const actualCallId = callId || currentSession?.getCallId?.() || null;
          const actualPartnerId = partnerId || currentSession?.getPartnerId?.() || null;
          const hasActiveCall = (!!actualRoomId || !!actualCallId || !!actualPartnerId) && !isInactiveStateRef.current && !wasFriendCallEndedRef.current;
          
          if (hasActiveCall && startXRef.current !== null && startXRef.current <= edgeCaptureWidth) {
            logger.info('[usePiP] PanResponder: onStartShouldSetPanResponderCapture - захватываем жест в capture фазе (iOS)', {
              actualRoomId,
              actualCallId,
              hasActiveCall,
              isInactiveState: isInactiveStateRef.current,
              wasFriendCallEnded: wasFriendCallEndedRef.current,
              startX: startXRef.current
            });
            return true; // Захватываем жест в capture фазе на iOS
          }
        }
        return false;
      },
      onStartShouldSetPanResponder: () => false, // Не используем обычную фазу, только capture
      onMoveShouldSetPanResponderCapture: (_, gestureState) => {
        if (Platform.OS === 'ios') {
          const { dx, dy } = gestureState;
          // Уменьшаем минимальный порог для более раннего начала обработки жеста
          const minDx = screenWidth * 0.05;
          const shouldCapture =
            (startXRef.current !== null && startXRef.current <= edgeCaptureWidth) &&
            Math.abs(dx) > minDx &&
            dx > 0 &&
            Math.abs(dx) > Math.abs(dy);
          if (shouldCapture) {
            logger.info('[usePiP] PanResponder: onMoveShouldSetPanResponderCapture - захватываем жест свайпа в capture фазе', {
              dx,
              dy,
              minDx,
              platform: Platform.OS
            });
          }
          return shouldCapture;
        }
        return false;
      },
      onMoveShouldSetPanResponder: () => false, // Не используем обычную фазу, только capture
        onPanResponderGrant: () => {
        logger.info('[usePiP] PanResponder: onPanResponderGrant - получили контроль над жестом', {
          platform: Platform.OS
        });
        pipShownDuringSwipeRef.current = false;
        // На iOS PiP показываем только в Release с deferVisible, чтобы экран звонка успел размонтироваться (один RTCView).
      },
      onPanResponderMove: () => {
        // На iOS не показываем PiP в Move — только в Release с deferVisible.
      },
      onPanResponderRelease: (_, gestureState) => {
        const { dx, vx } = gestureState;
        const shouldTrigger = dx > swipeThreshold || vx > velocityThreshold;
        
        logger.info('[usePiP] PanResponder: onPanResponderRelease', {
          dx,
          vx,
          swipeThreshold,
          velocityThreshold,
          shouldTrigger,
          platform: Platform.OS
        });
        startXRef.current = null;
        
        if (shouldTrigger) {
          // КРИТИЧНО: Проверяем актуальное состояние звонка через ref
          // Это предотвращает показ PiP после завершения звонка
          if (isInactiveStateRef.current || wasFriendCallEndedRef.current) {
            logger.info('[usePiP] PanResponder: звонок завершен, возвращаемся назад без PiP', {
              isInactiveState: isInactiveStateRef.current,
              wasFriendCallEnded: wasFriendCallEndedRef.current
            });
            // Звонок завершен - просто возвращаемся назад без PiP
            requestAnimationFrame(() => {
              if (navigation.canGoBack && navigation.canGoBack()) {
                navigation.goBack();
              } else {
                navigation.navigate('Home' as never);
              }
            });
            return;
          }
          
          // КРИТИЧНО: Получаем актуальные значения из session для проверки активного звонка
          const currentSession = session || (global as any).__webrtcSessionRef?.current;
          const actualRoomId = roomId || currentSession?.getRoomId?.() || null;
          const actualCallId = callId || currentSession?.getCallId?.() || null;
          const actualPartnerId = partnerId || currentSession?.getPartnerId?.() || null;
          const hasActiveCall = (!!actualRoomId || !!actualCallId || !!actualPartnerId) && !isInactiveStateRef.current && !wasFriendCallEndedRef.current;

          // Простая логика: показываем PiP и возвращаемся назад
          logger.info('[usePiP] PanResponder: проверяем условия для PiP', {
            hasActiveCall,
            pipVisible: pip.visible,
            actualRoomId,
            actualCallId,
            actualPartnerId,
            isInactiveState: isInactiveStateRef.current,
            wasFriendCallEnded: wasFriendCallEndedRef.current,
            platform: Platform.OS
          });
          
          // КРИТИЧНО: Показываем PiP если есть активный звонок
          // Флаг pipShownDuringSwipeRef предотвращает повторный показ только в onPanResponderMove
          // В onPanResponderRelease всегда показываем PiP, если он еще не показан
          // После завершения жеста (навигации) флаг сбрасывается, и PiP может показаться снова при следующем свайпе
          if (hasActiveCall) {
            if (Platform.OS === 'android') {
              // Android: in-app PiP отключён. Свайп — просто шаг назад (системный PiP только по Back/Home).
              requestAnimationFrame(() => {
                if (navigation.canGoBack && navigation.canGoBack()) {
                  navigation.goBack();
                } else {
                  navigation.navigate('Home' as never);
                }
              });
            } else {
              // iOS: системный PiP для текущего сценария недоступен, сохраняем in-app PiP.
              if (!pipShownDuringSwipeRef.current) {
                logger.info('[usePiP] PanResponder: показываем PiP перед навигацией', {
                  actualRoomId,
                  actualCallId,
                  platform: Platform.OS,
                  useDeferVisible: true
                });
                enterPiPMode({ deferVisible: true });
                pipShownDuringSwipeRef.current = true;
              }
              if (navigation.canGoBack && navigation.canGoBack()) {
                navigation.goBack();
              } else {
                navigation.navigate('Home' as never);
              }
              pipShownDuringSwipeRef.current = false;
            }
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
        }
      },
      onPanResponderTerminate: (_, gestureState) => {
        logger.info('[usePiP] PanResponder: onPanResponderTerminate - жест прерван', {
          dx: gestureState.dx,
          vx: gestureState.vx,
          pipShown: pipShownDuringSwipeRef.current,
          platform: Platform.OS
        });
        if (!isInactiveStateRef.current && !wasFriendCallEndedRef.current) {
          const currentSession = session || (global as any).__webrtcSessionRef?.current;
          const actualRoomId = roomId || currentSession?.getRoomId?.() || null;
          const actualCallId = callId || currentSession?.getCallId?.() || null;
          const actualPartnerId = partnerId || currentSession?.getPartnerId?.() || null;
          const hasActiveCall = !!(actualRoomId || actualCallId || actualPartnerId);
          if (hasActiveCall) {
            if (Platform.OS === 'android') {
              requestAnimationFrame(() => {
                if (navigation.canGoBack && navigation.canGoBack()) {
                  navigation.goBack();
                } else {
                  navigation.navigate('Home' as never);
                }
                requestAnimationFrame(() => {
                  enterPiPMode({ deferVisible: true });
                  pipShownDuringSwipeRef.current = false;
                });
              });
            } else {
              if (!pipShownDuringSwipeRef.current) {
                enterPiPMode({ deferVisible: true });
                pipShownDuringSwipeRef.current = true;
              }
              requestAnimationFrame(() => {
                if (navigation.canGoBack && navigation.canGoBack()) {
                  navigation.goBack();
                } else {
                  navigation.navigate('Home' as never);
                }
                pipShownDuringSwipeRef.current = false;
              });
            }
          }
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
