// utils/installSecret.ts
// Секрет установки (installSecret): случайное значение высокой энтропии, которое клиент
// генерирует один раз при первой привязке installId -> user и хранит в SecureStore.
// Сервер хранит только HMAC-хэш. Без этого секрета простое знание/подбор installId
// достаточно для получения чужой сессии (см. security review) — этот модуль закрывает дыру.
import crypto from 'crypto';
import { logger } from './logger';

const PEPPER = String(process.env.INSTALL_SECRET_PEPPER || '').trim();
const DEV_FALLBACK_PEPPER = 'livi-dev-only-pepper-do-not-use-in-production';

let warnedMissingPepper = false;
function effectivePepper(): string {
  if (PEPPER) return PEPPER;
  if (!warnedMissingPepper) {
    warnedMissingPepper = true;
    logger.warn(
      '[installSecret] INSTALL_SECRET_PEPPER is not set — falling back to a fixed dev pepper. ' +
      'Set INSTALL_SECRET_PEPPER (long random string) in the backend environment for production.'
    );
  }
  return DEV_FALLBACK_PEPPER;
}

/** Хэширует installSecret для хранения в Install.installSecretHash. */
export function hashInstallSecret(secret: string): string {
  return crypto
    .createHmac('sha256', effectivePepper())
    .update(String(secret || ''))
    .digest('hex');
}

/** Таймсейф-проверка присланного секрета против сохранённого хэша. */
export function verifyInstallSecret(secret: string | undefined | null, storedHash: string | undefined | null): boolean {
  const s = String(secret || '');
  const h = String(storedHash || '');
  if (!s || !h) return false;
  const candidate = hashInstallSecret(s);
  try {
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(h, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Простая проверка формата: не пустой, разумной длины (клиент шлёт hex/base64 случайных байт). */
export function isPlausibleInstallSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && secret.length >= 16 && secret.length <= 512;
}

/**
 * installId, выведенный из аппаратного идентификатора устройства (Android SSAID).
 *
 * Такой id клиент восстанавливает после переустановки приложения, а installSecret — нет:
 * expo-secure-store шифрует значение ключом из AndroidKeyStore, а ключ удаляется вместе с
 * приложением, поэтому секрет не переживает удаление даже через резервное копирование.
 * Для этих id сервер разрешает ротацию секрета — иначе установка навсегда занята мёртвой
 * привязкой и пользователь теряет друзей, переписки и покупки после переустановки.
 *
 * Владение самим значением и есть доказательство: ANDROID_ID выдаётся по паре
 * (подпись приложения + пользователь устройства), другим приложениям недоступен и нигде
 * не показывается. Для случайных installId ротация по-прежнему запрещена.
 */
export function isDeviceBoundInstallId(installId: unknown): boolean {
  const id = String(installId || '');
  return /^inst_android_[A-Za-z0-9]{8,}$/.test(id);
}
