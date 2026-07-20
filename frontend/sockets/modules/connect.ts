import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, type AppStateStatus, NativeModules, Platform } from "react-native";
import { getInstallId } from "../../utils/installId";
import { logger } from "../../utils/logger";
import {
  startActiveCallNotification,
  stopActiveCallNotification,
  syncAndroidLeaveHintForOngoingCall,
} from "../../utils/activeCallNotification";
import {
  API_BASE,
  SOCKET_CONNECT_WAIT_MS,
  SOCKET_RECONNECT_AFTER_SERVER_RESTART_DELAY_MAX_MS,
  SOCKET_RECONNECT_AFTER_SERVER_RESTART_DELAY_MS,
  SOCKET_RECONNECT_DELAY_MAX_MS,
  SOCKET_RECONNECT_DELAY_MS,
  isOid,
} from "./constants";
import { emitAck } from "./emit";
import { createUser } from "./identity";
import { sendChatViewing } from "./messages";
import "./presence";
import { getMyProfile } from "./profile";
import { emitReauthDeduped, recoverFromReauthFailure } from "./reauth";
import { __flushPendingRtcSignals } from "./rtc";
import { shared } from "./shared";
import { socket } from "./socketCore";
import { __notifyCurrentUserId } from "./authState";

/**
 * Держать Socket.IO подключённым в фоне и не выключать reconnection при блокировке экрана.
 * Внимание: сильнее батарея; iOS всё равно может приостановить JS-процесс без спец. background modes;
 * Android при агрессивном Doze может рвать сеть — клиент переподключится при пробуждении.
 */
const SOCKET_KEEP_ALIVE_IN_BACKGROUND = true;
const APP_VISIBILITY_FOREGROUND_HEARTBEAT_MS = 25_000;

function mirrorCallPresenceFlagsToGlobal(patch: {
  incomingScreen?: boolean;
  outgoingScreen?: boolean;
  activeVideoCall?: boolean;
}): void {
  try {
    const g = global as any;
    if (typeof patch.incomingScreen === "boolean") {
      g.__incomingCallScreenVisibleRef = g.__incomingCallScreenVisibleRef || { current: false };
      g.__incomingCallScreenVisibleRef.current = patch.incomingScreen;
    }
    if (typeof patch.outgoingScreen === "boolean") {
      g.__outgoingCallScreenVisibleRef = g.__outgoingCallScreenVisibleRef || { current: false };
      g.__outgoingCallScreenVisibleRef.current = patch.outgoingScreen;
    }
    if (typeof patch.activeVideoCall === "boolean") {
      g.__socketActiveVideoCallRef = g.__socketActiveVideoCallRef || { current: false };
      g.__socketActiveVideoCallRef.current = patch.activeVideoCall;
    }
  } catch {}
}

function emitAppVisibilityToServer(foreground: boolean, options: { heartbeat?: boolean } = {}) {
  try {
    if (socket?.connected) {
      socket.emit("app:visibility", { foreground, ...(options.heartbeat ? { heartbeat: true } : {}) });
    }
  } catch {}
}

function isAppForegroundForPresence(): boolean {
  const state = AppState.currentState || shared.lastAppState;
  return state === "active" || state === "inactive";
}

async function readAndroidMainActivityForeground(): Promise<boolean | null> {
  if (Platform.OS !== "android") return null;
  try {
    const mod = NativeModules.LiviAppModule;
    if (typeof mod?.isMainActivityForeground !== "function") return null;
    const value = await mod.isMainActivityForeground();
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

function stopAppVisibilityForegroundHeartbeat(): void {
  if (shared.appVisibilityHeartbeatTimer) {
    clearInterval(shared.appVisibilityHeartbeatTimer);
    shared.appVisibilityHeartbeatTimer = null;
  }
}

function startAppVisibilityForegroundHeartbeat(): void {
  if (shared.appVisibilityHeartbeatTimer) return;
  shared.appVisibilityHeartbeatTimer = setInterval(() => {
    if (Platform.OS === "android") {
      readAndroidMainActivityForeground()
        .then((nativeForeground) => {
          const foreground = nativeForeground ?? isAppForegroundForPresence();
          if (!foreground) {
            stopAppVisibilityForegroundHeartbeat();
            emitAppVisibilityToServer(false);
            return;
          }
          emitAppVisibilityToServer(true, { heartbeat: true });
        })
        .catch(() => {});
      return;
    }
    if (!isAppForegroundForPresence()) {
      stopAppVisibilityForegroundHeartbeat();
      emitAppVisibilityToServer(false);
      return;
    }
    emitAppVisibilityToServer(true, { heartbeat: true });
  }, APP_VISIBILITY_FOREGROUND_HEARTBEAT_MS);
}

function syncAppVisibilityToServerFromAppState(): void {
  const foreground = isAppForegroundForPresence();
  emitAppVisibilityToServer(foreground);
  if (foreground) startAppVisibilityForegroundHeartbeat();
  else stopAppVisibilityForegroundHeartbeat();
  if (Platform.OS === "android") {
    readAndroidMainActivityForeground()
      .then((nativeForeground) => {
        if (typeof nativeForeground !== "boolean") return;
        emitAppVisibilityToServer(nativeForeground);
        if (nativeForeground) startAppVisibilityForegroundHeartbeat();
        else stopAppVisibilityForegroundHeartbeat();
      })
      .catch(() => {});
  }
}

export function shouldAttemptRealtimeConnection(): boolean {
  if (SOCKET_KEEP_ALIVE_IN_BACKGROUND) return true;
  const inSystemPiP =
    typeof (global as any).__pipInSystemModeRef?.current === "boolean" &&
    (global as any).__pipInSystemModeRef?.current === true;
  return !shared.realtimePaused || shared.outgoingCallScreenVisible || shared.incomingCallScreenVisible || shared.activeVideoCall || inSystemPiP;
}

function isExpectedSocketConnectError(error: unknown): boolean {
  const msg = String((error as any)?.message || error || "").toLowerCase();
  return (
    msg.includes("websocket error") ||
    msg.includes("xhr poll error") ||
    msg.includes("network request failed") ||
    msg.includes("timeout") ||
    msg.includes("aborted")
  );
}

export async function applyAuthAndConnect() {
  if (shared.connectAttemptPromise) return shared.connectAttemptPromise;

  shared.connectAttemptPromise = (async () => {
    try {
      const installId = await getInstallId();
      // @ts-ignore
      socket.auth = { installId, ...(shared.currentUserId ? { userId: shared.currentUserId } : {}) };

      // Если realtime сейчас сознательно поставлен на паузу, не стартуем новый connect().
      // Иначе при фоне/блокировке экрана можно словить шумный xhr poll error от уже отмененного запроса.
      if (!shouldAttemptRealtimeConnection()) {
        logger.debug("[applyAuthAndConnect] Realtime paused, skip connect");
        return;
      }

      // Если уже подключены, но handshake был без installId (типичный кейс из-за autoConnect),
      // сервер будет считать нас гостем и profile:me вернёт {}. В этом случае делаем 1 reconnect.
      if (socket.connected) {
        if (!shared.handshakeHasInstallId && installId) {
          try {
            const resp = await emitAck<{ ok: boolean; userId?: string; error?: string }>(
              "reauth",
              { userId: shared.currentUserId },
              6000,
              0,
            );
            if (resp?.ok) {
              shared.handshakeHasInstallId = true;
              return;
            }
            if (resp?.error === "no_installId") {
              logger.warn("[applyAuthAndConnect] Connected without installId in handshake, forcing reconnect");
              try {
                socket.disconnect();
              } catch {}
              shared.handshakeHasInstallId = false;
              socket.connect();
            } else {
              return;
            }
          } catch (e) {
            try {
              socket.disconnect();
            } catch {}
            shared.handshakeHasInstallId = false;
            socket.connect();
          }
        } else {
          return;
        }
      }

      if (!socket.connected) {
        logger.debug("Connecting socket...");
        socket.connect();

        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timeout);
            socket.off("connect", onConnect);
            socket.off("connect_error", onError);
          };
          const timeout = setTimeout(() => {
            cleanup();
            if (!shouldAttemptRealtimeConnection()) {
              logger.debug("[applyAuthAndConnect] Connection timeout while realtime paused");
              resolve();
              return;
            }
            reject(new Error("Socket connection timeout"));
          }, SOCKET_CONNECT_WAIT_MS);

          const onConnect = () => {
            cleanup();
            logger.debug("Socket connected");
            resolve();
          };

          const onError = (err: any) => {
            cleanup();
            if (!shouldAttemptRealtimeConnection()) {
              logger.debug("[applyAuthAndConnect] Ignoring connect error while realtime paused:", err?.message || String(err));
              resolve();
              return;
            }
            logger.warn("Socket connect error:", err);
            reject(err);
          };

          if (socket.connected) {
            cleanup();
            resolve();
          } else {
            socket.once("connect", onConnect);
            socket.once("connect_error", onError);
          }
        });
        if (socket.connected && installId) shared.handshakeHasInstallId = true;
      } else {
        logger.debug("Socket already connected, skip reconnect");
      }
    } catch (error) {
      if (!shouldAttemptRealtimeConnection()) {
        logger.debug("[applyAuthAndConnect] Connection attempt stopped while realtime paused");
        return;
      }
      if (isExpectedSocketConnectError(error)) {
        logger.warn("[applyAuthAndConnect] Connection failed (non-critical network):", error);
      } else {
        logger.error("[applyAuthAndConnect] Connection failed:", error);
      }
    } finally {
      shared.connectAttemptPromise = null;
    }
  })();

  return shared.connectAttemptPromise;
}

export async function boot() {
  // Защита от повторного вызова
  if (shared.bootInProgress) {
    logger.debug("Boot already in progress, skipping...");
    return;
  }

  shared.bootInProgress = true;
  logger.debug("Starting boot process...");

  // Снимаем уведомление «Видеозвонок от...», если оно осталось от прошлого запуска (сервис не закрылся).
  if (Platform.OS === "android") {
    stopActiveCallNotification();
  }

  try {
    const saved = await AsyncStorage.getItem("userId");
    if (saved && isOid(saved)) {
      logger.debug("Found saved userId:", saved);

      // Сначала устанавливаем userId и подключаемся
      shared.currentUserId = saved;
      __notifyCurrentUserId();

      // Подключаемся к socket (и гарантируем installId в handshake)
      await applyAuthAndConnect();

      // ВАЖНО: гарантируем, что сервер "видит" userId (иначе profile:me вернёт гостевой профиль {})
      // Не пересоздаём пользователя на временных проблемах сети/авторизации — сначала пробуем reauth.
      try {
        if (socket.connected) {
          await emitReauthDeduped(saved, 6000, 1);
        }
      } catch (e) {
        // мягко игнорируем — может быть оффлайн, но userId локально сохраняем
        logger.warn("[boot] reauth failed (non-critical):", e);
      }

      // Проверяем профиль пользователя через getMyProfile
      // КРИТИЧНО: getMyProfile уже имеет таймаут 8 секунд
      try {
        const profileResponse = await getMyProfile();
        if (profileResponse?.ok) {
          // profile === undefined → userId не найден в БД (реальный кейс "пользователь удалён/сломана база")
          // profile === {} допустимо (пустой ник/аватар) и НЕ должно приводить к созданию нового userId
          if (profileResponse.profile === undefined) {
            logger.info("Profile is missing for saved userId (user not found), creating new user...");
            await createUser();
            return;
          }

          const profile = profileResponse.profile;
          logger.debug("Loaded profile from backend:", { nick: profile?.nick });

          logger.debug("Using existing user with profile:", saved);
        } else {
          const err = String((profileResponse as any)?.error || "").toLowerCase();
          const isDefinitiveUserMissing =
            err === "user_not_found" ||
            err.includes("user_not_found") ||
            err.startsWith("http_404");
          if (isDefinitiveUserMissing) {
            logger.info("Profile explicitly missing for saved userId, creating new user...");
            await createUser();
            return;
          }
          // ВАЖНО: оффлайн/таймаут/временный сбой НЕ должен приводить к пересозданию userId
          // и очистке локального профиля/кэшей друзей.
          logger.warn("[boot] Profile check failed (temporary), keep saved userId and local cache", {
            error: (profileResponse as any)?.error,
          });
        }
      } catch (e) {
        // ВАЖНО: при сетевых сбоях не пересоздаём пользователя.
        logger.warn("[boot] Profile check threw error, keep saved userId and local cache", e as any);
      }
    } else {
      // Нет сохраненного userId (удаление приложения или сброс аккаунта) - создаем нового
      logger.info("No saved userId, creating new user...");
      await createUser();
    }
  } catch (e) {
    logger.error("Boot error loading userId:", e);
    logger.info("Error occurred, creating new user...");
    await createUser();
  }

  // КРИТИЧНО: Подключаемся с актуальным currentUserId (только если не создавали нового пользователя)
  logger.debug("Final currentUserId:", shared.currentUserId);
  if (!socket.connected) {
    await applyAuthAndConnect();
  } else if (shared.currentUserId) {
    logger.debug("Socket connected, sending reauth with userId:", shared.currentUserId);
    try {
      const reauthResponse = await emitReauthDeduped(shared.currentUserId);
      if (reauthResponse?.ok) {
        logger.debug("Reauth successful");
      } else {
        logger.warn("Reauth failed:", reauthResponse?.error);
        if (reauthResponse?.error === "user_not_found" || reauthResponse?.error === "not_found") {
          await recoverFromReauthFailure(reauthResponse?.error);
        }
      }
    } catch (e) {
      logger.warn("Reauth error:", e);
    }
  }

  // Сбрасываем флаг завершения boot процесса
  shared.bootInProgress = false;
  logger.debug("[boot] Boot process completed");
}

export function setOutgoingCallScreenVisible(visible: boolean): void {
  shared.outgoingCallScreenVisible = visible;
  mirrorCallPresenceFlagsToGlobal({ outgoingScreen: visible });
  if (
    !SOCKET_KEEP_ALIVE_IN_BACKGROUND &&
    !visible &&
    shared.lastAppState !== "active" &&
    shared.lastAppState !== "inactive"
  ) {
    shared.realtimePaused = true;
    try {
      (socket as any).io.opts.reconnection = false;
    } catch {}
    if (socket?.connected) socket.disconnect();
  }
}

export function setIncomingCallScreenVisible(visible: boolean, fromUserId?: string | null): void {
  shared.incomingCallScreenVisible = visible;
  shared.incomingCallFromUserId = visible && fromUserId != null ? String(fromUserId) : null;
  mirrorCallPresenceFlagsToGlobal({ incomingScreen: visible });
  shared.incomingCallScreenChangeListeners.forEach((cb) => {
    try {
      cb(shared.incomingCallScreenVisible, shared.incomingCallFromUserId);
    } catch {}
  });
  if (
    !SOCKET_KEEP_ALIVE_IN_BACKGROUND &&
    !visible &&
    shared.lastAppState !== "active" &&
    shared.lastAppState !== "inactive"
  ) {
    shared.realtimePaused = true;
    try {
      (socket as any).io.opts.reconnection = false;
    } catch {}
    if (socket?.connected) socket.disconnect();
  }
}

export function getIncomingCallScreenState(): { visible: boolean; fromUserId: string | null } {
  return { visible: shared.incomingCallScreenVisible, fromUserId: shared.incomingCallFromUserId };
}

export function onIncomingCallScreenChange(cb: (visible: boolean, fromUserId: string | null) => void): () => void {
  shared.incomingCallScreenChangeListeners.add(cb);
  return () => {
    shared.incomingCallScreenChangeListeners.delete(cb);
  };
}

export function setActiveVideoCall(active: boolean, partnerDisplayName?: string | null): void {
  shared.activeVideoCall = active;
  mirrorCallPresenceFlagsToGlobal({ activeVideoCall: active });
  if (Platform.OS === "android") {
    if (active) {
      startActiveCallNotification(partnerDisplayName);
      try {
        syncAndroidLeaveHintForOngoingCall();
      } catch (_) {}
    } else {
      stopActiveCallNotification();
    }
  }
  if (
    !SOCKET_KEEP_ALIVE_IN_BACKGROUND &&
    !active &&
    shared.lastAppState !== "active" &&
    shared.lastAppState !== "inactive"
  ) {
    shared.realtimePaused = true;
    try {
      (socket as any).io.opts.reconnection = false;
    } catch {}
    if (socket?.connected) socket.disconnect();
  }
}

// КРИТИЧНО: Обертываем boot() в try-catch для предотвращения крашей
// Запускаем boot с задержкой, чтобы дать приложению время инициализироваться
setTimeout(() => {
  (async () => {
    try {
      await boot();
    } catch (error) {
      logger.error("[boot] Critical error during boot process:", error);
      // Не выбрасываем ошибку - приложение должно продолжить работу
      // Попробуем создать пользователя как fallback
      try {
        await createUser();
      } catch (createError) {
        logger.error("[boot] Failed to create user as fallback:", createError);
      }
    }
  })();
}, 100); // Небольшая задержка для инициализации модулей

try {
  AppState.addEventListener("change", (nextState) => {
    try {
      // Treat 'inactive' as foreground to avoid disconnect/reconnect flicker while user is still in-app
      // (e.g. transient OS transitions). We only pause realtime when app actually goes to background.
      const wasForeground = shared.lastAppState === "active" || shared.lastAppState === "inactive";
      const isForeground = nextState === "active" || nextState === "inactive";
      shared.lastAppState = nextState;

      if (wasForeground && !isForeground) {
        emitAppVisibilityToServer(false);
        stopAppVisibilityForegroundHeartbeat();
        if (SOCKET_KEEP_ALIVE_IN_BACKGROUND) return;
        const inSystemPiP = typeof (global as any).__pipInSystemModeRef?.current === "boolean" && (global as any).__pipInSystemModeRef?.current === true;
        if (shared.outgoingCallScreenVisible || shared.incomingCallScreenVisible || shared.activeVideoCall || inSystemPiP) return;
        shared.realtimePaused = true;
        try {
          try {
            (socket as any).io.opts.reconnection = false;
          } catch {}
          if (socket?.connected) socket.disconnect();
        } catch {}
        return;
      }

      if (!wasForeground && isForeground) {
        emitAppVisibilityToServer(true);
        startAppVisibilityForegroundHeartbeat();
        if (!SOCKET_KEEP_ALIVE_IN_BACKGROUND) shared.realtimePaused = false;
        // Не сбрасываем __incomingCallScreenVisible / __outgoingCallScreenVisible / __activeVideoCall здесь:
        // нативные экраны звонка и видеозвонок могут оставаться активными при возврате из фона; сброс давал
        // ложный «офлайн», обрыв сокета во время входящего/исходящего и рассинхрон presence.
        try {
          (socket as any).io.opts.reconnection = true;
        } catch {}
        // applyAuthAndConnect already sets installId/userId and connects with timeouts.
        applyAuthAndConnect().catch(() => {});
      }
    } catch {}
  });
} catch {}

/* ========= logging ========= */
socket.on("server:restarting", () => {
  try {
    const mgr = (socket as any).io;
    if (mgr?.opts) {
      mgr.opts.reconnectionDelay = SOCKET_RECONNECT_AFTER_SERVER_RESTART_DELAY_MS;
      mgr.opts.reconnectionDelayMax = SOCKET_RECONNECT_AFTER_SERVER_RESTART_DELAY_MAX_MS;
    }
  } catch {}
  logger.info("[socket] server restarting — accelerated reconnect backoff");
});

socket.on("connect", async () => {
  shared.reconnecting = false;
  try {
    const mgr = (socket as any).io;
    if (mgr?.opts) {
      mgr.opts.reconnectionDelay = SOCKET_RECONNECT_DELAY_MS;
      mgr.opts.reconnectionDelayMax = SOCKET_RECONNECT_DELAY_MAX_MS;
    }
  } catch {}
  logger.debug(`[socket] connected ${socket.id} (API: ${API_BASE})`);
  // If we connected with installId in auth, handshake is considered valid.
  try {
    // @ts-ignore
    const auth = (socket as any)?.auth;
    if (auth?.installId) shared.handshakeHasInstallId = true;
  } catch {}

  // КРИТИЧНО: Если у нас есть userId, но socket подключился без него - отправляем reauth (дедуп с boot / другими вызовами)
  if (shared.currentUserId && !(socket as any).data?.userId) {
    logger.debug("[socket] post-connect reauth (no userId in socket data yet)", { userId: shared.currentUserId });
    try {
      const reauthResponse = await emitReauthDeduped(shared.currentUserId);
      if (reauthResponse?.ok) {
        logger.debug("[socket] Reauth successful after connect");
      } else {
        logger.warn("[socket] Reauth failed after connect:", reauthResponse?.error);
        if (reauthResponse?.error === "user_not_found" || reauthResponse?.error === "not_found") {
          await recoverFromReauthFailure(reauthResponse?.error);
        }
      }
    } catch (e) {
      logger.warn("[socket] Reauth error after connect:", e);
    }
  }
  // После bind на сервере: для друзей «онлайн» только на переднем плане (сокет может оставаться в фоне).
  const syncAppVisibilityAfterConnect = () => {
    try {
      if (socket.connected) syncAppVisibilityToServerFromAppState();
    } catch {}
  };
  syncAppVisibilityAfterConnect();
  setTimeout(syncAppVisibilityAfterConnect, 250);
  __flushPendingRtcSignals();
  // После reconnect сервер сбрасывает chat:viewing — восстанавливаем, если пользователь всё ещё в переписке.
  try {
    const peer = (global as any).__currentChatPeerId;
    if (peer && typeof peer === "string" && peer.length > 0) {
      sendChatViewing(peer);
    }
  } catch {}
});

socket.on("reconnect_attempt", () => {
  shared.reconnecting = true;
});
// Manager `reconnect` не дублируем: после успешного переподключения снова срабатывает `connect` → один reauth через emitReauthDeduped.

socket.on("disconnect", (r) => {
  // Временные отвалы: по ним считаем, что сокет в состоянии переподключения (для логов и isReconnecting()).
  // io server disconnect: корректное закрытие при деплое/restart (см. server:restarting на бэкенде)
  const transient = ["transport close", "ping timeout", "transport error", "io server disconnect"];
  shared.reconnecting = transient.includes(r) || r === undefined;
  // При транзиентных разрывах auth на клиенте не теряется — не сбрасываем флаг (избегаем лишних reconnect/reauth веток).
  const reason = String(r || "");
  if (!transient.includes(reason) && reason) {
    shared.handshakeHasInstallId = false;
  }
  const isExpectedUserBackgroundDisconnect = reason === "io client disconnect";
  if (isExpectedUserBackgroundDisconnect) {
    const note = shared.realtimePaused ? "app in background / screen locked" : "user-initiated disconnect";
    logger.info(`[socket] temporary disconnect (${note}) reason=${reason || "unknown"}`);
  } else if (transient.includes(reason)) {
    logger.debug(`[socket] disconnected (${reason}) reconnecting=${shared.reconnecting} (transient; reauth after reconnect if needed)`);
  } else {
    logger.warn(`[socket] disconnected (${reason || "unknown"}) reconnecting=${shared.reconnecting}`);
  }
});

socket.on("connect_error", (e) => {
  shared.reconnecting = true;
  // VPNs sometimes break XHR polling while WebSocket is still available.
  // Switch transport preference for next attempts to avoid stuck retries.
  try {
    const msg = String((e as any)?.message || "").toLowerCase();
    if (msg.includes("xhr poll error")) {
      const ioOpts: any = (socket as any)?.io?.opts;
      if (Array.isArray(ioOpts?.transports) && ioOpts.transports[0] !== "websocket") {
        ioOpts.transports = ["websocket", "polling"];
        logger.warn("[socket] xhr polling failed, preferring websocket for reconnect");
      }
    }
  } catch {}
  console.warn(`[socket] error ${e?.message || e}`);
});
// Busy handler (for logging/forwarding to UI screens)
socket.on("call:busy", (data) => {});

// Обработчики для системы бэйджа "Занято"
socket.on("random:busy", (data: { userId: string; busy: boolean }) => {});

socket.on("friends:room_state", (data: { roomId: string; participants: string[] }) => {});
