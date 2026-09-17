const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStorage.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    mockStorage.delete(key);
  }),
}));

jest.mock('../../sockets/socket', () => ({
  getCurrentUserId: () => '507f1f77bcf86cd799439011',
}));

jest.mock('../chat/chatCallEvents', () => ({
  appendChatCallStatusIfEligible: jest.fn(async () => null),
}));

import {
  getCallLogSnapshot,
  loadCallLog,
  recordCallLog,
  recordCancelledCall,
  subscribeCallLog,
} from './callLog';

describe('local call log', () => {
  beforeAll(async () => {
    mockStorage.clear();
    await loadCallLog();
  });

  it('уведомляет активный список сразу при локальной записи исходящего', () => {
    const peerId = '507f191e810c19729de860ea';
    const seen: string[][] = [];
    const off = subscribeCallLog((entries) => {
      seen.push(entries.map((entry) => `${entry.peerId}:${entry.direction}`));
    });

    recordCallLog({ peerId, direction: 'outgoing', at: 10_000 });

    expect(seen.at(-1)).toContain(`${peerId}:outgoing`);
    off();
  });

  it('при неподтверждённом звонке локально заменяет исходящий на отменённый', () => {
    const peerId = '507f191e810c19729de860eb';
    recordCallLog({ peerId, direction: 'outgoing', at: Date.now() - 100 });

    recordCancelledCall(peerId);

    const peerRows = getCallLogSnapshot().filter((entry) => entry.peerId === peerId);
    expect(peerRows).toHaveLength(1);
    expect(peerRows[0]?.direction).toBe('cancelled');
  });
});
