// frontend/sockets/modules/outboxBackgroundDrain.ts
import { AppState, NativeModules, Platform } from "react-native";

/**
 * Досылка очереди сообщений в фоне (Android). Повторы очереди — JS-таймеры, а RN не запускает их,
 * пока приложение свернуто, и Android замораживает фоновый процесс: сообщение, отправленное без сети
 * перед сворачиванием, уходило только по возвращении в LiVi. Пока очередь не пуста и приложение не на
 * экране, натив держит задание JobScheduler «есть сеть» (OutboxDrainJobService), которое будит JS
 * headless-задачей LiviOutboxDrain.
 */
let pending = false;

function syncNative(): void {
  if (Platform.OS !== "android") return;
  try {
    NativeModules.LiviAppModule?.syncOutboxBackgroundDrain?.(pending, AppState.currentState !== "active");
  } catch {}
}

export function noteMessageOutboxPending(next: boolean): void {
  if (next === pending) return;
  pending = next;
  syncNative();
}

try {
  AppState.addEventListener("change", syncNative);
} catch {}
