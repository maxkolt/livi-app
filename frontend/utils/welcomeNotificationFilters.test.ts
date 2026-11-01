import {
  setPendingWelcomeChatsFilter, consumePendingWelcomeChatsFilter, getWelcomeChatsFilterSnapshot,
  setPendingWelcomeCallsFilter, consumePendingWelcomeCallsFilter, getWelcomeCallsFilterSnapshot,
  onPendingWelcomeChatsFilter,
} from './globalEvents';

beforeEach(() => {
  setPendingWelcomeChatsFilter('all'); consumePendingWelcomeChatsFilter();
  setPendingWelcomeCallsFilter('all'); consumePendingWelcomeCallsFilter();
});
it('retains Unread for a new screen after the previous screen consumed the notification', () => {
  setPendingWelcomeChatsFilter('unread');
  expect(consumePendingWelcomeChatsFilter()).toBe('unread');
  expect(consumePendingWelcomeChatsFilter()).toBeNull();
  expect(getWelcomeChatsFilterSnapshot()).toBe('unread');
});
it('retains Missed through notification navigation and remount', () => {
  setPendingWelcomeCallsFilter('missed');
  expect(consumePendingWelcomeCallsFilter()).toBe('missed');
  expect(getWelcomeCallsFilterSnapshot()).toBe('missed');
});
it('allows a manual All selection to replace the previous notification filter', () => {
  setPendingWelcomeChatsFilter('unread'); consumePendingWelcomeChatsFilter();
  setPendingWelcomeChatsFilter('all'); consumePendingWelcomeChatsFilter();
  expect(getWelcomeChatsFilterSnapshot()).toBe('all');
  setPendingWelcomeCallsFilter('missed'); consumePendingWelcomeCallsFilter();
  setPendingWelcomeCallsFilter('all'); consumePendingWelcomeCallsFilter();
  expect(getWelcomeCallsFilterSnapshot()).toBe('all');
});
it('publishes the selection before a mounted screen consumes the event', () => {
  let snapshot = '';
  const off = onPendingWelcomeChatsFilter(() => {
    consumePendingWelcomeChatsFilter();
    snapshot = getWelcomeChatsFilterSnapshot();
  });
  setPendingWelcomeChatsFilter('unread');
  expect(snapshot).toBe('unread');
  expect(getWelcomeChatsFilterSnapshot()).toBe('unread');
  off();
});
