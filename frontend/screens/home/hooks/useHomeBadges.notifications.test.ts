// Exercise the real hook callbacks with controlled storage, native inbox and socket timing.
const mockState: unknown[] = [];
const mockEffects: Array<() => void | (() => void)> = [];
let mockStateIndex = 0;
let mockReceived: (message: { id: string; from: string }) => void;
let mockPending: string[] = [];
const mockBatch = jest.fn();
const mockCount = jest.fn();
jest.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = mockStateIndex++;
    mockState[index] = initial;
    return [initial, (action: unknown) => {
      mockState[index] = typeof action === 'function' ? action(mockState[index]) : action;
    }];
  },
  useEffect: (effect: () => void) => { mockEffects.push(effect); },
  useCallback: (fn: unknown) => fn,
  useRef: (current: unknown) => ({ current }),
}));
jest.mock('react-native', () => ({
  AppState: { currentState: 'active' }, Platform: { OS: 'android' },
  NativeModules: { LiviAppModule: { getAndClearPendingUnreadMessages: async () => mockPending } },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}),
}));
jest.mock('../../../sockets/socket', () => ({
  __esModule: true, default: { on: jest.fn(), off: jest.fn() },
  onMessageReceived: (fn: typeof mockReceived) => { mockReceived = fn; return () => {}; },
  onMessageReadReceipt: () => () => {}, onMessageDeleted: () => () => {}, onMessagesDeleted: () => () => {},
  getUnreadCount: (...args: unknown[]) => mockCount(...args),
  getUnreadCounts: (...args: unknown[]) => mockBatch(...args),
}));
jest.mock('../../../utils/globalEvents', () => ({
  onMissedIncrement: () => () => {}, onMissedClear: () => () => {},
  onMissedFetchedFromServer: () => () => {}, onChatOpened: () => () => {},
}));
jest.mock('../../../utils/pushNotifications', () => ({
  applyPendingMissedCallsFromNative: async () => {}, clearMissedBadgeCleared: async () => {},
  getMissedCountByUserFromNative: async () => ({}), syncAppBadgeFromMissedCount: async () => {},
}));
jest.mock('../../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.mock('../constants', () => ({ MISSED_CALLS_KEY: 'missed', UNREAD_BY_USER_KEY: 'unread' }));
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useHomeBadges } from './useHomeBadges';
import type { Friend } from '../types';
let cleanup: Array<void | (() => void)>;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function MountHomeBadges() {
  const friends = [{ id: 'peer', online: false }] as Friend[];
  const hook = useHomeBadges({ friends, friendsRef: { current: friends } });
  cleanup = mockEffects.map(effect => effect());
  return hook;
}
beforeEach(() => {
  jest.useFakeTimers(); mockState.length = 0; mockEffects.length = 0; mockStateIndex = 0; mockPending = [];
  (global as typeof global & { __currentChatPeerId?: string }).__currentChatPeerId = undefined;
  mockBatch.mockReset().mockResolvedValue({ ok: true, counts: { peer: 1 } });
  mockCount.mockReset().mockResolvedValue({ ok: true, count: 1 });
  (AsyncStorage.getItem as jest.Mock).mockReset().mockResolvedValue(null);
});
afterEach(() => { cleanup?.forEach(off => off?.()); jest.clearAllTimers(); jest.useRealTimers(); });
it('keeps one unread when a killed-app native push is followed by socket replay', async () => {
  const hook = MountHomeBadges(); await flush(); mockPending = ['peer'];
  await hook.refreshBadgesOnAppResume();
  expect(mockState[0]).toEqual({ peer: 1 });
  mockReceived({ id: 'message-1', from: 'peer' });
  expect(mockState[0]).toEqual({ peer: 1 });
  await jest.advanceTimersByTimeAsync(3000);
  expect(mockState[0]).toEqual({ peer: 1 });
});
it('imports a killed-app push before declaring the initial unread cache ready', async () => {
  mockPending = ['peer'];
  MountHomeBadges();
  expect(mockState[3]).toBe(false);
  await flush();
  expect(mockState[0]).toEqual({ peer: 1 });
  expect(mockState[3]).toBe(true);
  mockReceived({ id: 'cold-replay', from: 'peer' });
  expect(mockState[0]).toEqual({ peer: 1 });
});
it('does not add a replay to a disk count or an already received server snapshot', async () => {
  (AsyncStorage.getItem as jest.Mock).mockImplementation(async key => key === 'unread' ? '{"peer":1}' : null);
  MountHomeBadges(); await flush();
  expect(mockState[0]).toEqual({ peer: 1 });
  await jest.advanceTimersByTimeAsync(150);
  mockReceived({ id: 'already-counted', from: 'peer' });
  mockReceived({ id: 'already-counted', from: 'peer' });
  expect(mockState[0]).toEqual({ peer: 1 });
});
it('shows a badge immediately and reconciles two distinct messages to the exact server count', async () => {
  MountHomeBadges(); await flush();
  mockReceived({ id: 'one', from: 'peer' });
  mockReceived({ id: 'two', from: 'peer' });
  expect(mockState[0]).toEqual({ peer: 1 });
  mockBatch.mockResolvedValue({ ok: true, counts: { peer: 2 } });
  mockCount.mockResolvedValue({ ok: true, count: 2 });
  await jest.advanceTimersByTimeAsync(150);
  expect(mockState[0]).toEqual({ peer: 2 });
  await jest.advanceTimersByTimeAsync(3000);
  expect(mockState[0]).toEqual({ peer: 2 });
});
it('retries after the server write catches up and retains the badge while offline', async () => {
  mockBatch.mockResolvedValue({ ok: true, counts: { peer: 0 } });
  mockCount.mockResolvedValue({ ok: true, count: 2 });
  MountHomeBadges(); await flush(); mockReceived({ id: 'new', from: 'peer' });
  await jest.advanceTimersByTimeAsync(150);
  expect(mockState[0]).toEqual({ peer: 1 });
  await jest.advanceTimersByTimeAsync(2600);
  expect(mockState[0]).toEqual({ peer: 2 });
  mockBatch.mockRejectedValue(new Error('offline')); mockCount.mockRejectedValue(new Error('offline'));
  mockReceived({ id: 'offline-replay', from: 'peer' });
  await jest.advanceTimersByTimeAsync(4000);
  expect(mockState[0]).toEqual({ peer: 2 });
});
it('does not mark the currently open chat unread on replay', async () => {
  MountHomeBadges(); await flush();
  (global as typeof global & { __currentChatPeerId?: string }).__currentChatPeerId = 'peer';
  mockReceived({ id: 'open-chat', from: 'peer' });
  expect((mockState[0] as Record<string, number>).peer || 0).toBe(0);
});
