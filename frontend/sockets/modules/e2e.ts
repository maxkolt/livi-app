/**
 * Сквозное шифрование чата: ключи и шифрование на границе сети.
 *
 * Включается само, без пароля: ключ создаётся на устройстве и публикуется при первой
 * сверке с сервером. Переустановку переживает через системное хранилище — Android
 * Block Store (LiviKeyVault), на iOS Keychain (SecureStore) переживает её и так.
 *
 * Состояния своего ключа:
 *   unknown       — ещё не сверялись с сервером
 *   needs_setup   — ключ не удалось опубликовать (нет связи, старый сервер): сообщения
 *                   идут как раньше, пробуем снова при следующей сверке
 *   needs_restore — ключ включали по паролю (прежняя схема), а на устройстве его нет:
 *                   старую переписку вернёт только пароль копии
 *   ready         — ключ на устройстве совпадает с опубликованным
 *   disabled      — пользователь отключил шифрование: ключ снят с публикации;
 *                   новые сообщения обычные, старые читаются (если ключ здесь)
 *
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
const CHAT_NOTICE_SEEN_KEY = "e2e_chat_notice_seen_v1";
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
  for (const cb of [...statusSubs]) {
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

/**
 * Хранилище ключа, переживающее переустановку: Android Block Store. На iOS модуля нет —
 * там Keychain (SecureStore) сам переживает переустановку.
 */
type KeyVault = {
  save(key: string, valueB64: string): Promise<boolean>;
  /** null — ключа нет; reject — временный сбой (не путать с «нет»). */
  load(key: string): Promise<string | null>;
  remove(key: string): Promise<boolean>;
};
const keyVault = (NativeModules as any)?.LiviKeyVault as KeyVault | undefined;
/** Последнее чтение хранилища сорвалось: ключ мог там быть, новый создавать нельзя. */
let vaultReadFailed = false;
/** Для кого копия в хранилище уже сверена в этом запуске. */
let vaultSyncedFor: string | null = null;

async function vaultSave(key: string, valueB64: string): Promise<void> {
  try {
    await keyVault?.save(key, valueB64);
  } catch {}
}

async function loadOwnKey(me: string): Promise<E2eKeyPair | null> {
  if (state.own) return state.own;
  vaultReadFailed = false;
  try {
    let raw = await SecureStore.getItemAsync(SECRET_KEY_PREFIX + me);
    if (!raw && keyVault) {
      // Переустановка на Android: SecureStore пуст, ключ ждёт в Block Store.
      try {
        raw = await keyVault.load(SECRET_KEY_PREFIX + me);
      } catch {
        vaultReadFailed = true;
      }
      if (raw) {
        await SecureStore.setItemAsync(SECRET_KEY_PREFIX + me, raw).catch(() => {});
        vaultSyncedFor = me;
      }
    }
    const sk = raw ? fromBase64(raw) : null;
    if (sk && sk.length === 32 && state.userId === me) state.own = keyPairFromSecretKey(sk);
  } catch {}
  return state.own;
}

async function saveOwnKey(me: string, pair: E2eKeyPair): Promise<void> {
  // Сначала на устройство, потом на сервер: опубликованный ключ без локальной копии — потеря переписки.
  const b64 = toBase64(pair.secretKey);
  await SecureStore.setItemAsync(SECRET_KEY_PREFIX + me, b64);
  if (state.userId === me) state.own = pair;
  await vaultSave(SECRET_KEY_PREFIX + me, b64);
  vaultSyncedFor = me;
}

/** Ключ включали до хранилища (или по паролю): кладём копию туда один раз за запуск. */
function ensureVaultCopy(me: string, own: E2eKeyPair): void {
  if (!keyVault || vaultSyncedFor === me) return;
  vaultSyncedFor = me;
  void vaultSave(SECRET_KEY_PREFIX + me, toBase64(own.secretKey));
}

/** Удаление профиля: ключ и запомненные ключи собеседников этого аккаунта больше не нужны. */
export async function deleteLocalE2eKey(userId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SECRET_KEY_PREFIX + userId);
  } catch {}
  try {
    await keyVault?.remove(SECRET_KEY_PREFIX + userId);
  } catch {}
  if (vaultSyncedFor === userId) vaultSyncedFor = null;
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
    // Отключил сам. Сервер до автошифрования флага не шлёт: там признак — ключ снят, копия есть.
    const disabled =
      resp.disabled === true || (!state.serverPublicKey && !!state.backupKdf && !!state.backupPk);
    if (disabled) {
      // Шифрование всегда включено (кнопки «Отключить» больше нет). Кто отключал его
      // раньше — включаем обратно тем же ключом: с устройства или из хранилища. Ключа
      // нет, а есть копия под паролем прежней схемы — сперва вернуть её паролем, иначе
      // новый ключ сделает старую переписку нечитаемой.
      if (own) await autoEnable(me, own);
      else if (vaultReadFailed) setStatus("needs_setup");
      else if (state.backupKdf && state.backupPk) setStatus("needs_restore");
      else await autoEnable(me, null);
    } else if (own && state.serverPublicKey === toBase64(own.publicKey)) {
      setStatus("ready");
      ensureVaultCopy(me, own);
    }
    // Ключ включали по паролю (прежняя схема), а здесь его нет: переписку вернёт только пароль.
    else if (state.serverPublicKey && state.backupKdf && state.backupPk === state.serverPublicKey) {
      setStatus("needs_restore");
    }
    // Хранилище не ответило, а ключ на сервере есть: он мог лежать там — новый не создаём,
    // иначе старая переписка станет нечитаемой. Повторим при следующей сверке.
    else if (!own && vaultReadFailed && state.serverPublicKey) setStatus("needs_setup");
    else await autoEnable(me, own);
    return state.status;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Шифрование включается само: свой ключ (с этого устройства или из хранилища после
 * переустановки) либо новый. Не удалось опубликовать (нет связи или старый сервер,
 * требующий копию под паролем) — остаёмся без шифрования до следующей сверки.
 */
async function autoEnable(me: string, own: E2eKeyPair | null): Promise<void> {
  const pair = own ?? generateKeyPair();
  if (!own) {
    try {
      await saveOwnKey(me, pair);
    } catch {
      if (state.userId === me) setStatus("needs_setup");
      return;
    }
  }
  const r = await publishDeviceKey(me, pair);
  if (!r.ok && state.userId === me) setStatus("needs_setup");
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

/** Публикация ключа без копии под паролем: переустановку он переживёт через хранилище. */
async function publishDeviceKey(me: string, pair: E2eKeyPair): Promise<ActionResult> {
  const publicKey = toBase64(pair.publicKey);
  const resp: any = await emitAuthed("e2e:publish", { publicKey });
  logger.info("[e2e] publish device key", {
    ok: !!resp?.ok,
    error: resp?.error ?? (resp ? null : "no_ack"),
    vault: !!keyVault,
  });
  if (!resp?.ok) return { ok: false, error: resp?.error || "network" };
  if (state.userId === me) {
    state.serverPublicKey = publicKey;
    setStatus("ready");
  }
  return { ok: true };
}

/** Публикация ключа вместе с новой копией под паролем — только смена пароля старой схемы. */
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

/** Есть копия под паролем для текущего ключа (включали по паролю) — можно сменить пароль. */
export function hasPasswordBackup(): boolean {
  syncUser();
  return !!state.backupKdf && !!state.backupPk && state.backupPk === state.serverPublicKey;
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

/**
 * Включить снова — без пароля: тот же ключ, а если его здесь нет (переустановка с
 * отключённым шифрованием) — новый.
 */
export async function enableE2eAgain(): Promise<ActionResult> {
  const me = syncUser();
  if (!me) return { ok: false, error: "unauthorized" };
  const own = await loadOwnKey(me);
  const pair = own ?? generateKeyPair();
  if (!own) {
    try {
      await saveOwnKey(me, pair);
    } catch {
      return { ok: false, error: "secure_store" };
    }
  }
  return publishDeviceKey(me, pair);
}

/** Собеседник включил/отключил/сменил шифрование (e2e:key_changed). */
export function onPeerE2eUpdated(cb: (peerId: string) => void): () => void {
  peerE2eSubs.add(cb);
  return () => peerE2eSubs.delete(cb);
}

/**
 * Пароль прежней схемы забыт: новый ключ, уже без пароля. Старые зашифрованные сообщения
 * у этого пользователя больше не прочитать (у собеседников они остаются читаемыми).
 */
export async function resetE2e(): Promise<ActionResult> {
  const me = syncUser();
  if (!me) return { ok: false, error: "unauthorized" };
  const pair = generateKeyPair();
  try {
    await saveOwnKey(me, pair);
  } catch {
    return { ok: false, error: "secure_store" };
  }
  return publishDeviceKey(me, pair);
}

/* ---------- уведомление «чат защищён» ---------- */

/** Показываем один раз на собеседника — при первом входе в пустой зашифрованный чат. */
export async function wasE2eChatNoticeSeen(peerId: string): Promise<boolean> {
  const me = syncUser();
  const pid = String(peerId || "").trim();
  if (!me || !pid) return true;
  try {
    return (await AsyncStorage.getItem(`${CHAT_NOTICE_SEEN_KEY}:${me}:${pid}`)) === "1";
  } catch {
    return true;
  }
}

export async function markE2eChatNoticeSeen(peerId: string): Promise<void> {
  const me = syncUser();
  const pid = String(peerId || "").trim();
  if (!me || !pid) return;
  try {
    await AsyncStorage.setItem(`${CHAT_NOTICE_SEEN_KEY}:${me}:${pid}`, "1");
  } catch {}
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
    for (const cb of [...keyChangeSubs]) {
      try {
        cb(peerId);
      } catch {}
    }
  }
}

/** Ключ собеседника или null, если он ещё не включил шифрование. Бросает при сбое сети. */
/** Ключ собеседника, если он уже известен в этой сессии (для первого кадра экрана); иначе undefined. */
export function peekPeerPublicKey(peerId: string): string | null | undefined {
  const cached = peerKeys.get(peerId);
  if (!cached) return undefined;
  return cached.pk || null;
}

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
  for (const cb of [...peerE2eSubs]) {
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
