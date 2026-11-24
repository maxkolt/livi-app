import React from 'react';

const mockSlots: unknown[] = [];
let mockCursor = 0;
let mockEffects: Array<() => void> = [];
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
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
jest.mock('react-native', () => ({ View: 'View' }));
jest.mock('react-native-reanimated', () => ({
  useSharedValue: (initial: unknown) => {
    const { useRef } = jest.requireMock('react');
    return useRef({ value: initial }).current;
  },
}));
jest.mock('./HomeLayoutContext', () => ({ DeferredHomeLayout: 'DeferredHomeLayout' }));

import { WelcomeKeepAlivePane } from './WelcomeKeepAlivePane';
import { PaneLiveContext, PaneVisibleContext, PaneResourcesContext } from '../../utils/paneVisibility';
import { completeNotificationHome, getNotificationHomeRequest, prepareNotificationHome } from '../../utils/notificationHome';

type PaneProps = React.ComponentProps<typeof WelcomeKeepAlivePane>;
type ElementProps = {
  children?: React.ReactNode;
  style?: unknown;
  value?: unknown;
  live?: boolean;
  accessibilityElementsHidden?: boolean;
  importantForAccessibility?: string;
};

function RenderPane(props: PaneProps) {
  mockCursor = 0;
  return WelcomeKeepAlivePane(props) as React.ReactElement<ElementProps>;
}
function flushEffects() {
  mockEffects.splice(0).forEach(effect => effect());
}
function find(node: React.ReactNode, type: unknown): React.ReactElement<ElementProps> | undefined {
  if (!React.isValidElement<ElementProps>(node)) return;
  if (node.type === type) return node;
  return React.Children.toArray(node.props.children).map(child => find(child, type)).find(Boolean);
}
function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}
const constraints = (tree: React.ReactElement<ElementProps>) => {
  const style = flattenStyle(tree.props.style);
  return Object.fromEntries(['position', 'left', 'right', 'top', 'bottom', 'minHeight'].map(key => [key, style[key]]));
};
const live = (tree: React.ReactElement<ElementProps>) => find(tree, PaneLiveContext.Provider)?.props.value;

beforeEach(() => {
  jest.useFakeTimers();
  const pending = getNotificationHomeRequest();
  if (pending) completeNotificationHome(pending.id);
  mockSlots.length = 0;
  mockCursor = 0;
  mockEffects = [];
});
afterEach(() => {
  mockSlots.forEach(slot => (slot as { cleanup?: () => void } | undefined)?.cleanup?.());
  const pending = getNotificationHomeRequest();
  if (pending) completeNotificationHome(pending.id);
  jest.useRealTimers();
});

it('releases hidden surfaces and shrinks the list after grace, restoring both on the first visible render', () => {
  RenderPane({ visible: true, mode: 'list' });
  flushEffects();
  RenderPane({ visible: false, mode: 'list' });
  flushEffects();
  jest.advanceTimersByTime(5000);
  const asleep = RenderPane({ visible: false, mode: 'list' });
  expect(live(asleep)).toBe(false);
  expect(find(asleep, PaneResourcesContext.Provider)?.props.value).toBe(false);
  const shown = RenderPane({ visible: true, mode: 'list' });
  expect(live(shown)).toBe(true);
  expect(find(shown, PaneResourcesContext.Provider)?.props.value).toBe(true);
});

it.each(['offscreen', 'list'] as const)('keeps the same filled layout while showing and hiding a warmed %s pane', mode => {
  const child = React.createElement('List');
  const padding = { paddingTop: 24, paddingBottom: 80 };
  const hidden = RenderPane({ visible: false, mode, style: padding, children: child });
  flushEffects();
  const shown = RenderPane({ visible: true, mode, style: padding, children: child });
  expect(constraints(hidden)).toEqual({ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, minHeight: 0 });
  expect(constraints(shown)).toEqual(constraints(hidden));
  expect(flattenStyle(shown.props.style)).toMatchObject(padding);
  expect(find(shown, 'DeferredHomeLayout')?.props.children).toBe(child);
  flushEffects();
  const hiddenAgain = RenderPane({ visible: false, mode, style: padding, children: child });
  expect(constraints(hiddenAgain)).toEqual(constraints(shown));
  expect(find(hiddenAgain, 'DeferredHomeLayout')?.props.children).toBe(child);
});

it('publishes the full live list on the first visible render before effects and keeps it warm afterwards', () => {
  const hidden = RenderPane({ visible: false, mode: 'offscreen' });
  expect(live(hidden)).toBe(false);
  flushEffects();
  const shownBeforeEffects = RenderPane({ visible: true, mode: 'offscreen' });
  expect(live(shownBeforeEffects)).toBe(true);
  expect(find(shownBeforeEffects, 'DeferredHomeLayout')?.props.live).toBe(true);
  flushEffects();
  const hiddenAgain = RenderPane({ visible: false, mode: 'offscreen' });
  expect(live(hiddenAgain)).toBe(true);
  expect(find(hiddenAgain, 'DeferredHomeLayout')?.props.live).toBe(true);
});

it.each(['offscreen', 'list'] as const)('makes hidden %s content noninteractive and inaccessible without losing layout', mode => {
  const hidden = RenderPane({ visible: false, mode });
  expect(hidden.props.accessibilityElementsHidden).toBe(true);
  expect(hidden.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(flattenStyle(hidden.props.style).pointerEvents).toBe('none');
  if (mode === 'offscreen') expect(flattenStyle(hidden.props.style).transform).toEqual([{ translateX: 100000 }]);
  else expect(flattenStyle(hidden.props.style).opacity).toBe(0);
  flushEffects();
  const shown = RenderPane({ visible: true, mode });
  expect(shown.props.accessibilityElementsHidden).toBe(false);
  expect(shown.props.importantForAccessibility).toBe('auto');
  expect(flattenStyle(shown.props.style).pointerEvents).toBeUndefined();
  expect(flattenStyle(shown.props.style).transform).toBeUndefined();
  expect(flattenStyle(shown.props.style).opacity).toBeUndefined();
});

it('shows the notification destination immediately while the Home shell still supplies the old tab', () => {
  RenderPane({ visible: false, tabId: 'chat', mode: 'offscreen' });
  flushEffects();
  prepareNotificationHome('unread');
  const destination = RenderPane({ visible: false, tabId: 'chat', mode: 'offscreen' });
  expect(destination.props.accessibilityElementsHidden).toBe(false);
  expect(live(destination)).toBe(true);
  expect(flattenStyle(destination.props.style).transform).toBeUndefined();

  // A separate mounted pane still receives visible=true from the stale shell.
  mockSlots.length = 0;
  mockEffects = [];
  const previous = RenderPane({ visible: true, tabId: 'search', mode: 'offscreen' });
  expect(previous.props.accessibilityElementsHidden).toBe(true);
  expect(flattenStyle(previous.props.style).pointerEvents).toBe('none');
  expect(find(previous, PaneVisibleContext.Provider)).toBeDefined();
});
