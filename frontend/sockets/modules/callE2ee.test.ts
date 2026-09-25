const secure = new Map<string, string>();

jest.mock('react-native-get-random-values', () => ({}), { virtual: true });
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => secure.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    secure.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    secure.delete(key);
  }),
}));

import {
  bindOutgoingCallE2ee,
  clearCallE2ee,
  createOutgoingCallE2eeDeclaration,
  deriveCallKey,
  getOrCreateIncomingCallE2eeDeclaration,
} from './callE2ee';
import { deriveCallFrameKey, fromBase64, generateKeyPair, toBase64 } from './e2eCrypto';

describe('automatic per-call E2EE', () => {
  beforeEach(() => secure.clear());

  it('derives the same frame key without any chat E2EE state', async () => {
    const callId = 'call-outgoing-1';
    const declaration = createOutgoingCallE2eeDeclaration('507f191e810c19729de860ea');
    expect(await bindOutgoingCallE2ee(callId, '507f191e810c19729de860ea', declaration)).toBe(true);

    const remote = generateKeyPair();
    const ownPublicKey = fromBase64(declaration.pk)!;
    const expected = deriveCallFrameKey(remote, ownPublicKey, callId);
    const actual = await deriveCallKey(toBase64(remote.publicKey), callId);

    expect(actual && toBase64(actual)).toBe(expected && toBase64(expected));
    await clearCallE2ee(callId);
  });

  it('reuses one incoming key for accept retries and stores it for reconnect', async () => {
    const first = await getOrCreateIncomingCallE2eeDeclaration('call-incoming-1');
    const second = await getOrCreateIncomingCallE2eeDeclaration('call-incoming-1');

    expect(second).toEqual(first);
    expect([...secure.values()]).toHaveLength(1);
    await clearCallE2ee('call-incoming-1');
    expect(secure.size).toBe(0);
  });
});
