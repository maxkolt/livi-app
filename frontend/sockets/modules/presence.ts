import { logger } from "../../utils/logger";
import { shared } from "./shared";
import { socket } from "./socketCore";
import { applyMissedFromReauth } from "./missedCalls";
import { drainEditOutbox, drainMessageOutbox } from "./outbox";

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

/**
 * Сразу после connect пустой массив presence часто приходит при гонке reauth / комнаты — не затираем
 * последний непустой снимок (иначе мерцание «онлайн → офлайн → онлайн»).
 */
const PRESENCE_EMPTY_ONLINE_LIST_GRACE_MS = 5000;

/** Совпадает с серверным списком «видимых» онлайн (в т.ч. ушёл в фон → нет в списке). */
function ingestVisibleOnlinePresenceList(data: unknown) {
  if (!Array.isArray(data)) return;
  shared.visibleOnlinePresenceListKnown = true;
  const next = new Set<string>();
  for (const it of data) {
    if (it == null) continue;
    const id = String((it as any)?._id ?? it);
    if (id) next.add(id);
  }
  shared.lastVisibleOnlineUserIds = next;
}

function __normalizePresenceUpdatePayload(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  if (
    raw.length === 0 &&
    shared.lastVisibleOnlineUserIds.size > 0 &&
    Date.now() - shared.lastSocketConnectAt < PRESENCE_EMPTY_ONLINE_LIST_GRACE_MS
  ) {
    const msSinceConnect = Date.now() - shared.lastSocketConnectAt;
    logger.debug("[socket] presence: skip empty online list during post-connect grace", {
      preservedCount: shared.lastVisibleOnlineUserIds.size,
      msSinceConnect,
    });
    return Array.from(shared.lastVisibleOnlineUserIds);
  }
  return raw;
}

function __dispatchPresenceUpdate(raw: unknown): void {
  const payload = __normalizePresenceUpdatePayload(raw);
  if (Array.isArray(payload)) {
    ingestVisibleOnlinePresenceList(payload);
  }
  for (const cb of shared.presenceUpdateSubscribers) {
    try {
      cb(payload);
    } catch (e) {
      logger.warn("[socket] onPresenceUpdate subscriber error", e as any);
    }
  }
}

/**
 * Был ли хотя бы один полный presence-массив с сервера (не путать с «ещё не приходил»).
 * Для шапки чата: при фокусе подставляем тот же статус, что и у списка друзей.
 */
export function hasVisibleOnlinePresenceSnapshot(): boolean {
  return shared.visibleOnlinePresenceListKnown;
}

export function isPeerInVisibleOnlinePresence(peerId: string): boolean {
  if (!peerId) return false;
  return shared.lastVisibleOnlineUserIds.has(String(peerId));
}

export function onPresenceUpdate(
  cb: (data: Array<{ _id: string; online: boolean }> | string[] | { userId: string; busy: boolean }) => void,
): () => void {
  const wrapped = (data: any) => {
    cb(data);
  };
  shared.presenceUpdateSubscribers.add(wrapped);
  return () => {
    shared.presenceUpdateSubscribers.delete(wrapped);
  };
}

export function onUserPresence(
  cb: (userId: string, online: boolean) => void,
): () => void {
  // Сохраняем предыдущий список онлайн пользователей для сравнения
  let previousOnlineUsers = new Set<string>();

  return onPresenceUpdate((data) => {
    // Логи presence убраны - показывают только рабочее состояние

    if (Array.isArray(data)) {
      const currentOnlineUsers = new Set<string>();

      // Обрабатываем массив (обычно это массив строк - ID онлайн пользователей)
      data.forEach((item) => {
        const userId = typeof item === "string" ? item : item._id;
        if (userId) {
          currentOnlineUsers.add(userId);
        }
      });

      // Определяем, кто стал онлайн
      currentOnlineUsers.forEach((userId) => {
        if (!previousOnlineUsers.has(userId)) {
          cb(userId, true); // Пользователь стал онлайн
        }
      });

      // Определяем, кто стал офлайн
      previousOnlineUsers.forEach((userId) => {
        if (!currentOnlineUsers.has(userId)) {
          cb(userId, false); // Пользователь стал офлайн
        }
      });

      // Обновляем предыдущий список
      previousOnlineUsers = currentOnlineUsers;
    }
  });
}

socket.on("connect", () => {
  shared.hasConnectedEver = true;
  shared.lastPresenceUpdateKey = null;
  shared.lastSocketConnectAt = Date.now();
  void drainMessageOutbox()
    .then(() => drainEditOutbox())
    .catch(() => {});
});

socket.on("presence:update", __dispatchPresenceUpdate);
socket.on("presence_update", __dispatchPresenceUpdate);

// При подключении сервер шлёт пропущенные звонки (телефон был выключен / нет сети) — мержим в хранилище и обновляем UI
socket.on("missed_calls:sync", (payload: { missed?: { from: string; fromNick?: string }[] }) => {
  applyMissedFromReauth(payload).catch(() => {});
});
