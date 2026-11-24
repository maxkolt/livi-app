import React from 'react';
const mockSlots: unknown[] = [];
let mockCursor = 0;
const mockCleanups: Array<() => void> = [];
const mockFrames = new Map<number, FrameRequestCallback>();
let mockNextFrame = 0;
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useRef: (current: unknown) => { const index = mockCursor++; return mockSlots[index] ?? (mockSlots[index] = { current }); },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => () => void) => { mockCleanups.push(effect()); },
}));
jest.mock('react-native', () => ({
  Pressable: 'Pressable', StyleSheet: { absoluteFillObject: {} },
  Animated: {
    View: 'AnimatedView',
    Value: class { stopAnimation() {} setValue() {} interpolate() { return 1; } },
    spring: () => ({ start() {} }),
  },
}));
jest.mock('../home/constants', () => ({ HOME_NAV_BG: '#000' }));
import { ChatRoundButton } from './ChatRoundButton';
const onPress = jest.fn();
function render(disabled: boolean) {
  mockCursor = 0;
  return ChatRoundButton({ disabled, onPress, accessibilityLabel: 'call', backgroundColor: '#000', pressedBackgroundColor: '#111', children: null }) as React.ReactElement<{ disabled: boolean; accessibilityState: { disabled: boolean }; onPress: () => void }>;
}
beforeEach(() => {
  mockSlots.length = 0; mockCleanups.length = 0; mockFrames.clear(); onPress.mockClear();
  global.requestAnimationFrame = callback => { const id = ++mockNextFrame; mockFrames.set(id, callback); return id; };
  global.cancelAnimationFrame = id => { mockFrames.delete(id); };
});
afterEach(() => { mockCleanups.splice(0).forEach(cleanup => cleanup()); });
it('exposes real disabled state and does not schedule a call', () => {
  const button = render(true);
  expect(button.props.disabled).toBe(true);
  expect(button.props.accessibilityState.disabled).toBe(true);
  button.props.onPress();
  expect(mockFrames.size).toBe(0);
  expect(onPress).not.toHaveBeenCalled();
});
it('rejects a queued tap when a call starts before its frame is delivered', () => {
  render(false).props.onPress();
  const callback = [...mockFrames.values()][0];
  render(true);
  callback(0);
  expect(onPress).not.toHaveBeenCalled();
});
it('cancels the queued action when its screen unmounts', () => {
  render(false).props.onPress();
  expect(mockFrames.size).toBe(1);
  mockCleanups.splice(0).forEach(cleanup => cleanup());
  expect(mockFrames.size).toBe(0);
  expect(onPress).not.toHaveBeenCalled();
});
