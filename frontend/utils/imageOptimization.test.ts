const mockPrefetch = jest.fn(async (_source: string, _policy?: string) => true);
const mockLoad = jest.fn(async (_source: { uri: string }, _options?: { maxWidth: number; maxHeight: number }) => ({ width: 96, height: 96, scale: 1 }));
const mockClearMemory = jest.fn(async () => true);
const mockClearDisk = jest.fn(async () => true);
const mockResolve = jest.fn(async (uri: string) => uri);
const mockWarn = jest.fn();
jest.mock('expo-image', () => ({ Image: {
  prefetch: mockPrefetch, loadAsync: mockLoad,
  clearMemoryCache: mockClearMemory, clearDiskCache: mockClearDisk,
} }));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('./dataUriToFileUri', () => ({ resolveDataUriForAndroid: mockResolve }));
jest.mock('./logger', () => ({ logger: { warn: mockWarn } }));

let images: typeof import('./imageOptimization');
const immutableFile = (n: number) => `file:///cache/glide_data_uri_avatar_${n.toString(16).padStart(64, '0')}.jpg`;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

beforeEach(() => {
  jest.useFakeTimers();
  jest.resetModules();
  mockPrefetch.mockReset().mockResolvedValue(true);
  mockLoad.mockReset().mockImplementation(async () => ({ width: 96, height: 96, scale: 1 }));
  mockResolve.mockReset().mockImplementation(async uri => uri);
  mockWarn.mockReset();
  images = require('./imageOptimization');
});
afterEach(() => { images.clearImageWarmupMemory(); jest.useRealTimers(); });

it('sends only remote HTTP sources to native URL prefetch and decodes local sources normally', async () => {
  const data = 'data:image/jpeg;base64,YQ==';
  mockResolve.mockImplementation(async uri => uri === data ? immutableFile(1) : uri);
  await images.prefetchImages([
    ' https://api.test/avatar?v=7 ', 'https://api.test/avatar?v=7',
    'http://api.test/image.jpg', 'file:///picked.jpg', 'content://photos/12', data, '',
  ]);
  expect(mockPrefetch.mock.calls).toEqual([
    ['https://api.test/avatar?v=7', 'memory-disk'],
    ['http://api.test/image.jpg', 'memory-disk'],
  ]);
  expect(mockLoad.mock.calls.every(([, options]) => options?.maxWidth === 1024 && options?.maxHeight === 1024)).toBe(true);
  expect(mockLoad.mock.calls.map(([source]) => source.uri)).toEqual([
    'file:///picked.jpg', 'content://photos/12', immutableFile(1),
  ]);
});

it('shares overlapping warmups including the data and file aliases of the same image', async () => {
  const file = immutableFile(2);
  mockResolve.mockImplementation(async uri => uri.startsWith('data:') ? file : uri);
  let finish!: (image: { width: number; height: number; scale: number }) => void;
  mockLoad.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = images.prefetchImages(['data:image/jpeg;base64,Yg==', file, file]);
  const second = images.prefetchImages([file]);
  await flush();
  expect(mockLoad).toHaveBeenCalledTimes(1);
  const decoded = { width: 96, height: 96, scale: 1 };
  finish(decoded);
  await Promise.all([first, second]);
  expect(images.getAvatarImageProps(file, 'avatar_user_v2').source).toBe(decoded);
  await images.prefetchImages([file]);
  expect(mockLoad).toHaveBeenCalledTimes(1);
});

it('keeps content and recycling identity separate for avatar replacements', async () => {
  const oldFile = immutableFile(3), nextFile = immutableFile(4);
  await images.prefetchImages([oldFile]);
  const oldSource = images.getAvatarImageProps(oldFile, 'avatar_a_v1').source;
  expect(images.getAvatarImageProps(nextFile, 'avatar_a_v2').source).toEqual({ uri: nextFile });
  expect(images.getAvatarImageProps('', 'avatar_b_v1').source).toEqual({ uri: '' });
  await images.prefetchImages([nextFile]);
  const nextProps = images.getAvatarImageProps(nextFile, 'avatar_a_v2');
  expect(nextProps.source).not.toBe(oldSource);
  expect(nextProps.recyclingKey).toBe('avatar_a_v2');
});

it('does not retain mutable picker files and retries decoding after a failed request', async () => {
  mockLoad.mockRejectedValueOnce(new Error('temporary read failure'));
  await images.prefetchImages(['file:///picked.jpg']);
  expect(mockWarn).toHaveBeenCalledTimes(1);
  await images.prefetchImages(['file:///picked.jpg']);
  await images.prefetchImages(['file:///picked.jpg']);
  expect(mockLoad).toHaveBeenCalledTimes(3);
  expect(images.getAvatarImageProps('file:///picked.jpg', 'profile').source).toEqual({ uri: 'file:///picked.jpg' });
});

it('limits simultaneous native decodes and bounds retained avatar memory', async () => {
  const pending: Array<(image: { width: number; height: number; scale: number }) => void> = [];
  mockLoad.mockImplementation(() => new Promise(resolve => { pending.push(resolve); }));
  const files = [5, 6, 7, 8, 9].map(immutableFile);
  const warming = images.prefetchImages(files);
  await flush();
  expect(mockLoad).toHaveBeenCalledTimes(2);
  const decoded = () => ({ width: 1024, height: 1024, scale: 1 });
  for (let i = 0; i < files.length; i++) {
    pending[i](decoded());
    await flush();
  }
  await warming;
  expect(images.getAvatarImageProps(files[0], 'oldest').source).toEqual({ uri: files[0] });
  expect(images.getAvatarImageProps(files[4], 'newest').source).not.toEqual({ uri: files[4] });
});

it('does not resurrect a decoded reference after an explicit cache clear', async () => {
  let finish!: (image: { width: number; height: number; scale: number }) => void;
  mockLoad.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const file = immutableFile(10);
  const warming = images.prefetchImages([file]);
  await flush();
  await images.forceImageRefresh();
  finish({ width: 96, height: 96, scale: 1 });
  await warming;
  expect(images.getAvatarImageProps(file, 'after-clear').source).toEqual({ uri: file });
});


it('warms the exact row thumbnail instead of a different full avatar and falls back for legacy friends', async () => {
  const data = 'data:image/jpeg;base64,cm93LXRodW1i';
  const rowFile = immutableFile(11);
  mockResolve.mockImplementation(async uri => uri === data ? rowFile : uri);
  const sources = images.selectFriendAvatarWarmSources([
    { avatarThumbB64: data, avatar: 'https://api.test/full-selfie.jpg' },
    { avatarThumbB64: 'https://api.test/exact-row-thumb.jpg', avatar: 'https://api.test/different-full.jpg' },
    { avatar: 'https://api.test/legacy-avatar.jpg' },
    { avatarThumbB64: data },
    { avatarThumbB64: '', avatar: '' },
    {},
  ]);
  expect(sources).toEqual([data, 'https://api.test/exact-row-thumb.jpg', 'https://api.test/legacy-avatar.jpg']);
  await images.prefetchImages(sources);
  expect(mockLoad).toHaveBeenCalledWith({ uri: rowFile }, { maxWidth: 1024, maxHeight: 1024 });
  expect(mockPrefetch.mock.calls.map(([uri]) => uri)).toEqual([
    'https://api.test/exact-row-thumb.jpg', 'https://api.test/legacy-avatar.jpg',
  ]);
  expect(images.getAvatarImageProps(rowFile, 'avatar_friend_v11').source).not.toEqual({ uri: rowFile });
});


it('uses the original URI for full-screen avatar previews even after a capped native warmup', async () => {
  const file = immutableFile(12);
  await images.prefetchImages([file]);
  expect(images.getAvatarImageProps(file, 'row').source).not.toEqual({ uri: file });
  expect(images.getAvatarImageProps(file, 'modal', { useDecodedSource: false }).source).toEqual({ uri: file });
});

it('warms chat photos on disk without retaining a decoded bitmap for local files', async () => {
  await images.prefetchImages(['https://api.test/photo.jpg', 'file:///cache/photo.jpg'], { diskOnly: true });
  expect(mockPrefetch).toHaveBeenCalledWith('https://api.test/photo.jpg', 'disk');
  expect(mockLoad).not.toHaveBeenCalled();
});

it('bounds a large warmup burst, expires waiters and ignores a late native result', async () => {
  const finishes: Array<(image: { width: number; height: number; scale: number }) => void> = [];
  mockLoad.mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  const warming = images.prefetchImages(Array.from({ length: 1000 }, (_, i) => immutableFile(1000 + i)));
  await flush();
  expect(mockLoad).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(32);
  jest.advanceTimersByTime(15001); await warming;
  expect(jest.getTimerCount()).toBe(0);
  await images.prefetchImages([immutableFile(1000)]);
  expect(mockLoad).toHaveBeenCalledTimes(2);
  finishes.forEach(finish => finish({ width: 96, height: 96, scale: 1 })); await flush();
  expect(images.getAvatarImageProps(immutableFile(1000), 'late').source).toEqual({ uri: immutableFile(1000) });
  mockLoad.mockResolvedValue({ width: 96, height: 96, scale: 1 });
  await images.prefetchImages([immutableFile(1000)]);
  expect(mockLoad).toHaveBeenCalledTimes(3);
});

it('bounds retained source strings by bytes, including sources held by timed-out native operations', async () => {
  mockLoad.mockImplementation(() => new Promise(() => {}));
  const data = 'data:image/jpeg;base64,' + 'A'.repeat(1024 * 1024);
  const warming = images.prefetchImages([data + 'a', data + 'b']);
  await flush();
  expect(mockResolve).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(15001); await warming;
  await images.prefetchImages([data + 'c']);
  expect(mockResolve).toHaveBeenCalledTimes(1);
});

it('clears waiting warmups on memory pressure and expires decoded references while idle', async () => {
  const file = immutableFile(2000);
  await images.prefetchImages([file]);
  jest.advanceTimersByTime(5 * 60 * 1000 + 1);
  expect(images.getAvatarImageProps(file, 'expired').source).toEqual({ uri: file });
  const finishes: Array<(image: { width: number; height: number; scale: number }) => void> = [];
  mockLoad.mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  const warming = images.prefetchImages([2001, 2002, 2003].map(immutableFile)); await flush();
  const { notifyMemoryPressure } = require('./memoryPressure');
  notifyMemoryPressure(); await warming;
  finishes.forEach(finish => finish({ width: 96, height: 96, scale: 1 })); await flush();
  expect(mockLoad).toHaveBeenCalledTimes(3); // One completed load plus two active loads; no waiting load.
  expect(images.getAvatarImageProps(immutableFile(2001), 'cleared').source).toEqual({ uri: immutableFile(2001) });
});

it('bounds Android call-file priming before it reaches file conversion', async () => {
  mockResolve.mockImplementation(() => new Promise(() => {}));
  for (let i = 0; i < 1000; i++) images.warmAndroidAvatarFile(`data:image/jpeg;base64,avatar-${i}`);
  await flush(); expect(mockResolve).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(32);
  jest.advanceTimersByTime(15001); await flush();
  expect(jest.getTimerCount()).toBe(0);
});
