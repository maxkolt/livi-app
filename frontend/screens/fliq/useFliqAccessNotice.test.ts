let mockSlots: any[] = [];
let mockCursor = 0;
let mockEffects: Array<() => void> = [];
jest.mock('react', () => {
  const memo = (factory: () => unknown, deps: unknown[]) => {
    const index = mockCursor++;
    const previous = mockSlots[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) mockSlots[index] = { value: factory(), deps };
    return mockSlots[index].value;
  };
  return {
    useRef: (initial: unknown) => { const index = mockCursor++; return mockSlots[index] ?? (mockSlots[index] = { current: initial }); },
    useState: (initial: unknown) => {
      const index = mockCursor++;
      if (!(index in mockSlots)) mockSlots[index] = initial;
      return [mockSlots[index], (next: unknown) => { mockSlots[index] = next; }];
    },
    useCallback: (callback: unknown, deps: unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
      const index = mockCursor++, previous = mockSlots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        mockEffects.push(() => { previous?.cleanup?.(); mockSlots[index] = { deps, cleanup: effect() }; });
      }
    },
  };
});
import NetInfo from '@react-native-community/netinfo';
import { useFliqAccessNotice } from './useFliqAccessNotice';
const mockFetch = jest.fn();
const originalFetch = globalThis.fetch;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function RenderHook(active = true) {
  mockCursor = 0;
  const result = useFliqAccessNotice(active);
  mockEffects.splice(0).forEach(effect => effect());
  return result;
}
beforeEach(() => {
  jest.useFakeTimers(); mockSlots = []; mockEffects = [];
  globalThis.fetch = mockFetch;
  mockFetch.mockReset().mockReturnValue(new Promise(() => {}));
  jest.spyOn(NetInfo, 'fetch').mockResolvedValue({ isConnected: true, isInternetReachable: true } as any);
});
afterEach(() => {
  mockSlots.forEach(slot => slot?.cleanup?.());
  jest.restoreAllMocks(); globalThis.fetch = originalFetch; jest.useRealTimers();
});
it('shows once on a YouTube timeout and hides after ten seconds', async () => {
  RenderHook(); jest.advanceTimersByTime(8000); await flush();
  expect(RenderHook().visible).toBe(true);
  jest.advanceTimersByTime(10000);
  const hidden = RenderHook(); expect(hidden.visible).toBe(false);
  await hidden.onPlaybackIssue(-1); expect(RenderHook().visible).toBe(false);
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
it('does not warn when YouTube responds successfully', async () => {
  mockFetch.mockResolvedValue({ ok: true }); RenderHook(); await flush();
  jest.advanceTimersByTime(20000); await flush(); expect(RenderHook().visible).toBe(false);
});
it('a first frame wins over a late network check', async () => {
  let resolve!: (value: any) => void;
  jest.mocked(NetInfo.fetch).mockReturnValue(new Promise(r => { resolve = r; }));
  const hook = RenderHook(), pending = hook.onPlaybackIssue(-1);
  hook.onFirstFrame(); resolve({ isConnected: true, isInternetReachable: true }); await pending;
  expect(RenderHook().visible).toBe(false);
});
it('does not publish a late result into another visit', async () => {
  let resolve!: (value: any) => void;
  jest.mocked(NetInfo.fetch).mockReturnValue(new Promise(r => { resolve = r; }));
  const pending = RenderHook().onPlaybackIssue(-1); RenderHook(false); RenderHook(true);
  resolve({ isConnected: true, isInternetReachable: true }); await pending;
  expect(RenderHook().visible).toBe(false);
});
it('hides immediately when playback recovers', async () => {
  await RenderHook().onPlaybackIssue(-1); expect(RenderHook().visible).toBe(true);
  RenderHook().onFirstFrame(); expect(RenderHook().visible).toBe(false);
});
it('does not suggest VPN for an offline phone or an unavailable video', async () => {
  jest.mocked(NetInfo.fetch).mockResolvedValue({ isConnected: false, isInternetReachable: false } as any);
  await RenderHook().onPlaybackIssue(-1); expect(RenderHook().visible).toBe(false);
  jest.mocked(NetInfo.fetch).mockResolvedValue({ isConnected: true, isInternetReachable: true } as any);
  await RenderHook().onPlaybackIssue(150); expect(RenderHook().visible).toBe(false);
});
it('aborts its request and clears timers when leaving Fliq', () => {
  RenderHook(); const signal = mockFetch.mock.calls[0][1].signal;
  RenderHook(false); expect(signal.aborted).toBe(true); expect(jest.getTimerCount()).toBe(0);
});
