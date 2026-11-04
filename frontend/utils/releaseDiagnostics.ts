import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, NativeModules, Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import nacl from 'tweetnacl';
import { API_BASE } from '../sockets/modules/constants';
import { getInstallAuthHeaders } from './installId';
import { DIAGNOSTIC_QUEUE_KEY, ReleaseDiagnosticQueue, type ReleaseDiagnosticEvent } from './releaseDiagnosticQueue';
import { setDiagnosticLogSink } from './logger';
import { recordReleaseDiagnostic, setReleaseDiagnosticCollector } from './releaseDiagnosticBridge';

const SETTINGS_KEY = 'livi.release_diagnostics.settings.v1';
const session = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
let queue: ReleaseDiagnosticQueue | null = null;
let enabled = false;
let initialized = false;
let configuring = false;
let lastConfigAt = 0;
let sequence = 0;
let lastHeartbeat = 0;
let diagnosticOwner = '';
let overflow = 0;
let startLogged = false;
const throttled = new Map<string, number>();
const device = {
  model: Device.modelName || Device.modelId || 'unknown', manufacturer: Device.manufacturer || 'unknown',
  os: Device.osVersion || String(Platform.Version), build: Application.nativeBuildVersion || '0',
  version: Application.nativeApplicationVersion || 'unknown', packageName: Application.applicationId || '',
};
const KEYS = new Set(['phase', 'reason', 'outcome', 'role', 'source', 'state', 'roomState', 'kind', 'type',
  'code', 'errorName', 'tag', 'mode', 'isFatal', 'connected', 'delivered', 'queued', 'ok', 'attempt', 'count',
  'pending', 'dropped', 'durationMs', 'connectMs', 'ringMs', 'talkMs', 'stalledMs', 'delayMs', 'ageMs',
  'audioLevel', 'audioEnergy', 'bytesSent', 'bytesReceived', 'framesDecoded', 'framesEncoded', 'nativeTimestamp', 'status', 'retryCount']);

export function safeDiagnosticData(payload: Record<string, unknown>): ReleaseDiagnosticEvent['data'] {
  const result: ReleaseDiagnosticEvent['data'] = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!KEYS.has(key)) continue;
    if (typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e15) result[key] = value;
    else if (typeof value === 'string' && /^[A-Za-z0-9_.:~-]{1,96}$/.test(value)) result[key] = value;
  }
  return result;
}

function operationKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 255;
  return Array.from(nacl.hash(bytes).slice(0, 12), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Privacy-filtered diagnostic stream; disabled until the server enrolls this installation. */
function collectEvent(event: string, level: ReleaseDiagnosticEvent['level'], payload: Record<string, unknown>): void {
  if (!enabled || !queue || !/^[a-z][a-z0-9_]{0,79}$/.test(event)) return;
  const now = Date.now();
  const data = safeDiagnosticData(payload);
  if (event === 'call_outcome' && data.outcome === 'connect_failed') level = 'warning';
  const signature = `${event}|${data.phase || ''}|${data.tag || ''}|${data.code || ''}`;
  // Keep repeated failures visible without flooding disk/network during a tight retry loop.
  if (level !== 'info' && event !== 'native_process_failure') {
    if (now - (throttled.get(signature) || 0) < 5000) { overflow++; return; }
    if (throttled.size >= 200) throttled.clear();
    throttled.set(signature, now);
  }
  const operation = operationKey(payload.callId || payload.roomId || payload.messageId || payload.outboxId);
  void queue.enqueue({ id: `${session}_${++sequence}`, at: now, session, event, level, data,
    ...(operation ? { operation } : {}) }).catch(() => {});
}

async function request(path: string, body: unknown): Promise<{ ok?: boolean; enabled?: boolean; accepted?: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const headers = await getInstallAuthHeaders();
    if (!headers['x-install-id'] || !headers['x-install-secret']) return null;
    // Do not upload a prior account/installation's buffered data using another identity.
    if (diagnosticOwner && headers['x-install-id'] !== diagnosticOwner) { enabled = false; return null; }
    const response = await fetch(`${API_BASE}/api/diagnostics/${path}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device, ...body as object }), signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function configure(): Promise<void> {
  if (configuring) return;
  configuring = true;
  try {
    const headers = await getInstallAuthHeaders();
    const owner = headers['x-install-id'];
    if (!owner) return;
    if (diagnosticOwner !== owner) {
      enabled = false;
      diagnosticOwner = owner;
      queue = new ReleaseDiagnosticQueue(AsyncStorage, `${DIAGNOSTIC_QUEUE_KEY}:${operationKey(owner)}`);
      startLogged = false;
    }
    const savedRaw = await AsyncStorage.getItem(SETTINGS_KEY);
    const saved = savedRaw ? JSON.parse(savedRaw) : null;
    enabled = saved?.owner === owner && saved.enabled === true && Date.now() - saved.at < 7 * 86400_000;
    const result = await request('config', {});
    if (result?.ok) {
      enabled = result.enabled === true;
      lastConfigAt = Date.now();
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ owner, enabled, at: lastConfigAt }));
    }
  } catch { /* Retry next minute; no diagnostics recursion. */ }
  finally { configuring = false; }
}

async function collectNativeExits(): Promise<void> {
    const read = NativeModules.LiviAppModule?.getReleaseDiagnosticExits;
  if (!read || !enabled) return;
  try {
    const key = `livi.release_diagnostics.native_exit_cursor:${operationKey(diagnosticOwner)}`;
    const cursor = Number(await AsyncStorage.getItem(key)) || (await Application.getInstallationTimeAsync()).getTime();
    const exits: Array<{ at: number; code: string }> = await read(cursor);
    let latest = cursor;
    for (const exit of exits) {
      if (!queue) return;
      await queue.enqueue({ id: `native_${exit.at}_${exit.code}`, at: Date.now(), session,
        event: 'native_process_failure', level: 'error', data: { code: exit.code, nativeTimestamp: exit.at } });
      latest = Math.max(latest, exit.at);
    }
    await AsyncStorage.setItem(key, String(Math.max(latest, Date.now() - 1000)));
  } catch {}
}

export async function flushReleaseDiagnostics(): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (!lastConfigAt || Date.now() - lastConfigAt > 3600_000) await configure();
  if (!enabled || !queue) return;
  if (!startLogged) {
    startLogged = true;
    recordReleaseDiagnostic('app_start');
    await collectNativeExits();
  }
  if (Date.now() - lastHeartbeat > 300_000) {
    lastHeartbeat = Date.now();
    recordReleaseDiagnostic('diagnostic_heartbeat', 'info', { state: AppState.currentState, dropped: overflow });
    overflow = 0;
  }
  await queue.flush(async (events, dropped) => {
    const response = await request('events', { events, dropped });
    if (response?.ok && response.enabled === false) enabled = false;
    return response?.ok === true && response.enabled === true && response.accepted === events.length;
  }).catch(() => {});
}

export function installReleaseDiagnostics(): void {
  if (initialized || Platform.OS !== 'android') return;
  initialized = true;
  setReleaseDiagnosticCollector(collectEvent);
  setDiagnosticLogSink((level, args) => {
    const label = typeof args[0] === 'string' ? args[0] : '';
    const tags = label.match(/\[([A-Za-z0-9_.:-]+)\]/g)?.join('').replace(/[\[\]]/g, '_').slice(0, 80);
    if (!tags) return;
    const meta = args.find(value => value !== null && typeof value === 'object');
    recordReleaseDiagnostic(level === 'error' ? 'app_error' : 'app_warning', level,
      { ...(meta && !(meta instanceof Error) ? meta as Record<string, unknown> : {}), tag: tags,
        ...(meta instanceof Error ? { errorName: meta.name } : {}) });
  });
  void configure().then(async () => {
    await flushReleaseDiagnostics();
  }).catch(() => {});
  const interval = setInterval(() => void flushReleaseDiagnostics().catch(() => {}), 60_000);
  // JS timers may pause in background; foreground always retries independently.
  interval.unref?.();
  AppState.addEventListener('change', state => {
    recordReleaseDiagnostic('app_state', 'info', { state });
    void flushReleaseDiagnostics().catch(() => {});
  });
}
