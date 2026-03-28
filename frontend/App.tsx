// App.tsx
import "react-native-gesture-handler";
import React from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Provider as PaperProvider } from "react-native-paper";
import { Platform } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import * as NavigationBar from "expo-navigation-bar";
import { NavigationContainer, createNavigationContainerRef, CommonActions, DefaultTheme } from "@react-navigation/native";
import { ThemeProvider, useAppTheme } from "./theme/ThemeProvider";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Audio } from "expo-av";
import { View, Text, Animated, TouchableOpacity, StyleSheet, Easing, AppState, StatusBar, Linking, LogBox, Keyboard, InteractionManager, NativeModules, NativeEventEmitter, BackHandler, Modal } from "react-native";
import { BlurView } from "expo-blur";
import { MaterialIcons } from "@expo/vector-icons";
import { PanGestureHandler } from "react-native-gesture-handler";
import socket, { onCallIncoming, onCallTimeout, onCallDeclined, onCallCanceled, onCallAccepted, acceptCall, declineCall, cancelCall, requestCallAccepted, ensureSocketConnected, checkInviteLink, getCurrentUserId, onCurrentUserId, API_BASE, setOutgoingCallScreenVisible, setIncomingCallScreenVisible, setActiveVideoCall, wasAppliedFromReauth, recordAppliedFromPending, reportIncomingCallShown } from "./sockets/socket";
import { emitMissedIncrement, emitCloseIncoming, emitRequestCloseIncoming, emitCloseOutgoingCall, emitCallCancelledOnHome, emitCallEndedOnHome, emitCloseHomeModals, onRequestCloseIncoming, onCloseIncoming } from './utils/globalEvents';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './utils/logger';
import InCallManager from 'react-native-incall-manager';
import { startIncomingCallAlert, stopIncomingCallAlert } from './utils/incomingCallAlert';
import HomeScreen from "./screens/HomeScreen";
import VideoCallScreen from "./screens/VideoCallScreen";
import RandomChatScreen from "./screens/RandomChatScreen";
import ChatScreen from "./screens/ChatScreen";
import { PiPProvider, usePiP } from "./src/pip/PiPContext";
import PiPOverlay from "./src/pip/PiPOverlay";
import { ensureCometChatReady } from "./chat/cometchat";
import type { RootStackParamList } from "./navigation/types";
import { registerGlobals as registerLiveKitGlobals } from '@livekit/react-native';
import { addNotificationListeners, ensureInitialNotificationPermissions, openIncomingCallScreen, openAnswerCallScreen, handleDeclineCallFromDeepLink, registerAndSendPushToken, clearCallRelatedNotificationsAndSyncBadge, syncAppBadgeFromMissedCount, clearMissedBadgeCleared, setMissedBadgeCleared } from './utils/pushNotifications';
import { getInstallId } from './utils/installId';
import { ensureInitialMediaPermissions } from './utils/mediaPermissions';
import { setupCallKeep, launchIncomingCallActivityScreen, showIncomingCallSystemUI, sendCallAnsweredBroadcast, displayIncomingCall, isCallKeepAvailable, registerCallKeepEvents, reportAnswerIncomingCall, reportRejectCall, reportEndCallToCallKeep, setCallKeepAvailable, getPendingCallInfo, closeOutgoingCallActivity, bringMainActivityToFront, OUTGOING_CALL_TIMEOUT_MS, setOutgoingCallTimeoutMs, isOutgoingDeclineHandled, markOutgoingDeclineHandled, getAndClearPendingIncomingCallForCallKeep, stopIncomingCallForegroundService, startIncomingCallRingtoneAndVibration, stopIncomingCallRingtoneAndVibration, canDrawOverlays, openOverlayPermissionSettings, notifyCallCanceled } from './utils/callKeep';
import { useLang } from './store/lang';
import { t } from './utils/i18n';

// Импорт expo-keep-awake с безопасной загрузкой
let activateKeepAwakeAsync: (() => Promise<void>) | null = null;
let deactivateKeepAwakeAsync: (() => Promise<void>) | null = null;

try {
  const keepAwakeModule = require("expo-keep-awake");
  // КРИТИЧНО: Используем асинхронные версии (activateKeepAwakeAsync вместо activateKeepAwake)
  activateKeepAwakeAsync = keepAwakeModule.activateKeepAwakeAsync;
  deactivateKeepAwakeAsync = keepAwakeModule.deactivateKeepAwakeAsync;
  // Fallback: если async версии нет, пробуем синхронные (для обратной совместимости)
  if (!activateKeepAwakeAsync && keepAwakeModule.activateKeepAwake) {
    activateKeepAwakeAsync = async () => { keepAwakeModule.activateKeepAwake(); };
  }
  if (!deactivateKeepAwakeAsync && keepAwakeModule.deactivateKeepAwake) {
    deactivateKeepAwakeAsync = async () => { keepAwakeModule.deactivateKeepAwake(); };
  }
} catch (e) {
  logger.warn("expo-keep-awake module not available, using fallback", e);
  // Fallback функции если модуль недоступен
  activateKeepAwakeAsync = async () => {
    logger.debug("keep-awake activate (fallback - module not available)");
  };
  deactivateKeepAwakeAsync = async () => {
    logger.debug("keep-awake deactivate (fallback - module not available)");
  };
}

/** Модалки «Вызовы на заблокированном экране» показываются только один раз при первом запуске после установки. */
const OVERLAY_PERMISSION_MODAL_SHOWN_KEY = 'overlay_permission_modal_shown_v1';

// Экспортируем функции для использования в других компонентах
export { activateKeepAwakeAsync, deactivateKeepAwakeAsync };

try { (React as any).useInsertionEffect = (React as any).useEffect; } catch {}

// Dev: hide extremely noisy warning that can spam logs on slower Android devices.
// This does NOT fix the root cause, but makes Metro logs usable while we iterate.
if (__DEV__) {
  try {
    LogBox.ignoreLogs([
      'Excessive number of pending callbacks',
    ]);
  } catch {}
}

// Регистрация глобальных LiveKit штук один раз при старте приложения
try {
  registerLiveKitGlobals();
} catch (e) {
  logger.warn('[App] Failed to register LiveKit globals', e);
}


const Stack = createNativeStackNavigator<RootStackParamList>();
const navRef = createNavigationContainerRef<RootStackParamList>();
// Экспортируем ссылку глобально для простого доступа из модулей без хука
// (безопасно: используется только для navigate на Home при разрыве вызова)
(global as any).__navRef = navRef;

// Звонки, для которых уже пришло call:ended по сокету. Не переходить на VideoCall по call:accepted для такого callId (избегаем мелькания и «произвольных» переходов).
const endedCallIdsFromSocket = new Set<string>();
const ENDED_CALL_IDS_TTL_MS = 120000;
function addEndedCallIdFromSocket(callId: string) {
  endedCallIdsFromSocket.add(callId);
  setTimeout(() => endedCallIdsFromSocket.delete(callId), ENDED_CALL_IDS_TTL_MS);
}

const isVideoSessionRoute = (routeName?: string | null) =>
  routeName === 'VideoCall' || routeName === 'RandomChat';

// КРИТИЧНО: Глобальная ссылка на состояние неактивности экрана видеозвонка/рандомчата
// Когда true - входящий звонок показывается в блоке собеседник, а не глобально
(global as any).__isInactiveStateRef = { current: false };

// КРИТИЧНО: Глобальная ссылка на функцию очистки звонка из VideoCall
// Это нужно чтобы можно было вызвать очистку даже когда экран звонка размонтирован (в PiP)
(global as any).__endCallCleanupRef = { current: null as (() => void) | null };

// Колбэк для принудительного ре-рендера списка друзей при завершении видеозвонка (чтобы снялись бейдж «Занят» и disabled кнопки).
(global as any).__onVideoCallEndedRef = { current: null as (() => void) | null };

// КРИТИЧНО: Глобальная ссылка на WebRTC session
// Это нужно чтобы можно было остановить стримы даже когда экран звонка размонтирован (в PiP)
(global as any).__webrtcSessionRef = { current: null as any };

// КРИТИЧНО: VideoCall выставляет true при doReset() → навигация на Home. App при call:ended не вызывает goHome() повторно (убирает двойное закрытие).
(global as any).__homeResetByVideoCallRef = { current: false };

// КРИТИЧНО: Один переход на Home при отмене звонка (call:cancel). Ключ по from (инициатор): несколько call:cancel с разными callId от одного звонящего = одно действие за окно времени.
(global as any).__callCancelNavDoneRef = { from: '' as string, at: 0 };

// КРИТИЧНО: Глобальная ссылка на функцию переключения микрофона из VideoCall
// Это нужно чтобы можно было запустить startMicMeter даже когда экран звонка размонтирован (в PiP)
(global as any).__toggleMicRef = { current: null as (() => void) | null };

// КРИТИЧНО: Глобальная ссылка на функцию переключения удаленного аудио из VideoCall
// Это нужно чтобы можно было переключать динамик даже когда экран звонка размонтирован (в PiP)
(global as any).__toggleRemoteAudioRef = { current: null as (() => void) | null };

// КРИТИЧНО: Глобальная ссылка на функцию переключения камеры из VideoCall (для PiP).
(global as any).__toggleCamRef = { current: null as (() => void) | null };

const getOverlayPermissionModalStyles = (theme: any, isDark: boolean) => StyleSheet.create({
  overlayPermissionBackdrop: {
    flex: 1,
    backgroundColor: isDark ? 'rgba(5, 8, 14, 0.66)' : 'rgba(26, 35, 52, 0.28)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 24,
  },
  overlayPermissionCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 24,
    padding: 22,
    backgroundColor: isDark ? '#0D0E10' : '#F0F2F5',
    borderWidth: 1,
    borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(113,91,168,0.16)',
    shadowColor: '#000',
    shadowOpacity: isDark ? 0.32 : 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  overlayPermissionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  overlayPermissionIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    backgroundColor: isDark ? 'rgba(4, 4, 4, 0.8)' : 'rgba(113,91,168,0.12)',
    borderWidth: 1,
    borderColor: isDark ? '#4DD0E1' : theme.colors.primary,
  },
  overlayPermissionTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  overlayPermissionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: isDark ? '#4DD0E1' : '#8B7BC8',
  },
  overlayPermissionText: {
    fontSize: 15,
    color: isDark ? '#AEB6C6' : '#444444',
    lineHeight: 22,
    marginBottom: 16,
  },
  overlayPermissionNote: {
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 18,
    backgroundColor: isDark ? '#201C31' : '#F2EEF9',
    borderWidth: 1,
    borderColor: isDark ? 'rgba(113,91,168,0.34)' : 'rgba(113,91,168,0.22)',
  },
  overlayPermissionNoteText: {
    fontSize: 14,
    lineHeight: 20,
    color: isDark ? '#AEB6C6' : '#444444',
    fontWeight: '600',
  },
  overlayPermissionButtons: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    alignItems: 'stretch',
  },
  overlayPermissionButtonSecondary: {
    flex: 0.82,
    minHeight: 52,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
    backgroundColor: isDark ? 'rgba(138, 143, 153, 0.28)' : 'rgba(59, 68, 83, 0.2)',
    borderWidth: 0.2,
    borderColor: isDark ? 'rgba(138, 143, 153, 0.45)' : 'rgba(59, 68, 83, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlayPermissionButtonSecondaryText: {
    fontSize: 15,
    fontWeight: '600',
    color: isDark ? '#AEB6C6' : '#444444',
  },
  overlayPermissionButtonPrimary: {
    flex: 1.28,
    minHeight: 52,
    borderRadius: 14,
    overflow: 'hidden',
  },
  overlayPermissionButtonPrimaryLightOuter: {
    backgroundColor: theme.colors.primary,
    paddingTop: 1,
    paddingLeft: 1,
    paddingRight: 1,
    paddingBottom: 1.5,
  },
  overlayPermissionButtonPrimaryDarkOuter: {
    backgroundColor: '#4DD0E1',
    padding: 1,
  },
  overlayPermissionButtonPrimaryLightInner: {
    flex: 1,
    borderTopLeftRadius: 13,
    borderTopRightRadius: 13,
    borderBottomLeftRadius: 12.5,
    borderBottomRightRadius: 12.5,
    backgroundColor: '#9E8FD6',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  overlayPermissionButtonPrimaryDark: {
    flex: 1,
    borderRadius: 13,
    backgroundColor: 'rgba(4, 4, 4, 0.8)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  overlayPermissionButtonPrimaryText: {
    fontSize: 15,
    fontWeight: '700',
    color: isDark ? '#AEB6C6' : '#444444',
    textAlign: 'center',
  },
  overlayPermissionLinkButton: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingVertical: 6,
  },
});

function AppContent() {
  const { theme, isDark } = useAppTheme();
  const overlayPermissionModalStyles = React.useMemo(
    () => getOverlayPermissionModalStyles(theme, isDark),
    [theme, isDark]
  );
  const pip = usePiP();
  const lang = useLang((s) => s.lang);
  const hydrateLang = useLang((s) => s.hydrate);
  const insets = useSafeAreaInsets();
  /** Пока true — не скрываем оверлей. После обработки initial URL (в т.ч. answer-call) ставим true, чтобы не мелькала Home у принимающего. */
  const [initialUrlProcessed, setInitialUrlProcessed] = React.useState(false);
  /** Android: модалка «Разрешить отображение поверх других окон» при первом заходе (как камера/микрофон). */
  const [overlayPermissionModalVisible, setOverlayPermissionModalVisible] = React.useState(false);

  React.useEffect(() => {
    void hydrateLang();
  }, [hydrateLang]);

  // Ref для различения в onEnd: мы принимающий (отклонили входящий) или звонящий (отменили исходящий)
  const incomingCallIdRef = React.useRef<string | null>(null);

  // FCM входящий при разблокированном экране: pending передан через MainActivity → показать через ConnectionService/CallKeep (баннер не исчезает)
  React.useEffect(() => {
    if (Platform.OS !== 'android') return;
    (async () => {
      const pending = await getAndClearPendingIncomingCallForCallKeep();
      if (!pending?.callId || !pending?.from) return;
      try {
        const ready = await setupCallKeep({ requestPermission: false });
        if (ready) {
          displayIncomingCall(pending.callId, pending.from, pending.fromNick ?? '', true);
          startIncomingCallRingtoneAndVibration();
          logger.info('[App] Pending CallKeep incoming shown', { callId: pending.callId });
        } else {
          await launchIncomingCallActivityScreen(pending.callId, pending.from, pending.fromNick ?? '', true);
          logger.info('[App] Pending incoming shown via native activity fallback', { callId: pending.callId });
        }
        stopIncomingCallForegroundService();
      } catch (e) {
        logger.warn('[App] Pending CallKeep incoming failed', e);
      }
    })();
  }, []);

  // События от нативных экранов: инициатор нажал X на исходящем / получатель нажал X на входящем — очищаем состояние
  React.useEffect(() => {
    if (Platform.OS !== 'android') return () => {};
    const emitter = new NativeEventEmitter();
    const sub1 = emitter.addListener('OutgoingCallCanceledByUser', () => {
      (global as any).__outgoingCanceledByNativeRef = (global as any).__outgoingCanceledByNativeRef ?? { current: false };
      (global as any).__outgoingCanceledByNativeRef.current = true;
      try { emitCloseOutgoingCall(); } catch {}
    });
    const sub2 = emitter.addListener('IncomingCallDeclinedByUser', () => {
      incomingCallIdRef.current = null;
      setIncoming(null);
      try { setIncomingCallScreenVisible(false); } catch {}
      try { stopIncomingCallAlert(); } catch {}
      try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
      // Бейдж «Вызов отменен» на главном экране (тот, кому звонили, отклонил в приложении)
      if (navRef.isReady()) {
        const rn = String(navRef.getCurrentRoute()?.name ?? '');
        if (rn !== 'Home') {
          navRef.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any, params: { callCancelled: true } }] }));
        } else {
          navRef.dispatch(CommonActions.setParams({ callCancelled: true }));
        }
      }
    });
    const sub3 = emitter.addListener('LiviPendingCallAccepted', () => {
      const LiviAppModule = NativeModules.LiviAppModule;
      LiviAppModule?.getAndClearPendingCallAcceptedCallId?.()?.then?.((callId: string | null) => {
        if (callId) {
          logger.info('[App] LiviPendingCallAccepted: requesting call:accepted', { callId });
          try { requestCallAccepted(callId); } catch {}
        }
      });
    });
    const sub4 = emitter.addListener('EndCallFromPiP', () => {
      console.log('[App] [PiP] 📵 EndCallFromPiP получен от натива (нажата кнопка «Завершить» в системном PiP)');
      try {
        (global as any).__endingFromPiPButtonRef = (global as any).__endingFromPiPButtonRef || { current: false };
        (global as any).__endingFromPiPButtonRef.current = true;
      } catch (_) {}
      NativeModules.LiviAppModule?.getPiPEndCallParams?.()?.then?.((params: { callId?: string | null; roomId?: string | null }) => {
        console.log('[App] [PiP] getPiPEndCallParams результат', { callId: params?.callId ?? null, roomId: params?.roomId ?? null });
        const fn = (global as any).__endCallFromNativeRef?.current;
        if (typeof fn === 'function') {
          console.log('[App] [PiP] вызываем endCallImpl(callId, roomId)');
          fn(params?.callId ?? null, params?.roomId ?? null);
        } else {
          console.warn('[App] [PiP] __endCallFromNativeRef.current не функция, endCallImpl не вызван');
        }
      });
    });
    const sub5 = emitter.addListener('SystemPiPModeChanged', (payload: { isInPiP?: boolean }) => {
      if (payload?.isInPiP === false) {
        const ref = (global as any).__pipReturnToCallJustPressedRef as { current?: boolean } | undefined;
        if (ref?.current) {
          ref.current = false;
        }
        // Различие «развернуть» / «закрыть X» делается на нативе: приходит SystemPiPExpanded или EndCallFromPiP
      }
    });
    // Кнопка «развернуть» (стрелки) в системном PiP: натив различает «развернуть» и «закрыть X» (onResume vs таймер).
    // Мы вызываем __pipReturnToCallRef.current() → навигация на VideoCall. __disableSystemPiPUntilRef + 6 с
    // запрещает вход в PiP по onUserLeaveHint, иначе на части устройств при переходе приложение снова уходит в PiP.
    const sub7 = emitter.addListener('SystemPiPExpanded', () => {
      console.log('[App] SystemPiPExpanded received');
      try {
        const g = (global as any);
        g.__disableSystemPiPUntilRef = g.__disableSystemPiPUntilRef || { current: 0 };
        g.__disableSystemPiPUntilRef.current = Date.now() + 6000;
        NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false);
      } catch (_) {}
      const fn = (global as any).__pipReturnToCallRef?.current;
      if (typeof fn === 'function') {
        console.log('[App] Calling __pipReturnToCallRef.current()');
        fn();
        return;
      }
      // Fallback: если ref не установлен (тайминг), берём callId/roomId из глобального ref и навигируем сами
      const params = (global as any).__currentCallPiPParamsRef?.current;
      const nav = (global as any).__navRef;
      console.log('[App] SystemPiPExpanded fallback', { hasParams: !!params, callId: params?.callId, roomId: params?.roomId, navReady: nav?.isReady?.() });
      if (params?.callId && params?.roomId && nav?.isReady?.()) {
        nav.dispatch(
          CommonActions.reset({
            index: 1,
            routes: [
              { name: 'Home' as const },
              { name: 'VideoCall' as const, params: { resume: true, fromPiP: true, callId: params.callId, roomId: params.roomId, directCall: true } },
            ],
          })
        );
        console.log('[App] SystemPiPExpanded fallback: dispatched reset to VideoCall');
      }
    });
    // AboutToEnterSystemPiP обрабатывается в PiPContext (как в WhatsApp/Telegram: компактный вид + requestEnterPictureInPicture, без смены экрана).
    return () => {
      sub1.remove();
      sub2.remove();
      sub3.remove();
      sub4.remove();
      sub5.remove();
      sub7.remove();
    };
  }, []);

  // События answer/end от нативного экрана звонка (Android) — регистрируем после возможного setup
  React.useEffect(() => {
    let unsub: (() => void) | undefined;
    const t = setTimeout(() => {
      unsub = registerCallKeepEvents({
        onAnswer: async (callId) => {
          stopIncomingCallRingtoneAndVibration();
          try { stopIncomingCallForegroundService(); } catch {}
          const info = getPendingCallInfo(callId);
          if (!info || !navRef.isReady()) return;
          incomingCallIdRef.current = null;
          try { setIncomingCallScreenVisible(false); } catch {}
          stopIncomingCallAlert();
          setIncoming(null);
          try {
            await ensureSocketConnected(5000);
            acceptCall(callId);
          } catch {}
          reportAnswerIncomingCall(callId);
          try { emitCloseHomeModals(); } catch {}
          // Push VideoCall поверх текущего экрана (не reset), чтобы после завершения звонка goBack() вернул на тот же экран (Chat, Friends и т.д.).
          navRef.navigate('VideoCall' as any, {
            peerUserId: info.from,
            directCall: true,
            directInitiator: false,
            callId,
            isIncoming: true,
          });
        },
        onEnd: (callId) => {
          stopIncomingCallRingtoneAndVibration();
          try { stopIncomingCallForegroundService(); } catch {}
          const routeName = navRef.getCurrentRoute()?.name;
          if (routeName === 'VideoCall') {
            const endFn = (global as any).__endCallFromNativeRef?.current;
            if (typeof endFn === 'function') endFn(callId, null);
          } else {
            const isCallee = incomingCallIdRef.current === callId;
            if (isCallee) {
              // Принимающий нажал X на нативном экране — отклоняем входящий; сервер пошлёт call:declined звонящему
              incomingCallIdRef.current = null;
              try { declineCall(callId); } catch {}
              try { setIncomingCallScreenVisible(false); } catch {}
              stopIncomingCallAlert();
              setIncoming(null);
              try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
              // Бейдж «Вызов отменен» на главном экране (тот, кому звонили, отклонил)
              if (navRef.isReady()) {
                const rn = String(navRef.getCurrentRoute()?.name ?? '');
                if (rn !== 'Home') {
                  navRef.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any, params: { callCancelled: true } }] }));
                } else {
                  navRef.dispatch(CommonActions.setParams({ callCancelled: true }));
                }
              }
            } else {
              // Звонящий отменил с нативного экрана — отменяем исходящий и сразу закрываем модалку
              try { cancelCall(callId); } catch {}
              try { emitCloseOutgoingCall(); } catch {}
            }
          }
          incomingCallIdRef.current = null;
          reportEndCallToCallKeep(callId);
          stopIncomingCallRingtoneAndVibration();
          try { setIncomingCallScreenVisible(false); } catch {}
          stopIncomingCallAlert();
          setIncoming(null);
          reportRejectCall(callId);
          clearCallRelatedNotificationsAndSyncBadge().catch(() => {});
        },
      });
    }, 4000);
    return () => {
      clearTimeout(t);
      unsub?.();
    };
  }, []);

  // Убрали постоянные логи для уменьшения шума
  const [routeName, setRouteName] = React.useState<string | undefined>(undefined);
  const lastLoggedRouteRef = React.useRef<string | undefined>(undefined);
  // Grace period после перехода на VideoCall/RandomChat: не разрешаем системный PiP по onUserLeaveHint
  // первые 1 с (должен совпадать с таймером в VideoCall), чтобы избежать ложного сворачивания при закрытии IncomingCallActivity.
  // Короткий grace — чтобы на обоих устройствах leaveHint успевал включиться до нажатия Home.
  const VIDEO_SESSION_PIP_GRACE_MS = 1000;
  const videoSessionRouteEnteredAtRef = React.useRef<number>(0);
  const videoSessionRouteLastRef = React.useRef<string | undefined>(undefined);
  const systemPiPDecisionLogRef = React.useRef<string>('');


  // ==== incoming call (global, когда не на экране видеозвонка) ====
  const [incoming, setIncoming] = React.useState<{ callId: string; from: string; fromNick?: string } | null>(null);
  React.useEffect(() => {
    incomingCallIdRef.current = incoming?.callId ?? null;
  }, [incoming]);
  const bounce = React.useRef(new Animated.Value(0)).current;
  const wave1 = React.useRef(new Animated.Value(0)).current;
  const wave2 = React.useRef(new Animated.Value(0)).current;
  
  // Настройка навигационной панели на Android для edge-to-edge
  React.useEffect(() => {
    if (Platform.OS === 'android') {
      // ВНИМАНИЕ:
      // При включённом edge-to-edge expo-navigation-bar выводит WARN для setPositionAsync/setBackgroundColorAsync/setBorderColorAsync.
      // Мы переносим цвета в app.json (через плагин expo-navigation-bar), а в рантайме меняем только стиль кнопок.
      // Это убирает WARN и не ломает UI.
      NavigationBar.setButtonStyleAsync(isDark ? 'light' : 'dark').catch(() => {});
    }
  }, [isDark]);
  
  // КРИТИЧНО: Управление яркостью экрана при показе модального окна входящего вызова на Android
  React.useEffect(() => {
    if (Platform.OS !== 'android') return;
    
    if (incoming) {
      // При показе модального окна входящего вызова
      try {
        // Активируем InCallManager для предотвращения падения яркости
        InCallManager.start({ media: 'video', ringback: '' });
        // Устанавливаем keep screen on для предотвращения затемнения
        (InCallManager as any).setKeepScreenOn?.(true);
        logger.debug('[App] InCallManager started for incoming call modal');
      } catch (e) {
        logger.warn('[App] Failed to start InCallManager for incoming call:', e);
      }
    } else {
      // При закрытии модального окна
      try {
        // Останавливаем InCallManager только если нет активного звонка
        // Проверяем через routeName - если мы не на экране видеозвонка, то можно остановить
        let currentRoute: string | undefined = undefined;
        if (navRef.isReady()) {
          currentRoute = navRef.getCurrentRoute()?.name;
        } else {
          // Fallback на routeName из state, если навигация еще не готова
          currentRoute = routeName;
        }
        // КРИТИЧНО: Если PiP видим, нельзя останавливать InCallManager — иначе пропадет звук в PiP.
        const pipVisible = !!(pip as any)?.visible || !!(global as any).__pipVisibleRef?.current;
        if (!isVideoSessionRoute(currentRoute) && !pipVisible) {
          (InCallManager as any).setKeepScreenOn?.(false);
          InCallManager.stop();
          logger.debug('[App] InCallManager stopped after incoming call modal closed');
        }
      } catch (e) {
        logger.warn('[App] Failed to stop InCallManager:', e);
      }
    }
  }, [incoming, routeName]);

  // 🔔 Рингтон/вибрация для входящего звонка (когда показываем глобальную модалку)
  React.useEffect(() => {
    if (incoming) startIncomingCallAlert();
    else stopIncomingCallAlert();
    return () => {
      // На всякий случай при размонтировании
      stopIncomingCallAlert();
    };
  }, [incoming]);
  // Храним недавно отменённые/истёкшие вызовы, чтобы избежать гонок событий (declined/timeout перед incoming)
  const canceledCallsRef = React.useRef<Map<string, number>>(new Map());
  const timedOutCallsRef = React.useRef<Map<string, number>>(new Map());
  // Время последнего инкремента пропущенного по userId (из сокета) — чтобы не дублировать при применении pending с FCM
  const lastMissedIncrementTimeByUserRef = React.useRef<Record<string, number>>({});
  // Ref для хранения обработчика входящего звонка, чтобы он всегда был доступен
  const incomingCallHandlerRef = React.useRef<((d: { callId: string; from: string; fromNick?: string }) => void) | null>(null);


  const startAnim = React.useCallback(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(bounce, { toValue: 1, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(bounce, { toValue: -1, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(bounce, { toValue: 0, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.delay(300),
      ])
    ).start();

    const loop = (v: Animated.Value, delay: number) => {
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, { toValue: 1, duration: 1400, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      ).start();
    };
    loop(wave1, 0); loop(wave2, 400);
  }, [bounce, wave1, wave2]);

  const stopAnim = React.useCallback(() => {
    bounce.stopAnimation(); wave1.stopAnimation(); wave2.stopAnimation();
  }, [bounce, wave1, wave2]);
  React.useEffect(() => {
    // Откладываем инициализацию до после первого фрейма — чтобы JS context был готов (expo-av JSI bindings, меньше contention).
    const cancel = InteractionManager.runAfterInteractions(() => {
      (async () => {
        try {
          // 🔊 Конфиг аудио (после runAfterInteractions — контекст готов, меньше шанс "JS context is not available")
          await Audio.setAudioModeAsync({
            playsInSilentModeIOS: true,
            // Default app-wide mode: playback (not recording). Recording-enabled modes can route audio to the receiver on iOS.
            allowsRecordingIOS: false,
            // IMPORTANT: do not keep audio session alive in background to avoid battery drain.
            staysActiveInBackground: false,
            shouldDuckAndroid: false,
            // IMPORTANT: do not force earpiece output. Let OS route (speaker / wired / BT) for consistent loud playback.
            playThroughEarpieceAndroid: false,
          });
        } catch (e) {
          logger.warn("Audio setAudioModeAsync failed:", e);
        }

        try {
          // ✅ Инициализация CometChat (один раз на старте)
          await ensureCometChatReady();
        } catch (e) {
          logger.error("CometChat init failed:", e);
        }

      // 🔔 Запрашиваем разрешение на уведомления сразу при старте (Android 13+ / iOS),
      // чтобы пользователь увидел системный диалог до любых фоновых токен-регистраций.
      try {
        await ensureInitialNotificationPermissions();
      } catch {}

      // 🎥🎙️ Запрашиваем разрешения камеры/микрофона на старте.
      // На части Android 8.x (в т.ч. ColorOS) это снижает шанс "тихого" фейла WebRTC захвата.
      try {
        await ensureInitialMediaPermissions();
      } catch {}

      // 📞 Android: разрешение «звонки и управление ими» (CallKeep/ConnectionService) — запрашиваем вместе с остальными,
      // чтобы диалог не появлялся поверх экрана исходящего звонка.
      if (Platform.OS === 'android') {
        try {
          await setupCallKeep({ requestPermission: true });
        } catch {}
      }

        // 📱 Android: модалка «показ поверх других окон» — только один раз при первом запуске после установки.
      if (Platform.OS === 'android') {
        try {
          const overlayShown = await AsyncStorage.getItem(OVERLAY_PERMISSION_MODAL_SHOWN_KEY);
          if (overlayShown !== '1') {
            const can = await canDrawOverlays();
            if (!can) {
              await AsyncStorage.setItem(OVERLAY_PERMISSION_MODAL_SHOWN_KEY, '1');
              setOverlayPermissionModalVisible(true);
            }
          }
        } catch (_) {}
      }

      })();
    });
    return () => cancel.cancel();
  }, []);

  // 🔔 Push notifications: register token once we have userId
  React.useEffect(() => {
    let cancelled = false;
    let cleanupListeners: null | (() => void) = null;

    (async () => {
      try {
        cleanupListeners = addNotificationListeners();
      } catch {}

      // ждём userId (boot() в sockets/socket.ts асинхронный)
      for (let i = 0; i < 12 && !cancelled; i++) {
        try {
          const uid = getCurrentUserId?.();
          if (uid) {
            await registerAndSendPushToken(uid, { reason: 'startup' });
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();

    return () => {
      cancelled = true;
      try { cleanupListeners?.(); } catch {}
    };
  }, []);

  // Android: при старте приложения применить пропущенные, показанные из нативного кода (FCM call_ended), чтобы бейдж совпадал с числом уведомлений в шторке
  // И при тапе по уведомлению «Пропущенный вызов» — перейти на вкладку Друзья
  React.useEffect(() => {
    if (Platform.OS !== 'android') return;
    const LiviAppModule = NativeModules.LiviAppModule;
    const key = 'missed_calls_by_user_v1';
    let cancelled = false;
    const GO_TO_FRIENDS_RETRIES = 25;
    const GO_TO_FRIENDS_DELAY_MS = 100;
    const goToFriends = (retryCount = 0) => {
      if (cancelled) return;
      if (navRef.isReady()) {
        navRef.dispatch(CommonActions.navigate({ name: 'Home', params: { openFriendsMenu: true, openFriendsTab: true } }));
        return;
      }
      if (retryCount < GO_TO_FRIENDS_RETRIES) {
        setTimeout(() => goToFriends(retryCount + 1), GO_TO_FRIENDS_DELAY_MS);
      }
    };
    (async () => {
      // Сразу проверяем «открыли по тапу Пропущенный вызов» и помечаем «увидел», чтобы ни syncAppBadgeFromMissedCount, ни синхронизация с нативом не пересоздавали уведомление и иконку в статус-баре
      const open = await (LiviAppModule?.getAndClearPendingOpenTabFriends?.() ?? Promise.resolve(false));
      if (open) await setMissedBadgeCleared();
      try {
        const arr = (await (LiviAppModule?.getAndClearPendingMissedCalls?.() ?? Promise.resolve([]))) as string[];
        if (arr?.length && !cancelled) {
          const raw = await AsyncStorage.getItem(key);
          const map = raw ? JSON.parse(raw) : {};
          const MISSED_APPLY_SKIP_MS = 15000;
          // Считаем количество пропущенных по каждому userId (массив — по одному элементу на каждый показ «Пропущенный вызов» из FCM)
          const countByUid: Record<string, number> = {};
          for (const u of arr) {
            if (!u) continue;
            countByUid[u] = (countByUid[u] || 0) + 1;
          }
          for (const uid of Object.keys(countByUid)) {
            const lastInc = lastMissedIncrementTimeByUserRef.current[uid];
            if (lastInc && Date.now() - lastInc < MISSED_APPLY_SKIP_MS) continue;
            if (wasAppliedFromReauth(uid)) continue;
            const add = countByUid[uid] || 1;
            map[uid] = (map[uid] || 0) + add;
            try { recordAppliedFromPending(uid); } catch {}
            try { emitMissedIncrement(uid); } catch {}
          }
          await AsyncStorage.setItem(key, JSON.stringify(map));
          await clearMissedBadgeCleared();
          await syncAppBadgeFromMissedCount();
        }
      } catch (e) {
        logger.warn('[App] getAndClearPendingMissedCalls on mount failed', e);
      }
      if (cancelled) return;
      await syncAppBadgeFromMissedCount();
      // Синхронизировать счётчик в шторке с источником истины (AsyncStorage) при каждом старте
      if (Platform.OS === 'android') {
        try {
          const badgeCleared = await AsyncStorage.getItem('missed_calls_badge_cleared_v1');
          const raw2 = await AsyncStorage.getItem(key);
          const map2 = raw2 ? JSON.parse(raw2) as Record<string, number> : {};
          const setOnly = badgeCleared === 'true';
          for (const uid of Object.keys(map2 || {})) {
            const c = map2[uid];
            if (uid && typeof c === 'number' && c > 0) {
              if (setOnly) LiviAppModule?.setMissedCountForUserOnly?.(uid, c);
              else LiviAppModule?.syncMissedCountForUser?.(uid, c);
            }
          }
        } catch (_) {}
      }
      if (open) goToFriends();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Android: при возврате в приложение (тап по уведомлению «Пропущенный вызов») — открыть меню и вкладку Друзья; сразу помечаем «увидел», чтобы синхронизация с нативом не пересоздала уведомление
  React.useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      NativeModules.LiviAppModule?.getAndClearPendingOpenTabFriends?.()?.then?.((open: boolean) => {
        if (!open) return;
        setMissedBadgeCleared().catch(() => {});
        const go = (retry = 0) => {
          if (navRef.isReady()) {
            navRef.dispatch(CommonActions.navigate({ name: 'Home', params: { openFriendsMenu: true, openFriendsTab: true } }));
            return;
          }
          if (retry < 15) setTimeout(() => go(retry + 1), 100);
        };
        go();
      });
    });
    return () => sub.remove();
  }, []);

  // При возврате в приложение перерегистрируем push-токен (в т.ч. fcmToken на Android), чтобы не терять FCM после пуша сообщения.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const uid = getCurrentUserId?.();
      if (uid) registerAndSendPushToken(uid, { reason: 'app_active' }).catch(() => {});
    });
    return () => sub.remove();
  }, []);

  // ===== Deep Linking: звонки livi://incoming-call | livi://answer-call | livi://decline-call =====
  const handleIncomingCallDeepLink = async (url: string) => {
    try {
      const m = url.match(/livi:\/\/incoming-call[?]?(.*)/i);
      if (!m) return;
      const search = m[1] || '';
      const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
      const callId = params.get('callId') || params.get('call_id') || '';
      const from = params.get('from') || params.get('userId') || '';
      const fromNick = params.get('fromNick') ?? '';
      if (callId && from) {
        logger.info('[App] Incoming call deep link: showing native IncomingCallActivity', { callId, from });
        if (Platform.OS === 'android') {
          launchIncomingCallActivityScreen(callId, from, fromNick);
        } else {
          await openIncomingCallScreen(from, callId);
        }
      }
    } catch (e) {
      logger.warn('[App] handleIncomingCallDeepLink failed', e);
    }
  };

  const handleCallDeepLink = async (url: string) => {
    try {
      if (/livi:\/\/answer-call/i.test(url)) {
        const params = new URLSearchParams(url.replace(/^[^?]*\?/, ''));
        const callId = params.get('callId') || params.get('call_id') || '';
        const from = params.get('from') || params.get('userId') || '';
        if (callId && from) {
          logger.info('[App] answer-call deep link: opening call', { callId, from });
          // Android: снять уведомление входящего и остановить FGS сразу после "Принять"
          if (Platform.OS === 'android') {
            try { stopIncomingCallForegroundService(); } catch {}
            try { sendCallAnsweredBroadcast(callId); } catch {}
          }
          await openAnswerCallScreen(from, callId);
          return true;
        }
      }
      if (/livi:\/\/decline-call/i.test(url)) {
        const params = new URLSearchParams(url.replace(/^[^?]*\?/, ''));
        const callId = params.get('callId') || params.get('call_id') || '';
        if (callId) {
          logger.info('[App] decline-call deep link', { callId });
          await handleDeclineCallFromDeepLink(callId);
          return true;
        }
      }
      if (/livi:\/\/cancel-outgoing/i.test(url)) {
        const params = new URLSearchParams(url.replace(/^[^?]*\?/, ''));
        const callId = params.get('callId') || params.get('call_id') || '';
        if (callId) {
          logger.info('[App] cancel-outgoing deep link', { callId });
          try { cancelCall(callId); } catch {}
          setTimeout(() => { try { cancelCall(callId); } catch {} }, 150);
          try { reportEndCallToCallKeep(callId); } catch {}
          try { setOutgoingCallScreenVisible(false); } catch {}
          try { emitCloseOutgoingCall(); } catch {}
          try { closeOutgoingCallActivity(); } catch {}
          return true;
        }
      }
    } catch (e) {
      logger.warn('[App] handleCallDeepLink failed', e);
    }
    return false;
  };

  // Глобальный обработчик для deep link livi:// (decline-call, answer-call, incoming-call): expo-dev-launcher в dev перехватывает ссылки и показывает модалку — патч вызывает этот ref и не показывает модалку, чтобы отмена/принятие звонка сработали
  const handleCallDeepLinkRef = React.useRef<(url: string) => Promise<boolean>>(async () => false);
  handleCallDeepLinkRef.current = handleCallDeepLink;
  React.useEffect(() => {
    (global as any).__handleCallDeepLinkRef = handleCallDeepLinkRef;
    return () => {
      delete (global as any).__handleCallDeepLinkRef;
    };
  }, []);

  // Сохраняем installId, serverUrl, userId в натив (POST /api/calls/decline с экрана входящего без JS)
  React.useEffect(() => {
    if (Platform.OS !== 'android') return;
    const LiviAppModule = NativeModules.LiviAppModule;
    if (!LiviAppModule?.setInstallIdForDecline || !LiviAppModule?.setServerUrlForDecline) return;
    const syncDeclinePrefs = async () => {
      try {
        const [installId, url] = await Promise.all([getInstallId(), Promise.resolve(API_BASE)]);
        if (installId) LiviAppModule.setInstallIdForDecline(installId);
        if (url) LiviAppModule.setServerUrlForDecline(url);
        const uid = getCurrentUserId?.() ?? '';
        if (LiviAppModule.setUserIdForDecline) {
          if (uid) LiviAppModule.setUserIdForDecline(uid);
          else LiviAppModule.setUserIdForDecline(null);
        }
        setOutgoingCallTimeoutMs(OUTGOING_CALL_TIMEOUT_MS);
      } catch {}
    };
    void syncDeclinePrefs();
    const off = onCurrentUserId?.(() => {
      void syncDeclinePrefs();
    });
    return () => {
      try {
        off?.();
      } catch {}
    };
  }, []);

  // ===== Deep Linking обработка для реферальных ссылок =====
  const INVITE_LINK_KEY = 'pending_invite_code';
  React.useEffect(() => {
    const handleInitialUrl = async () => {
      try {
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl) {
          const handled = await handleCallDeepLink(initialUrl);
          if (!handled) {
            await handleIncomingCallDeepLink(initialUrl);
            if (!initialUrl.includes('expo-development-client') && !/^exp\+livi-video-chat:\/\//i.test(initialUrl)) {
              handleInviteLink(initialUrl);
            }
          }
        }
      } catch (e) {
        logger.warn('Failed to get initial URL:', e);
      } finally {
        setInitialUrlProcessed(true);
      }
    };

    const handleUrl = async (event: { url: string }) => {
      const handled = await handleCallDeepLink(event.url);
      if (!handled) {
        await handleIncomingCallDeepLink(event.url);
        if (!event.url.includes('expo-development-client') && !/^exp\+livi-video-chat:\/\//i.test(event.url)) {
          handleInviteLink(event.url);
        }
      }
    };

    const subscription = Linking.addEventListener('url', handleUrl);
    
    // Проверяем начальную ссылку
    handleInitialUrl();

    // Проверяем сохраненный код приглашения при старте (с небольшой задержкой для готовности навигации)
    setTimeout(() => {
      checkPendingInvite();
    }, 1000);

    return () => {
      subscription.remove();
    };
  }, []);

  // Функция обработки реферальной ссылки
  const handleInviteLink = async (url: string) => {
    try {
      if (url.includes('expo-development-client') || /^exp\+livi-video-chat:\/\//i.test(url)) {
        return;
      }
      logger.debug('[App] Processing invite link:', url);

      // Парсим URL: 
      // - livi://invite/{code} (custom scheme для тестирования)
      // - https://livi.app/invite/{code} (Universal Links для продакшена)
      // - http://livi.app/invite/{code} (fallback)
      let inviteMatch = url.match(/livi:\/\/invite\/([a-f\d]{24})/i);
      if (!inviteMatch) {
        inviteMatch = url.match(/\/invite\/([a-f\d]{24})/i);
      }
      
      if (!inviteMatch) {
        logger.debug('[App] URL does not match invite pattern');
        return;
      }

      const code = inviteMatch[1];
      logger.info('[App] Extracted invite code:', code);

      const userId = getCurrentUserId();
      
      if (!userId) {
        // Пользователь не авторизован - сохраняем код для обработки после авторизации
        await AsyncStorage.setItem(INVITE_LINK_KEY, code);
        logger.info('[App] User not authorized, saved invite code for later');
        return;
      }

      // Пользователь авторизован - обрабатываем сразу
      await processInviteCode(code);
    } catch (e) {
      logger.error('[App] Error handling invite link:', e);
    }
  };

  // Функция обработки кода приглашения
  const processInviteCode = async (code: string) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) {
        logger.warn('[App] Cannot process invite: user not authorized');
        return;
      }

      // Проверяем ссылку через API
      const result = await checkInviteLink(code);
      
      if (!result.ok) {
        logger.warn('[App] Invalid invite link:', result.error);
        return;
      }

      if (result.areFriends) {
        // Пользователи уже друзья - показываем сообщение
        logger.info('[App] Users are already friends');
        // Можно показать toast или модалку
        return;
      }

      if (result.hasPendingRequest) {
        // Заявка уже отправлена
        logger.info('[App] Friend request already pending');
        return;
      }

      if (result.canAdd && result.inviter) {
        // Можно добавить в друзья - сохраняем информацию для показа модалки
        await AsyncStorage.setItem(INVITE_LINK_KEY, JSON.stringify({
          code,
          inviter: result.inviter,
          timestamp: Date.now(),
        }));
        
        // КРИТИЧНО: Навигация на Home с параметром для показа модалки
        // Используем reset для гарантированного открытия HomeScreen
        if (navRef.isReady()) {
          const currentRoute = navRef.getCurrentRoute()?.name;
          
          // Если уже на Home, просто обновляем параметры
          if (currentRoute === 'Home') {
            navRef.dispatch(
              CommonActions.setParams({
                showInviteModal: true,
                inviteCode: code,
              })
            );
          } else {
            // Если на другом экране - сбрасываем навигацию на Home
            navRef.dispatch(
              CommonActions.reset({
                index: 0,
                routes: [
                  {
                    name: 'Home',
                    params: { showInviteModal: true, inviteCode: code },
                  },
                ],
              })
            );
          }
        } else {
          // Если навигация еще не готова - сохраняем для обработки позже
          logger.info('[App] Navigation not ready, will process invite when ready');
        }
      }
    } catch (e) {
      logger.error('[App] Error processing invite code:', e);
    }
  };

  // Проверка сохраненного кода приглашения
  const checkPendingInvite = async () => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return;

      const saved = await AsyncStorage.getItem(INVITE_LINK_KEY);
      if (!saved) return;

      // Пытаемся распарсить как JSON (новый формат) или как строку (старый формат)
      let code: string;
      try {
        const parsed = JSON.parse(saved);
        code = parsed.code || saved;
      } catch {
        code = saved;
      }

      await processInviteCode(code);
      // Удаляем после обработки
      await AsyncStorage.removeItem(INVITE_LINK_KEY);
    } catch (e) {
      logger.error('[App] Error checking pending invite:', e);
    }
  };

  // КРИТИЧНО: Поддержание экрана включенным ТОЛЬКО когда это нужно (звонок/рандомчат/входящий/PiP).
  // Глобальный агрессивный InCallManager.start на некоторых Android может приводить к сворачиванию/крашам.
  React.useEffect(() => {
    // Проверяем что модуль доступен
    if (!activateKeepAwakeAsync || !deactivateKeepAwakeAsync) {
      logger.warn('Keep-awake module not available, skipping initialization');
      return;
    }

    // Нужно ли держать экран включённым именно сейчас
    let currentRoute: string | undefined = undefined;
    try {
      currentRoute = navRef.isReady() ? navRef.getCurrentRoute()?.name : routeName;
    } catch {
      currentRoute = routeName;
    }
    const pipVisible = !!(pip as any)?.visible || !!(global as any).__pipVisibleRef?.current;
    const shouldKeepOn = isVideoSessionRoute(currentRoute) || !!incoming || pipVisible;

    // Отслеживание перехода на экран видеозвонка/рандомчата для grace period
    const onVideoSessionRoute = isVideoSessionRoute(currentRoute);
    const lastRoute = videoSessionRouteLastRef.current;
    if (onVideoSessionRoute) {
      if (!isVideoSessionRoute(lastRoute)) {
        videoSessionRouteEnteredAtRef.current = Date.now();
      }
      videoSessionRouteLastRef.current = currentRoute;
    } else {
      videoSessionRouteLastRef.current = currentRoute;
    }

    // Android: системный PiP разрешаем ТОЛЬКО при реально активном звонке/входящем/видимом PiP,
    // а не просто потому что текущий экран = VideoCall (иначе при call:ended может произойти автозаход в PiP).
    if (Platform.OS === 'android') {
      try {
        const g = (global as any);
        const sessionForGuard = g.__webrtcSessionRef?.current;
        const sessionNotEndedForGuard =
          !!sessionForGuard && (typeof sessionForGuard.isEnded === 'function' ? !sessionForGuard.isEnded() : true);
        // При активном звонке (экран VideoCall или in-app PiP) guard не должен гасить leaveHint —
        // иначе по нажатию Home системный PiP не покажется.
        const allowWhileGuardActive =
          (!!pipVisible && !isVideoSessionRoute(currentRoute)) ||
          (isVideoSessionRoute(currentRoute) && sessionNotEndedForGuard);
        // Глобальный guard: после завершения звонка запрещаем системный PiP на короткое время,
        // чтобы исключить гонку (cleanup/reset → onUserLeaveHint → PiP + лаунчер).
        const disableUntil = g.__disableSystemPiPUntilRef?.current;
        if (typeof disableUntil === 'number' && disableUntil > Date.now() && !allowWhileGuardActive) {
          const logKey = `guard:disableUntil:${currentRoute}:${disableUntil}:${allowWhileGuardActive}`;
          if (systemPiPDecisionLogRef.current !== logKey) {
            systemPiPDecisionLogRef.current = logKey;
            logger.info('[App] system PiP leaveHint disabled by global guard', {
              currentRoute,
              disableUntil,
              remainingMs: disableUntil - Date.now(),
              allowWhileGuardActive,
            });
          }
          NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false);
        } else {
        const systemPiPEntryUntil = g.__systemPiPEntryInProgressUntilRef?.current;
        const systemPiPEntryInProgress =
          typeof systemPiPEntryUntil === 'number' && systemPiPEntryUntil > Date.now();
        const session = g.__webrtcSessionRef?.current;
        const sessionNotEnded =
          !!session && (typeof session.isEnded === 'function' ? !session.isEnded() : true);
        const params = g.__currentCallPiPParamsRef?.current;
        const hasAnyIds =
          !!params?.callId ||
          !!params?.roomId ||
          (!!session && typeof session.getRoomId === 'function' && !!session.getRoomId()) ||
          (!!session && typeof session.getCallId === 'function' && !!session.getCallId());
        const hasActiveCallForPiP = sessionNotEnded && hasAnyIds;
        const onVideoCallWithActiveSession = isVideoSessionRoute(currentRoute) && sessionNotEnded;
        // Grace period: первые VIDEO_SESSION_PIP_GRACE_MS мс после перехода на VideoCall/RandomChat
        // не разрешаем системный PiP по onUserLeaveHint (ложный hint при закрытии IncomingCallActivity).
        const onVideoCallRecently = onVideoSessionRoute && (Date.now() - videoSessionRouteEnteredAtRef.current) < VIDEO_SESSION_PIP_GRACE_MS;
        const allowSystemPiP =
          (systemPiPEntryInProgress && hasActiveCallForPiP) ||
          pipVisible ||
          !!incoming ||
          ((hasActiveCallForPiP || onVideoCallWithActiveSession) && !onVideoCallRecently);
        // На экране VideoCall во время grace не трогаем leaveHint — управляет только VideoCall.
        // Иначе эффект App перезаписывает флаг в false и на одном устройстве системный PiP не открывается по Home.
        const skipSetLeaveHint =
          onVideoSessionRoute && sessionNotEnded && onVideoCallRecently;
        const logKey = JSON.stringify({
          currentRoute,
          allowSystemPiP: !!allowSystemPiP,
          pipVisible: !!pipVisible,
          hasIncoming: !!incoming,
          hasActiveCallForPiP: !!hasActiveCallForPiP,
          onVideoCallWithActiveSession: !!onVideoCallWithActiveSession,
          onVideoCallRecently: !!onVideoCallRecently,
          hasParamsCallId: !!params?.callId,
          hasParamsRoomId: !!params?.roomId,
          sessionNotEnded: !!sessionNotEnded,
          systemPiPEntryInProgress: !!systemPiPEntryInProgress,
        });
        if (systemPiPDecisionLogRef.current !== logKey) {
          systemPiPDecisionLogRef.current = logKey;
          logger.info('[App] system PiP leaveHint recalculated', {
            currentRoute,
            allowSystemPiP: !!allowSystemPiP,
            allowWhileGuardActive,
            pipVisible: !!pipVisible,
            hasIncoming: !!incoming,
            hasActiveCallForPiP: !!hasActiveCallForPiP,
            onVideoCallWithActiveSession: !!onVideoCallWithActiveSession,
            onVideoCallRecently: !!onVideoCallRecently,
            skipSetLeaveHint: !!skipSetLeaveHint,
            timeSinceVideoRouteMs: onVideoSessionRoute ? Date.now() - videoSessionRouteEnteredAtRef.current : null,
            hasParamsCallId: !!params?.callId,
            hasParamsRoomId: !!params?.roomId,
            sessionNotEnded: !!sessionNotEnded,
            systemPiPEntryInProgress: !!systemPiPEntryInProgress,
          });
        }
        if (!skipSetLeaveHint) {
          NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(!!allowSystemPiP);
        }
        }
      } catch (_) {}
    }

    let appStateSubscription: any = null;
    let keepAwakeInterval: ReturnType<typeof setInterval> | null = null;
    let androidKeepScreenOnInterval: ReturnType<typeof setInterval> | null = null;
    let pipKeepScreenOnInterval: ReturnType<typeof setInterval> | null = null;
    
    const activateKeepAwake = () => {
      if (activateKeepAwakeAsync) {
        activateKeepAwakeAsync().catch((e) => {
          logger.warn('Failed to activate keep-awake:', e);
        });
      }
    };
    
    const activateAndroidKeepScreenOn = () => {
      if (Platform.OS === 'android') {
        try {
          // Убеждаемся что InCallManager запущен
          InCallManager.start({ media: 'video', ringback: '' });
          // Устанавливаем keep screen on
          (InCallManager as any).setKeepScreenOn?.(true);
          // Также активируем expo-keep-awake для Android (дополнительная защита)
          if (activateKeepAwakeAsync) {
            activateKeepAwakeAsync().catch((e) => {
              logger.warn('[App] Failed to activate keep-awake for Android:', e);
            });
          }
          logger.debug('[App] setKeepScreenOn(true) and keep-awake reactivated for Android');
        } catch (e) {
          logger.warn('[App] Failed to reactivate setKeepScreenOn on Android:', e);
        }
      }
    };
    
    const handleAppStateChange = (nextAppState: string) => {
      if (!shouldKeepOn) return;
      if (nextAppState === 'active' || nextAppState === 'inactive') {
        // Останавливаем интервал «экран не гаснет в PiP», когда вернулись из фона
        if (pipKeepScreenOnInterval) {
          clearInterval(pipKeepScreenOnInterval);
          pipKeepScreenOnInterval = null;
        }
        // КРИТИЧНО: Приложение активно или неактивно (но видно) - ВСЕГДА активируем keep-awake
        // 'inactive' на iOS означает, что приложение видно, но не полностью активно
        // (например, показывается Control Center или уведомление)
        // НЕ ДОЛЖНО ЗАКРЫВАТЬСЯ пока пользователь в приложении
        activateKeepAwake();
        
        // КРИТИЧНО: Для Android ВСЕГДА используем InCallManager для предотвращения засыпания экрана
        if (Platform.OS === 'android') {
          activateAndroidKeepScreenOn();
          
          // Запускаем периодическую переактивацию для Android (каждые 3 секунды)
          // чтобы предотвратить затемнение экрана системой
          if (!androidKeepScreenOnInterval) {
            androidKeepScreenOnInterval = setInterval(() => {
              if (AppState.currentState === 'active' || AppState.currentState === 'inactive') {
                activateAndroidKeepScreenOn();
              }
            }, 3000); // Переактивируем каждые 3 секунды для Android (максимально агрессивная защита)
          }
        }
      } else if (nextAppState === 'background') {
        // Проверяем: в системном PiP с активным звонком — экран не гасим до завершения звонка
        const g = (global as any);
        const inPiP = g.__pipVisibleRef?.current === true || g.__pipInSystemModeRef?.current === true;
        const session = g.__webrtcSessionRef?.current;
        const activeVideoCallNotEnded = !!session && (typeof session.isEnded !== 'function' ? true : !session.isEnded());
        const keepScreenOnInPiP = inPiP && activeVideoCallNotEnded;

        if (!keepScreenOnInPiP) {
          // Обычный фон — деактивируем для экономии батареи
          if (keepAwakeInterval) {
            clearInterval(keepAwakeInterval);
            keepAwakeInterval = null;
          }
          if (androidKeepScreenOnInterval) {
            clearInterval(androidKeepScreenOnInterval);
            androidKeepScreenOnInterval = null;
          }
          if (pipKeepScreenOnInterval) {
            clearInterval(pipKeepScreenOnInterval);
            pipKeepScreenOnInterval = null;
          }
          if (deactivateKeepAwakeAsync) {
            deactivateKeepAwakeAsync().catch((e) => {
              logger.warn('Failed to deactivate keep-awake:', e);
            });
            logger.debug('Keep-awake deactivated (app background)');
          }
        } else {
          // В PiP с активным звонком — keep-awake не выключаем, экран не гасим
          if (!pipKeepScreenOnInterval) {
            pipKeepScreenOnInterval = setInterval(() => {
              activateKeepAwake();
              if (Platform.OS === 'android') {
                activateAndroidKeepScreenOn();
              }
            }, 3000);
          }
          logger.debug('[App] Background in PiP: keep-awake left on until call ends');
        }
        // Для Android деактивируем setKeepScreenOn и InCallManager только если НЕ в PiP и НЕ активный видеозвонок.
        // В системном PiP звук звонка должен оставаться громким — InCallManager.stop() сбрасывает аудио-сессию и делает звук тихим.
        // Страховка: не вызывать stop(), если есть активная сессия (ref'ы PiP могли не успеть проставиться в release).
        if (Platform.OS === 'android') {
          try {
            if (!inPiP && !activeVideoCallNotEnded) {
              (InCallManager as any).setKeepScreenOn?.(false);
              InCallManager.stop();
              logger.info('[App] AppState background: InCallManager.stop() called (no PiP, no active call)');
            } else {
              logger.info('[App] AppState background: Skip InCallManager.stop() — keep call audio', {
                inPiP,
                activeVideoCallNotEnded,
                pipVisibleRef: g.__pipVisibleRef?.current,
                pipInSystemModeRef: g.__pipInSystemModeRef?.current,
              });
            }
          } catch (e) {
            logger.warn('[App] Failed to setKeepScreenOn(false) on Android:', e);
          }
        }
      }
    };

    // Если не на экранах звонка/нет входящего/PiP — ничего не держим включённым.
    if (!shouldKeepOn) {
      try {
        deactivateKeepAwakeAsync?.().catch(() => {});
      } catch {}
      if (Platform.OS === 'android') {
        try {
          (InCallManager as any).setKeepScreenOn?.(false);
          InCallManager.stop();
        } catch {}
      }
      return;
    }

    // Активируем сразу при монтировании если приложение активно или неактивно
    const currentState = AppState.currentState;
    
    if (currentState === 'active' || currentState === 'inactive') {
      activateKeepAwake();
      
      // Для Android включаем keep-screen-on только в call-like режиме
      if (Platform.OS === 'android') {
        activateAndroidKeepScreenOn();
        
        // Запускаем периодическую переактивацию реже, чтобы не спамить нативные вызовы
        androidKeepScreenOnInterval = setInterval(() => {
          if (AppState.currentState === 'active' || AppState.currentState === 'inactive') {
            activateAndroidKeepScreenOn();
          }
        }, 8000);
      }
    }

    // Отслеживаем изменения AppState
    appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
    
    return () => {
      if (Platform.OS === 'android') {
        try {
          // Не выключать leaveHint во время входа в системный PiP (Home во время звонка):
          // иначе повторный запуск эффекта (из-за pip.visible/route) гасит флаг до срабатывания onUserLeaveHint.
          const g = (global as any);
          const systemPiPEntryUntil = g?.__systemPiPEntryInProgressUntilRef?.current;
          const enteringSystemPiP = typeof systemPiPEntryUntil === 'number' && systemPiPEntryUntil > Date.now();
          if (!enteringSystemPiP) {
            NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false);
          }
        } catch (_) {}
      }
      // Останавливаем интервалы
      if (keepAwakeInterval) {
        clearInterval(keepAwakeInterval);
        keepAwakeInterval = null;
      }
      if (androidKeepScreenOnInterval) {
        clearInterval(androidKeepScreenOnInterval);
        androidKeepScreenOnInterval = null;
      }
      if (pipKeepScreenOnInterval) {
        clearInterval(pipKeepScreenOnInterval);
        pipKeepScreenOnInterval = null;
      }
      // Деактивируем при unmount
      if (deactivateKeepAwakeAsync) {
        deactivateKeepAwakeAsync().catch((e) => {
          logger.warn('Failed to deactivate keep-awake on unmount:', e);
        });
        logger.debug('Keep-awake deactivated (unmount)');
      }
      // Для Android деактивируем setKeepScreenOn при unmount
      if (Platform.OS === 'android') {
        try {
          (InCallManager as any).setKeepScreenOn?.(false);
          InCallManager.stop();
          logger.debug('[App] setKeepScreenOn(false) deactivated for Android (unmount)');
        } catch (e) {
          logger.warn('[App] Failed to setKeepScreenOn(false) on Android (unmount):', e);
        }
      }
      if (appStateSubscription) {
        appStateSubscription.remove();
      }
    };
  }, [routeName, incoming, (pip as any)?.visible]); // пересчитываем need-to-keep-on по состоянию приложения

  // КРИТИЧНО: Убрана глобальная обработка блокировки экрана из App.tsx
  // Логика завершения звонков при блокировке экрана теперь полностью обрабатывается в VideoCall.tsx
  // VideoCall.tsx правильно различает звонки друзьям (не завершаются) и рандомные чаты (завершаются)
  // Это предотвращает конфликты и дублирование логики

  // КРИТИЧНО: Обработчик входящего звонка - должен быть всегда зарегистрирован
  // Используем useRef для хранения функции, чтобы она не пересоздавалась
  const INCOMING_CALL_DEBOUNCE_MS = 3000;
  const lastProcessedIncomingRef = React.useRef<{ callId: string; at: number } | null>(null);

  const handleIncomingCall = React.useCallback((d: { callId: string; from: string; fromNick?: string }) => {
    const callId = String(d?.callId ?? '');
    const now = Date.now();
    const last = lastProcessedIncomingRef.current;
    if (callId && last?.callId === callId && now - last.at < INCOMING_CALL_DEBOUNCE_MS) {
      logger.debug('[call:incoming] debounced duplicate', { callId });
      return;
    }
    lastProcessedIncomingRef.current = callId ? { callId, at: now } : null;
    logger.debug('[call:incoming] received', { callId: d.callId, from: d.from, fromNick: d.fromNick });

    // КРИТИЧНО: Используем актуальное значение навигации напрямую, а не routeName (который обновляется асинхронно)
    // Fallback: если навигация не готова, разрешаем показать модалку (лучше показать, чем пропустить)
    let currentRoute: string | undefined = undefined;
    try {
      if (navRef.isReady()) {
        currentRoute = navRef.getCurrentRoute()?.name;
      } else {
        currentRoute = routeName;
      }
    } catch (e) {
      // Если навигация еще не готова - разрешаем показать модалку
      logger.debug('Navigation not ready, allowing modal show', { routeName });
      currentRoute = routeName;
    }
    
    // Защита от гонки: если для этого callId уже пришёл cancel/timeout, игнорируем входящий
    try {
      const id = String((d as any)?.callId || '');
      if (id) {
        const now = Date.now();
        // ленивое очищение старых записей (>10с)
        for (const [k, ts] of canceledCallsRef.current) if (now - ts > 10000) canceledCallsRef.current.delete(k);
        for (const [k, ts] of timedOutCallsRef.current) if (now - ts > 10000) timedOutCallsRef.current.delete(k);
        if (canceledCallsRef.current.has(id) || timedOutCallsRef.current.has(id)) {
          logger.debug('Ignoring incoming call - already canceled/timed out', { callId: id });
          return;
        }
      }
    } catch {}

    // На экране видеозвонка с активным звонком — входящий от того же собеседника игнорируем (дубликат после отмены на нативном экране у звонящего)
    const isOnVideoScreen = isVideoSessionRoute(currentRoute);
    const isInactiveVideoState = !!(global as any)?.__isInactiveStateRef?.current;
    const videoCallPartner = (global as any)?.__videoCallPartnerUserIdRef?.current;
    const videoCallActive = (global as any)?.__videoCallActiveRef?.current;
    if (isOnVideoScreen && !isInactiveVideoState && videoCallActive && videoCallPartner && String(d.from) === String(videoCallPartner)) {
      logger.debug('[call:incoming] Ignoring incoming from current partner (active VideoCall)', { callId: d.callId, from: d.from });
      return;
    }

    // Android: мы отказались от кастомных модалок — входящий всегда открываем нативным экраном
    // поверх любого экрана/вкладки/модалки в приложении (в т.ч. "неактивный" VideoCall после завершения).
    logger.debug('Incoming call — showing native incoming UI', {
      callId: d.callId,
      from: d.from,
      fromNick: d.fromNick,
      currentRoute,
      isOnVideoScreen,
      isInactiveVideoState,
    });
    // Метрика E2E: подтверждаем серверу фактический показ входящего UI.
    try { reportIncomingCallShown(d.callId); } catch {}
    incomingCallIdRef.current = d.callId;
    try { Keyboard.dismiss(); } catch {}

    // Единый UI Android:
    // - app active: открыть IncomingCallActivity
    // - app background: показать системный UI (unlocked→notification, locked/sleep→full-screen→IncomingCallActivity)
    if (Platform.OS === 'android') {
      const appState = AppState.currentState;
      if (appState && appState !== 'active') {
        showIncomingCallSystemUI(d.callId, d.from, d.fromNick ?? '');
      } else {
        launchIncomingCallActivityScreen(d.callId, d.from, d.fromNick ?? '');
      }
    } else if (isCallKeepAvailable()) {
      // iOS: системный UI через CallKeep (нативный, без RN-модалки)
      displayIncomingCall(d.callId, d.from, d.fromNick ?? '', true);
    }
    try { AsyncStorage.setItem('last_incoming_from', String(d.from || '')); } catch {}
  }, [routeName]);

  // Сохраняем обработчик в ref для использования в fallback и для пуша
  incomingCallHandlerRef.current = handleIncomingCall;
  (global as any).__setIncomingCallFromPush = (data: any) => {
    if (data?.callId && data?.from && incomingCallHandlerRef.current) {
      incomingCallHandlerRef.current({ callId: String(data.callId), from: String(data.from), fromNick: data?.fromNick ?? '' });
    }
  };

  // КРИТИЧНО: Общий прямой обработчик для перерегистрации при переподключении
  // Используем одну функцию для всех случаев чтобы избежать конфликтов
  const sharedDirectHandlerRef = React.useRef<((d: any) => void) | null>(null);

  React.useEffect(() => {
    // Закрытие по внешнему запросу (например, из ChatScreen)
    const offReq = onRequestCloseIncoming?.(() => { try { setIncomingCallScreenVisible(false); } catch {} stopIncomingCallAlert(); setIncoming(null); stopAnim(); });
    const offClose = onCloseIncoming?.(() => { try { setIncomingCallScreenVisible(false); } catch {} stopIncomingCallAlert(); setIncoming(null); stopAnim(); });
    
    // Регистрируем через обертку (основной способ)
    // УБРАНО: Дублирующий прямой слушатель - он регистрируется в отдельном useEffect для переподключения
    const off = onCallIncoming?.(handleIncomingCall);
    
    return () => { 
      off?.(); 
      offReq?.(); 
      offClose?.();
    };
  }, [handleIncomingCall, stopAnim]);

  // КРИТИЧНО: Перерегистрация обработчика при переподключении socket
  // Это гарантирует что обработчик всегда работает после пробуждения телефона
  React.useEffect(() => {
    // Создаем общий обработчик
    const directHandler = (d: any) => {
      // Используем обработчик из ref чтобы всегда был актуальный
      if (incomingCallHandlerRef.current) {
        incomingCallHandlerRef.current(d);
      }
    };
    sharedDirectHandlerRef.current = directHandler;

    const registerHandler = () => {
      try {
        // Убираем старый если есть (защита от дублирования)
        if (sharedDirectHandlerRef.current) {
          socket.off('call:incoming', sharedDirectHandlerRef.current);
        }
        socket.on('call:incoming', directHandler);
        logger.info('[call:incoming] socket handler registered');
      } catch (e) {
        logger.warn('Failed to register call:incoming handler:', e);
      }
    };

    const onConnect = () => {
      logger.debug('Socket connected/reconnected - ensuring call:incoming handler is registered');
      // Небольшая задержка чтобы socket точно был готов и reauth завершился
      setTimeout(() => {
        registerHandler();
      }, 200);
      // FCM call_accepted вывел приложение — запросить call:accepted (инициатор перейдёт на VideoCall). Fallback: ref от HomeScreen, если нативный pending не сработал.
      if (Platform.OS === 'android') {
        setTimeout(() => {
          const LiviAppModule = NativeModules.LiviAppModule;
          LiviAppModule?.getAndClearPendingCallAcceptedCallId?.()?.then?.((callId: string | null) => {
            if (callId) {
              logger.info('[App] Socket connected with pending call_accepted, requesting call:accepted', { callId });
              try { requestCallAccepted(callId); } catch {}
              return;
            }
            const refCallId = (global as any).__outgoingCallIdRef?.current;
            if (refCallId) {
              logger.info('[App] Socket connected with outgoing callId ref (FCM fallback), requesting call:accepted', { callId: refCallId });
              (global as any).__outgoingCallIdRef.current = null;
              try { requestCallAccepted(refCallId); } catch {}
            }
          });
        }, 400);
      }
      // После reauth перерегистрируем push-токен, чтобы backend получал его (важно для dev и после выхода из фона)
      setTimeout(() => {
        const uid = getCurrentUserId?.();
        if (uid) registerAndSendPushToken(uid, { reason: 'socket_reconnect' });
      }, 2500);
    };

    // Регистрируем сразу при монтировании
    registerHandler();
    
    socket.on('connect', onConnect);
    socket.on('reconnect', onConnect);
    
    return () => {
      socket.off('connect', onConnect);
      socket.off('reconnect', onConnect);
      if (sharedDirectHandlerRef.current) {
        try {
          socket.off('call:incoming', sharedDirectHandlerRef.current);
        } catch {}
      }
    };
  }, []);

  // При получении call:ended (второй участник завершил) — закрываем модалки, PiP по контексту: только reset на Home если были на полноэкранном видеозвонке.
  React.useEffect(() => {
    const onCallEnded = (data?: { callId?: string }) => {
      const g = global as any;
      console.log('[App] [call:ended] 📩 onCallEnded вызван', { callId: data?.callId, inSystem: g.__pipInSystemModeRef?.current, __callEndedFromPiPNoOpen: g.__callEndedFromPiPNoOpenRef?.current });
      // КРИТИЧНО: Сразу сбрасываем refs и уведомляем HomeScreen у обоих участников (кто нажал «Завершить», кто получил call:ended), чтобы кнопки видеозвонка и бейдж «Занят» восстановились.
      try {
        g.__videoCallPartnerUserIdRef = g.__videoCallPartnerUserIdRef || { current: null };
        g.__videoCallPartnerUserIdRef.current = null;
        g.__videoCallActiveRef = g.__videoCallActiveRef || { current: false };
        g.__videoCallActiveRef.current = false;
        g.__onVideoCallEndedRef?.current?.();
      } catch (_) {}
      // Очищаем сохранённый call:accepted, чтобы следующий звонок не подхватил старый payload (логи: «Found pending call:accepted» со старым callId).
      if (g.__pendingCallAcceptedRef) g.__pendingCallAcceptedRef.current = null;
      // Сразу закрываем системный PiP у собеседника (до любых очисток), иначе окно успевает показать лоадер.
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.requestExitSystemPiP?.(); } catch (_) {}
      }
      // Жёстко запрещаем системный PiP на короткое время после завершения звонка (анти-гонка).
      try {
        (global as any).__disableSystemPiPUntilRef = (global as any).__disableSystemPiPUntilRef || { current: 0 };
        (global as any).__disableSystemPiPUntilRef.current = Date.now() + 4000;
      } catch (_) {}
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
      }
      if (data?.callId) {
        addEndedCallIdFromSocket(data.callId);
        try { reportEndCallToCallKeep(data.callId); } catch {}
      }
      stopIncomingCallRingtoneAndVibration();
      stopIncomingCallAlert();
      setIncoming(null);
      stopAnim();
      try { emitCloseOutgoingCall(); } catch {}
      try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
      clearCallRelatedNotificationsAndSyncBadge().catch(() => {});

      const inSystem = g.__pipInSystemModeRef?.current === true;
      const pipVisible = g.__pipVisibleRef?.current === true;
      const hidePiP = g.__pipHidePiPRef?.current;
      const noOpenFlag = g.__callEndedFromPiPNoOpenRef?.current === true;

      if (typeof hidePiP === 'function') hidePiP();
      // Кто в системном PiP при call:ended — только закрываем PiP, приложение не открываем.
      if (inSystem) {
        console.log('[App] [call:ended] inSystem=true → ставим __callEndedFromPiPNoOpenRef, return (НЕ вызываем goHome)');
        try {
          g.__callEndedFromPiPNoOpenRef = g.__callEndedFromPiPNoOpenRef || { current: false };
          g.__callEndedFromPiPNoOpenRef.current = true;
          setTimeout(() => {
            try { (global as any).__callEndedFromPiPNoOpenRef.current = false; } catch (_) {}
          }, 6000);
        } catch (_) {}
        return;
      }
      // Звонок завершили из PiP (флаг выставлен в endCallImpl): call:ended мог прийти после закрытия PiP (inSystem уже false). Не открываем приложение.
      if (noOpenFlag) {
        console.log('[App] [call:ended] __callEndedFromPiPNoOpenRef=true → return (НЕ вызываем goHome, приложение не открываем)');
        return;
      }

      // Закрываем экран видеозвонка (goBack — пользователь остаётся на том же экране, что и до звонка). Не вызываем, если VideoCall уже закрыл экран.
      const homeResetByVideoCall = g.__homeResetByVideoCallRef?.current === true;
      if (homeResetByVideoCall) {
        console.log('[App] [call:ended] навигацию не делаем — экран звонка уже закрыт из VideoCall');
        try { g.__homeResetByVideoCallRef.current = false; } catch (_) {}
        return;
      }
      const closeVideoCallScreen = () => {
        if (!navRef.isReady()) return;
        const route = navRef.getCurrentRoute();
        const routeName = String((route as any)?.name ?? '');
        if (routeName === 'Home') return;
        // Только если сейчас на VideoCall — закрываем экран (goBack или reset). Иначе пользователь уже на другом экране — не трогаем.
        if (routeName === 'VideoCall') {
          const state = navRef.getState();
          const routes = state?.routes ?? [];
          if (routes.length > 1) {
            navRef.dispatch(CommonActions.goBack());
            try { emitCallEndedOnHome(); } catch (_) {}
          } else {
            navRef.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any, params: { callEnded: true } }] }));
          }
          return;
        }
      };
      closeVideoCallScreen();
    };
    socket.on('call:ended', onCallEnded);
    return () => { socket.off('call:ended', onCallEnded); };
  }, [stopAnim]);

  // Fallback: когда сокет переподключается (устройство в PiP могло не получить call:ended). Если мы в системном PiP и комната уже отключена — закрываем PiP и синхронизируем состояние.
  React.useEffect(() => {
    if (Platform.OS !== 'android') return () => {};
    const onReconnect = () => {
      const g = global as any;
      if (g.__pipInSystemModeRef?.current !== true) return;
      const session = g.__webrtcSessionRef?.current;
      const roomDisconnected = session?.room?.state === 'disconnected';
      const sessionEnded = typeof session?.ended === 'boolean' && session.ended;
      if (roomDisconnected || sessionEnded || !session) {
        try { NativeModules.LiviAppModule?.requestExitSystemPiP?.(); } catch (_) {}
        try {
          const hidePiP = g.__pipHidePiPRef?.current;
          if (typeof hidePiP === 'function') hidePiP();
        } catch (_) {}
      }
    };
    socket.on('connect', onReconnect);
    return () => { socket.off('connect', onReconnect); };
  }, []);

  // Тап по уведомлению «звонок завершён» — по контексту: только reset на Home если были на полноэкранном видеозвонке
  React.useEffect(() => {
    (global as any).__onCallEndedFromPush = () => {
      try {
        (global as any).__disableSystemPiPUntilRef = (global as any).__disableSystemPiPUntilRef || { current: 0 };
        (global as any).__disableSystemPiPUntilRef.current = Date.now() + 4000;
      } catch (_) {}
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
      }
      const g = global as any;
      const inSystem = g.__pipInSystemModeRef?.current === true;
      const pipVisible = g.__pipVisibleRef?.current === true;
      const hidePiP = g.__pipHidePiPRef?.current;
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.requestExitSystemPiP?.(); } catch (_) {}
      }
      if (inSystem) {
        if (typeof hidePiP === 'function') hidePiP();
      } else if (pipVisible) {
        if (typeof hidePiP === 'function') hidePiP();
      } else {
        if (typeof hidePiP === 'function') hidePiP();
        if (navRef.isReady()) {
          const route = navRef.getCurrentRoute();
          if (route?.name === 'Home') {
            // уже на Home
          } else if (route?.name === 'VideoCall') {
            // Открытие по пушу «звонок завершён»: сбрасываем на Home только если это не тот, кто завершил из PiP (иначе он оказывается на странице приветствия).
            const endedFromPiP = (global as any).__lastEndCallSourceRef?.current === 'pip_close';
            if (!endedFromPiP) {
              navRef.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any }] }));
            }
          } else {
            const state = navRef.getState();
            const routes = state?.routes ?? [];
            const idx = state?.index ?? 0;
            if (idx > 0 && routes[idx - 1]?.name === 'Home') {
              navRef.dispatch(CommonActions.goBack());
            } else {
              navRef.dispatch(
                CommonActions.reset({
                  index: 0,
                  routes: [{ name: 'Home' as any }],
                })
              );
            }
          }
        }
      }
      clearCallRelatedNotificationsAndSyncBadge().catch(() => {});
    };
    return () => { delete (global as any).__onCallEndedFromPush; };
  }, []);

  // При старте приложения (в т.ч. по FCM call_accepted) — запросить call:accepted, если нативный модуль сохранил callId. Несколько попыток: после холодного старта или экрана dev client App может смонтироваться с задержкой.
  React.useEffect(() => {
    if (Platform.OS !== 'android') return;
    const delays = [100, 500, 1500];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const tryPending = () => {
      const LiviAppModule = NativeModules.LiviAppModule;
      LiviAppModule?.getAndClearPendingCallAcceptedCallId?.()?.then?.((callId: string | null) => {
        if (callId) {
          logger.info('[App] Launch with pending call_accepted, requesting call:accepted', { callId });
          try { requestCallAccepted(callId); } catch {}
        }
      });
    };
    delays.forEach((ms) => timers.push(setTimeout(tryPending, ms)));
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);


  // КРИТИЧНО: Перерегистрация обработчика при возврате из спящего режима (AppState change)
  React.useEffect(() => {
    const { AppState } = require('react-native');
    let appStateRef = AppState.currentState;

    const handleAppStateChange = (nextAppState: string) => {
      if (appStateRef.match(/inactive|background/) && nextAppState === 'active') {
        // Если пользователь нажал X на нативном экране исходящего — событие могло не дойти до JS; при возврате в приложение очищаем состояние
        const canceledByNative = (global as any).__outgoingCanceledByNativeRef?.current === true;
        if (canceledByNative) {
          (global as any).__outgoingCanceledByNativeRef.current = false;
          try { emitCloseOutgoingCall(); } catch {}
        }
        if (Platform.OS === 'android') {
          const LiviAppModule = NativeModules.LiviAppModule;
          LiviAppModule?.getAndClearOutgoingCanceledByUserFlag?.()?.then?.((flag: boolean) => {
            if (flag) try { emitCloseOutgoingCall(); } catch {}
          });
          // FCM call_accepted вывел приложение — запросить call:accepted у сервера → переход на VideoCall
          LiviAppModule?.getAndClearPendingCallAcceptedCallId?.()?.then?.((callId: string | null) => {
            if (callId) {
              logger.info('[App] Pending call_accepted from FCM, requesting call:accepted', { callId });
              try { requestCallAccepted(callId); } catch {}
            }
          });
          // Пропущенные, показанные из нативного кода (FCM call_ended) — обновить счётчик и бейдж (без дубля, если уже учли по сокету)
          LiviAppModule?.getAndClearPendingMissedCalls?.()?.then?.((arr: string[]) => {
            if (arr?.length) {
              (async () => {
                try {
                  const key = 'missed_calls_by_user_v1';
                  const badgeCleared = await AsyncStorage.getItem('missed_calls_badge_cleared_v1');
                  const alreadySeen = badgeCleared === 'true';
                  const raw = await AsyncStorage.getItem(key);
                  const map = raw ? JSON.parse(raw) : {};
                  const MISSED_APPLY_SKIP_MS = 15000;
                  const countByUid: Record<string, number> = {};
                  for (const u of arr) {
                    if (!u) continue;
                    countByUid[u] = (countByUid[u] || 0) + 1;
                  }
                  for (const uid of Object.keys(countByUid)) {
                    const lastInc = lastMissedIncrementTimeByUserRef.current[uid];
                    if (lastInc && Date.now() - lastInc < MISSED_APPLY_SKIP_MS) continue;
                    if (wasAppliedFromReauth(uid)) continue;
                    const add = countByUid[uid] || 1;
                    map[uid] = (map[uid] || 0) + add;
                    try { recordAppliedFromPending(uid); } catch {}
                    try { emitMissedIncrement(uid); } catch {}
                  }
                  await AsyncStorage.setItem(key, JSON.stringify(map));
                  if (!alreadySeen) {
                    await clearMissedBadgeCleared();
                    await syncAppBadgeFromMissedCount();
                  }
                  if (Platform.OS === 'android' && NativeModules.LiviAppModule) {
                    try {
                      for (const uid of Object.keys(map || {})) {
                        const c = map[uid];
                        if (uid && typeof c === 'number' && c > 0) {
                          if (alreadySeen) NativeModules.LiviAppModule.setMissedCountForUserOnly?.(uid, c);
                          else NativeModules.LiviAppModule.syncMissedCountForUser?.(uid, c);
                        }
                      }
                    } catch (_) {}
                  }
                } catch (e) {
                  logger.warn('[App] getAndClearPendingMissedCalls apply failed', e);
                }
              })();
            }
          });
        }
        // Если приложение открыли (или вернулись в него), а текущий экран — неактивный видеозвонок — сбрасываем на Home только если это не тот, кто завершил звонок из PiP (иначе он оказывается на странице приветствия при открытии по пушу, когда у собеседника закрывается PiP).
        try {
          if (navRef.isReady()) {
            const route = navRef.getCurrentRoute();
            const isInactiveCall = (global as any).__isInactiveStateRef?.current === true;
            const sessionEnded = (global as any).__webrtcSessionRef?.current?.ended === true;
            const endedFromPiP = (global as any).__lastEndCallSourceRef?.current === 'pip_close';
            if ((route?.name === 'VideoCall') && (isInactiveCall || sessionEnded) && !endedFromPiP) {
              navRef.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any }] }));
            }
          }
        } catch (_) {}

        // Приложение вернулось из спящего режима - перерегистрируем обработчик
        logger.debug('App returned from sleep - re-registering call:incoming handler');
        setTimeout(() => {
          try {
            if (sharedDirectHandlerRef.current) {
              socket.off('call:incoming', sharedDirectHandlerRef.current);
              socket.on('call:incoming', sharedDirectHandlerRef.current);
              logger.debug('Re-registered call:incoming handler after app resume');
            }
          } catch (e) {
            logger.warn('Failed to re-register call:incoming handler after app resume:', e);
          }
        }, 300); // Задержка для завершения reauth и присоединения к комнате
      }
      appStateRef = nextAppState;
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    
    return () => {
      subscription.remove();
    };
  }, []);

  // Android nav bar: управление перенесено на конкретные экраны (Home/Chat/Video)

  // УБРАНО: Дублирующий обработчик onCallTimeout - он уже зарегистрирован в общем useEffect ниже
  // вместе с onCallDeclined, onCallCanceled, onCallAccepted

  // УБРАНО: Резервные сырые слушатели - они дублируют обработчики через обертки
  // Все события обрабатываются через onCallDeclined, onCallTimeout, onCallCanceled, onCallAccepted
  // которые уже зарегистрированы в useEffect выше

  // Закрываем входящую модалку, если звонящий отменил вызов
  React.useEffect(() => {
    const offDecl = onCallDeclined?.((d) => {
      const id = d?.callId ? String(d.callId) : '';
      logger.info('[decline/инициатор] App onCallDeclined вызван', { callId: id, alreadyHandled: id ? isOutgoingDeclineHandled(id) : false });
      if (id && isOutgoingDeclineHandled(id)) {
        logger.info('[decline/инициатор] App onCallDeclined — уже обработан, выходим');
        return;
      }
      if (id) markOutgoingDeclineHandled(id);
      incomingCallIdRef.current = null;
      if (d?.callId) try { reportEndCallToCallKeep(d.callId); } catch {}
      stopIncomingCallRingtoneAndVibration();
      stopIncomingCallAlert();
      setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
      logger.info('[decline/инициатор] App: закрываем нативное окно и сбрасываем visible');
      try { closeOutgoingCallActivity(); } catch {}
      try { setOutgoingCallScreenVisible(false); } catch {}
      // Сбрасываем refs активного звонка, чтобы кнопки видеозвонка у инициатора снова стали активными
      try {
        (global as any).__videoCallPartnerUserIdRef = { current: null };
        (global as any).__videoCallActiveRef = { current: false };
        (global as any).__onVideoCallEndedRef?.current?.();
      } catch (_) {}
      // Не эмитим emitCloseOutgoingCall — иначе onCloseOutgoingCall вызовет второй setCalling и второе мерцание
      // call:declined = тот, кому звонили, отклонил — пропущенным не считаем, счётчик не увеличиваем
    });
    const offCancel = onCallCanceled?.(async (d) => {
      const callerId = String((d as any)?.from || '');
      const myUserId = getCurrentUserId?.() ?? '';
      const isCallee = callerId && myUserId && callerId !== myUserId;
      incomingCallIdRef.current = null;
      const callIdStr = (d as any)?.callId ? String((d as any).callId) : '';
      if (callIdStr) {
        try { reportEndCallToCallKeep(callIdStr); } catch {}
        try { notifyCallCanceled(callIdStr); } catch {}
      }
      stopIncomingCallRingtoneAndVibration();
      try { setIncomingCallScreenVisible(false); } catch {}
      stopIncomingCallAlert();
      // Сбрасываем refs активного звонка при отмене вызова
      try {
        (global as any).__videoCallPartnerUserIdRef = { current: null };
        (global as any).__videoCallActiveRef = { current: false };
        (global as any).__onVideoCallEndedRef?.current?.();
      } catch (_) {}
      // КРИТИЧНО: Обновляем canceledCallsRef для защиты от гонки событий
      try {
        const id = String((d as any)?.callId || '');
        if (id) canceledCallsRef.current.set(id, Date.now());
      } catch {}
      const g = global as any;
      const homeResetByVideoCall = g.__homeResetByVideoCallRef?.current === true;
      const doneRef = g.__callCancelNavDoneRef;
      const now = Date.now();
      const CALL_CANCEL_NAV_DEBOUNCE_MS = 4000;
      let alreadyDidNav = doneRef && callerId && doneRef.from === callerId && (now - (doneRef.at || 0)) < CALL_CANCEL_NAV_DEBOUNCE_MS;
      if (!alreadyDidNav && callerId && doneRef) {
        try { doneRef.from = callerId; doneRef.at = now; } catch (_) {}
        alreadyDidNav = false;
      }
      const routeName = String(navRef.getCurrentRoute()?.name ?? '');
      const willDispatch = !homeResetByVideoCall && !alreadyDidNav && navRef.isReady();
      // Callee уже на Home: страница приветствия не должна ре-рендериться — не вызываем setIncoming и эмиты с подписчиками-setState
      const calleeAlreadyOnHome = isCallee && routeName === 'Home';
      const runCloseUI = () => {
        setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); emitCloseOutgoingCall(); } catch {}
      };

      if (calleeAlreadyOnHome) {
        // Ноль ре-рендеров в момент закрытия нативного экрана: ничего не делаем, что дергает HomeScreen (setIncoming, эмиты с setState, бейдж, пропущенный — всё откладываем)
        // Пропуск setAppIsActive при AppState 'active': при возврате с нативного экрана HomeScreen не должен вызывать setAppIsActive → ре-рендер
        try {
          const skipRef = (g.__skipAppStateActiveSetAppIsActiveRef = g.__skipAppStateActiveSetAppIsActiveRef || { current: false });
          skipRef.current = true;
        } catch (_) {}
        try {
          const pipVisible = !!(pip as any)?.visible || !!(g?.__pipVisibleRef?.current);
          if (!isVideoSessionRoute(routeName) && !pipVisible && Platform.OS === 'android') {
            try { (InCallManager as any).setKeepScreenOn?.(false); } catch (_) {}
            InCallManager.stop();
          }
        } catch (_) {}
        // Бейдж (showNotice) и пропущенный (emitMissedIncrement → setMissedByUser) вызывают ре-рендер HomeScreen — откладываем на 400ms, чтобы первый кадр после закрытия нативного экрана прошёл без дёргания
        const CALLEE_ON_HOME_DEFER_MS = 400;
        setTimeout(async () => {
          try {
            const skipRef = (g as any).__skipAppStateActiveSetAppIsActiveRef;
            if (skipRef) skipRef.current = false;
          } catch (_) {}
          try { emitCallCancelledOnHome(); } catch (_) {}
          try {
            if (callerId) {
              lastMissedIncrementTimeByUserRef.current[callerId] = Date.now();
              const key = 'missed_calls_by_user_v1';
              const raw = await AsyncStorage.getItem(key);
              const map = raw ? JSON.parse(raw) : {};
              map[callerId] = (map[callerId] || 0) + 1;
              await AsyncStorage.setItem(key, JSON.stringify(map));
              try { emitMissedIncrement(callerId); } catch {}
              await clearMissedBadgeCleared();
              await syncAppBadgeFromMissedCount();
              try { await AsyncStorage.removeItem('last_incoming_from'); } catch {}
            }
          } catch (_) {}
        }, CALLEE_ON_HOME_DEFER_MS);
      } else {
        runCloseUI();
        if (homeResetByVideoCall) {
          try { g.__homeResetByVideoCallRef.current = false; } catch (_) {}
        } else if (!alreadyDidNav && navRef.isReady()) {
          if (routeName !== 'Home') {
            navRef.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any, params: { callCancelled: true } }] }));
          } else {
            navRef.dispatch(CommonActions.setParams({ callCancelled: true }));
          }
        }
      }
      // Инкремент пропущенного только у получателя (callee); для callee на Home делаем в setTimeout выше
      try {
        if (callerId && isCallee && !calleeAlreadyOnHome) {
          lastMissedIncrementTimeByUserRef.current[callerId] = Date.now();
          const key = 'missed_calls_by_user_v1';
          const raw = await AsyncStorage.getItem(key);
          const map = raw ? JSON.parse(raw) : {};
          map[callerId] = (map[callerId] || 0) + 1;
          await AsyncStorage.setItem(key, JSON.stringify(map));
          try { emitMissedIncrement(callerId); } catch {}
          await clearMissedBadgeCleared();
          await syncAppBadgeFromMissedCount();
          try { await AsyncStorage.removeItem('last_incoming_from'); } catch {}
        }
      } catch {}
    });
    // Если пришло accepted (ответили), синхронно открываем VideoCall у обоих
    const onAccepted = onCallAccepted?.((data) => {
      logger.info('[App] 📥 call:accepted received in App.tsx', {
        callId: data?.callId,
        from: data?.from,
        currentRoute: navRef.getCurrentRoute()?.name,
      });
      const callId = data?.callId ? String(data.callId) : '';
      // Не переходить на VideoCall, если по сокету уже пришло call:ended (звонок уже завершён) — избегаем мелькания и лишних сессий
      if (callId && endedCallIdsFromSocket.has(callId)) {
        logger.info('[App] ⏭️ call:accepted ignored (call already ended)', { callId });
        try { setOutgoingCallScreenVisible(false); } catch {}
        try { setIncomingCallScreenVisible(false); } catch {}
        try { emitCloseOutgoingCall(); } catch {}
        try { closeOutgoingCallActivity(); } catch {}
        if ((global as any).__pendingCallAcceptedRef) (global as any).__pendingCallAcceptedRef.current = null;
        stopIncomingCallAlert();
        setIncoming(null);
        stopAnim();
        try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
        clearCallRelatedNotificationsAndSyncBadge().catch(() => {});
        return;
      }
      // КРИТИЧНО: Сохраняем событие call:accepted в глобальный ref на случай, если VideoCallSession еще не создан
      // Это решает проблему, когда call:accepted приходит до того, как VideoCallSession создан
      if (!(global as any).__pendingCallAcceptedRef) {
        (global as any).__pendingCallAcceptedRef = { current: null };
      }
      (global as any).__pendingCallAcceptedRef.current = data;
      logger.info('[App] 💾 Saved call:accepted event to global ref', {
        callId: data?.callId,
        hasLivekitToken: !!(data as any)?.livekitToken,
        hasLivekitRoomName: !!(data as any)?.livekitRoomName,
      });

      const fromUserId = (data as any)?.fromUserId ?? (data as any)?.from;
      const myUserId = getCurrentUserId();
      const isCaller = myUserId && fromUserId && myUserId !== fromUserId;
      // Инициатор: закрывать нативный экран исходящего только если принят именно текущий звонок (не устаревший call:accepted при переподключении сокета)
      if (isCaller && callId) {
        const currentOutgoing = (global as any).__outgoingCallIdRef?.current;
        if (currentOutgoing != null && String(currentOutgoing) !== String(callId)) {
          logger.info('[App] ⏭️ call:accepted ignored (callId not current outgoing)', { callId, currentOutgoing });
          return;
        }
      }
      
      try { setIncomingCallScreenVisible(false); } catch {}
      stopIncomingCallAlert();
      setIncoming(null);
      stopAnim();
      try {
        const currentRoute = navRef.getCurrentRoute();
        if (navRef.isReady() && currentRoute?.name !== 'VideoCall') {
          // Caller: we initiated, the other accepted → directInitiator: true, peerUserId = callee (who accepted).
          // Callee: we accepted → we're already on VideoCall (navigated on Accept tap); skip or rare edge case.
          const params = isCaller
            ? { directCall: true, directInitiator: true, callId: (data as any)?.callId, peerUserId: fromUserId, roomId: (data as any)?.livekitRoomName ?? (data as any)?.roomId }
            : { directCall: true, directInitiator: false, callId: (data as any)?.callId, isIncoming: true, peerUserId: fromUserId ?? undefined };
          logger.info('[App] 🚀 Navigating to VideoCall screen', {
            callId: data?.callId,
            peerUserId: fromUserId,
            isCaller,
          });
          const doNavigate = () => {
            try {
              if (navRef.isReady() && navRef.getCurrentRoute()?.name !== 'VideoCall') {
                setActiveVideoCall(true);
                // Закрываем модалки «Поддержать LiVi» и «Пригласи друга», чтобы экран видеозвонка был поверх
                try { emitCloseHomeModals(); } catch {}
                // Push VideoCall поверх текущего экрана (не reset), чтобы после завершения звонка goBack() вернул на тот же экран (Chat, Friends и т.д.).
                navRef.navigate('VideoCall' as any, params);
              }
            } catch (err) {
              logger.error('[App] ❌ Error navigating to VideoCall', { error: err, callId: data?.callId });
            }
          };
          // Сначала навигация на VideoCall, потом закрытие нативного экрана — при закрытии исходящего пользователь сразу видит экран видеозвонка
          doNavigate();
          try { setOutgoingCallScreenVisible(false); } catch {}
          try { emitCloseOutgoingCall(); } catch {}
          if (isCaller) {
            // Инициатор: один вызов — bringMainActivityToFront закрывает OutgoingCallActivity и выводит MainActivity (избегаем двойного закрытия)
            logger.info('[App] 📱 bringMainActivityToFront (socket-only path, caller)');
            try { bringMainActivityToFront(); } catch {}
          } else {
            try { closeOutgoingCallActivity(); } catch {}
          }
        } else {
          logger.info('[App] ⏭️ Already on VideoCall screen, skipping navigation', { callId: data?.callId });
        }
      } catch (e) {
        logger.error('[App] ❌ Error navigating to VideoCall', { error: e, callId: data?.callId });
        try { setOutgoingCallScreenVisible(false); } catch {}
        try { setIncomingCallScreenVisible(false); } catch {}
        try { emitCloseOutgoingCall(); } catch {}
        try { closeOutgoingCallActivity(); } catch {}
        try { bringMainActivityToFront(); } catch {}
      }
    });
    // Обработчик таймаута
    const offTimeout = onCallTimeout?.(async (d) => {
      logger.debug('Call timeout received', { callId: d?.callId });
      incomingCallIdRef.current = null;
      if (d?.callId) try { reportEndCallToCallKeep(d.callId); } catch {}
      try { setIncomingCallScreenVisible(false); } catch {}
      stopIncomingCallAlert();
      // Сбрасываем refs активного звонка, чтобы кнопки видеозвонка у инициатора снова стали активными
      try {
        (global as any).__videoCallPartnerUserIdRef = { current: null };
        (global as any).__videoCallActiveRef = { current: false };
        (global as any).__onVideoCallEndedRef?.current?.();
      } catch (_) {}
      // Мгновенно закрываем UI
      setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); emitCloseOutgoingCall(); } catch {}
      // Переход на Home с бейджем «Вызов отменен»
      if (navRef.isReady()) {
        const routeName = String(navRef.getCurrentRoute()?.name ?? '');
        if (routeName !== 'Home') {
          navRef.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any, params: { callCancelled: true } }] }));
        } else {
          navRef.dispatch(CommonActions.setParams({ callCancelled: true }));
        }
      }
      try {
        const id = String((d as any)?.callId || '');
        if (id) {
          timedOutCallsRef.current.set(id, Date.now());
        }
      } catch {}
      // Инкремент пропущенного только у получателя (callee), не у инициатора
      try {
        const uid = await AsyncStorage.getItem('last_incoming_from');
        const callerId = String((d as any)?.from || '');
        if (uid && callerId && uid === callerId) {
          lastMissedIncrementTimeByUserRef.current[uid] = Date.now();
          const key = 'missed_calls_by_user_v1';
          const raw = await AsyncStorage.getItem(key);
          const map = raw ? JSON.parse(raw) : {};
          map[uid] = (map[uid] || 0) + 1;
          await AsyncStorage.setItem(key, JSON.stringify(map));
          try { emitMissedIncrement(uid); } catch {}
          await clearMissedBadgeCleared();
          await syncAppBadgeFromMissedCount();
          try { await AsyncStorage.removeItem('last_incoming_from'); } catch {}
          // Дедуп: убрать этого пользователя из нативного pending, чтобы при getAndClearPendingMissedCalls не инкрементировать повторно (FCM call_ended тоже добавляет в pending)
          try {
            if (Platform.OS === 'android') NativeModules.LiviAppModule?.removePendingMissedCall?.(uid);
          } catch (_) {}
        }
      } catch {}
    });
    
    return () => { offDecl?.(); offCancel?.(); onAccepted?.(); offTimeout?.(); };
  }, [stopAnim]);

  // Fallback: если по какой-то причине не пришёл call:timeout, авто-сворачиваем через 20с и фиксируем пропущенный
  React.useEffect(() => {
    if (!incoming) return;
    const t = setTimeout(async () => {
      try {
        // если всё ещё висит входящий — считаем пропущенным и сворачиваем
        const cur = incoming; // замкнём
        if (cur) {
          try {
            // если уже пришёл реальный timeout/cancel для этого звонка — не инкрементим повторно
            const cid = String((cur as any)?.callId || '');
            if (cid && (timedOutCallsRef.current.has(cid) || canceledCallsRef.current.has(cid))) {
              try { setIncomingCallScreenVisible(false); } catch {}
              stopIncomingCallAlert(); setIncoming(null); stopAnim();
              return;
            }
            const key = 'missed_calls_by_user_v1';
            const raw = await AsyncStorage.getItem(key);
            const map = raw ? JSON.parse(raw) : {};
            const uid = String(cur.from || '');
            if (uid) {
              lastMissedIncrementTimeByUserRef.current[uid] = Date.now();
              map[uid] = (map[uid] || 0) + 1;
              await AsyncStorage.setItem(key, JSON.stringify(map));
              try { emitMissedIncrement(uid); } catch {}
              await clearMissedBadgeCleared();
              await syncAppBadgeFromMissedCount();
              try { await AsyncStorage.removeItem('last_incoming_from'); } catch {}
            }
            } catch {}
          try { setIncomingCallScreenVisible(false); } catch {}
          stopIncomingCallAlert(); setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
        }
      } catch {}
    }, OUTGOING_CALL_TIMEOUT_MS);
    return () => { try { clearTimeout(t); } catch {} };
  }, [incoming, stopAnim]);

  // Debug logging for incoming call modal
  React.useEffect(() => {
    if (incoming) {
      logger.debug('Incoming call modal state changed', { incoming: !!incoming, callId: incoming?.callId, from: incoming?.from });
    }
  }, [incoming]);

  // Как в WhatsApp/Telegram: в системном PiP остаёмся на экране VideoCall (компактный вид), навигатор не размонтируем — возврат из PiP без перехода.
  return (
    <>
      <StatusBar 
        barStyle={isDark ? 'light-content' : 'dark-content'} 
        translucent={Platform.OS === 'android'}
        backgroundColor={Platform.OS === 'android' ? 'transparent' : undefined}
      />
      <PaperProvider theme={theme}>
        <>
        <NavigationContainer
          ref={navRef}
          theme={{
            ...DefaultTheme,
            colors: {
              ...DefaultTheme.colors,
              background: (theme.colors.background as string) || '#151F33',
            },
          }}
          onReady={() => {
            try {
              if (navRef.isReady()) {
                const currentRoute = navRef.getCurrentRoute()?.name;
                if (currentRoute && currentRoute !== lastLoggedRouteRef.current) {
                  console.log('[App] Navigation ready, current route:', currentRoute);
                  lastLoggedRouteRef.current = currentRoute;
                }
                // После отмены входящего на Home не дергаем setRouteName — иначе ре-рендер App и двойная отрисовка Home
                if ((global as any).__skipAppStateActiveSetAppIsActiveRef?.current !== true) {
                  setRouteName(currentRoute);
                }
              }
            } catch (e) {
              console.warn('[App] Error in onReady callback:', e);
            }
          }}
          onStateChange={() => {
            try {
              if (navRef.isReady()) {
                const currentRoute = navRef.getCurrentRoute()?.name;
                if (currentRoute && currentRoute !== lastLoggedRouteRef.current) {
                  console.log('[App] Navigation state changed, current route:', currentRoute);
                  lastLoggedRouteRef.current = currentRoute;
                }
                // После отмены входящего на Home не дергаем setRouteName — иначе ре-рендер App и двойная отрисовка Home
                if ((global as any).__skipAppStateActiveSetAppIsActiveRef?.current !== true) {
                  setRouteName(currentRoute);
                }
              }
            } catch (e) {
              console.warn('[App] Error in onStateChange callback:', e);
            }
          }}
        >
          <Stack.Navigator screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: 'transparent' },
            animation: 'fade',
            animationDuration: 450,
            // Не размонтировать неактивные экраны — при закрытии VideoCall Home остаётся смонтированным, state (аватар и т.д.) сохраняется, нет мерцания буквы.
            // Типы native-stack не включают detachInactiveScreens, но опция поддерживается в рантайме.
            detachInactiveScreens: false,
          } as React.ComponentProps<typeof Stack.Navigator>['screenOptions']}>
              <Stack.Screen name="Home" component={HomeScreen} />
              <Stack.Screen
                name="RandomChat"
                component={RandomChatScreen}
                options={{
                  presentation: 'card',
                  gestureEnabled: true,
                  animation: 'fade',
                  // Быстрее переход с welcome-экрана, но с мягким fade без резкости.
                  animationDuration: 240,
                  contentStyle: { backgroundColor: 'transparent' },
                }}
              />
              <Stack.Screen
                name="VideoCall"
                component={VideoCallScreen}
                options={{
                  presentation: 'card',
                  gestureEnabled: true,
                  animation: 'fade',
                  animationDuration: 10,
                  contentStyle: { backgroundColor: 'transparent' },
                }}
              />
              <Stack.Screen
                name="Chat"
                component={ChatScreen}
                options={{
                  animation: 'fade',
                  animationDuration: 450,
                  gestureEnabled: true,
                }}
              />
            </Stack.Navigator>
          </NavigationContainer>

          {/* До обработки initial URL (answer-call и т.д.) не показываем контент — иначе у принимающего мелькает Home перед VideoCall */}
          {!initialUrlProcessed && (
            <View
              style={[StyleSheet.absoluteFill, { backgroundColor: (theme.colors?.background as string) || '#151F33' }]}
              pointerEvents="none"
            />
          )}

          {/* In-app PiP не показывается на экране видеозвонка (VideoCall/RandomChat) — только на Home и др. */}
          <PiPOverlay currentRouteName={routeName} />

          {/* Android: запрос разрешения «Отображение поверх других окон» при первом заходе (без Alert) */}
          {Platform.OS === 'android' && (
            <Modal
              visible={overlayPermissionModalVisible}
              transparent
              animationType="fade"
              onRequestClose={() => setOverlayPermissionModalVisible(false)}
            >
              <TouchableOpacity
                activeOpacity={1}
                style={overlayPermissionModalStyles.overlayPermissionBackdrop}
                onPress={() => setOverlayPermissionModalVisible(false)}
              >
                <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation()} style={overlayPermissionModalStyles.overlayPermissionCard}>
                  <View style={overlayPermissionModalStyles.overlayPermissionHeader}>
                    <View style={overlayPermissionModalStyles.overlayPermissionIconWrap}>
                      <MaterialIcons name="lock-open" size={20} color={isDark ? '#4DD0E1' : theme.colors.primary} />
                    </View>
                    <View style={overlayPermissionModalStyles.overlayPermissionTitleWrap}>
                      <Text style={overlayPermissionModalStyles.overlayPermissionTitle}>Вызовы на заблокированном экране</Text>
                    </View>
                  </View>
                  <Text style={overlayPermissionModalStyles.overlayPermissionText}>
                    Включите для LiVi показ поверх других приложений.
                  </Text>
                  <View style={overlayPermissionModalStyles.overlayPermissionNote}>
                    <Text style={overlayPermissionModalStyles.overlayPermissionNoteText}>
                      Это нужно, чтобы принимать входящие вызовы, когда экран телефона заблокирован.
                    </Text>
                  </View>
                  <View style={overlayPermissionModalStyles.overlayPermissionButtons}>
                    <TouchableOpacity style={overlayPermissionModalStyles.overlayPermissionButtonSecondary} onPress={() => setOverlayPermissionModalVisible(false)}>
                      <Text style={overlayPermissionModalStyles.overlayPermissionButtonSecondaryText}>Не сейчас</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        overlayPermissionModalStyles.overlayPermissionButtonPrimary,
                        isDark
                          ? overlayPermissionModalStyles.overlayPermissionButtonPrimaryDarkOuter
                          : overlayPermissionModalStyles.overlayPermissionButtonPrimaryLightOuter,
                      ]}
                      onPress={() => {
                        openOverlayPermissionSettings();
                        setOverlayPermissionModalVisible(false);
                      }}
                    >
                      <View style={isDark ? overlayPermissionModalStyles.overlayPermissionButtonPrimaryDark : overlayPermissionModalStyles.overlayPermissionButtonPrimaryLightInner}>
                        <Text style={overlayPermissionModalStyles.overlayPermissionButtonPrimaryText}>Открыть настройки</Text>
                      </View>
                    </TouchableOpacity>
                  </View>
                </TouchableOpacity>
              </TouchableOpacity>
            </Modal>
          )}
          </>
      </PaperProvider>
    </>
  );
}

export default function App() {
  // Навигация в «вернуться к звонку»:
  const navigateToCall = (callId: string | null, roomId: string | null) => {
    console.log('[App] navigateToCall called with:', { callId, roomId });
    // возвращаем ровно на экран друга, НЕ на «Начать/Далее»
    if (navRef.isReady()) {
      navRef.navigate('VideoCall', {
        resume: true,
        callId: callId || undefined,
        roomId: roomId || undefined,
        fromPiP: true,
      });
    }
  };

  const endCallImpl = (callId: string | null, roomId: string | null) => {
    const g = global as any;
    const fromPiPButton = g.__endingFromPiPButtonRef?.current === true;
    if (fromPiPButton) {
      try { g.__endingFromPiPButtonRef.current = false; } catch (_) {}
    }
    const inSystem = g.__pipInSystemModeRef?.current === true;
    const pipVisible = g.__pipVisibleRef?.current === true;
    const endingFromSystemPiP = inSystem || fromPiPButton;
    console.log('[App] 🔥 endCallImpl вызван', { callId, roomId, inSystem, pipVisible, fromPiPButton, endingFromSystemPiP, __callEndedFromPiPNoOpen: g.__callEndedFromPiPNoOpenRef?.current });

    // Сразу выставляем флаги «завершили из PiP», чтобы handleCallEnded (вызовется из session.endCall) и onCallEnded (call:ended) не открывали приложение.
    // SystemPiPModeChanged(true) может прийти позже, поэтому inSystem часто false при нажатии X в PiP.
    if (endingFromSystemPiP) {
      try {
        g.__lastEndCallSourceRef = g.__lastEndCallSourceRef || { current: null };
        g.__lastEndCallSourceRef.current = 'pip_close';
        g.__callEndedFromPiPNoOpenRef = g.__callEndedFromPiPNoOpenRef || { current: false };
        g.__callEndedFromPiPNoOpenRef.current = true;
        setTimeout(() => {
          try { (global as any).__callEndedFromPiPNoOpenRef.current = false; } catch (_) {}
        }, 6000);
      } catch (_) {}
      // При завершении из системного PiP cleanupFunction не выполнит InCallManager.stop() (guard по isInactiveStateRef).
      // Останавливаем аудио сразу, чтобы звук и PiP закрылись одновременно.
      try {
        (InCallManager as any).setForceSpeakerphoneOn?.('auto');
        InCallManager.setSpeakerphoneOn(false);
        InCallManager.stop();
        (InCallManager as any).abandonAudioFocus?.();
      } catch (_) {}
    }

    try {
      g.__disableSystemPiPUntilRef = g.__disableSystemPiPUntilRef || { current: 0 };
      g.__disableSystemPiPUntilRef.current = Date.now() + 4000;
    } catch (_) {}
    if (Platform.OS === 'android') {
      try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
    }
    reportEndCallToCallKeep(callId);
    setCallKeepAvailable(true);
    clearCallRelatedNotificationsAndSyncBadge().catch(() => {});
    try { emitCloseOutgoingCall(); } catch {}
    try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}

    // КРИТИЧНО: Завершение видеозвонка из PiP (кнопка X) завершает звонок у обоих: отправка call:end на сервер,
    // иначе у собеседника звонок продолжается. Сначала завершаем звонок на сервере, потом локальный cleanup.
    const hasPiPIds = (callId && roomId) || pipVisible || inSystem;
    if (hasPiPIds && (callId || roomId)) {
      try {
        const session = g.__webrtcSessionRef?.current;
        if (session && typeof session.endCall === 'function') {
          console.log('[App] Завершение из PiP: вызываем session.endCall(callId, roomId)');
          session.endCall(callId || undefined, roomId || undefined);
        } else {
          console.log('[App] Завершение из PiP: отправляем call:end на сервер (fallback)');
          socket.emit('call:end', {
            callId: callId || undefined,
            roomId: roomId || undefined,
          });
        }
      } catch (e) {
        console.warn('[App] Error ending call from PiP:', e);
      }
    }

    try {
      const cleanupFn = g.__endCallCleanupRef?.current;
      if (cleanupFn && typeof cleanupFn === 'function') {
        if (!endingFromSystemPiP) {
          g.__lastEndCallSourceRef = g.__lastEndCallSourceRef || { current: null };
          g.__lastEndCallSourceRef.current = 'pip_close';
        }
        console.log('[App] Вызываем cleanupFunction из __endCallCleanupRef');
        cleanupFn();
      } else if (!hasPiPIds) {
        const session = g.__webrtcSessionRef?.current;
        if (session && typeof session.endCall === 'function') {
          console.log('[App] Вызываем session.endCall() напрямую (cleanupFunction не установлена)');
          session.endCall();
        } else {
          console.log('[App] Отправляем call:end напрямую на сервер (fallback)');
          socket.emit('call:end', {
            callId: callId || undefined,
            roomId: roomId || undefined,
          });
        }
      }
    } catch (e) {
      console.warn('[App] Error calling endCall cleanup:', e);
    }

    // КРИТИЧНО: Всегда сбрасываем refs и уведомляем HomeScreen при завершении из PiP (in-app или системный), чтобы кнопки видеозвонка и бейдж «Занят» восстановились у того, кто нажал «Завершить». (cleanupFn может быть null, если VideoCall уже размонтирован при системном PiP.)
    try {
      g.__videoCallPartnerUserIdRef = g.__videoCallPartnerUserIdRef || { current: null };
      g.__videoCallPartnerUserIdRef.current = null;
      g.__videoCallActiveRef = g.__videoCallActiveRef || { current: false };
      g.__videoCallActiveRef.current = false;
      g.__onVideoCallEndedRef?.current?.();
    } catch (_) {}

    // При завершении из системного PiP (X): только закрываем PiP, приложение не открываем.
    // endingFromSystemPiP = inSystem || fromPiPButton: fromPiPButton true, когда вызов из EndCallFromPiP (SystemPiPModeChanged(true) может прийти позже).
    const hidePiP = g.__pipHidePiPRef?.current;
    if (endingFromSystemPiP) {
      console.log('[App] [PiP] endCallImpl: endingFromSystemPiP=true (inSystem=', inSystem, ', fromPiPButton=', fromPiPButton, ') → hidePiP(), requestExitSystemPiP(), return (НЕ открываем приложение)');
      if (typeof hidePiP === 'function') hidePiP();
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.requestExitSystemPiP?.(); } catch (_) {}
      }
      return;
    }
    // In-app PiP (кнопка X): звонок уже завершён для обоих выше (session.endCall/call:end); только скрываем PiP, навигации нет.
    if (pipVisible) {
      if (typeof hidePiP === 'function') hidePiP();
      return;
    }
    if (typeof hidePiP === 'function') hidePiP();
    // Если пользователь на странице видеозвонка — не переходим на Home, остаёмся на ней.
    if (navRef.isReady()) {
      const route = navRef.getCurrentRoute();
      const routeName = route?.name ?? '';
      if (routeName !== 'VideoCall') {
        console.log('[App] [PiP] endCallImpl: навигация на Home (не в PiP: inSystem=false, pipVisible=false, текущий экран=', routeName, ')');
        navRef.dispatch(
          CommonActions.reset({
            index: 0,
            routes: [{ name: 'Home' as any }],
          })
        );
      }
    }
  };

  const endCallImplRef = React.useRef<(cid: string | null, rid: string | null) => void>(endCallImpl);
  endCallImplRef.current = endCallImpl;
  const pipReturnToCallJustPressedRef = React.useRef(false);
  React.useEffect(() => {
    (global as any).__endCallFromNativeRef = endCallImplRef;
    (global as any).__pipReturnToCallJustPressedRef = pipReturnToCallJustPressedRef;
    return () => {
      delete (global as any).__endCallFromNativeRef;
      delete (global as any).__pipReturnToCallJustPressedRef;
    };
  }, []);

  // Android: при 2–3 нажатиях «Назад» пользователь выходит из приложения на главный экран телефона.
  // Если на корне стека (Back закрыл бы приложение) и при этом либо видим in-app PiP, либо идёт активный звонок (ушли по Back без PiP) — входим в системный PiP вместо выхода.
  // Если PiP ещё не показывали (ушли по Back без оверлея) — сначала показываем PiP с видео, затем через задержку входим в системный PiP.
  React.useEffect(() => {
    if (Platform.OS !== 'android') return () => {};
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const pipVisible = (global as any).__pipVisibleRef?.current === true;
      const session = (global as any).__webrtcSessionRef?.current;
      const hasActiveCall = session && typeof session.getRoomId === 'function' && session.getRoomId();
      if (!pipVisible && !hasActiveCall) return false;
      if (!navRef.isReady()) return false;
      // Завершение звонка по кнопке «Завершить»: не переходить в PiP по Back (как и по Home).
      if ((global as any).__endingCallInProgressRef?.current === true) return false;
      const currentRoute = navRef.getCurrentRoute?.()?.name;
      // На экране VideoCall кнопку Back обрабатывает сам экран: возвращаемся на предыдущую
      // страницу приложения и показываем in-app PiP, не уводя задачу в фон.
      if (currentRoute === 'VideoCall' && hasActiveCall) {
        return false;
      }

      if (navRef.canGoBack()) return false; // не на корне — пусть экран/навигация обработает Back
      try {
        const SYSTEM_PIP_PREP_DELAY_MS = pipVisible ? 700 : 420;
        const prepSystemPiPUI = (onPrepared?: () => void) => {
          try {
            const upd = (global as any).__pipUpdateStateRef?.current;
            const apply = (size: { width: number; height: number } | null) => {
              try {
                if (typeof upd === 'function') {
                  upd({
                    pendingSystemPiP: true,
                    allowVideoRender: true,
                    ...(size ? { decorSizeForPiP: size } : {}),
                  });
                }
              } catch (_) {}
              setTimeout(() => {
                try {
                  const upd2 = (global as any).__pipUpdateStateRef?.current;
                  if (typeof upd2 === 'function') upd2({ pendingSystemPiP: false, decorSizeForPiP: null });
                } catch (_) {}
              }, 1500);
              setTimeout(() => {
                try { onPrepared?.(); } catch (_) {}
              }, SYSTEM_PIP_PREP_DELAY_MS);
            };
            const getDecor = NativeModules.LiviAppModule?.getDecorViewSize;
            if (typeof getDecor === 'function') {
              getDecor().then((size: { width: number; height: number }) => apply(size)).catch(() => apply(null));
            } else {
              apply(null);
            }
          } catch (_) {
            setTimeout(() => {
              try { onPrepared?.(); } catch (_) {}
            }, SYSTEM_PIP_PREP_DELAY_MS);
          }
        };
        const requestSystemPiP = () => {
          const raf = (typeof requestAnimationFrame !== 'undefined')
            ? requestAnimationFrame
            : ((fn: any) => setTimeout(fn, 0));
          raf(() => {
            raf(() => {
              try { NativeModules.LiviAppModule?.requestEnterPictureInPicture?.(); } catch (_) {}
            });
          });
        };
        const params = (global as any).__currentCallPiPParamsRef?.current;
        const callId = params?.callId ?? (typeof session.getCallId === 'function' ? session.getCallId() : null);
        const roomId = params?.roomId ?? (typeof session.getRoomId === 'function' ? session.getRoomId() : null);
        if (currentRoute !== 'VideoCall' && callId && roomId) {
          const g = global as any;
          g.__enterSystemPiPAfterVideoCallRef = g.__enterSystemPiPAfterVideoCallRef || { current: null };
          g.__enterSystemPiPAfterVideoCallRef.current = {
            callId,
            roomId,
            source: 'back-root',
            requestedAt: Date.now(),
          };
          try {
            const hidePiP = g.__pipHidePiPRef?.current;
            if (typeof hidePiP === 'function') hidePiP();
          } catch (_) {}
          navRef.navigate('VideoCall' as any, {
            ...(params?.navParams ?? {}),
            callId,
            roomId,
            directCall: true,
          });
          return true;
        }
        if (!pipVisible && hasActiveCall) {
          // Сначала показываем in-app PiP с видео, чтобы в системном PiP было видео собеседника
          const showPiP = (global as any).__pipShowPiPRef?.current;
          const remoteStream = params?.remoteStream ?? (typeof session.getRemoteStream === 'function' ? session.getRemoteStream() : null);
          if (typeof showPiP === 'function' && callId && roomId) {
            showPiP({
              callId,
              roomId,
              partnerName: params?.partnerName,
              partnerAvatarUrl: params?.partnerAvatarUrl,
              localStream: params?.localStream ?? null,
              remoteStream: remoteStream ?? null,
              localCamOn: params?.localCamOn,
              remoteCamOn: params?.remoteCamOn,
              navParams: params?.navParams,
              deferVisible: false,
            });
            if (NativeModules.LiviAppModule?.setPiPEndCallParams) {
              NativeModules.LiviAppModule.setPiPEndCallParams(callId, roomId);
            }
            if (session && typeof session.enterPiP === 'function') session.enterPiP();
            prepSystemPiPUI(requestSystemPiP);
          } else {
            prepSystemPiPUI(requestSystemPiP);
          }
        } else {
          prepSystemPiPUI(requestSystemPiP);
        }
      } catch (_) {}
      return true; // перехватываем — уходим в системный PiP, не закрываем приложение
    });
    return () => sub.remove();
  }, []);

  // Дефолтные insets, чтобы SafeAreaProvider никогда не рендерил null (иначе при уходе в PiP/фон
  // insets могут стать null и React при реконсиляции даёт "Cannot read property 'forEach' of null").
  const defaultSafeAreaInsets = { top: 0, left: 0, right: 0, bottom: 0 };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialSafeAreaInsets={defaultSafeAreaInsets}>
        <ThemeProvider>
          <PiPProvider onReturnToCall={navigateToCall} onEndCall={endCallImpl}>
            <AppContent />
          </PiPProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
