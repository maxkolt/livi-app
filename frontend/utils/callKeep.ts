/**
 * CallKeep (ConnectionService) — нативный экран входящего звонка на Android.
 * Инициализация, displayIncomingCall, обработка answer/end.
 */
import { Platform, NativeModules, AppState, PermissionsAndroid } from 'react-native';
import { logger } from './logger';
import { setIncomingCallScreenVisible } from '../sockets/socket';
import { loadLang, t } from './i18n';
import { prefetchDirectCallIce } from './directCallConnectPrewarm';
// Константа вынесена в callTimeouts.ts, чтобы её можно было использовать (см. callExpiry.ts)
// без затягивания тяжёлого графа зависимостей этого файла (react-native, sockets/socket, i18n...).
import { OUTGOING_CALL_TIMEOUT_MS } from './callTimeouts';
import {
  type DirectCallMediaHint,
  setCallMediaHint,
  getCallMediaHint,
  resolveDirectCallAudioFirst,
  resolveCallHasVideo,
  videoCallNavExtras,
} from './directCallMediaHint';

export type { DirectCallMediaHint };
export {
  setCallMediaHint,
  getCallMediaHint,
  resolveDirectCallAudioFirst,
  resolveCallHasVideo,
  videoCallNavExtras,
};

export { OUTGOING_CALL_TIMEOUT_MS };

let isSetup = false;
/** Android: CallKeep успешно инициализирован и готов к показу системного UI звонка. */
let isAndroidCallKeepReady = false;
/** Android: устройство без android.software.telecom (планшеты) — CallKeep не используем. */
let androidTelecomSupported: boolean | null = null;
let androidTelecomSupportedPromise: Promise<boolean> | null = null;

async function resolveAndroidTelecomSupported(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (androidTelecomSupported !== null) return androidTelecomSupported;
  if (!androidTelecomSupportedPromise) {
    androidTelecomSupportedPromise = (async () => {
      try {
        const mod = NativeModules.LiviAppModule;
        if (mod?.isTelecomSupported) {
          androidTelecomSupported = (await mod.isTelecomSupported()) === true;
        } else {
          androidTelecomSupported = true;
        }
      } catch {
        androidTelecomSupported = true;
      }
      return androidTelecomSupported;
    })();
  }
  return androidTelecomSupportedPromise;
}

/**
 * Samsung/API 30+: VoiceConnectionService.getPhoneAccount требует READ_PHONE_NUMBERS.
 * В Play-сборке permission снят (AndroidManifest tools:node=remove) → displayIncomingCall
 * крашит процесс SecurityException. Connection создаём только если permission реально есть.
 */
let androidTelecomConnectionAllowed: boolean | null = null;
let androidTelecomConnectionAllowedPromise: Promise<boolean> | null = null;

async function canCreateAndroidTelecomConnection(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (androidTelecomConnectionAllowed !== null) return androidTelecomConnectionAllowed;
  if (!androidTelecomConnectionAllowedPromise) {
    androidTelecomConnectionAllowedPromise = (async () => {
      try {
        const perm = PermissionsAndroid.PERMISSIONS.READ_PHONE_NUMBERS;
        if (!perm) {
          androidTelecomConnectionAllowed = false;
          return false;
        }
        const granted = await PermissionsAndroid.check(perm);
        androidTelecomConnectionAllowed = granted === true;
      } catch {
        androidTelecomConnectionAllowed = false;
      }
      if (!androidTelecomConnectionAllowed) {
        logger.info(
          '[callKeep] Telecom Connection disabled (no READ_PHONE_NUMBERS) — IncomingCallActivity only',
        );
      }
      return androidTelecomConnectionAllowed;
    })();
  }
  return androidTelecomConnectionAllowedPromise;
}
/** raw callId -> { from, fromNick, callKitId, hasVideo? } для навигации при answer из нативного UI */
const pendingCallById: Record<string, { from: string; fromNick?: string; callKitId?: string; hasVideo?: boolean }> = {};
const callKitUuidByCallId: Record<string, string> = {};
const callIdByCallKitUuid: Record<string, string> = {};
const activeCallKeepCallIds = new Set<string>();
/** Android: уже вызывали displayIncomingCall (Telecom Connection) для этого callId. */
const callKeepConnectionRequestedIds = new Set<string>();
const recentCallKeepEndAtByCallId: Record<string, number> = {};
const CALLKEEP_END_DEDUP_MS = 4000;
/** Telecom Connection создаётся асинхронно после addNewIncomingCall — ретраи для answer/active/end. */
const CALLKEEP_CONNECTION_RETRY_MS = [0, 60, 160, 350, 700, 1200] as const;

function resolveRawCallId(callIdOrUuid: string): string {
  const id = String(callIdOrUuid || '').trim();
  return callIdByCallKitUuid[id] || id;
}

function resolveCallKeepUuid(callIdOrUuid: string): string {
  const id = String(callIdOrUuid || '').trim();
  return callKitUuidByCallId[id] || id;
}

function rememberPendingCall(input: { callId: string; from: string; fromNick?: string; callKitId?: string; hasVideo?: boolean }): void {
  const callId = String(input.callId || '').trim();
  const from = String(input.from || '').trim();
  const callKitId = String(input.callKitId || '').trim();
  if (!callId || !from) return;
  const hasVideo = input.hasVideo === true;
  pendingCallById[callId] = { from, fromNick: input.fromNick, callKitId: callKitId || undefined, hasVideo };
  setCallMediaHint(callId, hasVideo ? 'video' : 'audio');
  activeCallKeepCallIds.add(callId);
  if (callKitId) {
    callKitUuidByCallId[callId] = callKitId;
    callIdByCallKitUuid[callKitId] = callId;
  }
}

function canEndCallKeepCall(callIdOrUuid: string): { ok: boolean; callId: string } {
  const callId = resolveRawCallId(callIdOrUuid);
  if (!callId) return { ok: false, callId: '' };
  const now = Date.now();
  const lastEndAt = recentCallKeepEndAtByCallId[callId] || 0;
  if (lastEndAt > 0 && now - lastEndAt < CALLKEEP_END_DEDUP_MS) {
    return { ok: false, callId };
  }
  if (!activeCallKeepCallIds.has(callId)) {
    return { ok: false, callId };
  }
  return { ok: true, callId };
}

function markCallKeepEnded(callIdOrUuid: string): void {
  const callId = resolveRawCallId(callIdOrUuid);
  if (!callId) return;
  recentCallKeepEndAtByCallId[callId] = Date.now();
  activeCallKeepCallIds.delete(callId);
  callKeepConnectionRequestedIds.delete(callId);
  clearPendingCall(callId);
}

/**
 * Повторить native CallKeep action: Connection появляется не сразу после displayIncomingCall.
 * Native API при отсутствии connection только логирует warn и не бросает — поэтому ретраим слепо.
 */
function runWithCallKeepConnectionRetry(
  label: string,
  nativeCallId: string,
  action: (rnCallKeep: { default: any }) => void,
): void {
  let rn: { default: any } | null = null;
  try {
    rn = require('react-native-callkeep');
  } catch (e) {
    logger.warn(`[callKeep] ${label} require failed`, e as Error);
    return;
  }
  CALLKEEP_CONNECTION_RETRY_MS.forEach((delayMs, attempt) => {
    setTimeout(() => {
      try {
        action(rn!);
        if (attempt > 0) {
          logger.debug(`[callKeep] ${label} retry`, { nativeCallId, attempt, delayMs });
        }
      } catch (e) {
        if (attempt === CALLKEEP_CONNECTION_RETRY_MS.length - 1) {
          logger.warn(`[callKeep] ${label} failed`, e as Error);
        }
      }
    }, delayMs);
  });
}

type SetupCallKeepOptions = {
  requestPermission?: boolean;
};

/** Ленивая инициализация CallKeep. Permission можно только проверить или запросить явно. */
export async function setupCallKeep(options?: SetupCallKeepOptions): Promise<boolean> {
  const requestPermission = options?.requestPermission === true;

  if (Platform.OS === 'android' && isSetup) {
    return isAndroidCallKeepReady;
  }

  const lang = await loadLang();

  if (Platform.OS === 'ios') {
    if (isSetup) return true;
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

  if (requestPermission) {
    logger.info('[callKeep] setup requested with permission prompt flag; no dangerous runtime permission is requested on Android');
  }

  const telecomSupported = await resolveAndroidTelecomSupported();
  if (!telecomSupported) {
    isSetup = true;
    isAndroidCallKeepReady = false;
    logger.info('[callKeep] skip setup: device has no android.software.telecom (tablet / no Telecom stack)');
    return false;
  }

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
    isAndroidCallKeepReady = true;
    try {
      RNCallKeep.default.setReachable?.();
    } catch {}
    try {
      RNCallKeep.default.setAvailable?.(true);
    } catch {}
    logger.info('[callKeep] setup OK (selfManaged)');
    return true;
  } catch (e) {
    isAndroidCallKeepReady = false;
    logger.warn('[callKeep] setup failed (non-fatal)', e as Error);
    return false;
  }
}

export function isCallKeepAvailable(): boolean {
  if (Platform.OS === 'ios') return isSetup;
  return Platform.OS === 'android' && isSetup && isAndroidCallKeepReady;
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

/** Дебаунс: не вызывать нативный finish повторно для одного и того же callId; разные звонки закрываем независимо. */
const OUTGOING_CLOSE_DEBOUNCE_MS = 2000;
const lastOutgoingCloseAtByKey: Record<string, number> = {};

/** Сбросить дебаунс при открытии нового исходящего (чтобы следующий decline мог закрыть). */
export function resetOutgoingCloseDebounce(): void {
  for (const key of Object.keys(lastOutgoingCloseAtByKey)) delete lastOutgoingCloseAtByKey[key];
}

/** Закрыть нативный экран исходящего (OutgoingCallActivity) при принятии/отклонении/таймауте. */
export function closeOutgoingCallActivity(
  callId?: string | null,
  opts?: { force?: boolean; skipMainReturn?: boolean },
): void {
  if (Platform.OS !== 'android') return;
  const id = String(callId || '').trim();
  const key = id || '__unscoped__';
  const now = Date.now();
  const lastAt = lastOutgoingCloseAtByKey[key] || 0;
  const sinceLast = lastAt > 0 ? now - lastAt : Infinity;
  if (!opts?.force && sinceLast < OUTGOING_CLOSE_DEBOUNCE_MS) {
    logger.info('[decline/инициатор] callKeep.closeOutgoingCallActivity — пропуск (дебаунс)', {
      callId: id || null,
      sinceLastMs: Math.round(sinceLast),
    });
    return;
  }
  lastOutgoingCloseAtByKey[key] = now;
  logger.info('[decline/инициатор] callKeep.closeOutgoingCallActivity — вызываем нативный finish', {
    callId: id || null,
    force: opts?.force === true,
    skipMainReturn: opts?.skipMainReturn === true,
  });
  try {
    NativeModules.LiviAppModule?.closeOutgoingCallActivity?.(
      id,
      opts?.force === true,
      opts?.skipMainReturn === true,
    );
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

/**
 * Accept входящего: сразу Main на передний план, без закрытия Outgoing через startActivity
 * (иначе singleInstance Outgoing мелькает и после finish остаётся лаунчер).
 */
export function bringMainActivityToFrontForIncomingAnswer(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.bringMainActivityToFrontForIncomingAnswer?.();
  } catch {}
}

/** Снять нативную крышку accept (#0A0C14) после отрисовки VideoCall. */
export function clearIncomingAnswerNativeCover(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.clearIncomingAnswerNativeCover?.();
  } catch {}
}

/** Показать нативную крышку accept без подъёма Main. */
export function showIncomingAnswerNativeCover(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.showIncomingAnswerNativeCover?.();
  } catch {}
}

/**
 * Выход из системного PiP без finish() MainActivity: разворот в полноэкранный режим (REORDER_TO_FRONT).
 * Нужен при call:ended у собеседника / LiveKit — иначе moveTaskToBack+finish() убивает Activity и Metro перезапускается с нуля.
 * Завершение по X в PiP — по-прежнему {@link NativeModules.LiviAppModule.requestExitSystemPiP} (жёсткий выход).
 */
export function requestExitSystemPiPSoft(): void {
  if (Platform.OS !== 'android') return;
  try {
    (NativeModules.LiviAppModule as any)?.requestExitSystemPiPSoft?.();
  } catch {}
}

/** Закрыть system PiP при завершении звонка (несколько попыток + fallback hard exit). */
export function dismissSystemPiPAfterCallEnded(): void {
  if (Platform.OS !== 'android') return;
  try {
    (NativeModules.LiviAppModule as any)?.dismissSystemPiPAfterCallEnded?.();
  } catch {
    requestExitSystemPiPSoft();
  }
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
  checkEnded?: boolean,
  hasVideo = false,
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
      rememberPendingCall({ callId, from, fromNick, hasVideo });
      LiviAppModule.launchIncomingCallActivity(callId, from, fromNick ?? '', hasVideo);
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
export function showIncomingCallSystemUI(callId: string, from: string, fromNick?: string, hasVideo = false): void {
  if (Platform.OS !== 'android') return;
  try {
    rememberPendingCall({ callId, from, fromNick, hasVideo });
    NativeModules.LiviAppModule?.showIncomingCallSystemUI?.(callId, from, fromNick ?? '', hasVideo);
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

/** Android: PAUSE + transient media focus на время входящего/активного звонка. */
export { beginBackgroundMediaSuppression, pauseBackgroundMediaAfterCall } from './backgroundMediaSuppression';

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

/**
 * Может ли приложение вообще показать экран входящего.
 *
 * Путей два и они взаимозаменяемы: полноэкранное уведомление (систему поднимает экран сама)
 * и «поверх других приложений» (экран стартует напрямую). Достаточно любого — поэтому
 * спрашивать оба разрешения не нужно, и на Android ниже 14 не нужно спрашивать ничего:
 * там полноэкранные уведомления разрешены по умолчанию.
 */
export async function canShowIncomingCallScreen(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    const [fullScreen, overlay] = await Promise.all([
      canUseFullScreenIntent(),
      canDrawOverlays(),
    ]);
    return !!fullScreen || !!overlay;
  } catch {
    return true;
  }
}

/** Открыть настройку «Полноэкранные уведомления» (Android 14+) — самый короткий путь к показу входящего. */
export function openFullScreenIntentSettings(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.openFullScreenIntentSettings?.();
  } catch {}
}

/**
 * Входящий, который не удалось показать из-за настроек. Запись создаёт нативный сервис,
 * забирается один раз — по ней показываем напоминание после реально пропущенного звонка.
 */
export async function consumeIncomingCallDisplayFailure(): Promise<{ atMs: number; fromNick?: string } | null> {
  if (Platform.OS !== 'android') return null;
  try {
    const res = await NativeModules.LiviAppModule?.getAndClearIncomingCallDisplayFailure?.();
    if (!res || typeof res.atMs !== 'number' || res.atMs <= 0) return null;
    return { atMs: res.atMs, fromNick: typeof res.fromNick === 'string' ? res.fromNick : undefined };
  } catch {
    return null;
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
export function displayOutgoingCallImmediate(toUserId: string, toNick?: string, hasVideo = true): void {
  prefetchDirectCallIce('callKeep:outgoing-immediate');
  // Не делаем audio prewarm здесь: createLocalTracks на mic забирает audio focus и глушит
  // ringback LiviOutgoingCallService (MediaPlayer VOICE_COMMUNICATION). Prewarm — после accept в App.
  logger.info('[outgoing] displayOutgoingCallImmediate called', {
    toUserId,
    toNick: toNick ?? '',
    platform: Platform.OS,
    isSetup,
    isAndroidCallKeepReady,
  });
  if (Platform.OS !== 'android') {
    logger.info('[outgoing] skip: not Android');
    return;
  }
  if (!isSetup || !isAndroidCallKeepReady) {
    logger.warn('[outgoing] skip: нативный экран не показывается — CallKeep не готов', {
      isSetup,
      isAndroidCallKeepReady,
    });
    return;
  }
  resetOutgoingCloseDebounce();
  try {
    const LiviAppModule = NativeModules.LiviAppModule;
    if (LiviAppModule?.launchOutgoingCallActivityWithoutCallId) {
      logger.info('[outgoing] calling native launchOutgoingCallActivityWithoutCallId', { to: toUserId, hasVideo });
      LiviAppModule.launchOutgoingCallActivityWithoutCallId(toUserId, toNick ?? toUserId, hasVideo);
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
  if (!isSetup || !isAndroidCallKeepReady) return;
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
 *
 * @deprecated На Android предпочитайте {@link presentIncomingCall} — без второго UI CallKeep.
 */
export function displayIncomingCall(callId: string, fromUserId: string, fromNick?: string, hasVideo = false, callKitId?: string): void {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return;
  if (!isSetup || (Platform.OS === 'android' && !isAndroidCallKeepReady)) {
    logger.warn('[callKeep] displayIncomingCall skipped (CallKeep not ready)', {
      callId,
      isSetup,
      isAndroidCallKeepReady,
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
    rememberPendingCall({ callId, from: fromUserId, fromNick, callKitId, hasVideo });
    const RNCallKeep = require('react-native-callkeep');
    const nativeCallId = Platform.OS === 'ios' ? resolveCallKeepUuid(callKitId || callId) : callId;
    if (Platform.OS === 'ios') {
      RNCallKeep.default.displayIncomingCall(nativeCallId, fromUserId, fromNick ?? '', 'generic', hasVideo, {
        ios: { supportsHolding: false, supportsDTMF: false, supportsGrouping: false, supportsUngrouping: false },
      });
      setIncomingCallScreenVisible(true, fromUserId);
      logger.info('[callKeep] displayIncomingCall', { callId, from: fromUserId });
      return;
    }
    // Android: см. canCreateAndroidTelecomConnection — без READ_PHONE_NUMBERS краш на Samsung.
    void (async () => {
      const canConnect = await canCreateAndroidTelecomConnection();
      if (!canConnect) {
        logger.info('[callKeep] displayIncomingCall skipped (no READ_PHONE_NUMBERS)', { callId });
        setIncomingCallScreenVisible(true, fromUserId);
        return;
      }
      try {
        RNCallKeep.default.displayIncomingCall(nativeCallId, fromUserId, fromNick ?? '', hasVideo);
        callKeepConnectionRequestedIds.add(String(callId).trim());
        setIncomingCallScreenVisible(true, fromUserId);
        logger.info('[callKeep] displayIncomingCall', { callId, from: fromUserId });
      } catch (e) {
        logger.warn('[callKeep] displayIncomingCall failed', e as Error);
      }
    })();
  } catch (e) {
    logger.warn('[callKeep] displayIncomingCall failed', e as Error);
  }
}

export type PresentIncomingCallOptions = {
  callId: string;
  from: string;
  fromNick?: string;
  hasVideo?: boolean;
  callKitId?: string;
  /** Проверить ended на нативе перед показом. */
  checkEnded?: boolean;
  /**
   * Android: форсировать system UI (background / headless), даже если AppState ещё 'active'.
   */
  forceBackgroundUi?: boolean;
  source?: string;
};

export type PresentIncomingCallResult = 'shown' | 'skipped' | 'ended';

/**
 * Пункт 2: один путь показа входящего.
 *
 * Android: IncomingCallActivity (foreground) или showIncomingCallSystemUI (background).
 * Telecom Connection создаём через {@link registerIncomingCallKeepSession} → CallKeep.displayIncomingCall
 * (selfManaged: без системного dialer UI; нужен для setCurrentCallActive/endCall).
 *
 * iOS: CallKeep displayIncomingCall.
 */
export async function presentIncomingCall(
  opts: PresentIncomingCallOptions,
): Promise<PresentIncomingCallResult> {
  const callId = String(opts.callId || '').trim();
  const from = String(opts.from || '').trim();
  if (!callId || !from) return 'skipped';

  if (opts.checkEnded && (await isEndedCallId(callId))) {
    logger.info('[presentIncomingCall] skipped (ended)', { callId, source: opts.source || null });
    return 'ended';
  }

  const now = Date.now();
  if (lastDisplayedCallId.id === callId && now - lastDisplayedCallId.at < DISPLAY_DEBOUNCE_MS) {
    logger.debug('[presentIncomingCall] skipped (duplicate)', {
      callId,
      source: opts.source || null,
    });
    return 'skipped';
  }

  const hasVideo = opts.hasVideo === true;

  if (Platform.OS === 'ios') {
    displayIncomingCall(callId, from, opts.fromNick, hasVideo, opts.callKitId);
    return 'shown';
  }

  if (Platform.OS !== 'android') return 'skipped';

  const appState = AppState.currentState;
  const useSystemUi =
    opts.forceBackgroundUi === true || !!(appState && appState !== 'active');

  if (useSystemUi) {
    lastDisplayedCallId.id = callId;
    lastDisplayedCallId.at = now;
    showIncomingCallSystemUI(callId, from, opts.fromNick, hasVideo);
  } else {
    // launchIncomingCallActivityScreen сам ставит lastDisplayed + дедуп.
    await launchIncomingCallActivityScreen(callId, from, opts.fromNick, false, hasVideo);
  }

  try {
    registerIncomingCallKeepSession(callId, from, {
      fromNick: opts.fromNick,
      hasVideo,
    });
  } catch {}

  logger.info('[presentIncomingCall]', {
    callId,
    from,
    via: useSystemUi ? 'system_ui' : 'activity',
    source: opts.source || null,
    appState,
  });
  return 'shown';
}

/** Данные входящего по callId (для навигации при answer из нативного UI). */
export function getPendingCallInfo(callId: string): { from: string; fromNick?: string; callKitId?: string; hasVideo?: boolean } | undefined {
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
  activeCallKeepCallIds.delete(rawCallId);
}

/**
 * Зарегистрировать входящий в CallKeep/Telecom.
 * UI уже показан через IncomingCallActivity / system UI — здесь только Connection:
 * без displayIncomingCall setCurrentCallActive/endCall дают "no connection found".
 * selfManaged=true → системный dialer не рисуется поверх нашего Activity.
 *
 * Android без READ_PHONE_NUMBERS: не вызываем displayIncomingCall (crash SecurityException
 * в VoiceConnectionService на Samsung) — UI остаётся на IncomingCallActivity.
 */
export function registerIncomingCallKeepSession(
  callId: string,
  fromUserId: string,
  opts?: { fromNick?: string; hasVideo?: boolean },
): void {
  if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !isSetup) return;
  if (Platform.OS === 'android' && !isAndroidCallKeepReady) return;
  const raw = String(callId || '').trim();
  const from = String(fromUserId || '').trim();
  if (!raw || !from) return;

  if (Platform.OS !== 'android') {
    rememberPendingCall({
      callId: raw,
      from,
      fromNick: opts?.fromNick,
      hasVideo: opts?.hasVideo === true,
    });
    return;
  }

  void (async () => {
    const canConnect = await canCreateAndroidTelecomConnection();
    if (!canConnect) {
      // Только метаданные для answer-навигации — без activeCallKeep / Connection.
      pendingCallById[raw] = {
        from,
        fromNick: opts?.fromNick,
        hasVideo: opts?.hasVideo === true,
      };
      setCallMediaHint(raw, opts?.hasVideo === true ? 'video' : 'audio');
      logger.info('[callKeep] registerIncomingCallKeepSession skip displayIncomingCall', {
        callId: raw,
        reason: 'no_READ_PHONE_NUMBERS',
      });
      return;
    }

    rememberPendingCall({
      callId: raw,
      from,
      fromNick: opts?.fromNick,
      hasVideo: opts?.hasVideo === true,
    });
    try {
      const RNCallKeep = require('react-native-callkeep');
      const nativeCallId = resolveCallKeepUuid(raw);
      if (!callKeepConnectionRequestedIds.has(raw)) {
        callKeepConnectionRequestedIds.add(raw);
        RNCallKeep.default.displayIncomingCall(
          nativeCallId,
          from,
          opts?.fromNick ?? from,
          opts?.hasVideo === true,
        );
        logger.info('[callKeep] registerIncomingCallKeepSession displayIncomingCall', {
          callId: raw,
          from,
        });
      } else {
        logger.debug('[callKeep] registerIncomingCallKeepSession connection already requested', {
          callId: raw,
        });
      }
    } catch (e) {
      callKeepConnectionRequestedIds.delete(raw);
      logger.warn('[callKeep] registerIncomingCallKeepSession failed', e as Error);
    }
  })();
}

/**
 * Сообщить CallKeep, что пользователь принял звонок (вызывать после перехода на VideoCall и acceptCall).
 */
export function reportAnswerIncomingCall(callId: string): void {
  if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !isSetup) return;
  if (Platform.OS === 'android' && !isAndroidCallKeepReady) return;
  const raw = resolveRawCallId(callId);
  const nativeCallId = resolveCallKeepUuid(callId);
  if (!raw || !nativeCallId) return;

  void (async () => {
    if (Platform.OS === 'android') {
      const canConnect = await canCreateAndroidTelecomConnection();
      if (!canConnect) {
        logger.debug('[callKeep] reportAnswerIncomingCall skip (no Telecom Connection)', {
          callId: raw,
        });
        clearPendingCall(callId);
        return;
      }
      if (!callKeepConnectionRequestedIds.has(raw)) {
        const info = pendingCallById[raw];
        if (info?.from) {
          registerIncomingCallKeepSession(raw, info.from, {
            fromNick: info.fromNick,
            hasVideo: info.hasVideo === true,
          });
          await new Promise((r) => setTimeout(r, 80));
        }
      }
    }
    activeCallKeepCallIds.add(raw);
    runWithCallKeepConnectionRetry('answerIncomingCall', nativeCallId, (RNCallKeep) => {
      RNCallKeep.default.answerIncomingCall(nativeCallId);
      if (Platform.OS === 'android') {
        RNCallKeep.default.setCurrentCallActive?.(nativeCallId);
      }
    });
    clearPendingCall(callId);
    activeCallKeepCallIds.add(raw);
  })();
}

/**
 * Сообщить CallKeep, что пользователь отклонил звонок.
 */
export function reportRejectCall(callId: string): void {
  if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !isSetup) return;
  const endCheck = canEndCallKeepCall(callId);
  if (!endCheck.ok) {
    logger.debug('[callKeep] rejectCall skipped (not active or duplicate)', { callId: endCheck.callId || callId });
    return;
  }
  try {
    const RNCallKeep = require('react-native-callkeep');
    const uuid = resolveCallKeepUuid(endCheck.callId);
    runWithCallKeepConnectionRetry('rejectCall', uuid, (RN) => {
      RN.default.rejectCall(uuid);
    });
    markCallKeepEnded(endCheck.callId);
  } catch (e) {
    markCallKeepEnded(endCheck.callId);
    logger.warn('[callKeep] rejectCall failed', e as Error);
  }
}

/**
 * Сообщить CallKeep, что звонок завершён (положили трубку, таймаут и т.д.).
 * Обязательно вызывать при завершении звонка, иначе следующий звонок может не идти.
 *
 * @param opts.force — вызвать endCall даже если callId не в active/requested set
 *   (финал из VideoCallSession / remote ended; идемпотентно через CALLKEEP_END_DEDUP_MS).
 */
export function reportEndCallToCallKeep(
  callId: string | null,
  opts?: { force?: boolean },
): void {
  if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !isSetup || !callId) return;
  const raw = resolveRawCallId(callId) || String(callId || '').trim();
  if (!raw) return;

  const endCheck = canEndCallKeepCall(raw);
  const hadConnectionRequest = callKeepConnectionRequestedIds.has(raw);
  const recentlyEnded =
    (recentCallKeepEndAtByCallId[raw] || 0) > 0 &&
    Date.now() - (recentCallKeepEndAtByCallId[raw] || 0) < CALLKEEP_END_DEDUP_MS;

  // Dedupe всегда (в т.ч. force): иначе double endCall → "no connection found" в logcat.
  if (recentlyEnded) {
    logger.debug('[callKeep] endCall skipped (recent dedupe)', { callId: raw });
    return;
  }
  if (!endCheck.ok && !hadConnectionRequest && !opts?.force) {
    logger.debug('[callKeep] endCall skipped (not active or duplicate)', { callId: raw });
    return;
  }

  const id = endCheck.callId || raw;
  try {
    const uuid = resolveCallKeepUuid(id);
    // Race: Connection ещё не в map — ретраи; force чистит JS-состояние даже без active set.
    runWithCallKeepConnectionRetry('endCall', uuid, (RNCallKeep) => {
      RNCallKeep.default.endCall(uuid);
    });
    markCallKeepEnded(id);
    try {
      setCallKeepAvailable(true);
    } catch {}
    logger.debug('[callKeep] endCall reported', { callId: id, force: !!opts?.force });
  } catch (e) {
    markCallKeepEnded(id);
    try {
      setCallKeepAvailable(true);
    } catch {}
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
let callKeepEventsUnsub: (() => void) | null = null;

export function registerCallKeepEvents(callbacks: CallKeepEventCallbacks): () => void {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return () => {};
  try {
    if (callKeepEventsUnsub) {
      try { callKeepEventsUnsub(); } catch {}
      callKeepEventsUnsub = null;
    }
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
      if (callUUID) {
        markCallKeepEnded(callUUID);
        callbacks.onEnd(resolveRawCallId(callUUID));
      }
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
    const unsub = () => {
      try {
        RNCallKeep.default.removeEventListener?.('answerCall', onAnswer);
        RNCallKeep.default.removeEventListener?.('endCall', onEnd);
        RNCallKeep.default.removeEventListener?.('didDisplayIncomingCall', onDisplay);
      } catch {}
      if (callKeepEventsUnsub === unsub) callKeepEventsUnsub = null;
    };
    callKeepEventsUnsub = unsub;
    return unsub;
  } catch (e) {
    logger.warn('[callKeep] registerCallKeepEvents failed', e as Error);
    return () => {};
  }
}
