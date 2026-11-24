const mockDownload = jest.fn();
const mockDecrypt = jest.fn();
const mockEncrypt = jest.fn();
const mockFiles = new Set<string>();
const mockCancel = jest.fn(async () => {});
let mockOwner = 'alice';
jest.mock('../sockets/modules/constants', () => ({ API_BASE: 'https://api.test' }));
jest.mock('../sockets/modules/authState', () => ({ getCurrentUserId: () => mockOwner }));
jest.mock('./installId', () => ({ getInstallAuthHeaders: async () => ({ 'x-install-id': 'install', 'x-install-secret': 'proof' }) }));
jest.mock('expo-file-system', () => ({ cacheDirectory: 'file:///cache/', getInfoAsync: async (uri: string) => ({ exists: mockFiles.has(uri) }), createDownloadResumable: (...args: unknown[]) => ({ downloadAsync: () => mockDownload(...args), cancelAsync: mockCancel }), moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => { mockFiles.delete(from); mockFiles.add(to); }), deleteAsync: jest.fn(async (uri: string) => { mockFiles.delete(uri); }) }));
jest.mock('react-native', () => ({ NativeModules: { LiviCrypto: { decryptMedia: (...args: unknown[]) => mockDecrypt(...args), encryptMedia: (...args: unknown[]) => mockEncrypt(...args) } } }));
import { notifyMemoryPressure } from './memoryPressure';
import { attachMediaKey, parseMediaKey, mediaWireUrl, resolveProtectedMedia, encryptMediaForUpload } from './protectedMedia';
const key = { v: 1 as const, k: Buffer.alloc(32, 3).toString('base64'), e: 'jpg' };
beforeEach(() => { mockOwner = 'alice'; jest.clearAllMocks(); mockFiles.clear(); notifyMemoryPressure(); mockDecrypt.mockResolvedValue('file:///cache/plain.jpg'); });
it('keeps a valid key only in local metadata and strips it from the network URL', () => {
  const uri = attachMediaKey('/uploads/media/photo.livi', key);
  expect(parseMediaKey(uri)).toEqual(key);
  expect(mediaWireUrl(uri)).toBe('/uploads/media/photo.livi');
  expect(() => attachMediaKey('https://other.test/uploads/media/photo.livi', key)).toThrow();
  expect(() => mediaWireUrl('/uploads/media/a.livi#livi-media=bad')).toThrow();
});
it('downloads with proof, authenticates/decrypts locally, and isolates the cache by owner', async () => {
  mockDownload.mockImplementation(async (_url: string, dest: string) => ({ status: 200, uri: dest }));
  const uri = attachMediaKey('/uploads/media/round-trip.livi', key);
  expect(await resolveProtectedMedia(uri)).toMatch(/^file:\/\/\/cache\/private-[a-f0-9]{64}\.jpg$/);
  expect(mockDownload).toHaveBeenCalledWith('https://api.test/uploads/media/round-trip.livi', expect.any(String), { headers: { 'x-install-id': 'install', 'x-install-secret': 'proof' } });
  expect(mockDecrypt).toHaveBeenCalledWith(expect.any(String), key.k, 'jpg');
  mockOwner = 'bob';
  await resolveProtectedMedia(uri);
  expect(mockDownload).toHaveBeenCalledTimes(2);
});
it('never sends credentials to external hosts', async () => {
  expect(await resolveProtectedMedia('https://other.test/uploads/media/photo.jpg')).toBe('https://other.test/uploads/media/photo.jpg');
  expect(mockDownload).not.toHaveBeenCalled();
});
it('never decrypts or caches an unauthorized download', async () => {
  mockDownload.mockResolvedValue({ status: 401, uri: 'file:///cache/rejected.livi' });
  await expect(resolveProtectedMedia(attachMediaKey('/uploads/media/rejected.livi', key))).rejects.toThrow('media_access_denied');
  expect(mockDecrypt).not.toHaveBeenCalled();
});
it('does not expose a cached result after the signed-in owner changes during download', async () => {
  mockDownload.mockImplementationOnce(async (_url: string, dest: string) => { mockOwner = 'bob'; return { status: 200, uri: dest }; });
  await expect(resolveProtectedMedia(attachMediaKey('/uploads/media/account-change.livi', key))).rejects.toThrow('identity_changed');
});

it.each([
  ['image', 'jpg'], ['audio', 'm4a'], ['video', 'mp4'],
] as const)('keeps native encryption and key metadata for %s uploads', async (type, extension) => {
  const uri = `file:///cache/message.${extension}`;
  mockEncrypt.mockResolvedValueOnce({ uri: 'file:///cache/encrypted.livi', key: key.k });
  await expect(encryptMediaForUpload(uri, type)).resolves.toEqual({
    uri: 'file:///cache/encrypted.livi', key: { v: 1, k: key.k, e: extension },
  });
  expect(mockEncrypt).toHaveBeenCalledWith(uri);
});


it('reuses its owner-specific disk file after memory pressure without another download/decryption', async () => {
  mockDownload.mockImplementation(async (_url: string, dest: string) => ({ status: 200, uri: dest }));
  const uri = attachMediaKey('/uploads/media/disk-reuse.livi', key);
  const local = await resolveProtectedMedia(uri);
  notifyMemoryPressure();
  expect(await resolveProtectedMedia(uri)).toBe(local);
  expect(mockDownload).toHaveBeenCalledTimes(1); expect(mockDecrypt).toHaveBeenCalledTimes(1);
});
it('cancels expired native downloads and does not decrypt their late data', async () => {
  jest.useFakeTimers();
  try {
    let finish!: (value: {status: number; uri: string}) => void;
    mockDownload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const request = resolveProtectedMedia(attachMediaKey('/uploads/media/hung.livi', key));
    const rejected = expect(request).rejects.toThrow('media_request_timeout');
    for (let i = 0; i < 30; i++) await Promise.resolve();
    jest.advanceTimersByTime(45001); await rejected;
    expect(mockCancel).toHaveBeenCalledTimes(1);
    finish({status: 200, uri: 'file:///cache/late.livi'});
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(mockDecrypt).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});
