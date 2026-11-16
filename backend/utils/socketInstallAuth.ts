import type { AuthedSocket } from '../sockets/types';
import { allowLegacyInstallAuth, verifyInstallSecret } from './installSecret';

export function socketInstallCredentials(sock: AuthedSocket) {
  const auth = sock.handshake.auth || {};
  return {
    installId: typeof auth.installId === 'string' ? auth.installId.trim() : String(sock.handshake.query?.installId || '').trim(),
    secret: typeof auth.installSecret === 'string' ? auth.installSecret : '',
  };
}

export function hasVerifiedSocketInstall(sock: AuthedSocket, install: {
  installId: string; user: unknown; installSecretHash?: string;
}, secret = socketInstallCredentials(sock).secret): boolean {
  if (!install.installSecretHash) return allowLegacyInstallAuth();
  if (verifyInstallSecret(secret, install.installSecretHash)) return true;
  // Older apps attach with the secret in identity:attach, after connecting.
  return sock.data.verifiedInstallId === install.installId &&
    sock.data.verifiedInstallSecretHash === install.installSecretHash &&
    sock.data.userId === String(install.user);
}
