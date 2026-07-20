// frontend/sockets/modules/authState.ts
import { shared } from "./shared";

export type { SocketReauthResponse } from "./types";
export { REAUTH_FRESH_MS } from "./reauthConstants";

type CurrentUserIdListener = (userId: string | undefined) => void;
const __currentUserIdListeners = new Set<CurrentUserIdListener>();

export function __notifyCurrentUserId() {
  try {
    for (const cb of __currentUserIdListeners) {
      try {
        cb(shared.currentUserId);
      } catch {}
    }
  } catch {}
}

export function onCurrentUserId(cb: CurrentUserIdListener): () => void {
  try {
    cb(shared.currentUserId);
  } catch {}
  __currentUserIdListeners.add(cb);
  return () => {
    __currentUserIdListeners.delete(cb);
  };
}

export function getCurrentUserId(): string | undefined {
  return shared.currentUserId;
}
