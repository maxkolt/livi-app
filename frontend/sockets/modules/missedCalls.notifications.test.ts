const mockStorage = new Map<string, string>();
const mockReceipts = new Set<string>();
const mockEmit = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: async (key: string) => mockStorage.get(key) ?? null,
  setItem: async (key: string, value: string) => { mockStorage.set(key, value); },
}));
jest.mock('./shared', () => ({ shared: {
  currentUserId: 'me', appliedFromPendingByUid: new Map(), appliedFromReauthByUid: new Map(),
} }));
jest.mock('./socketCore', () => ({ socket: { connected: true, emit: (...args: unknown[]) => mockEmit(...args) } }));
jest.mock('../../utils/globalEvents', () => ({
  emitMissedFetchedFromServer: jest.fn(), isWelcomeViewingMissedCalls: () => false,
  isWelcomeCallsMissedFilterActive: () => false,
}));
jest.mock('../../utils/pendingMissedCallHistory', () => ({ persistPendingMissedCallHistory: async () => {} }));
jest.mock('../../screens/home/callLog', () => ({ recordMissedCallHistory: async ({ eventId }: { eventId: string }) => {
  if (mockReceipts.has(eventId)) return false;
  mockReceipts.add(eventId); return true;
} }));
import { applyMissedFromReauth, recordAppliedFromPending } from './missedCalls';
const count = () => JSON.parse(mockStorage.get('missed_calls_by_user_v1') || '{}').peer || 0;
beforeEach(() => { mockStorage.clear(); mockReceipts.clear(); mockEmit.mockClear(); });
it('does not count the native call again, but counts another call from the same caller during replay', async () => {
  mockStorage.set('missed_calls_by_user_v1', '{"peer":1}'); mockReceipts.add('native-call');
  recordAppliedFromPending('peer');
  await applyMissedFromReauth({ userId: 'me', missed: [
    { id: 'delivery-one', callId: 'native-call', from: 'peer' },
    { id: 'delivery-two', callId: 'other-call', from: 'peer' },
  ] });
  expect(count()).toBe(2);
  expect(mockEmit).toHaveBeenCalledWith('missed_calls:ack', { ids: ['delivery-one', 'delivery-two'] }, expect.any(Function));
  await applyMissedFromReauth({ userId: 'me', missed: [
    { id: 'delivery-one', callId: 'native-call', from: 'peer' },
    { id: 'delivery-two', callId: 'other-call', from: 'peer' },
  ] });
  expect(count()).toBe(2);
});
