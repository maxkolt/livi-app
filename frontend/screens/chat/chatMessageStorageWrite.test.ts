const store = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => store.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
}));
// Модуль сокетов тянет нативные ESM-пакеты (SecureStore, Application); здесь нужен только сброс кэша.
jest.mock('../../sockets/modules/messages', () => ({ clearMessageCacheForStorageKey: jest.fn() }));

import { patchStoredChatMessage, writeStoredChatMessages } from './chatMessageStorageWrite';
import { createChatMessagePersistQueue, type ChatPersistSnapshot } from './chatMessagePersistQueue';
import AsyncStorage from '@react-native-async-storage/async-storage';

describe('chat message storage writes', () => {
  beforeEach(() => store.clear());

  it('keeps close/reopen writes ordered across two screen instances', async () => {
    const key = 'chat_messages_me_peer';
    const oldScreen = createChatMessagePersistQueue(s => writeStoredChatMessages(s.key, s.messages), () => {});
    const newScreen = createChatMessagePersistQueue(s => writeStoredChatMessages(s.key, s.messages), () => {});
    const initial: ChatPersistSnapshot = {
      key, userId: 'me', peerId: 'peer', lang: 'ru', messages: [{ id: 'first' }],
    };
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    (AsyncStorage.setItem as jest.Mock).mockImplementationOnce(async (storageKey: string, value: string) => {
      await blocked;
      store.set(storageKey, value);
    });
    const first = oldScreen(initial);
    const closing = oldScreen({ ...initial, messages: [...initial.messages, { id: 'before-back' }] });
    const reopenedMessages = [...initial.messages, { id: 'before-back' }, { id: 'after-reopen' }];
    const reopened = newScreen({ ...initial, messages: reopenedMessages });
    release();
    await Promise.all([first, closing, reopened]);
    expect(JSON.parse(store.get(key)!)).toEqual(reopenedMessages);
  });

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
