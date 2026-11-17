import React from 'react';

const mockSlots: unknown[] = [];
let mockCursor = 0;
let mockEffects: Array<() => void> = [];
let mockDensity = 2.8125;
const mockResolve = jest.fn();
const mockCached = new Map<string, string>();
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  memo: (component: unknown) => component,
  useState: (initial: unknown) => {
    const index = mockCursor++;
    if (!(index in mockSlots)) mockSlots[index] = typeof initial === 'function' ? initial() : initial;
    return [mockSlots[index], (value: unknown) => {
      mockSlots[index] = typeof value === 'function' ? value(mockSlots[index]) : value;
    }];
  },
  useRef: (current: unknown) => {
    const index = mockCursor++;
    return mockSlots[index] ?? (mockSlots[index] = { current });
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = mockCursor++;
    const previous = mockSlots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    mockSlots[index] = { deps };
    mockEffects.push(() => {
      previous?.cleanup?.();
      mockSlots[index] = { deps, cleanup: effect() };
    });
  },
}));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' }, View: 'View', StyleSheet: { create: (s: unknown) => s, absoluteFillObject: {} },
  PixelRatio: { roundToNearestPixel: (value: number) => Math.round(value * mockDensity) / mockDensity },
}));
jest.mock('expo-image', () => ({ Image: 'ExpoImage' }));
jest.mock('react-native-svg', () => ({ __esModule: true, default: 'Svg' }));
jest.mock('react-native-reanimated', () => ({ __esModule: true, default: { View: 'AnimatedView' }, useAnimatedStyle: () => ({}) }));
jest.mock('../utils/dataUriToFileUri', () => ({
  peekResolvedDataUriCache: (uri: string) => mockCached.get(uri) || null,
  resolveDataUriForAndroid: (uri: string) => mockResolve(uri),
}));
jest.mock('../utils/avatarCache', () => ({ getAvatarUri: jest.fn(async () => null) }));
jest.mock('../utils/imageOptimization', () => ({ getAvatarImageProps: (uri: string, key: string) => ({ source: { uri }, recyclingKey: key }) }));
jest.mock('../utils/cosmeticCatalog', () => ({ getCosmeticFrame: (id: string) =>
  id ? { colors: ['#ffffff', '#888888'] } : null }));
jest.mock('../utils/cosmetics', () => ({ useUserActiveFrame: () => '' }));
jest.mock('../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.mock('./frames/FireAvatarFrame', () => ({ FireAvatarFrame: 'Frame', fireFrameOutset: (size: number) =>
  Math.max(2, Math.min(12, Math.round(Math.max(1, size) * 0.085))) }));
jest.mock('./frames/IceAvatarFrame', () => ({ IceAvatarFrame: 'Frame' }));
jest.mock('./frames/DiamondAvatarFrame', () => ({ DiamondAvatarFrame: 'Frame' }));
jest.mock('./AvatarGlyph', () => ({ AvatarGlyph: 'Glyph' }));

import AvatarImage from './AvatarImage';
import { useResolvedImageUri } from '../hooks/useResolvedImageUri';

function render<T>(fn: () => T): T {
  mockCursor = 0;
  const result = fn();
  mockEffects.splice(0).forEach(effect => effect());
  return result;
}
function imageUri(node: React.ReactNode): string | undefined {
  if (!React.isValidElement<{ source?: { uri?: string }; children?: React.ReactNode }>(node)) return;
  if ((node.type as unknown) === 'ExpoImage') return node.props.source?.uri;
  return React.Children.toArray(node.props.children).map(imageUri).find(Boolean);
}
function imageNode(node: React.ReactNode): React.ReactElement<{ recyclingKey: string; children?: React.ReactNode }> | undefined {
  if (!React.isValidElement<{ recyclingKey: string; children?: React.ReactNode }>(node)) return;
  if ((node.type as unknown) === 'ExpoImage') return node;
  return React.Children.toArray(node.props.children).map(imageNode).find(Boolean);
}
const avatar = (id: string, version: number, uri: string) => render(() =>
  AvatarImage({ userId: id, avatarVer: version, uri, fallbackText: 'A' }));
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  mockDensity = 2.8125;
  mockSlots.length = 0;
  mockEffects = [];
  mockCached.clear();
  mockResolve.mockReset();
});
afterEach(() => {
  mockSlots.forEach(slot => (slot as { cleanup?: () => void } | undefined)?.cleanup?.());
});

it('marks the previous resolved file as stale on the very first render of a new image', async () => {
  const oldData = 'data:image/jpeg;base64,old';
  mockCached.set(oldData, 'file:///old.jpg');
  expect(render(() => useResolvedImageUri(oldData))).toEqual(['file:///old.jpg', true]);
  let finish!: (uri: string) => void;
  mockResolve.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  expect(render(() => useResolvedImageUri('data:image/jpeg;base64,new'))[1]).toBe(false);
  finish('file:///new.jpg'); await flush();
  expect(render(() => useResolvedImageUri('data:image/jpeg;base64,new'))).toEqual(['file:///new.jpg', true]);
});

it('ignores a late conversion after another photo is selected and clears synchronously', async () => {
  const pending = new Map<string, (uri: string) => void>();
  mockResolve.mockImplementation((uri: string) => new Promise(resolve => { pending.set(uri, resolve); }));
  const a = 'data:image/jpeg;base64,late-a', b = 'data:image/jpeg;base64,late-b';
  render(() => useResolvedImageUri(a));
  render(() => useResolvedImageUri(b));
  pending.get(b)!('file:///latest.jpg'); await flush();
  pending.get(a)!('file:///outdated.jpg'); await flush();
  expect(render(() => useResolvedImageUri(b))).toEqual(['file:///latest.jpg', true]);
  expect(render(() => useResolvedImageUri(''))).toEqual(['', true]);
});

it('replaces a friend photo after its version changes and keeps the new file on remount', async () => {
  const oldData = 'data:image/jpeg;base64,friend-old';
  const newData = 'data:image/jpeg;base64,friend-new';
  mockCached.set(oldData, 'file:///friend-old.jpg');
  for (let i = 0; i < 3; i++) avatar('friend-version', 1, oldData);
  let finish!: (uri: string) => void;
  mockResolve.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  for (let i = 0; i < 3; i++) avatar('friend-version', 2, newData);
  finish('file:///friend-new.jpg'); await flush();
  let tree;
  for (let i = 0; i < 3; i++) tree = avatar('friend-version', 2, newData);
  expect(imageUri(tree)).toBe('file:///friend-new.jpg');
  mockSlots.length = 0;
  expect(imageUri(avatar('friend-version', 2, newData))).toBe('file:///friend-new.jpg');
});

it('does not assign the previous user photo to another user when a row is reused', () => {
  const a = 'data:image/jpeg;base64,user-a', b = 'data:image/jpeg;base64,user-b';
  mockCached.set(a, 'file:///a.jpg'); mockCached.set(b, 'file:///b.jpg');
  for (let i = 0; i < 3; i++) avatar('row-a', 1, a);
  let tree;
  for (let i = 0; i < 3; i++) tree = avatar('row-b', 1, b);
  expect(imageUri(tree)).toBe('file:///b.jpg');
});

it('clears a removed photo and preserves a stable file when the same image returns as data', () => {
  const data = 'data:image/jpeg;base64,same';
  for (let i = 0; i < 3; i++) avatar('stable', 1, 'file:///same.jpg');
  expect(imageUri(avatar('stable', 1, data))).toBe('file:///same.jpg');
  let tree;
  for (let i = 0; i < 3; i++) tree = avatar('stable', 2, '');
  expect(imageUri(tree)).toBeUndefined();
});

type FramedAvatarTree = React.ReactElement<{
  style: Array<{ width: number; height: number }>;
  children: React.ReactElement<{ size: number; photoSize: number; style: { left: number; top: number } }>;
}>;

it.each(['fire', 'frost', 'diamond'].flatMap(frameId =>
  [22, 30, 34, 38, 40, 42].map(size => [frameId, size] as const),
))('keeps the small %s frame and %s dp photo centered on physical pixels', (frameId, size) => {
  const tree = render(() => AvatarImage({ size, frameId, uri: 'file:///small-avatar.jpg' })) as FramedAvatarTree;
  const photo = tree.props.style[tree.props.style.length - 1];
  const frame = tree.props.children.props;
  expect(photo.width * mockDensity).toBeCloseTo(Math.round(size * mockDensity), 8);
  expect(photo.height).toBe(photo.width);
  expect(frame.photoSize).toBe(photo.width);
  expect(frame.size * mockDensity).toBeCloseTo(Math.round(frame.size * mockDensity), 8);
  expect(frame.style.left * mockDensity).toBeCloseTo(Math.round(frame.style.left * mockDensity), 8);
  expect(frame.style.top).toBe(frame.style.left);
  expect(frame.style.left + frame.size / 2).toBeCloseTo(photo.width / 2, 8);
});

it.each([2.625, 3.5, 4])('keeps a small frame centered at density %s', density => {
  mockDensity = density;
  const tree = render(() => AvatarImage({ size: 38, frameId: 'diamond', uri: 'file:///small-avatar.jpg' })) as FramedAvatarTree;
  const frame = tree.props.children.props;
  expect(frame.photoSize * density).toBeCloseTo(Math.round(38 * density), 8);
  expect(frame.style.left * density).toBeCloseTo(Math.round(frame.style.left * density), 8);
  expect(frame.style.left + frame.size / 2).toBeCloseTo(frame.photoSize / 2, 8);
});

it('preserves the dimensions of a large framed avatar', () => {
  const tree = render(() => AvatarImage({ size: 121, frameSize: 141, frameId: 'fire', uri: 'file:///large-avatar.jpg' })) as FramedAvatarTree;
  expect(tree.props.children.props).toMatchObject({ size: 141, photoSize: 121, style: { left: -10, top: -10 } });
});

it('keeps the profile photo mounted when upload confirmation assigns a new version', () => {
  const props = { userId: 'upload-self', uri: 'file:///selected-profile.jpg', preserveImageOnVersionChange: true };
  const before = imageNode(render(() => AvatarImage({ ...props, avatarVer: 0 })));
  const after = imageNode(render(() => AvatarImage({ ...props, avatarVer: 5 })));
  expect(after).toBeDefined();
  expect(after?.key).toBe(before?.key);
  expect(after?.props.recyclingKey).toBe(before?.props.recyclingKey);
});

it('still recycles ordinary avatars on a version change and profiles on a user change', () => {
  const props = { userId: 'recycling-a', uri: 'file:///recycling.jpg' };
  const a = imageNode(render(() => AvatarImage({ ...props, avatarVer: 1 })));
  const b = imageNode(render(() => AvatarImage({ ...props, avatarVer: 2 })));
  expect(a?.props.recyclingKey).not.toBe(b?.props.recyclingKey);
  const c = imageNode(render(() => AvatarImage({ ...props, preserveImageOnVersionChange: true })));
  const d = imageNode(render(() => AvatarImage({ ...props, userId: 'recycling-b', preserveImageOnVersionChange: true })));
  expect(c?.props.recyclingKey).not.toBe(d?.props.recyclingKey);
});
