import { Server, Socket } from 'socket.io';
import mongoose from 'mongoose';
import User from '../models/User';
import { checkRateLimit } from '../utils/rateLimit';
import { hashInstallSecret, verifyInstallSecret } from '../utils/installSecret';
import { isE2ePublicKey, strictBase64Length } from '../utils/e2eEnvelope';

/**
 * Ключи сквозного шифрования чата.
 *
 * Правило: публичный ключ публикуется только вместе с резервной копией приватного
 * под паролем. Переустановка на Android сохраняет аккаунт, но не SecureStore —
 * без копии вся зашифрованная переписка стала бы нечитаемой.
 *
 * Копия: из пароля (scrypt) клиент выводит ключ шифрования копии и authKey.
 * Сервер хранит HMAC(authKey) и отдаёт копию только тому, кто прислал верный
 * authKey, с лимитом попыток — перебор пароля через сервер невозможен.
 */

export const E2E_BACKUP_VERSION = 1;
const SECRETBOX_OVERHEAD = 16;
const SECRET_KEY_BYTES = 32;
const AUTH_KEY_BYTES = 32;
const MAX_KEY_LOOKUP = 100;
/** Попытки восстановления: подбор пароля онлайн упирается в эти окна. */
export const BACKUP_FETCH_LIMITS = [
  { key: 'e2e_backup_fetch_h', max: 5, windowMs: 60 * 60_000 },
  { key: 'e2e_backup_fetch_d', max: 20, windowMs: 24 * 60 * 60_000 },
];

export type BackupKdf = { alg: 'scrypt'; N: number; r: number; p: number; salt: string };
export type BackupUpload = { v: number; kdf: BackupKdf; n: string; c: string; pk: string; authKey: string };

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

export function parseBackupKdf(raw: unknown): BackupKdf | null {
  const k = raw as any;
  if (!k || k.alg !== 'scrypt') return null;
  // Нижняя граница — не дать клиенту (или атакующему с сессией) ослабить копию.
  if (!isPowerOfTwo(k.N) || k.N < 2 ** 15 || k.N > 2 ** 20) return null;
  if (!Number.isInteger(k.r) || k.r < 8 || k.r > 16) return null;
  if (!Number.isInteger(k.p) || k.p < 1 || k.p > 4) return null;
  const saltLen = strictBase64Length(k.salt);
  if (saltLen == null || saltLen < 16 || saltLen > 64) return null;
  return { alg: 'scrypt', N: k.N, r: k.r, p: k.p, salt: k.salt };
}

export function parseBackupUpload(raw: unknown, publicKey: string): BackupUpload | null {
  const b = raw as any;
  if (!b || b.v !== E2E_BACKUP_VERSION) return null;
  const kdf = parseBackupKdf(b.kdf);
  if (!kdf) return null;
  if (strictBase64Length(b.n) !== 24) return null;
  if (strictBase64Length(b.c) !== SECRET_KEY_BYTES + SECRETBOX_OVERHEAD) return null;
  if (b.pk !== publicKey) return null;
  if (strictBase64Length(b.authKey) !== AUTH_KEY_BYTES) return null;
  return { v: E2E_BACKUP_VERSION, kdf, n: b.n, c: b.c, pk: b.pk, authKey: b.authKey };
}

/** Отдельный домен HMAC, чтобы хэш authKey нельзя было перепутать с installSecret. */
export function hashBackupAuthKey(authKey: string): string {
  return hashInstallSecret(`e2e-backup-auth:${authKey}`);
}

export function verifyBackupAuthKey(authKey: unknown, storedHash: string | undefined): boolean {
  if (typeof authKey !== 'string' || strictBase64Length(authKey) !== AUTH_KEY_BYTES) return false;
  return verifyInstallSecret(`e2e-backup-auth:${authKey}`, storedHash);
}

export async function loadE2ePublicKeys(userIds: string[]): Promise<Record<string, string | undefined>> {
  const ids = [...new Set(userIds)].filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (ids.length === 0) return {};
  const docs = await User.find({ _id: { $in: ids } }).select('e2ePublicKey').lean();
  const out: Record<string, string | undefined> = {};
  for (const d of docs as any[]) out[String(d._id)] = d.e2ePublicKey || undefined;
  return out;
}

export function registerE2eKeyHandlers(io: Server, sock: Socket, meId: () => string) {
  const authed = () => {
    const me = meId();
    return mongoose.Types.ObjectId.isValid(me) ? me : null;
  };

  /** Своё состояние: опубликован ли ключ и есть ли копия (для восстановления после переустановки). */
  sock.on('e2e:state', async (_payload: unknown, ack?: Function) => {
    try {
      const me = authed();
      if (!me) return ack?.({ ok: false, error: 'unauthorized' });
      const u = await User.findById(me).select('e2ePublicKey +e2eBackup').lean();
      const backup = (u as any)?.e2eBackup;
      return ack?.({
        ok: true,
        publicKey: (u as any)?.e2ePublicKey || '',
        backup: backup ? { kdf: backup.kdf, pk: backup.pk } : null,
      });
    } catch (e: any) {
      console.error('[e2e:state] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** Публикация ключа (или смена пароля копии для того же ключа). Только вместе с копией. */
  sock.on('e2e:publish', async (payload: { publicKey?: string; backup?: unknown }, ack?: Function) => {
    try {
      const me = authed();
      if (!me) return ack?.({ ok: false, error: 'unauthorized' });
      const publicKey = payload?.publicKey;
      if (!isE2ePublicKey(publicKey)) return ack?.({ ok: false, error: 'invalid_key' });
      const backup = parseBackupUpload(payload?.backup, publicKey);
      if (!backup) return ack?.({ ok: false, error: 'invalid_backup' });

      const prev = await User.findById(me).select('e2ePublicKey friends').lean();
      if (!prev) return ack?.({ ok: false, error: 'not_found' });
      const now = new Date();
      await User.updateOne(
        { _id: me },
        {
          $set: {
            e2ePublicKey: publicKey,
            e2eKeyUpdatedAt: now,
            e2eBackup: {
              v: backup.v,
              kdf: backup.kdf,
              n: backup.n,
              c: backup.c,
              pk: backup.pk,
              authHash: hashBackupAuthKey(backup.authKey),
              updatedAt: now,
            },
          },
        }
      );

      if ((prev as any).e2ePublicKey !== publicKey) {
        const changed = { userId: me, publicKey };
        for (const friendId of ((prev as any).friends || []) as any[]) {
          io.to(`u:${String(friendId)}`).emit('e2e:key_changed', changed);
        }
        console.log(`[e2e] public key ${(prev as any).e2ePublicKey ? 'rotated' : 'published'} user=${me}`);
      }
      return ack?.({ ok: true });
    } catch (e: any) {
      console.error('[e2e:publish] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** Выдача копии знающему пароль. Лимит считается до проверки — неверные попытки тоже тратят его. */
  sock.on('e2e:backup_fetch', async (payload: { authKey?: string }, ack?: Function) => {
    try {
      const me = authed();
      if (!me) return ack?.({ ok: false, error: 'unauthorized' });
      for (const lim of BACKUP_FETCH_LIMITS) {
        const r = await checkRateLimit(`${lim.key}:${me}`, lim.max, lim.windowMs, { sensitive: true });
        if (!r.ok) return ack?.({ ok: false, error: 'rate_limited', retryAfterSec: r.retryAfterSec });
      }
      const u = await User.findById(me).select('+e2eBackup').lean();
      const backup = (u as any)?.e2eBackup;
      if (!backup) return ack?.({ ok: false, error: 'no_backup' });
      if (!verifyBackupAuthKey(payload?.authKey, backup.authHash)) {
        return ack?.({ ok: false, error: 'wrong_password' });
      }
      return ack?.({ ok: true, backup: { v: backup.v, kdf: backup.kdf, n: backup.n, c: backup.c, pk: backup.pk } });
    } catch (e: any) {
      console.error('[e2e:backup_fetch] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** Публичные ключи друзей (и свой). Чужим не-друзьям ключ не раскрываем. */
  sock.on('e2e:keys', async (payload: { userIds?: string[] }, ack?: Function) => {
    try {
      const me = authed();
      if (!me) return ack?.({ ok: false, error: 'unauthorized' });
      const requested = Array.isArray(payload?.userIds)
        ? [...new Set(payload.userIds.map((id) => String(id || '').trim()))]
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
            .slice(0, MAX_KEY_LOOKUP)
        : [];
      if (requested.length === 0) return ack?.({ ok: true, keys: {} });
      const meDoc = await User.findById(me).select('friends').lean();
      const allowed = new Set([me, ...(((meDoc as any)?.friends || []) as any[]).map(String)]);
      const ids = requested.filter((id) => allowed.has(id));
      const found = await loadE2ePublicKeys(ids);
      const keys: Record<string, string> = {};
      for (const id of ids) keys[id] = found[id] || '';
      return ack?.({ ok: true, keys });
    } catch (e: any) {
      console.error('[e2e:keys] error:', e?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });
}
