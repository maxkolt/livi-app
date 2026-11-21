import { getCurrentUserId } from '../sockets/modules/authState';
import { API_BASE } from '../sockets/modules/constants';
import { getInstallId, getInstallSecret } from './installId';
import { fetchWithTimeout } from './fetchWithTimeout';
import type { InstallMigrationChallenge } from './installMigrationProof';
let inFlight: { userId: string; promise: Promise<boolean> } | null = null;
/** Best-effort staged enrollment. Never reset identity, generate a chat key, or block startup. */
export function migrateLegacyInstall(userId: string, options?: { enrollOnly?: boolean }): Promise<boolean> {
  if (inFlight?.userId === userId) return inFlight.promise;
  const promise = (async () => {
    try {
      if (!userId || getCurrentUserId() !== userId) return false;
      const [installId, installSecret] = await Promise.all([getInstallId(), getInstallSecret()]);
      if (!installId || !installSecret || getCurrentUserId() !== userId) return false;
      const post = (path: string, body: object) => fetchWithTimeout(`${API_BASE}/api/identity/migration/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-install-id': installId, 'x-install-secret': installSecret }, body: JSON.stringify(body),
      }, 8000);
      const response = await post('challenge', { userId });
      if (!response.ok) return false;
      const challenge = await response.json() as InstallMigrationChallenge & { ok: boolean; alreadyVerified?: boolean };
      if (!challenge.ok || getCurrentUserId() !== userId) return false;
      if (!challenge.alreadyVerified) {
        const { answerInstallMigrationChallenge } = await import('../sockets/modules/e2e');
        const proof = await answerInstallMigrationChallenge(userId, challenge);
        if (!proof || getCurrentUserId() !== userId) return false;
        const completion = await post('complete', { id: challenge.id, proof });
        if (!completion.ok || !(await completion.json()).ok || getCurrentUserId() !== userId) return false;
      }
      if (options?.enrollOnly) return true;
      const { emitAck } = await import('../sockets/modules/emit');
      const result = await emitAck<{ ok: boolean; userId?: string }>('reauth', { userId, installSecret }, 6000, 0);
      return result?.ok === true && result.userId === userId && getCurrentUserId() === userId;
    } catch { return false; }
  })().finally(() => { if (inFlight?.promise === promise) inFlight = null; });
  inFlight = { userId, promise }; return promise;
}
