const mockGetSize = jest.fn();
jest.mock('react-native', () => ({ Image: { getSize: mockGetSize } }));
import {
  chatPhotoPreviewLayout, peekChatPhotoDimensions, rememberChatPhotoDimensions,
  resolveChatPhotoDimensions, validChatPhotoDimensions,
} from './chatPhotoDimensions';

beforeEach(() => { mockGetSize.mockReset(); });

it.each([
  ['portrait', 900, 1600], ['landscape', 1600, 900], ['square', 1200, 1200],
  ['panorama', 6000, 1000], ['long screenshot', 1000, 9000],
])('uses the %s natural ratio inside phone viewport limits', (_name, width, height) => {
  for (const viewport of [{ width: 320, height: 720 }, { width: 360, height: 780 }, { width: 430, height: 932 }]) {
    const bounds = chatPhotoPreviewLayout(viewport.width, { width, height }, viewport.height);
    expect(bounds.width / bounds.height).toBeCloseTo(width / height, 10);
    expect(bounds.width).toBeLessThanOrEqual(chatPhotoPreviewLayout(viewport.width).width);
    expect(bounds.height).toBeLessThanOrEqual(Math.min(480, viewport.height * 0.6));
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
  }
});

it.each([[0, 100], [100, 0], [-1, 200], [NaN, 20], [20, Infinity], [32769, 20], ['100', 200], [null, 200]])(
  'rejects invalid dimensions %s/%s', (width, height) => {
    expect(validChatPhotoDimensions(width, height)).toBeNull();
  },
);

it('uses metadata before first paint without probing or fetching an image', async () => {
  const uri = 'https://photo.test/known.jpg';
  const ready = resolveChatPhotoDimensions(uri, 900, 1600);
  expect(peekChatPhotoDimensions(uri)).toEqual({ width: 900, height: 1600 });
  expect(await ready).toEqual({ width: 900, height: 1600 });
  expect(mockGetSize).not.toHaveBeenCalled();
  expect(await resolveChatPhotoDimensions(uri)).toEqual({ width: 900, height: 1600 });
  expect(mockGetSize).not.toHaveBeenCalled();
});

it('coalesces old-photo probes and reuses dimensions when the conversation opens again', async () => {
  let finish!: (width: number, height: number) => void;
  mockGetSize.mockImplementation((_uri: string, success: typeof finish) => { finish = success; });
  const first = resolveChatPhotoDimensions('https://photo.test/legacy.jpg');
  const second = resolveChatPhotoDimensions('https://photo.test/legacy.jpg');
  expect(mockGetSize).toHaveBeenCalledTimes(1);
  finish(800, 1400);
  expect(await first).toEqual({ width: 800, height: 1400 });
  expect(await second).toEqual({ width: 800, height: 1400 });
  expect(await resolveChatPhotoDimensions('https://photo.test/legacy.jpg')).toEqual({ width: 800, height: 1400 });
  expect(mockGetSize).toHaveBeenCalledTimes(1);
});

it('does not overwrite new sender metadata with a late probe', async () => {
  let finish!: (width: number, height: number) => void;
  mockGetSize.mockImplementation((_uri: string, success: typeof finish) => { finish = success; });
  const uri = 'https://photo.test/late.jpg';
  const oldProbe = resolveChatPhotoDimensions(uri);
  expect(await resolveChatPhotoDimensions(uri, 900, 1500)).toEqual({ width: 900, height: 1500 });
  finish(400, 300);
  expect(await oldProbe).toEqual({ width: 900, height: 1500 });
  expect(peekChatPhotoDimensions(uri)).toEqual({ width: 900, height: 1500 });
});

it('allows retry after a failed legacy lookup and keeps a bounded cache', async () => {
  mockGetSize.mockImplementationOnce((_uri, _success, failure) => { failure(new Error('offline')); });
  expect(await resolveChatPhotoDimensions('https://photo.test/retry.jpg')).toBeNull();
  mockGetSize.mockImplementationOnce((_uri, success) => { success(1000, 2000); });
  expect(await resolveChatPhotoDimensions('https://photo.test/retry.jpg')).toEqual({ width: 1000, height: 2000 });
  for (let i = 0; i < 257; i++) rememberChatPhotoDimensions(`file:///bounded-${i}.jpg`, 100, 200);
  expect(peekChatPhotoDimensions('file:///bounded-0.jpg')).toBeNull();
  expect(peekChatPhotoDimensions('file:///bounded-256.jpg')).toEqual({ width: 100, height: 200 });
});
