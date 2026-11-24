import { getInstallSecret } from '../../utils/installId';
import { shared } from "./shared";
import type { SocketReauthResponse } from "./types";
import { REAUTH_FRESH_MS } from "./reauthConstants";
import { applyMissedFromReauth } from "./missedCalls";
import { emitAck, ensureSocketConnected } from "./emit";
import { socket } from "./socketCore";

let reauthSocketId: string | undefined;
let reauthUserId: string | undefined;

/** Один reauth за раз на всех вызывающих (connect, boot, friends:fetch, …). */
export async function emitReauthDeduped(
  userId: string,
  timeoutMs = 6000,
  retries = 1,
): Promise<SocketReauthResponse> {
  const uid = String(userId || "").trim();
  if (!uid) return { ok: false, error: "no_userId" };
  const socketId = socket.id;
  if (shared.reauthInFlight && reauthSocketId === socketId && reauthUserId === uid) return shared.reauthInFlight;

  let p!: Promise<SocketReauthResponse>;
  p = (async (): Promise<SocketReauthResponse> => {
    try {
      const installSecret = await getInstallSecret();
      if (socket.id !== socketId) return { ok: false, error: "connection_changed" };
      const res = await emitAck<SocketReauthResponse>("reauth", { userId: uid, installSecret }, timeoutMs, retries);
      if (!socket.connected || socket.id !== socketId || shared.currentUserId !== uid) return { ok: false, error: "connection_changed" };
      if (res?.ok) {
        shared.lastSuccessfulReauthAt = Date.now();
        shared.lastSuccessfulReauthSocketId = socketId;
        shared.lastSuccessfulReauthUserId = uid;
        // Also drain native history after identity becomes available, even without server backlog.
        applyMissedFromReauth(res).catch(() => {});
      } else {
        shared.lastSuccessfulReauthAt = 0;
      }
      return res && typeof res.ok === "boolean" ? res : { ok: false, error: "bad_response" };
    } catch (e: unknown) {
      if (socket.id === socketId) shared.lastSuccessfulReauthAt = 0;
      return { ok: false, error: String((e as { message?: string } | null)?.message || e || "reauth_failed") };
    } finally {
      if (shared.reauthInFlight === p) shared.reauthInFlight = null;
    }
  })();

  shared.reauthInFlight = p;
  reauthSocketId = socketId;
  reauthUserId = uid;
  return p;
}

/** Reauth failed: restore install mapping or recreate user (handles race with in-flight createUser). */
export async function recoverFromReauthFailure(error?: string): Promise<void> {
  const err = String(error || "");
  if (err !== "user_not_found" && err !== "not_found") return;

  const identity = await import("./identity");

  if (err === "not_found" && identity.isCreateUserInProgress()) {
    try {
      await identity.waitForCreateUserCompletion();
    } catch {}
    const uid = identity.getCurrentUserId();
    if (uid) {
      const retry = await emitReauthDeduped(uid);
      if (retry?.ok) return;
    }
  }

  if (err === "not_found") {
    const mapped = await identity.refreshUserIdFromInstall();
    if (mapped) {
      const retry = await emitReauthDeduped(mapped);
      if (retry?.ok) return;
    }
  }

  identity.clearCurrentUserId();
  await identity.createUser();
}

/** Server ownership binding lives until this socket connection/user changes. */
export function hasPrivilegedSocketOwnershipProof(): boolean {
  const uid = String(shared.currentUserId || "").trim();
  return !!uid && socket.connected && !!socket.id && shared.lastSuccessfulReauthAt > 0 &&
    shared.lastSuccessfulReauthSocketId === socket.id && shared.lastSuccessfulReauthUserId === uid;
}

/** Other privileged operations keep their existing short-lived freshness policy. */
export function hasFreshPrivilegedSocketProof(): boolean {
  const age = Date.now() - shared.lastSuccessfulReauthAt;
  return hasPrivilegedSocketOwnershipProof() && age >= 0 && age < REAUTH_FRESH_MS;
}

// После разрыва Manager шлёт `reconnect`, а namespace socket всегда шлёт `connect` — reauth делаем только в обработчике `connect` (через emitReauthDeduped), иначе двойной emit.
export async function ensureReauthBeforePrivilegedSocketOp(force = false): Promise<boolean> {
  const uid = String(shared.currentUserId || "").trim();
  if (!uid) return false;
  if (!socket.connected) await ensureSocketConnected();
  if (!socket.connected) return false;
  if (!force && hasFreshPrivilegedSocketProof()) return true;
  const res = await emitReauthDeduped(uid);
  return !!res.ok && socket.connected && !!socket.id && shared.lastSuccessfulReauthSocketId === socket.id &&
    shared.lastSuccessfulReauthUserId === shared.currentUserId;
}
