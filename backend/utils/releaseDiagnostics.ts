import { createHash } from 'crypto';

export type DiagnosticLevel = 'info' | 'warning' | 'error';
export type DiagnosticData = Record<string, string | number | boolean>;
export type DiagnosticEvent = {
  id: string; at: number; session: string; event: string; level: DiagnosticLevel;
  operation?: string; data: DiagnosticData;
};
export type DiagnosticDevice = {
  model: string; manufacturer: string; os: string; build: string; version: string; packageName: string;
};

const TOKEN = /^[A-Za-z0-9_.:~-]{1,96}$/;
const DATA_KEYS = new Set([
  'phase', 'reason', 'outcome', 'role', 'source', 'state', 'roomState', 'kind', 'type',
  'code', 'errorName', 'tag', 'mode', 'isFatal', 'connected', 'delivered', 'queued', 'ok',
  'attempt', 'count', 'pending', 'dropped', 'durationMs', 'connectMs', 'ringMs', 'talkMs',
  'stalledMs', 'delayMs', 'ageMs', 'audioLevel', 'audioEnergy', 'bytesSent', 'bytesReceived',
  'framesDecoded', 'framesEncoded', 'nativeTimestamp', 'status', 'retryCount',
]);

/** Only categorical tokens and bounded metrics. No text, URIs, stacks, tokens or user names. */
export function sanitizeDiagnosticData(value: unknown): DiagnosticData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: DiagnosticData = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!DATA_KEYS.has(key)) continue;
    if (typeof raw === 'boolean') result[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw) && Math.abs(raw) <= 1e15) result[key] = raw;
    else if (typeof raw === 'string' && TOKEN.test(raw)) result[key] = raw;
  }
  return result;
}

export function sanitizeDiagnosticEvent(value: unknown, now: number): DiagnosticEvent | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !TOKEN.test(v.id) || typeof v.session !== 'string' || !TOKEN.test(v.session)) return null;
  if (typeof v.event !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(v.event)) return null;
  if (!['info', 'warning', 'error'].includes(String(v.level))) return null;
  if (typeof v.at !== 'number' || !Number.isFinite(v.at) || v.at < now - 30 * 86400_000 || v.at > now + 300_000) return null;
  return {
    id: v.id, session: v.session, event: v.event, at: v.at, level: v.level as DiagnosticLevel,
    ...(typeof v.operation === 'string' && /^[a-f0-9]{24}$/.test(v.operation) ? { operation: v.operation } : {}),
    data: sanitizeDiagnosticData(v.data),
  };
}

export function sanitizeDiagnosticDevice(value: unknown): DiagnosticDevice | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const read = (key: string) => typeof v[key] === 'string' ? v[key].replace(/[\r\n<>]/g, '').slice(0, 80) : '';
  const device = { model: read('model'), manufacturer: read('manufacturer'), os: read('os'),
    build: read('build'), version: read('version'), packageName: read('packageName') };
  if (!device.model || !/^\d{1,9}$/.test(device.build) || !['com.kolt12max.livi', 'com.kolt12max.livi.dev'].includes(device.packageName)) return null;
  return device;
}

export const diagnosticDeviceKey = (installId: string) => createHash('sha256').update(`livi-diagnostics-v1|${installId}`).digest('hex').slice(0, 24);

export function diagnosticDeviceAllowed(installId: string, model: string): boolean {
  const ids = String(process.env.RELEASE_DIAGNOSTICS_INSTALL_IDS || '').split(',').map(v => v.trim()).filter(Boolean);
  const models = String(process.env.RELEASE_DIAGNOSTICS_MODELS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  // Explicit installation IDs take precedence over model enrollment, when supplied.
  return ids.length ? ids.includes(installId) : models.includes(model.toLowerCase());
}

/** Daily reporting window ends at 21:00 Moscow, independent of the host timezone. */
export function diagnosticReportWindow(now: Date): { key: string; start: Date; end: Date } {
  const offset = 3 * 3600_000;
  const moscow = new Date(now.getTime() + offset);
  const end = new Date(Date.UTC(moscow.getUTCFullYear(), moscow.getUTCMonth(), moscow.getUTCDate(), 18));
  if (now < end) end.setUTCDate(end.getUTCDate() - 1);
  return { key: new Date(end.getTime() + offset).toISOString().slice(0, 10), start: new Date(end.getTime() - 86400_000), end };
}
