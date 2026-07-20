// frontend/sockets/modules/constants.ts
import { Platform } from "react-native";
import { logger } from '../../utils/logger';

/* ========= Server URL ========= */
// Получаем BASE_URL из переменных окружения
// Приоритет: платформо-специфичная переменная > общая переменная > fallback
// КРИТИЧНО: В production используйте домены с HTTPS, не IP адреса!
const DEFAULT_URL = process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
const IOS_URL = process.env.EXPO_PUBLIC_SERVER_URL_IOS || process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
const ANDROID_URL = process.env.EXPO_PUBLIC_SERVER_URL_ANDROID || process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';

function isLocalOrPrivateApiHost(rawUrl: string): boolean {
  try {
    const normalized = String(rawUrl || '').trim();
    if (!normalized) return true;
    const u = new URL(normalized);
    const host = String(u.hostname || '').toLowerCase();
    if (!host) return true;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (host.startsWith('10.')) return true;
    if (host.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
    return false;
  } catch {
    return true;
  }
}

const RAW_API_BASE = (Platform.OS === 'android' ? ANDROID_URL : IOS_URL).replace(/\/+$/, '');
const ALLOW_PRIVATE_API_IN_RELEASE = String(process.env.EXPO_PUBLIC_ALLOW_PRIVATE_API_IN_RELEASE || '').trim() === '1';
const SAFE_PRODUCTION_API_BASE = 'https://api.liviapp.com';
const SHOULD_FORCE_SAFE_API_BASE =
  !__DEV__ &&
  !ALLOW_PRIVATE_API_IN_RELEASE &&
  isLocalOrPrivateApiHost(RAW_API_BASE);

export const API_BASE = SHOULD_FORCE_SAFE_API_BASE ? SAFE_PRODUCTION_API_BASE : RAW_API_BASE;

if (SHOULD_FORCE_SAFE_API_BASE) {
  logger.warn('[socket] Non-public API base in release build, forcing production API', {
    rawApiBase: RAW_API_BASE,
    forcedApiBase: API_BASE,
  });
}

/** Первый коннект / смена сети (VPN, DNS): согласовано с io({ timeout }). Пуши и accept/decline ждут столько же. */
export const SOCKET_CONNECT_WAIT_MS = 25000;

/** In-app call signaling (accept / initiate) after warmCallSignaling or while app is active. */
export const CALL_SIGNALING_CONNECT_MS = 8000;

if (__DEV__) {
  const lk = (process.env.EXPO_PUBLIC_LIVEKIT_URL || '').trim();
  logger.debug('[socket] API_BASE / LIVEKIT', { API_BASE, livekit: lk || '—' });
}

/* ========= helpers ========= */
export const isOid = (s?: string) => !!s && /^[a-f\d]{24}$/i.test(s);

export const SOCKET_RECONNECT_DELAY_MS = 1000;
export const SOCKET_RECONNECT_DELAY_MAX_MS = 10000;
/** После server:restarting (деплой) — быстрее цепляемся к поднявшемуся инстансу. */
export const SOCKET_RECONNECT_AFTER_SERVER_RESTART_DELAY_MS = 200;
export const SOCKET_RECONNECT_AFTER_SERVER_RESTART_DELAY_MAX_MS = 5000;
