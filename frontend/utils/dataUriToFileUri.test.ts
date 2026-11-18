import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const mockFiles = new Map<string, string>();
const mockWrite = jest.fn(async (path: string, value: string) => { mockFiles.set(path, value); });
const mockMove = jest.fn(async ({ from, to }: { from: string; to: string }) => {
  if (!mockFiles.has(from)) throw new Error('source missing');
  mockFiles.set(to, mockFiles.get(from)!);
  mockFiles.delete(from);
});
const mockDelete = jest.fn(async (path: string) => { mockFiles.delete(path); });
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-file-system', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: async (path: string) => ({
    exists: mockFiles.has(path), isDirectory: false,
    size: Buffer.from(mockFiles.get(path) || '', 'base64').length,
  }),
  writeAsStringAsync: (path: string, value: string) => mockWrite(path, value),
  moveAsync: (options: { from: string; to: string }) => mockMove(options),
  deleteAsync: (path: string) => mockDelete(path),
}));
import { peekResolvedDataUriCache, resolveDataUriForAndroid } from './dataUriToFileUri';

const fileFor = (uri: string) => `file:///cache/glide_data_uri_avatar_${bytesToHex(sha256(uri))}.jpg`;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  mockFiles.clear();
  mockWrite.mockReset().mockImplementation(async (path, value) => { mockFiles.set(path, value); });
  mockMove.mockReset().mockImplementation(async ({ from, to }) => {
    if (!mockFiles.has(from)) throw new Error('source missing');
    mockFiles.set(to, mockFiles.get(from)!);
    mockFiles.delete(from);
  });
  mockDelete.mockReset().mockImplementation(async path => { mockFiles.delete(path); });
});

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
  expect(mockMove).toHaveBeenCalledTimes(2);
});

it('leaves file and HTTP sources unchanged', async () => {
  expect(await resolveDataUriForAndroid('file:///picked.jpg')).toBe('file:///picked.jpg');
  expect(await resolveDataUriForAndroid('https://api.test/avatar?v=2')).toBe('https://api.test/avatar?v=2');
});

it('keeps concurrent readers pending until the complete file has been atomically published', async () => {
  const data = 'data:image/jpeg;base64,Y29uY3VycmVudC1hdmF0YXI=';
  const file = fileFor(data);
  let finishWrite!: () => void;
  mockWrite.mockImplementation((path, value) => new Promise(resolve => {
    mockFiles.set(path, value.slice(0, 4));
    finishWrite = () => { mockFiles.set(path, value); resolve(); };
  }));
  const first = resolveDataUriForAndroid(data);
  await flush();
  let secondReady = false;
  const second = resolveDataUriForAndroid(data).then(value => { secondReady = true; return value; });
  await flush();
  expect(mockWrite).toHaveBeenCalledTimes(1);
  expect(mockFiles.has(`${file}.pending`)).toBe(true);
  expect(mockFiles.has(file)).toBe(false);
  expect(peekResolvedDataUriCache(data)).toBeNull();
  expect(secondReady).toBe(false);
  finishWrite();
  expect(await Promise.all([first, second])).toEqual([file, file]);
  expect(mockFiles.get(file)).toBe(data.split(',')[1]);
  expect(mockFiles.has(`${file}.pending`)).toBe(false);
  expect(mockMove).toHaveBeenCalledTimes(1);
  expect(peekResolvedDataUriCache(data)).toBe(file);
});

it.each(['write', 'move'])('cleans up an incomplete %s and releases pending callers so the next request can retry', async stage => {
  const data = `data:image/jpeg;base64,${Buffer.from(`failed-${stage}-avatar`).toString('base64')}`;
  const file = fileFor(data);
  if (stage === 'write') {
    mockWrite.mockImplementationOnce(async (path, value) => {
      mockFiles.set(path, value.slice(0, 4));
      throw new Error('write interrupted');
    });
  } else {
    mockMove.mockRejectedValueOnce(new Error('rename interrupted'));
  }
  expect(await resolveDataUriForAndroid(data)).toBe(data);
  expect(peekResolvedDataUriCache(data)).toBeNull();
  expect(mockFiles.has(`${file}.pending`)).toBe(false);
  expect(mockFiles.has(file)).toBe(false);
  expect(await resolveDataUriForAndroid(data)).toBe(file);
  expect(mockFiles.get(file)).toBe(data.split(',')[1]);
  expect(mockWrite).toHaveBeenCalledTimes(2);
});

it('reuses a complete cache file but replaces a truncated file left by an older process', async () => {
  const complete = 'data:image/jpeg;base64,Y29tcGxldGUtYXZhdGFy';
  const partial = 'data:image/jpeg;base64,cGFydGlhbC1hdmF0YXI=';
  mockFiles.set(fileFor(complete), complete.split(',')[1]);
  mockFiles.set(fileFor(partial), 'cGFy');
  expect(await resolveDataUriForAndroid(complete)).toBe(fileFor(complete));
  expect(mockWrite).not.toHaveBeenCalled();
  expect(await resolveDataUriForAndroid(partial)).toBe(fileFor(partial));
  expect(mockWrite).toHaveBeenCalledTimes(1);
  expect(mockFiles.get(fileFor(partial))).toBe(partial.split(',')[1]);
});
