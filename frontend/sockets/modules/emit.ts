import { getInstallId } from "../../utils/installId";
import { shared } from "./shared";
import { socket } from "./socketCore";
import { SOCKET_CONNECT_WAIT_MS } from "./constants";

type AnyObj = Record<string, any>;

/** @internal used by emitAck / messages; not part of public socket.ts facade */
export async function waitForConnect(ms = 8000): Promise<void> {
  if (socket.connected) return;
  // Первое подключение (VPN / медленный DNS): не обрываем раньше, чем engine.io handshake.
  const effectiveMs = !shared.hasConnectedEver ? Math.max(ms, SOCKET_CONNECT_WAIT_MS) : ms;
  // CRITICAL: ensure installId is attached before any implicit connect().
  // Some codepaths call waitForConnect() (emitAck) which triggers socket.connect().
  // Without installId in handshake server can treat client as guest and return empty profile/avatar.
  try {
    const installId = await getInstallId();
    // @ts-ignore
    const prevAuth =
      (socket as any)?.auth && typeof (socket as any).auth === "object" ? (socket as any).auth : {};
    // @ts-ignore
    socket.auth = {
      ...prevAuth,
      installId,
      ...(shared.currentUserId ? { userId: shared.currentUserId } : {}),
    };
  } catch {}
  return new Promise((resolve, reject) => {
    const onOk = () => {
      cleanup();
      resolve();
    };
    const t = setTimeout(() => {
      cleanup();
      reject(new Error("wait connect timeout"));
    }, effectiveMs);
    const cleanup = () => {
      clearTimeout(t);
      socket.off("connect", onOk);
    };
    socket.once("connect", onOk);
    // гарантируем попытку соединения
    try {
      socket.connect();
    } catch {}
  });
}

/** Ждёт подключения сокета (с таймаутом). Нужно при отмене вызова из вне приложения, чтобы call:decline дошёл до сервера и caller получил call:declined. */
export async function ensureSocketConnected(ms = 15000): Promise<void> {
  if (socket.connected) return;
  try {
    await waitForConnect(ms);
  } catch {
    // Таймаут — всё равно вызываем declineCall ниже, emit может уйти в очередь
  }
}

/** Неблокирующий старт handshake до accept/initiate (входящий/исходящий звонок). */
export function warmCallSignaling(): void {
  if (socket.connected) return;
  // Важно (lock screen / фон): после suspend JS флаг shared.reconnecting может остаться true,
  // пока manager реально не reconnect'ится. Раньше мы выходили тут и early call:accept ждал зря.
  // Если сокет уже disconnected — всегда мягко подталкиваем connect().
  void (async () => {
    try {
      const installId = await getInstallId();
      // @ts-ignore
      const prevAuth =
        (socket as any)?.auth && typeof (socket as any).auth === "object" ? (socket as any).auth : {};
      // @ts-ignore
      socket.auth = {
        ...prevAuth,
        installId,
        ...(shared.currentUserId ? { userId: shared.currentUserId } : {}),
      };
    } catch {}
    try {
      socket.connect();
    } catch {}
  })();
}

export async function emitAck<T = any>(
  event: string,
  payload?: AnyObj,
  timeoutMs = 12000,
  retries = 2,
): Promise<T> {
  // 1) если оффлайн/реконнект — сначала дождаться коннекта
  if (!socket.connected || shared.reconnecting) {
    try {
      await waitForConnect(15000);
    } catch {
      throw new Error(`offline: cannot emit "${event}"`);
    }
  }

  const tryOnce = () =>
    new Promise<T>((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error(`Ack timeout for "${event}"`));
        }
      }, timeoutMs);

      const ack = (resp: T) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(resp);
      };

      // socket.emit с ack
      try {
        if (payload !== undefined) socket.emit(event, payload, ack);
        else socket.emit(event, null, ack);
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
    });

  // 2) ретраи на таймаут
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    try {
      return await tryOnce();
    } catch (e: any) {
      lastErr = e;
      // если снова ушли в реконнект — подождём и повторим
      if (!socket.connected || shared.reconnecting) {
        try {
          await waitForConnect(15000);
        } catch {}
      }
      // джиттер между попытками
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 300));
    }
  }
  throw lastErr;
}

export function onConnected(cb: () => void): () => void {
  const h = () => cb();
  if (socket.connected) h();
  socket.on("connect", h);
  return () => socket.off("connect", h);
}

export function onDisconnected(cb: (reason?: string) => void): () => void {
  const h = (r?: string) => cb(r);
  socket.on("disconnect", h);
  return () => socket.off("disconnect", h);
}

