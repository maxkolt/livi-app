import React from 'react';

const mockSlots: unknown[] = [];
let mockCursor = 0;
let mockEffects: Array<() => void> = [];
let mockResources = true, mockLive = true, mockMounted = false;
const mockRequests: Array<{ url: string; receive: (image: unknown) => void; cancel: jest.Mock }> = [];
const mockAnimations: Array<(finished: boolean) => void> = [];
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  memo: (component: unknown) => component,
  useContext: () => mockLive,
  useCallback: (callback: unknown, deps: unknown[]) => {
    const index = mockCursor++;
    const previous = mockSlots[index] as { value: unknown; deps: unknown[] } | undefined;
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      mockSlots[index] = { value: callback, deps };
    }
    return (mockSlots[index] as { value: unknown }).value;
  },
  useState: (initial: unknown) => {
    const index = mockCursor++;
    if (!(index in mockSlots)) mockSlots[index] = initial;
    return [mockSlots[index], (next: unknown) => { mockSlots[index] = next; }];
  },
  useRef: (current: unknown) => {
    const index = mockCursor++;
    return mockSlots[index] ?? (mockSlots[index] = { current });
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = mockCursor++;
    const previous = mockSlots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    mockEffects.push(() => {
      previous?.cleanup?.();
      mockSlots[index] = { deps, cleanup: effect() };
    });
  },
}));
jest.mock('../../utils/paneVisibility', () => ({
  PaneLiveContext: {}, usePaneResources: () => mockResources,
}));
jest.mock('react-native', () => ({ View: 'View', StyleSheet: { absoluteFill: {} } }));
jest.mock('@shopify/react-native-skia', () => ({
  Blur: 'Blur', Canvas: 'Canvas', ColorMatrix: 'ColorMatrix', Group: 'Group', Image: 'Image', Paint: 'Paint',
}));
jest.mock('./fliqAmbientImages', () => ({
  prefetchFliqAmbient: jest.fn(),
  fliqAmbientImages: { request: (url: string, receive: (image: unknown) => void) => {
    const cancel = jest.fn(); mockRequests.push({ url, receive, cancel }); return cancel;
  } },
}));
jest.mock('react-native-reanimated', () => ({
  useSharedValue: (value: number) => jest.requireMock('react').useRef({ value }).current,
  useDerivedValue: (fn: () => number) => ({ value: fn() }),
  withTiming: (value: number, _options: unknown, complete: (finished: boolean) => void) => {
    mockAnimations.push(complete); return value;
  },
  cancelAnimation: jest.fn(), runOnJS: (fn: unknown) => fn,
  Easing: { out: (fn: unknown) => fn, quad: 'quad' },
}));
import { FliqAmbient } from './FliqAmbient';

const props = { url: 'a', card: { x: 0, y: 0, width: 100, height: 200 }, width: 200, height: 400 };
function unmount() {
  for (const slot of mockSlots) (slot as { cleanup?: () => void } | undefined)?.cleanup?.();
  mockSlots.length = 0; mockMounted = false;
}
function render(url: string | null = 'a', size = { width: 200, height: 400 }): React.ReactNode {
  const wrapper = FliqAmbient({ ...props, ...size, url }) as React.ReactElement<typeof props> | null;
  if (!wrapper) { if (mockMounted) unmount(); return null; }
  mockMounted = true; mockCursor = 0;
  const tree = (wrapper.type as (childProps: typeof props) => React.ReactNode)(wrapper.props);
  mockEffects.splice(0).forEach(effect => effect());
  return tree;
}
function images(tree: React.ReactNode): unknown[] {
  if (!React.isValidElement<{ image?: unknown; children?: React.ReactNode }>(tree)) return [];
  return [tree.props.image, ...React.Children.toArray(tree.props.children).flatMap(images)].filter(Boolean);
}
beforeEach(() => {
  mockSlots.length = 0; mockEffects = []; mockResources = true; mockLive = true;
  mockRequests.length = 0; mockAnimations.length = 0; mockMounted = false;
});
afterEach(unmount);

it('unmounts hidden image owners and detaches their pending callback', () => {
  render(); const old = mockRequests[0]; old.receive({ id: 'a' });
  expect(images(render())).toHaveLength(2);
  mockLive = false;
  expect(render()).toBeNull();
  expect(old.cancel).toHaveBeenCalledTimes(1);
  old.receive({ id: 'late' });
  mockLive = true;
  expect(images(render())).toEqual([]);
  expect(mockRequests).toHaveLength(2);
});
it('does not load images without pane resources, URL, or valid dimensions', () => {
  mockResources = false; expect(render()).toBeNull();
  mockResources = true; expect(render(null)).toBeNull();
  expect(render('a', { width: 0, height: 400 })).toBeNull();
  expect(mockRequests).toHaveLength(0);
});
it('drops the previous frame on fade completion and rejects obsolete completion callbacks', () => {
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };
  render(); mockRequests[0].receive(a); render();
  render('b'); mockRequests[1].receive(b);
  expect(images(render('b'))).toEqual([a, b, a, b]);
  mockAnimations[0](true); // Completion for a cannot clear b's transition.
  expect(images(render('b'))).toEqual([a, b, a, b]);
  mockAnimations[1](true);
  expect(images(render('b'))).toEqual([b, b]);
  render('c'); mockRequests[2].receive(c); render('c');
  mockAnimations[1](true);
  expect(images(render('c'))).toEqual([b, c, b, c]);
  mockAnimations[2](true);
  expect(images(render('c'))).toEqual([c, c]);
});
it('ignores stale loads after URL changes and clears old light on load failure', () => {
  render(); const first = mockRequests[0];
  render('b'); first.receive({ id: 'stale' });
  expect(images(render('b'))).toEqual([]);
  mockRequests[1].receive({ id: 'b' }); render('b');
  render('c'); mockRequests[2].receive(null);
  expect(images(render('c'))).toEqual([]);
  expect(first.cancel).toHaveBeenCalledTimes(1);
});
