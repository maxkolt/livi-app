import nacl from 'tweetnacl';
import { randomBytes } from 'crypto';
import { openInstallMigrationProof } from './installMigrationProof';
import { toBase64 } from '../sockets/modules/e2eCrypto';
const pair = () => nacl.box.keyPair.fromSecretKey(new Uint8Array(randomBytes(32)));
it('answers the server box only with the original private chat key', () => {
  const owner = pair(), server = pair(), proof = new Uint8Array(randomBytes(32)), nonce = new Uint8Array(randomBytes(24));
  const challenge = { id: 'fixture', publicKey: toBase64(server.publicKey), recipientKey: toBase64(owner.publicKey), nonce: toBase64(nonce), ciphertext: toBase64(nacl.box(proof, nonce, owner.publicKey, server.secretKey)) };
  expect(openInstallMigrationProof(challenge, owner.secretKey)).toBe(toBase64(proof));
  expect(openInstallMigrationProof(challenge, pair().secretKey)).toBeNull();
  expect(openInstallMigrationProof({ ...challenge, nonce: 'invalid' }, owner.secretKey)).toBeNull();
  expect(openInstallMigrationProof({ ...challenge, ciphertext: toBase64(new Uint8Array(48)) }, owner.secretKey)).toBeNull();
});
