/**
 * CallKeep (ConnectionService) — нативный экран входящего звонка на Android.
 * Инициализация, displayIncomingCall, обработка answer/end.
 */
import { Platform } from 'react-native';
import { logger } from './logger';

let isSetup = false;
/** callId (uuid) -> { from, fromNick } для навигации при answer из нативного UI */
const pendingCallByUuid: Record<string, { from: string; fromNick?: string }> = {};

/** Один раз при старте приложения (только Android). Ничего не ломает при ошибке. */
export async function setupCallKeep(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (isSetup) return true;

  try {
    const RNCallKeep = require('react-native-callkeep');
    const options = {
      ios: { appName: 'LiVi' },
      android: {
        alertTitle: 'Доступ к звонкам',
        alertDescription: 'LiVi нужен доступ к учётной записи звонков для отображения входящих видеозвонков.',
        cancelButton: 'Отмена',
        okButton: 'Разрешить',
        selfManaged: true,
        foregroundService: {
          channelId: 'livi_call_channel',
          channelName: 'Звонки LiVi',
          notificationTitle: 'LiVi — видеозвонок',
          notificationIcon: 'ic_launcher',
        },
      },
    };
    await RNCallKeep.default.setup(options);
    isSetup = true;
    try {
      RNCallKeep.default.setReachable?.();
    } catch {}
    try {
      RNCallKeep.default.setAvailable?.(true);
    } catch {}
    logger.info('[callKeep] setup OK (selfManaged)');
    return true;
  } catch (e) {
    logger.warn('[callKeep] setup failed (non-fatal)', e as Error);
    return false;
  }
}

export function isCallKeepAvailable(): boolean {
  return Platform.OS === 'android' && isSetup;
}

/**
 * Показать входящий звонок в нативном UI (полный экран / уведомление).
 * Вызывать при получении входящего (сокет или пуш).
 */
export function displayIncomingCall(callId: string, fromUserId: string, fromNick?: string, hasVideo = true): void {
  if (Platform.OS !== 'android' || !isSetup) return;
  try {
    pendingCallByUuid[callId] = { from: fromUserId, fromNick };
    const RNCallKeep = require('react-native-callkeep');
    RNCallKeep.default.displayIncomingCall(callId, fromUserId, fromNick ?? '', hasVideo);
    logger.info('[callKeep] displayIncomingCall', { callId, from: fromUserId });
  } catch (e) {
    logger.warn('[callKeep] displayIncomingCall failed', e as Error);
  }
}

/** Данные входящего по callId (для навигации при answer из нативного UI). */
export function getPendingCallInfo(callId: string): { from: string; fromNick?: string } | undefined {
  return pendingCallByUuid[callId];
}

export function clearPendingCall(callId: string): void {
  delete pendingCallByUuid[callId];
}

/**
 * Сообщить CallKeep, что пользователь принял звонок (вызывать после перехода на VideoCall и acceptCall).
 */
export function reportAnswerIncomingCall(callId: string): void {
  if (Platform.OS !== 'android' || !isSetup) return;
  try {
    const RNCallKeep = require('react-native-callkeep');
    RNCallKeep.default.answerIncomingCall(callId);
    RNCallKeep.default.setCurrentCallActive?.(callId);
    clearPendingCall(callId);
  } catch (e) {
    logger.warn('[callKeep] answerIncomingCall failed', e as Error);
  }
}

/**
 * Сообщить CallKeep, что пользователь отклонил звонок.
 */
export function reportRejectCall(callId: string): void {
  if (Platform.OS !== 'android' || !isSetup) return;
  try {
    const RNCallKeep = require('react-native-callkeep');
    RNCallKeep.default.rejectCall(callId);
    clearPendingCall(callId);
  } catch (e) {
    logger.warn('[callKeep] rejectCall failed', e as Error);
  }
}

/**
 * Сообщить CallKeep, что звонок завершён (положили трубку, таймаут и т.д.).
 * Обязательно вызывать при завершении звонка, иначе следующий звонок может не идти.
 */
export function reportEndCallToCallKeep(callId: string | null): void {
  if (Platform.OS !== 'android' || !isSetup || !callId) return;
  try {
    const RNCallKeep = require('react-native-callkeep');
    RNCallKeep.default.endCall(callId);
    clearPendingCall(callId);
    logger.debug('[callKeep] endCall reported', { callId });
  } catch (e) {
    logger.warn('[callKeep] endCall failed', e as Error);
  }
}

/**
 * Сообщить системе, что приложение готово принимать/совершать звонки.
 * Вызывается после setup и после завершения звонка.
 */
export function setCallKeepAvailable(available: boolean): void {
  if (Platform.OS !== 'android' || !isSetup) return;
  try {
    const RNCallKeep = require('react-native-callkeep');
    RNCallKeep.default.setAvailable?.(available);
  } catch (e) {
    logger.warn('[callKeep] setAvailable failed', e as Error);
  }
}

export type CallKeepEventCallbacks = {
  onAnswer: (callId: string) => void;
  onEnd: (callId: string) => void;
};

/**
 * Подписаться на события answer/end от нативного экрана звонка.
 * Возвращает функцию отписки.
 */
export function registerCallKeepEvents(callbacks: CallKeepEventCallbacks): () => void {
  if (Platform.OS !== 'android' || !isSetup) return () => {};
  try {
    const RNCallKeep = require('react-native-callkeep');
    const onAnswer = ({ callUUID }: { callUUID?: string }) => {
      if (callUUID) callbacks.onAnswer(callUUID);
    };
    const onEnd = ({ callUUID }: { callUUID?: string }) => {
      if (callUUID) callbacks.onEnd(callUUID);
    };
    RNCallKeep.default.addEventListener('answerCall', onAnswer);
    RNCallKeep.default.addEventListener('endCall', onEnd);
    return () => {
      try {
        RNCallKeep.default.removeEventListener?.('answerCall', onAnswer);
        RNCallKeep.default.removeEventListener?.('endCall', onEnd);
      } catch {}
    };
  } catch (e) {
    logger.warn('[callKeep] registerCallKeepEvents failed', e as Error);
    return () => {};
  }
}
