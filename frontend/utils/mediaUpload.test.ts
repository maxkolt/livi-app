const mockUpload = jest.fn();
const mockCancel = jest.fn(async () => undefined);
const mockEncrypt = jest.fn(async () => ({ uri: 'file:///encrypted.livi', key: { v: 1, k: 'secret', e: 'm4a' } }));
const mockRequirePeer = jest.fn(async () => undefined);
jest.mock('expo-file-system', () => ({
  FileSystemUploadType: { MULTIPART: 1 },
  getInfoAsync: jest.fn(async () => ({ exists: true })),
  deleteAsync: jest.fn(async () => undefined),
  createUploadTask: jest.fn(() => ({ uploadAsync: mockUpload, cancelAsync: mockCancel })),
}));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { PNG: 'png', JPEG: 'jpeg' } }));
jest.mock('./logger', () => ({ logger: { warn: jest.fn() } }));
jest.mock('./installId', () => ({ getInstallAuthHeaders: async () => ({ 'x-install-id': 'inst', 'x-install-secret': 'proof' }) }));
jest.mock('../sockets/socket', () => ({ API_BASE: 'https://api.test' }));
jest.mock('../sockets/modules/e2e', () => ({ requireMediaEncryptionPeer: (...args: unknown[]) => mockRequirePeer(...(args as [])) }));
jest.mock('./protectedMedia', () => ({ encryptMediaForUpload: (...args: unknown[]) => mockEncrypt(...(args as [])), attachMediaKey: (url: string) => url+'#livi-media=encrypted-key' }));
import * as FileSystem from 'expo-file-system';
import { uploadMediaToServer } from './mediaUpload';
beforeEach(() => { jest.clearAllMocks(); mockRequirePeer.mockResolvedValue(undefined); mockEncrypt.mockResolvedValue({ uri: 'file:///encrypted.livi', key: { v: 1, k: 'secret', e: 'm4a' } }); });
it('uploads only encrypted bytes with install proof and returns a local key descriptor', async () => {
  mockUpload.mockResolvedValue({ status: 200, body: JSON.stringify({ok:true,url:'/uploads/media/voice.livi'}) });
  const result = await uploadMediaToServer('file:///voice.m4a','audio',undefined,'owner','peer');
  expect(result).toMatchObject({success:true,url:'/uploads/media/voice.livi#livi-media=encrypted-key'});
  expect(FileSystem.createUploadTask).toHaveBeenCalledWith('https://api.test/api/upload/media/multipart','file:///encrypted.livi',expect.objectContaining({mimeType:'application/vnd.livi.encrypted',headers:expect.objectContaining({'x-install-secret':'proof'})}));
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///encrypted.livi',{idempotent:true});
});
it('never retries a failed encrypted transfer as plaintext', async () => {
  mockUpload.mockRejectedValue(new Error('network disconnected'));
  expect(await uploadMediaToServer('file:///voice.m4a','audio',undefined,'owner','peer')).toMatchObject({success:false,kind:'network'});
  expect(FileSystem.createUploadTask).toHaveBeenCalledTimes(1);
  expect(FileSystem.deleteAsync).toHaveBeenCalled();
});
it('does not upload to an outdated peer or after encryption fails', async () => {
  mockRequirePeer.mockRejectedValueOnce(new Error('recipient_update_required'));
  expect(await uploadMediaToServer('file:///voice.m4a','audio',undefined,'owner','peer')).toMatchObject({success:false,kind:'server'});
  expect(FileSystem.createUploadTask).not.toHaveBeenCalled();
  mockEncrypt.mockRejectedValueOnce(new Error('encryption failed'));
  expect((await uploadMediaToServer('file:///voice.m4a','audio',undefined,'owner','peer')).success).toBe(false);
  expect(FileSystem.createUploadTask).not.toHaveBeenCalled();
});
it('rejects missing identity before encryption or upload', async () => {
  expect(await uploadMediaToServer('file:///voice.m4a','audio')).toMatchObject({success:false,kind:'server'});
  expect(mockEncrypt).not.toHaveBeenCalled();
});
