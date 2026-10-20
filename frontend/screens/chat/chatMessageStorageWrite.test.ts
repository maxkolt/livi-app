const store = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => store.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
}));

import { patchStoredChatMessage, writeStoredChatMessages } from './chatMessageStorageWrite';

describe('chat message storage writes', () => {
  beforeEach(() => store.clear());

  it('patches one completed background media job without dropping newer messages', async () => {
    const key = 'chat_messages_me_peer';
    await writeStoredChatMessages(key, [
      { id: 'voice-1', type: 'audio', uri: 'file:///cache/voice.m4a' },
      { id: 'newer-2', type: 'text', text: 'newer' },
    ]);

    await patchStoredChatMessage(key, 'voice-1', { uri: 'file:///documents/voice.m4a' });

    expect(JSON.parse(store.get(key)!)).toEqual([
      { id: 'voice-1', type: 'audio', uri: 'file:///documents/voice.m4a' },
      { id: 'newer-2', type: 'text', text: 'newer' },
    ]);
  });
});
