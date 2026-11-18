import type { ChatMessage, PickedChatImage } from './chatMessageTypes';
import type { ChatSessionState } from './useChatSessionState';

const mockStore = new Map<string, string>();
const mockUpload = jest.fn();
const mockSend = jest.fn();
const mockSocket = { on: jest.fn(), off: jest.fn() };
const mockSlots: unknown[] = [];
let mockCursor = 0;
let mockEffects: Array<() => void> = [];
let mockId = 0;
jest.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = mockCursor++;
    if (!(index in mockSlots)) mockSlots[index] = typeof initial === 'function' ? initial() : initial;
    return [mockSlots[index], (value: unknown) => {
      mockSlots[index] = typeof value === 'function' ? value(mockSlots[index]) : value;
    }];
  },
  useRef: (current: unknown) => {
    const index = mockCursor++;
    return mockSlots[index] ?? (mockSlots[index] = { current });
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = mockCursor++;
    const previous = mockSlots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    mockSlots[index] = { deps };
    mockEffects.push(() => {
      previous?.cleanup?.();
      mockSlots[index] = { deps, cleanup: effect() };
    });
  },
}));
jest.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }));
jest.mock('@react-native-community/netinfo', () => ({ addEventListener: () => () => {} }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStore.get(key) || null),
  setItem: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  removeItem: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));
jest.mock('../../sockets/socket', () => ({ __esModule: true, default: mockSocket, sendMessage: (...args: unknown[]) => mockSend(...args) }));
jest.mock('../../sockets/modules/messages', () => ({ clearMessageCacheForStorageKey: jest.fn() }));
jest.mock('../../utils/mediaUpload', () => ({ uploadMediaToServer: (...args: unknown[]) => mockUpload(...args) }));
jest.mock('./chatVoiceRecord', () => ({ keepVoiceRecording: async (uri: string) => uri }));
jest.mock('./videoNoteFiles', () => ({ keepVideoNoteRecording: async (uri: string) => uri, makeVideoNoteThumb: async () => '' }));
jest.mock('./chatMessageMeta', () => ({ stickerFieldsFromMessage: () => ({}) }));
jest.mock('./chatMessageIds', () => ({
  ...jest.requireActual('./chatMessageIds'),
  createOptimisticChatMessageId: () => `photo-test-${++mockId}`,
}));

import { useChatSendMedia } from './useChatSendMedia';
import { useChatMediaOutbox } from './useChatMediaOutbox';
import { getChatMediaSend } from './chatMediaSendJobs';
import { getChatMessagesKey } from './chatStorageKeys';
import { writeStoredChatMessages } from './chatMessageStorageWrite';

const key = getChatMessagesKey('me', 'peer');
const caption = '  Фото 😀\nПодпись на второй строке\n';
const portrait: PickedChatImage = { uri: 'file:///portrait.jpg', width: 900, height: 1600, fileName: 'portrait.jpg' };
const landscape: PickedChatImage = { uri: 'file:///landscape.jpg', width: 1600, height: 900 };
const unknown: PickedChatImage = { uri: 'file:///unknown.jpg' };
let writes: Array<Promise<void>> = [];
let enqueue: jest.Mock;
let dequeue: jest.Mock;

function makeSession(): ChatSessionState {
  const session = {
    peerId: 'peer', currentUserId: 'me', historyReady: false,
    messages: [], latestMessagesForPersistRef: { current: [] }, uploadStatus: {}, readStatuses: {},
    setMessages: jest.fn(), setUploadStatus: jest.fn(), updateReadStatuses: jest.fn(),
  } as unknown as ChatSessionState;
  session.setMessages = jest.fn(action => {
    session.messages = typeof action === 'function' ? action(session.messages) : action;
  });
  session.setUploadStatus = jest.fn(action => {
    session.uploadStatus = typeof action === 'function' ? action(session.uploadStatus) : action;
  });
  session.updateReadStatuses = jest.fn(action => {
    session.readStatuses = action(session.readStatuses);
  });
  return session;
}
function RenderSender(session: ChatSessionState) {
  mockCursor = 0;
  const result = useChatSendMedia({ session,
    enqueueMessagesPersist: () => {
      writes.push(writeStoredChatMessages(key, JSON.parse(JSON.stringify(session.latestMessagesForPersistRef.current))));
    },
    resolveMediaUri: uri => uri || '', enqueueMediaOutboxId: enqueue, dequeueMediaOutboxId: dequeue,
    setVoiceRecordMs: jest.fn(),
  });
  mockEffects.splice(0).forEach(effect => effect());
  return result;
}
function RenderRetry(session: ChatSessionState) {
  mockCursor = 0;
  const result = useChatMediaOutbox({ session, resolveMediaUri: uri => uri || '' });
  mockEffects.splice(0).forEach(effect => effect());
  return result;
}
function unmount() {
  mockSlots.forEach(slot => (slot as { cleanup?: () => void } | undefined)?.cleanup?.());
}
function nextMount() {
  unmount(); mockSlots.length = 0; mockEffects = []; mockCursor = 0;
}
const persisted = (): ChatMessage[] => JSON.parse(mockStore.get(key) || '[]');
const persistAll = async () => { await Promise.all(writes); };

beforeEach(() => {
  mockStore.clear(); mockSlots.length = 0; mockEffects = []; mockCursor = 0; mockId = 0; writes = [];
  mockUpload.mockReset().mockImplementation(async (uri: string) => ({ success: true, url: `https://api.test/${uri.split('/').pop()}` }));
  mockSend.mockReset().mockResolvedValue({ ok: true, messageId: 'server-photo', delivered: true });
  enqueue = jest.fn().mockResolvedValue(undefined); dequeue = jest.fn().mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { unmount(); await persistAll(); jest.restoreAllMocks(); });

it('persists exact single-photo caption and natural bounds before upload, then preserves them in the sent message', async () => {
  let finish!: (value: unknown) => void;
  mockUpload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const session = makeSession();
  const pending = RenderSender(session).sendPickedImage(portrait, caption);
  expect(session.messages).toHaveLength(1);
  expect(session.messages[0]).toMatchObject({ id: 'photo-test-1', text: caption, imageWidth: 900, imageHeight: 1600, uri: portrait.uri });
  expect(session.latestMessagesForPersistRef.current[0]).toEqual(session.messages[0]);
  await persistAll();
  expect(persisted()[0]).toMatchObject({ text: caption, imageWidth: 900, imageHeight: 1600 });
  finish({ success: true, url: 'https://api.test/portrait.jpg' });
  expect(await pending).toBe(true);
  await persistAll();
  expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ text: caption, imageWidth: 900, imageHeight: 1600,
    uri: 'https://api.test/portrait.jpg', clientUiMessageId: 'photo-test-1' }));
  expect(persisted()[0]).toMatchObject({ id: 'server-photo', text: caption, imageWidth: 900, imageHeight: 1600 });
});

it('preserves album caption and positional sizes from optimistic insertion through upload and delivery', async () => {
  const assets = [portrait, unknown, landscape];
  const dimensions = [{ width: 900, height: 1600 }, null, { width: 1600, height: 900 }];
  const session = makeSession();
  const pending = RenderSender(session).sendPickedAlbum(assets, caption);
  expect(session.messages[0]).toMatchObject({ text: caption, imageSizes: dimensions, uris: assets.map(asset => asset.uri) });
  expect(await pending).toBe(true);
  await persistAll();
  const uris = ['https://api.test/portrait.jpg', 'https://api.test/unknown.jpg', 'https://api.test/landscape.jpg'];
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ text: caption, uris,
    imageWidth: 900, imageHeight: 1600, imageSizes: dimensions }));
  expect(persisted()[0]).toMatchObject({ id: 'server-photo', text: caption, uris, imageSizes: dimensions });
});

it('keeps the caption and dimensions when a one-photo album falls back to a single send', async () => {
  const session = makeSession();
  expect(await RenderSender(session).sendPickedAlbum([portrait], caption)).toBe(true);
  expect(mockUpload).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0]).toMatchObject({ text: caption, imageWidth: 900, imageHeight: 1600 });
  expect(mockSend.mock.calls[0][0].uris).toBeUndefined();
  expect(session.messages).toHaveLength(1);
});

it('preserves a partial album on failure and retries only unfinished members through the actual media outbox', async () => {
  mockUpload.mockReset().mockResolvedValueOnce({ success: true, url: 'https://api.test/portrait.jpg' })
    .mockResolvedValueOnce({ success: false, error: 'offline' });
  const session = makeSession();
  expect(await RenderSender(session).sendPickedAlbum([portrait, landscape], caption)).toBe(false);
  await persistAll();
  expect(mockSend).not.toHaveBeenCalled();
  expect(enqueue).toHaveBeenCalledWith('photo-test-1');
  expect(persisted()[0]).toMatchObject({ text: caption, uris: ['https://api.test/portrait.jpg', landscape.uri],
    imageSizes: [{ width: 900, height: 1600 }, { width: 1600, height: 900 }] });
  nextMount();
  mockUpload.mockClear().mockResolvedValue({ success: true, url: 'https://api.test/landscape.jpg' });
  const retry = RenderRetry(session);
  expect(await retry.retryFailedOutgoingMessage(session.messages[0])).toBe(true);
  expect(mockUpload).toHaveBeenCalledTimes(1);
  expect(mockUpload.mock.calls[0][0]).toBe(landscape.uri);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0]).toMatchObject({ text: caption,
    uris: ['https://api.test/portrait.jpg', 'https://api.test/landscape.jpg'],
    imageSizes: [{ width: 900, height: 1600 }, { width: 1600, height: 900 }], clientUiMessageId: 'photo-test-1' });
});

it.each(['single', 'album'] as const)('finishes a %s upload after Back by patching only its stored bubble', async kind => {
  let finish!: (value: unknown) => void;
  mockUpload.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const session = makeSession();
  const sender = RenderSender(session);
  const pending = kind === 'single' ? sender.sendPickedImage(portrait, caption) : sender.sendPickedAlbum([portrait, landscape], caption);
  await persistAll();
  const original = persisted()[0];
  unmount();
  const newer: ChatMessage = { id: 'newer', type: 'text', text: 'Added in reopened chat' };
  await writeStoredChatMessages(key, [original, newer]);
  const oldSetMessages = session.setMessages as jest.Mock;
  oldSetMessages.mockClear().mockImplementation(() => { throw new Error('Old screen must not mutate reopened messages'); });
  finish({ success: true, url: 'https://api.test/portrait.jpg' });
  expect(await pending).toBe(true);
  expect(oldSetMessages).not.toHaveBeenCalled();
  expect(persisted()).toEqual([expect.objectContaining({ id: 'server-photo', text: caption,
    uri: 'https://api.test/portrait.jpg', imageWidth: 900, imageHeight: 1600 }), newer]);
  if (kind === 'album') expect(persisted()[0].uris).toEqual(['https://api.test/portrait.jpg', 'https://api.test/landscape.jpg']);
});

it.each(['single', 'album'] as const)('keeps queued %s status when the server id has not changed', async kind => {
  mockSend.mockResolvedValue({ ok: true, queued: true });
  const session = makeSession();
  const sender = RenderSender(session);
  const pending = kind === 'single' ? sender.sendPickedImage(portrait, caption) : sender.sendPickedAlbum([portrait, landscape], caption);
  expect(await pending).toBe(true);
  await persistAll();
  expect(session.readStatuses['photo-test-1']).toBe('sending');
  expect(persisted()[0]).toMatchObject({ id: 'photo-test-1', text: caption, imageWidth: 900, imageHeight: 1600 });
});

it('shares the actual original send with an outbox retry after reopening without another upload or message', async () => {
  let finish!: (value: unknown) => void;
  mockUpload.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const session = makeSession();
  const initial = RenderSender(session).sendPickedImage(portrait, caption);
  const registered = getChatMediaSend('me', 'peer', 'photo-test-1');
  expect(registered).toBeDefined();
  await persistAll();
  nextMount();
  const retry = RenderRetry(session).retryFailedOutgoingMessage(session.messages[0]);
  expect(retry).toBe(registered);
  finish({ success: true, url: 'https://api.test/portrait.jpg' });
  await Promise.all([initial, retry]);
  expect(mockUpload).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(persisted()[0]).toMatchObject({ id: 'server-photo', text: caption });
});

it('keeps an unsuccessful single-photo caption and dimensions available for an offline retry', async () => {
  mockUpload.mockResolvedValue({ success: false, error: 'offline' });
  const session = makeSession();
  expect(await RenderSender(session).sendPickedImage(portrait, caption)).toBe(false);
  await persistAll();
  expect(mockSend).not.toHaveBeenCalled();
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(persisted()[0]).toMatchObject({ text: caption, uri: portrait.uri, imageWidth: 900, imageHeight: 1600 });
  expect(session.readStatuses['photo-test-1']).toBe('failed');
});
