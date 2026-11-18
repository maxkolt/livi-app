const mockSlots: unknown[] = [];
let mockCursor = 0;
let mockEffects: Array<() => void> = [];
const mockGetSize = jest.fn();
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: (initial: unknown) => {
    const index = mockCursor++;
    if (!(index in mockSlots)) mockSlots[index] = typeof initial === 'function' ? initial() : initial;
    return [mockSlots[index], (value: unknown) => { mockSlots[index] = value; }];
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = mockCursor++;
    const previous = mockSlots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    mockSlots[index] = { deps };
    mockEffects.push(() => { previous?.cleanup?.(); mockSlots[index] = { deps, cleanup: effect() }; });
  },
}));
jest.mock('react-native', () => ({ Image: { getSize: mockGetSize } }));
jest.mock('expo-image', () => ({ Image: 'ExpoImage' }));
import { useChatPhotoPreviewLayout } from './ChatPhotoPreviewImage';
import { chatPhotoPreviewLayout } from './chatPhotoDimensions';

function RenderPhotoLayout(uri: string, width?: number, height?: number) {
  mockCursor = 0;
  const result = useChatPhotoPreviewLayout(uri, width, height, 360, 780);
  mockEffects.splice(0).forEach(effect => effect());
  return result;
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
beforeEach(() => {
  mockSlots.length = 0;
  mockEffects = [];
  mockGetSize.mockReset();
});
afterEach(() => mockSlots.forEach(slot => (slot as { cleanup?: () => void } | undefined)?.cleanup?.()));

it('keeps natural first-paint geometry through optimistic local to remote echo and navigation remount', () => {
  const before = RenderPhotoLayout('file:///optimistic-photo.jpg', 900, 1600);
  const echoed = RenderPhotoLayout('https://photo.test/echoed-photo.jpg', 900, 1600);
  expect(echoed).toEqual(before);
  mockSlots.length = 0;
  expect(RenderPhotoLayout('https://photo.test/echoed-photo.jpg', 900, 1600)).toEqual(before);
  expect(mockGetSize).not.toHaveBeenCalled();
});

it('probes an old image once then uses its cached natural bounds when reopening the chat', async () => {
  let finish!: (width: number, height: number) => void;
  mockGetSize.mockImplementation((_uri, success) => { finish = success; });
  const uri = 'https://photo.test/hook-old.jpg';
  expect(RenderPhotoLayout(uri)).toEqual(chatPhotoPreviewLayout(360));
  finish(900, 1600);
  await flush();
  const natural = RenderPhotoLayout(uri);
  expect(natural.width / natural.height).toBeCloseTo(900 / 1600, 10);
  mockSlots.length = 0;
  expect(RenderPhotoLayout(uri)).toEqual(natural);
  expect(mockGetSize).toHaveBeenCalledTimes(1);
});

it('ignores an old URI dimension callback after a reused row changes its image', async () => {
  const callbacks = new Map<string, (width: number, height: number) => void>();
  mockGetSize.mockImplementation((uri, success) => { callbacks.set(uri, success); });
  RenderPhotoLayout('https://photo.test/hook-a.jpg');
  RenderPhotoLayout('https://photo.test/hook-b.jpg');
  callbacks.get('https://photo.test/hook-a.jpg')!(600, 3000);
  await flush();
  expect(RenderPhotoLayout('https://photo.test/hook-b.jpg')).toEqual(chatPhotoPreviewLayout(360));
  callbacks.get('https://photo.test/hook-b.jpg')!(1000, 1000);
  await flush();
  const current = RenderPhotoLayout('https://photo.test/hook-b.jpg');
  expect(current.width).toBe(current.height);
});
