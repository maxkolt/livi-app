// frontend/sockets/modules/missedCalls.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules, Platform } from "react-native";
import { logger } from "../../utils/logger";
import { emitMissedFetchedFromServer } from '../../utils/globalEvents';
import { shared } from './shared';

const MISSED_CALLS_KEY = 'missed_calls_by_user_v1';
const APPLIED_FROM_REAUTH_EXPIRY_MS = 30_000;
const APPLIED_FROM_PENDING_EXPIRY_MS = 30_000;

/** Проверить, что uid недавно учтён в applyMissedFromReauth — чтобы при применении pending не инкрементировать повторно. */
export function wasAppliedFromReauth(uid: string): boolean {
  if (!uid) return false;
  const ts = shared.appliedFromReauthByUid.get(uid);
  if (ts == null) return false;
  if (Date.now() - ts > APPLIED_FROM_REAUTH_EXPIRY_MS) {
    shared.appliedFromReauthByUid.delete(uid);
    return false;
  }
  return true;
}

/** Записать, что uid только что учтён при применении pending (getAndClearPendingMissedCalls). */
export function recordAppliedFromPending(uid: string): void {
  if (!uid) return;
  shared.appliedFromPendingByUid.set(uid, Date.now());
}

/** Проверить, что uid недавно учтён при применении pending — чтобы applyMissedFromReauth не инкрементировал повторно. */
function wasAppliedFromPending(uid: string): boolean {
  if (!uid) return false;
  const ts = shared.appliedFromPendingByUid.get(uid);
  if (ts == null) return false;
  if (Date.now() - ts > APPLIED_FROM_PENDING_EXPIRY_MS) {
    shared.appliedFromPendingByUid.delete(uid);
    return false;
  }
  return true;
}

/** Мержим пропущенные с сервера (после reauth) в AsyncStorage и уведомляем UI. */
export async function applyMissedFromReauth(response: { missed?: { from: string; fromNick?: string }[] }) {
  const missed = response?.missed;
  if (!Array.isArray(missed) || missed.length === 0) return;
  try {
    const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
    const map: Record<string, number> = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    for (const m of missed) {
      const uid = String(m?.from || '').trim();
      if (uid) {
        if (wasAppliedFromPending(uid)) continue;
        map[uid] = (map[uid] || 0) + 1;
        shared.appliedFromReauthByUid.set(uid, now);
      }
    }
    await AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(map));
    if (Platform.OS === 'android' && NativeModules.LiviAppModule?.removePendingMissedCall) {
      for (const m of missed) {
        const uid = String(m?.from || '').trim();
        if (uid) {
          try { NativeModules.LiviAppModule.removePendingMissedCall(uid); } catch (_) {}
        }
      }
    }
    emitMissedFetchedFromServer();
  } catch (e) {
    logger.warn('[applyMissedFromReauth] failed', e as any);
  }
}