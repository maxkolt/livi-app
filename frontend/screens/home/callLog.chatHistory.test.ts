const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => { mockStorage.set(key, value); }),
}));
jest.mock('../../sockets/modules/authState', () => ({ getCurrentUserId: () => 'callee' }));
jest.mock('../../sockets/modules/shared', () => ({ shared: { currentUserId: 'callee', messageCache: new Map() } }));
jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.mock('../../utils/globalEvents', () => ({ emitChatCallStatusMessage: jest.fn() }));

import { loadCallLog, recordCallLog } from './callLog';
import { globalMessageStorage } from '../../sockets/modules/messageStorage';
import { appendAcceptedChatCallStatus } from '../chat/chatCallEvents';

const settleWrites = () => new Promise<void>(resolve => setImmediate(resolve));

it('persists an accepted incoming call without an open chat and keeps one bubble after acceptance replay', async () => {
  await loadCallLog();
  const accepted = { peerId: 'caller', direction: 'incoming' as const, callId: 'native-accepted-call', at: Date.now() };
  recordCallLog(accepted);
  await settleWrites();
  const key = globalMessageStorage.getChatKey('callee', 'caller');
  expect(JSON.parse(mockStorage.get(key)!)).toEqual([
    expect.objectContaining({ id: 'local_call_native-accepted-call_incoming', type: 'call', callDirection: 'incoming', from: 'caller', to: 'callee', localOnly: true }),
  ]);

  // A delayed socket replay must not add another bubble, including after the time dedupe expires.
  recordCallLog({ ...accepted, at: accepted.at + 5_000 });
  await settleWrites();
  expect(JSON.parse(mockStorage.get(key)!)).toHaveLength(1);
});

it('also persists an accepted outgoing call started outside its chat', async () => {
  await appendAcceptedChatCallStatus('other-peer', 'outgoing', { callId: 'friends-list-call' });
  const key = globalMessageStorage.getChatKey('callee', 'other-peer');
  expect(JSON.parse(mockStorage.get(key)!)).toEqual([
    expect.objectContaining({ id: 'local_call_friends-list-call_outgoing', from: 'callee', to: 'other-peer', sender: 'me', callDirection: 'outgoing' }),
  ]);
});
