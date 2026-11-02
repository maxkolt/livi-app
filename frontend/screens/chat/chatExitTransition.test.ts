import { beginChatExitTransition, finishChatExitTransition, waitForChatExitTransition } from './chatExitTransition';

beforeEach(() => jest.useFakeTimers());
afterEach(() => { finishChatExitTransition(); jest.useRealTimers(); });

it('holds heavy work until the closing transition finishes', async () => {
  beginChatExitTransition();
  const work = jest.fn();
  const pending = waitForChatExitTransition().then(work);
  await jest.advanceTimersByTimeAsync(120);
  expect(work).not.toHaveBeenCalled();
  finishChatExitTransition();
  await pending;
  expect(work).toHaveBeenCalledTimes(1);
});

it('has a bounded fallback when native-stack unmount removes the end listener', async () => {
  beginChatExitTransition();
  const work = jest.fn();
  const pending = waitForChatExitTransition().then(work);
  await jest.advanceTimersByTimeAsync(499);
  expect(work).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  await pending;
  expect(work).toHaveBeenCalledTimes(1);
});

it('extends the guard for a second close without losing existing waiters', async () => {
  beginChatExitTransition();
  const work = jest.fn();
  const pending = waitForChatExitTransition().then(work);
  await jest.advanceTimersByTimeAsync(300);
  beginChatExitTransition();
  await jest.advanceTimersByTimeAsync(200);
  expect(work).not.toHaveBeenCalled();
  finishChatExitTransition();
  await pending;
  expect(work).toHaveBeenCalledTimes(1);
});
