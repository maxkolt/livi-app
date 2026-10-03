/**
 * Загрузка голосового при плохой связи: старое соединение после смены сети не держит
 * отправку, а под VPN, где multipart не проходит, голосовое уходит обычным запросом.
 */

const mockTasks: Array<{ uploadAsync: jest.Mock; cancelAsync: jest.Mock }> = [];
const mockNextUpload: Array<() => Promise<unknown>> = [];
jest.mock('expo-file-system', () => ({
  FileSystemUploadType: { MULTIPART: 1 },
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 2048 })),
  readAsStringAsync: jest.fn(async () => 'QUJD'),
  createUploadTask: jest.fn(() => {
    const run = mockNextUpload.shift() ?? (() => Promise.reject(new Error('no upload scripted')));
    const task = { uploadAsync: jest.fn(run), cancelAsync: jest.fn(async () => undefined) };
    mockTasks.push(task);
    return task;
  }),
}));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { PNG: 'png', JPEG: 'jpeg' } }));
jest.mock('./logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } }));
jest.mock('./installId', () => ({ getInstallId: jest.fn(async () => 'inst') }));
jest.mock('../sockets/socket', () => ({ API_BASE: 'https://api.test' }));

const mockFetch = jest.fn();
(global as any).fetch = (...args: unknown[]) => mockFetch(...args);

type Upload = typeof import('./mediaUpload');
let upload: Upload['uploadMediaToServer'];

const ok = (url: string) => async () => ({ status: 200, body: JSON.stringify({ ok: true, url }) });
const fails = (message: string) => async () => {
  throw new Error(message);
};

beforeEach(() => {
  jest.resetModules();
  mockTasks.length = 0;
  mockNextUpload.length = 0;
  mockFetch.mockReset();
  upload = require('./mediaUpload').uploadMediaToServer;
});

describe('uploadMediaToServer on a bad network', () => {
  it('retries at once on a dead pooled connection right after the network changed', async () => {
    mockNextUpload.push(fails('connection closed'), ok('/uploads/v.m4a'));

    const res = await upload('file:///v.m4a', 'audio');

    expect(res).toEqual({ success: true, url: '/uploads/v.m4a' });
    expect(mockTasks).toHaveLength(2);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends a voice message with a plain request when multipart does not get through (VPN)', async () => {
    mockNextUpload.push(fails('Software caused connection abort'), fails('Software caused connection abort'));
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, url: '/uploads/v2.m4a' }) });

    const res = await upload('file:///v.m4a', 'audio');

    expect(res).toEqual(expect.objectContaining({ success: true, url: '/uploads/v2.m4a' }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test/api/upload/media');
  });

  it('reports no network when both ways fail, so the queue retries later', async () => {
    mockNextUpload.push(fails('Unable to resolve host'));
    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));

    const res = await upload('file:///v.m4a', 'audio');

    expect(res).toEqual(expect.objectContaining({ success: false, kind: 'network' }));
  });

  it('does not send a photo a second, much heavier way', async () => {
    mockNextUpload.push(fails('Unable to resolve host'));

    const res = await upload('file:///p.gif', 'image');

    expect(res).toEqual(expect.objectContaining({ success: false, kind: 'network' }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('stops at once when the queue cancels the upload (network changed)', async () => {
    let cancel: () => void = () => {};
    mockNextUpload.push(() => new Promise((resolve) => setTimeout(() => resolve(null), 10)));
    const pending = upload('file:///v.m4a', 'audio', undefined, undefined, undefined, {
      registerCancel: (c) => {
        cancel = c;
      },
    });
    await new Promise((r) => setImmediate(r));
    cancel();
    const res = await pending;

    expect(res).toEqual(expect.objectContaining({ success: false, kind: 'network' }));
    expect(mockTasks[0].cancelAsync).toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('says the file is gone instead of retrying forever', async () => {
    const FileSystem = require('expo-file-system');
    FileSystem.getInfoAsync.mockResolvedValueOnce({ exists: false });

    const res = await upload('file:///gone.m4a', 'audio');

    expect(res).toEqual(expect.objectContaining({ success: false, kind: 'file' }));
    expect(mockTasks).toHaveLength(0);
  });
});
