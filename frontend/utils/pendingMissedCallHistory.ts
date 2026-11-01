import { NativeModules, Platform } from 'react-native';
import { recordMissedCallHistory } from '../screens/home/callLog';
import type { PushNotificationData } from './notificationTypes';

let importing: Promise<void> | null = null;

/** A tapped notification may reach JS before either socket replay or the native inbox import. */
export async function persistMissedCallNotificationHistory(data: PushNotificationData = {}): Promise<void> {
  await persistPendingMissedCallHistory();
  const peerId = String(data.from || data.fromUserId || '').trim();
  const eventId = String(data.callId || '').trim();
  if (!peerId || !eventId) return;
  const at = Date.parse(String(data.sentAt || ''));
  await recordMissedCallHistory({
    peerId, eventId, fromNick: data.fromNick,
    ...(Number.isFinite(at) && at > 0 ? { at } : {}),
  });
}

/** The native inbox is independent of notification counts and is removed only after disk writes. */
export function persistPendingMissedCallHistory(): Promise<void> {
  if (importing) return importing;
  const native = NativeModules.LiviAppModule;
  if (Platform.OS !== 'android' || !native?.getPendingMissedCallEventsJson) return Promise.resolve();
  importing = (async () => {
    const events = JSON.parse(await native.getPendingMissedCallEventsJson());
    if (!Array.isArray(events)) throw new Error('invalid_native_missed_calls');
    const ids: string[] = [];
    for (const event of events) {
      await recordMissedCallHistory({
        eventId: event.id, peerId: event.from, fromNick: event.fromNick, at: event.at,
      });
      ids.push(event.id);
    }
    if (ids.length) await native.acknowledgePendingMissedCallEvents(JSON.stringify(ids));
  })().finally(() => { importing = null; });
  return importing;
}
