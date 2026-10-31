import { Server, Socket } from 'socket.io';
import mongoose from 'mongoose';
import User from '../models/User';
import { checkRateLimit } from '../utils/rateLimit';
import { hashInstallSecret, verifyInstallSecret } from '../utils/installSecret';
import { isE2ePublicKey, strictBase64Length } from '../utils/e2eEnvelope';
import { getFriendIds } from '../utils/friendshipUtils';

/**
 * Ключи сквозного шифрования чата.
 *
 * Клиент включает шифрование сам, без пароля: ключ создаётся на устройстве и
 * переживает переустановку через системное хранилище (Android Block Store, iOS
 * Keychain). Поэтому ключ публикуется и без резервной копии.
 *
 * Копия под паролем осталась у тех, кто включал шифрование раньше (по паролю):
 * из пароля (scrypt/PBKDF2) клиент выводит ключ шифрования копии и authKey.
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

type BackupKdf =
  | { alg: 'scrypt'; N: number; r: number; p: number; salt: string }
  | { alg: 'pbkdf2-sha256'; iterations: number; salt: string };

/** Нижняя граница PBKDF2 (OWASP 2023: 600 000; 310 000 — прежняя рекомендация). */
const PBKDF2_MIN_ITERATIONS = 310_000;
type BackupUpload = { v: number; kdf: BackupKdf; n: string; c: string; pk: string; authKey: string };

// Number.isInteger checks both the primitive type and integer value; lib.d.ts exposes only boolean.
type IntegerGuard = (value: unknown) => value is number;

function isPowerOfTwo(n: unknown): n is number {
  return (Number.isInteger as IntegerGuard)(n) && n > 0 && (n & (n - 1)) === 0;
}

export function parseBackupKdf(raw: unknown): BackupKdf | null {
  const k = raw as Partial<Record<'alg' | 'salt' | 'iterations' | 'N' | 'r' | 'p', unknown>> | null;
  const saltLen = strictBase64Length(k?.salt);
  if (saltLen == null || saltLen < 16 || saltLen > 64) return null;
  if (k?.alg === 'pbkdf2-sha256') {
    // Нативный PBKDF2 на устройстве (LiviCrypto). Нижняя граница — чтобы копию не ослабили.
    if (!(Number.isInteger as IntegerGuard)(k.iterations) || k.iterations < PBKDF2_MIN_ITERATIONS || k.iterations > 10_000_000) return null;
    return { alg: 'pbkdf2-sha256', iterations: k.iterations, salt: k.salt as string };
  }
  if (!k || k.alg !== 'scrypt') return null;
  // Нижняя граница — не дать клиенту (или атакующему с сессией) ослабить копию.
  if (!isPowerOfTwo(k.N) || k.N < 2 ** 15 || k.N > 2 ** 20) return null;
  if (!(Number.isInteger as IntegerGuard)(k.r) || k.r < 8 || k.r > 16) return null;
  if (!(Number.isInteger as IntegerGuard)(k.p) || k.p < 1 || k.p > 4) return null;
  return { alg: 'scrypt', N: k.N, r: k.r, p: k.p, salt: k.salt as string };
}

export function parseBackupUpload(raw: unknown, publicKey: string): BackupUpload | null {
  const b = raw as Partial<Record<keyof BackupUpload, unknown>> | null;
  if (!b || b.v !== E2E_BACKUP_VERSION) return null;
  const kdf = parseBackupKdf(b.kdf);
  if (!kdf) return null;
  if (strictBase64Length(b.n) !== 24) return null;
  if (strictBase64Length(b.c) !== SECRET_KEY_BYTES + SECRETBOX_OVERHEAD) return null;
  if (b.pk !== publicKey) return null;
  if (strictBase64Length(b.authKey) !== AUTH_KEY_BYTES) return null;
  return { v: E2E_BACKUP_VERSION, kdf, n: b.n as string, c: b.c as string, pk: b.pk, authKey: b.authKey as string };
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
  for (const d of docs) out[String(d._id)] = d.e2ePublicKey || undefined;
  return out;
}

/**
 * Друзья узнают о смене ключа. Дружба живёт в FriendshipEdge (getFriendIds);
 * User.friends — устаревшее поле, по нему ключи никому не доходили.
 */
async function notifyFriendsKeyChanged(io: Server, me: string, publicKey: string): Promise<void> {
  const friendIds = await getFriendIds(me).catch(() => [] as string[]);
  for (const friendId of friendIds) {
    io.to(`u:${String(friendId)}`).emit('e2e:key_changed', { userId: me, publicKey });
  }
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
      const u = await User.findById(me).select('e2ePublicKey e2eDisabled +e2eBackup').lean();
      const backup = u?.e2eBackup;
      return ack?.({
        ok: true,
        publicKey: u?.e2ePublicKey || '',
        backup: backup ? { kdf: backup.kdf, pk: backup.pk } : null,
        disabled: u?.e2eDisabled === true,
      });
    } catch (e) {
      console.error('[e2e:state] error:', (e as { message?: unknown } | null)?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /**
   * Публикация ключа. Копия под паролем необязательна (автоматическое шифрование
   * её не делает); если прислана — должна быть копией именно этого ключа.
   */
  sock.on('e2e:publish', async (payload: { publicKey?: string; backup?: unknown }, ack?: Function) => {
    try {
      const me = authed();
      if (!me) return ack?.({ ok: false, error: 'unauthorized' });
      const publicKey = payload?.publicKey;
      if (!isE2ePublicKey(publicKey)) return ack?.({ ok: false, error: 'invalid_key' });
      const hasBackup = payload?.backup != null;
      const backup = hasBackup ? parseBackupUpload(payload.backup, publicKey) : null;
      if (hasBackup && !backup) return ack?.({ ok: false, error: 'invalid_backup' });

      const prev = await User.findById(me).select('e2ePublicKey').lean();
      if (!prev) return ack?.({ ok: false, error: 'not_found' });
      const now = new Date();
      await User.updateOne(
        { _id: me },
        {
          $set: {
            e2ePublicKey: publicKey,
            e2eKeyUpdatedAt: now,
            e2eDisabled: false,
            // Без копии старую не трогаем: она от прежнего ключа, клиент сверяет её pk.
            ...(backup
              ? {
                  e2eBackup: {
                    v: backup.v,
                    kdf: backup.kdf,
                    n: backup.n,
                    c: backup.c,
                    pk: backup.pk,
                    authHash: hashBackupAuthKey(backup.authKey),
                    updatedAt: now,
                  },
                }
              : {}),
          },
        }
      );

      if (prev.e2ePublicKey !== publicKey) {
        await notifyFriendsKeyChanged(io, me, publicKey);
        console.log(`[e2e] public key ${prev.e2ePublicKey ? 'rotated' : 'published'} user=${me}`);
      }
      return ack?.({ ok: true });
    } catch (e) {
      console.error('[e2e:publish] error:', (e as { message?: unknown } | null)?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /**
   * Отключить шифрование: ключ снимается с публикации, копия и ключ на устройстве
   * остаются — старая зашифрованная переписка по-прежнему читается, а новые
   * сообщения и звонки идут обычными. Друзья перечитают ключ по e2e:key_changed.
   */
  sock.on('e2e:disable', async (_payload: unknown, ack?: Function) => {
    try {
      const me = authed();
      if (!me) return ack?.({ ok: false, error: 'unauthorized' });
      const prev = await User.findById(me).select('e2ePublicKey').lean();
      if (!prev) return ack?.({ ok: false, error: 'not_found' });
      await User.updateOne(
        { _id: me },
        { $set: { e2ePublicKey: '', e2eKeyUpdatedAt: new Date(), e2eDisabled: true } },
      );
      if (prev.e2ePublicKey) {
        await notifyFriendsKeyChanged(io, me, '');
        console.log(`[e2e] disabled user=${me}`);
      }
      return ack?.({ ok: true });
    } catch (e) {
      console.error('[e2e:disable] error:', (e as { message?: unknown } | null)?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });

  /** Включить снова без пароля: только тот ключ, для которого на сервере уже лежит копия. */
  sock.on('e2e:enable', async (payload: { publicKey?: string }, ack?: Function) => {
    try {
      const me = authed();
      if (!me) return ack?.({ ok: false, error: 'unauthorized' });
      const publicKey = payload?.publicKey;
      if (!isE2ePublicKey(publicKey)) return ack?.({ ok: false, error: 'invalid_key' });
      const u = await User.findById(me).select('e2ePublicKey +e2eBackup').lean();
      if (!u) return ack?.({ ok: false, error: 'not_found' });
      if (u.e2eBackup?.pk !== publicKey) return ack?.({ ok: false, error: 'no_backup' });
      await User.updateOne(
        { _id: me },
        { $set: { e2ePublicKey: publicKey, e2eKeyUpdatedAt: new Date(), e2eDisabled: false } },
      );
      if (u.e2ePublicKey !== publicKey) {
        await notifyFriendsKeyChanged(io, me, publicKey);
        console.log(`[e2e] re-enabled user=${me}`);
      }
      return ack?.({ ok: true });
    } catch (e) {
      console.error('[e2e:enable] error:', (e as { message?: unknown } | null)?.message || e);
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
      const backup = u?.e2eBackup;
      if (!backup) return ack?.({ ok: false, error: 'no_backup' });
      if (!verifyBackupAuthKey(payload?.authKey, backup.authHash)) {
        return ack?.({ ok: false, error: 'wrong_password' });
      }
      return ack?.({ ok: true, backup: { v: backup.v, kdf: backup.kdf, n: backup.n, c: backup.c, pk: backup.pk } });
    } catch (e) {
      console.error('[e2e:backup_fetch] error:', (e as { message?: unknown } | null)?.message || e);
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
      const allowed = new Set([me, ...(await getFriendIds(me)).map(String)]);
      const ids = requested.filter((id) => allowed.has(id));
      const found = await loadE2ePublicKeys(ids);
      const keys: Record<string, string> = {};
      for (const id of ids) keys[id] = found[id] || '';
      return ack?.({ ok: true, keys });
    } catch (e) {
      console.error('[e2e:keys] error:', (e as { message?: unknown } | null)?.message || e);
      return ack?.({ ok: false, error: 'server_error' });
    }
  });
}
