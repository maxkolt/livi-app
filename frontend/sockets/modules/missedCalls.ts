// frontend/sockets/modules/missedCalls.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules, Platform } from "react-native";
import { logger } from "../../utils/logger";
import { emitMissedFetchedFromServer, isWelcomeViewingMissedCalls, isWelcomeCallsMissedFilterActive } from '../../utils/globalEvents';
import { shared } from './shared';
import { socket } from './socketCore';
import { recordMissedCallHistory } from '../../screens/home/callLog';
import { persistPendingMissedCallHistory } from '../../utils/pendingMissedCallHistory';
import type { MissedCallDelivery } from './types';

const MISSED_CALLS_KEY = 'missed_calls_by_user_v1';
const APPLIED_FROM_PENDING_EXPIRY_MS = 30_000;

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

let deliveryQueue: Promise<void> = Promise.resolve();

/** Save the actual history before badges, deduplication or acknowledging server delivery. */
export function applyMissedFromReauth(response: { userId?: string; missed?: MissedCallDelivery[] }): Promise<void> {
  const run = deliveryQueue.catch(() => {}).then(async () => {
    const recipient = shared.currentUserId;
    if (!recipient || (response.userId && response.userId !== recipient)) return;
    await persistPendingMissedCallHistory();
    const missed = response?.missed;
    if (!Array.isArray(missed) || missed.length === 0) return;
    const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
    const map: Record<string, number> = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    const ids: string[] = [];
    for (const m of missed) {
      const uid = String(m?.from || '').trim();
      if (uid) {
        const eventId = m.callId || (m.id ? `server:${m.id}` : `legacy-server:${uid}:${now}:${ids.length}`);
        const added = await recordMissedCallHistory({ peerId: uid, eventId, at: m.at, fromNick: m.fromNick });
        if (m.id) ids.push(m.id);
        if (added && !wasAppliedFromPending(uid) && !isWelcomeViewingMissedCalls() && !isWelcomeCallsMissedFilterActive()) {
          map[uid] = (map[uid] || 0) + 1;
        }
        shared.appliedFromReauthByUid.set(uid, now);
      }
    }
    if (shared.currentUserId !== recipient) return;
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
    if (ids.length && socket.connected) {
      socket.emit('missed_calls:ack', { ids }, (next: { ok?: boolean; userId?: string; missed?: MissedCallDelivery[] }) => {
        if (next?.ok && next.missed?.length) void applyMissedFromReauth(next);
      });
    }
  });
  deliveryQueue = run;
  return run.catch((e) => {
    logger.warn('[applyMissedFromReauth] failed', e);
  });
}
