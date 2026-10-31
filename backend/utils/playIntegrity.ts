// utils/playIntegrity.ts
// Play Integrity (стандартные запросы): расшифровка токена через Google и короткая сводка вердикта.
// Пока только наблюдение: ни вход, ни ротация installSecret от вердикта не зависят. По накопленным
// сводкам решим, можно ли закрыть ротацию секрета после переустановки проверкой целостности.
import crypto from 'crypto';
import { readFileSync } from 'fs';

const SCOPE = 'https://www.googleapis.com/auth/playintegrity';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REQUEST_TIMEOUT_MS = 10_000;
/** Токен старше этого — повтор старого ответа, а не свежая проверка. */
const MAX_TOKEN_AGE_MS = 10 * 60_000;

/** Магазинный пакет и dev-сборка: для .dev Google ответит ошибкой, её тоже пишем. */
export const INTEGRITY_PACKAGES: ReadonlySet<string> = new Set(['com.kolt12max.livi', 'com.kolt12max.livi.dev']);

type ServiceAccount = { client_email: string; private_key: string };

/** Raw verdict fields are normalized and compared in summarizeIntegrity. */
export type IntegrityPayload = {
  requestDetails?: { requestPackageName?: unknown; requestHash?: unknown; timestampMillis?: unknown } | null;
  appIntegrity?: { appRecognitionVerdict?: unknown; packageName?: unknown } | null;
  deviceIntegrity?: {
    deviceRecognitionVerdict?: unknown;
    recentDeviceActivity?: { deviceActivityLevel?: unknown } | null;
  } | null;
  accountDetails?: { appLicensingVerdict?: unknown } | null;
};

type OAuthTokenResponse = { access_token?: string; expires_in?: number | string; error?: string };
type IntegrityDecodeResponse = { tokenPayloadExternal?: IntegrityPayload | null; error?: { status?: string } };
type HttpJsonResult<T> = { status: number; ok: boolean; json: T | null };

/** Тот же сервисный аккаунт, что у FCM (utils/push.ts): его проект привязан к Play Integrity в Play Console. */
function readServiceAccount(): ServiceAccount | null {
  try {
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const raw = path ? readFileSync(path, 'utf8') : json;
    if (!raw) return null;
    const sa = JSON.parse(raw);
    return sa?.client_email && sa?.private_key ? { client_email: sa.client_email, private_key: sa.private_key } : null;
  } catch {
    return null;
  }
}

/** Привязка токена к запросу: тот же хэш считает приложение (frontend/utils/playIntegrity.ts). */
export function integrityRequestHash(installId: string, installSecret: string): string {
  return crypto.createHash('sha512').update(`livi-integrity-v1|${installId}|${installSecret}`, 'utf8').digest('hex');
}

/** JWT сервисного аккаунта для обмена на access token (RFC 7523). */
export function buildServiceAccountAssertion(sa: ServiceAccount, nowSec: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  })}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  return `${unsigned}.${signature}`;
}

function postJson(url: typeof TOKEN_URL, init: RequestInit): Promise<HttpJsonResult<OAuthTokenResponse>>;
function postJson(url: `https://playintegrity.googleapis.com/v1/${string}:decodeIntegrityToken`, init: RequestInit): Promise<HttpJsonResult<IntegrityDecodeResponse>>;
async function postJson(url: string, init: RequestInit): Promise<HttpJsonResult<OAuthTokenResponse | IntegrityDecodeResponse>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, method: 'POST', signal: controller.signal });
    const json = await res.json().catch(() => ({})) as OAuthTokenResponse | IntegrityDecodeResponse | null;
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

let cachedAccess: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccess && cachedAccess.expiresAt - 60_000 > Date.now()) return cachedAccess.token;
  const sa = readServiceAccount();
  if (!sa) throw new Error('no_service_account');
  const { ok, status, json } = await postJson(TOKEN_URL, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildServiceAccountAssertion(sa, Math.floor(Date.now() / 1000)),
    }).toString(),
  });
  if (!ok || !json?.access_token) throw new Error(`oauth_${status}_${json?.error || ''}`);
  cachedAccess = { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000 };
  return cachedAccess.token;
}

/** Расшифровка на стороне Google (шифрование ответов «под управлением Google» в Play Console). */
export async function decodeIntegrityToken(packageName: string, integrityToken: string): Promise<IntegrityPayload | null> {
  const access = await getAccessToken();
  const { ok, status, json } = await postJson(
    `https://playintegrity.googleapis.com/v1/${encodeURIComponent(packageName)}:decodeIntegrityToken`,
    {
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ integrityToken }),
    }
  );
  if (!ok) throw new Error(`decode_${status}_${json?.error?.status || ''}`);
  return json?.tokenPayloadExternal ?? null;
}

export type IntegritySummary = {
  app: string;
  device: string;
  licensing: string;
  activity: string;
  packageOk: boolean;
  hashOk: boolean;
  ageMs: number | null;
  /** Всё, что понадобится для ротации: Play-клиент, настоящее устройство, этот запрос, свежий токен. */
  pass: boolean;
};

export function summarizeIntegrity(
  payload: IntegrityPayload | null | undefined,
  expected: { packageName: string; requestHash: string; nowMs: number }
): IntegritySummary {
  const details = payload?.requestDetails || {};
  const app = String(payload?.appIntegrity?.appRecognitionVerdict || 'missing');
  const deviceVerdicts: string[] = Array.isArray(payload?.deviceIntegrity?.deviceRecognitionVerdict)
    ? payload.deviceIntegrity.deviceRecognitionVerdict.map(String)
    : [];
  const appPackage = payload?.appIntegrity?.packageName;
  const packageOk =
    details.requestPackageName === expected.packageName && (appPackage == null || appPackage === expected.packageName);
  const hashOk = typeof details.requestHash === 'string' && details.requestHash === expected.requestHash;
  const timestamp = Number(details.timestampMillis);
  const ageMs = Number.isFinite(timestamp) && timestamp > 0 ? expected.nowMs - timestamp : null;
  const fresh = ageMs != null && ageMs >= -60_000 && ageMs <= MAX_TOKEN_AGE_MS;
  return {
    app,
    device: deviceVerdicts.join(',') || 'none',
    licensing: String(payload?.accountDetails?.appLicensingVerdict || 'missing'),
    activity: String(payload?.deviceIntegrity?.recentDeviceActivity?.deviceActivityLevel || 'missing'),
    packageOk,
    hashOk,
    ageMs,
    pass: app === 'PLAY_RECOGNIZED' && deviceVerdicts.includes('MEETS_DEVICE_INTEGRITY') && packageOk && hashOk && fresh,
  };
}
