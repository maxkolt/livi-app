import { chatDistanceFromBottom, createChatScrollController } from './chatScrollController';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function openChat() {
  const scroll = jest.fn();
  const chat = createChatScrollController(scroll);
  chat.focus();
  jest.runOnlyPendingTimers();
  scroll.mockClear();
  return { chat, scroll };
}

it('opens at the latest message and follows updates while the user stays there', () => {
  const scroll = jest.fn();
  const chat = createChatScrollController(scroll);
  chat.focus();
  jest.runOnlyPendingTimers();
  expect(scroll).toHaveBeenCalledTimes(1);
  // History hydration, incoming bubble layout and a late image measurement.
  for (let i = 0; i < 3; i++) {
    chat.scheduleScrollToBottom();
    jest.runOnlyPendingTimers();
  }
  expect(scroll).toHaveBeenCalledTimes(4);
});

it('holds the reading position through deletion, incoming messages and keyboard changes', () => {
  const { chat, scroll } = openChat();
  chat.beginDrag();
  chat.onScroll(900);
  chat.endDrag(900);
  jest.runAllTimers();
  // Simulate content/layout callbacks plus late socket and keyboard scroll requests.
  for (let i = 0; i < 5; i++) {
    chat.scheduleScrollToBottom();
    chat.scrollToBottom();
  }
  jest.runAllTimers();
  expect(scroll).not.toHaveBeenCalled();
});

it('cancels a queued bottom jump as soon as a drag begins', () => {
  const { chat, scroll } = openChat();
  chat.scheduleScrollToBottom(90);
  chat.beginDrag();
  jest.advanceTimersByTime(220);
  chat.scrollToBottom();
  expect(scroll).not.toHaveBeenCalled();
});

it('cancels entry and layout retries before a first drag has been recognised', () => {
  const scroll = jest.fn();
  const chat = createChatScrollController(scroll);
  chat.focus(); // Entry scroll is still pending.
  chat.beginTouch(); // Finger lands before native onScrollBeginDrag.
  jest.runAllTimers();
  chat.scheduleScrollToBottom(); // Late history/image layout during that gap.
  chat.scrollToBottom(); // A delayed realtime callback.
  jest.runAllTimers();
  expect(scroll).not.toHaveBeenCalled();
  chat.beginDrag();
  chat.onScroll(600);
  chat.endTouch();
  chat.endDrag(600);
  chat.beginMomentum();
  chat.onScroll(900);
  chat.endMomentum(900);
  chat.scheduleScrollToBottom();
  chat.scrollToBottom();
  jest.runAllTimers();
  expect(scroll).not.toHaveBeenCalled();
});

it('keeps follow enabled for a simple tap at the bottom without interrupting the touch', () => {
  const { chat, scroll } = openChat();
  chat.beginTouch();
  chat.scheduleScrollToBottom();
  chat.scrollToBottom();
  jest.runAllTimers();
  expect(scroll).not.toHaveBeenCalled();
  chat.endTouch();
  jest.runAllTimers();
  expect(scroll).toHaveBeenCalledTimes(1);
});

it('does not jump when ScrollView cancels a touch before reporting the drag', () => {
  const { chat, scroll } = openChat();
  chat.beginTouch();
  chat.cancelTouch();
  chat.scheduleScrollToBottom();
  chat.scrollToBottom();
  jest.runAllTimers();
  expect(scroll).not.toHaveBeenCalled();
  chat.beginDrag();
  chat.endDrag(600);
  jest.runAllTimers();
  expect(scroll).not.toHaveBeenCalled();
});

it('does not resume following on touch release after a message action holds the viewport', () => {
  const { chat, scroll } = openChat();
  chat.beginTouch();
  chat.preservePosition();
  chat.endTouch();
  jest.runAllTimers();
  expect(scroll).not.toHaveBeenCalled();
});

it('does not interrupt dragging or momentum even when they start at the bottom', () => {
  const { chat, scroll } = openChat();
  chat.beginDrag();
  chat.onScroll(0);
  chat.scrollToBottom();
  chat.endDrag(0);
  chat.scrollToBottom();
  chat.beginMomentum();
  jest.advanceTimersByTime(200);
  chat.onScroll(600);
  chat.scrollToBottom();
  chat.endMomentum(600);
  jest.runAllTimers();
  expect(scroll).not.toHaveBeenCalled();
});

it('resumes following when the user scrolls back to the latest message', () => {
  const { chat, scroll } = openChat();
  chat.preservePosition();
  chat.beginDrag();
  chat.endDrag(250);
  chat.beginMomentum();
  chat.onScroll(0);
  chat.endMomentum(0);
  jest.runAllTimers();
  scroll.mockClear();
  chat.scheduleScrollToBottom();
  jest.runAllTimers();
  expect(scroll).toHaveBeenCalledTimes(1);
});

it('resumes at the bottom after a drag without momentum', () => {
  const { chat, scroll } = openChat();
  chat.preservePosition();
  chat.beginDrag();
  chat.endDrag(0);
  jest.runAllTimers();
  expect(scroll).toHaveBeenCalledTimes(1);
});

it('does not treat native anchor corrections as a request to follow messages', () => {
  const { chat, scroll } = openChat();
  chat.preservePosition();
  chat.onScroll(0);
  chat.scheduleScrollToBottom();
  jest.runAllTimers();
  expect(scroll).not.toHaveBeenCalled();
});

it('keeps a quoted message or message action in place despite delayed socket callbacks', () => {
  const { chat, scroll } = openChat();
  chat.scheduleScrollToBottom(80);
  chat.preservePosition();
  chat.beginMomentum(); // A programmatic animated quote jump is not a user drag.
  chat.onScroll(0);
  chat.endMomentum(0);
  jest.advanceTimersByTime(220);
  chat.scrollToBottom();
  expect(scroll).not.toHaveBeenCalled();
});

it('cancels work on exit and resets the viewport when reopening a retained screen', () => {
  const { chat, scroll } = openChat();
  chat.scheduleScrollToBottom(220);
  chat.blur();
  chat.scrollToBottom();
  jest.runAllTimers();
  expect(scroll).not.toHaveBeenCalled();
  chat.focus();
  jest.runAllTimers();
  expect(scroll).toHaveBeenCalledTimes(1);
  chat.beginDrag();
  chat.endDrag(500);
  chat.blur();
  jest.runAllTimers();
  scroll.mockClear();
  chat.focus();
  jest.runAllTimers();
  expect(scroll).toHaveBeenCalledTimes(1);
});

it.each([8, 40, 500])('keeps history still when the user is %s px above the bottom', (distance) => {
  const { chat, scroll } = openChat();
  chat.beginDrag();
  chat.endDrag(distance);
  jest.runAllTimers();
  chat.scrollToBottom();
  expect(scroll).not.toHaveBeenCalled();
});

it('accounts for Android inversion and iOS insets without treating short lists as history', () => {
  expect(chatDistanceFromBottom(true, 0, 2000, 700)).toBe(0);
  expect(chatDistanceFromBottom(true, 400, 2200, 700)).toBe(400);
  expect(chatDistanceFromBottom(false, 1300, 2000, 700)).toBe(0);
  expect(chatDistanceFromBottom(false, 600, 2000, 700)).toBe(700);
  expect(chatDistanceFromBottom(false, 0, 200, 700)).toBe(0);
  expect(chatDistanceFromBottom(false, 1320, 2000, 700, 0, 20)).toBe(0);
  expect(chatDistanceFromBottom(true, -20, 2000, 700, 20)).toBe(0);
});
