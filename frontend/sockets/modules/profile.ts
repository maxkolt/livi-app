import { getInstallId } from "../../utils/installId";
import { logger } from "../../utils/logger";
import { API_BASE, isOid } from "./constants";
import { emitAck } from "./emit";
import { ensureReauthBeforePrivilegedSocketOp } from "./reauth";
import { shared } from "./shared";
import { socket } from "./socketCore";

export function getMyProfile() {
  // КРИТИЧНО: Добавляем таймаут 8 секунд для защиты от зависания MongoDB
  const viaSocket = () =>
    emitAck<{
      ok: boolean;
      profile?: {
        nick?: string;
        avatarUrl?: string;
        avatarB64?: string;
        avatarThumbB64?: string;
        avatarVer?: number;
      };
      error?: string;
    }>("profile:me", undefined, 8000);

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (installId) headers["x-install-id"] = String(installId);
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

    const timeouts = [5000, 12000];
    let lastErr: any = null;
    const url = `${API_BASE}/me`;

    for (const ms of timeouts) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ""}` };
        }
        const data = await res.json();
        if (data?.ok && data?.user) {
          return {
            ok: true,
            profile: {
              nick: data.user.nick || "",
              avatarUrl: data.user.avatar || "",
              avatarVer: data.user.avatarVer || 0,
            },
          };
        }
        return { ok: false, error: "invalid_response" };
      } catch (e: any) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return { ok: false, error: lastErr?.message || String(lastErr || "network_error") };
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}

export function updateProfile(patch: { nick?: string; avatar?: string }) {
  const clean: { nick?: string; avatar?: string } = {};
  const hasNick = typeof patch.nick === "string";
  if (hasNick) clean.nick = patch.nick;

  // ⚠️ КРИТИЧНО:
  // На сервере `avatar: ''` трактуется как УДАЛЕНИЕ аватара.
  // Поэтому:
  // - отправляем avatar='' ТОЛЬКО если это явная операция удаления (нет nick в patch)
  // - отправляем avatar только если это http(s) URL
  // - data:/file:/content:/ph: и т.п. НЕ отправляем
  if (typeof patch.avatar === "string") {
    const a = patch.avatar.trim();
    if (a === "") {
      if (!hasNick) clean.avatar = "";
    } else if (/^https?:\/\//i.test(a)) {
      clean.avatar = a;
    }
  }

  const viaSocket = async () => {
    if (shared.currentUserId && socket.connected) {
      const ok = await ensureReauthBeforePrivilegedSocketOp();
      if (!ok) return { ok: false, error: "unauthorized" };
    }
    return emitAck<{ ok: boolean; profile?: { nick?: string; avatar?: string }; error?: string }>(
      "profile:update",
      clean,
      5000,
    );
  };

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (installId) headers["x-install-id"] = String(installId);
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

    const timeouts = [5000, 12000];
    let lastErr: any = null;
    const url = `${API_BASE}/api/me`;
    for (const ms of timeouts) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(url, {
          method: "PATCH",
          headers,
          body: JSON.stringify(clean),
          signal: controller.signal,
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ""}` };
        }
        const data = await res.json();
        if (data?.ok && data?.user) {
          return { ok: true, profile: { nick: data.user.nick || "", avatar: data.user.avatar || "" } };
        }
        return data;
      } catch (e: any) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return { ok: false, error: lastErr?.message || String(lastErr || "network_error") };
  };

  const promise = (async () => {
    if (!shared.currentUserId || !isOid(shared.currentUserId)) {
      return { ok: false, error: "no_userId" };
    }
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();

  promise
    .then((result) => {
      if (result?.ok) {
      } else {
        const err = String(result?.error || "");
        if (err === "unauthorized" || err === "no_userId") {
          logger.debug("[updateProfile] skipped — identity not ready yet", { error: err });
        } else {
          console.error("[updateProfile] ❌ Server response error:", result?.error);
        }
      }
    })
    .catch((error) => {
      console.error("[updateProfile] ❌ Request failed:", error);
    });

  return promise;
}

export async function getAvatar(userId: string) {
  if (!isOid(userId)) return { ok: false };
  return emitAck<{ ok: boolean; avatarB64?: string; avatarVer?: number }>(
    "user.getAvatar",
    { userId },
    8000,
    1,
  );
}
