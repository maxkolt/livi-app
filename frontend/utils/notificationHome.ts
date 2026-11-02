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
