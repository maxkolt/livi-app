import { getCurrentUserId } from '../sockets/modules/authState';
import { getInstallId, getInstallSecret } from './installId';

let inFlight: { userId: string; promise: Promise<boolean> } | null = null;

/** Re-validate the existing installation after HTTP 401. Never reset local identity
 * or call createUser; only retry HTTP after the server confirms the same account. */
export function restoreHttpInstallAuth(): Promise<boolean> {
  const userId = String(getCurrentUserId() || '');
  if (!userId) return Promise.resolve(false);
  if (inFlight?.userId === userId) return inFlight.promise;
  const pending = (async () => {
    try {
      const [installId, installSecret] = await Promise.all([getInstallId(), getInstallSecret()]);
      if (!installId || !installSecret || getCurrentUserId() !== userId) return false;
      // Reauth verifies that this installation still maps to the existing user.
      // A missing/deleted account must not enter identity:attach's creation path.
      const { emitAck } = await import('../sockets/modules/emit');
      const mapped = await emitAck<{ ok: boolean; userId?: string }>('reauth', { userId }, 6000, 0);
      if (!mapped?.ok || mapped.userId !== userId || getCurrentUserId() !== userId) return false;
      const { attachIdentity } = await import('../sockets/modules/identity');
      if (getCurrentUserId() !== userId) return false;
      const restored = await attachIdentity({ installId, installSecret });
      return restored?.ok === true && restored.userId === userId && getCurrentUserId() === userId;
    } catch {
      return false;
    }
  })().finally(() => {
    if (inFlight?.promise === pending) inFlight = null;
  });
  inFlight = { userId, promise: pending };
  return pending;
}
