import { useCallback, useRef, useEffect } from 'react';
import { BackHandler, PanResponder, Platform, Dimensions, NativeModules } from 'react-native';
import { usePiP as usePiPContext, isPipOverlayVisibleSync } from '../../../src/pip/PiPContext';
import { isInAudioOnlyCallUi, setPipInAppRtcFromAudioOnlySticky } from '../../../src/pip/pipPlaceholderOnly';
import { resolvePiPLocalMutedState, markDirectCallVideoMediaActive } from '../../../utils/activeCallSession';
import { goBackFromCallScreenOrHome } from '../../../utils/appNavigationGuard';
import { setPersistedCallAudioRoute } from '../../../utils/callAudioRoutePersist';
import { readInAppPiPAudioOutputRoute } from '../../../utils/inAppPiPAudioRoute';
import { logger } from '../../../utils/logger';
import socket from '../../../sockets/socket';

const logStateTransition = (..._args: unknown[]) => {};

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
  remoteCamOn: boolean;
  localStream: any;
  remoteStream: any;
  friends: any[];
  routeParams?: any;
  session?: any; // VideoCallSession
  acceptCallTimeRef: React.MutableRefObject<number>;
  enableAndroidBackHandler?: boolean;
  getAudioOutputRoute?: () => import('./audioRouteTypes').InCallAudioRoute;
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
  remoteCamOn,
  localStream,
  remoteStream,
  friends,
  routeParams,
  session,
  acceptCallTimeRef,
  enableAndroidBackHandler = true,
  getAudioOutputRoute,
}: UsePiPProps) => {
  const pip = usePiPContext();
  const pipRef = useRef(pip);
  const pipVisibleRef = useRef(pip.visible);
  const pipShownDuringSwipeRef = useRef(false); // Флаг, что PiP уже показан во время текущего свайпа
  const startXRef = useRef<number | null>(null);
  const pipTransitionUntilRef = useRef(0);
  
  // КРИТИЧНО: Используем ref для хранения актуальных значений состояния звонка
  const isInactiveStateRef = useRef(isInactiveState);
  const wasFriendCallEndedRef = useRef(wasFriendCallEnded);
  // В BackHandler только читаем ref — без вызовов session.getRoomId() и т.д., чтобы нажатие Back срабатывало моментально.
  const hasActiveCallRef = useRef(false);

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

  useEffect(() => {
    const currentSession = session || (global as any).__webrtcSessionRef?.current;
    const actualRoomId = roomId || currentSession?.getRoomId?.() || null;
    const actualCallId = callId || currentSession?.getCallId?.() || null;
    const actualPartnerId = partnerId || currentSession?.getPartnerId?.() || null;
    hasActiveCallRef.current =
      (!!actualRoomId || !!actualCallId || !!actualPartnerId) &&
      !isInactiveState &&
      !wasFriendCallEnded;
  }, [session, roomId, callId, partnerId, isInactiveState, wasFriendCallEnded]);

  // Функция для входа в PiP
  const enterPiPMode = useCallback((opts?: { deferVisible?: boolean; fromVideoCallBack?: boolean }) => {
    const now = Date.now();
    const g = global as any;
    const fromVideoCallBack = opts?.fromVideoCallBack === true;
    if (!fromVideoCallBack) {
      const suppressInAppPiPUntil = Number(g.__suppressInAppPiPUntilRef?.current || 0);
      const systemPiPEntryUntil = Number(g.__systemPiPEntryInProgressUntilRef?.current || 0);
      if (now < suppressInAppPiPUntil || now < systemPiPEntryUntil) {
        return;
      }
      if (now < pipTransitionUntilRef.current) {
        return;
      }
    }
    pipTransitionUntilRef.current = now + (fromVideoCallBack ? 200 : 450);

    if (isInAudioOnlyCallUi()) {
      setPipInAppRtcFromAudioOnlySticky(true);
      const routeEarly = getAudioOutputRoute?.() || readInAppPiPAudioOutputRoute();
      if (routeEarly) {
        setPersistedCallAudioRoute(routeEarly);
        try {
          const params = g.__currentCallPiPParamsRef?.current;
          if (params && typeof params === 'object') {
            params.audioOutputRoute = routeEarly;
          }
        } catch {}
      }
    }

    // КРИТИЧНО: Проверяем по refs
    // не показывать PiP, если звонок успел завершиться. Пропы могут быть устаревшими в замыкании.
    const inactive = isInactiveStateRef.current || wasFriendCallEndedRef.current;
    if (inactive || isInactiveState || wasFriendCallEnded) {
      // Не сбрасываем __pipVisibleRef по pip.visible — после showPiP он ещё false до ре-рендера.
      // Закрываем PiP если оверлей реально показан (React и/или синхронный флаг).
      if (pip.visible || isPipOverlayVisibleSync()) {
        pip.hidePiP();
        pipRef.current = { ...pip, visible: false };
        pipVisibleRef.current = false;
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
    
    // Не показываем PiP если звонок завершен (refs — актуальное состояние при отложенном вызове)
    const hasActiveCall = (!!actualRoomId || !!actualCallId || !!actualPartnerId) && !isInactiveStateRef.current && !wasFriendCallEndedRef.current && !isInactiveState && !wasFriendCallEnded;

    // КРИТИЧНО: Показываем PiP если есть активный звонок, даже если он уже видим
    // Это позволяет показывать PiP повторно при свайпе назад после возврата из PiP
    if (hasActiveCall) {
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
      
      // КРИТИЧНО: Используем актуальные значения из session
      const finalCallId = actualCallId || callId || '';
      const finalRoomId = actualRoomId || roomId || '';
      
      const audioRoute = getAudioOutputRoute?.() || readInAppPiPAudioOutputRoute();
      const fromAudioOnlyUi = isInAudioOnlyCallUi();
      const pipAudioRoute =
        fromAudioOnlyUi
          ? audioRoute || 'EARPIECE'
          : audioRoute === 'EARPIECE'
            ? 'SPEAKER_PHONE'
            : audioRoute;
      const muteLocal = resolvePiPLocalMutedState(micOn);
      const sessionCamOn =
        currentSession && typeof currentSession.getIsCamOn === 'function'
          ? currentSession.getIsCamOn()
          : false;
      const effectiveLocalCamOn = camOn || sessionCamOn;
      pip.updatePiPState({ localCamOn: effectiveLocalCamOn });
      if (effectiveLocalCamOn) {
        markDirectCallVideoMediaActive();
        try {
          const g = global as any;
          g.__stayOnVideoCallUiRef = g.__stayOnVideoCallUiRef || { current: false };
          g.__stayOnVideoCallUiRef.current = true;
        } catch {}
      }
      pip.showPiP({
        callId: finalCallId,
        roomId: finalRoomId,
        partnerName: (partner?.nick && partner.nick.trim()) ? partner.nick.trim() : (partnerNameFromParams && String(partnerNameFromParams).trim()) ? String(partnerNameFromParams).trim() : '',
        partnerAvatarUrl: avatarUrl,
        muteLocal,
        muteRemote: remoteMuted,
        localStream: localStream || null,
        remoteStream: remoteStream || null,
        localCamOn: effectiveLocalCamOn,
        remoteCamOn,
        fromAudioOnlyUi,
        audioOutputRoute: pipAudioRoute,
        deferVisible: !!opts?.deferVisible,
        navParams: {
          ...routeParams,
          peerUserId: partnerUserId,
          partnerId: actualPartnerId || partnerId,
        } as any,
      });
      // Синхронно совмещаем ref с showPiP до следующего рендера (pip.visible из замыкания ещё старый).
      pipRef.current = { ...pip, visible: true };
      pipVisibleRef.current = true;

      // КРИТИЧНО: Вызываем session.enterPiP() для отправки pip:state партнеру
      if (currentSession) {
        logStateTransition('active_call', 'pip_mode', { roomId: finalRoomId, callId: finalCallId, partnerId: actualPartnerId });
        // Вызываем enterPiP если метод доступен (может быть опциональным)
        if (currentSession.enterPiP && typeof currentSession.enterPiP === 'function') {
          currentSession.enterPiP();
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

    } else {
      // Префетч Android Back: __pipVisibleRef=true до goBack(), но PiP не показываем — убираем «висящий» флаг.
      try {
        const g = global as any;
        if (g.__pipVisibleRef?.current === true && !pip.visible) g.__pipVisibleRef.current = false;
      } catch {}
    }
  }, [roomId, callId, partnerId, isInactiveState, wasFriendCallEnded, pip.visible, friends, partnerUserId, camOn, micOn, remoteMuted, remoteCamOn, localStream, remoteStream, routeParams, session, getAudioOutputRoute]);

  // Android Back: goBack + in-app PiP поверх предыдущего экрана. Системный PiP — только «Домой».
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    if (!enableAndroidBackHandler) {
      return;
    }

    const navigateBackFromCallScreen = () => {
      const returnTo = (routeParams as any)?.returnTo as
        | { name: string; params?: object }
        | undefined;
      if (goBackFromCallScreenOrHome(returnTo)) {
        return;
      }
    };

    const revealInAppPiPAfterBack = () => {
      enterPiPMode({ deferVisible: true, fromVideoCallBack: true });
      try {
        const g = global as any;
        const clearLeaving = () => {
          g.__leavingVideoCallByBackRef = g.__leavingVideoCallByBackRef || { current: false };
          g.__leavingVideoCallByBackRef.current = false;
        };
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(clearLeaving);
        } else {
          setTimeout(clearLeaving, 16);
        }
      } catch {}
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (isInactiveStateRef.current || wasFriendCallEndedRef.current) {
        navigateBackFromCallScreen();
        return true;
      }

      if (!hasActiveCallRef.current) return false;

      const now = Date.now();
      try {
        const g = global as any;
        g.__leavingVideoCallByBackRef = g.__leavingVideoCallByBackRef || { current: false };
        g.__leavingVideoCallByBackRef.current = true;
        g.__disableSystemPiPUntilRef = g.__disableSystemPiPUntilRef || { current: 0 };
        g.__disableSystemPiPUntilRef.current = now + 2000;
        g.__pipVisibleRef = g.__pipVisibleRef || { current: false };
        g.__pipVisibleRef.current = true;
        g.__suppressInAppPiPUntilRef = g.__suppressInAppPiPUntilRef || { current: 0 };
        g.__suppressInAppPiPUntilRef.current = 0;
        g.__systemPiPEntryInProgressUntilRef = g.__systemPiPEntryInProgressUntilRef || { current: 0 };
        g.__systemPiPEntryInProgressUntilRef.current = 0;
        const upd = g.__pipUpdateStateRef?.current;
        if (typeof upd === 'function') {
          upd({
            pendingSystemPiP: false,
            systemPiPCaptureActive: false,
            systemPiPCaptureRequestId: 0,
            decorSizeForPiP: null,
          });
        }
        NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(false);
      } catch {}

      navigateBackFromCallScreen();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(revealInAppPiPAfterBack);
      } else {
        revealInAppPiPAfterBack();
      }
      return true;
    });

    return () => backHandler.remove();
  }, [
    enableAndroidBackHandler,
    enterPiPMode,
    roomId,
    callId,
    partnerId,
    isInactiveState,
    wasFriendCallEnded,
    pip.visible,
    session,
    routeParams,
    localStream,
    remoteStream,
    camOn,
    remoteCamOn,
  ]);

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
          return shouldCapture;
        }
        return false;
      },
      onMoveShouldSetPanResponder: () => false, // Не используем обычную фазу, только capture
        onPanResponderGrant: () => {
        pipShownDuringSwipeRef.current = false;
        // На iOS PiP показываем только в Release с deferVisible, чтобы экран звонка успел размонтироваться (один RTCView).
      },
      onPanResponderMove: () => {
        // На iOS не показываем PiP в Move — только в Release с deferVisible.
      },
      onPanResponderRelease: (_, gestureState) => {
        const { dx, vx } = gestureState;
        const shouldTrigger = dx > swipeThreshold || vx > velocityThreshold;
        startXRef.current = null;
        
        if (shouldTrigger) {
          // КРИТИЧНО: Проверяем актуальное состояние звонка через ref
          // Это предотвращает показ PiP после завершения звонка
          if (isInactiveStateRef.current || wasFriendCallEndedRef.current) {
            // Звонок завершен - просто возвращаемся назад без PiP
            requestAnimationFrame(() => {
              goBackFromCallScreenOrHome(
                (routeParams as any)?.returnTo as { name: string; params?: object } | undefined,
              );
            });
            return;
          }
          
          // КРИТИЧНО: Получаем актуальные значения из session для проверки активного звонка
          const currentSession = session || (global as any).__webrtcSessionRef?.current;
          const actualRoomId = roomId || currentSession?.getRoomId?.() || null;
          const actualCallId = callId || currentSession?.getCallId?.() || null;
          const actualPartnerId = partnerId || currentSession?.getPartnerId?.() || null;
          const hasActiveCall = (!!actualRoomId || !!actualCallId || !!actualPartnerId) && !isInactiveStateRef.current && !wasFriendCallEndedRef.current;
          
          // КРИТИЧНО: Показываем PiP если есть активный звонок
          // Флаг pipShownDuringSwipeRef предотвращает повторный показ только в onPanResponderMove
          // В onPanResponderRelease всегда показываем PiP, если он еще не показан
          // После завершения жеста (навигации) флаг сбрасывается, и PiP может показаться снова при следующем свайпе
          if (hasActiveCall) {
            if (Platform.OS === 'android') {
              // Android: in-app PiP отключён. Свайп — просто шаг назад (системный PiP только по Back/Home).
              requestAnimationFrame(() => {
                goBackFromCallScreenOrHome(
                  (routeParams as any)?.returnTo as { name: string; params?: object } | undefined,
                );
              });
            } else {
              // iOS: системный PiP для текущего сценария недоступен, сохраняем in-app PiP.
              if (!pipShownDuringSwipeRef.current) {
                enterPiPMode({ deferVisible: true });
                pipShownDuringSwipeRef.current = true;
              }
              goBackFromCallScreenOrHome(
                (routeParams as any)?.returnTo as { name: string; params?: object } | undefined,
              );
              pipShownDuringSwipeRef.current = false;
            }
          } else {
            // Нет активного звонка - просто возвращаемся назад
            requestAnimationFrame(() => {
              goBackFromCallScreenOrHome(
                (routeParams as any)?.returnTo as { name: string; params?: object } | undefined,
              );
            });
          }
        }
      },
      onPanResponderTerminate: (_, gestureState) => {
        if (!isInactiveStateRef.current && !wasFriendCallEndedRef.current) {
          const currentSession = session || (global as any).__webrtcSessionRef?.current;
          const actualRoomId = roomId || currentSession?.getRoomId?.() || null;
          const actualCallId = callId || currentSession?.getCallId?.() || null;
          const actualPartnerId = partnerId || currentSession?.getPartnerId?.() || null;
          const hasActiveCall = !!(actualRoomId || actualCallId || actualPartnerId);
          if (hasActiveCall) {
            if (Platform.OS === 'android') {
              // На Android при terminate не показываем in-app PiP: логика едина с onPanResponderRelease.
              requestAnimationFrame(() => {
                goBackFromCallScreenOrHome(
                  (routeParams as any)?.returnTo as { name: string; params?: object } | undefined,
                );
                pipShownDuringSwipeRef.current = false;
              });
            } else {
              if (!pipShownDuringSwipeRef.current) {
                enterPiPMode({ deferVisible: true });
                pipShownDuringSwipeRef.current = true;
              }
              requestAnimationFrame(() => {
                goBackFromCallScreenOrHome(
                  (routeParams as any)?.returnTo as { name: string; params?: object } | undefined,
                );
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
