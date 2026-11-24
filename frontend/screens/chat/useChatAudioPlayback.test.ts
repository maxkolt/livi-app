const mockSlots: unknown[] = [];
let mockCursor = 0;
let mockEffects: Array<() => void | (() => void)> = [];
let mockCleanups: Array<() => void> = [];
const mockCreate = jest.fn(), mockCache = jest.fn();
jest.mock('react', () => ({
  useRef: (current: unknown) => { const i = mockCursor++; return mockSlots[i] ?? (mockSlots[i] = { current }); },
  useState: (initial: unknown) => { const i = mockCursor++; if (!(i in mockSlots)) mockSlots[i] = initial; return [mockSlots[i], (v: unknown) => { mockSlots[i] = typeof v === 'function' ? v(mockSlots[i]) : v; }]; },
  useCallback: (fn: unknown) => { mockCursor++; return fn; },
  useEffect: (effect: () => void | (() => void)) => { mockCursor++; mockEffects.push(effect); },
}));
jest.mock('expo-av', () => ({ Audio: { setAudioModeAsync: async () => {}, Sound: { createAsync: (...args: unknown[]) => mockCreate(...args) } } }));
jest.mock('./chatVoiceCache', () => ({ ensureVoiceCachedToLocalFile: (...args: unknown[]) => mockCache(...args) }));
import { useChatAudioPlayback } from './useChatAudioPlayback';
import { getActiveChatPlaybackKey, resetChatPlaybackCoordinatorForTests } from './chatPlaybackCoordinator';
import type { ChatMessage } from './chatMessageTypes';
const message = (id: string, uri = 'file:///voice.m4a') => ({ id, type: 'audio', uri }) as ChatMessage;
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function sound() { return { stopAsync: jest.fn(async () => {}), unloadAsync: jest.fn(async () => {}), playAsync: jest.fn(async () => {}) }; }
function PlaybackHarness() {
  const hook = useChatAudioPlayback({ messages: [], resolveMediaUri: uri => uri || '' });
  mockEffects.splice(0).forEach(effect => { const cleanup = effect(); if (cleanup) mockCleanups.push(cleanup); });
  return hook;
}
function unmount() { mockCleanups.splice(0).forEach(cleanup => cleanup()); }
beforeEach(() => { mockSlots.length = 0; mockCursor = 0; mockEffects = []; mockCleanups = []; mockCreate.mockReset(); mockCache.mockReset(); resetChatPlaybackCoordinatorForTests(); });
afterEach(unmount);

it('cannot create another native player when unmounted during the previous stop', async () => {
  const first = sound(), stopped = deferred();
  mockCreate.mockResolvedValue({ sound: first });
  const hook = PlaybackHarness(); await hook.togglePlayAudioMessage(message('first'));
  first.stopAsync.mockImplementation(() => stopped.promise);
  const second = hook.togglePlayAudioMessage(message('second'));
  unmount(); stopped.resolve(); await second;
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(first.unloadAsync).toHaveBeenCalledTimes(1);
  expect(getActiveChatPlaybackKey()).toBeNull();
});
it('does not create a player after an obsolete download finishes', async () => {
  const download = deferred<string>(); mockCache.mockReturnValue(download.promise);
  const hook = PlaybackHarness(); const play = hook.togglePlayAudioMessage(message('a', 'https://api.test/voice'));
  await flush(); unmount(); download.resolve('file:///cached.m4a'); await play;
  expect(mockCreate).not.toHaveBeenCalled(); expect(getActiveChatPlaybackKey()).toBeNull();
});
it('unloads a late-created sound without ever starting it', async () => {
  const created = deferred<{ sound: ReturnType<typeof sound> }>(), s = sound(); mockCreate.mockReturnValue(created.promise);
  const hook = PlaybackHarness(); const play = hook.togglePlayAudioMessage(message('a'));
  await flush(); unmount(); created.resolve({ sound: s }); await play;
  expect(mockCreate.mock.calls[0][1]).toEqual({ shouldPlay: false });
  expect(s.playAsync).not.toHaveBeenCalled(); expect(s.unloadAsync).toHaveBeenCalledTimes(1);
});
it('keeps only the latest tap when the previous sound is still stopping', async () => {
  const first = sound(), last = sound(), stopped = deferred();
  mockCreate.mockResolvedValueOnce({ sound: first }).mockResolvedValueOnce({ sound: last });
  const hook = PlaybackHarness(); await hook.togglePlayAudioMessage(message('first'));
  first.stopAsync.mockImplementation(() => stopped.promise);
  const obsolete = hook.togglePlayAudioMessage(message('obsolete'));
  await hook.togglePlayAudioMessage(message('last')); stopped.resolve(); await obsolete;
  expect(mockCreate).toHaveBeenCalledTimes(2); expect(getActiveChatPlaybackKey()).toBe('audio:last');
});
it('ignores completion callbacks from the old sound and unloads on play failure', async () => {
  const first = sound(), last = sound();
  mockCreate.mockResolvedValueOnce({ sound: first }).mockResolvedValueOnce({ sound: last });
  const hook = PlaybackHarness(); await hook.togglePlayAudioMessage(message('first'));
  const oldStatus = mockCreate.mock.calls[0][2];
  await hook.togglePlayAudioMessage(message('last')); oldStatus({ isLoaded: true, didJustFinish: true });
  expect(getActiveChatPlaybackKey()).toBe('audio:last');
  await hook.stopAudioPlayback();
  const bad = sound(); bad.playAsync.mockRejectedValue(new Error('failed')); mockCreate.mockResolvedValue({ sound: bad });
  await hook.togglePlayAudioMessage(message('bad'));
  expect(bad.unloadAsync).toHaveBeenCalledTimes(1); expect(getActiveChatPlaybackKey()).toBeNull();
});
