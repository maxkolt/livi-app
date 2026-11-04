let mockSlots: any[] = [];
let mockCursor = 0;
let mockEffects: Array<() => void> = [];
const mockCleanups: Array<() => void> = [];

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  memo: (component: unknown) => component,
  forwardRef: (component: unknown) => component,
  useRef: (initial: unknown) => {
    const index = mockCursor++;
    return mockSlots[index] ?? (mockSlots[index] = { current: initial });
  },
  useState: (initial: unknown) => {
    const index = mockCursor++;
    if (!(index in mockSlots)) mockSlots[index] = initial;
    return [mockSlots[index], (next: any) => { mockSlots[index] = typeof next === 'function' ? next(mockSlots[index]) : next; }];
  },
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown, deps: unknown[]) => {
    const index = mockCursor++;
    const previous = mockSlots[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      mockSlots[index] = { value: factory(), deps };
    }
    return mockSlots[index].value;
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = mockCursor++;
    const previous = mockSlots[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      mockSlots[index] = { deps };
      mockEffects.push(() => {
        const cleanup = effect();
        if (cleanup) mockCleanups.push(cleanup);
      });
    }
  },
  useImperativeHandle: () => {},
}));
jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
jest.mock('react-native', () => ({
  ...jest.requireActual('../../__mocks__/react-native'),
  View: 'View', Pressable: 'Pressable',
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../../store/lang', () => ({ useLang: () => 'ru' }));
jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));

(globalThis as any).__DEV__ = true;
import React from 'react';
import { __emit, __listenerCount } from '../../__mocks__/@react-native-community/netinfo';
import { FliqYoutubePlayer } from './FliqPlayer';

function render(props: Record<string, unknown> = {}) {
  mockCursor = 0;
  const tree = (FliqYoutubePlayer as any)({ videoId: 'CEJXqm2eiJ0', mode: 'play', ...props }, null);
  const web = React.Children.toArray(tree.props.children)[0] as React.ReactElement<any>;
  mockEffects.splice(0).forEach((effect) => effect());
  return {
    web,
    message: (message: object) => web.props.onMessage({ nativeEvent: { data: JSON.stringify(message) } }),
  };
}

beforeEach(() => {
  (globalThis as any).__DEV__ = true;
  jest.useFakeTimers();
  jest.setSystemTime(1_000_000);
  mockSlots = [];
  mockEffects = [];
});
afterEach(() => {
  mockCleanups.splice(0).forEach((cleanup) => cleanup());
  jest.useRealTimers();
});

it('reloads the same video from its saved time and ignores late messages from the old WebView', () => {
  const onRecovery = jest.fn(), onEnded = jest.fn(), onFirstFrame = jest.fn();
  const props = { muted: true, loop: false, onRecovery, onEnded, onFirstFrame };
  const first = render(props);
  first.message({ t: 'state', s: 1 });
  first.message({ t: 'tick', c: 7.8, d: 30, p: 1, at: Date.now() });
  jest.advanceTimersByTime(12_000);
  expect(onRecovery).toHaveBeenCalledTimes(1);
  const second = render(props);
  expect(second.web.key).not.toBe(first.web.key);
  expect(second.web.props.source.html).toContain("videoId:'CEJXqm2eiJ0'");
  expect(second.web.props.source.html).toContain('start:7');
  expect(second.web.props.source.html).toContain('muted=true');
  first.message({ t: 'ended' });
  expect(onEnded).not.toHaveBeenCalled();
  second.message({ t: 'state', s: 1 });
  expect(onFirstFrame).toHaveBeenCalledTimes(2);
});

it('keeps the current WebView for normal prop updates and a user pause', () => {
  const first = render();
  const paused = render({ mode: 'hold', muted: true });
  expect(paused.web.props.source).toBe(first.web.props.source);
  jest.advanceTimersByTime(120_000);
  const stillPaused = render({ mode: 'hold', muted: true });
  expect(stillPaused.web.key).toBe(first.web.key);
});

it('recovers after offline/reconnect and releases its network subscription on unmount', () => {
  const onRecovery = jest.fn();
  render({ onRecovery });
  expect(__listenerCount()).toBe(1);
  __emit({ isConnected: false, isInternetReachable: false, type: 'wifi' });
  jest.advanceTimersByTime(4000);
  __emit({ isConnected: true, isInternetReachable: true, type: 'wifi' });
  expect(onRecovery).toHaveBeenCalledTimes(1);
  mockCleanups.splice(0).forEach((cleanup) => cleanup());
  expect(__listenerCount()).toBe(0);
  jest.advanceTimersByTime(120_000);
  expect(onRecovery).toHaveBeenCalledTimes(1);
});
