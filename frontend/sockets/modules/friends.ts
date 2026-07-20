import { getInstallId } from "../../utils/installId";
import { logger } from "../../utils/logger";
import { API_BASE, isOid } from "./constants";
import { emitAck } from "./emit";
import { ensureReauthBeforePrivilegedSocketOp } from "./reauth";
import { shared } from "./shared";
import { socket } from "./socketCore";

export type FriendListItem = {
  _id: string;
  nick?: string;
  avatar?: string;
  avatarVer?: number;
  avatarThumbB64?: string;
  online: boolean;
  isBusy?: boolean;
  isRandomBusy?: boolean;
  inCall?: boolean;
};

export function addFriend(toUserId: string) {
  if (!isOid(toUserId)) return Promise.reject(new Error("invalid ObjectId"));
  const viaSocket = async () => {
    if (socket.connected && shared.currentUserId) {
      const ok = await ensureReauthBeforePrivilegedSocketOp();
      if (!ok) throw new Error("reauth_before_friends_add_failed");
    }
    return emitAck<{ ok: boolean; status?: string; error?: string }>("friends:add", { to: toUserId });
  };

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (installId) headers["x-install-id"] = String(installId);
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

    const url = `${API_BASE}/api/friends/add`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ to: toUserId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ""}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}

export const inviteFriend = addFriend;
export const requestFriend = addFriend;

export function respondFriend(fromUserId: string, accept: boolean, requestId?: string) {
  if (!isOid(fromUserId)) return Promise.reject(new Error("invalid ObjectId"));
  const viaSocket = () =>
    emitAck<{ ok: boolean; status?: string; error?: string }>("friends:respond", {
      from: fromUserId,
      accept,
      requestId,
    });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (installId) headers["x-install-id"] = String(installId);
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

    const url = `${API_BASE}/api/friends/respond`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ from: fromUserId, accept }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ""}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}

export function acceptInvite(inviterId: string) {
  if (!isOid(inviterId)) return Promise.reject(new Error("invalid ObjectId"));
  const viaSocket = () =>
    emitAck<{ ok: boolean; status?: string; error?: string }>("friends:acceptInvite", { inviterId });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (installId) headers["x-install-id"] = String(installId);
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

    const url = `${API_BASE}/api/friends/acceptInvite`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ inviterId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ""}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}

export function fetchFriends(
  page: number = 1,
  limit: number = 50,
  options: { includeAvatarThumbs?: boolean } = {},
) {
  const includeAvatarThumbs = options.includeAvatarThumbs !== false;
  const viaSocket = async () => {
    // Защита от гонки: socket connected, но reauth на бэкенде ещё не успел завершиться.
    if (socket.connected && shared.currentUserId) {
      const ok = await ensureReauthBeforePrivilegedSocketOp();
      if (!ok) throw new Error("reauth_before_friends_fetch_failed");
    }
    return emitAck<{
      ok: boolean;
      list: FriendListItem[];
      pagination?: {
        page: number;
        limit: number;
        total: number;
        hasMore: boolean;
      };
      error?: string;
    }>("friends:fetch", { page, limit, includeAvatarThumbs });
  };

  // Fallback for networks/VPNs that break socket connectivity:
  // use REST endpoint that returns the same list shape.
  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (installId) headers["x-install-id"] = String(installId);
    // Legacy/audit-only header (server does NOT trust it, but may log mismatch).
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

    // "Fast but safe" strategy:
    // - first attempt: short timeout (good networks feel instant)
    // - second attempt: longer timeout (slow VPN still succeeds)
    const timeouts = [7000, 20000];
    let lastErr: any = null;
    const url = `${API_BASE}/api/friends?page=${encodeURIComponent(String(page))}&limit=${encodeURIComponent(String(limit))}&includeAvatarThumbs=${includeAvatarThumbs ? "1" : "0"}`;

    for (const ms of timeouts) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          return { ok: false, list: [], error: `http_${res.status}${txt ? `:${txt}` : ""}` };
        }
        return await res.json();
      } catch (e: any) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return { ok: false, list: [], error: lastErr?.message || String(lastErr || "network_error") };
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch (e) {
      return await viaHttp();
    }
  })();
}

export function onFriendAdded(
  cb: (d: { userId: string; userNick?: string }) => void,
): () => void {
  const h = (d: any) => cb(d);
  socket.on("friend_added", h);
  socket.on("friend:added", h);
  return () => {
    socket.off("friend_added", h);
    socket.off("friend:added", h);
  };
}

export function onFriendRequest(
  cb: (d: { from: string; requestId?: string; fromNick?: string }) => void,
): () => void {
  const h = (d: any) => cb(d);
  socket.on("friend_request", h);
  socket.on("friend:request", h);
  return () => {
    socket.off("friend_request", h);
    socket.off("friend:request", h);
  };
}

export function onFriendAccepted(cb: (d: { userId: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on("friend_accepted", h);
  socket.on("friend:accepted", h);
  return () => {
    socket.off("friend_accepted", h);
    socket.off("friend:accepted", h);
  };
}

export function onFriendDeclined(cb: (d: { userId: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on("friend_declined", h);
  socket.on("friend:declined", h);
  return () => {
    socket.off("friend_declined", h);
    socket.off("friend:declined", h);
  };
}

export function onFriendRemoved(cb: (p: { userId: string }) => void): () => void {
  const h = (d: any) => cb({ userId: String(d?.userId ?? d?.id ?? d) });
  socket.on("friend_removed", h);
  socket.on("friend:removed", h);
  return () => {
    socket.off("friend_removed", h);
    socket.off("friend:removed", h);
  };
}

export function removeFriend(peerId: string) {
  if (!isOid(peerId)) return Promise.reject(new Error("invalid ObjectId"));
  const viaSocket = () => emitAck<{ ok: boolean; error?: string }>("friends:remove", { peerId });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (installId) headers["x-install-id"] = String(installId);
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

    const url = `${API_BASE}/api/friends/remove`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ peerId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ""}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}

// Проверка реферальной ссылки
export async function checkInviteLink(code: string): Promise<{
  ok: boolean;
  inviter?: {
    id: string;
    nick: string;
    avatar: string;
    avatarVer: number;
    avatarThumbB64: string;
  };
  areFriends?: boolean;
  hasPendingRequest?: boolean;
  canAdd?: boolean;
  error?: string;
}> {
  try {
    if (!isOid(code)) {
      return { ok: false, error: "invalid_code" };
    }

    const userId = shared.currentUserId;
    const headers: Record<string, string> = {};
    // Prefer installId so backend can resolve user securely.
    try {
      const installId = await getInstallId();
      if (installId) headers["x-install-id"] = String(installId);
    } catch {}

    if (userId) {
      headers["x-user-id"] = userId;
    }

    const url = `${API_BASE}/api/invite/${code}`;
    logger.debug("Checking invite link:", { url, code, userId });

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error("Invite link check failed:", {
        status: response.status,
        statusText: response.statusText,
        url,
        responseText: text.substring(0, 200),
      });
      return { ok: false, error: `http_error_${response.status}` };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await response.text();
      logger.error("Invite link check returned non-JSON:", {
        contentType,
        url,
        responseText: text.substring(0, 200),
      });
      return { ok: false, error: "invalid_response_format" };
    }

    const data = await response.json();
    logger.debug("Invite link check success:", { code, hasInviter: !!data.inviter });
    return data;
  } catch (e: any) {
    logger.error("Failed to check invite link:", {
      error: e?.message || e,
      code,
      stack: e?.stack,
    });
    return { ok: false, error: e?.message || "network_error" };
  }
}

export function checkFriendship(userId: string) {
  if (!isOid(userId)) return Promise.reject(new Error("invalid ObjectId"));
  const viaSocket = () =>
    emitAck<{ ok: boolean; areFriends: boolean; error?: string }>("friends:check", { userId });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (installId) headers["x-install-id"] = String(installId);
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

    const timeouts = [5000, 12000];
    let lastErr: any = null;
    const url = `${API_BASE}/api/friends/check/${encodeURIComponent(String(userId))}`;

    for (const ms of timeouts) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          return { ok: false, areFriends: false, error: `http_${res.status}${txt ? `:${txt}` : ""}` };
        }
        return await res.json();
      } catch (e: any) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return { ok: false, areFriends: false, error: lastErr?.message || String(lastErr || "network_error") };
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch (e) {
      return await viaHttp();
    }
  })();
}
