import type { ChatMessage } from './chatMessageTypes';
import type { ChatSessionState } from './useChatSessionState';

const mockStore = new Map<string, string>();
const mockUpload = jest.fn();
const mockSend = jest.fn();
const mockSocket = { on: jest.fn(), off: jest.fn() };
const mockSlots: unknown[] = [];
let mockCursor = 0;
let mockEffects: Array<() => void> = [];
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
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStore.get(key) || null),
  setItem: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  removeItem: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));
jest.mock('@react-native-community/netinfo', () => ({ addEventListener: () => () => {} }));
jest.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }));
jest.mock('../../sockets/socket', () => ({ __esModule: true, default: mockSocket, sendMessage: (...args: unknown[]) => mockSend(...args) }));
jest.mock('../../sockets/modules/messages', () => ({ clearMessageCacheForStorageKey: jest.fn() }));
jest.mock('../../utils/mediaUpload', () => ({ uploadMediaToServer: (...args: unknown[]) => mockUpload(...args) }));
jest.mock('./chatMessageMeta', () => ({ stickerFieldsFromMessage: () => ({}) }));

import { useChatMediaOutbox } from './useChatMediaOutbox';
import { getChatMediaOutboxKey, getChatMessagesKey } from './chatStorageKeys';
import { getChatMediaSend, trackChatMediaSend } from './chatMediaSendJobs';

const messagesKey = getChatMessagesKey('me', 'peer');
const caption = '  Фото 😀\nВторая строка\n';
const sizes = [{ width: 800, height: 1200 }, null, { width: 1600, height: 900 }];

function makeSession(message: ChatMessage, ready = false): ChatSessionState {
  const session = {
    peerId: 'peer', currentUserId: 'me', historyReady: ready,
    messages: [message], latestMessagesForPersistRef: { current: [message] },
    uploadStatus: {}, readStatuses: {},
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
  mockStore.set(messagesKey, JSON.stringify(session.messages));
  return session;
}
function RenderOutbox(session: ChatSessionState) {
  mockCursor = 0;
  const result = useChatMediaOutbox({ session, resolveMediaUri: uri => uri || '' });
  mockEffects.splice(0).forEach(effect => effect());
  return result;
}
const storedMessages = (): ChatMessage[] => JSON.parse(mockStore.get(messagesKey) || '[]');
const flush = async () => { for (let index = 0; index < 60; index++) await Promise.resolve(); };
function unmount() {
  mockSlots.forEach(slot => (slot as { cleanup?: () => void } | undefined)?.cleanup?.());
}

beforeEach(() => {
  mockStore.clear(); mockSlots.length = 0; mockCursor = 0; mockEffects = [];
  mockUpload.mockReset(); mockSend.mockReset(); mockSocket.on.mockClear(); mockSocket.off.mockClear();
  mockSend.mockResolvedValue({ ok: true, messageId: 'server-image', delivered: true });
});
afterEach(() => { unmount(); });

it('retries every local album member and preserves exact caption, dimensions and reply through delivery', async () => {
  const remoteFirst = 'https://api.test/first.jpg';
  const message: ChatMessage = { id: 'album', type: 'image', uri: remoteFirst,
    uris: [remoteFirst, 'file:///second.jpg', 'file:///third.jpg'], text: caption,
    imageWidth: 800, imageHeight: 1200, imageSizes: sizes,
    replyTo: { id: 'quoted', text: 'reply', from: 'peer', isOwn: false },
  };
  mockUpload.mockImplementation(async (uri: string) => ({ success: true, url: `https://api.test/${uri.split('/').pop()}` }));
  const session = makeSession(message);
  const { retryFailedOutgoingMessage } = RenderOutbox(session);
  expect(await retryFailedOutgoingMessage(message)).toBe(true);
  expect(mockUpload.mock.calls.map(call => call[0])).toEqual(['file:///second.jpg', 'file:///third.jpg']);
  const uris = [remoteFirst, 'https://api.test/second.jpg', 'https://api.test/third.jpg'];
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ type: 'image', uri: remoteFirst, uris,
    text: caption, imageWidth: 800, imageHeight: 1200, imageSizes: sizes,
    replyTo: message.replyTo, clientUiMessageId: 'album',
  }));
  expect(session.messages[0]).toMatchObject({ id: 'server-image', uris, text: caption, imageSizes: sizes });
  expect(storedMessages()[0]).toMatchObject({ id: 'server-image', uris, text: caption, imageSizes: sizes });
});

it('never sends a partial album and resumes a later retry without uploading completed members again', async () => {
  const message: ChatMessage = { id: 'partial', type: 'image', uri: 'file:///first.jpg',
    uris: ['file:///first.jpg', 'file:///second.jpg', 'file:///third.jpg'], text: caption, imageSizes: sizes };
  mockUpload.mockResolvedValueOnce({ success: true, url: 'https://api.test/first.jpg' })
    .mockResolvedValueOnce({ success: false, error: 'offline' });
  const session = makeSession(message);
  const { retryFailedOutgoingMessage } = RenderOutbox(session);
  expect(await retryFailedOutgoingMessage(message)).toBe(false);
  expect(mockSend).not.toHaveBeenCalled();
  expect(storedMessages()[0]).toMatchObject({ text: caption, imageSizes: sizes,
    uris: ['https://api.test/first.jpg', 'file:///second.jpg', 'file:///third.jpg'] });
  mockUpload.mockClear().mockImplementation(async (uri: string) => ({ success: true, url: `https://api.test/${uri.split('/').pop()}` }));
  expect(await retryFailedOutgoingMessage(session.messages[0])).toBe(true);
  expect(mockUpload.mock.calls.map(call => call[0])).toEqual(['file:///second.jpg', 'file:///third.jpg']);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0]).toMatchObject({ text: caption, imageSizes: sizes,
    uris: ['https://api.test/first.jpg', 'https://api.test/second.jpg', 'https://api.test/third.jpg'] });
});

it('shares an in-flight retry between repeated taps instead of creating duplicate uploads or sends', async () => {
  const message: ChatMessage = { id: 'dedupe', type: 'image', uri: 'file:///one.jpg', text: caption };
  let finish!: (value: unknown) => void;
  mockUpload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { retryFailedOutgoingMessage } = RenderOutbox(makeSession(message));
  const first = retryFailedOutgoingMessage(message);
  const second = retryFailedOutgoingMessage(message);
  expect(second).toBe(first);
  finish({ success: true, url: 'https://api.test/one.jpg' });
  await Promise.all([first, second]);
  expect(mockUpload).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
});

it('patches only its persisted bubble after Back while retaining messages written by the reopened chat', async () => {
  const message: ChatMessage = { id: 'back', type: 'image', uri: 'file:///portrait.jpg', text: caption,
    imageWidth: 900, imageHeight: 1600 };
  let finish!: (value: unknown) => void;
  mockUpload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const session = makeSession(message);
  const { retryFailedOutgoingMessage } = RenderOutbox(session);
  const pending = retryFailedOutgoingMessage(message);
  unmount();
  const newer: ChatMessage = { id: 'newer', type: 'text', text: 'Written after reopening' };
  mockStore.set(messagesKey, JSON.stringify([message, newer]));
  finish({ success: true, url: 'https://api.test/portrait.jpg' });
  expect(await pending).toBe(true);
  expect(session.setMessages).not.toHaveBeenCalled();
  expect(storedMessages()).toEqual([expect.objectContaining({ id: 'server-image', text: caption,
    imageWidth: 900, imageHeight: 1600, uri: 'https://api.test/portrait.jpg' }), newer]);
});

it('joins a retry still uploading in the previous screen after reopening the conversation', async () => {
  const message: ChatMessage = { id: 'reopen-inflight', type: 'image', uri: 'file:///portrait.jpg', text: caption };
  let finish!: (value: unknown) => void;
  mockUpload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const old = RenderOutbox(makeSession(message));
  const first = old.retryFailedOutgoingMessage(message);
  unmount();
  mockSlots.length = 0;
  mockEffects = [];
  const reopened = RenderOutbox(makeSession(message));
  const second = reopened.retryFailedOutgoingMessage(message);
  expect(second).toBe(first);
  finish({ success: true, url: 'https://api.test/portrait.jpg' });
  await Promise.all([first, second]);
  expect(mockUpload).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(storedMessages()[0]).toMatchObject({ id: 'server-image', text: caption });
});

it('joins the original initial send after Back instead of starting a competing outbox upload', async () => {
  const message: ChatMessage = { id: 'initial-send-race', type: 'image', uri: 'file:///portrait.jpg', text: caption };
  let finish!: (value: unknown) => void;
  mockUpload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const original = trackChatMediaSend('me', 'peer', message.id!, (async () => {
    const uploaded = await mockUpload(message.uri);
    const sent = await mockSend({ type: 'image', uri: uploaded.url, text: caption, clientUiMessageId: message.id });
    return !!sent.ok;
  })());
  const reopened = RenderOutbox(makeSession(message));
  const retry = reopened.retryFailedOutgoingMessage(message);
  expect(retry).toBe(original);
  expect(mockUpload).toHaveBeenCalledTimes(1);
  finish({ success: true, url: 'https://api.test/portrait.jpg' });
  await Promise.all([original, retry]);
  expect(mockUpload).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(getChatMediaSend('me', 'peer', message.id!)).toBeUndefined();
});

it('drains a restored album with a remote first photo and a pending local second photo', async () => {
  const message: ChatMessage = { id: 'restore', type: 'image', uri: 'https://api.test/first.jpg',
    uris: ['https://api.test/first.jpg', 'file:///second.jpg'], text: caption,
    imageSizes: [null, { width: 1600, height: 900 }] };
  const key = getChatMediaOutboxKey('me', 'peer');
  mockStore.set(key, JSON.stringify(['restore']));
  mockUpload.mockResolvedValue({ success: true, url: 'https://api.test/second.jpg' });
  RenderOutbox(makeSession(message, true));
  await flush();
  expect(mockUpload).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ text: caption,
    uris: ['https://api.test/first.jpg', 'https://api.test/second.jpg'],
    imageSizes: [null, { width: 1600, height: 900 }],
  }));
  expect(mockStore.has(key)).toBe(false);
});

it('retains a queued single-photo caption without depending on a server message id', async () => {
  const message: ChatMessage = { id: 'queued', type: 'image', uri: 'https://api.test/portrait.jpg',
    text: caption, imageWidth: 900, imageHeight: 1600 };
  mockSend.mockResolvedValue({ ok: true, queued: true });
  const session = makeSession(message);
  const { retryFailedOutgoingMessage } = RenderOutbox(session);
  expect(await retryFailedOutgoingMessage(message)).toBe(true);
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockSend.mock.calls[0][0]).toMatchObject({ text: caption, imageWidth: 900, imageHeight: 1600 });
  expect(session.readStatuses.queued).toBe('sending');
  expect(storedMessages()[0]).toMatchObject({ id: 'queued', text: caption, imageWidth: 900, imageHeight: 1600 });
});

it('preserves legacy serialized album positions and omits an all-whitespace caption', async () => {
  const message: ChatMessage = { id: 'legacy', type: 'image', uri: 'https://api.test/one.jpg',
    uris: JSON.stringify(['https://api.test/one.jpg', 'https://api.test/two.jpg']), text: ' \n ',
    imageSizes: [null, { width: 1000, height: 2000 }] };
  const { retryFailedOutgoingMessage } = RenderOutbox(makeSession(message));
  await retryFailedOutgoingMessage(message);
  expect(mockSend.mock.calls[0][0]).toMatchObject({ uris: ['https://api.test/one.jpg', 'https://api.test/two.jpg'],
    imageSizes: [null, { width: 1000, height: 2000 }] });
  expect(mockSend.mock.calls[0][0].text).toBeUndefined();
});
