import type { AuthedSocket } from '../sockets/types';
import { LEGACY_INSTALL_SEAL } from './installSecret';

/** Old releases prove ownership in identity:attach after opening the transport. */
export function installSocketAuthorization(sock: AuthedSocket, waitMs = 4000): void {
  let waiting: Promise<boolean> | null = null;
  let pendingCalls = 0;
  const verified = () => !!(sock.data.verifiedInstallId && sock.data.verifiedInstallSecretHash && sock.data.userId);

  const waitForIdentity = (): Promise<boolean> => {
    if (waiting) return waiting;
    const work = new Promise<boolean>(resolve => {
      const deadline = Date.now() + waitMs;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        sock.off('disconnect', disconnected);
        resolve(ok);
      };
      const disconnected = () => finish(false);
      const check = () => {
        if (!sock.connected) return finish(false);
        if (verified()) return finish(true);
        if (Date.now() >= deadline) return finish(false);
        timer = setTimeout(check, Math.min(25, deadline - Date.now()));
      };
      sock.once('disconnect', disconnected);
      check();
    });
    waiting = work;
    void work.then(() => { if (waiting === work) waiting = null; });
    return work;
  };

  sock.use((packet, next) => {
    if (packet.length === 1 || packet[1] == null) packet[1] = {};
    const ack = packet[packet.length - 1];
    const reject = (error: string) => { if (typeof ack === 'function') ack({ ok: false, error }); };
    if (sock.data.verifiedInstallSecretHash === LEGACY_INSTALL_SEAL &&
        ['identity:wipeMe', 'e2e:publish', 'e2e:disable', 'e2e:enable'].includes(packet[0])) {
      reject('account_proof_required');
      return;
    }
    if (['identity:attach', 'reauth', 'whoami', 'user:exists'].includes(packet[0]) || verified()) return next();

    // Wait only for ownership proof on this socket. Identifiers never authorize a call.
    // One bounded wait and at most four pending requests prevent a guest queue flood.
    if (['call:initiate', 'call:accept'].includes(packet[0]) && typeof ack === 'function' &&
        sock.connected && pendingCalls < 4) {
      pendingCalls++;
      void waitForIdentity().then(ok => {
        pendingCalls--;
        if (ok && sock.connected && verified()) next();
        else reject('unauthorized');
      });
      return;
    }
    reject('unauthorized');
  });
}
