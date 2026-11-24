const mockFromURI = jest.fn();
const mockDecode = jest.fn();
let mockPressure: () => void;
jest.mock('@shopify/react-native-skia', () => ({
  Skia: { Data: { fromURI: (url: string) => mockFromURI(url) }, Image: { MakeImageFromEncoded: (data: unknown) => mockDecode(data) } },
}));
jest.mock('../../utils/memoryPressure', () => ({
  subscribeMemoryPressure: (listener: () => void) => { mockPressure = listener; },
}));
import { fliqAmbientImages } from './fliqAmbientImages';
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function image() { return { width: () => 2, height: () => 2, dispose: jest.fn() }; }
beforeEach(() => {
  jest.useFakeTimers(); fliqAmbientImages.clear(); mockFromURI.mockReset(); mockDecode.mockReset();
});
afterEach(() => { fliqAmbientImages.clear(); jest.useRealTimers(); });

it('releases encoded data after success and shares the image safely', async () => {
  const data = { dispose: jest.fn() }, decoded = image(), first = jest.fn(), second = jest.fn();
  mockFromURI.mockResolvedValue(data); mockDecode.mockReturnValue(decoded);
  fliqAmbientImages.request('a', first); fliqAmbientImages.request('a', second); await flush();
  expect(mockFromURI).toHaveBeenCalledTimes(1);
  expect(data.dispose).toHaveBeenCalledTimes(1);
  expect(first).toHaveBeenCalledWith(decoded); expect(second).toHaveBeenCalledWith(decoded);
  mockPressure(); expect(decoded.dispose).not.toHaveBeenCalled();
});
it('releases encoded data when decoding fails', async () => {
  const data = { dispose: jest.fn() }, listener = jest.fn();
  mockFromURI.mockResolvedValue(data); mockDecode.mockImplementation(() => { throw Error('decode'); });
  fliqAmbientImages.request('a', listener); await flush();
  expect(data.dispose).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith(null);
});
it('skips stale decoding and releases encoded data after cancellation', async () => {
  let finish!: (data: unknown) => void;
  const data = { dispose: jest.fn() }, listener = jest.fn();
  mockFromURI.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const cancel = fliqAmbientImages.request('a', listener); await flush();
  cancel(); finish(data); await flush();
  expect(mockDecode).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  expect(data.dispose).toHaveBeenCalledTimes(1);
});
it('evicts unpublished prefetches under memory pressure', async () => {
  const data = { dispose: jest.fn() }, decoded = image();
  mockFromURI.mockResolvedValue(data); mockDecode.mockReturnValue(decoded);
  fliqAmbientImages.prefetch(['a']); await flush();
  mockPressure();
  expect(decoded.dispose).toHaveBeenCalledTimes(1);
});
