import { getInstallId } from "../../utils/installId";
import { logger } from "../../utils/logger";
import { API_BASE, CALL_SIGNALING_CONNECT_MS, isOid } from "./constants";
import { emitAck, ensureSocketConnected, warmCallSignaling } from "./emit";
import { shared } from "./shared";
import { socket } from "./socketCore";

export type DirectCallMedia = "audio" | "video";

export function startCall(toUserId: string, options?: { media?: DirectCallMedia }) {
  const raw = String(toUserId || "").trim();
  if (!isOid(raw)) return Promise.reject(new Error("invalid ObjectId"));
  const to = /^[a-f\d]{24}$/i.test(raw) ? raw.toLowerCase() : raw;
  const media = options?.media === "audio" ? "audio" : undefined;
  const payload: { to: string; media?: DirectCallMedia } = { to };
  if (media) payload.media = media;

  const viaSocket = () =>
    emitAck<{ ok: boolean; callId?: string; error?: string }>(
      "call:initiate",
      payload,
      20000,
    );

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (installId) headers["x-install-id"] = String(installId);
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(`${API_BASE}/api/calls/initiate`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(async () => {
          const txt = await res.text().catch(() => "");
          return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ""}` };
        });
        return {
          ok: false,
          error: body?.error || `http_${res.status}`,
        };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    if (!socket.connected || shared.reconnecting) {
      logger.info("[call:initiate] socket unavailable, using HTTP fallback", {
        connected: socket.connected,
        reconnecting: shared.reconnecting,
      });
      return viaHttp();
    }

    try {
      const socketResp = await viaSocket();
      if (socketResp?.ok === true) return socketResp;
      return socketResp;
    } catch (e: any) {
      logger.warn("[call:initiate] socket initiate failed, trying HTTP fallback", {
        error: e?.message || String(e),
        connected: socket.connected,
        reconnecting: shared.reconnecting,
      });
      return viaHttp();
    }
  })();
}

export function cancelCall(callId: string) {
  socket.emit("call:cancel", { callId });
}

/** Снять залипший direct-call на сервере (initiator_busy / busy при новом звонке тому же другу). */
export function forceEndDirectCallWithPeer(peerUserId: string, callId?: string | null): void {
  const peer = String(peerUserId || "").trim().toLowerCase();
  const me = String(shared.currentUserId || "").trim().toLowerCase();
  if (!peer || !me || !/^[a-f\d]{24}$/i.test(peer) || !/^[a-f\d]{24}$/i.test(me)) return;
  const sorted = [me, peer].sort();
  const roomId = `room_${sorted[0]}_${sorted[1]}`;
  const cid = callId != null ? String(callId).trim() : "";
  const payload: { callId?: string; roomId?: string } = { roomId };
  if (cid) payload.callId = cid;
  try {
    socket.emit("call:end", payload);
    logger.info("[socket] forceEndDirectCallWithPeer", { roomId, callId: cid || undefined });
  } catch (e) {
    logger.warn("[socket] forceEndDirectCallWithPeer failed", e as Error);
  }
}

function markIncomingAcceptSent(callId: string): boolean {
  try {
    const g = global as any;
    g.__incomingAcceptSentRef = g.__incomingAcceptSentRef || { current: null as string | null };
    if (g.__incomingAcceptSentRef.current === callId) return false;
    g.__incomingAcceptSentRef.current = callId;
    return true;
  } catch {
    return true;
  }
}

function clearIncomingAcceptSent(callId: string): void {
  try {
    const g = global as any;
    if (g.__incomingAcceptSentRef?.current === callId) {
      g.__incomingAcceptSentRef.current = null;
    }
  } catch {}
}

/** Cold-start: accept может стартовать до boot() → currentUserId ещё пуст. */
async function waitForCurrentUserId(ms = 8000): Promise<string | null> {
  const existing = String(shared.currentUserId || "").trim();
  if (existing) return existing;
  const { onCurrentUserId } = await import("./authState");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (uid: string | null) => {
      if (settled) return;
      settled = true;
      try {
        off();
      } catch {}
      clearTimeout(t);
      resolve(uid);
    };
    const t = setTimeout(() => {
      finish(String(shared.currentUserId || "").trim() || null);
    }, ms);
    const off = onCurrentUserId((id) => {
      const uid = String(id || "").trim();
      if (uid) finish(uid);
    });
  });
}

/**
 * call:accept с ожиданием connect + identity + reauth.
 * Без этого cold-start шлёт accept до bind userId → callee_socket_not_found.
 */
export async function emitCallAcceptAck(
  callId: string,
): Promise<{ ok: boolean; duplicate?: boolean; error?: string }> {
  const id = String(callId || "").trim();
  if (!id) return { ok: false, error: "missing_callId" };

  warmCallSignaling();
  await ensureSocketConnected(CALL_SIGNALING_CONNECT_MS);
  const uid = await waitForCurrentUserId(8000);
  if (!uid) {
    logger.warn("[socket] call:accept deferred — no currentUserId yet", { callId: id });
  }
  try {
    const { ensureReauthBeforePrivilegedSocketOp } = await import("./reauth");
    const reauthed = await ensureReauthBeforePrivilegedSocketOp();
    if (!reauthed && shared.reauthInFlight) {
      try {
        await shared.reauthInFlight;
      } catch {}
    } else if (!reauthed) {
      logger.warn("[socket] call:accept continuing without fresh reauth", { callId: id });
    }
  } catch (e: any) {
    logger.warn("[socket] call:accept reauth wait failed", {
      callId: id,
      error: e?.message || String(e),
    });
  }

  const resp = await emitAck<{ ok?: boolean; error?: string; duplicate?: boolean }>(
    "call:accept",
    { callId: id },
    7000,
    2,
  );
  return {
    ok: !!resp?.ok,
    duplicate: resp?.duplicate,
    error: resp?.error ? String(resp.error) : undefined,
  };
}

/**
 * Отправить call:accept до монтирования VideoCall (аудио / входящий) — инициатор раньше получает call:accepted.
 */
export function beginEarlyIncomingCallAccept(callId: string): void {
  const id = String(callId || "").trim();
  if (!id) return;
  if (shared.earlyIncomingCallAcceptById.has(id)) return;
  if (!markIncomingAcceptSent(id)) return;

  const work = (async () => {
    try {
      const result = await emitCallAcceptAck(id);
      if (!result.ok) {
        // Позволяем dedupe, чтобы VideoCallSession / повторный begin могли ретраить.
        clearIncomingAcceptSent(id);
        logger.warn("[socket] early call:accept ack not ok", {
          callId: id,
          error: result.error,
          duplicate: result.duplicate,
        });
      }
      return result;
    } catch (e: any) {
      clearIncomingAcceptSent(id);
      logger.warn("[socket] early call:accept failed, fallback emit", {
        callId: id,
        error: e?.message || String(e),
      });
      try {
        socket.emit("call:accept", { callId: id });
      } catch {}
      // Оптимистично: emit мог дойти; VideoCallSession всё равно дождётся call:accepted / recover.
      return { ok: true };
    }
  })();
  shared.earlyIncomingCallAcceptById.set(id, work);
  void work.finally(() => {
    setTimeout(() => {
      if (shared.earlyIncomingCallAcceptById.get(id) === work) {
        shared.earlyIncomingCallAcceptById.delete(id);
      }
    }, 60_000);
  });
}

export function hasEarlyIncomingCallAccept(callId: string): boolean {
  return shared.earlyIncomingCallAcceptById.has(String(callId || "").trim());
}

export async function awaitEarlyIncomingCallAccept(
  callId: string,
): Promise<{ ok: boolean; duplicate?: boolean; error?: string } | null> {
  const id = String(callId || "").trim();
  const p = shared.earlyIncomingCallAcceptById.get(id);
  if (!p) return null;
  try {
    return await p;
  } catch {
    return { ok: false, error: "early_accept_rejected" };
  }
}

export function acceptCall(callId: string) {
  const id = String(callId || "").trim();
  if (!id) return;
  beginEarlyIncomingCallAccept(id);
}

export function declineCall(callId: string) {
  socket.emit("call:decline", { callId });
}

/** Запросить payload call:accepted у сервера (после FCM call_accepted, когда приложение вывели на передний план). */
export function requestCallAccepted(callId: string) {
  socket.emit("call:getAccepted", { callId });
}

/**
 * Повторно запросить call:accepted, пока нет токена / LiveKit ещё не connected.
 * Нужен, когда сокет/FCM доставили accept с задержкой — один emit часто не успевает.
 */
export function requestCallAcceptedWithRetry(
  callId: string,
  opts?: { delaysMs?: number[]; reason?: string },
): void {
  const id = String(callId || "").trim();
  if (!id) return;
  const delays = opts?.delaysMs ?? [0, 350, 900, 1800, 3200];
  const reason = opts?.reason || "retry";
  delays.forEach((ms, attempt) => {
    setTimeout(() => {
      try {
        const g = global as any;
        const pending = g.__pendingCallAcceptedRef?.current;
        const pendingCallId = pending ? String(pending?.callId || "").trim() : "";
        const pendingHasToken = pendingCallId === id && !!(pending as any)?.livekitToken;
        const sess = g.__webrtcSessionRef?.current;
        const sessCallId =
          sess && typeof sess.getCallId === "function"
            ? String(sess.getCallId() || "").trim()
            : "";
        const roomState = sess?.room?.state as string | undefined;
        const liveKitReady =
          sessCallId === id &&
          (roomState === "connected" || roomState === "connecting" || roomState === "reconnecting");
        if (liveKitReady) {
          if (attempt === 0) {
            logger.debug("[call:getAccepted] retry skipped — LiveKit already active", {
              callId: id,
              reason,
              roomState,
            });
          }
          return;
        }
        if (pendingHasToken && !liveKitReady) {
          return;
        }
        logger.info("[call:getAccepted] emit", {
          callId: id,
          reason,
          attempt: attempt + 1,
          delayMs: ms,
        });
        socket.emit("call:getAccepted", { callId: id });
      } catch (e) {
        logger.warn("[call:getAccepted] retry emit failed", {
          callId: id,
          reason,
          error: (e as Error)?.message || String(e),
        });
      }
    }, ms);
  });
}

export function onCallIncoming(cb: (d: { callId: string; callKitId?: string; from: string; fromNick?: string; ts?: number | string; expiresAt?: number | string }) => void): () => void {
  const h = (d: any) => {
    logger.debug("Socket received call:incoming", { callId: d.callId, from: d.from, fromNick: d.fromNick });
    cb(d);
  };
  socket.on("call:incoming", h);
  return () => socket.off("call:incoming", h);
}

/** Получатель сообщает серверу, что входящий экран реально показан (метрика доставки). */
export function reportIncomingCallShown(callId: string): void {
  const id = String(callId || "").trim();
  if (!id) return;
  const connected = socket.connected;
  const sid = connected ? socket.id : null;
  try {
    logger.info("[call:incoming_shown] socket emit", { callId: id, connected, socketId: sid });
    socket.emit("call:incoming_shown", { callId: id });
  } catch (e) {
    logger.warn("[call:incoming_shown] socket emit failed", { callId: id, connected, err: String(e) });
  }
}

export function onCallAccepted(cb: (d: { callId: string; from: string }) => void): () => void {
  const h = (d: any) => {
    logger.debug("Socket received call:accepted", { callId: d.callId, from: d.from });
    cb(d);
  };
  socket.on("call:accepted", h);
  return () => socket.off("call:accepted", h);
}

export function onCallDeclined(cb: (d: { callId: string; from: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on("call:declined", h);
  return () => socket.off("call:declined", h);
}

// Отдельное событие для явной отмены звонком инициатора (дублирует call:declined на сервере, но даём отдельный listener для явности)
export function onCallCanceled(cb: (d: { callId: string; from: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on("call:cancel", h);
  return () => socket.off("call:cancel", h);
}

export function onCallTimeout(cb: (d: { callId: string; from?: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on("call:timeout", h);
  return () => socket.off("call:timeout", h);
}

export function onCallRoomFull(cb: (d: { userId?: string }) => void): () => void {
  const h = (d: any) => cb(d || {});
  socket.on("call:room_full", h);
  return () => socket.off("call:room_full", h);
}

// Обработчики для системы бэйджа "Занято"
export function onRandomBusy(cb: (data: { userId: string; busy: boolean }) => void): () => void {
  const h = (data: any) => cb(data);
  socket.on("random:busy", h);
  return () => socket.off("random:busy", h);
}

export function onFriendsRoomState(cb: (data: { roomId: string; participants: string[] }) => void): () => void {
  const h = (data: any) => cb(data);
  socket.on("friends:room_state", h);
  return () => socket.off("friends:room_state", h);
}
