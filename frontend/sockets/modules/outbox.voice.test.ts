/**
 * Голосовое, записанное без сети или при плохой связи: очередь сама загружает файл,
 * когда сеть вернётся, отправляет сообщение уже с адресом на сервере, меняет адрес
 * в сохранённой истории чата и удаляет локальный файл. Пропавший файл — «не отправлено»,
 * а не вечное ожидание.
 */

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => (mockStore.has(k) ? mockStore.get(k)! : null)),
  setItem: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
  removeItem: jest.fn(async (k: string) => {
    mockStore.delete(k);
  }),
}));

const mockEmitAck = jest.fn();
const mockPost = jest.fn();
const mockUpload = jest.fn();
const mockDeleteFile = jest.fn(async () => undefined);
const mockSocket = { connected: true };
jest.mock('./emit', () => ({ emitAck: (...args: unknown[]) => mockEmitAck(...args) }));
jest.mock('./apiHttp', () => ({ postApiJson: (...args: unknown[]) => mockPost(...args) }));
jest.mock('./reauth', () => ({ ensureReauthBeforePrivilegedSocketOp: jest.fn(async () => true) }));
jest.mock('./socketCore', () => ({ socket: mockSocket }));
jest.mock('./constants', () => ({ API_BASE: 'https://api.test' }));
jest.mock('../../utils/mediaUpload', () => ({
  uploadMediaToServer: (...args: unknown[]) => mockUpload(...args),
}));
jest.mock('expo-file-system', () => ({ deleteAsync: (...args: unknown[]) => mockDeleteFile(...(args as [])) }));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('./e2e', () => ({
  E2eUnavailableError: class extends Error {},
  invalidateKeysAfterMismatch: jest.fn(async () => undefined),
  toWireMessagePayload: jest.fn(async (p: unknown) => p),
  toWireEditPayload: jest.fn(async (messageId: string, text: string) => ({ messageId, text })),
}));
jest.mock('./shared', () => ({
  shared: {
    currentUserId: 'me',
    reconnecting: false,
    cancelledOutboxSendIds: new Set<string>(),
    cancelledOutboxDiskHydrated: false,
    outboxDrainInFlight: null,
    editOutboxDrainInFlight: null,
    outboxMessageDeliveredSubs: new Set(),
    messageCache: new Map(),
  },
}));

type Outbox = typeof import('./outbox');
let outbox: Outbox;

const OUTBOX_KEY = 'chat_message_outbox_v1';
const CHAT_KEY = 'chat_messages_me_peer';
const LOCAL = 'file:///doc/voice-outbox/a.m4a';
const queuedRows = () => JSON.parse(mockStore.get(OUTBOX_KEY) ?? '[]');
const enqueueVoice = () =>
  outbox.enqueueMessageOutbox({
    id: 'outbox_a',
    optimisticUiId: 'a',
    createdAt: 1,
    payload: { to: 'peer', type: 'audio', localUri: LOCAL, duration: 3, clientMessageId: 'a' },
  });
const ackOk = async (_event: string, p: any) => ({ ok: true, messageId: p.clientMessageId });

beforeEach(() => {
  jest.resetModules();
  jest.useRealTimers();
  mockStore.clear();
  mockEmitAck.mockReset();
  mockPost.mockReset();
  mockUpload.mockReset();
  mockDeleteFile.mockClear();
  mockSocket.connected = true;
  mockStore.set(CHAT_KEY, JSON.stringify([{ id: 'a', type: 'audio', uri: LOCAL, from: 'me', to: 'peer' }]));
  outbox = require('./outbox');
});

describe('voice message in the outbox', () => {
  it('waits for the network with a clock, then uploads and sends with the server address', async () => {
    jest.useFakeTimers();
    await enqueueVoice();
    mockUpload.mockResolvedValueOnce({ success: false, kind: 'network', error: 'Network error' });
    const failed: any[] = [];
    outbox.onOutboxMessageFailed((e) => failed.push(e));

    await outbox.drainMessageOutbox();
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockEmitAck).not.toHaveBeenCalled();
    expect(outbox.isMessagePendingInOutbox('a')).toBe(true);
    expect(failed).toEqual([]);

    mockUpload.mockResolvedValueOnce({ success: true, url: '/uploads/v.m4a' });
    mockEmitAck.mockImplementation(ackOk);
    const delivered: any[] = [];
    outbox.onOutboxMessageDelivered((e) => delivered.push(e));
    await jest.advanceTimersByTimeAsync(2000);

    expect(mockUpload).toHaveBeenCalledTimes(2);
    const wire = mockEmitAck.mock.calls[0][1];
    expect(wire.uri).toBe('https://api.test/uploads/v.m4a');
    expect(wire).not.toHaveProperty('localUri');
    expect(delivered).toEqual([
      expect.objectContaining({ optimisticUiId: 'a', serverMessageId: 'a', uri: 'https://api.test/uploads/v.m4a' }),
    ]);
    expect(queuedRows()).toEqual([]);
    expect(outbox.isMessagePendingInOutbox('a')).toBe(false);
  });

  it('swaps the stored chat history to the server address and deletes the local file', async () => {
    await enqueueVoice();
    mockUpload.mockResolvedValueOnce({ success: true, url: 'https://cdn.test/v.m4a' });
    mockEmitAck.mockImplementation(ackOk);

    await outbox.drainMessageOutbox();
    // Правка истории и удаление файла идут после события доставки.
    await new Promise((r) => setImmediate(r));

    expect(JSON.parse(mockStore.get(CHAT_KEY)!)[0].uri).toBe('https://cdn.test/v.m4a');
    expect(mockDeleteFile).toHaveBeenCalledWith(LOCAL, { idempotent: true });
  });

  it('does not upload the file again when only the send failed', async () => {
    jest.useFakeTimers();
    mockSocket.connected = false;
    await enqueueVoice();
    mockUpload.mockResolvedValue({ success: true, url: 'https://cdn.test/v.m4a' });
    mockPost.mockRejectedValueOnce(new TypeError('Network request failed'));

    await outbox.drainMessageOutbox();
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(queuedRows()[0].payload.uri).toBe('https://cdn.test/v.m4a');

    mockPost.mockImplementation(async (_path: string, p: any) => ({ ok: true, messageId: p.clientMessageId }));
    await jest.advanceTimersByTimeAsync(2000);

    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(queuedRows()).toEqual([]);
  });

  it('marks the voice message failed when the recording is gone, instead of waiting forever', async () => {
    await enqueueVoice();
    mockUpload.mockResolvedValueOnce({ success: false, kind: 'file', error: 'File not found' });
    const failed: any[] = [];
    outbox.onOutboxMessageFailed((e) => failed.push(e));

    await outbox.drainMessageOutbox();

    expect(failed).toEqual([{ to: 'peer', outboxId: 'outbox_a', optimisticUiId: 'a', error: 'upload_file_missing' }]);
    expect(mockEmitAck).not.toHaveBeenCalled();
    expect(queuedRows()).toEqual([]);
    // Файла нет — удалять нечего; запись в истории не трогаем.
    expect(JSON.parse(mockStore.get(CHAT_KEY)!)[0].uri).toBe(LOCAL);
  });

  it('keeps retrying when the server rejects the upload for a while', async () => {
    await enqueueVoice();
    mockUpload.mockResolvedValue({ success: false, kind: 'server', error: 'Server error 502' });
    const failed: any[] = [];
    outbox.onOutboxMessageFailed((e) => failed.push(e));

    await outbox.drainMessageOutbox();

    expect(failed).toEqual([]);
    expect(queuedRows()).toEqual([expect.objectContaining({ id: 'outbox_a', attempts: 1 })]);
  });

  it('deletes the local recording when the message was deleted before it went out', async () => {
    await enqueueVoice();
    await outbox.removeQueuedMessagesMatching(['a']);
    await outbox.drainMessageOutbox();

    expect(mockUpload).not.toHaveBeenCalled();
    expect(queuedRows()).toEqual([]);
    expect(mockDeleteFile).toHaveBeenCalledWith(LOCAL, { idempotent: true });
  });

  it('sends right away when the network is back instead of waiting out the offline pause', async () => {
    jest.useFakeTimers();
    await enqueueVoice();
    mockUpload.mockResolvedValue({ success: false, kind: 'network', error: 'Network error' });

    // Долго без сети: пауза дошла до потолка (2 → 4 → 8 → 15 с).
    await outbox.drainMessageOutbox();
    await jest.advanceTimersByTimeAsync(2000 + 4000 + 8000);
    expect(mockUpload).toHaveBeenCalledTimes(4);

    // Сеть вернулась: первая попытка ещё упала на старом соединении,
    // но следующая — через 2 с, а не через 15.
    outbox.noteNetworkBack();
    await outbox.drainMessageOutbox();
    expect(mockUpload).toHaveBeenCalledTimes(5);
    mockUpload.mockResolvedValue({ success: true, url: 'https://cdn.test/v.m4a' });
    mockEmitAck.mockImplementation(ackOk);
    await jest.advanceTimersByTimeAsync(2000);

    expect(mockUpload).toHaveBeenCalledTimes(6);
    expect(queuedRows()).toEqual([]);
  });

  it('drops an upload stuck on the old network and starts it again when the network changes', async () => {
    jest.useFakeTimers();
    await enqueueVoice();
    // Первая загрузка повисла (сеть пропала посреди неё) и ответит только на отмену.
    mockUpload.mockImplementationOnce(
      (_uri: string, _type: string, _p: unknown, _from: unknown, _to: unknown, opts: any) =>
        new Promise((resolve) => {
          opts.registerCancel(() => resolve({ success: false, kind: 'network', error: 'Upload cancelled' }));
        }),
    );
    mockUpload.mockResolvedValue({ success: true, url: 'https://cdn.test/v.m4a' });
    mockEmitAck.mockImplementation(ackOk);

    const drain = outbox.drainMessageOutbox();
    await jest.advanceTimersByTimeAsync(10);
    expect(mockUpload).toHaveBeenCalledTimes(1);

    outbox.noteNetworkBack({ restartUpload: true });
    await drain;
    await jest.advanceTimersByTimeAsync(1000);

    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(mockEmitAck).toHaveBeenCalledTimes(1);
    expect(queuedRows()).toEqual([]);
  });
});
