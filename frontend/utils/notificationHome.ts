import type { HomeRouteParams } from '../screens/home/types';

export type NotificationHomeDestination = 'unread' | 'missed' | 'requests' | 'updates';

export function notificationHomeParams(destination: unknown): HomeRouteParams | undefined {
  switch (destination) {
    case 'unread': return { openWelcomeChat: true, openWelcomeChatUnread: true };
    case 'missed': return { openWelcomeCalls: true, openWelcomeCallsMissed: true };
    case 'requests': return { openFriendsTab: true, openFriendRequests: true };
    case 'updates': return { openWelcomeProfile: true, openAppUpdates: true };
    default: return undefined;
  }
}

export function notificationHomeTab(params?: HomeRouteParams) {
  if (params?.openWelcomeCalls || params?.openFriendsMenu) return 'calls';
  if (params?.openWelcomeChat || (params?.openFriendsTab && params?.pushMessageFrom)) return 'chat';
  if (params?.openFriendsTab || params?.openFriendRequests) return 'friends';
  if (params?.openWelcomeProfile || params?.openAppUpdates) return 'profile';
  return undefined;
}


type NotificationHomeRequest = { id: number; destination: NotificationHomeDestination };
let request: NotificationHomeRequest | null = null;
let requestId = 0;
let stackTransitionRequestId: number | null = null;
const listeners = new Set<() => void>();
export const getNotificationHomeRequest = () => request;
export const getNotificationHomeTabSnapshot = () => notificationHomeTab(notificationHomeParams(request?.destination));
export const getNotificationStackTransition = () => stackTransitionRequestId !== null;
export function subscribeNotificationHomeRequest(listener: () => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
/** Publish the destination before the stack changes, including an already mounted Home. */
export function prepareNotificationHome(destination: NotificationHomeDestination, stackTransition = true) {
  request = { id: ++requestId, destination };
  stackTransitionRequestId = stackTransition ? request.id : null;
  listeners.forEach(listener => listener());
  return request.id;
}
/** A late frame from an older tap cannot clear a more recent destination. */
export function completeNotificationHome(id: number) {
  if (request?.id !== id) return;
  request = null; stackTransitionRequestId = null; listeners.forEach(listener => listener());
}

export function isNotificationHomeDestination(value: unknown): value is NotificationHomeDestination {
  return value === 'unread' || value === 'missed' || value === 'requests' || value === 'updates';
}

/** Native resume reads can finish after a newer tap. Only the newest delivery may navigate. */
export function createNotificationHomeDelivery({ readPending, onDestination, onError }: {
  readPending: () => Promise<unknown>;
  onDestination: (destination: NotificationHomeDestination) => void | Promise<unknown>;
  onError: (error: unknown) => void;
}) {
  let disposed = false, reading = false, readAgain = false, eventVersion = 0;
  const consume = async () => {
    if (disposed) return;
    if (reading) { readAgain = true; return; }
    reading = true;
    try {
      do {
        readAgain = false;
        const version = eventVersion;
        const destination = await readPending();
        if (!disposed && version === eventVersion && isNotificationHomeDestination(destination)) await onDestination(destination);
      } while (readAgain && !disposed);
    } catch (error) { if (!disposed) onError(error); }
    finally { reading = false; if (readAgain && !disposed) void consume(); }
  };
  return {
    consume,
    receive(destination: unknown) {
      if (disposed) return;
      eventVersion++;
      if (isNotificationHomeDestination(destination)) {
        try { Promise.resolve(onDestination(destination)).catch(onError); } catch (error) { onError(error); }
      }
      void consume();
    },
    dispose() { disposed = true; },
  };
}
