// frontend/sockets/modules/outboxTriggers.ts
import { AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { drainEditOutbox, drainMessageOutbox } from "./outbox";
import { drainReactionOutbox } from "./reactionOutbox";

/** Сообщения → правки → реакции: правки и реакции могут ждать доставки своего сообщения. */
export function drainAllOutboxes(): Promise<void> {
  return drainMessageOutbox()
    .catch(() => {})
    .then(() => drainEditOutbox())
    .catch(() => {})
    .then(() => drainReactionOutbox())
    .catch(() => {});
}

/** Холодный старт: даём boot подключиться, а если сокет не поднимется (VPN), очередь уйдёт по HTTP. */
const COLD_START_DRAIN_DELAY_MS = 3000;
/** Сеть только что вернулась: маршрут ещё прогревается. */
const NETWORK_BACK_DRAIN_DELAY_MS = 600;

try {
  let lastReachable: boolean | null = null;
  NetInfo.addEventListener((state) => {
    const reachable = state.isConnected === true && state.isInternetReachable !== false;
    const wasReachable = lastReachable;
    lastReachable = reachable;
    if (!reachable) return;
    // Режим полёта, лифт, VPN: не ждём connect сокета — пока он переподнимается, HTTP уже пройдёт.
    if (wasReachable === false) {
      setTimeout(() => void drainAllOutboxes(), NETWORK_BACK_DRAIN_DELAY_MS);
    } else if (wasReachable === null) {
      setTimeout(() => void drainAllOutboxes(), COLD_START_DRAIN_DELAY_MS);
    }
  });
} catch {}

try {
  AppState.addEventListener("change", (state) => {
    if (state === "active") void drainAllOutboxes();
  });
} catch {}
