import { beginFriendBusyNotification } from './friendBusyPresence';

it('suppresses a delayed busy=true after a later Stop has already completed', () => {
  const oldCall = beginFriendBusyNotification('max');
  const stopped = beginFriendBusyNotification('max');
  expect(oldCall.isCurrent()).toBe(false);
  expect(stopped.isCurrent()).toBe(true);
  stopped.finish();
  expect(oldCall.isCurrent()).toBe(false);
});

it('does not let old cleanup invalidate a newer call or a different user', () => {
  const oldRandom = beginFriendBusyNotification('max');
  const newCall = beginFriendBusyNotification('max');
  const other = beginFriendBusyNotification('ray');
  oldRandom.finish();
  expect(newCall.isCurrent()).toBe(true);
  expect(other.isCurrent()).toBe(true);
  newCall.finish();
  other.finish();
  expect(newCall.isCurrent()).toBe(false);
  expect(other.isCurrent()).toBe(false);
});
