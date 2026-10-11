import { shared } from "./shared";
import { socket } from "./socketCore";

export function __flushPendingRtcSignals() {
  if (!socket.connected) return;
  if (!shared.pendingRtcSignals.length) return;
  const pending = shared.pendingRtcSignals.splice(0, shared.pendingRtcSignals.length);
  for (const item of pending) {
    try {
      socket.emit(item.event, item.payload);
    } catch {
      shared.pendingRtcSignals.unshift(item);
    }
  }
}

