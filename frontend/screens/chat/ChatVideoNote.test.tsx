const mockEffects: Array<() => void | (() => void)> = [];
const mockSetPaused = jest.fn();
const mockPlayer = { duration: 30, currentTime: 0, status: 'readyToPlay', play: jest.fn(), pause: jest.fn(), addListener: jest.fn() };
let mockPanConfig: import('react-native').PanResponderCallbacks;
let mockStore: { activeId: string | null; setActive: (id: string | null) => void };

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  memo: (component: unknown) => component,
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => [initial, mockSetPaused],
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void | (() => void)) => { mockEffects.push(effect); },
}));
jest.mock('zustand', () => ({
  create: (initialize: (set: (patch: object) => void) => typeof mockStore) => {
    mockStore = initialize(patch => Object.assign(mockStore, patch));
    return Object.assign((selector: (state: typeof mockStore) => unknown) => selector(mockStore), {
      getState: () => mockStore,
    });
  },
}));
jest.mock('react-native', () => ({
  Pressable: 'Pressable', View: 'View', Text: 'Text',
  StyleSheet: { create: (styles: unknown) => styles },
  PanResponder: { create: (config: typeof mockPanConfig) => {
    mockPanConfig = config;
    return { panHandlers: {} };
  } },
}));
jest.mock('expo', () => ({ useEvent: (_player: unknown, _event: unknown, initial: unknown) => initial }));
jest.mock('expo-video', () => ({ useVideoPlayer: () => mockPlayer, VideoView: 'VideoView' }));
jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-svg', () => ({ __esModule: true, default: 'Svg', Circle: 'Circle' }));
jest.mock('../home/constants', () => ({ UI_ACCENT: '#62B0D8' }));

import React from 'react';
import type { GestureResponderEvent, PanResponderGestureState } from 'react-native';
import { MESSAGE_LONG_PRESS_MS } from '../../constants/uiTokens';
import { ChatVideoNote } from './ChatVideoNote';
import { getActiveChatPlaybackKey, pauseActiveChatVideoNote, resetChatPlaybackCoordinatorForTests } from './chatPlaybackCoordinator';

type CircleProps = {
  onPress: () => void;
  onTouchStart: (event: { stopPropagation: () => void }) => void;
  children: React.ReactNode;
  uri?: string;
};
const render = (disabled = false, onLongPress?: () => void) => ChatVideoNote({
  id: 'v', uri: 'file:///video.mp4', durationSec: 30, disabled, onLongPress,
}) as React.ReactElement<CircleProps>;
const hasPlayer = (circle: React.ReactElement<CircleProps>) => React.Children.toArray(circle.props.children)
  .some(child => React.isValidElement<{ uri?: string }>(child) && child.props.uri === 'file:///video.mp4');

beforeEach(() => {
  mockEffects.length = 0;
  mockSetPaused.mockClear();
  mockStore.setActive(null);
  resetChatPlaybackCoordinatorForTests();
  mockPlayer.currentTime = 0;
  mockPlayer.play.mockClear();
  mockPlayer.pause.mockClear();
});

function renderActive(onLongPress?: () => void) {
  render(false, onLongPress).props.onPress();
  const child = React.Children.toArray(render(false, onLongPress).props.children).find(node => React.isValidElement<{ uri?: string }>(node) && node.props.uri === 'file:///video.mp4') as React.ReactElement;
  return (child.type as (props: unknown) => React.ReactElement<{ children: React.ReactNode }>)(child.props);
}
const touch = (x: number, y: number) => ({ nativeEvent: { locationX: x, locationY: y } }) as GestureResponderEvent;
const move = (dx: number, dy: number, fingers = 1) => ({ dx, dy, numberActiveTouches: fingers }) as PanResponderGestureState;

it('creates a video child only after playback is selected', () => {
  const idle = render();
  expect(hasPlayer(idle)).toBe(false);
  idle.props.onPress();
  expect(hasPlayer(render())).toBe(true);
});

it('registers an outside pause that preserves the active circle and its player', () => {
  render().props.onPress();
  mockSetPaused.mockClear();
  pauseActiveChatVideoNote();
  expect(mockSetPaused).toHaveBeenCalledWith(true);
  expect(mockStore.activeId).toBe('v');
  expect(getActiveChatPlaybackKey()).toBe('video-note:v');
});

it('keeps a circle touch from bubbling into the screen outside-touch handler', () => {
  const stopPropagation = jest.fn();
  render().props.onTouchStart({ stopPropagation });
  expect(stopPropagation).toHaveBeenCalledTimes(1);
});

it('never creates a second player in a disabled menu preview or releases the original on preview close', () => {
  render().props.onPress();
  mockEffects.length = 0;
  const preview = render(true);
  expect(hasPlayer(preview)).toBe(false);
  mockEffects.map(effect => effect()).forEach(cleanup => cleanup?.());
  expect(mockStore.activeId).toBe('v');
  expect(getActiveChatPlaybackKey()).toBe('video-note:v');
});

it.each([[108, 108], [108, 24], [24, 108], [192, 108], [108, 192]])('leaves the video surface to the list, including close to its edge (%s,%s)', (x, y) => {
  renderActive();
  expect(mockPanConfig.onStartShouldSetPanResponder!(touch(x, y), move(0, 0))).toBe(false);
  expect(mockPlayer.pause).not.toHaveBeenCalled();
  expect(mockPlayer.currentTime).toBe(0);
});

it('keeps circular ring seeking through a half circle and resumes playback', () => {
  renderActive();
  expect(mockPanConfig.onStartShouldSetPanResponder!(touch(108, 4), move(0, 0))).toBe(true);
  mockPanConfig.onPanResponderGrant!(touch(108, 4), move(0, 0));
  mockPanConfig.onPanResponderMove!(touch(212, 108), move(104, 104));
  expect(mockPlayer.currentTime).toBeCloseTo(7.5);
  mockPanConfig.onPanResponderMove!(touch(108, 212), move(0, 208));
  mockPanConfig.onPanResponderRelease!(touch(108, 212), move(0, 208));
  expect(mockPlayer.currentTime).toBeCloseTo(15);
  expect(mockPlayer.pause).toHaveBeenCalledTimes(1);
  expect(mockPlayer.play).toHaveBeenCalledTimes(1);
});

it('does not jump from the beginning to the end across twelve oclock', () => {
  renderActive();
  mockPanConfig.onPanResponderGrant!(touch(108, 4), move(0, 0));
  mockPanConfig.onPanResponderMove!(touch(80, 8), move(-28, 4));
  mockPanConfig.onPanResponderRelease!(touch(80, 8), move(-28, 4));
  expect(mockPlayer.currentTime).toBe(0);
});

it('cancels the ring hold when circular seeking starts', () => {
  jest.useFakeTimers();
  try {
    const onLongPress = jest.fn();
    renderActive(onLongPress);
    mockPanConfig.onPanResponderGrant!(touch(108, 4), move(0, 0));
    mockPanConfig.onPanResponderMove!(touch(212, 108), move(104, 104));
    jest.runOnlyPendingTimers();
    expect(onLongPress).not.toHaveBeenCalled();
    mockPanConfig.onPanResponderRelease!(touch(212, 108), move(104, 104));
    expect(mockPlayer.currentTime).toBeCloseTo(7.5);
  } finally { jest.useRealTimers(); }
});

it('preserves ring hold for selection without toggling playback', () => {
  jest.useFakeTimers();
  try {
    const onLongPress = jest.fn();
    renderActive(onLongPress);
    mockPanConfig.onPanResponderGrant!(touch(108, 4), move(0, 0));
    jest.advanceTimersByTime(MESSAGE_LONG_PRESS_MS);
    mockPanConfig.onPanResponderRelease!(touch(108, 4), move(0, 0));
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(mockPlayer.play).not.toHaveBeenCalled();
    expect(mockPlayer.pause).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

it('keeps the native video surface out of touch handling', () => {
  const active = renderActive();
  const video = React.Children.toArray(active.props.children)
    .find(node => React.isValidElement(node) && node.type === 'VideoView') as React.ReactElement<{ pointerEvents: string }>;
  expect(video.props.pointerEvents).toBe('none');
});
