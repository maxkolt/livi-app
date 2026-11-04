import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { ChatListRow } from './chatList';

let mockFocusEffect: () => () => void;
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
}));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => () => void) => { mockFocusEffect = effect; },
}));

import { useChatScroll } from './useChatScroll';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function event(inverted: boolean, distance: number): NativeSyntheticEvent<NativeScrollEvent> {
  return { nativeEvent: {
    contentOffset: { x: 0, y: inverted ? distance : 1300 - distance },
    contentSize: { width: 400, height: 2000 },
    layoutMeasurement: { width: 400, height: 700 },
    contentInset: { top: 0, bottom: 0, left: 0, right: 0 },
  } } as NativeSyntheticEvent<NativeScrollEvent>;
}

it.each([true, false])('preserves reading position across list updates (inverted=%s)', (inverted) => {
  const nativeList = { scrollToOffset: jest.fn(), scrollToEnd: jest.fn() };
  const onDrag = jest.fn();
  const hook = useChatScroll({ current: nativeList as unknown as FlatList<ChatListRow> }, 'peer', inverted, onDrag);
  const blur = mockFocusEffect();
  jest.runAllTimers();
  const bottomScroll = inverted ? nativeList.scrollToOffset : nativeList.scrollToEnd;
  expect(bottomScroll).toHaveBeenCalledTimes(1);
  bottomScroll.mockClear();

  const list = hook.listScrollProps;
  // Native anchoring keeps the same visible bubble when rows above it change.
  expect(list.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
  list.onScrollBeginDrag();
  expect(onDrag).toHaveBeenCalledTimes(1);
  list.onScroll(event(inverted, 700));
  list.onScrollEndDrag(event(inverted, 700));
  jest.runAllTimers();
  for (let i = 0; i < 3; i++) {
    list.onContentSizeChange(); // Delete, new message, media measurement.
    list.onLayout();
    hook.scrollToBottom(); // Late realtime pass.
    list.onScroll(event(inverted, 0)); // Non-gesture anchor correction.
    jest.runAllTimers();
  }
  expect(bottomScroll).not.toHaveBeenCalled();

  blur();
  mockFocusEffect(); // Screen retained in the navigation stack, opened again.
  jest.runAllTimers();
  expect(bottomScroll).toHaveBeenCalledTimes(1);
  if (inverted) expect(bottomScroll).toHaveBeenLastCalledWith({ offset: 0, animated: false });
  else expect(bottomScroll).toHaveBeenLastCalledWith({ animated: false });
});

it('waits for list layout when history becomes available after focus', () => {
  const listRef: { current: FlatList<ChatListRow> | null } = { current: null };
  const hook = useChatScroll(listRef, 'peer', true, jest.fn());
  mockFocusEffect();
  jest.runAllTimers();
  const scroll = jest.fn();
  listRef.current = { scrollToOffset: scroll } as unknown as FlatList<ChatListRow>;
  hook.listScrollProps.onLayout();
  hook.listScrollProps.onContentSizeChange();
  jest.runAllTimers();
  expect(scroll).toHaveBeenCalledTimes(1);
});

it.each([true, false])('does not flash the latest bubble during the first touch (inverted=%s)', (inverted) => {
  const nativeList = { scrollToOffset: jest.fn(), scrollToEnd: jest.fn() };
  const hook = useChatScroll({ current: nativeList as unknown as FlatList<ChatListRow> }, 'peer', inverted, jest.fn());
  mockFocusEffect();
  const list = hook.listScrollProps;
  list.onTouchStart();
  list.onLayout();
  list.onContentSizeChange();
  hook.scrollToBottom();
  jest.runAllTimers();
  expect(nativeList.scrollToOffset).not.toHaveBeenCalled();
  expect(nativeList.scrollToEnd).not.toHaveBeenCalled();
  list.onScrollBeginDrag();
  list.onScroll(event(inverted, 500));
  list.onTouchCancel(); // ScrollView takes over the responder from the touch target.
  list.onScrollEndDrag(event(inverted, 500));
  list.onMomentumScrollBegin();
  list.onScroll(event(inverted, 900));
  list.onMomentumScrollEnd(event(inverted, 900));
  list.onContentSizeChange();
  jest.runAllTimers();
  expect(nativeList.scrollToOffset).not.toHaveBeenCalled();
  expect(nativeList.scrollToEnd).not.toHaveBeenCalled();
});
