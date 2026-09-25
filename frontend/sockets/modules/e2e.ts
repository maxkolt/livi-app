/**
 * Сквозное шифрование чата: ключи, их резервная копия и шифрование на границе сети.
 *
 * Состояния своего ключа:
 *   unknown       — ещё не сверялись с сервером
 *   needs_setup   — ключа нет: сообщения идут как раньше, пока пользователь не задаст пароль
 *   needs_restore — на сервере опубликован ключ, а на устройстве его нет (переустановка):
 *                   нужен пароль копии, иначе старая переписка не читается
 *   ready         — ключ на устройстве совпадает с опубликованным
 *   disabled      — пользователь отключил шифрование: ключ снят с публикации, копия
 *                   осталась; новые сообщения обычные, старые читаются (если ключ здесь)
 *
 * Ключ публикуется только вместе с копией под паролем (правило держит и сервер):
 * переустановка на Android сохраняет аккаунт, но стирает SecureStore.
 * Ключ хранится под userId: удаление профиля даёт новый аккаунт, ключи не смешиваются.
 */
import "react-native-get-random-values";
import { NativeModules } from "react-native";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { emitAck } from "./emit";
import { logger } from "../../utils/logger";
import { ensureReauthBeforePrivilegedSocketOp } from "./reauth";
import { shared } from "./shared";
import { socket } from "./socketCore";
import {
  createKeyBackup,
  deriveCallFrameKey,
  deriveRestoreKeys,
  fromBase64,
  generateKeyPair,
  keyPairFromSecretKey,
  nativePbkdf2MatchesJs,
  openKeyBackup,
  setNativePbkdf2,
  type Pbkdf2Impl,
  openMessage,
  sealMessage,
  toBase64,
  type E2eBackup,
  type E2eBackupKdf,
  type E2eEnvelope,
  type E2eKeyPair,
} from "./e2eCrypto";

export type E2eStatus = "unknown" | "needs_setup" | "needs_restore" | "ready" | "disabled";

/** Свой ключ есть, а зашифровать сейчас нельзя — сообщение не должно уйти открытым текстом. */
export class E2eUnavailableError extends Error {
  /** locked — свой ключ не восстановлен; unavailable — временно нет связи для сверки ключей. */
  constructor(public readonly reason: "locked" | "unavailable") {
    super(`e2e_${reason}`);
  }
}

const SECRET_KEY_PREFIX = "livi.e2e.sk.";
const PINS_KEY = "e2e_peer_key_pins_v1";
const PEER_KEY_TTL_MS = 30 * 60_000;
/** «Ключа нет» проверяем чаще: собеседник мог только что включить шифрование. */
const PEER_NO_KEY_TTL_MS = 2 * 60_000;

type State = {
  userId: string | null;
  status: E2eStatus;
  own: E2eKeyPair | null;
  serverPublicKey: string;
  backupKdf: E2eBackupKdf | null;
  /** Публичный ключ, которому соответствует копия на сервере. */
  backupPk: string;
};

const state: State = { userId: null, status: "unknown", own: null, serverPublicKey: "", backupKdf: null, backupPk: "" };
const peerE2eSubs = new Set<(peerId: string) => void>();
const statusSubs = new Set<(s: E2eStatus) => void>();
const keyChangeSubs = new Set<(peerId: string) => void>();
const peerKeys = new Map<string, { pk: string; at: number }>();
let pins: Record<string, string> | null = null;
let refreshInFlight: Promise<E2eStatus> | null = null;
/** Сервер не ответил на e2e:state (нет связи или старый бэкенд) — не ждём его на каждом сообщении. */
let stateFailedAt = 0;
const STATE_RETRY_MS = 60_000;
const STATE_TIMEOUT_MS = 8_000;

function setStatus(next: E2eStatus) {
  if (state.status === next) return;
  state.status = next;
  for (const cb of statusSubs) {
    try {
      cb(next);
    } catch {}
  }
}

/** Смена пользователя (выход, удаление профиля) — сбрасываем всё, что относилось к прошлому. */
function syncUser(): string | null {
  const me = String(shared.currentUserId || "").trim() || null;
  if (me !== state.userId) {
    state.userId = me;
    state.own = null;
    state.serverPublicKey = "";
    state.backupKdf = null;
    state.backupPk = "";
    peerKeys.clear();
    pins = null;
    stateFailedAt = 0;
    setStatus("unknown");
  }
  return me;
}

async function loadOwnKey(me: string): Promise<E2eKeyPair | null> {
  if (state.own) return state.own;
  try {
    const raw = await SecureStore.getItemAsync(SECRET_KEY_PREFIX + me);
    const sk = raw ? fromBase64(raw) : null;
    if (sk && sk.length === 32 && state.userId === me) state.own = keyPairFromSecretKey(sk);
  } catch {}
  return state.own;
}

async function saveOwnKey(me: string, pair: E2eKeyPair): Promise<void> {
  // Сначала на устройство, потом на сервер: опубликованный ключ без локальной копии — потеря переписки.
  await SecureStore.setItemAsync(SECRET_KEY_PREFIX + me, toBase64(pair.secretKey));
  if (state.userId === me) state.own = pair;
}

/** Удаление профиля: ключ и запомненные ключи собеседников этого аккаунта больше не нужны. */
export async function deleteLocalE2eKey(userId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SECRET_KEY_PREFIX + userId);
  } catch {}
  try {
    await AsyncStorage.multiRemove([`${PINS_KEY}:${userId}`, `e2e_setup_prompt_seen_v1:${userId}`]);
  } catch {}
  if (state.userId === userId) {
    state.own = null;
    setStatus("unknown");
  }
}

export function getE2eStatus(): E2eStatus {
  syncUser();
  return state.status;
}

export function onE2eStatus(cb: (s: E2eStatus) => void): () => void {
  statusSubs.add(cb);
  return () => statusSubs.delete(cb);
}

/** Собеседник сменил ключ (сбросил пароль): стоит сказать об этом пользователю. */
export function onPeerKeyChanged(cb: (peerId: string) => void): () => void {
  keyChangeSubs.add(cb);
  return () => keyChangeSubs.delete(cb);
}

/** Сверка своего ключа с сервером. Вызывается после подключения и reauth. */
export function refreshE2eState(): Promise<E2eStatus> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const me = syncUser();
    if (!me) return state.status;
    const own = await loadOwnKey(me);
    // До reauth сервер не знает userId и ответит unauthorized.
    if (!(await ensureReauthBeforePrivilegedSocketOp().catch(() => false))) return state.status;
    const resp: any = await emitAck("e2e:state", {}, STATE_TIMEOUT_MS, 0).catch(() => null);
    if (!resp?.ok) stateFailedAt = Date.now();
    if (!resp?.ok || state.userId !== me) return state.status;
    stateFailedAt = 0;
    state.serverPublicKey = String(resp.publicKey || "");
    state.backupKdf = resp.backup?.kdf ?? null;
    state.backupPk = String(resp.backup?.pk || "");
    if (own && state.serverPublicKey === toBase64(own.publicKey)) setStatus("ready");
    else if (state.serverPublicKey && state.backupKdf) setStatus("needs_restore");
    // Отключено (ключ снят, копия есть): отправка обычная, восстановить/включить — из меню.
    else if (!state.serverPublicKey && state.backupKdf && state.backupPk) setStatus("disabled");
    else setStatus("needs_setup");
    return state.status;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

type ActionResult = { ok: true } | { ok: false; error: string; retryAfterSec?: number };

let nativeKdfReady: Promise<void> | null = null;

/**
 * Нативный PBKDF2 (LiviCrypto) — только если он даёт те же байты, что JS:
 * копию, сделанную на одном устройстве, должно открыть любое другое.
 */
function ensureNativeKdf(): Promise<void> {
  if (nativeKdfReady) return nativeKdfReady;
  nativeKdfReady = (async () => {
    const mod = (NativeModules as any)?.LiviCrypto;
    if (typeof mod?.pbkdf2Sha256 !== "function") return;
    const impl: Pbkdf2Impl = async (password, salt, iterations, dkLen) => {
      const out = fromBase64(await mod.pbkdf2Sha256(toBase64(password), toBase64(salt), iterations, dkLen));
      if (!out || out.length !== dkLen) throw new Error("e2e: native pbkdf2 returned bad output");
      return out;
    };
    try {
      if (await nativePbkdf2MatchesJs(impl)) setNativePbkdf2(impl);
      else logger.error("[e2e] native pbkdf2 differs from JS, falling back to JS");
    } catch (e) {
      logger.warn("[e2e] native pbkdf2 self-check failed, falling back to JS", { error: String((e as Error)?.message || e) });
    }
  })();
  return nativeKdfReady;
}

/**
 * Запрос к серверу шифрования от имени пользователя. После переподключения сокет
 * какое-то время не авторизован (сервер ответит unauthorized) — дожидаемся reauth
 * и повторяем один раз, а не показываем «нет соединения».
 */
async function emitAuthed(event: string, payload: Record<string, unknown>): Promise<any> {
  await ensureReauthBeforePrivilegedSocketOp().catch(() => false);
  let resp: any = await emitAck(event, payload).catch(() => null);
  if (resp?.error === "unauthorized") {
    await ensureReauthBeforePrivilegedSocketOp().catch(() => false);
    resp = await emitAck(event, payload).catch(() => null);
  }
  return resp;
}

async function publish(me: string, pair: E2eKeyPair, password: string): Promise<ActionResult> {
  await ensureNativeKdf();
  const kdfStartedAt = Date.now();
  const backup = await createKeyBackup(pair, password);
  const kdfMs = Date.now() - kdfStartedAt;
  const publishStartedAt = Date.now();
  const resp: any = await emitAuthed("e2e:publish", { publicKey: toBase64(pair.publicKey), backup });
  logger.info("[e2e] publish", {
    ok: !!resp?.ok,
    error: resp?.error ?? (resp ? null : "no_ack"),
    kdf: backup.kdf.alg,
    kdfMs,
    publishMs: Date.now() - publishStartedAt,
  });
  if (!resp?.ok) return { ok: false, error: resp?.error || "network" };
  if (state.userId === me) {
    state.serverPublicKey = toBase64(pair.publicKey);
    state.backupKdf = backup.kdf;
    setStatus("ready");
  }
  return { ok: true };
}

/** Включить шифрование: создать (или взять недопубликованный) ключ и сохранить копию под паролем. */
export async function setupE2e(password: string): Promise<ActionResult> {
  const me = syncUser();
  if (!me) return { ok: false, error: "unauthorized" };
  if (state.status === "needs_restore") return { ok: false, error: "needs_restore" };
  const pair = (await loadOwnKey(me)) ?? generateKeyPair();
  try {
    await saveOwnKey(me, pair);
  } catch {
    return { ok: false, error: "secure_store" };
  }
  return publish(me, pair, password);
}

/** Сменить пароль копии для того же ключа. */
export async function changeE2eBackupPassword(password: string): Promise<ActionResult> {
  const me = syncUser();
  const own = me ? await loadOwnKey(me) : null;
  if (!me || !own || state.status !== "ready") return { ok: false, error: "not_ready" };
  return publish(me, own, password);
}

/** Восстановить ключ из копии после переустановки. */
export async function restoreE2e(password: string): Promise<ActionResult> {
  const me = syncUser();
  if (!me) return { ok: false, error: "unauthorized" };
  if (!state.backupKdf) await refreshE2eState();
  const kdf = state.backupKdf;
  if (!kdf) return { ok: false, error: "no_backup" };
  await ensureNativeKdf();
  const { wrapKey, authKey } = await deriveRestoreKeys(password, kdf);
  const resp: any = await emitAuthed("e2e:backup_fetch", { authKey });
  if (!resp?.ok) {
    wrapKey.fill(0);
    return { ok: false, error: resp?.error || "network", retryAfterSec: resp?.retryAfterSec };
  }
  const pair = openKeyBackup(resp.backup as E2eBackup, wrapKey);
  wrapKey.fill(0);
  if (!pair || toBase64(pair.publicKey) !== state.backupPk) return { ok: false, error: "wrong_password" };
  try {
    await saveOwnKey(me, pair);
  } catch {
    return { ok: false, error: "secure_store" };
  }
  // Восстановили ключ при отключённом шифровании — остаётся отключённым, пока не включат.
  if (state.userId === me) setStatus(state.serverPublicKey === state.backupPk ? "ready" : "disabled");
  return { ok: true };
}

/** Есть ли ключ на этом устройстве (отключённое шифрование можно включить без пароля). */
export function hasLocalE2eKey(): boolean {
  syncUser();
  return state.own != null;
}

/** Отключить шифрование во всех чатах: ключ снимается с публикации, копия остаётся. */
export async function disableE2e(): Promise<ActionResult> {
  const me = syncUser();
  if (!me) return { ok: false, error: "unauthorized" };
  const resp: any = await emitAuthed("e2e:disable", {});
  if (!resp?.ok) return { ok: false, error: resp?.error || "network" };
  if (state.userId === me) {
    state.serverPublicKey = "";
    setStatus("disabled");
  }
  return { ok: true };
}

/** Включить снова тот же ключ — без пароля: копия для него на сервере уже есть. */
export async function enableE2eAgain(): Promise<ActionResult> {
  const me = syncUser();
  const own = me ? await loadOwnKey(me) : null;
  if (!me || !own) return { ok: false, error: "no_local_key" };
  const publicKey = toBase64(own.publicKey);
  const resp: any = await emitAuthed("e2e:enable", { publicKey });
  if (!resp?.ok) return { ok: false, error: resp?.error || "network" };
  if (state.userId === me) {
    state.serverPublicKey = publicKey;
    setStatus("ready");
  }
  return { ok: true };
}

/** Собеседник включил/отключил/сменил шифрование (e2e:key_changed). */
export function onPeerE2eUpdated(cb: (peerId: string) => void): () => void {
  peerE2eSubs.add(cb);
  return () => peerE2eSubs.delete(cb);
}

/**
 * Пароль забыт: новый ключ и новая копия. Старые зашифрованные сообщения у этого
 * пользователя больше не прочитать (у собеседников они остаются читаемыми).
 */
export async function resetE2e(password: string): Promise<ActionResult> {
  const me = syncUser();
  if (!me) return { ok: false, error: "unauthorized" };
  const pair = generateKeyPair();
  try {
    await saveOwnKey(me, pair);
  } catch {
    return { ok: false, error: "secure_store" };
  }
  return publish(me, pair, password);
}

/* ---------- ключи собеседников ---------- */

async function loadPins(): Promise<Record<string, string>> {
  if (pins) return pins;
  try {
    const raw = await AsyncStorage.getItem(`${PINS_KEY}:${state.userId}`);
    pins = raw ? JSON.parse(raw) : {};
  } catch {
    pins = {};
  }
  return pins!;
}

/** Первый увиденный ключ собеседника запоминаем; смену сообщаем подписчикам. */
async function notePeerKey(peerId: string, pk: string): Promise<void> {
  if (!pk) return;
  const table = await loadPins();
  const prev = table[peerId];
  if (prev === pk) return;
  table[peerId] = pk;
  try {
    await AsyncStorage.setItem(`${PINS_KEY}:${state.userId}`, JSON.stringify(table));
  } catch {}
  if (prev) {
    for (const cb of keyChangeSubs) {
      try {
        cb(peerId);
      } catch {}
    }
  }
}

/** Ключ собеседника или null, если он ещё не включил шифрование. Бросает при сбое сети. */
export async function getPeerPublicKey(peerId: string, opts?: { force?: boolean }): Promise<string | null> {
  syncUser();
  const cached = peerKeys.get(peerId);
  const ttl = cached?.pk ? PEER_KEY_TTL_MS : PEER_NO_KEY_TTL_MS;
  if (cached && !opts?.force && Date.now() - cached.at < ttl) return cached.pk || null;
  const resp: any = await emitAuthed("e2e:keys", { userIds: [peerId] });
  if (!resp?.ok) throw new E2eUnavailableError("unavailable");
  const pk = String(resp.keys?.[peerId] || "");
  peerKeys.set(peerId, { pk, at: Date.now() });
  await notePeerKey(peerId, pk);
  return pk || null;
}

socket.on("e2e:key_changed", (data: { userId?: string }) => {
  const peerId = String(data?.userId || "");
  if (!peerId) return;
  peerKeys.delete(peerId);
  for (const cb of peerE2eSubs) {
    try {
      cb(peerId);
    } catch {}
  }
});

/* ---------- шифрование на границе сети ---------- */

/**
 * Зашифровать текст для отправки. null — отправлять как обычно (у меня или у
 * собеседника шифрование не включено). Бросает E2eUnavailableError, когда
 * шифрование включено, но сейчас невозможно — такое сообщение ждёт в очереди.
 */
export async function sealOutgoingText(args: {
  id: string;
  to: string;
  text: string;
  replyText?: string;
}): Promise<E2eEnvelope | null> {
  const me = syncUser();
  if (!me) return null;
  // Без связи (или сразу после неудачной сверки) не ждём таймаутов на каждом сообщении.
  if (state.status === "unknown" && socket.connected && Date.now() - stateFailedAt > STATE_RETRY_MS) {
    await refreshE2eState().catch(() => {});
  }
  if (state.status === "unknown") {
    // Шифрование на этом устройстве включали — открытым текстом не рискуем, ждём сверки.
    if (await loadOwnKey(me)) throw new E2eUnavailableError("unavailable");
    // Ключа здесь не было никогда, а сервер не ответил (нет связи или бэкенд без E2E):
    // ведём себя как до шифрования, иначе чат встал бы целиком.
    return null;
  }
  if (state.status === "needs_restore") throw new E2eUnavailableError("locked");
  if (state.status !== "ready") return null;
  const own = await loadOwnKey(me);
  if (!own) throw new E2eUnavailableError("locked");
  const cachedPeer = peerKeys.get(args.to);
  if (!socket.connected && !cachedPeer) throw new E2eUnavailableError("unavailable");
  let peer: string | null;
  try {
    peer = await getPeerPublicKey(args.to);
  } catch {
    throw new E2eUnavailableError("unavailable");
  }
  const peerKey = peer ? fromBase64(peer) : null;
  if (!peerKey || peerKey.length !== 32) return null;
  return sealMessage(
    { id: args.id, from: me, to: args.to, text: args.text, ...(args.replyText != null ? { replyText: args.replyText } : {}) },
    own,
    peerKey,
  );
}

/** Сервер отверг конверт из-за устаревшего ключа — перечитать ключи перед повтором. */
export async function invalidateKeysAfterMismatch(peerId: string): Promise<void> {
  peerKeys.delete(peerId);
  await refreshE2eState().catch(() => {});
}

export type DecryptedFields = { text: string; replyText?: string } | { undecryptable: true };

/**
 * Расшифровать конверт сообщения (сверяет id/from/to). Ключ собеседника отсюда не
 * запоминаем: старые сообщения законно зашифрованы его прежним ключом.
 */
export async function openIncomingEnvelope(msg: {
  id?: unknown;
  from?: unknown;
  to?: unknown;
  enc?: unknown;
}): Promise<DecryptedFields> {
  const me = syncUser();
  const own = me ? await loadOwnKey(me) : null;
  if (!me || !own) return { undecryptable: true };
  const from = String(msg.from || "");
  const to = String(msg.to || "");
  const r = openMessage(msg.enc, own, { id: String(msg.id || ""), from, to, me });
  if (!r.ok) return { undecryptable: true };
  return { text: r.body.text, ...(r.body.replyText != null ? { replyText: r.body.replyText } : {}) };
}

type OutgoingTextPayload = {
  to: string;
  type: string;
  text?: string;
  replyTo?: { id: string; text?: string; from: string };
  clientMessageId?: string;
};

/**
 * Payload для сети: зашифрованный текст вместо открытого, цитата — только внутри
 * конверта. В очереди на отправку хранится открытый payload, а шифруем при каждой
 * попытке: иначе после смены ключа собеседника сообщение застряло бы навсегда.
 */
export async function toWireMessagePayload<T extends OutgoingTextPayload>(
  payload: T,
): Promise<Omit<T, "text"> & { text?: string; enc?: E2eEnvelope }> {
  if (payload.type !== "text" || typeof payload.text !== "string" || !payload.clientMessageId) return payload;
  const enc = await sealOutgoingText({
    id: payload.clientMessageId,
    to: payload.to,
    text: payload.text,
    ...(payload.replyTo?.text != null ? { replyText: String(payload.replyTo.text) } : {}),
  });
  if (!enc) return payload;
  const { text: _plain, replyTo, ...rest } = payload;
  // replyTo без текста совместим с полем исходного типа (text там необязателен).
  return {
    ...rest,
    ...(replyTo ? { replyTo: { id: replyTo.id, from: replyTo.from } } : {}),
    enc,
  } as unknown as Omit<T, "text"> & { enc: E2eEnvelope };
}

/**
 * Входящее сообщение с конвертом → обычный вид для приложения. Не расшифровалось
 * (ключ не восстановлен, сброшен или конверт подделан) — заглушка с флагом
 * e2eUndecryptable: после восстановления ключа серверная версия её заменит.
 */
export async function decryptIncomingMessage<M extends Record<string, any>>(
  msg: M,
  undecryptableText: () => string,
): Promise<M> {
  if (!msg || msg.enc == null) return msg;
  const { enc: _enc, ...rest } = msg;
  const r = await openIncomingEnvelope(msg);
  if ("undecryptable" in r) {
    return { ...rest, text: undecryptableText(), e2eUndecryptable: true } as unknown as M;
  }
  const replyTo = rest.replyTo && rest.replyTo.id ? { ...rest.replyTo, text: r.replyText } : rest.replyTo;
  return { ...rest, text: r.text, ...(replyTo ? { replyTo } : {}), e2e: true } as unknown as M;
}

/** Payload правки для сети. Без `to` (старые записи очереди) шифровать не для кого. */
export async function toWireEditPayload(
  messageId: string,
  text: string,
  to?: string,
): Promise<{ messageId: string; text: string } | { messageId: string; enc: E2eEnvelope }> {
  if (!to) return { messageId, text };
  const enc = await sealOutgoingText({ id: messageId, to, text });
  return enc ? { messageId, enc } : { messageId, text };
}

const SETUP_PROMPT_SEEN_KEY = "e2e_setup_prompt_seen_v1";

/** Предложение включить шифрование показываем в чате один раз на аккаунт — дальше оно в меню чата. */
export async function wasE2eSetupPromptSeen(): Promise<boolean> {
  const me = syncUser();
  if (!me) return true;
  try {
    return (await AsyncStorage.getItem(`${SETUP_PROMPT_SEEN_KEY}:${me}`)) === "1";
  } catch {
    return true;
  }
}

export async function markE2eSetupPromptSeen(): Promise<void> {
  const me = syncUser();
  if (!me) return;
  try {
    await AsyncStorage.setItem(`${SETUP_PROMPT_SEEN_KEY}:${me}`, "1");
  } catch {}
}

/* ---------- звонки ---------- */

/**
 * Объявление для call:initiate / call:accept: «умею шифровать звонок, мой ключ такой».
 * Только когда свой ключ сверен с сервером — иначе сервер не включит шифрование,
 * и звонок пройдёт как обычный у обеих сторон.
 */
export function getCallE2eeDeclaration(): { pk: string } | undefined {
  syncUser();
  if (state.status !== "ready" || !state.own) return undefined;
  return { pk: toBase64(state.own.publicKey) };
}

/** Ключ шифрования кадров для принятого звонка (см. deriveCallFrameKey). */
export async function deriveCallKey(peerPublicKey: string, callId: string): Promise<Uint8Array | null> {
  const me = syncUser();
  const own = me ? await loadOwnKey(me) : null;
  const peer = fromBase64(peerPublicKey);
  if (!own || !peer) return null;
  return deriveCallFrameKey(own, peer, callId);
}

/**
 * То же, но если после холодного старта (приняли звонок из пуша) сверки ещё не было —
 * ждём её недолго: дольше нельзя, это задерживает соединение звонка.
 */
export async function getCallE2eeDeclarationSoon(maxWaitMs = 1200): Promise<{ pk: string } | undefined> {
  syncUser();
  if (state.status === "unknown" && socket.connected) {
    await Promise.race([
      refreshE2eState().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
    ]);
  }
  return getCallE2eeDeclaration();
}
