import { createHomeActivityState } from './homeActivityState';
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
it('does not repaint the old Home pane for a notification Activity pause immediately followed by resume', () => {
  const commit = jest.fn(); const state = createHomeActivityState(commit);
  state.update(false); state.update(true);
  expect(commit).not.toHaveBeenCalled(); jest.runAllTimers();
  expect(commit.mock.calls).toEqual([[true]]);
});
it('still commits a genuine background transition on the next timer turn', () => {
  const commit = jest.fn(); const state = createHomeActivityState(commit);
  state.update(false); jest.runAllTimers(); expect(commit.mock.calls).toEqual([[false]]);
});
it('pauses media immediately and cancels an obsolete queued activity change', () => {
  const commit = jest.fn(); const state = createHomeActivityState(commit);
  state.update(true); state.update(false, true);
  expect(commit.mock.calls).toEqual([[false]]); jest.runAllTimers();
  expect(commit).toHaveBeenCalledTimes(1);
});
it('cannot update an unmounted Home from a delayed timer', () => {
  const commit = jest.fn(); const state = createHomeActivityState(commit);
  state.update(false); state.dispose(); state.update(true, true); jest.runAllTimers();
  expect(commit).not.toHaveBeenCalled();
});
