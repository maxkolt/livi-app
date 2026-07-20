import { shared } from "./shared";
import type { SocketReauthResponse } from "./types";
import { REAUTH_FRESH_MS } from "./reauthConstants";
import { applyMissedFromReauth } from "./missedCalls";
import { emitAck } from "./emit";

/** Один reauth за раз на всех вызывающих (connect, boot, friends:fetch, …). */
export async function emitReauthDeduped(
  userId: string,
  timeoutMs = 6000,
  retries = 1,
): Promise<SocketReauthResponse> {
  const uid = String(userId || "").trim();
  if (!uid) return { ok: false, error: "no_userId" };
  if (shared.reauthInFlight) return shared.reauthInFlight;

  const p = (async (): Promise<SocketReauthResponse> => {
    try {
      const res = await emitAck<SocketReauthResponse>("reauth", { userId: uid }, timeoutMs, retries);
      if (res?.ok) {
        shared.lastSuccessfulReauthAt = Date.now();
        if (res?.missed?.length) applyMissedFromReauth(res).catch(() => {});
      }
      return res && typeof res.ok === "boolean" ? res : { ok: false, error: "bad_response" };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e || "reauth_failed") };
    } finally {
      shared.reauthInFlight = null;
    }
  })();

  shared.reauthInFlight = p;
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

// После разрыва Manager шлёт `reconnect`, а namespace socket всегда шлёт `connect` — reauth делаем только в обработчике `connect` (через emitReauthDeduped), иначе двойной emit.
export async function ensureReauthBeforePrivilegedSocketOp(): Promise<boolean> {
  const uid = String(shared.currentUserId || "").trim();
  if (!uid) return false;
  const now = Date.now();
  if (now - shared.lastSuccessfulReauthAt < REAUTH_FRESH_MS) return true;
  const res = await emitReauthDeduped(uid);
  return !!res.ok;
}
