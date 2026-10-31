import { getInstallAuthHeaders } from "../../utils/installId";
import { API_BASE, isOid } from "./constants";
import { emitAck } from "./emit";
import { ensureReauthBeforePrivilegedSocketOp } from "./reauth";
import { shared } from "./shared";
import { socket } from "./socketCore";

export type UserProfile = {
  nick?: string;
  avatar?: string;
  avatarUrl?: string;
  avatarB64?: string;
  avatarThumbB64?: string;
  avatarVer?: number;
};
export type ProfileResult = { ok: boolean; profile?: UserProfile; error?: string };
type HttpProfileResult = ProfileResult & { user?: UserProfile };

export type AvatarResult =
  | { ok: true; avatarB64?: string; avatarVer: number; userId?: string }
  | { ok: false; error?: string };

export function getMyProfile() {
  // КРИТИЧНО: Добавляем таймаут 8 секунд для защиты от зависания MongoDB
  const viaSocket = () =>
    emitAck<ProfileResult>("profile:me", undefined, 8000);

  const viaHttp = async (): Promise<ProfileResult> => {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(await getInstallAuthHeaders()) };
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

    const timeouts = [5000, 12000];
    let lastErr: unknown = null;
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
        const data: HttpProfileResult = await res.json();
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
      } catch (e: unknown) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return { ok: false, error: (lastErr as { message?: string } | null)?.message || String(lastErr || "network_error") };
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
    return emitAck<ProfileResult>(
      "profile:update",
      clean,
      5000,
    );
  };

  const viaHttp = async (): Promise<ProfileResult> => {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(await getInstallAuthHeaders()) };
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

    const timeouts = [5000, 12000];
    let lastErr: unknown = null;
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
        const data: HttpProfileResult = await res.json();
        if (data?.ok && data?.user) {
          return { ok: true, profile: { nick: data.user.nick || "", avatar: data.user.avatar || "" } };
        }
        return data;
      } catch (e: unknown) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return { ok: false, error: (lastErr as { message?: string } | null)?.message || String(lastErr || "network_error") };
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
      if (!result?.ok) {
        const err = String(result?.error || "");
        if (err !== "unauthorized" && err !== "no_userId") {
          console.error("[updateProfile] ❌ Server response error:", result?.error);
        }
      }
    })
    .catch((error) => {
      console.error("[updateProfile] ❌ Request failed:", error);
    });

  return promise;
}

export async function getAvatar(userId: string): Promise<AvatarResult> {
  if (!isOid(userId)) return { ok: false };
  return emitAck<AvatarResult>(
    "user.getAvatar",
    { userId },
    8000,
    1,
  );
}
