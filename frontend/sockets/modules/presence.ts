import { logger } from "../../utils/logger";
import { applyRemoteFrameChange } from '../../utils/cosmetics';
import { shared } from "./shared";
import { socket } from "./socketCore";
import { applyMissedFromReauth } from "./missedCalls";
import type { MissedCallDelivery, PresenceUpdatePayload, WelcomePresencePayload } from './types';
import { drainAllOutboxes } from "./outboxTriggers";
import { noteNetworkBack } from "./outbox";
import { refreshE2eState } from "./e2e";

/** Дедуп повторных presence:update с одним и тем же status/roomId (useEffect в VideoCall/PiP и т.д.). Сброс при connect. */
function __presenceUpdateKey(payload: { status?: string; roomId?: string | undefined }): string {
  const st = String(payload?.status || "");
  const rid =
    payload?.roomId != null && String(payload.roomId).trim() !== ""
      ? String(payload.roomId).trim()
      : "";
  return `${st}\0${rid}`;
}

/**
 * Отправляет presence:update только если изменился статус или комната.
 * После reconnect передавайте `{ force: true }`, чтобы сервер снова получил busy.
 */
export function emitPresenceUpdateIfChanged(
  payload: { status: string; roomId?: string; idle?: boolean },
  opts?: { force?: boolean },
): void {
  const key = __presenceUpdateKey(payload);
  if (!opts?.force && key === shared.lastPresenceUpdateKey) return;
  shared.lastPresenceUpdateKey = key;
  const out: { status: string; roomId?: string; idle?: boolean } = { status: payload.status };
  const rid = payload.roomId != null ? String(payload.roomId).trim() : "";
  if (rid) out.roomId = rid;
  if (payload.idle === true) out.idle = true;
  try {
    socket.emit("presence:update", out);
  } catch {}
}

/** Единый debounce офлайн в списке друзей и шапке чата (см. HomeScreen / ChatScreen). */
export const PRESENCE_OFFLINE_DEBOUNCE_MS = 350;

/** Совпадает с серверным списком «видимых» онлайн (в т.ч. ушёл в фон → нет в списке). */
function ingestVisibleOnlinePresenceList(data: unknown) {
  if (!Array.isArray(data)) return;
  shared.visibleOnlinePresenceListKnown = true;
  const next = new Set<string>();
  for (const it of data) {
    if (it == null) continue;
    const id = String((it)?._id ?? it);
    if (id) next.add(id);
  }
  shared.lastVisibleOnlineUserIds = next;
}

function __dispatchPresenceUpdate(raw: PresenceUpdatePayload): void {
  // The server emits this snapshot only after the socket is identity-bound.
  // An empty list is authoritative: preserving the pre-reconnect list here left
  // offline friends stuck online until the process was restarted.
  const payload = raw;
  if (Array.isArray(payload)) {
    ingestVisibleOnlinePresenceList(payload);
  }
  for (const cb of [...shared.presenceUpdateSubscribers]) {
    try {
      cb(payload);
    } catch (e) {
      logger.warn("[socket] onPresenceUpdate subscriber error", e);
    }
  }
}

export function onPresenceUpdate(
  cb: (data: PresenceUpdatePayload) => void,
): () => void {
  const wrapped = (data: Parameters<typeof cb>[0]) => {
    cb(data);
  };
  shared.presenceUpdateSubscribers.add(wrapped);
  return () => {
    shared.presenceUpdateSubscribers.delete(wrapped);
  };
}

/** Global app-online snapshot for welcome banner (not friend-only). */
export function onWelcomePresence(cb: (data: WelcomePresencePayload) => void): () => void {
  const handler = (data: WelcomePresencePayload) => {
    try {
      cb(data);
    } catch (e) {
      logger.warn("[socket] onWelcomePresence subscriber error", e);
    }
  };
  shared.welcomePresenceSubscribers.add(handler);
  return () => {
    shared.welcomePresenceSubscribers.delete(handler);
  };
}

socket.on("connect", () => {
  shared.hasConnectedEver = true;
  shared.lastPresenceUpdateKey = null;
  shared.lastSocketConnectAt = Date.now();
  // Сервер снова доступен: очередь шлёт сразу, без паузы, накопленной без сети.
  noteNetworkBack();
  void refreshE2eState()
    .catch(() => undefined)
    .then(() => drainAllOutboxes());
});

/**
 * Смена рамки у себя или у друга. Сервер шлёт это сразу при применении
 * косметики, чтобы аватар обновился везде без перезапуска приложения.
 */
socket.on("cosmetics:frame", (data: { userId?: string; frameId?: string }) => {
  try {
    applyRemoteFrameChange(String(data?.userId || ''), String(data?.frameId || ''));
  } catch {}
});

socket.on("presence:update", __dispatchPresenceUpdate);
socket.on("presence_update", __dispatchPresenceUpdate);
socket.on("presence:welcome", (data: WelcomePresencePayload) => {
  for (const cb of [...shared.welcomePresenceSubscribers]) {
    try {
      cb(data);
    } catch (e) {
      logger.warn("[socket] presence:welcome subscriber error", e);
    }
  }
});

// При подключении сервер шлёт пропущенные звонки (телефон был выключен / нет сети) — мержим в хранилище и обновляем UI
socket.on("missed_calls:sync", (payload: { userId?: string; missed?: MissedCallDelivery[] }) => {
  applyMissedFromReauth(payload).catch(() => {});
});
