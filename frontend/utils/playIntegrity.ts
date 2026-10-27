/**
 * Play Integrity — пока только наблюдение (backend/routes/integrity.ts). После переустановки (секрет
 * установки создан заново, сервер его перепривязал) и раз в неделю как выборка приложение получает у
 * Google токен, привязанный к installId и секрету, и отдаёт серверу. Вход от этого не зависит:
 * отчёт уходит после успешного identity:attach, в фоне, любая ошибка просто пишется на сервер.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import { applicationId } from 'expo-application';
import nacl from 'tweetnacl';
import { API_BASE } from '../sockets/modules/constants';
import { utf8Encode } from '../sockets/modules/e2eCrypto';
import { fetchWithTimeout } from './fetchWithTimeout';
import { getInstallAuthHeaders, getInstallId, getInstallSecret, wasInstallSecretCreatedThisRun } from './installId';

/** Проект Google Cloud livi-4dbe5 (Firebase), привязанный к Play Integrity в Play Console. */
const CLOUD_PROJECT_NUMBER = 611469781534;
const PERIODIC_MS = 7 * 24 * 60 * 60_000;
const TOKEN_TIMEOUT_MS = 20_000;
const LAST_REPORT_KEY = 'livi.integrity.lastReportAt';

/** Тот же хэш считает сервер (backend/utils/playIntegrity.ts): токен годится только для этой пары. */
export function integrityRequestHash(installId: string, installSecret: string): string {
  const digest = nacl.hash(utf8Encode(`livi-integrity-v1|${installId}|${installSecret}`));
  let hex = '';
  for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2, '0');
  return hex;
}

function requestToken(requestHash: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('E_INTEGRITY_TIMEOUT')), TOKEN_TIMEOUT_MS);
    NativeModules.LiviIntegrity.requestToken(CLOUD_PROJECT_NUMBER, requestHash).then(
      (token: string) => {
        clearTimeout(timer);
        resolve(token);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Один отчёт за запуск. Повтор (на следующем connect) — только после сети или 401 до перепривязки
 * секрета, и не больше MAX_ATTEMPTS: каждый заход тратит квоту Play Integrity.
 */
const MAX_ATTEMPTS = 3;
let reportState: 'idle' | 'running' | 'done' = 'idle';
let attempts = 0;

export async function reportInstallIntegrityIfDue(): Promise<void> {
  if (Platform.OS !== 'android' || !NativeModules.LiviIntegrity?.requestToken || reportState !== 'idle') return;
  if (attempts >= MAX_ATTEMPTS) return;
  attempts += 1;
  reportState = 'running';
  try {
    let reason: 'new_secret' | 'periodic' | null = wasInstallSecretCreatedThisRun() ? 'new_secret' : null;
    if (!reason) {
      const last = Number((await AsyncStorage.getItem(LAST_REPORT_KEY).catch(() => null)) || 0);
      if (Date.now() - last >= PERIODIC_MS) reason = 'periodic';
    }
    if (!reason) {
      reportState = 'done';
      return;
    }

    const [installId, installSecret] = await Promise.all([getInstallId(), getInstallSecret()]);
    if (!installId || !installSecret) {
      reportState = 'idle';
      return;
    }

    let token: string | null = null;
    let error: string | null = null;
    try {
      token = await requestToken(integrityRequestHash(installId, installSecret));
    } catch (e: any) {
      error = String(e?.code || e?.message || 'E_INTEGRITY').slice(0, 80);
    }

    const res = await fetchWithTimeout(
      `${API_BASE}/api/integrity/report`,
      {
        method: 'POST',
        headers: { ...(await getInstallAuthHeaders()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, packageName: applicationId, token, error }),
      },
      15_000,
    );
    // 401: секрет ещё не перепривязан (attach после переустановки не завершился) — повторим позже.
    // Остальные ошибки сервера повтором не лечатся: до следующего запуска.
    reportState = res.status === 401 ? 'idle' : 'done';
    if (res.ok) await AsyncStorage.setItem(LAST_REPORT_KEY, String(Date.now())).catch(() => {});
  } catch {
    reportState = 'idle';
  }
}
