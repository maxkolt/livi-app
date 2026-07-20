import AsyncStorage from "@react-native-async-storage/async-storage";
import { getInstallId } from "../../utils/installId";
import { __notifyCurrentUserId } from "./authState";
import { API_BASE, isOid } from "./constants";
import { emitAck } from "./emit";
import { clearCancelledOutboxFingerprints } from "./outbox";
import { clearAllMessageCache } from "./messages";
import { shared } from "./shared";
import { getSocketInstance, socket } from "./socketCore";
import { logger } from "../../utils/logger";

// ВАЖНО: отрицательный результат нельзя кэшировать надолго — иначе после восстановления/создания пользователя
// приложение будет зацикливаться на "user_not_found" и делать hard reset по старому кэшу.
const USER_EXISTS_CACHE_TTL_TRUE = 30000;
const USER_EXISTS_CACHE_TTL_FALSE = 1500;

export function identityAttach(payload: {
  installId?: string;
  profile?: { nick?: string; avatarUrl?: string };
}) {
  return emitAck<{ ok: boolean; userId?: string; error?: string }>(
    "identity:attach",
    payload,
  );
}

export const attachIdentity = identityAttach;

/* ========= Service ========= */
export function getSocketId() {
  return socket.id;
}

export async function attachUserId(userId: string) {
  if (!isOid(userId)) return;
  console.log("[attachUserId] Attaching userId:", userId);
  shared.currentUserId = userId;
  __notifyCurrentUserId();
  try {
    await AsyncStorage.setItem("userId", shared.currentUserId);
  } catch {}
  if (socket.connected) {
    console.log("[socket] reauth — skip full disconnect");
    socket.emit("reauth", { userId });
    return;
  }
  const connect = await import("./connect");
  await connect.applyAuthAndConnect();
}

// Функция для проверки существования пользователя с retry и кэшированием
export async function checkUserExists(userId: string): Promise<boolean | null> {
  // Проверяем кэш
  const cached = shared.userExistsCache.get(userId);
  if (cached) {
    const ttl = cached.result ? USER_EXISTS_CACHE_TTL_TRUE : USER_EXISTS_CACHE_TTL_FALSE;
    if (Date.now() - cached.timestamp < ttl) {
      const now = Date.now();
      if (__DEV__ && now - shared.lastUserExistsCacheLogAt > 10_000) {
        shared.lastUserExistsCacheLogAt = now;
        logger.debug("[checkUserExists] Using cached result", { result: cached.result });
      }
      return cached.result;
    }
  }

  // Защита от одновременных вызовов - если уже есть запрос для этого userId, ждем его
  const pending = shared.pendingChecks.get(userId);
  if (pending) {
    if (!shared.pendingWaitLogged.has(userId)) {
      shared.pendingWaitLogged.add(userId);
      logger.debug("[checkUserExists] Waiting for pending check", { userId });
    }
    return pending;
  }

  const checkPromise = (async () => {
    try {
      logger.debug("[checkUserExists] Checking user", { userId });

      // ПРИОРИТЕТ: Используем socket.io если подключен, иначе HTTP
      if (getSocketInstance()?.connected) {
        try {
          const socketResult = await checkUserExistsSocket(userId);
          // ВАЖНО: не интерпретируем ok=false как exists=false (например, когда БД временно недоступна).
          if (socketResult?.ok === true && typeof (socketResult as any).exists === "boolean") {
            const exists = (socketResult as any).exists as boolean;
            shared.userExistsCache.set(userId, { result: exists, timestamp: Date.now() });
            logger.debug("[checkUserExists] User exists (via socket)", { userId, exists });
            return exists;
          }
          // ok=false / нет exists -> fallback to HTTP
        } catch (socketError) {
          // Не логируем как warning - это нормально если socket временно недоступен
          logger.debug("[checkUserExists] Socket check failed, falling back to HTTP");
        }
      }

      // Fallback: HTTP запрос с retry (только если socket не работает)
      const httpMaxAttempts = 3;
      for (let attempt = 1; attempt <= httpMaxAttempts; attempt++) {
        try {
          if (attempt === 1) {
            logger.debug("[checkUserExists] Attempt (HTTP)", { attempt, maxAttempts: httpMaxAttempts });
          }

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 20000);

          const response = await fetch(`${API_BASE}/api/exists/${userId}`, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            if (attempt === httpMaxAttempts) {
              console.warn(`[checkUserExists] HTTP failed after ${attempt} attempts, status:`, response.status);
            }
            if (attempt < httpMaxAttempts) {
              await new Promise((resolve) => setTimeout(resolve, 700));
              continue;
            }
            return null;
          }

          const data = await response.json();
          if (data.ok) {
            logger.debug("[checkUserExists] User exists (via HTTP)", { userId, exists: data.exists });
            shared.userExistsCache.set(userId, { result: data.exists, timestamp: Date.now() });
            return data.exists;
          }
        } catch (e: any) {
          if (attempt === httpMaxAttempts) {
            const errorMsg = e?.message || String(e);
            if (errorMsg.includes("Network request failed") || errorMsg.includes("timeout")) {
              logger.debug("[checkUserExists] Network unavailable, will retry later", {
                attempt,
                maxAttempts: httpMaxAttempts,
              });
            } else {
              console.warn(`[checkUserExists] HTTP error (attempt ${attempt}/${httpMaxAttempts}):`, errorMsg);
            }
          }
          if (attempt < httpMaxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 700));
            continue;
          }
        }
      }

      logger.debug("[checkUserExists] All attempts failed, server temporarily unavailable");
      return null;
    } finally {
      shared.pendingChecks.delete(userId);
      shared.pendingWaitLogged.delete(userId);
    }
  })();

  shared.pendingChecks.set(userId, checkPromise);
  return checkPromise;
}

async function createUserInternal(): Promise<string | null> {
  console.log("[createUser] Creating user...");

  // КРИТИЧНО: Проверяем существование пользователя на сервере перед пропуском создания
  if (shared.currentUserId) {
    try {
      const exists = await checkUserExists(shared.currentUserId);
      if (exists === true) {
        console.log("[createUser] User already exists on server:", shared.currentUserId, "skipping creation");
        return shared.currentUserId;
      } else if (exists === false) {
        console.warn("[createUser] User exists locally but not on server, clearing and creating new...");
        clearCurrentUserId();
      } else {
        console.warn("[createUser] User existence unknown (temporary offline), keeping local userId and retrying later...");
        return null;
      }
    } catch (e) {
      console.warn("[createUser] Failed to check user existence, clearing local userId:", e);
      clearCurrentUserId();
    }
  }

  // Очищаем старый userId и все локальные данные из AsyncStorage
  try {
    await AsyncStorage.removeItem("userId");
    // актуальные ключи
    await AsyncStorage.removeItem("livi.profile.v1");
    await AsyncStorage.removeItem("profile_draft_v1");
    // legacy keys (на случай старых версий)
    await AsyncStorage.removeItem("profile");
    await AsyncStorage.removeItem("livi.home.draft.v1");
    console.log("[createUser] Cleared old userId and all local data from AsyncStorage");
  } catch (e) {
    console.warn("[createUser] Failed to clear AsyncStorage:", e);
  }

  let installId = await getInstallId();

  // Retry до 5 раз с задержкой
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`[createUser] Attempt ${attempt}/5...`);

      // Используем identity:attach для создания пользователя
      const response = await identityAttach({ installId });

      if (response?.ok && response?.userId) {
        // ВАЖНО: сервер может вернуть userId, который уже удалён из БД (например, по старой связке installId→userId).
        // Поэтому подтверждаем существование перед тем как считать создание успешным.
        const candidateId = String(response.userId);
        const exists = await checkUserExists(candidateId);

        if (exists === true) {
          setCurrentUserId(candidateId);
          const connect = await import("./connect");
          await connect.applyAuthAndConnect();
          console.log("[createUser] User created successfully:", candidateId);
          return candidateId;
        }

        if (exists === null) {
          setCurrentUserId(candidateId);
          const connect = await import("./connect");
          await connect.applyAuthAndConnect();
          try {
            const reauth = await import("./reauth");
            await reauth.emitReauthDeduped(candidateId);
          } catch {}
          console.log("[createUser] User created (existence check inconclusive, trusting attach):", candidateId);
          return candidateId;
        }

        console.warn("[createUser] identity:attach returned non-existing userId, resetting installId and retrying...", {
          candidateId,
          exists,
        });
        const { resetInstallId } = await import("../../utils/installId");
        await resetInstallId();
        clearCurrentUserId();
        installId = await getInstallId();
        continue;
      }

      if (response?.error === "duplicate_request") {
        const existing = await getMyUserId();
        if (existing) {
          const exists = await checkUserExists(existing);
          if (exists) {
            setCurrentUserId(existing);
            const connect = await import("./connect");
            await connect.applyAuthAndConnect();
            console.log("[createUser] Existing user restored from installId:", existing);
            return existing;
          } else {
            console.warn("[createUser] User from duplicate_request does not exist on server, clearing installId and creating new user...");
            const { resetInstallId } = await import("../../utils/installId");
            await resetInstallId();
            clearCurrentUserId();
            await getInstallId();
            continue;
          }
        } else {
          console.warn("[createUser] duplicate_request but no userId found, retrying...");
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
      }

      // КРИТИЧНО: Если БД недоступна, не бросаем ошибку сразу - ждем и повторяем
      // Это позволяет приложению работать даже если БД временно недоступна
      if (response?.error === "database_unavailable") {
        console.warn(`[createUser] Database unavailable on attempt ${attempt}, will retry...`);
        throw new Error("database_unavailable");
      }

      throw new Error(response?.error || "Failed to create user");
    } catch (e) {
      console.warn(`[createUser] Attempt ${attempt} error:`, e);
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
    }
  }

  console.error("[createUser] All attempts failed");
  return null;
}

// Функция для создания пользователя с retry
export async function createUser(): Promise<string | null> {
  if (shared.createUserPromise) {
    console.log("[createUser] Creation already in progress, waiting for existing promise");
    return shared.createUserPromise;
  }

  shared.createUserPromise = (async () => {
    try {
      return await createUserInternal();
    } catch (error) {
      throw error;
    }
  })();

  try {
    return await shared.createUserPromise;
  } finally {
    shared.createUserPromise = null;
  }
}

export const isCreateUserInProgress = () => !!shared.createUserPromise;

export async function waitForCreateUserCompletion(): Promise<string | null> {
  if (!shared.createUserPromise) return null;
  return shared.createUserPromise.catch((error) => {
    throw error;
  });
}

export function getCurrentUserId(): string | undefined {
  return shared.currentUserId;
}

export function setCurrentUserId(userId: string) {
  if (!userId || !isOid(String(userId))) {
    clearCurrentUserId();
    return;
  }
  shared.currentUserId = userId;
  __notifyCurrentUserId();
  try {
    shared.userExistsCache.delete(String(userId));
  } catch {}
  try {
    clearAllMessageCache();
  } catch {}
  AsyncStorage.setItem("userId", userId).catch((e) => console.warn("Failed to save userId to storage:", e));
}

// КРИТИЧНО: Функция для сброса currentUserId (нужна после удаления профиля)
export function clearCurrentUserId() {
  shared.currentUserId = undefined;
  __notifyCurrentUserId();
  try {
    shared.userExistsCache.clear();
  } catch {}
  try {
    shared.pendingChecks.clear();
  } catch {}
  try {
    clearAllMessageCache();
  } catch {}
  try {
    clearCancelledOutboxFingerprints();
  } catch {}
  AsyncStorage.removeItem("userId").catch((e) => console.warn("Failed to remove userId from storage:", e));
  console.log("[clearCurrentUserId] Cleared currentUserId");
}

/* ========= REST API для получения userId (как в старой версии) ========= */
async function whoamiViaRest(): Promise<string | null> {
  try {
    const installId = await getInstallId();
    const r = await fetch(`${API_BASE}/whoami?installId=${encodeURIComponent(installId)}`);
    const j = await r.json();
    if (j?.ok && isOid(j?.userId)) {
      return String(j.userId);
    }
  } catch (e) {
    console.warn("whoamiViaRest failed:", e);
  }
  return null;
}

/** installId → user mapping with REST whoami (ignores in-memory currentUserId). */
export async function refreshUserIdFromInstall(): Promise<string | null> {
  const userId = await whoamiViaRest();
  if (userId && isOid(userId)) {
    setCurrentUserId(userId);
    return userId;
  }
  return null;
}

export async function getMyUserId(): Promise<string | null> {
  // Сначала пробуем из памяти
  if (shared.currentUserId) {
    return shared.currentUserId;
  }

  // Потом через REST API
  const userId = await whoamiViaRest();
  if (userId) {
    setCurrentUserId(userId);
    return userId;
  }

  // Если REST API не работает, попробуем через socket
  try {
    const resp = await emitAck<any>("whoami", undefined, 6000, 1);
    if (resp && resp._id) {
      setCurrentUserId(resp._id);
      return resp._id;
    }
  } catch (error) {
    console.warn("🔍 getMyUserId: whoami via socket failed:", error);
  }

  return null;
}

export function onFriendProfile(
  cb: (p: { userId: string; nick?: string; avatar?: string; avatarVer?: number; avatarThumbB64?: string }) => void,
): () => void {
  const h = (p: any) => cb(p);
  socket.on("friend:profile", h);
  socket.on("friend_profile", h);
  return () => {
    socket.off("friend:profile", h);
    socket.off("friend_profile", h);
  };
}

/* ========= User Validation ========= */
export function checkUserExistsSocket(userId: string) {
  return emitAck<{ ok: boolean; exists: boolean; error?: string }>(
    "user:exists",
    { userId },
  );
}

/* ========= User Data Cleanup ========= */
export async function clearAllUserData(): Promise<{ success: boolean; error?: any }> {
  try {
    // Очищаем все данные из AsyncStorage
    const keys = await AsyncStorage.getAllKeys();
    const userDataKeys = keys.filter((key) =>
      key.startsWith("user") ||
      key.startsWith("friends") ||
      key.startsWith("chat_messages_") ||
      key.startsWith("chat_statuses_") ||
      key.startsWith("profile_") ||
      key.startsWith("profile_draft_") ||
      key.startsWith("livi.profile") ||
      key.startsWith("unread_") ||
      key.startsWith("message_") ||
      key === "missed_calls_by_user_v1" ||
      key.includes("userId") ||
      key.includes("installId") ||
      key.includes("avatar") ||
      key.includes("cache") ||
      key.includes("draft")
    );

    if (userDataKeys.length > 0) {
      await AsyncStorage.multiRemove(userDataKeys);
    }

    clearAllMessageCache();

    try {
      const { clearProfileStorage } = await import("../../utils/profileStorage");
      await clearProfileStorage();
    } catch (e) {
      console.warn("Failed to clear profile storage:", e);
    }

    try {
      const { clearAvatarCache } = await import("../../utils/avatarCache");
      await clearAvatarCache();
    } catch (e) {
      console.warn("Failed to clear avatar cache:", e);
    }

    shared.currentUserId = undefined;

    return { success: true };
  } catch (error) {
    console.error("Failed to clear user data:", error);
    return { success: false, error };
  }
}
