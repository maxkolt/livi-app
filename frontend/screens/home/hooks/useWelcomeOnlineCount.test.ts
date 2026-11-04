import type { WelcomePresencePayload } from '../../../sockets/modules/types';
const mockSlots: unknown[] = [];
let mockCursor = 0;
let mockPendingEffects: Array<() => void> = [];
let mockSkip = false;
let mockCached: WelcomePresencePayload | null = null;
let mockPresence: (data: WelcomePresencePayload) => void;
let mockConnected: () => void;
let mockNetwork: (state: { isConnected: boolean; isInternetReachable?: boolean; type: string }) => void;
const mockEvents = new Map<string, () => void>();
const mockFetch = jest.fn();
const mockApply = jest.fn((data: WelcomePresencePayload) => data);
const mockSync = jest.fn();
jest.mock('react', () => ({
  useState: (initial: unknown) => {
    const slot = mockCursor++;
    if (!(slot in mockSlots)) mockSlots[slot] = typeof initial === 'function' ? initial() : initial;
    return [mockSlots[slot], (value: unknown) => { mockSlots[slot] = typeof value === 'function' ? value(mockSlots[slot]) : value; }];
  },
  useRef: (current: unknown) => {
    const slot = mockCursor++;
    if (!(slot in mockSlots)) mockSlots[slot] = { current };
    return mockSlots[slot];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (callback: () => void | (() => void), deps: unknown[]) => {
    const slot = mockCursor++;
    const previous = mockSlots[slot] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
    mockPendingEffects.push(() => {
      previous?.cleanup?.();
      mockSlots[slot] = { deps, cleanup: callback() };
    });
  },
}));
jest.mock('react-native', () => ({
  AppState: { addEventListener: (_name: string, fn: (state: string) => void) => {
    mockEvents.set('appState', () => fn('active')); return { remove: () => mockEvents.delete('appState') };
  } },
  DeviceEventEmitter: { addListener: (name: string, fn: () => void) => {
    mockEvents.set(name, fn); return { remove: () => mockEvents.delete(name) };
  } },
}));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: {
  addEventListener: (fn: typeof mockNetwork) => { mockNetwork = fn; return jest.fn(); },
} }));
jest.mock('../../../sockets/socket', () => ({
  API_BASE: 'https://api.test',
  onConnected: (fn: () => void) => { mockConnected = fn; return jest.fn(); },
  onWelcomePresence: (fn: typeof mockPresence) => { mockPresence = fn; if (mockCached) fn(mockCached); return jest.fn(); },
  getWelcomePresenceSnapshot: () => mockCached,
  beginWelcomePresenceRefresh: () => ({ query: '', apply: (data: WelcomePresencePayload) => mockApply(data) }),
  refreshWelcomePresenceSnapshot: () => mockSync(),
}));
jest.mock('../../../utils/globalEvents', () => ({ shouldSkipHomeUiSettle: () => mockSkip }));
jest.mock('../../../utils/fetchWithTimeout', () => ({ fetchWithTimeout: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('../../../utils/i18n', () => ({}));
import { useWelcomeOnlineCount } from './useWelcomeOnlineCount';
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const response = (data: WelcomePresencePayload) => ({ ok: true, json: async () => data });
function MountWelcomeOnlineCount(exclude = 'me', enabled = true) {
  mockCursor = 0; mockPendingEffects = [];
  const hook = useWelcomeOnlineCount(enabled, exclude);
  mockPendingEffects.forEach(effect => effect());
  return hook;
}
function cleanup() {
  mockSlots.forEach(slot => (slot as { cleanup?: () => void } | undefined)?.cleanup?.());
}
beforeEach(() => {
  jest.useFakeTimers(); mockSlots.length = 0; mockCursor = 0; mockEvents.clear();
  mockSkip = false; mockCached = null; mockFetch.mockReset(); mockApply.mockClear(); mockSync.mockClear();
  mockFetch.mockResolvedValue(response({ ok: true, list: ['me', 'peer'] }));
});
afterEach(() => { cleanup(); jest.clearAllTimers(); jest.useRealTimers(); });

it('fetches the first number even during a UI transition and accepts later socket updates without dropping them', async () => {
  mockSkip = true;
  MountWelcomeOnlineCount(); await flush();
  expect(mockSlots[0]).toBe(1);
  mockPresence({ ok: true, list: ['me'] });
  expect(mockSlots[0]).toBe(0);
});

it('retries a failed cold VPN read and excludes duplicates and the current user', async () => {
  mockFetch.mockRejectedValueOnce(new Error('VPN timeout'))
    .mockResolvedValueOnce(response({ ok: true, list: ['me', 'peer', 'peer', { id: 'other' }, { id: '' }] }));
  MountWelcomeOnlineCount(); await flush();
  expect(mockSlots[0]).toBeNull();
  await jest.advanceTimersByTimeAsync(1000);
  expect(mockSlots[0]).toBe(2);
});

it('uses the cached server list on remount and recalculates exclusions from the complete list', async () => {
  mockCached = { ok: true, list: ['me', 'new-me', 'peer', 'peer'] };
  mockFetch.mockRejectedValue(new Error('offline'));
  const first = MountWelcomeOnlineCount();
  expect(first.onlineCount).toBe(2);
  await flush();
  MountWelcomeOnlineCount('new-me');
  expect(mockSlots[0]).toBe(2);
  expect((mockSlots[1] as Array<{ id: string }>).map(peer => peer.id)).toEqual(['me', 'peer']);
});

it('abandons a stalled response body on native VPN route change and rejects its late result', async () => {
  let finishBody!: (data: WelcomePresencePayload) => void;
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) })
    .mockResolvedValueOnce(response({ ok: true, list: ['me', 'new-peer', 'other'] }));
  MountWelcomeOnlineCount(); await flush();
  const oldSignal = mockFetch.mock.calls[0][1].signal as AbortSignal;
  mockEvents.get('LiviNetRouteChanged')!();
  expect(oldSignal.aborted).toBe(true);
  await jest.advanceTimersByTimeAsync(400);
  expect(mockSlots[0]).toBe(2);
  const stale = { ok: true, list: ['me', 'stale'] };
  finishBody(stale); await flush();
  expect(mockSlots[0]).toBe(2);
  expect(mockApply).not.toHaveBeenCalledWith(stale);
});

it('refreshes on reconnect, resume and network return even when the VPN blocks the OS internet probe', async () => {
  MountWelcomeOnlineCount(); await flush();
  mockNetwork({ isConnected: false, type: 'wifi' });
  mockNetwork({ isConnected: true, isInternetReachable: false, type: 'wifi' });
  await jest.advanceTimersByTimeAsync(400);
  expect(mockFetch).toHaveBeenCalledTimes(2);
  mockConnected(); await flush();
  mockEvents.get('appState')!(); await flush();
  expect(mockFetch).toHaveBeenCalledTimes(4);
});

it('keeps the last confirmed number on a transient error and cancels subscriptions on background/unmount', async () => {
  MountWelcomeOnlineCount(); await flush();
  expect(mockSlots[0]).toBe(1);
  mockFetch.mockRejectedValue(new Error('route switching'));
  mockConnected(); await flush();
  expect(mockSlots[0]).toBe(1);
  MountWelcomeOnlineCount('me', false);
  expect(mockEvents.size).toBe(0);
  const requests = mockFetch.mock.calls.length;
  await jest.advanceTimersByTimeAsync(120_000);
  expect(mockFetch).toHaveBeenCalledTimes(requests);
});
