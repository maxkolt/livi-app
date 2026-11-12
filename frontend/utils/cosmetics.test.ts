let mockSlots: unknown[] = [];
let mockCursor = 0;
let mockEffects: Array<() => void> = [];
const mockMounts = new Map<string, unknown[]>();
const mockFetch = jest.fn();
const mockGetItem = jest.fn();
const mockSetItem = jest.fn<Promise<void>, unknown[]>(async () => {});
const mockEvents = new Map<string, () => void>();
let mockNetwork: (state: { isConnected: boolean; isInternetReachable?: boolean; type: string }) => void;
const mockOffNetwork = jest.fn();
jest.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = mockCursor++, slots = mockSlots;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  },
  useEffect: (callback: () => void | (() => void), deps: unknown[]) => {
    const index = mockCursor++, slots = mockSlots;
    const previous = slots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (previous && deps.length === previous.deps.length && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
    slots[index] = { deps };
    mockEffects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
  },
}));
jest.mock('react-native', () => ({
  AppState: { addEventListener: (_event: string, listener: (state: string) => void) => {
    mockEvents.set('resume', () => listener('active')); return { remove: () => mockEvents.delete('resume') };
  } },
  DeviceEventEmitter: { addListener: (event: string, listener: () => void) => {
    mockEvents.set(event, listener); return { remove: () => mockEvents.delete(event) };
  } },
}));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: {
  addEventListener: (listener: typeof mockNetwork) => { mockNetwork = listener; return mockOffNetwork; },
} }));
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: {
  getItem: (...args: unknown[]) => mockGetItem(...args), setItem: (...args: unknown[]) => mockSetItem(...args),
} }));
jest.mock('../sockets/modules/constants', () => ({ API_BASE: 'https://api.test' }));
jest.mock('../sockets/modules/authState', () => ({ getCurrentUserId: () => 'me' }));
jest.mock('./installId', () => ({ getInstallAuthHeaders: async () => ({ 'x-install-id': 'test' }) }));
jest.mock('./fetchWithTimeout', () => ({ fetchWithTimeout: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('./cosmeticCatalog', () => ({ getCosmeticBackground: () => null }));
jest.mock('./chatWallpaper', () => ({ DEFAULT_DARK_WALLPAPER_ID: 'default', setChatWallpaperId: jest.fn() }));

let cosmetics: typeof import('./cosmetics');
const response = (frame: string) => ({ ok: true, json: async () => ({ ok: true, activeFrameId: frame }) });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function mount(id = 'peer', key = 'avatar') {
  mockSlots = mockMounts.get(key) || [];
  mockMounts.set(key, mockSlots); mockCursor = 0;
  const frame = cosmetics.useUserActiveFrame(id);
  mockEffects.splice(0).forEach(effect => effect());
  return frame;
}
function unmount(key: string) {
  mockMounts.get(key)?.forEach(slot => (slot as { cleanup?: () => void } | undefined)?.cleanup?.());
  mockMounts.delete(key);
}
beforeEach(() => {
  jest.useFakeTimers(); jest.resetModules(); mockMounts.clear(); mockEvents.clear(); mockEffects = [];
  mockFetch.mockReset(); mockGetItem.mockReset().mockResolvedValue(null); mockSetItem.mockClear(); mockOffNetwork.mockClear();
});
afterEach(() => {
  [...mockMounts.keys()].forEach(unmount); jest.clearAllTimers(); jest.useRealTimers();
});
function boot() { cosmetics = require('./cosmetics'); }

it('loads a frame after a cold VPN failure without reopening the online block', async () => {
  mockFetch.mockRejectedValueOnce(new Error('VPN timeout')).mockResolvedValue(response('fire'));
  boot(); expect(mount()).toBe(''); await flush();
  await jest.advanceTimersByTimeAsync(1000);
  expect(mount()).toBe('fire');
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

it('shows a disk-cached frame during outage, cancels a stuck body on route change and rejects its late result', async () => {
  mockGetItem.mockResolvedValue(JSON.stringify({ frames: { peer: 'fire' } }));
  let finish!: (body: object) => void;
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) })
    .mockResolvedValue(response('frost'));
  boot(); mount(); await flush();
  expect(mount()).toBe('fire');
  const signal = mockFetch.mock.calls[0][1].signal as AbortSignal;
  mockEvents.get('LiviNetRouteChanged')!();
  expect(signal.aborted).toBe(true);
  await jest.advanceTimersByTimeAsync(400);
  expect(mount()).toBe('frost');
  finish({ ok: true, activeFrameId: '' }); await flush();
  expect(mount()).toBe('frost');
});

it('keeps a newer socket frame when a pre-switch HTTP request finishes later', async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  mockFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  boot(); mount(); await flush();
  cosmetics.applyRemoteFrameChange('peer', 'diamond');
  expect(mount()).toBe('diamond');
  finish(response('')); await flush();
  expect(mount()).toBe('diamond');
});

it('shares reads for repeated online avatars and releases network listeners after the last unmount', async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  mockFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  boot(); mount('peer', 'normal'); mount('peer', 'compact'); await flush();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const signal = mockFetch.mock.calls[0][1].signal as AbortSignal;
  unmount('normal'); expect(signal.aborted).toBe(false);
  finish(response('frost')); await flush();
  expect(mount('peer', 'compact')).toBe('frost');
  unmount('compact');
  expect(mockEvents.size).toBe(0); expect(mockOffNetwork).toHaveBeenCalledTimes(1);
});

it('does not show the previous online user frame when a row changes identity during a VPN failure', async () => {
  mockFetch.mockRejectedValue(new Error('offline'));
  boot(); cosmetics.applyRemoteFrameChange('first', 'fire');
  expect(mount('first')).toBe('fire'); await flush();
  expect(mount('second')).toBe(''); await flush();
  expect(mount('second')).toBe('');
});

it('discards an abandoned request when the online block is closed and reopened', async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  mockFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue(response('frost'));
  boot(); mount(); await flush();
  const signal = mockFetch.mock.calls[0][1].signal as AbortSignal;
  unmount('avatar'); expect(signal.aborted).toBe(true);
  finish(response('fire')); await flush();
  expect(mount()).toBe(''); await flush();
  expect(mount()).toBe('frost');
});

it('refreshes on reconnect, resume and network return even if a VPN blocks the OS probe', async () => {
  mockFetch.mockResolvedValue(response('fire'));
  boot(); mount(); await flush();
  expect(mount()).toBe('fire');
  mockFetch.mockResolvedValue(response('diamond'));
  cosmetics.refreshObservedUserFrames(); await flush();
  expect(mount()).toBe('diamond');
  mockEvents.get('resume')!(); await flush();
  mockNetwork({ isConnected: false, type: 'wifi' });
  mockNetwork({ isConnected: true, isInternetReachable: false, type: 'wifi' });
  await jest.advanceTimersByTimeAsync(400);
  expect(mockFetch).toHaveBeenCalledTimes(4);
});

it('treats malformed responses as failures and clears a frame only after a confirmed empty value', async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) }).mockResolvedValue(response(''));
  boot(); cosmetics.applyRemoteFrameChange('peer', 'fire'); mount(); await flush();
  cosmetics.refreshObservedUserFrames(); await flush();
  expect(mount()).toBe('fire');
  await jest.advanceTimersByTimeAsync(1000);
  expect(mount()).toBe('');
});
