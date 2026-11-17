import { acceptsAccountDataGeneration, assertAccountDataGenerationConfiguration, assertAccountDataGenerationReceipt } from './accountDataGeneration';

const original = { generation: process.env.ACCOUNT_DATA_GENERATION, mode: process.env.INSTALL_AUTH_MODE, http: process.env.HTTP_INSTALL_SECRET_REQUIRED };
afterEach(() => {
  for (const [key, value] of Object.entries({ ACCOUNT_DATA_GENERATION: original.generation, INSTALL_AUTH_MODE: original.mode, HTTP_INSTALL_SECRET_REQUIRED: original.http })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

it('preserves the existing deployment until a reset marker is configured', () => {
  delete process.env.ACCOUNT_DATA_GENERATION;
  expect(acceptsAccountDataGeneration(undefined)).toBe(true);
  expect(() => assertAccountDataGenerationConfiguration()).not.toThrow();
});

it('rejects old registration clients after reset and accepts the adopted generation', () => {
  process.env.ACCOUNT_DATA_GENERATION = 'fresh-1';
  expect(acceptsAccountDataGeneration(undefined)).toBe(false);
  expect(acceptsAccountDataGeneration('old')).toBe(false);
  expect(acceptsAccountDataGeneration('fresh-1')).toBe(true);
});

it('refuses to start a fresh generation with legacy or optional authentication', () => {
  process.env.ACCOUNT_DATA_GENERATION = 'fresh-1';
  process.env.HTTP_INSTALL_SECRET_REQUIRED = '1';
  process.env.INSTALL_AUTH_MODE = 'legacy-migration';
  expect(() => assertAccountDataGenerationConfiguration()).toThrow('strict');
  delete process.env.INSTALL_AUTH_MODE;
  process.env.HTTP_INSTALL_SECRET_REQUIRED = '0';
  expect(() => assertAccountDataGenerationConfiguration()).toThrow('strict');
  process.env.HTTP_INSTALL_SECRET_REQUIRED = '1';
  expect(() => assertAccountDataGenerationConfiguration()).not.toThrow();
  process.env.ACCOUNT_DATA_GENERATION = '../invalid';
  expect(() => assertAccountDataGenerationConfiguration()).toThrow('Invalid');
});

it('does not add a database dependency to a normal deployment', async () => {
  delete process.env.ACCOUNT_DATA_GENERATION;
  const read = jest.fn();
  await expect(assertAccountDataGenerationReceipt(read)).resolves.toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

it.each([undefined, null, 'old-generation'])('rejects a reset marker without the matching database receipt (%s)', async value => {
  process.env.ACCOUNT_DATA_GENERATION = 'fresh-1';
  await expect(assertAccountDataGenerationReceipt(async () => value)).rejects.toThrow('receipt');
});

it('accepts only the generation actually committed by the reset transaction', async () => {
  process.env.ACCOUNT_DATA_GENERATION = 'fresh-1';
  await expect(assertAccountDataGenerationReceipt(async () => 'fresh-1')).resolves.toBeUndefined();
});
