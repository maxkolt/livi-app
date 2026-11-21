const mockDownload = jest.fn();
const mockDecrypt = jest.fn();
let mockOwner = 'alice';
jest.mock('../sockets/modules/constants', () => ({ API_BASE: 'https://api.test' }));
jest.mock('../sockets/modules/authState', () => ({ getCurrentUserId: () => mockOwner }));
jest.mock('./installId', () => ({ getInstallAuthHeaders: async () => ({ 'x-install-id': 'install', 'x-install-secret': 'proof' }) }));
jest.mock('expo-file-system', () => ({ cacheDirectory: 'file:///cache/', getInfoAsync: async () => ({ exists: true }), downloadAsync: (...args: unknown[]) => mockDownload(...args), deleteAsync: jest.fn(async () => undefined) }));
jest.mock('react-native', () => ({ NativeModules: { LiviCrypto: { decryptMedia: (...args: unknown[]) => mockDecrypt(...args) } } }));
import { attachMediaKey, parseMediaKey, mediaWireUrl, resolveProtectedMedia } from './protectedMedia';
const key = { v: 1 as const, k: Buffer.alloc(32, 3).toString('base64'), e: 'jpg' };
beforeEach(() => { mockOwner = 'alice'; jest.clearAllMocks(); mockDecrypt.mockResolvedValue('file:///cache/plain.jpg'); });
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
  expect(await resolveProtectedMedia(uri)).toBe('file:///cache/plain.jpg');
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
