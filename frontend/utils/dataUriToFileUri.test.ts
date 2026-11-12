const mockFiles = new Map<string, string>();
const mockWrite = jest.fn(async (path: string, value: string) => { mockFiles.set(path, value); });
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-file-system', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: async (path: string) => ({ exists: mockFiles.has(path) }),
  writeAsStringAsync: (path: string, value: string) => mockWrite(path, value),
}));
import { peekResolvedDataUriCache, resolveDataUriForAndroid } from './dataUriToFileUri';

it('stores different photos separately even with identical JPEG headers and byte lengths', async () => {
  // JPEG headers can exceed the old 2000-character hash window.
  const header = 'A'.repeat(2400);
  const a = `data:image/jpeg;base64,${header}AAAA`;
  const b = `data:image/jpeg;base64,${header}BBBB`;
  const aFile = await resolveDataUriForAndroid(a);
  const bFile = await resolveDataUriForAndroid(b);
  expect(aFile).not.toBe(bFile);
  expect(mockFiles.get(aFile)).toBe(`${header}AAAA`);
  expect(mockFiles.get(bFile)).toBe(`${header}BBBB`);
  expect(peekResolvedDataUriCache(a)).toBe(aFile);
  expect(peekResolvedDataUriCache(b)).toBe(bFile);
  expect(await resolveDataUriForAndroid(b)).toBe(bFile);
  expect(mockWrite).toHaveBeenCalledTimes(2);
});

it('leaves file and HTTP sources unchanged', async () => {
  expect(await resolveDataUriForAndroid('file:///picked.jpg')).toBe('file:///picked.jpg');
  expect(await resolveDataUriForAndroid('https://api.test/avatar?v=2')).toBe('https://api.test/avatar?v=2');
});
