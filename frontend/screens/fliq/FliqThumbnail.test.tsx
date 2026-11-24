import React from 'react';

const mockSlots: unknown[] = [];
let mockCursor = 0;
let mockEffects: Array<() => void> = [];
let mockResources = true;
let mockNet: ((state: { isConnected: boolean; isInternetReachable: boolean }) => void) | undefined;
jest.mock('react', () => ({
  ...jest.requireActual('react'),
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
jest.mock('react-native', () => ({ View: 'View', AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('../../utils/paneVisibility', () => ({ usePaneResources: () => mockResources }));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: {
  addEventListener: (cb: typeof mockNet) => { mockNet = cb; return () => { mockNet = undefined; }; },
} }));
import { FliqThumbnail } from './FliqThumbnail';

type Props = { onError: () => void; source: { uri: string } };
function render(uri = 'https://i.ytimg.com/test.jpg') {
  mockCursor = 0;
  const tree = FliqThumbnail({ uri }) as React.ReactElement<Props>;
  mockEffects.splice(0).forEach(effect => effect());
  return tree;
}
beforeEach(() => { jest.useFakeTimers(); mockSlots.length = 0; mockEffects = []; mockResources = true; });
afterEach(() => {
  mockSlots.forEach(slot => (slot as { cleanup?: () => void } | undefined)?.cleanup?.());
  jest.useRealTimers();
});
it('bounds retries, retries after reconnect, and never reloads a healthy image', () => {
  let tree = render();
  const firstKey = tree.key;
  mockNet?.({ isConnected: true, isInternetReachable: true });
  expect(render().key).toBe(firstKey);
  for (const delay of [1000, 3000, 8000]) {
    tree.props.onError(); render();
    jest.advanceTimersByTime(delay);
    const next = render();
    expect(next.key).not.toBe(tree.key);
    tree = next;
  }
  tree.props.onError(); render();
  expect(jest.getTimerCount()).toBe(0);
  mockNet?.({ isConnected: false, isInternetReachable: false });
  mockNet?.({ isConnected: true, isInternetReachable: true });
  expect(render().key).not.toBe(tree.key);
});
it('drops hidden image views and cancels retry timers, without clearing disk data', () => {
  const tree = render(); tree.props.onError(); render();
  expect(jest.getTimerCount()).toBe(1);
  mockResources = false;
  expect(render().type).toBe('View');
  expect(jest.getTimerCount()).toBe(0);
});
it('ignores errors from an obsolete source', () => {
  const old = render(); render('https://i.ytimg.com/new.jpg');
  old.props.onError(); render('https://i.ytimg.com/new.jpg');
  expect(jest.getTimerCount()).toBe(0);
});
