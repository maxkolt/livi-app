/**
 * E2EE звонков не зависит от настроек и ключей чата.
 *
 * Для каждого звонка обе стороны автоматически создают отдельную
 * эфемерную X25519-пару. Сервер видит только публичные ключи; общий
 * ключ LiveKit frame encryption выводится на устройствах.
 */
import "react-native-get-random-values";
import * as SecureStore from "expo-secure-store";
import {
  deriveCallFrameKey,
  fromBase64,
  generateKeyPair,
  keyPairFromSecretKey,
  toBase64,
  type E2eKeyPair,
} from "./e2eCrypto";

export type CallE2eeDeclaration = { pk: string };

const SECRET_KEY_PREFIX = "livi_call_e2ee_secret_v1:";
const PENDING_TTL_MS = 2 * 60_000;
const MAX_MEMORY_KEYS = 12;

type PendingKey = { pair: E2eKeyPair; createdAt: number };

const keysByCallId = new Map<string, E2eKeyPair>();
const pendingByPeer = new Map<string, PendingKey>();

function normalize(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function erasePair(pair: E2eKeyPair | undefined): void {
  if (!pair) return;
  try {
    pair.secretKey.fill(0);
  } catch {}
}

function pairIsPending(pair: E2eKeyPair): boolean {
  for (const pending of pendingByPeer.values()) {
    if (pending.pair === pair) return true;
  }
  return false;
}

function pruneMemory(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [peerId, pending] of pendingByPeer) {
    if (pending.createdAt >= cutoff) continue;
    pendingByPeer.delete(peerId);
    if (![...keysByCallId.values()].includes(pending.pair)) erasePair(pending.pair);
  }
  while (keysByCallId.size > MAX_MEMORY_KEYS) {
    const oldest = keysByCallId.keys().next().value as string | undefined;
    if (!oldest) break;
    const pair = keysByCallId.get(oldest);
    keysByCallId.delete(oldest);
    if (pair && !pairIsPending(pair)) erasePair(pair);
  }
}

async function persistCallPair(callId: string, pair: E2eKeyPair): Promise<void> {
  try {
    await SecureStore.setItemAsync(SECRET_KEY_PREFIX + callId, toBase64(pair.secretKey));
  } catch {
    // Активный звонок всё равно защищён ключом из памяти; не логируем секрет.
  }
}

async function loadCallPair(callId: string): Promise<E2eKeyPair | null> {
  const inMemory = keysByCallId.get(callId);
  if (inMemory) return inMemory;
  try {
    const encoded = await SecureStore.getItemAsync(SECRET_KEY_PREFIX + callId);
    const secretKey = encoded ? fromBase64(encoded) : null;
    if (!secretKey || secretKey.length !== 32) return null;
    const pair = keyPairFromSecretKey(secretKey);
    keysByCallId.set(callId, pair);
    pruneMemory();
    return pair;
  } catch {
    return null;
  }
}

/** Один ключ на весь ringing-retry к тому же peer, чтобы не разойтись с уже созданным callId. */
export function createOutgoingCallE2eeDeclaration(peerUserId: string): CallE2eeDeclaration {
  pruneMemory();
  const peerId = normalize(peerUserId);
  if (!peerId) throw new Error("call_e2ee_missing_peer");
  const existing = pendingByPeer.get(peerId);
  if (existing) return { pk: toBase64(existing.pair.publicKey) };
  const pair = generateKeyPair();
  pendingByPeer.set(peerId, { pair, createdAt: Date.now() });
  return { pk: toBase64(pair.publicKey) };
}

/** После initiate ack привязываем секрет звонящего к callId и сохраняем для reconnect. */
export async function bindOutgoingCallE2ee(
  callIdRaw: string,
  peerUserId: string,
  declaration: CallE2eeDeclaration,
): Promise<boolean> {
  const callId = String(callIdRaw || "").trim();
  const peerId = normalize(peerUserId);
  if (!callId || !peerId) return false;
  const pending = pendingByPeer.get(peerId);
  if (!pending || toBase64(pending.pair.publicKey) !== declaration.pk) return false;
  // Оставляем ту же пару до истечения ringing TTL: повторный initiate
  // может получить тот же callId и обязан объявить тот же public key.
  pending.createdAt = Date.now();
  keysByCallId.set(callId, pending.pair);
  pruneMemory();
  await persistCallPair(callId, pending.pair);
  return true;
}

/** Принимающая сторона уже знает callId и сразу создаёт и сохраняет его ключ. */
export async function getOrCreateIncomingCallE2eeDeclaration(callIdRaw: string): Promise<CallE2eeDeclaration> {
  const callId = String(callIdRaw || "").trim();
  if (!callId) throw new Error("call_e2ee_missing_call_id");
  let pair = await loadCallPair(callId);
  if (!pair) {
    pair = generateKeyPair();
    keysByCallId.set(callId, pair);
    pruneMemory();
    await persistCallPair(callId, pair);
  }
  return { pk: toBase64(pair.publicKey) };
}

/** Общий 32-байтный ключ кадров. Приватный ключ никогда не покидает устройство. */
export async function deriveCallKey(peerPublicKey: string, callIdRaw: string): Promise<Uint8Array | null> {
  const callId = String(callIdRaw || "").trim();
  const peer = fromBase64(peerPublicKey);
  if (!callId || !peer || peer.length !== 32) return null;
  const own = await loadCallPair(callId);
  if (!own) return null;
  return deriveCallFrameKey(own, peer, callId);
}

/** Секрет намеренно живёт только до конца звонка. */
export async function clearCallE2ee(callIdRaw: string): Promise<void> {
  const callId = String(callIdRaw || "").trim();
  if (!callId) return;
  const pair = keysByCallId.get(callId);
  keysByCallId.delete(callId);
  for (const [peerId, pending] of pendingByPeer) {
    if (pending.pair === pair) pendingByPeer.delete(peerId);
  }
  erasePair(pair);
  clearCallE2eeUi(callId);
  try {
    await SecureStore.deleteItemAsync(SECRET_KEY_PREFIX + callId);
  } catch {}
}

/* ---------- UI: щит на экране звонка (caller + callee) ---------- */

let callE2eeUiActive = false;
let callE2eeUiCallId: string | null = null;
const callE2eeUiListeners = new Set<() => void>();

function notifyCallE2eeUi(): void {
  callE2eeUiListeners.forEach((listener) => listener());
}

/** Включить/выключить щит; привязка к callId, чтобы старый звонок не гасил новый. */
export function setCallE2eeUiActive(active: boolean, callIdRaw?: string | null): void {
  const callId = String(callIdRaw || "").trim() || null;
  if (active) {
    if (callE2eeUiActive && callE2eeUiCallId === callId) return;
    callE2eeUiActive = true;
    callE2eeUiCallId = callId;
    notifyCallE2eeUi();
    return;
  }
  if (callId && callE2eeUiCallId && callId !== callE2eeUiCallId) return;
  if (!callE2eeUiActive && !callE2eeUiCallId) return;
  callE2eeUiActive = false;
  callE2eeUiCallId = null;
  notifyCallE2eeUi();
}

export function clearCallE2eeUi(callIdRaw?: string | null): void {
  setCallE2eeUiActive(false, callIdRaw);
}

export function getCallE2eeUiSnapshot(): boolean {
  return callE2eeUiActive;
}

export function subscribeCallE2eeUi(onStoreChange: () => void): () => void {
  callE2eeUiListeners.add(onStoreChange);
  return () => {
    callE2eeUiListeners.delete(onStoreChange);
  };
}
