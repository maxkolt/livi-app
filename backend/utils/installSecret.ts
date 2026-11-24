// utils/installSecret.ts
// Секрет установки (installSecret): случайное значение высокой энтропии, которое клиент
// генерирует один раз при первой привязке installId -> user и хранит в SecureStore.
// Сервер хранит только HMAC-хэш. Без этого секрета простое знание/подбор installId
// достаточно для получения чужой сессии (см. security review) — этот модуль закрывает дыру.
import crypto from 'crypto';

const PEPPER = String(process.env.INSTALL_SECRET_PEPPER || '').trim();
const DEV_FALLBACK_PEPPER = 'livi-dev-only-pepper-do-not-use-in-production';

export function assertInstallSecretConfiguration(): void {
  if (process.env.NODE_ENV === 'production' && PEPPER.length < 32) {
    throw new Error('INSTALL_SECRET_PEPPER must contain at least 32 characters');
  }
}

function digest(secret: string, pepper: string): string {
  return crypto.createHmac('sha256', pepper).update(secret).digest('hex');
}
function sameHash(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Existing opt-in legacy access policy. It never enrolls or rewrites an old record. */
export function allowLegacyInstallAuth(): boolean { return process.env.INSTALL_AUTH_MODE === 'legacy-migration'; }
export const LEGACY_INSTALL_SEAL = 'legacy-migration';

/** Versioned hashes never use the legacy pepper. */
export function hashInstallSecret(secret: string): string {
  assertInstallSecretConfiguration();
  // Development without a production pepper writes the explicit legacy format,
  // so previously created accounts remain verifiable without rewriting their records.
  return PEPPER ? 'v1:' + digest(String(secret), PEPPER) : digest(String(secret), DEV_FALLBACK_PEPPER);
}
export function verifyInstallSecret(secret: string | undefined | null, storedHash: string | undefined | null): boolean {
  if (!isPlausibleInstallSecret(secret) || typeof storedHash !== 'string') return false;
  if (storedHash.startsWith('v1:')) return sameHash(digest(secret, PEPPER || DEV_FALLBACK_PEPPER), storedHash.slice(3));
  // Transition only for previously stored, unversioned hashes. The high-entropy
  // original secret is still mandatory; authentication leaves the stored hash intact.
  return sameHash(digest(secret, PEPPER || DEV_FALLBACK_PEPPER), storedHash) ||
    sameHash(digest(secret, DEV_FALLBACK_PEPPER), storedHash);
}

/** Простая проверка формата: не пустой, разумной длины (клиент шлёт hex/base64 случайных байт). */
export function isPlausibleInstallSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && secret.length >= 16 && secret.length <= 512;
}

export type HttpInstallAuthDecision = {
  /** allow — секрет верный; reject — не пускать. */
  result: 'allow' | 'reject';
  /** Первый верный секрет по HTTP: с этого момента для установки он обязателен. */
  markHttpSecretSeen: boolean;
};

/** Every authenticated HTTP request must prove ownership, including legacy records. */
export function decideHttpInstallAuth(input: {
  storedHash?: string | null;
  providedSecret?: string | null;
  httpSecretSeen: boolean;
  requireAll: boolean;
}): HttpInstallAuthDecision {
  if (!input.storedHash && !input.requireAll && allowLegacyInstallAuth()) return { result: 'allow', markHttpSecretSeen: false };
  if (verifyInstallSecret(input.providedSecret, input.storedHash)) {
    return { result: 'allow', markHttpSecretSeen: !input.httpSecretSeen };
  }
  return { result: 'reject', markHttpSecretSeen: false };
}
