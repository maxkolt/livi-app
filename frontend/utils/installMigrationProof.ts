import nacl from 'tweetnacl';
import { fromBase64, toBase64 } from '../sockets/modules/e2eCrypto';
export type InstallMigrationChallenge = { id: string; publicKey: string; recipientKey: string; nonce: string; ciphertext: string };
/** Prove possession of the existing chat key without transmitting that key. */
export function openInstallMigrationProof(challenge: InstallMigrationChallenge, secretKey: Uint8Array): string | null {
  if (secretKey.length !== 32 || toBase64(nacl.box.keyPair.fromSecretKey(secretKey).publicKey) !== challenge.recipientKey) return null;
  const pk = fromBase64(challenge.publicKey), nonce = fromBase64(challenge.nonce), ciphertext = fromBase64(challenge.ciphertext);
  if (pk?.length !== 32 || nonce?.length !== 24 || ciphertext?.length !== 48) return null;
  const proof = nacl.box.open(ciphertext, nonce, pk, secretKey);
  if (proof?.length !== 32) return null;
  const answer = toBase64(proof); proof.fill(0); return answer;
}
