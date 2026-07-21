import { AppState, NativeModules, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { CommonActions } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  API_BASE,
  SOCKET_CONNECT_WAIT_MS,
  setOutgoingCallScreenVisible,
  setIncomingCallScreenVisible,
  setActiveVideoCall,
  declineCall,
  ensureSocketConnected,
  warmCallSignaling,
  getUnreadCount,
  beginEarlyIncomingCallAccept,
} from '../sockets/socket';
import { getInstallId } from './installId';
import { logger } from './logger';
import { trackReleaseError, trackReleaseEvent } from './telemetry';
import { stopIncomingCallAlert } from './incomingCallAlert';
import { displayIncomingCall, isCallKeepAvailable, sendCallAnsweredBroadcast, addEndedCallId, closeOutgoingCallActivity, notifyCallCanceled, isEndedCallId, isOutgoingDeclineHandled, markOutgoingDeclineHandled, stopIncomingCallRingtoneAndVibration, setCallMediaHint, getCallMediaHint, videoCallNavExtras, type DirectCallMediaHint } from './callKeep';
import { emitCloseOutgoingCall, emitCloseHomeModals, emitMissedClear, emitMissedIncrement } from './globalEvents';
import { navigateToVideoCallScreen, type VideoCallNavLike } from './appNavigationGuard';
import { recordAppliedFromPending } from '../sockets/socket';
import { loadLang, t } from './i18n';
import { isIncomingCallExpired } from './callExpiry';
import { getVoipPushToken } from './voipPush';
import {
  disposeDirectCallAudioPrewarm,
  prefetchDirectCallIce,
  prewarmDirectCallAudioCapture,
} from './directCallConnectPrewarm';

const MISSED_CALLS_KEY = 'missed_calls_by_user_v1';
/** Флаг: пользователь заходил во вкладку «Друзья» и «увидел» пропущенные — бейдж и уведомления в шторке скрываем, счётчики в приложении не трогаем. */
const MISSED_BADGE_CLEARED_KEY = 'missed_calls_badge_cleared_v1';
const MISSED_CALL_APPLIED_ID_PREFIX = 'missed_call_applied_v1:';
const PUSH_TOKEN_SNAPSHOT_KEY = 'push_token_snapshot_v1';

/** ID категории уведомления входящего звонка с кнопками «Поднять» / «Положить» */
export const INCOMING_CALL_CATEGORY_ID = 'incoming_call';
const PUSH_TOKEN_REGISTER_COOLDOWN_MS = 60_000;

let syncBadgeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let syncBadgeWaiters: Array<() => void> = [];
const SYNC_BADGE_DEBOUNCE_MS = 160;
let syncBadgeInFlight = false;
let syncBadgeRunAgain = false;
type BadgeSnapshot = { total: number; missed: number; unread: number; legacyCleared: boolean };
let lastAppliedBadge: BadgeSnapshot | null = null;

function shouldApplyBadgeToOs(missedTotal: number, unreadTotal: number, total: number, legacyCleared: boolean): boolean {
  const snap: BadgeSnapshot = { total, missed: missedTotal, unread: unreadTotal, legacyCleared };
  if (
    lastAppliedBadge &&
    lastAppliedBadge.total === snap.total &&
    lastAppliedBadge.missed === snap.missed &&
    lastAppliedBadge.unread === snap.unread &&
    lastAppliedBadge.legacyCleared === snap.legacyCleared
  ) {
    return false;
  }
  lastAppliedBadge = snap;
  return true;
}

/** Обновить shade на Android только для изменившихся частей бейджа (не дергать missed при смене unread). */
function applyAndroidShadeSummariesIfNeeded(
  prev: BadgeSnapshot | null,
  missedTotal: number,
  unreadTotal: number,
  missedByUser: Record<string, number>,
  nativeMissed: Record<string, number>,
): void {
  if (Platform.OS !== 'android') return;
  const mod = NativeModules.LiviAppModule;
  if (!mod) return;
  const missedChanged = !prev || prev.missed !== missedTotal;
  const unreadChanged = !prev || prev.unread !== unreadTotal;
  let refreshMissed = missedChanged;
  if (refreshMissed && missedTotal > 0) {
    refreshMissed = !nativeMissedCountsMatchJs(missedByUser, nativeMissed, missedTotal);
  }
  if (refreshMissed && mod.updateMissedSummaryInShade) {
    try { mod.updateMissedSummaryInShade(missedTotal); } catch (_) {}
  }
  if (unreadChanged && mod.updateUnreadSummaryInShade) {
    try { mod.updateUnreadSummaryInShade(unreadTotal); } catch (_) {}
  } else if (unreadChanged && mod.updateSummaryNotifications) {
    try { mod.updateSummaryNotifications(0, unreadTotal); } catch (_) {}
  }
}

function nativeMissedCountsMatchJs(
  map: Record<string, number>,
  native: Record<string, number>,
  missedTotal: number,
): boolean {
  let jsSum = 0;
  const keys = new Set<string>();
  for (const [uid, n] of Object.entries(map)) {
    if (typeof n === 'number' && n > 0) {
      keys.add(uid);
      jsSum += n;
    }
  }
  for (const uid of Object.keys(native)) {
    if (typeof native[uid] === 'number' && native[uid]! > 0) keys.add(uid);
  }
  if (jsSum !== missedTotal) return false;
  let nativeSum = 0;
  for (const uid of keys) {
    const jsN = typeof map[uid] === 'number' && map[uid]! > 0 ? map[uid]! : 0;
    const natN = typeof native[uid] === 'number' && native[uid]! > 0 ? native[uid]! : 0;
    if (jsN !== natN) return false;
    nativeSum += natN;
  }
  return nativeSum === missedTotal;
}

async function readNativeMissedCountsWithRetry(): Promise<Record<string, number>> {
  if (Platform.OS !== 'android') return {};
  let nativeMissed: Record<string, number> = {};
  try {
    nativeMissed = await getMissedCountByUserFromNative();
  } catch (_) {}
  const sum = Object.values(nativeMissed).reduce(
    (s, n) => s + (typeof n === 'number' && n > 0 ? n : 0),
    0,
  );
  if (sum === 0) {
    await new Promise((r) => setTimeout(r, 48));
    try {
      nativeMissed = await getMissedCountByUserFromNative();
    } catch (_) {}
  }
  return nativeMissed;
}

/** Дедуп: setNotificationHandler и addNotificationReceivedListener оба получают один Expo-пуш. */
const missedNativeAndroidShownAt = new Map<string, number>();
const MISSED_NATIVE_ANDROID_DEDUP_MS = 30_000;

/** Android: нативное уведомление «пропущенный» (Expo fallback / foreground). FCM data-only обрабатывает LiviFirebaseMessagingService. */
function notifyMissedCallNativeAndroid(callId: string, fromUserId: string, fromNick?: string): void {
  if (Platform.OS !== 'android' || !callId) return;
  const now = Date.now();
  const prev = missedNativeAndroidShownAt.get(callId);
  if (prev != null && now - prev < MISSED_NATIVE_ANDROID_DEDUP_MS) {
    logger.info('[push] notifyMissedCallNativeAndroid skipped (duplicate JS path)', { callId });
    return;
  }
  missedNativeAndroidShownAt.set(callId, now);
  try {
    NativeModules.LiviAppModule?.showMissedCallNotification?.(callId, fromUserId || '', fromNick ?? '');
  } catch (e) {
    logger.warn('[push] showMissedCallNotification native failed', e as any);
  }
}

type PushTokenSnapshot = {
  userId: string;
  expoToken: string;
  fcmToken: string;
  atMs: number;
};

type RegisterPushTokenOptions = {
  force?: boolean;
  reason?: 'startup' | 'app_active' | 'socket_reconnect' | 'manual' | 'ios_voip_token';
};

let lastRegisteredPushToken: PushTokenSnapshot | null = null;
let registerPushInFlight: Promise<void> | null = null;
let lastRegisteredPushTokenLoaded = false;
/** Один startup-register за жизнь JS-контекста (dev reload / двойной mount не шлёт два «token registered»). */
let pushStartupRegisterDone = false;

async function loadPersistedPushTokenSnapshot(): Promise<void> {
  if (lastRegisteredPushTokenLoaded) return;
  lastRegisteredPushTokenLoaded = true;
  try {
    const raw = await AsyncStorage.getItem(PUSH_TOKEN_SNAPSHOT_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw || '{}') as Partial<PushTokenSnapshot>;
    if (!parsed || typeof parsed !== 'object') return;
    const userId = String(parsed.userId || '').trim();
    const expoToken = String(parsed.expoToken || '').trim();
    if (!userId || !expoToken) return;
    lastRegisteredPushToken = {
      userId,
      expoToken,
      fcmToken: String(parsed.fcmToken || ''),
      atMs: Number(parsed.atMs || 0) || 0,
    };
  } catch {}
}

async function persistPushTokenSnapshot(snapshot: PushTokenSnapshot): Promise<void> {
  try {
    await AsyncStorage.setItem(PUSH_TOKEN_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {}
}

function ensureInAppPiPBeforeOpeningFriendsFromMessageNotification(): void {
  try {
    const g = global as any;
    if (g.__pipVisibleRef?.current === true || g.__pipInSystemModeRef?.current === true) return;

    const session = g.__webrtcSessionRef?.current;
    const sessionEnded = !!session && typeof session.isEnded === 'function' && session.isEnded();
    if (sessionEnded) return;

    const params = g.__currentCallPiPParamsRef?.current;
    const callIdFromSession =
      !!session && typeof session.getCallId === 'function'
        ? session.getCallId()
        : null;
    const roomIdFromSession =
      !!session && typeof session.getRoomId === 'function'
        ? session.getRoomId()
        : null;
    const callId = String(params?.callId || callIdFromSession || '').trim();
    const roomId = String(params?.roomId || roomIdFromSession || '').trim();
    if (!callId || !roomId) return;

    const showPiP = g.__pipShowPiPRef?.current;
    if (typeof showPiP !== 'function') return;

    const remoteStream =
      params?.remoteStream ??
      (!!session && typeof session.getRemoteStream === 'function' ? session.getRemoteStream() : null);
    const localStream =
      params?.localStream ??
      (!!session && typeof session.getLocalStream === 'function' ? session.getLocalStream() : null);
    const remoteCamOn =
      typeof params?.remoteCamOn === 'boolean'
        ? params.remoteCamOn
        : (!!session && typeof session.getRemoteCamEnabled === 'function' ? session.getRemoteCamEnabled() : undefined);
    const localCamOn =
      typeof params?.localCamOn === 'boolean'
        ? params.localCamOn
        : (!!session && typeof session.getLocalCamEnabled === 'function' ? session.getLocalCamEnabled() : undefined);

    showPiP({
      callId,
      roomId,
      partnerName: params?.partnerName,
      partnerAvatarUrl: params?.partnerAvatarUrl,
      localStream: localStream ?? null,
      remoteStream: remoteStream ?? null,
      muteLocal: params?.muteLocal,
      muteRemote: params?.muteRemote,
      localCamOn,
      remoteCamOn,
      navParams: params?.navParams,
      deferVisible: false,
    });

    if (Platform.OS === 'android') {
      try { NativeModules.LiviAppModule?.setPiPEndCallParams?.(callId, roomId); } catch {}
    }
    try {
      if (session && typeof session.enterPiP === 'function') session.enterPiP();
    } catch {}
  } catch (e) {
    logger.warn('[push] ensureInAppPiPBeforeOpeningFriendsFromMessageNotification failed', e as any);
  }
}

/** Отметить, что пользователь «увидел» пропущенные (зашёл во вкладку Друзья) — бейдж и шторка будут скрыты. */
export async function setMissedBadgeCleared(): Promise<void> {
  try {
    await AsyncStorage.setItem(MISSED_BADGE_CLEARED_KEY, 'true');
  } catch {}
}

let applyMissedViewInFlight: Promise<void> | null = null;

/**
 * Пользователь открыл «Друзья» / тап по пропущенному: один атомарный проход — флаг «увидел»,
 * снять карточки в шторке, обнулить нативный счётчик пропущенных, синхронизировать бейдж (unread без missed).
 */
export async function applyMissedCallsViewedByUser(reason?: string): Promise<void> {
  if (applyMissedViewInFlight) return applyMissedViewInFlight;
  applyMissedViewInFlight = (async () => {
    logger.info('[push] applyMissedCallsViewedByUser', { reason: reason || 'friends' });
    if (syncBadgeDebounceTimer) {
      clearTimeout(syncBadgeDebounceTimer);
      syncBadgeDebounceTimer = null;
    }
    lastAppliedBadge = null;
    await setMissedBadgeCleared();
    await dismissMissedCallNotificationsOnly();
    try {
      const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
      const map: Record<string, number> = raw ? JSON.parse(raw) : {};
      for (const uid of Object.keys(map || {})) {
        if (uid && typeof map[uid] === 'number' && map[uid] > 0) {
          try { emitMissedClear(String(uid)); } catch (_) {}
        }
      }
      await AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify({}));
    } catch (_) {}
    if (Platform.OS === 'android' && NativeModules.LiviAppModule?.clearAllMissedCountsAndSetBadgeZero) {
      try {
        NativeModules.LiviAppModule.clearAllMissedCountsAndSetBadgeZero();
      } catch (_) {}
      try {
        await (NativeModules.LiviAppModule.getAndClearPendingMissedCalls?.() ?? Promise.resolve([]));
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 64));
    }
    await syncAppBadgeFromMissedCountNow();
    const waiters = syncBadgeWaiters.splice(0);
    waiters.forEach((w) => w());
  })().finally(() => {
    applyMissedViewInFlight = null;
  });
  return applyMissedViewInFlight;
}

async function fetchUnreadTotalForBadge(): Promise<number> {
  try {
    let unreadResult = await getUnreadCount();
    if (!unreadResult?.ok) {
      await new Promise((r) => setTimeout(r, 400));
      unreadResult = await getUnreadCount();
    }
    if (unreadResult?.ok) return Math.max(0, Number(unreadResult.count || 0));
  } catch (e) {
    logger.debug('[push] fetchUnreadTotalForBadge: offline or error', (e as Error)?.message);
  }
  return 0;
}

/** Сбросить флаг «увидел» при новом пропущенном — бейдж и шторка снова показываются. */
export async function clearMissedBadgeCleared(): Promise<void> {
  try {
    await AsyncStorage.removeItem(MISSED_BADGE_CLEARED_KEY);
  } catch {}
}

async function wasMissedCallIdApplied(callId: string): Promise<boolean> {
  if (!callId) return false;
  try {
    return (await AsyncStorage.getItem(MISSED_CALL_APPLIED_ID_PREFIX + callId)) === '1';
  } catch {
    return false;
  }
}

async function markMissedCallIdApplied(callId: string): Promise<void> {
  if (!callId) return;
  try {
    await AsyncStorage.setItem(MISSED_CALL_APPLIED_ID_PREFIX + callId, '1');
  } catch {}
}

/**
 * Один пропущенный звонок = +1 (не дублируем FCM native + socket/pending).
 * На Android FCM уже увеличивает нативный счётчик — JS подтягивает max(storage, native).
 */
export async function recordMissedCallForUser(
  userId: string,
  options?: { callId?: string; source?: string },
): Promise<boolean> {
  const uid = String(userId || '').trim();
  const callId = String(options?.callId || '').trim();
  const source = options?.source || 'unknown';
  if (!uid) return false;

  if (callId && (await wasMissedCallIdApplied(callId))) {
    logger.info('[push] recordMissedCallForUser skip (callId dup)', { callId, uid, source });
    return false;
  }

  const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
  const map: Record<string, number> = raw ? JSON.parse(raw) : {};
  const storageN = typeof map[uid] === 'number' ? map[uid] : 0;

  let nativeN = 0;
  if (Platform.OS === 'android') {
    try {
      const native = await getMissedCountByUserFromNative();
      nativeN = typeof native[uid] === 'number' ? native[uid] : 0;
    } catch (_) {}
  }

  let nativeAlreadyForCallId = false;
  if (callId && Platform.OS === 'android') {
    try {
      nativeAlreadyForCallId = !!(await NativeModules.LiviAppModule?.wasMissedShownForCallId?.(callId));
    } catch (_) {}
  }

  let next: number;
  if (nativeAlreadyForCallId) {
    next = Math.max(storageN, nativeN);
  } else if (nativeN > storageN) {
    next = nativeN;
  } else {
    next = storageN + 1;
    if (Platform.OS === 'android') {
      try { NativeModules.LiviAppModule?.syncMissedCountForUser?.(uid, next); } catch (_) {}
    }
  }

  if (next <= storageN && nativeN <= storageN) {
    if (callId) await markMissedCallIdApplied(callId);
    if (Platform.OS === 'android' && nativeAlreadyForCallId) {
      try { NativeModules.LiviAppModule?.removePendingMissedCall?.(uid); } catch (_) {}
      // Shade/badge уже обновлены в notifyMissedCallFromPush — sync снова дергает refresh и даёт лишний heads-up.
    }
    return false;
  }

  map[uid] = next;
  await AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(map));
  if (callId) await markMissedCallIdApplied(callId);
  if (Platform.OS === 'android') {
    try { NativeModules.LiviAppModule?.removePendingMissedCall?.(uid); } catch (_) {}
  }
  await clearMissedBadgeCleared();
  emitMissedIncrement(uid, next);
  logger.info('[push] recordMissedCallForUser', { uid, next, callId, source, storageN, nativeN, nativeAlreadyForCallId });
  if (!(Platform.OS === 'android' && nativeAlreadyForCallId)) {
    await syncAppBadgeFromMissedCount();
  }
  return true;
}

/** FCM уже учёл пропущенный в native — подтянуть в AsyncStorage/UI без +1 за каждый элемент pending. */
export async function applyPendingMissedCallsFromNative(pendingUserIds: string[]): Promise<void> {
  if (!pendingUserIds?.length) return;
  const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
  const map: Record<string, number> = raw ? JSON.parse(raw) : {};
  let native: Record<string, number> = {};
  if (Platform.OS === 'android') {
    try {
      native = await getMissedCountByUserFromNative();
    } catch (_) {}
  }
  let changed = false;
  for (const u of pendingUserIds) {
    const uid = String(u || '').trim();
    if (!uid) continue;
    const prev = typeof map[uid] === 'number' ? map[uid] : 0;
    const target = Math.max(prev, typeof native[uid] === 'number' ? native[uid] : 0);
    if (target > prev) {
      map[uid] = target;
      changed = true;
      emitMissedIncrement(uid, target);
    }
    try { recordAppliedFromPending(uid); } catch (_) {}
  }
  if (changed) {
    await AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(map));
    await clearMissedBadgeCleared();
    await syncAppBadgeFromMissedCount();
  }
}

/** На Android: счётчики пропущенных из нативного хранилища (источник истины при FCM). На iOS — пустой объект. */
export async function getMissedCountByUserFromNative(): Promise<Record<string, number>> {
  try {
    if (Platform.OS !== 'android') return {};
    if (!NativeModules.LiviAppModule?.getMissedCountByUserJson) {
      if (__DEV__) console.warn('[push] getMissedCountByUserJson not available on LiviAppModule — rebuild Android app (npm run android:install-all)');
      return {};
    }
    const json = await NativeModules.LiviAppModule.getMissedCountByUserJson();
    if (typeof json !== 'string') return {};
    const parsed = JSON.parse(json || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const key of Object.keys(parsed)) {
      const v = parsed[key];
      if (typeof v === 'number' && v > 0) out[String(key)] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Формат времени для уведомления о сообщении: «14:35», «вчера 14:35» или «12.03 14:35». Используем getFullYear (не getYear), чтобы не было багов с годом. */
function formatMessageNotificationTime(d: Date): string {
  const now = new Date();
  const today = now.getDate() === d.getDate() && now.getMonth() === d.getMonth() && now.getFullYear() === d.getFullYear();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const wasYesterday = yesterday.getDate() === d.getDate() && yesterday.getMonth() === d.getMonth() && yesterday.getFullYear() === d.getFullYear();
  const h = d.getHours().toString().padStart(2, '0');
  const min = d.getMinutes().toString().padStart(2, '0');
  const time = `${h}:${min}`;
  if (today) return time;
  if (wasYesterday) return `вчера ${time}`;
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${day}.${month} ${time}`;
}

/** Снять уведомление о сообщениях от одного пользователя (при заходе в чат с ним). */
export async function dismissMessageNotificationForUser(peerId: string): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      if (NativeModules.LiviAppModule?.dismissMessageNotificationForUser && peerId) {
        NativeModules.LiviAppModule.dismissMessageNotificationForUser(peerId);
      }
      return;
    }
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const n of presented || []) {
      const data = (n?.request?.content?.data as Record<string, unknown>) || {};
      const type = data?.type;
      const from = String(data?.from ?? data?.fromUserId ?? '').trim();
      if (type === 'message' && from === peerId && n?.request?.identifier) {
        try {
          await Notifications.dismissNotificationAsync(n.request.identifier);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

/** Снять только уведомления о сообщениях в шторке (при заходе во вкладку Друзья). */
export async function dismissMessageNotificationsOnly(): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      if (NativeModules.LiviAppModule?.dismissAllMessageNotifications) {
        NativeModules.LiviAppModule.dismissAllMessageNotifications();
      }
      return;
    }
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const n of presented || []) {
      const type = (n?.request?.content?.data as Record<string, unknown>)?.type;
      if (type === 'message' && n?.request?.identifier) {
        try {
          await Notifications.dismissNotificationAsync(n.request.identifier);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

/** Снять только уведомления «пропущенный вызов» в шторке (без обнуления счётчиков). Вызывать при заходе в Друзья. Android: нативный список; iOS: Expo getPresentedNotificationsAsync + dismiss по type === 'missed_call'. */
export async function dismissMissedCallNotificationsOnly(): Promise<void> {
  try {
    logger.info('[push] dismissMissedCallNotificationsOnly');
    if (Platform.OS === 'android') {
      if (NativeModules.LiviAppModule?.dismissAllMissedCallNotifications) {
        NativeModules.LiviAppModule.dismissAllMissedCallNotifications();
      }
      if (NativeModules.LiviAppModule?.dismissMissedCallNotificationOnly) {
        const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
        const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
        for (const uid of Object.keys(map || {})) {
          if (uid && typeof map[uid] === 'number' && map[uid] > 0) {
            try { NativeModules.LiviAppModule.dismissMissedCallNotificationOnly(String(uid)); } catch (_) {}
          }
        }
      }
      return;
    }
    // iOS: снять только уведомления с data.type === 'missed_call' (Expo показывает их при call_ended)
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const n of presented || []) {
      const type = (n?.request?.content?.data as Record<string, unknown>)?.type;
      if (type === 'missed_call' && n?.request?.identifier) {
        try { await Notifications.dismissNotificationAsync(n.request.identifier); } catch (_) {}
      }
    }
  } catch (e) {
    trackReleaseError('notification_cancel_miss', e, {});
  }
}

/** Синхронизировать бейдж иконки: непрочитанные сообщения + пропущенные вызовы.
 * Если пользователь «увидел» (зашёл во вкладку Друзья) — бейдж = 0 (на иконке и в шторке ничего не показываем).
 * Иначе бейдж = пропущенные звонки + непрочитанные сообщения.
 */
async function syncAppBadgeFromMissedCountNow(): Promise<void> {
  try {
    const unreadTotal = await fetchUnreadTotalForBadge();
    const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
    const map: Record<string, number> = raw ? JSON.parse(raw) : {};
    let nativeMissed: Record<string, number> = {};
    if (Platform.OS === 'android') {
      try {
        nativeMissed = await readNativeMissedCountsWithRetry();
        for (const [uid, n] of Object.entries(nativeMissed)) {
          if (!uid) continue;
          const prev = typeof map[uid] === 'number' ? map[uid] : 0;
          if (n > 0 && prev > n) {
            map[uid] = n;
          } else {
            map[uid] = Math.max(prev, n);
          }
        }
      } catch (_) {}
    }
    let missedTotal = Object.values(map).reduce((s: number, n: unknown) => s + (typeof n === 'number' && n > 0 ? n : 0), 0);
    const mapJson = JSON.stringify(map);
    if (mapJson !== (raw || '{}')) {
      try {
        await AsyncStorage.setItem(MISSED_CALLS_KEY, mapJson);
      } catch (_) {}
    }

    let cleared = await AsyncStorage.getItem(MISSED_BADGE_CLEARED_KEY);
    if (cleared === 'true' && missedTotal > 0) {
      await clearMissedBadgeCleared();
      cleared = null;
    }
    if (cleared === 'true' && missedTotal === 0) {
      const total = Math.min(99, unreadTotal);
      const prevSnap = lastAppliedBadge;
      if (shouldApplyBadgeToOs(0, unreadTotal, total, true)) {
        logger.info('[push] syncAppBadgeFromMissedCount (legacy cleared, no missed)', { missedTotal: 0, unreadTotal, total });
        await Notifications.setBadgeCountAsync(total);
        applyAndroidShadeSummariesIfNeeded(prevSnap, 0, unreadTotal, map, nativeMissed);
      }
      return;
    }

    const total = Math.min(99, missedTotal + unreadTotal);
    const prevSnap = lastAppliedBadge;
    if (shouldApplyBadgeToOs(missedTotal, unreadTotal, total, false)) {
      logger.info('[push] syncAppBadgeFromMissedCount', { missedTotal, unreadTotal, total });
      await Notifications.setBadgeCountAsync(total);
      applyAndroidShadeSummariesIfNeeded(prevSnap, missedTotal, unreadTotal, map, nativeMissed);
    }
  } catch (e) {
    logger.warn('[push] syncAppBadgeFromMissedCount failed', e as any);
    lastAppliedBadge = null;
    try { await Notifications.setBadgeCountAsync(0); } catch {}
  }
}

async function runSyncBadgeCoalesced(): Promise<void> {
  if (syncBadgeInFlight) {
    syncBadgeRunAgain = true;
    return;
  }
  syncBadgeInFlight = true;
  try {
    do {
      syncBadgeRunAgain = false;
      await syncAppBadgeFromMissedCountNow();
    } while (syncBadgeRunAgain);
  } finally {
    syncBadgeInFlight = false;
  }
}

/** Сливаем параллельные вызовы (App + HomeScreen после emitMissedIncrement) в один проход. */
export function syncAppBadgeFromMissedCount(): Promise<void> {
  return new Promise((resolve) => {
    syncBadgeWaiters.push(resolve);
    if (syncBadgeDebounceTimer) clearTimeout(syncBadgeDebounceTimer);
    syncBadgeDebounceTimer = setTimeout(() => {
      syncBadgeDebounceTimer = null;
      const waiters = syncBadgeWaiters.splice(0);
      void runSyncBadgeCoalesced().finally(() => {
        waiters.forEach((w) => w());
      });
    }, SYNC_BADGE_DEBOUNCE_MS);
  });
}

async function dismissPresentedNotificationsByTypes(types: Set<string>): Promise<void> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const n of presented || []) {
      const type = String((n?.request?.content?.data as Record<string, unknown>)?.type || '').trim();
      if (!types.has(type)) continue;
      if (!n?.request?.identifier) continue;
      try {
        await Notifications.dismissNotificationAsync(n.request.identifier);
      } catch (_) {}
    }
  } catch (_) {}
}

/** Снимает только уведомления активного/входящего звонка. Пропущенные не трогаем — их снимают только после просмотра во «Друзья». */
async function dismissCallRelatedNotificationsOnly(): Promise<void> {
  if (Platform.OS === 'android') {
    try { NativeModules.LiviAppModule?.dismissIncomingCallNotificationOnly?.(); } catch {}
    return;
  }
  await dismissPresentedNotificationsByTypes(new Set(['call', 'call_canceled', 'call_declined', 'call_ended']));
}

/** Убрать уведомления из шторки и выставить бейдж по пропущенным (после отклонения/завершения звонка). */
export async function clearCallRelatedNotificationsAndSyncBadge(): Promise<void> {
  await dismissCallRelatedNotificationsOnly();
  await syncAppBadgeFromMissedCount();
}

export async function clearNotificationIndicators() {
  await dismissMessageNotificationsOnly();
  await dismissMissedCallNotificationsOnly();
  await syncAppBadgeFromMissedCount();
}

// Состояние приложения: для звонков показываем пуш только когда приложение в фоне/убито
let appStateRef = AppState.currentState;
AppState.addEventListener('change', (next) => {
  appStateRef = next;
});

/** Текущий peerId чата, если пользователь сейчас в экране переписки. Устанавливается ChatScreen при фокусе, сбрасывается при уходе. */
export function setCurrentChatPeerId(peerId: string | null): void {
  (global as any).__currentChatPeerId = peerId ?? null;
}

// КРИТИЧНО: Захватываем «последний ответ на уведомление» сразу при загрузке модуля,
// чтобы не потерять его к моменту вызова addNotificationListeners (когда приложение открыто из пуша о звонке).
const lastNotificationResponsePromise = Notifications.getLastNotificationResponseAsync();
export function getColdStartNotificationResponse(): Promise<Notifications.NotificationResponse | null> {
  return lastNotificationResponsePromise;
}

// Показывать уведомления даже в foreground (для сообщений).
// Для звонков: в активном приложении показываем модалку по сокету; в фоне/убитом — показываем пуш на телефоне.
Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const type = String((n as any)?.request?.content?.data?.type || '');
    // Таймаут или отмена: останавливаем вибрацию (снимаем уведомление), затем показываем «Пропущенный вызов» без вибрации.
    // На Android «Пропущенный вызов» показывается только из нативного кода (LiviFirebaseMessagingService), чтобы не было двух одинаковых уведомлений в шторке.
    if (type === 'call_ended') {
      const data = (n as any)?.request?.content?.data || {};
      const endedFromActive = !!data.endedFromActive;
      if (data?.callId) addEndedCallId(String(data.callId));
      try {
        stopIncomingCallAlert();
      } catch {}
      await dismissCallRelatedNotificationsOnly();
      // Android: «пропущенный» только из FCM (LiviFirebaseMessagingService), без дубля из Expo.
      if (Platform.OS !== 'android' && !endedFromActive) {
        const fromNick = String(data.fromNick || '').trim();
        const fromUserId = String(data.from || '');
        try {
          const lang = await loadLang();
          const title = t('missedCallTitle', lang);
          const body = fromNick
            ? t('incomingFromPrefix', lang).replace('{name}', fromNick)
            : t('incomingVideoCallBody', lang);
          await Notifications.scheduleNotificationAsync({
            content: {
              title,
              body,
              data: { type: 'missed_call', from: fromUserId, fromNick },
            },
            trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 0.2 },
          });
        } catch (e) {
          logger.warn('[push] failed to show missed_call notification', e as any);
        }
      }
      return {
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    if (type === 'call_declined') {
      const data = (n as any)?.request?.content?.data || {};
      const id = data?.callId ? String(data.callId) : '';
      logger.info('[decline/инициатор] push setNotificationHandler call_declined', { callId: id, alreadyHandled: id ? isOutgoingDeclineHandled(id) : false });
      if (id && isOutgoingDeclineHandled(id)) {
        logger.info('[decline/инициатор] push setNotificationHandler — уже обработан, выходим');
        return { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };
      }
      if (id) markOutgoingDeclineHandled(id);
      try { closeOutgoingCallActivity(id || null, { force: true }); } catch {}
      try { setOutgoingCallScreenVisible(false); } catch {}
      try { emitCloseOutgoingCall({ reason: 'remote_closed', callId: id || null }); } catch {}
      logger.info('[decline/инициатор] push setNotificationHandler: закрыли и emitCloseOutgoingCall');
      return {
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    if (type === 'call_canceled') {
      const data = (n as any)?.request?.content?.data || {};
      logger.info('[push] call_canceled received (handler)', { callId: data?.callId });
      if (data?.callId) {
        try { stopIncomingCallRingtoneAndVibration(); } catch {}
        try { setIncomingCallScreenVisible(false); } catch {}
        try { notifyCallCanceled(String(data.callId)); } catch {}
        try { addEndedCallId(String(data.callId)); } catch {}
        logger.info('[push] notifyCallCanceled + addEndedCallId called after call_canceled');
      }
      // Android: пропущенный при отмене — FCM call_canceled в Kotlin; notifyCallCanceled закрывает входящий.
      return {
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    if (type === 'call') {
      // На Android входящий звонок показываем только нативным экраном (FCM → IncomingCallActivity + одно уведомление в шторке от foreground-сервиса).
      // Expo-уведомление не показываем, иначе будет два уведомления об одном звонке.
      if (Platform.OS === 'android') {
        return {
          shouldShowBanner: false,
          shouldShowList: false,
          shouldPlaySound: false,
          shouldSetBadge: false,
        };
      }
      const showCallNotification = appStateRef !== 'active';
      return {
        shouldShowBanner: showCallNotification,
        shouldShowList: showCallNotification,
        shouldPlaySound: showCallNotification,
        shouldSetBadge: false,
      };
    }
    // Одно уведомление о сообщениях: сверху количество, снизу «От X в HH:MM». Не показывать стандартное Expo.
    if (type === 'message') {
      const data = (n as any)?.request?.content?.data || {};
      const fromId = String(data?.from || data?.fromUserId || '').trim();
      const currentPeer = (global as any).__currentChatPeerId;
      if (fromId && currentPeer && fromId === currentPeer) {
        return {
          shouldShowBanner: false,
          shouldShowList: false,
          shouldPlaySound: false,
          shouldSetBadge: false,
        };
      }
      // На Android одно уведомление о сообщении показывается из FCM (От кого HH:MM + превью). Сводное «Непрочитанные сообщения» не показываем.
      if (Platform.OS === 'android') {
        syncAppBadgeFromMissedCount().catch(() => {});
        return {
          shouldShowBanner: false,
          shouldShowList: false,
          shouldPlaySound: false,
          shouldSetBadge: false,
        };
      }
    }
    // Не показывать баннер для необработанных типов — иначе возможно пустое уведомление.
    return {
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
});

type ReadyNavigation = NonNullable<any>;
type PendingNavigation = {
  key: string;
  createdAtMs: number;
  run: (nav: ReadyNavigation) => void | Promise<void>;
};

const handledNotificationTaps = new Map<string, number>();
const pendingNavigations = new Map<string, PendingNavigation>();
let pendingNavigationDrainTimer: ReturnType<typeof setTimeout> | null = null;
let pendingNavigationDrainInFlight = false;
const NOTIFICATION_TAP_DEDUPE_MS = 10_000;
const PENDING_NAVIGATION_TTL_MS = 30_000;
/** Не повторять cold start navigation (Друзья) при обычном запуске с иконки — Expo хранит last notification response между сессиями. */
const PUSH_HANDLED_NOTIFICATION_RESPONSES_KEY = 'push_handled_notification_responses_v1';
const MAX_STORED_HANDLED_NOTIFICATION_RESPONSES = 80;

function getReadyNav(): ReadyNavigation | null {
  const nav = (global as any).__navRef;
  return nav?.isReady?.() ? nav : null;
}

async function waitForNavReady(ms = 1200) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const nav = getReadyNav();
    if (nav) return nav;
    await new Promise((r) => setTimeout(r, 80));
  }
  return getReadyNav();
}

function cleanupHandledNotificationTaps(now = Date.now()): void {
  for (const [key, at] of handledNotificationTaps) {
    if (now - at > NOTIFICATION_TAP_DEDUPE_MS) handledNotificationTaps.delete(key);
  }
}

function buildNotificationTapKey(data: any, actionIdentifier: string, responseIdentifier?: string): string {
  const type = String(data?.type || '').trim();
  const callId = String(data?.callId || '').trim();
  const messageId = String(data?.messageId || '').trim();
  const from = String(data?.from || data?.fromUserId || '').trim();
  const roomId = String(data?.roomId || '').trim();
  return [
    responseIdentifier ? `response:${responseIdentifier}` : 'data',
    type,
    actionIdentifier,
    callId || messageId || roomId || from || 'unknown',
  ].join(':');
}

function shouldHandleNotificationTap(data: any, actionIdentifier: string, responseIdentifier?: string): boolean {
  const key = buildNotificationTapKey(data, actionIdentifier, responseIdentifier);
  const now = Date.now();
  cleanupHandledNotificationTaps(now);
  const lastAt = handledNotificationTaps.get(key);
  if (lastAt && now - lastAt < NOTIFICATION_TAP_DEDUPE_MS) {
    logger.info('[push] duplicate notification response ignored', {
      type: data?.type,
      actionIdentifier,
      responseIdentifier: responseIdentifier || null,
    });
    return false;
  }
  handledNotificationTaps.set(key, now);
  return true;
}

async function loadPersistedHandledNotificationResponseKeys(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(PUSH_HANDLED_NOTIFICATION_RESPONSES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x) => typeof x === 'string' && x.length > 0));
  } catch {
    return new Set();
  }
}

async function wasNotificationResponseHandledInPastSession(
  data: any,
  actionIdentifier: string,
  responseIdentifier?: string
): Promise<boolean> {
  const key = buildNotificationTapKey(data, actionIdentifier, responseIdentifier);
  const set = await loadPersistedHandledNotificationResponseKeys();
  return set.has(key);
}

async function persistHandledNotificationResponseKey(
  data: any,
  actionIdentifier: string,
  responseIdentifier?: string
): Promise<void> {
  const key = buildNotificationTapKey(data, actionIdentifier, responseIdentifier);
  const set = await loadPersistedHandledNotificationResponseKeys();
  if (set.has(key)) return;
  set.delete(key);
  set.add(key);
  const arr = [...set];
  while (arr.length > MAX_STORED_HANDLED_NOTIFICATION_RESPONSES) arr.shift();
  await AsyncStorage.setItem(PUSH_HANDLED_NOTIFICATION_RESPONSES_KEY, JSON.stringify(arr));
}

function schedulePendingNavigationDrain(delayMs = 80): void {
  if (pendingNavigationDrainTimer) return;
  pendingNavigationDrainTimer = setTimeout(() => {
    pendingNavigationDrainTimer = null;
    void drainPendingNavigations();
  }, delayMs);
}

async function drainPendingNavigations(): Promise<void> {
  if (pendingNavigationDrainInFlight) return;
  pendingNavigationDrainInFlight = true;
  try {
    const nav = getReadyNav();
    const now = Date.now();
    if (!nav) {
      for (const [key, pending] of pendingNavigations) {
        if (now - pending.createdAtMs > PENDING_NAVIGATION_TTL_MS) {
          pendingNavigations.delete(key);
          logger.warn('[push] pending notification navigation expired', { key });
        }
      }
      if (pendingNavigations.size > 0) schedulePendingNavigationDrain(250);
      return;
    }

    const entries = Array.from(pendingNavigations.entries());
    pendingNavigations.clear();
    for (const [, pending] of entries) {
      try {
        await pending.run(nav);
      } catch (e) {
        logger.warn('[push] pending notification navigation failed', { key: pending.key, error: (e as Error)?.message });
      }
    }
  } finally {
    pendingNavigationDrainInFlight = false;
  }
}

async function runWhenNavReady(
  key: string,
  run: (nav: ReadyNavigation) => void | Promise<void>,
  waitMs = 1200
): Promise<boolean> {
  const nav = await waitForNavReady(waitMs);
  if (nav) {
    await run(nav);
    return true;
  }
  pendingNavigations.set(key, { key, createdAtMs: Date.now(), run });
  schedulePendingNavigationDrain();
  logger.info('[push] queued notification navigation until nav ready', { key });
  return false;
}

async function navigateToVideoCallIncoming(peerUserId: string, callId: string, media?: DirectCallMediaHint) {
  const incomingMedia = media ?? getCallMediaHint(callId);
  try { setCallMediaHint(callId, incomingMedia); } catch {}
  await runWhenNavReady(`call:${callId || peerUserId}`, (nav) => {
    setActiveVideoCall(true);
    try { emitCloseHomeModals(); } catch {}
    navigateToVideoCallScreen(
      nav as VideoCallNavLike,
      {
        peerUserId,
        directCall: true,
        directInitiator: false,
        callId,
        isIncoming: true,
        ...videoCallNavExtras(callId, incomingMedia),
      },
      'incoming_navigate',
    );
  });
}

/** Открыть экран входящего звонка (для deep link livi://incoming-call и full-screen intent). */
export async function openIncomingCallScreen(peerUserId: string, callId: string): Promise<void> {
  try {
    stopIncomingCallAlert();
  } catch {}
  await navigateToVideoCallIncoming(peerUserId, callId);
}

/** Открыть приложение и принять звонок (для livi://answer-call из нативного IncomingCallActivity).
 * Сразу VideoCall + session.acceptCall() (сокет греется параллельно). */
export async function openAnswerCallScreen(
  peerUserId: string,
  callId: string,
  media?: DirectCallMediaHint,
): Promise<void> {
  try { setIncomingCallScreenVisible(false); } catch {}
  try {
    stopIncomingCallAlert();
  } catch {}
  warmCallSignaling();
  const mediaHint = media ?? getCallMediaHint(callId);
  prefetchDirectCallIce('push:answer-call-screen');
  if (Platform.OS === 'android' && mediaHint === 'audio') {
    prewarmDirectCallAudioCapture('push:answer-call-screen');
  }
  beginEarlyIncomingCallAccept(callId);
  await navigateToVideoCallIncoming(peerUserId, callId, mediaHint);
  // Incoming закрываем ПОСЛЕ navigate: иначе finish() singleInstance оставляет лаунчер до Main.
  if (Platform.OS === 'android') {
    sendCallAnsweredBroadcast(callId);
  }
  // Не блокируем ответный UI очисткой нотификаций — иначе долго видна крышка accept.
  void clearCallRelatedNotificationsAndSyncBadge().catch(() => {});
}

/** После отклонения из вне приложения — увести приложение в фон, чтобы пользователь остался на экране блокировки или в меню телефона. */
function moveAppToBackAfterDecline() {
  if (Platform.OS !== 'android') return;
  try {
    const LiviAppModule = NativeModules.LiviAppModule;
    if (LiviAppModule?.moveTaskToBack) {
      LiviAppModule.moveTaskToBack(true);
    }
  } catch {}
}

/** Отклонить звонок (для livi://decline-call из нативного IncomingCallActivity). Ждём сокет, чтобы call:decline дошёл до сервера и у звонящего завершился вызов. После этого уводим приложение в фон.
 * Отклонение получателем не считается пропущенным вызовом — очищаем last_incoming_from. */
export async function handleDeclineCallFromDeepLink(callId: string): Promise<void> {
  disposeDirectCallAudioPrewarm('push:decline-call');
  try { setIncomingCallScreenVisible(false); } catch {}
  try {
    stopIncomingCallAlert();
  } catch {}
  // Отклонение с нашей стороны — не пропущенный вызов; сбрасываем маркер, чтобы нигде не считать как пропущенный
  try {
    await AsyncStorage.removeItem('last_incoming_from');
  } catch {}
  try {
    await ensureSocketConnected(SOCKET_CONNECT_WAIT_MS);
    declineCall(callId);
  } catch (e) {
    logger.warn('[push] declineCall from decline-call deep link failed', { callId, error: (e as Error)?.message });
  }
  await clearCallRelatedNotificationsAndSyncBadge();
  moveAppToBackAfterDecline();
}

/**
 * Обработка ответа на уведомление (тап по уведомлению или по кнопке «Поднять»/«Положить»).
 * actionIdentifier: 'answer' = Поднять, 'decline' = Положить, DEFAULT = тап по телу уведомления.
 */
async function handleNotificationResponse(data: any, actionIdentifier: string, responseIdentifier?: string) {
  let persistAfterHandle = false;
  try {
    const type = String(data?.type || '');
    if (!type) return;
    if (!shouldHandleNotificationTap(data, actionIdentifier, responseIdentifier)) return;
    persistAfterHandle = true;
    trackReleaseEvent('notification_tap', {
      type,
      actionIdentifier,
      callId: String(data?.callId || '').trim() || null,
      roomId: String(data?.roomId || '').trim() || null,
      userId: String(data?.from || data?.fromUserId || '').trim() || null,
    });

    if (type === 'call_declined') {
      const id = data?.callId ? String(data.callId) : '';
      logger.info('[decline/инициатор] push handleNotificationResponse call_declined', { callId: id, alreadyHandled: id ? isOutgoingDeclineHandled(id) : false });
      if (id && isOutgoingDeclineHandled(id)) {
        logger.info('[decline/инициатор] push handleNotificationResponse — уже обработан, выходим');
        return;
      }
      if (id) markOutgoingDeclineHandled(id);
      try { closeOutgoingCallActivity(id || null, { force: true }); } catch {}
      try { setOutgoingCallScreenVisible(false); } catch {}
      try { emitCloseOutgoingCall({ reason: 'remote_closed', callId: id || null }); } catch {}
      logger.info('[decline/инициатор] push handleNotificationResponse: закрыли и emitCloseOutgoingCall');
      return;
    }
    if (type === 'call_canceled') {
      logger.info('[push] call_canceled received (handleNotificationResponse)', { callId: data?.callId });
      if (data?.callId) {
        try { stopIncomingCallRingtoneAndVibration(); } catch {}
        try { setIncomingCallScreenVisible(false); } catch {}
        try { notifyCallCanceled(String(data.callId)); } catch {}
        try { addEndedCallId(String(data.callId)); } catch {}
        logger.info('[push] notifyCallCanceled + addEndedCallId called after call_canceled (response)');
      }
      return;
    }
    if (type === 'call_ended') {
      if (data?.callId) addEndedCallId(String(data.callId));
      if (data?.endedFromActive) {
        await clearCallRelatedNotificationsAndSyncBadge();
        try {
          (global as any).__onCallEndedFromPush?.();
        } catch {}
      }
      return;
    }

    if (type === 'missed_call') {
      await runWhenNavReady(`missed_call:${String(data?.from || data?.fromUserId || 'unknown')}`, async (nav) => {
        nav.dispatch(
          CommonActions.reset({
            index: 0,
            routes: [{ name: 'Home' as never, params: { openFriendsMenu: true, openFriendsTab: true } }],
          })
        );
      });
      return;
    }

    if (type === 'message') {
      ensureInAppPiPBeforeOpeningFriendsFromMessageNotification();
      const fromId = String(data?.from || data?.fromUserId || '').trim();
      await runWhenNavReady(`message:${fromId || String(data?.messageId || 'unknown')}`, async (nav) => {
        await clearNotificationIndicators();
        nav.dispatch(
          CommonActions.reset({
            index: 0,
            routes: [{
              name: 'Home' as never,
              params: {
                openFriendsMenu: true,
                openFriendsTab: true,
                ...(fromId ? { pushMessageFrom: fromId } : {}),
              },
            }],
          })
        );
      });
      return;
    }

    if (type === 'call') {
      const peerUserId = String(data?.from || '');
      const callId = String(data?.callId || '');
      if (!peerUserId) return;
      if (isIncomingCallExpired({ expiresAt: data?.expiresAt, ts: data?.ts })) {
        logger.info('[push] ignore stale call notification action', {
          callId,
          actionIdentifier,
          expiresAt: data?.expiresAt,
          ts: data?.ts,
        });
        try {
          addEndedCallId(callId);
        } catch {}
        await clearCallRelatedNotificationsAndSyncBadge();
        return;
      }

      const isAnswer = actionIdentifier === 'answer';
      const isDecline = actionIdentifier === 'decline';
      const isDefaultTap = actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER;

      if (isDecline) {
        try {
          stopIncomingCallAlert();
        } catch {}
        try {
          await ensureSocketConnected(SOCKET_CONNECT_WAIT_MS);
          declineCall(callId);
        } catch (e) {
          logger.warn('[push] declineCall from notification failed', { callId, error: (e as Error)?.message });
        }
        await clearCallRelatedNotificationsAndSyncBadge();
        moveAppToBackAfterDecline();
        return;
      }

      if (isAnswer || isDefaultTap) {
        try {
          stopIncomingCallAlert();
        } catch {}
        const complete =
          typeof (global as any).__completeAndroidIncomingAnswer === 'function'
            ? (global as any).__completeAndroidIncomingAnswer as (from: string, callId: string) => Promise<void>
            : null;
        if (complete && Platform.OS === 'android') {
          await complete(peerUserId, callId);
        } else {
          warmCallSignaling();
          await navigateToVideoCallIncoming(peerUserId, callId);
        }
        try {
          await clearNotificationIndicators();
        } catch {}
      }
    }
  } catch (e) {
    trackReleaseError('notification_tap_failed', e, {
      callId: String(data?.callId || '').trim() || null,
      roomId: String(data?.roomId || '').trim() || null,
      userId: String(data?.from || data?.fromUserId || '').trim() || null,
      actionIdentifier,
    });
    logger.warn('[push] handleNotificationResponse failed', e as any);
  } finally {
    if (persistAfterHandle) {
      try {
        await persistHandledNotificationResponseKey(data, actionIdentifier, responseIdentifier);
      } catch {}
    }
  }
}

/** Устаревший путь: только навигация по data (тап по уведомлению без кнопок). */
async function navigateFromPushData(data: any) {
  await handleNotificationResponse(data, Notifications.DEFAULT_ACTION_IDENTIFIER);
}

export async function ensureAndroidNotificationChannels() {
  if (Platform.OS !== 'android') return;
  const lang = await loadLang();

  // Сообщения
  await Notifications.setNotificationChannelAsync('messages', {
    name: 'Messages',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 150, 80, 150],
    sound: 'default',
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });

  // Звонки (приложение закрыто/в фоне). Та же вибрация, что и при входящем в приложении (incomingCallAlert): [0, 700, 900].
  await Notifications.setNotificationChannelAsync('calls', {
    name: 'Calls',
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 700, 900],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });

  // Пропущенный вызов — без вибрации, только текст в шторке
  await Notifications.setNotificationChannelAsync('missed_call', {
    name: t('missedCallTitle', lang),
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0],
    sound: undefined,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

/**
 * Регистрирует категорию уведомления входящего звонка: справа две кнопки —
 * «Поднять» (принять), «Отменить» (красная, isDestructive).
 */
async function ensureIncomingCallNotificationCategory() {
  try {
    const lang = await loadLang();
    await Notifications.setNotificationCategoryAsync(INCOMING_CALL_CATEGORY_ID, [
      { identifier: 'answer', buttonTitle: t('answerAction', lang) },
      { identifier: 'decline', buttonTitle: t('cancelCall', lang), options: { isDestructive: true } },
    ]);
    logger.debug('[push] incoming call notification category registered');
  } catch (e) {
    logger.warn('[push] setNotificationCategoryAsync failed', e as any);
  }
}

/**
 * Requests OS notification permission on startup (Android 13+ and iOS).
 * On older Android versions there is no runtime prompt, but this will still
 * return the current permission status.
 */
export async function ensureInitialNotificationPermissions(): Promise<void> {
  try {
    await ensureAndroidNotificationChannels();
  } catch {}

  try {
    await ensureIncomingCallNotificationCategory();
  } catch {}

  try {
    const settings = await Notifications.getPermissionsAsync();
    let finalStatus = settings.status;
    if (finalStatus !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      finalStatus = req.status;
    }
    logger.info('[push] notification permission status:', finalStatus);
  } catch (e) {
    logger.warn('[push] Failed to request notification permissions', e as any);
  }

}

export async function registerAndSendPushToken(userId?: string, options?: RegisterPushTokenOptions) {
  if (!userId) return;
  await loadPersistedPushTokenSnapshot();
  const force = options?.force === true;
  const reason = options?.reason || 'manual';
  const uid = String(userId);

  if (reason === 'startup') {
    if (pushStartupRegisterDone && !force) {
      logger.debug('[push] startup register skipped (already done this session)');
      return;
    }
    pushStartupRegisterDone = true;
  }

  // Не дергаем Expo Push API на каждом reconnect: токен за минуту не меняется, а 503 от Expo даёт шторм и тормозит UI.
  if (!force && (reason === 'socket_reconnect' || reason === 'app_active')) {
    const last = lastRegisteredPushToken;
    if (last && last.userId === uid && Date.now() - last.atMs < PUSH_TOKEN_REGISTER_COOLDOWN_MS) {
      logger.debug('[push] register skipped (cooldown, no Expo fetch)', { reason });
      return;
    }
  }

  if (registerPushInFlight) {
    await registerPushInFlight;
    if (!force && (reason === 'socket_reconnect' || reason === 'app_active')) {
      const last = lastRegisteredPushToken;
      if (last && last.userId === uid && Date.now() - last.atMs < PUSH_TOKEN_REGISTER_COOLDOWN_MS) {
        logger.debug('[push] register skipped (cooldown after in-flight)', { reason });
        return;
      }
    }
  }
  registerPushInFlight = (async () => {
    try {
      await ensureAndroidNotificationChannels();

      const settings = await Notifications.getPermissionsAsync();
      let finalStatus = settings.status;
      if (finalStatus !== 'granted') {
        const req = await Notifications.requestPermissionsAsync();
        finalStatus = req.status;
      }
      if (finalStatus !== 'granted') {
        logger.info('[push] permission not granted');
        return;
      }

      // FCM token (Android): для data-only пуша звонка — бэкенд шлёт в FCM, onMessageReceived вызывается в фоне → нативный экран.
      let fcmToken: string | undefined;
      try {
        const deviceTokenResp = await Notifications.getDevicePushTokenAsync();
        const deviceToken = (deviceTokenResp as any)?.data;
        const deviceType = String((deviceTokenResp as any)?.type || '');
        if (deviceToken && Platform.OS === 'android') {
          fcmToken = String(deviceToken);
          logger.debug('[push] device push token acquired', {
            type: deviceType,
            tokenPrefix: fcmToken.slice(0, 18),
          });
          if (__DEV__) {
            logger.debug('[push][DEV] DEVICE_PUSH_TOKEN (Firebase test)', { tokenPrefix: fcmToken.slice(0, 24) + '…' });
          }
        }
      } catch (e) {
        const msg = String((e as any)?.message || e || '');
        const looksLikeFcmSetupError =
          msg.includes('fcm-credentials') ||
          msg.includes('Default FirebaseApp is not initialized') ||
          msg.includes('FirebaseApp.initializeApp');
        if (__DEV__ && looksLikeFcmSetupError) {
          logger.debug('[push] skipping device push token warning (FCM not configured)', { message: msg.slice(0, 220) });
        } else {
          logger.warn('[push] failed to get device push token', e as any);
        }
      }

      // Получаем Expo push token
      const projectId =
        (Constants.expoConfig as any)?.extra?.eas?.projectId ||
        (Constants as any)?.easConfig?.projectId;

      const tokenResp = await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined
      );
      const token = tokenResp?.data;
      if (!token) return;
      try {
        logger.debug('[push] expo token acquired', {
          userId,
          tokenPrefix: String(token).slice(0, 18),
          platform: Platform.OS,
          hasProjectId: !!projectId,
        });
      } catch {}

      const installId = await getInstallId();

      const snapshotNow: PushTokenSnapshot = {
        userId: String(userId),
        expoToken: String(token),
        fcmToken: String(fcmToken || ''),
        atMs: Date.now(),
      };
      const last = lastRegisteredPushToken;
      const unchanged =
        !!last &&
        last.userId === snapshotNow.userId &&
        last.expoToken === snapshotNow.expoToken &&
        last.fcmToken === snapshotNow.fcmToken;
      const withinCooldown = !!last && snapshotNow.atMs - last.atMs < PUSH_TOKEN_REGISTER_COOLDOWN_MS;
      const force = options?.force === true;
      if (!force && unchanged && withinCooldown) {
        logger.debug('[push] token registration skipped (unchanged + cooldown)', {
          reason: options?.reason || 'manual',
          cooldownLeftMs: Math.max(0, PUSH_TOKEN_REGISTER_COOLDOWN_MS - (snapshotNow.atMs - (last?.atMs || 0))),
        });
        return;
      }

      // Регистрируем токен на backend. Для Android входящий звонок с кнопками возможен только при отправке fcmToken — бэкенд шлёт FCM data-only.
      const voipToken = Platform.OS === 'ios' ? await getVoipPushToken() : undefined;
      const body: Record<string, unknown> = {
        token,
        platform: Platform.OS,
        ...(Platform.OS === 'android' && fcmToken ? { fcmToken } : {}),
        ...(Platform.OS === 'ios' && voipToken ? { voipToken } : {}),
      };
      if (Platform.OS === 'android') {
        logger.info('[push] registering token', { hasFcmToken: !!fcmToken });
      }
      const resp = await fetch(`${API_BASE}/api/push-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': String(userId),
          'x-install-id': String(installId),
        },
        body: JSON.stringify(body),
      }).catch((e) => {
        logger.warn('[push] failed to register token (network)', e);
        return null as any;
      });

      try {
        if (resp && typeof resp?.ok === 'boolean') {
          const text = await resp.text().catch(() => '');
          logger.debug('[push] token register response', {
            ok: resp.ok,
            status: resp.status,
            body: text ? text.slice(0, 200) : '',
            reason: options?.reason || 'manual',
          });
          if (resp.ok) {
            lastRegisteredPushToken = snapshotNow;
            await persistPushTokenSnapshot(snapshotNow);
          }
          if (Platform.OS === 'android' && resp.ok) {
            logger.info('[push] token registered', { hasFcmToken: !!fcmToken });
          }
        }
      } catch {}
    } catch (e: any) {
      // Dev-only noise suppression:
      // In dev builds, Firebase/FCM is often not configured, so expo-notifications may throw.
      // This should not spam logs during everyday debugging.
      const msg = String(e?.message || e || '');
      const looksLikeFcmSetupError =
        msg.includes('fcm-credentials') ||
        msg.includes('Default FirebaseApp is not initialized') ||
        msg.includes('FirebaseApp.initializeApp');

      if (__DEV__ && looksLikeFcmSetupError) {
        logger.debug('[push] В dev пуш-токен не зарегистрирован (FCM не настроен). Уведомления о звонках не придут. Собери с google-services.json или проверяй на релизной сборке.', {
          message: msg.slice(0, 220),
        });
        return;
      }

      const transientPush =
        msg.includes('503') ||
        msg.includes('SERVICE_UNAVAILABLE') ||
        msg.includes('temporarily unavailable') ||
        msg.includes('no healthy upstream') ||
        msg.includes('upstream connect error');
      if (transientPush) {
        logger.debug('[push] registerAndSendPushToken transient server/load — will retry on next register', {
          message: msg.slice(0, 220),
        });
        return;
      }

      logger.warn('[push] registerAndSendPushToken error', e as any);
    }
  })();
  try {
    await registerPushInFlight;
  } finally {
    registerPushInFlight = null;
  }
}

export function addNotificationListeners() {
  // Не сбрасываем все уведомления при переходе приложения в активное состояние:
  // иначе уведомление о входящем звонке исчезает, как только пользователь открыл приложение.
  // Очистка происходит при открытии чата (ChatScreen) или при ответе на пуш.
  let appStateRef = AppState.currentState;
  const appStateSub = AppState.addEventListener('change', (next) => {
    try {
      appStateRef = next;
    } catch {}
  });

  // 1) Если приложение было "убито" и открылось по тапу по пушу или по кнопке — используем заранее захваченный ответ
  (async () => {
    try {
      const last = await getColdStartNotificationResponse();
      const data = (last as any)?.notification?.request?.content?.data;
      const actionId = (last as any)?.actionIdentifier ?? Notifications.DEFAULT_ACTION_IDENTIFIER;
      const responseId = (last as any)?.notification?.request?.identifier;
      if (!data) return;
      const coldStartType = String(data?.type || '').trim();
      if (!coldStartType) {
        logger.info('[push] cold start: skip notification response without type', {
          responseId: responseId || null,
        });
        return;
      }
      if (await wasNotificationResponseHandledInPastSession(data, actionId, responseId)) {
        logger.info('[push] cold start: skip notification already handled in past session', {
          type: data?.type,
          responseId: responseId || null,
        });
        return;
      }
      logger.info('[push] cold start: handling notification response', { type: coldStartType, actionId });
      await handleNotificationResponse(data, actionId, responseId);
    } catch (e) {
      logger.warn('[push] cold start handle failed', e as any);
    }
  })();

  // 2) Если приложение в фоне/foreground и пользователь нажал на пуш или на кнопку «Поднять»/«Положить»
  const sub2 = Notifications.addNotificationResponseReceivedListener(async (r) => {
    const data = (r as any)?.notification?.request?.content?.data;
    const actionId = (r as any)?.actionIdentifier ?? Notifications.DEFAULT_ACTION_IDENTIFIER;
    const responseId = (r as any)?.notification?.request?.identifier;
    if (data) await handleNotificationResponse(data, actionId, responseId);
  });

  // При получении пуша о звонке: на Android показываем только нативный IncomingCallActivity
  // (Expo-уведомление скрыто в setNotificationHandler; при FCM пуше экран открывает LiviFirebaseMessagingService).
  const sub1 = Notifications.addNotificationReceivedListener(async (n) => {
    try {
      const data = (n as any)?.request?.content?.data;
      if (data?.type === 'call_declined') {
        const id = data?.callId ? String(data.callId) : '';
        logger.info('[decline/инициатор] push notificationReceived call_declined', { callId: id, alreadyHandled: id ? isOutgoingDeclineHandled(id) : false });
        if (id && isOutgoingDeclineHandled(id)) {
          logger.info('[decline/инициатор] push notificationReceived — уже обработан, выходим');
          return;
        }
        if (id) markOutgoingDeclineHandled(id);
        try { closeOutgoingCallActivity(id || null, { force: true }); } catch {}
        try { setOutgoingCallScreenVisible(false); } catch {}
        try { emitCloseOutgoingCall({ reason: 'remote_closed', callId: id || null }); } catch {}
        logger.info('[decline/инициатор] push notificationReceived: закрыли и emitCloseOutgoingCall');
        return;
      }
      if (data?.type === 'call_canceled' && data?.callId) {
        logger.info('[push] call_canceled received (notificationReceived)', { callId: data.callId });
        try { stopIncomingCallRingtoneAndVibration(); } catch {}
        try { setIncomingCallScreenVisible(false); } catch {}
        try { notifyCallCanceled(String(data.callId)); } catch {}
        try { addEndedCallId(String(data.callId)); } catch {}
        logger.info('[push] notifyCallCanceled + addEndedCallId called after call_canceled (received)');
        return;
      }
      if (data?.type === 'call_ended' && data?.callId) {
        const endedFromActive = !!data.endedFromActive;
        if (data?.callId) addEndedCallId(String(data.callId));
        // Android: см. call_canceled — не дублируем notifyMissedCallNativeAndroid.
        return;
      }
      if (data?.type === 'call' && data?.callId && data?.from) {
        // Android: keep native FCM as primary path, but do not ignore Expo payloads completely.
        // On unstable networks native/data delivery can be delayed or dropped while Expo listener still fires.
        // Existing de-dup + stale guards below prevent flash-open for old notifications.
        if (await isEndedCallId(data.callId)) {
          logger.info('[push] incoming call notification ignored (call already ended)', { callId: data.callId });
          return;
        }
        if (isIncomingCallExpired({ expiresAt: data.expiresAt, ts: data.ts })) {
          logger.info('[push] incoming call notification treated as stale (delayed delivery)', {
            callId: data.callId,
            ts: data.ts,
            expiresAt: data.expiresAt,
          });
          try {
            addEndedCallId(String(data.callId));
          } catch {}
          const fromNick = String(data.fromNick || '').trim();
          const fromUserId = String(data.from || '');
          try {
            const lang = await loadLang();
            const title = t('missedCallTitle', lang);
            const body = fromNick
              ? t('incomingFromPrefix', lang).replace('{name}', fromNick)
              : t('incomingVideoCallBody', lang);
            await Notifications.scheduleNotificationAsync({
              content: {
                title,
                body,
                data: { type: 'missed_call', from: fromUserId, fromNick },
              },
              trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 0.2 },
            });
          } catch (e) {
            logger.warn('[push] failed to show missed_call for stale call', e as any);
          }
          return;
        }
        logger.info('[push] incoming call notification received (Expo path; native FCM may also run)', {
          callId: data.callId,
          from: data.from,
          appState: AppState.currentState,
        });
        if (isCallKeepAvailable() && AppState.currentState !== 'active') {
          const hasVideo = String(data?.media || '').toLowerCase() === 'video';
          displayIncomingCall(data.callId, data.from, data.fromNick ?? '', hasVideo, data.callKitId);
        }
        const setFromPush = (global as any).__setIncomingCallFromPush;
        if (typeof setFromPush === 'function') {
          setFromPush(data);
        }
      }
    } catch {}
  });
  return () => {
    sub1.remove();
    sub2.remove();
    try {
      appStateSub.remove();
    } catch {}
  };
}

