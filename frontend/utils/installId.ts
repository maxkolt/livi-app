import 'react-native-get-random-values';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'livi.installId';
/** Секрет установки (installSecret): случайное значение высокой энтропии, доказывающее
 * владение installId серверу (identity:attach). Хранится ТОЛЬКО в SecureStore (Keychain/Keystore) —
 * никогда в AsyncStorage — и никогда не логируется целиком. См. backend/utils/installSecret.ts. */
const SECRET_KEY = 'livi.installSecret';

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  // react-native-get-random-values полифиллит crypto.getRandomValues криптостойким генератором.
  (globalThis).crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

let installSecretLoadPromise: Promise<string | null> | null = null;
/** Прочитанный секрет: его шлёт каждый HTTP-запрос, а чтение SecureStore — расшифровка в Keystore. */
let installSecretCache: string | null = null;
/** Секрет создан в этом запуске: первая установка или переустановка (SecureStore её не переживает). */
let installSecretCreatedThisRun = false;

export function wasInstallSecretCreatedThisRun(): boolean {
  return installSecretCreatedThisRun;
}

/** Возвращает (создавая при первом вызове) секрет установки. На web возвращает null:
 * SecureStore недоступен; строгий сервер не разрешает такой установке вход. */
export async function getInstallSecret(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  if (installSecretCache) return installSecretCache;
  if (!installSecretLoadPromise) {
    installSecretLoadPromise = (async () => {
      try {
        let secret = await SecureStore.getItemAsync(SECRET_KEY);
        if (!secret) {
          secret = randomHex(32); // 256 бит энтропии
          await SecureStore.setItemAsync(SECRET_KEY, secret);
          installSecretCreatedThisRun = true;
        }
        installSecretCache = secret;
        return secret;
      } catch (e) {
        return null;
      } finally {
        installSecretLoadPromise = null;
      }
    })();
  }
  return installSecretLoadPromise;
}

let installIdLoggedOnce = false;
/** Сериализуем параллельные getInstallId(), чтобы не создать два разных id до записи в SecureStore. */
let installIdLoadPromise: Promise<string> | null = null;

async function getSecure(k: string) { try { return await SecureStore.getItemAsync(k); } catch { return null; } }
async function setSecure(k: string, v: string) { try { await SecureStore.setItemAsync(k, v); } catch {} }
async function delSecure(k: string) { try { await SecureStore.deleteItemAsync(k); } catch {} }

async function loadOrCreateInstallId(): Promise<string> {
  let id = Platform.OS !== 'web' ? await getSecure(KEY) : null;
  if (!id) id = (await AsyncStorage.getItem(KEY)) || '';
  if (!id) {
    // Keep stored installations intact. A genuinely new installation gets a new
    // random identity, including after reinstall when its old secret is gone.
    // A hardware-derived ID cannot prove ownership of that previous account.
    id = `inst_${randomHex(16)}`;
  }

  if (Platform.OS !== 'web') await setSecure(KEY, id);
  await AsyncStorage.setItem(KEY, id);
  if (__DEV__ && !installIdLoggedOnce) {
    installIdLoggedOnce = true;
    const type = id.startsWith('inst_android_') ? 'Android ID (stable)' : id.startsWith('inst_ios_') ? 'IDFV (stable)' : 'random';
    console.log('[installId]', type, '→', id.slice(0, 24) + (id.length > 24 ? '…' : ''));
  }
  return id;
}

export async function getInstallId(): Promise<string> {
  if (!installIdLoadPromise) {
    installIdLoadPromise = loadOrCreateInstallId().finally(() => {
      installIdLoadPromise = null;
    });
  }
  return installIdLoadPromise;
}

/**
 * Завести новую установку с заведомо случайным installId.
 *
 * Нужно, когда сервер отверг привязку (`unauthorized`): такое бывает после удаления и повторной
 * установки приложения. installId на Android выводится из ANDROID_ID и переживает переустановку,
 * а installSecret лежит в SecureStore и намеренно исключён из бэкапа — то есть теряется всегда.
 * В итоге id занят прошлой установкой, секрет которой доказать уже невозможно, и обычный
 * resetInstallId() не спасает: он вернёт ровно тот же выведенный из ANDROID_ID идентификатор.
 * Поэтому здесь id именно случайный — иначе приложение не сможет ни войти, ни создать аккаунт.
 */
export async function regenerateRandomInstallId(): Promise<string> {
  installIdLoadPromise = null;
  installSecretLoadPromise = null;
  installSecretCache = null;
  const id = `inst_${randomHex(12)}`;
  if (Platform.OS !== 'web') {
    await SecureStore.setItemAsync(KEY, id);
    // Старый секрет больше ни к чему не привязан: следующий getInstallSecret() создаст новый.
    await SecureStore.deleteItemAsync(SECRET_KEY);
  }
  await AsyncStorage.setItem(KEY, id);
  return id;
}

export async function resetInstallId(): Promise<void> {
  installIdLoadPromise = null;
  installSecretLoadPromise = null;
  installSecretCache = null;
  if (Platform.OS !== 'web') {
    await delSecure(KEY);
    try { await SecureStore.deleteItemAsync(SECRET_KEY); } catch {}
  }
  await AsyncStorage.removeItem(KEY);
}

/**
 * Заголовки авторизации для HTTP API: installId и секрет установки. Сервер сверяет секрет с
 * хэшем, сохранённым при identity:attach, — одного installId (он виден в логах и ссылках)
 * для входа от имени пользователя недостаточно.
 */
export async function getInstallAuthHeaders(): Promise<Record<string, string>> {
  const [installId, installSecret] = await Promise.all([
    getInstallId().catch(() => ''),
    getInstallSecret().catch(() => null),
  ]);
  const headers: Record<string, string> = {};
  if (installId) headers['x-install-id'] = String(installId);
  if (installSecret) headers['x-install-secret'] = installSecret;
  return headers;
}
