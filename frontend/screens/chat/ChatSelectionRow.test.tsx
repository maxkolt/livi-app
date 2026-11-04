import React from 'react';
import type { GestureResponderEvent, ViewStyle } from 'react-native';

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useCallback: (callback: unknown) => callback,
}));
jest.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable' }));

import { ChatSelectionRow } from './ChatSelectionRow';

type RowProps = { children: React.ReactNode; style: ViewStyle; pointerEvents: string };
type TargetProps = {
  testID: string;
  accessible: boolean;
  style: ViewStyle;
  onPress: (event: GestureResponderEvent) => void;
};

function render(selectionMode: boolean, isOwn = true, sideInset = 0) {
  const onToggleSelect = jest.fn();
  const bubble = <React.Fragment key="bubble">Message</React.Fragment>;
  const row = ChatSelectionRow({
    children: bubble, messageId: 'message-7', selectionMode, isOwn, sideInset, onToggleSelect,
  }) as React.ReactElement<RowProps>;
  const target = React.Children.toArray(row.props.children)
    .find(child => React.isValidElement<TargetProps>(child) && child.props.testID === 'chat-selection-side-message-7') as
      React.ReactElement<TargetProps> | undefined;
  return { row, bubble, target, onToggleSelect };
}

it.each([true, false])('selects exactly once without cancelling selection (isOwn=%s)', (isOwn) => {
  const { target, onToggleSelect } = render(true, isOwn);
  const stopPropagation = jest.fn();
  target!.props.onPress({ stopPropagation } as unknown as GestureResponderEvent);
  expect(stopPropagation).toHaveBeenCalledTimes(1);
  expect(onToggleSelect).toHaveBeenCalledTimes(1);
  expect(onToggleSelect).toHaveBeenCalledWith('message-7');
  expect(stopPropagation.mock.invocationCallOrder[0]).toBeLessThan(onToggleSelect.mock.invocationCallOrder[0]);
});

it.each([
  [true, 0], [false, 0], [true, 28], [false, 28], [true, 96], [false, 96],
])('covers the checkbox side up to the screen edge (isOwn=%s, inset=%s)', (isOwn, inset) => {
  const { target, row } = render(true, isOwn as boolean, inset as number);
  expect(row.props.style).toEqual({ alignSelf: 'stretch', paddingHorizontal: inset });
  expect(target!.props.style).toMatchObject({
    position: 'absolute', top: 0, bottom: 0,
    width: 52 + Number(inset),
    ...(isOwn ? { right: 0 } : { left: 0 }),
  });
  // Only the checkbox side is claimed; the opposite background still cancels selection.
  expect(isOwn ? target!.props.style.left : target!.props.style.right).toBeUndefined();
  expect(target!.props.accessible).toBe(false); // Keep the visible checkbox as the accessibility control.
});

it('keeps message layout identical when selection opens and closes', () => {
  const normal = render(false, true, 28);
  const selected = render(true, true, 28);
  expect(normal.target).toBeUndefined();
  expect(normal.row.type).toBe(selected.row.type);
  expect(normal.row.props.style).toEqual(selected.row.props.style);
  expect(normal.row.props.pointerEvents).toBe('box-none');
  expect(React.Children.toArray(normal.row.props.children)[0]).toEqual(
    React.Children.toArray(selected.row.props.children)[0],
  );
});
