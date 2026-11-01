jest.mock('../screens/home/callLog', () => ({ recordMissedCallHistory: jest.fn(async () => true) }));
jest.mock('react-native', () => ({ Platform: { OS: 'android' }, NativeModules: {} }));
import { NativeModules, Platform } from 'react-native';
import { recordMissedCallHistory } from '../screens/home/callLog';
import { persistPendingMissedCallHistory, persistMissedCallNotificationHistory } from './pendingMissedCallHistory';
const save = recordMissedCallHistory as jest.Mock;
const event = { id: 'call-1', from: 'peer', fromNick: 'Caller', at: 1000 };
let native: { getPendingMissedCallEventsJson: jest.Mock; acknowledgePendingMissedCallEvents: jest.Mock };
beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  native = {
    getPendingMissedCallEventsJson: jest.fn(async () => JSON.stringify([event])),
    acknowledgePendingMissedCallEvents: jest.fn(async () => {}),
  };
  NativeModules.LiviAppModule = native;
  save.mockReset().mockResolvedValue(true);
});
it('acknowledges the native inbox only after the call row is on disk', async () => {
  let finish!: () => void;
  save.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = persistPendingMissedCallHistory();
  await Promise.resolve();
  expect(native.acknowledgePendingMissedCallEvents).not.toHaveBeenCalled();
  expect(save).toHaveBeenCalledWith({ eventId: event.id, peerId: event.from, fromNick: event.fromNick, at: event.at });
  finish(); await pending;
  expect(native.acknowledgePendingMissedCallEvents).toHaveBeenCalledWith('["call-1"]');
});
it('retains the inbox after a disk failure and retries on the next entry', async () => {
  save.mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(persistPendingMissedCallHistory()).rejects.toThrow('disk unavailable');
  expect(native.acknowledgePendingMissedCallEvents).not.toHaveBeenCalled();
  await persistPendingMissedCallHistory();
  expect(native.acknowledgePendingMissedCallEvents).toHaveBeenCalledTimes(1);
});
it('coalesces concurrent imports from notification tap and app resume', async () => {
  await Promise.all([persistPendingMissedCallHistory(), persistPendingMissedCallHistory()]);
  expect(native.getPendingMissedCallEventsJson).toHaveBeenCalledTimes(1);
});
it('also saves the tapped notification before navigation when native inbox is empty', async () => {
  native.getPendingMissedCallEventsJson.mockResolvedValue('[]');
  await persistMissedCallNotificationHistory({
    type: 'missed_call', fromUserId: 'peer', fromNick: 'Caller', callId: 'call-2', sentAt: '2026-11-01T07:00:00Z',
  });
  expect(save).toHaveBeenCalledWith({
    eventId: 'call-2', peerId: 'peer', fromNick: 'Caller', at: Date.parse('2026-11-01T07:00:00Z'),
  });
});
