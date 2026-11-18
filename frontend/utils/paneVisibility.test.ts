const mockSlots: unknown[] = [];
let mockCursor = 0;
let mockLive = false;
let mockEffects: Array<() => void> = [];

const mockSameDeps = (a: unknown[], b: unknown[]) =>
  a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useContext: () => mockLive,
  useRef: (current: unknown) => {
    const index = mockCursor++;
    return mockSlots[index] ?? (mockSlots[index] = { current });
  },
  useState: (initial: unknown) => {
    const index = mockCursor++;
    if (!(index in mockSlots)) mockSlots[index] = typeof initial === 'function' ? initial() : initial;
    return [mockSlots[index], (value: unknown) => {
      mockSlots[index] = typeof value === 'function' ? value(mockSlots[index]) : value;
    }];
  },
  useMemo: <T,>(factory: () => T, deps: unknown[]): T => {
    const index = mockCursor++;
    const previous = mockSlots[index] as { value: T; deps: unknown[] } | undefined;
    if (previous && mockSameDeps(previous.deps, deps)) return previous.value;
    const value = factory();
    mockSlots[index] = { value, deps };
    return value;
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = mockCursor++;
    const previous = mockSlots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (previous && mockSameDeps(previous.deps, deps)) return;
    mockSlots[index] = { deps };
    mockEffects.push(() => {
      previous?.cleanup?.();
      mockSlots[index] = { deps, cleanup: effect() };
    });
  },
}));

import { usePaneList } from './paneVisibility';

function RenderPaneList<T>(items: T[], live: boolean) {
  mockCursor = 0;
  mockLive = live;
  const result = usePaneList(items);
  mockEffects.splice(0).forEach(effect => effect());
  return result;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockSlots.length = 0;
  mockEffects = [];
  mockCursor = 0;
  mockLive = false;
});
afterEach(() => {
  mockSlots.forEach(slot => (slot as { cleanup?: () => void } | undefined)?.cleanup?.());
  jest.useRealTimers();
});

it('keeps prewarmed row identities through the first visible render without native clipping', () => {
  const friends = Array.from({ length: 8 }, (_, index) => ({ id: `friend-${index}` }));
  let hidden = RenderPaneList(friends, false);
  expect(hidden.data).toHaveLength(0);
  for (let index = 0; index < friends.length; index++) {
    jest.advanceTimersByTime(50);
    hidden = RenderPaneList(friends, false);
  }
  expect(hidden.data).toBe(friends);
  expect(hidden.windowProps.removeClippedSubviews).toBe(false);

  const visible = RenderPaneList(friends, true);
  expect(visible.data).toBe(hidden.data);
  expect(visible.windowProps.removeClippedSubviews).toBe(false);
  expect(visible.windowProps.windowSize).toBeGreaterThan(hidden.windowProps.windowSize);
});

it('expands the complete first visible list immediately and never shrinks its data on tab switches', () => {
  const chats = Array.from({ length: 30 }, (_, index) => ({ id: `chat-${index}` }));
  const firstHidden = RenderPaneList(chats, false);
  expect(firstHidden.data).toHaveLength(0);
  const visible = RenderPaneList(chats, true);
  expect(visible.data).toBe(chats);
  expect(visible.windowProps.removeClippedSubviews).toBe(false);

  for (const live of [false, true, false, true]) {
    const next = RenderPaneList(chats, live);
    expect(next.data).toBe(chats);
    expect(next.windowProps.removeClippedSubviews).toBe(false);
  }
  expect(jest.getTimerCount()).toBe(0);
});

it('prewarms a bounded first window, then retains those exact objects when the rest is revealed', () => {
  const calls = Array.from({ length: 30 }, (_, index) => ({ id: `call-${index}` }));
  let hidden = RenderPaneList(calls, false);
  for (let index = 0; index < 20; index++) {
    jest.advanceTimersByTime(50);
    hidden = RenderPaneList(calls, false);
  }
  expect(hidden.data).toHaveLength(12);
  expect(hidden.windowProps.removeClippedSubviews).toBe(false);
  const visible = RenderPaneList(calls, true);
  expect(visible.data).toBe(calls);
  hidden.data.forEach((row, index) => expect(visible.data[index]).toBe(row));
  expect(jest.getTimerCount()).toBe(0);
});
