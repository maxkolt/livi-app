import { AppState, NativeModules, Platform } from 'react-native';

/**
 * Тёплые соединения к API для WebSocket'ов (Android, WarmConnections.kt).
 *
 * Через VPN с выходом за рубежом новое TLS-соединение к нашему серверу в РФ иногда
 * открывается 15–30 с, а уже открытое отвечает за ~0.2 с. Натив держит в общем пуле
 * WebSocket'ов готовые соединения к API, и сигналинг LiveKit (через /livekit) и socket.io
 * поднимаются по ним. Соединение, простоявшее дольше 50 с, за VPN может быть уже мёртвым,
 * поэтому пока приложение на экране, освежаем их каждые KEEPALIVE_MS.
 */

const KEEPALIVE_MS = 30_000;

type LiviWarmModule = {
  prewarmApiConnections?: (reason: string, count: number) => void;
  cancelPendingLiveKitSignal?: (reason: string) => void;
};

/** Открыть/освежить count соединений к API заранее — до звонка, сокета, сигналинга. */
export function prewarmApiConnections(reason: string, count = 2): void {
  if (Platform.OS !== 'android') return;
  try {
    (NativeModules.LiviAppModule as LiviWarmModule | undefined)?.prewarmApiConnections?.(reason, count);
  } catch {}
}

/**
 * Брошенная сторожем попытка сигналинга LiveKit: отменить её зависшее TLS-рукопожатие.
 * Иначе оно позже доходит до SFU с тем же identity и выбивает следующую, уже рабочую
 * попытку (DUPLICATE_IDENTITY по кругу через VPN).
 */
export function cancelPendingLiveKitSignalConnects(reason: string): void {
  if (Platform.OS !== 'android') return;
  try {
    (NativeModules.LiviAppModule as LiviWarmModule | undefined)?.cancelPendingLiveKitSignal?.(reason);
  } catch {}
}

/** Пока приложение на экране, соединения к API остаются свежими. Возвращает отписку. */
export function startApiConnectionKeeper(): () => void {
  if (Platform.OS !== 'android') return () => {};
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (timer) return;
    prewarmApiConnections('foreground');
    timer = setInterval(() => prewarmApiConnections('keepalive'), KEEPALIVE_MS);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  if (AppState.currentState === 'active') start();
  const sub = AppState.addEventListener('change', (state) => (state === 'active' ? start() : stop()));
  return () => {
    stop();
    sub.remove();
  };
}
