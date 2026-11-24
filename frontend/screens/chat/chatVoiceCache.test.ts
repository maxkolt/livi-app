const mockFiles = new Set<string>();
const mockDownload = jest.fn();
const mockCancel = jest.fn(async () => {});
jest.mock('expo-file-system', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: async (uri: string) => ({ exists: mockFiles.has(uri) }),
  createDownloadResumable: (url: string, dest: string) => ({ downloadAsync: () => mockDownload(url, dest), cancelAsync: mockCancel }),
  moveAsync: async ({ to }: { from: string; to: string }) => { mockFiles.add(to); },
  deleteAsync: async (uri: string) => { mockFiles.delete(uri); },
}));
jest.mock('../../utils/protectedMedia', () => ({ isPrivateMedia: () => false }));
import { ensureVoiceCachedToLocalFile } from './chatVoiceCache';
const maps = () => ({ pathByUrl: new Map<string, string>(), inflightByUrl: new Map<string, Promise<string>>() });
beforeEach(() => { mockFiles.clear(); mockDownload.mockReset().mockImplementation(async (_url, dest) => ({ uri: dest, status: 200 })); });
it('deduplicates a native download and reuses its disk file across chat instances', async () => {
  const a = maps(), b = maps(), url = 'https://api.test/voice-one.m4a';
  const [first, second] = await Promise.all([ensureVoiceCachedToLocalFile(url, a), ensureVoiceCachedToLocalFile(url, b)]);
  expect(first).toBe(second); expect(mockDownload).toHaveBeenCalledTimes(1);
  expect(a.pathByUrl.get(url)).toBe(first); expect(b.pathByUrl.get(url)).toBe(first);
  expect(await ensureVoiceCachedToLocalFile(url, maps())).toBe(first); expect(mockDownload).toHaveBeenCalledTimes(1);
});
it('does not retain a finished download in a closed chat', async () => {
  const cache = { ...maps(), isCurrent: () => false };
  expect(await ensureVoiceCachedToLocalFile('https://api.test/closed.m4a', cache)).toMatch(/^file:/);
  expect(cache.pathByUrl.size).toBe(0); expect(cache.inflightByUrl.size).toBe(0);
});
it('does not publish an HTTP error body as playable audio and allows retry', async () => {
  const cache = maps(), url = 'https://api.test/retry.m4a'; mockDownload.mockResolvedValueOnce({ uri: 'file:///error', status: 503 });
  await expect(ensureVoiceCachedToLocalFile(url, cache)).rejects.toThrow('voice_download_failed');
  expect(cache.pathByUrl.size).toBe(0); expect(cache.inflightByUrl.size).toBe(0);
  await expect(ensureVoiceCachedToLocalFile(url, cache)).resolves.toMatch(/^file:/);
});
