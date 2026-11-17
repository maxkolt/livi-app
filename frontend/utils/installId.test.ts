const mockSecure = new Map<string, string>();
const mockAsync = new Map<string, string>();
Object.defineProperty(globalThis, '__DEV__', { configurable: true, value: false });
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('react-native-get-random-values', () => ({}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockSecure.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockSecure.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockSecure.delete(key); }),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: async (key: string) => mockAsync.get(key) ?? null,
  setItem: async (key: string, value: string) => { mockAsync.set(key, value); },
  removeItem: async (key: string) => { mockAsync.delete(key); },
}));
beforeEach(() => { mockSecure.clear(); mockAsync.clear(); jest.resetModules(); });

it('creates a new cryptographic identity after reinstall instead of reusing a hardware ID', async () => {
  let install = await import('./installId');
  const first = await install.getInstallId();
  const secret = await install.getInstallSecret();
  expect(first).toMatch(/^inst_[a-f0-9]{32}$/);
  expect(secret).toMatch(/^[a-f0-9]{64}$/);
  expect(await install.getInstallId()).toBe(first);
  mockSecure.clear(); mockAsync.clear(); jest.resetModules();
  install = await import('./installId');
  expect(await install.getInstallId()).not.toBe(first);
  expect(await install.getInstallSecret()).not.toBe(secret);
});

it('preserves an existing installation and refuses to hide a failed secure identity write', async () => {
  mockSecure.set('livi.installId', 'inst_android_existing');
  mockSecure.set('livi.installSecret', 'a'.repeat(64));
  const install = await import('./installId');
  expect(await install.getInstallId()).toBe('inst_android_existing');
  expect(await install.getInstallSecret()).toBe('a'.repeat(64));
  const secure = await import('expo-secure-store');
  jest.mocked(secure.setItemAsync).mockRejectedValueOnce(new Error('Keystore unavailable'));
  await expect(install.regenerateRandomInstallId()).rejects.toThrow('Keystore unavailable');
});
