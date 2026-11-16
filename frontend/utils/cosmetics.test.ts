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
const mockRestoreAuth = jest.fn();
jest.mock('./restoreHttpInstallAuth', () => ({ restoreHttpInstallAuth: () => mockRestoreAuth() }));
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
  mockFetch.mockReset(); mockRestoreAuth.mockReset().mockResolvedValue(false); mockGetItem.mockReset().mockResolvedValue(null); mockSetItem.mockClear(); mockOffNetwork.mockClear();
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

function ReadCosmetics(key = 'purchases') {
  mockSlots = mockMounts.get(key) || [];
  mockMounts.set(key, mockSlots); mockCursor = 0;
  const value = cosmetics.useCosmetics();
  mockEffects.splice(0).forEach(effect => effect());
  return value;
}

it.each(['frame', 'background'] as const)('keeps %s removed when an older purchases read finishes afterward', async kind => {
  const initial = {
    purchasedFrameIds: ['fire'], purchasedBackgroundIds: ['aurora-chat'],
    activeFrameId: 'fire', activeBackgroundId: 'aurora-chat',
  };
  const field = kind === 'frame' ? 'activeFrameId' : 'activeBackgroundId';
  mockGetItem.mockResolvedValue(JSON.stringify({ ownId: 'me', own: initial }));
  let finishRead!: (value: unknown) => void;
  mockFetch.mockImplementation((_url, init) => init?.method === 'PATCH'
    ? Promise.resolve({ ok: true, json: async () => ({ ok: true, entitlements: { ...initial, [field]: '' } }) })
    : new Promise(resolve => { finishRead = resolve; }));
  boot(); await flush();
  expect(ReadCosmetics()[field]).toBe(initial[field]);
  await cosmetics.setActiveCosmetic(kind, '');
  expect(ReadCosmetics()[field]).toBe('');
  finishRead({ ok: true, json: async () => ({ ok: true, entitlements: initial }) });
  await flush();
  expect(ReadCosmetics()[field]).toBe('');
});

it('ignores a purchases read started during a pending removal', async () => {
  const initial = { purchasedFrameIds: ['fire'], purchasedBackgroundIds: ['aurora-chat'], activeFrameId: 'fire', activeBackgroundId: 'aurora-chat' };
  mockGetItem.mockResolvedValue(JSON.stringify({ ownId: 'me', own: initial }));
  let finishWrite!: (value: unknown) => void;
  mockFetch.mockImplementation((_url, init) => init?.method === 'PATCH'
    ? new Promise(resolve => { finishWrite = resolve; })
    : Promise.resolve({ ok: true, json: async () => ({ ok: true, entitlements: initial }) }));
  boot(); await flush();
  const removal = cosmetics.setActiveCosmetic('frame', ''); await flush();
  cosmetics.applyRemoteFrameChange('me', '');
  await cosmetics.loadCosmetics(true);
  expect(ReadCosmetics().activeFrameId).toBe('');
  finishWrite({ ok: true, json: async () => ({ ok: true, entitlements: { ...initial, activeFrameId: '' } }) });
  await removal;
  expect(ReadCosmetics().activeFrameId).toBe('');
});

it('serializes frame and background changes and continues after a rejected write', async () => {
  const state = { purchasedFrameIds: ['fire'], purchasedBackgroundIds: ['aurora-chat'], activeFrameId: 'fire', activeBackgroundId: 'aurora-chat' };
  const pending: Array<() => void> = [];
  mockFetch.mockImplementation((_url, init) => {
    if (init?.method !== 'PATCH') return Promise.resolve({ ok: true, json: async () => ({ ok: true, entitlements: { ...state } }) });
    const body = JSON.parse(String(init.body));
    return new Promise(resolve => pending.push(() => {
      if (body.itemId === 'invalid') return resolve({ ok: false, status: 403, json: async () => ({ ok: false, error: 'not_owned' }) });
      if (body.kind === 'frame') state.activeFrameId = body.itemId;
      else state.activeBackgroundId = body.itemId;
      resolve({ ok: true, json: async () => ({ ok: true, entitlements: { ...state } }) });
    }));
  });
  boot(); await flush(); ReadCosmetics(); await flush();
  const first = cosmetics.setActiveCosmetic('frame', '');
  const second = cosmetics.setActiveCosmetic('background', '');
  await flush(); expect(pending).toHaveLength(1);
  pending.shift()!(); await first; await flush(); expect(pending).toHaveLength(1);
  pending.shift()!(); await second;
  expect(ReadCosmetics()).toMatchObject({ activeFrameId: '', activeBackgroundId: '' });
  const rejected = cosmetics.setActiveCosmetic('frame', 'invalid');
  const rejection = expect(rejected).rejects.toThrow('not_owned');
  const retry = cosmetics.setActiveCosmetic('frame', 'fire');
  await flush(); pending.shift()!(); await rejection; await flush();
  expect(pending).toHaveLength(1);
  pending.shift()!(); await retry;
  expect(ReadCosmetics()).toMatchObject({ activeFrameId: 'fire', activeBackgroundId: '' });
});

it('does not let an older forced refresh replace a newer refresh', async () => {
  const reads: Array<(value: unknown) => void> = [];
  mockFetch.mockImplementation(() => new Promise(resolve => reads.push(resolve)));
  boot(); await flush();
  const first = cosmetics.loadCosmetics(true), second = cosmetics.loadCosmetics(true);
  await flush();
  reads[1]({ ok: true, json: async () => ({ ok: true, entitlements: { activeFrameId: '', activeBackgroundId: '' } }) });
  await second;
  reads[0]({ ok: true, json: async () => ({ ok: true, entitlements: { activeFrameId: 'fire', activeBackgroundId: 'aurora-chat' } }) });
  await first;
  expect(ReadCosmetics()).toMatchObject({ activeFrameId: '', activeBackgroundId: '' });
});

it('retries an unauthorized change once after the existing installation is verified', async () => {
  mockRestoreAuth.mockResolvedValue(true);
  mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ ok: false, error: 'unauthorized' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, entitlements: { activeFrameId: '', activeBackgroundId: '' } }) });
  boot(); await flush();
  expect(await cosmetics.setActiveCosmetic('frame', '')).toMatchObject({ activeFrameId: '' });
  expect(mockRestoreAuth).toHaveBeenCalledTimes(1); expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(mockFetch.mock.calls[1][1].body).toBe(JSON.stringify({ kind: 'frame', itemId: '' }));
});
it.each([true, false])('bounds failed HTTP auth repair and preserves the saved selection (restored=%s)', async restored => {
  const initial = { activeFrameId: 'fire', activeBackgroundId: 'aurora-chat' };
  mockGetItem.mockResolvedValue(JSON.stringify({ ownId: 'me', own: initial }));
  mockRestoreAuth.mockResolvedValue(restored);
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, entitlements: initial }) })
    .mockResolvedValue({ ok: false, status: 401, json: async () => ({ ok: false, error: 'unauthorized' }) });
  boot(); await flush(); ReadCosmetics(); await flush();
  await expect(cosmetics.setActiveCosmetic('frame', '')).rejects.toThrow('unauthorized');
  expect(mockRestoreAuth).toHaveBeenCalledTimes(1);
  expect(mockFetch).toHaveBeenCalledTimes(restored ? 3 : 2);
  expect(ReadCosmetics()).toMatchObject(initial);
});

it('keeps a redeemed balance when an older wallet read arrives later', async () => {
  const initial = { activeFrameId: '', activeBackgroundId: '', rewards: { balance: 100, invitedCount: 10, feedbackSubmitted: false, feedbackGiftAvailable: false, invitePoints: 10, prices: { background: 50, frame: 100 } } };
  let finishRead!: (value: unknown) => void;
  mockFetch.mockImplementation((_url, init) => init?.method === 'POST'
    ? Promise.resolve({ ok: true, json: async () => ({ ok: true, entitlements: { ...initial, purchasedFrameIds: ['fire'], activeFrameId: 'fire', rewards: { ...initial.rewards, balance: 0 } } }) })
    : new Promise(resolve => { finishRead = resolve; }));
  boot(); await flush();
  const read = cosmetics.loadCosmetics(true); await flush();
  await cosmetics.redeemCosmetic('frame', 'fire');
  finishRead({ ok: true, json: async () => ({ ok: true, entitlements: initial }) }); await read;
  expect(ReadCosmetics()).toMatchObject({ activeFrameId: 'fire', rewards: { balance: 0 } });
  expect(mockFetch.mock.calls.find(([url]) => url.endsWith('/cosmetics/redeem'))?.[1].body)
    .toBe(JSON.stringify({ kind: 'frame', itemId: 'fire', useGift: false }));
});

it('serializes feedback, gift redemption and activation without restoring a consumed gift', async () => {
  const state = { purchasedBackgroundIds: [] as string[], activeBackgroundId: '', rewards: { balance: 0, invitedCount: 0, feedbackSubmitted: false, feedbackGiftAvailable: false, invitePoints: 10, prices: { background: 50, frame: 100 } } };
  const pending: Array<() => void> = [];
  mockFetch.mockImplementation((url, init) => new Promise(resolve => pending.push(() => {
    if (url.endsWith('/feedback')) { state.rewards.feedbackSubmitted = true; state.rewards.feedbackGiftAvailable = true; }
    if (url.endsWith('/redeem')) { state.purchasedBackgroundIds.push('poetry'); state.activeBackgroundId = 'poetry'; state.rewards.feedbackGiftAvailable = false; }
    if (init.method === 'PATCH') state.activeBackgroundId = '';
    resolve({ ok: true, json: async () => ({ ok: true, entitlements: { ...state, rewards: { ...state.rewards } } }) });
  })));
  boot(); await flush();
  const feedback = cosmetics.submitCosmeticFeedback('A useful piece of feedback.');
  const gift = cosmetics.redeemCosmetic('background', 'poetry', true);
  const remove = cosmetics.setActiveCosmetic('background', '');
  await flush(); expect(pending).toHaveLength(1);
  pending.shift()!(); await feedback; await flush(); expect(pending).toHaveLength(1);
  pending.shift()!(); await gift; await flush(); expect(pending).toHaveLength(1);
  pending.shift()!(); await remove;
  expect(ReadCosmetics()).toMatchObject({ activeBackgroundId: '', purchasedBackgroundIds: ['poetry'], rewards: { balance: 0, feedbackSubmitted: true, feedbackGiftAvailable: false } });
});

it('preserves wallet and ownership after a rejected redemption and allows a subsequent refresh', async () => {
  const initial = { activeFrameId: '', rewards: { balance: 20, invitedCount: 2, feedbackSubmitted: false, feedbackGiftAvailable: false, invitePoints: 10, prices: { background: 50, frame: 100 } } };
  mockGetItem.mockResolvedValue(JSON.stringify({ ownId: 'me', own: initial }));
  mockFetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ ok: false, error: 'insufficient_points' }) })
    .mockResolvedValue({ ok: true, json: async () => ({ ok: true, entitlements: initial }) });
  boot(); await flush();
  await expect(cosmetics.redeemCosmetic('frame', 'fire')).rejects.toThrow('insufficient_points');
  await cosmetics.loadCosmetics(true);
  expect(ReadCosmetics()).toMatchObject({ activeFrameId: '', purchasedFrameIds: [], rewards: { balance: 20 } });
});

it('discards an incomplete wallet from disk until the server supplies a valid balance', async () => {
  mockGetItem.mockResolvedValue(JSON.stringify({ ownId: 'me', own: { activeFrameId: 'fire', rewards: { balance: 100 } } }));
  mockFetch.mockRejectedValue(new Error('offline'));
  boot(); await flush();
  expect(ReadCosmetics()).toMatchObject({ activeFrameId: 'fire' });
  expect(ReadCosmetics().rewards).toBeUndefined();
});
