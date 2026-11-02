const mockEffects: Array<() => void | (() => void)> = [];
const mockSetPaused = jest.fn();
let mockStore: { activeId: string | null; setActive: (id: string | null) => void };

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  memo: (component: unknown) => component,
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => [initial, mockSetPaused],
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
}));
jest.mock('expo', () => ({ useEvent: jest.fn() }));
jest.mock('expo-video', () => ({ useVideoPlayer: jest.fn(), VideoView: 'VideoView' }));
jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-svg', () => ({ __esModule: true, default: 'Svg', Circle: 'Circle' }));
jest.mock('../home/constants', () => ({ UI_ACCENT: '#62B0D8' }));

import React from 'react';
import { ChatVideoNote } from './ChatVideoNote';
import { getActiveChatPlaybackKey, pauseActiveChatVideoNote, resetChatPlaybackCoordinatorForTests } from './chatPlaybackCoordinator';

type CircleProps = {
  onPress: () => void;
  onTouchStart: (event: { stopPropagation: () => void }) => void;
  children: React.ReactNode;
};
const render = (disabled = false) => ChatVideoNote({
  id: 'v', uri: 'file:///video.mp4', durationSec: 30, disabled,
}) as React.ReactElement<CircleProps>;
const hasPlayer = (circle: React.ReactElement<CircleProps>) => React.Children.toArray(circle.props.children)
  .some(child => React.isValidElement<{ uri?: string }>(child) && child.props.uri === 'file:///video.mp4');

beforeEach(() => {
  mockEffects.length = 0;
  mockSetPaused.mockClear();
  mockStore.setActive(null);
  resetChatPlaybackCoordinatorForTests();
});

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
