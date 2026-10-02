// frontend/sockets/modules/apiHttp.ts
import { getInstallId } from "../../utils/installId";
import { API_BASE } from "./constants";
import { shared } from "./shared";

/**
 * POST в API по HTTP — обход зависшего сокета (VPN держит socket.connected, но события не ходят).
 * Ошибку сервера возвращает как `{ ok:false, error:"http_<status>:<тело>" }`;
 * бросает, только если сеть не ответила (нет связи / таймаут).
 */
export async function postApiJson<T = any>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const installId = await getInstallId().catch(() => "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (installId) headers["x-install-id"] = String(installId);
  if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ""}` } as T;
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}
