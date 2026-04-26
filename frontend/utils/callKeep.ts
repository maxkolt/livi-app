/**
 * CallKeep (ConnectionService) — нативный экран входящего звонка на Android.
 * Инициализация, displayIncomingCall, обработка answer/end.
 */
import { Platform, PermissionsAndroid, NativeModules } from 'react-native';
import { logger } from './logger';
import { setIncomingCallScreenVisible } from '../sockets/socket';
import { loadLang, t } from './i18n';

/** Единый источник таймаута исходящего вызова (мс). Передаётся в натив при старте, используется в HomeScreen/App и в LiviOutgoingCallService. */
export const OUTGOING_CALL_TIMEOUT_MS = 20_000;

let isSetup = false;
/** Разрешение READ_PHONE_NUMBERS выдано (иначе VoiceConnectionService падает с SecurityException) */
let hasPhoneNumbersPermission = false;
/** raw callId -> { from, fromNick, callKitId } для навигации при answer из нативного UI */
const pendingCallById: Record<string, { from: string; fromNick?: string; callKitId?: string }> = {};
const callKitUuidByCallId: Record<string, string> = {};
const callIdByCallKitUuid: Record<string, string> = {};

function resolveRawCallId(callIdOrUuid: string): string {
  const id = String(callIdOrUuid || '').trim();
  return callIdByCallKitUuid[id] || id;
}

function resolveCallKeepUuid(callIdOrUuid: string): string {
  const id = String(callIdOrUuid || '').trim();
  return callKitUuidByCallId[id] || id;
}

function rememberPendingCall(input: { callId: string; from: string; fromNick?: string; callKitId?: string }): void {
  const callId = String(input.callId || '').trim();
  const from = String(input.from || '').trim();
  const callKitId = String(input.callKitId || '').trim();
  if (!callId || !from) return;
  pendingCallById[callId] = { from, fromNick: input.fromNick, callKitId: callKitId || undefined };
  if (callKitId) {
    callKitUuidByCallId[callId] = callKitId;
    callIdByCallKitUuid[callKitId] = callId;
  }
}

type SetupCallKeepOptions = {
  requestPermission?: boolean;
};

/** Ленивая инициализация CallKeep. Permission можно только проверить или запросить явно. */
export async function setupCallKeep(options?: SetupCallKeepOptions): Promise<boolean> {
  const requestPermission = options?.requestPermission === true;
  const lang = await loadLang();

  if (Platform.OS === 'ios') {
    try {
      const RNCallKeep = require('react-native-callkeep');
      const settings = {
        ios: {
          appName: 'LiVi',
          handleType: 'generic',
          supportsVideo: true,
          includesCallsInRecents: false,
          maximumCallGroups: '1',
          maximumCallsPerCallGroup: '1',
        },
        android: {
          alertTitle: t('callPermissionTitle', lang),
          alertDescription: t('callKeepAlertDescription', lang),
          cancelButton: t('cancelAction', lang),
          okButton: t('allowAction', lang),
          selfManaged: true,
          foregroundService: {
            channelId: 'livi_call_channel',
            channelName: t('callChannelName', lang),
            notificationTitle: t('callNotificationTitle', lang),
            notificationIcon: 'ic_launcher',
          },
        },
      };
      try {
        RNCallKeep.default.setSettings?.(settings);
      } catch {
        await RNCallKeep.default.setup(settings);
      }
      isSetup = true;
      return true;
    } catch (e) {
      logger.warn('[callKeep] iOS setup failed', e as Error);
      return false;
    }
  }

  if (Platform.OS !== 'android') return false;

  try {
    const status = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_PHONE_NUMBERS);
    if (status) {
      hasPhoneNumbersPermission = true;
    } else if (requestPermission) {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.READ_PHONE_NUMBERS,
        {
          title: t('callPermissionTitle', lang),
          message: t('callPermissionMessage', lang),
          buttonPositive: t('allowAction', lang),
        }
      );
      hasPhoneNumbersPermission = granted === PermissionsAndroid.RESULTS.GRANTED;
      if (!hasPhoneNumbersPermission) {
        logger.warn('[callKeep] READ_PHONE_NUMBERS not granted — нативный экран звонка отключён, только модалка в приложении');
      }
    } else {
      hasPhoneNumbersPermission = false;
      logger.info('[callKeep] READ_PHONE_NUMBERS not granted yet — skipping CallKeep setup without prompt');
    }
  } catch (e) {
    logger.warn('[callKeep] READ_PHONE_NUMBERS check/request failed', e as Error);
  }

  if (!hasPhoneNumbersPermission) return false;
  if (isSetup) return true;

  try {
    const RNCallKeep = require('react-native-callkeep');
    const options = {
      ios: { appName: 'LiVi' },
      android: {
        alertTitle: t('callPermissionTitle', lang),
        alertDescription: t('callKeepAlertDescription', lang),
        cancelButton: t('cancelAction', lang),
        okButton: t('allowAction', lang),
        selfManaged: true,
        foregroundService: {
          channelId: 'livi_call_channel',
          channelName: t('callChannelName', lang),
          notificationTitle: t('callNotificationTitle', lang),
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
  if (Platform.OS === 'ios') return isSetup;
  return Platform.OS === 'android' && isSetup && hasPhoneNumbersPermission;
}

/** Один раз закрываем исходящий при decline: сокет и пуш оба могут прийти — закрываем только по первому. */
let outgoingDeclineHandledCallId: string | null = null;
export function markOutgoingDeclineHandled(callId: string): void {
  outgoingDeclineHandledCallId = callId;
}
export function isOutgoingDeclineHandled(callId: string): boolean {
  return outgoingDeclineHandledCallId === callId;
}
export function clearOutgoingDeclineHandled(): void {
  outgoingDeclineHandledCallId = null;
}

/** Дебаунс: не вызывать нативный finish повторно в течение окна (сокет+пуш могут оба вызвать close; увеличенное окно реже даёт «пропуск» при двойных вызовах). */
const OUTGOING_CLOSE_DEBOUNCE_MS = 2000;
let lastOutgoingCloseAt = 0;

/** Сбросить дебаунс при открытии нового исходящего (чтобы следующий decline мог закрыть). */
export function resetOutgoingCloseDebounce(): void {
  lastOutgoingCloseAt = 0;
}

/** Закрыть нативный экран исходящего (OutgoingCallActivity) при принятии/отклонении/таймауте. */
export function closeOutgoingCallActivity(): void {
  if (Platform.OS !== 'android') return;
  const now = Date.now();
  const sinceLast = lastOutgoingCloseAt > 0 ? now - lastOutgoingCloseAt : Infinity;
  if (sinceLast < OUTGOING_CLOSE_DEBOUNCE_MS) {
    logger.info('[decline/инициатор] callKeep.closeOutgoingCallActivity — пропуск (дебаунс)', { sinceLastMs: Math.round(sinceLast) });
    return;
  }
  lastOutgoingCloseAt = now;
  logger.info('[decline/инициатор] callKeep.closeOutgoingCallActivity — вызываем нативный finish');
  try {
    NativeModules.LiviAppModule?.closeOutgoingCallActivity?.();
  } catch {}
}

/**
 * Вывести MainActivity на передний план (сценарий «только сокет»: call:accepted пришёл по сокету,
 * FCM не сработал — после навигации на VideoCall и closeOutgoingCallActivity вызывать, чтобы пользователь увидел экран видеозвонка).
 */
export function bringMainActivityToFront(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.bringMainActivityToFront?.();
  } catch {}
}

/** Дедупликация: один и тот же callId не показываем повторно (сокет + пуш могут вызвать несколько раз). */
const lastDisplayedCallId = { id: '' as string, at: 0 };
const DISPLAY_DEBOUNCE_MS = 3000;

/**
 * Единый UI входящего на Android: открыть нативный IncomingCallActivity (foreground и из livi://incoming-call).
 * Вызывать вместо displayIncomingCall когда приложение на переднем плане или из deep link.
 */
/**
 * Если checkEnded === true, перед показом проверяет isEndedCallId (для запоздалого Expo-пуша «call»).
 */
export async function launchIncomingCallActivityScreen(
  callId: string,
  from: string,
  fromNick?: string,
  checkEnded?: boolean
): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    if (checkEnded && (await isEndedCallId(callId))) {
      logger.debug('[callKeep] launchIncomingCallActivityScreen skipped (call already ended)', { callId });
      return;
    }
    const now = Date.now();
    if (lastDisplayedCallId.id === callId && now - lastDisplayedCallId.at < DISPLAY_DEBOUNCE_MS) {
      logger.debug('[callKeep] launchIncomingCallActivityScreen skipped (duplicate)', { callId });
      return;
    }
    lastDisplayedCallId.id = callId;
    lastDisplayedCallId.at = now;
    const LiviAppModule = NativeModules.LiviAppModule;
    if (LiviAppModule?.launchIncomingCallActivity) {
      LiviAppModule.launchIncomingCallActivity(callId, from, fromNick ?? '');
      setIncomingCallScreenVisible(true, from);
      logger.info('[callKeep] launchIncomingCallActivityScreen', { callId, from });
    }
  } catch (e) {
    logger.warn('[callKeep] launchIncomingCallActivityScreen failed', e as Error);
  }
}

/**
 * Android: показать системный UI входящего, когда приложение НЕ в фокусе.
 * Натив сам решит:
 * - unlocked → heads-up уведомление (как на скрине)
 * - locked/sleep → full-screen → IncomingCallActivity
 */
export function showIncomingCallSystemUI(callId: string, from: string, fromNick?: string): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.showIncomingCallSystemUI?.(callId, from, fromNick ?? '');
    // Как у launchIncomingCallActivityScreen: держим сокет/presence в согласовании с нативным входящим в фоне.
    setIncomingCallScreenVisible(true, from);
  } catch {}
}

/** Уже завершён/отменён ли звонок? Чтобы не показывать входящий при запоздалом пуше «call». */
export function isEndedCallId(callId: string): Promise<boolean> {
  if (Platform.OS !== 'android' || !callId?.trim()) return Promise.resolve(false);
  try {
    const p = NativeModules.LiviAppModule?.isEndedCallId?.(callId.trim());
    return Promise.resolve(p).then((v) => !!v).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/** Пометить звонок как завершённый на нативной стороне (при push call_ended). Чтобы при позднем/дублирующем пуше «call» не показывался экран входящего. */
export function addEndedCallId(callId: string): void {
  if (Platform.OS !== 'android' || !callId?.trim()) return;
  try {
    NativeModules.LiviAppModule?.addEndedCallId?.(callId.trim());
  } catch {}
}

/** Прочитать и сбросить входящий, переданный из FCM для показа через CallKeep (ConnectionService). Вызывать при старте приложения; при наличии данных — displayIncomingCall и stopIncomingCallForegroundService. */
export function getAndClearPendingIncomingCallForCallKeep(): Promise<{ callId: string; from: string; fromNick: string } | null> {
  if (Platform.OS !== 'android') return Promise.resolve(null);
  try {
    const p = NativeModules.LiviAppModule?.getAndClearPendingIncomingCallForCallKeep?.();
    return Promise.resolve(p).then((m) => {
      if (!m || typeof m.callId !== 'string' || typeof m.from !== 'string') return null;
      return { callId: m.callId, from: m.from, fromNick: typeof m.fromNick === 'string' ? m.fromNick : '' };
    }).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

/** Остановить IncomingCallForegroundService после показа входящего через CallKeep (ConnectionService). */
export function stopIncomingCallForegroundService(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.stopIncomingCallForegroundService?.();
  } catch {}
}

/** Запустить системную мелодию звонка и вибрацию звонка (Настройки телефона) для ConnectionService/CallKeep. */
export function startIncomingCallRingtoneAndVibration(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.startIncomingCallRingtoneAndVibration?.();
  } catch {}
}

/** Остановить мелодию и вибрацию входящего (после ответа/отклонения/отмены). */
export function stopIncomingCallRingtoneAndVibration(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.stopIncomingCallRingtoneAndVibration?.();
  } catch {}
}

/** Инициатор отменил вызов — пуш пришёл через Expo. Закрыть IncomingCallActivity и снять уведомление (то же, что FCM call_canceled). */
export function notifyCallCanceled(callId: string): void {
  if (Platform.OS !== 'android' || !callId?.trim()) return;
  try {
    NativeModules.LiviAppModule?.notifyCallCanceled?.(callId.trim());
  } catch {}
}

/** Отправить broadcast «call_answered» чтобы IncomingCallActivity закрылась (при ответе из уведомления). */
export function sendCallAnsweredBroadcast(callId: string): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.sendCallAnsweredBroadcast?.(callId);
  } catch {}
}

/** Открыть настройки уведомлений приложения (Android 8+). Включите «Полноэкранные уведомления» или «Показ как всплывающее окно», чтобы входящие звонки открывались на весь экран. */
export function openAppNotificationSettings(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.openAppNotificationSettings?.();
  } catch {}
}

/** Проверить, отключена ли battery optimization (Doze whitelist) для приложения. */
export function isIgnoringBatteryOptimizations(): Promise<boolean> {
  if (Platform.OS !== 'android') return Promise.resolve(true);
  try {
    return NativeModules.LiviAppModule?.isIgnoringBatteryOptimizations?.() ?? Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }
}

/** Открыть экран отключения оптимизации батареи для приложения. */
export function openBatteryOptimizationSettings(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.openBatteryOptimizationSettings?.();
  } catch {}
}

/** Открыть OEM-экран автозапуска/фоновой активности (если есть). */
export function openAutostartSettings(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.openAutostartSettings?.();
  } catch {}
}

/** Проверить, разрешены ли уведомления для приложения. Если нет — входящие звонки в фоне не покажут полноэкранный экран. */
export function areNotificationsEnabled(): Promise<boolean> {
  if (Platform.OS !== 'android') return Promise.resolve(true);
  try {
    return NativeModules.LiviAppModule?.areNotificationsEnabled?.() ?? Promise.resolve(true);
  } catch {
    return Promise.resolve(true);
  }
}

/** Проверить, разрешены ли полноэкранные уведомления (Android 14+). На старых версиях возвращает true. */
export function canUseFullScreenIntent(): Promise<boolean> {
  if (Platform.OS !== 'android') return Promise.resolve(true);
  try {
    return NativeModules.LiviAppModule?.canUseFullScreenIntent?.() ?? Promise.resolve(true);
  } catch {
    return Promise.resolve(true);
  }
}

/** Проверить, разрешено ли приложению «отображение поверх других окон» (Всегда сверху). */
export function canDrawOverlays(): Promise<boolean> {
  if (Platform.OS !== 'android') return Promise.resolve(true);
  try {
    return NativeModules.LiviAppModule?.canDrawOverlays?.() ?? Promise.resolve(true);
  } catch {
    return Promise.resolve(true);
  }
}

/** Открыть настройки «Отображение поверх других окон» / «Всегда сверху» для приложения. */
export function openOverlayPermissionSettings(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.openOverlayPermissionSettings?.();
  } catch {}
}

/** Передать нативу таймаут исходящего вызова (единый источник с OUTGOING_CALL_TIMEOUT_MS). Вызывать при старте приложения. */
export function setOutgoingCallTimeoutMs(ms: number): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.setOutgoingCallTimeoutMs?.(ms);
  } catch {}
}

/**
 * Показать нативный экран исходящего вызова сразу (без задержки на ответ сервера).
 * Вызывать в момент нажатия кнопки видеозвонка. После получения callId вызвать notifyOutgoingCallId(callId).
 */
export function displayOutgoingCallImmediate(toUserId: string, toNick?: string): void {
  logger.info('[outgoing] displayOutgoingCallImmediate called', {
    toUserId,
    toNick: toNick ?? '',
    platform: Platform.OS,
    isSetup,
    hasPhoneNumbersPermission,
  });
  if (Platform.OS !== 'android') {
    logger.info('[outgoing] skip: not Android');
    return;
  }
  if (!isSetup || !hasPhoneNumbersPermission) {
    logger.warn('[outgoing] skip: нативный экран не показывается — isSetup=false или нет разрешения', {
      isSetup,
      hasPhoneNumbersPermission,
    });
    return;
  }
  resetOutgoingCloseDebounce();
  try {
    const LiviAppModule = NativeModules.LiviAppModule;
    if (LiviAppModule?.launchOutgoingCallActivityWithoutCallId) {
      logger.info('[outgoing] calling native launchOutgoingCallActivityWithoutCallId', { to: toUserId });
      LiviAppModule.launchOutgoingCallActivityWithoutCallId(toUserId, toNick ?? toUserId);
      logger.info('[callKeep] displayOutgoingCallImmediate', { to: toUserId });
    } else if (LiviAppModule?.launchOutgoingCallActivity) {
      logger.info('[outgoing] calling native launchOutgoingCallActivity (fallback, no callId)', { to: toUserId });
      LiviAppModule.launchOutgoingCallActivity('', toUserId, toNick ?? toUserId);
      logger.info('[callKeep] displayOutgoingCallImmediate (fallback)', { to: toUserId });
    } else {
      logger.warn('[outgoing] LiviAppModule: нет метода launchOutgoingCallActivity* — нативный экран не запущен', {
        hasModule: !!LiviAppModule,
      });
    }
  } catch (e) {
    logger.warn('[callKeep] displayOutgoingCallImmediate failed', e as Error);
  }
}

/** Передать callId уже открытому нативному экрану исходящего (после ответа сервера). Запускает звук и таймаут 20с. */
export function notifyOutgoingCallId(callId: string): void {
  logger.info('[outgoing] notifyOutgoingCallId called', { callId, platform: Platform.OS });
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.notifyOutgoingCallId?.(callId);
    logger.info('[callKeep] notifyOutgoingCallId', { callId });
  } catch (e) {
    logger.warn('[callKeep] notifyOutgoingCallId failed', e as Error);
  }
}

/**
 * Показать исходящий звонок в нативном UI (полный экран / уведомление).
 * Вызывать после startCall, когда получен callId с сервера.
 * Уведомление в шторке одно — от LiviOutgoingCallService (звук, тап в экран, 20с таймаут).
 * CallKeep.startCall не вызываем, чтобы не дублировать уведомление.
 */
export function displayOutgoingCall(callId: string, toUserId: string, toNick?: string, _hasVideo = true): void {
  if (Platform.OS !== 'android') return;
  if (!isSetup || !hasPhoneNumbersPermission) return;
  try {
    const LiviAppModule = NativeModules.LiviAppModule;
    if (LiviAppModule?.launchOutgoingCallActivity) {
      LiviAppModule.launchOutgoingCallActivity(callId, toUserId, toNick ?? toUserId);
    }
    logger.info('[callKeep] displayOutgoingCall', { callId, to: toUserId });
  } catch (e) {
    logger.warn('[callKeep] displayOutgoingCall failed', e as Error);
  }
}

/**
 * Показать входящий звонок в нативном UI (полный экран / уведомление).
 * Вызывать при получении входящего (сокет или пуш). Повторные вызовы для того же callId игнорируются.
 */
export function displayIncomingCall(callId: string, fromUserId: string, fromNick?: string, hasVideo = true, callKitId?: string): void {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return;
  if (!isSetup || (Platform.OS === 'android' && !hasPhoneNumbersPermission)) {
    logger.warn('[callKeep] displayIncomingCall skipped (no setup or no READ_PHONE_NUMBERS)', {
      callId,
      isSetup,
      hasPhoneNumbersPermission,
    });
    return;
  }
  const now = Date.now();
  if (lastDisplayedCallId.id === callId && now - lastDisplayedCallId.at < DISPLAY_DEBOUNCE_MS) {
    logger.debug('[callKeep] displayIncomingCall skipped (duplicate)', { callId });
    return;
  }
  lastDisplayedCallId.id = callId;
  lastDisplayedCallId.at = now;
  try {
    rememberPendingCall({ callId, from: fromUserId, fromNick, callKitId });
    const RNCallKeep = require('react-native-callkeep');
    const nativeCallId = Platform.OS === 'ios' ? resolveCallKeepUuid(callKitId || callId) : callId;
    if (Platform.OS === 'ios') {
      RNCallKeep.default.displayIncomingCall(nativeCallId, fromUserId, fromNick ?? '', 'generic', hasVideo, {
        ios: { supportsHolding: false, supportsDTMF: false, supportsGrouping: false, supportsUngrouping: false },
      });
    } else {
      RNCallKeep.default.displayIncomingCall(nativeCallId, fromUserId, fromNick ?? '', hasVideo);
    }
    setIncomingCallScreenVisible(true, fromUserId);
    logger.info('[callKeep] displayIncomingCall', { callId, from: fromUserId });
  } catch (e) {
    logger.warn('[callKeep] displayIncomingCall failed', e as Error);
  }
}

/** Данные входящего по callId (для навигации при answer из нативного UI). */
export function getPendingCallInfo(callId: string): { from: string; fromNick?: string; callKitId?: string } | undefined {
  return pendingCallById[resolveRawCallId(callId)];
}

export function clearPendingCall(callId: string): void {
  const rawCallId = resolveRawCallId(callId);
  const callKitId = callKitUuidByCallId[rawCallId];
  delete pendingCallById[rawCallId];
  if (callKitId) {
    delete callIdByCallKitUuid[callKitId];
  }
  delete callKitUuidByCallId[rawCallId];
}

/**
 * Сообщить CallKeep, что пользователь принял звонок (вызывать после перехода на VideoCall и acceptCall).
 */
export function reportAnswerIncomingCall(callId: string): void {
  if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !isSetup) return;
  try {
    const RNCallKeep = require('react-native-callkeep');
    const nativeCallId = resolveCallKeepUuid(callId);
    RNCallKeep.default.answerIncomingCall(nativeCallId);
    if (Platform.OS === 'android') {
      RNCallKeep.default.setCurrentCallActive?.(nativeCallId);
    }
    clearPendingCall(callId);
  } catch (e) {
    logger.warn('[callKeep] answerIncomingCall failed', e as Error);
  }
}

/**
 * Сообщить CallKeep, что пользователь отклонил звонок.
 */
export function reportRejectCall(callId: string): void {
  if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !isSetup) return;
  try {
    const RNCallKeep = require('react-native-callkeep');
    RNCallKeep.default.rejectCall(resolveCallKeepUuid(callId));
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
  if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !isSetup || !callId) return;
  try {
    const RNCallKeep = require('react-native-callkeep');
    RNCallKeep.default.endCall(resolveCallKeepUuid(callId));
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
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return () => {};
  try {
    const RNCallKeep = require('react-native-callkeep');
    const syncPendingFromDisplay = (event: {
      callUUID?: string;
      handle?: string;
      localizedCallerName?: string;
      payload?: Record<string, unknown>;
    }) => {
      const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
      const callId = String((payload as any)?.callId || event?.callUUID || '').trim();
      const from = String((payload as any)?.from || (payload as any)?.fromUserId || event?.handle || '').trim();
      const fromNick = String((payload as any)?.fromNick || event?.localizedCallerName || '').trim();
      const callKitId = String((payload as any)?.callKitId || event?.callUUID || '').trim();
      if (callId && from) {
        rememberPendingCall({ callId, callKitId, from, fromNick: fromNick || undefined });
      }
    };
    const onAnswer = ({ callUUID }: { callUUID?: string }) => {
      if (callUUID) callbacks.onAnswer(resolveRawCallId(callUUID));
    };
    const onEnd = ({ callUUID }: { callUUID?: string }) => {
      if (callUUID) callbacks.onEnd(resolveRawCallId(callUUID));
    };
    const onDisplay = (event: { callUUID?: string; handle?: string; localizedCallerName?: string; payload?: Record<string, unknown> }) => {
      syncPendingFromDisplay(event);
    };
    RNCallKeep.default.addEventListener('answerCall', onAnswer);
    RNCallKeep.default.addEventListener('endCall', onEnd);
    RNCallKeep.default.addEventListener('didDisplayIncomingCall', onDisplay);
    RNCallKeep.default.getInitialEvents?.()
      ?.then?.((events: Array<{ name?: string; data?: any }>) => {
        for (const event of events || []) {
          const name = String(event?.name || '');
          if (name === 'RNCallKeepDidDisplayIncomingCall') {
            syncPendingFromDisplay(event?.data || {});
          } else if (name === 'RNCallKeepPerformAnswerCallAction' && event?.data?.callUUID) {
            callbacks.onAnswer(resolveRawCallId(String(event.data.callUUID)));
          } else if (name === 'RNCallKeepPerformEndCallAction' && event?.data?.callUUID) {
            callbacks.onEnd(resolveRawCallId(String(event.data.callUUID)));
          }
        }
        RNCallKeep.default.clearInitialEvents?.();
      })
      ?.catch?.(() => {});
    return () => {
      try {
        RNCallKeep.default.removeEventListener?.('answerCall', onAnswer);
        RNCallKeep.default.removeEventListener?.('endCall', onEnd);
        RNCallKeep.default.removeEventListener?.('didDisplayIncomingCall', onDisplay);
      } catch {}
    };
  } catch (e) {
    logger.warn('[callKeep] registerCallKeepEvents failed', e as Error);
    return () => {};
  }
}
