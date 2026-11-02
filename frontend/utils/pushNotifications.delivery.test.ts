const mockStorage = new Map<string, string>();
const mockHistory = new Set<string>();
const mockShown = new Set<string>();
let mockNativeCount = 0;
let mockViewingCalls = false;
const mockDispatch = jest.fn();
let mockNavReady = true;
const mockPersistHistory = jest.fn(async ({ eventId }: { eventId: string }) => {
  if (mockHistory.has(eventId)) return false;
  mockHistory.add(eventId); return true;
});
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => { mockStorage.set(key, value); }),
  removeItem: jest.fn(async (key: string) => { mockStorage.delete(key); }),
}));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  NativeModules: { LiviAppModule: {
    wasMissedShownForCallId: async (id: string) => mockShown.has(id),
    showMissedCallNotification: async (id: string) => {
      if (!mockShown.has(id)) { mockShown.add(id); mockNativeCount++; }
    },
    getMissedCountByUserJson: async () => JSON.stringify({ peer: mockNativeCount }),
    syncMissedCountForUser: (_id: string, count: number) => { mockNativeCount = count; },
  } },
}));
jest.mock('expo-notifications', () => ({
  getLastNotificationResponseAsync: async () => null, setNotificationHandler: jest.fn(),
  setBadgeCountAsync: async () => {},
}));
jest.mock('expo-constants', () => ({}));
jest.mock('@react-navigation/native', () => ({ CommonActions: { navigate: (payload: unknown) => payload } }));
jest.mock('../sockets/socket', () => ({ getUnreadCount: async () => ({ ok: true, count: 0 }) }));
jest.mock('./installId', () => ({}));
jest.mock('./fetchWithTimeout', () => ({}));
jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.mock('./telemetry', () => ({ trackReleaseEvent: jest.fn() }));
jest.mock('./incomingCallAlert', () => ({}));
jest.mock('./callKeep', () => ({}));
jest.mock('./globalEvents', () => ({
  isWelcomeViewingChats: () => false, isWelcomeViewingMissedCalls: () => mockViewingCalls,
  isWelcomeCallsMissedFilterActive: () => mockViewingCalls,
  emitCloseHomeModals: jest.fn(), emitMissedIncrement: jest.fn(), setPendingWelcomeCallsFilter: jest.fn(), setPendingWelcomeChatsFilter: jest.fn(),
}));
jest.mock('./terminateCall', () => ({}));
jest.mock('../screens/home/callLog', () => ({ recordMissedCallHistory: (args: { eventId: string }) => mockPersistHistory(args) }));
jest.mock('./pendingMissedCallHistory', () => ({}));
jest.mock('../screens/home/constants', () => ({ UNREAD_BY_USER_KEY: 'unread' }));
jest.mock('./appNavigationGuard', () => ({}));
jest.mock('./callPerfTrace', () => ({}));
jest.mock('./i18n', () => ({}));
jest.mock('./callExpiry', () => ({}));
jest.mock('./voipPush', () => ({}));
jest.mock('./directCallConnectPrewarm', () => ({}));
jest.mock('./productShadeNotifications', () => ({}));
import { recordMissedCallForUser, navigateNotificationHome, drainPendingNavigations } from './pushNotifications';
import { setPendingWelcomeCallsFilter, setPendingWelcomeChatsFilter } from './globalEvents';
import type { AppRuntimeGlobals } from './appRuntimeTypes';
const count = () => JSON.parse(mockStorage.get('missed_calls_by_user_v1') || '{}').peer || 0;
async function settle<T>(promise: Promise<T>) { await jest.runAllTimersAsync(); return promise; }
beforeEach(() => {
  jest.useFakeTimers(); mockStorage.clear(); mockHistory.clear(); mockShown.clear();
  mockNativeCount = 0; mockViewingCalls = false; mockNavReady = true; mockDispatch.mockClear();
  (global as AppRuntimeGlobals).__navRef = {
    isReady: () => mockNavReady, dispatch: mockDispatch, getCurrentRoute: () => ({ name: 'Home' }),
  } as unknown as AppRuntimeGlobals['__navRef'];
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
it('does not add one to equal native and cached counts for a call already notified by FCM', async () => {
  mockNativeCount = 1; mockShown.add('call-one');
  mockStorage.set('missed_calls_by_user_v1', '{"peer":1}');
  await settle(recordMissedCallForUser('peer', { callId: 'call-one', source: 'socket' }));
  expect(count()).toBe(1); expect(mockNativeCount).toBe(1);
});
it('counts simultaneous duplicate deliveries only once and distinct calls twice', async () => {
  await settle(Promise.all([
    recordMissedCallForUser('peer', { callId: 'concurrent' }),
    recordMissedCallForUser('peer', { callId: 'concurrent' }),
  ]));
  expect(count()).toBe(1);
  await settle(recordMissedCallForUser('peer', { callId: 'different' }));
  expect(count()).toBe(2);
});
it('does not increment a call already persisted by offline server replay', async () => {
  mockHistory.add('server-call'); mockNativeCount = 1;
  mockStorage.set('missed_calls_by_user_v1', '{"peer":1}');
  await settle(recordMissedCallForUser('peer', { callId: 'server-call' }));
  expect(count()).toBe(1);
});
it('saves history while the Missed page is visible without resurrecting its cleared badge', async () => {
  mockViewingCalls = true;
  await settle(recordMissedCallForUser('peer', { callId: 'visible-call' }));
  expect(mockHistory.has('visible-call')).toBe(true); expect(count()).toBe(0);
});
it.each([
  ['unread', { openWelcomeChat: true, openWelcomeChatUnread: true }],
  ['missed', { openWelcomeCalls: true, openWelcomeCallsMissed: true }],
  ['requests', { openFriendsTab: true, openFriendRequests: true }],
  ['updates', { openWelcomeProfile: true, openAppUpdates: true }],
] as const)('opens %s immediately without waiting for network or shade cleanup', async (destination, params) => {
  await navigateNotificationHome(destination);
  expect(mockDispatch).toHaveBeenCalledWith({ name: 'Home', params });
});
it('retains the most recent tap through a slow cold start instead of losing it after 2.5 seconds', async () => {
  mockNavReady = false;
  await navigateNotificationHome('unread');
  await jest.advanceTimersByTimeAsync(5000);
  await navigateNotificationHome('missed');
  expect(mockDispatch).not.toHaveBeenCalled();
  mockNavReady = true;
  await drainPendingNavigations();
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch).toHaveBeenCalledWith({ name: 'Home', params: { openWelcomeCalls: true, openWelcomeCallsMissed: true } });
  expect(setPendingWelcomeCallsFilter).toHaveBeenCalledWith('missed');
});
it('sets the unread filter before dispatch so a mounted chat list sees it in the first frame', async () => {
  mockDispatch.mockImplementationOnce(() => {
    expect(setPendingWelcomeChatsFilter).toHaveBeenCalledWith('unread');
  });
  await navigateNotificationHome('unread', 'peer');
  expect(mockDispatch).toHaveBeenCalledWith({ name: 'Home', params: {
    openWelcomeChat: true, openWelcomeChatUnread: true, pushMessageFrom: 'peer',
  } });
});

it('dispatches once when native, resume and Expo report the same notification tap', async () => {
  await navigateNotificationHome('unread');
  await navigateNotificationHome('unread', 'peer');
  await navigateNotificationHome('unread');
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  await navigateNotificationHome('missed');
  expect(mockDispatch).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(1600);
  await navigateNotificationHome('unread');
  expect(mockDispatch).toHaveBeenCalledTimes(3);
});
