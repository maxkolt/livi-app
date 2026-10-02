/**
 * Свой дедлайн на signaling-фазу room.connect().
 *
 * livekit-client обещает websocketTimeout, но на адресе, который молча глотает пакеты
 * (VPN глушит домен LiveKit), room.connect() у нас не завершился ни успехом, ни ошибкой
 * за 49 с — до конца звонка, и fallback через /livekit proxy так и не запустился.
 * Если SignalConnected не пришёл за deadlineMs, отпускаем вызывающего ошибкой
 * signal-таймаута, а дальнейший исход SDK-шного промиса игнорируем.
 *
 * После SignalConnected дедлайн снимается: фазу PeerConnection сторожит сам SDK
 * (peerConnectionTimeout), и её ошибки уходят в relay-ретрай, а не в proxy.
 */

/** Совпадает с isLikelyLiveKitSignalError — recoverFromLiveKitConnectError уводит его в proxy. */
export const SIGNAL_WATCHDOG_ERROR = 'room connection has timed out (signal): client watchdog';

export type SignalWatchdogOptions = {
  connect: () => Promise<void>;
  /** Подписка на SignalConnected; возвращает отписку. */
  onSignalConnected: (listener: () => void) => () => void;
  deadlineMs: number;
  /** Вызывается один раз при срабатывании, до reject: тут бросают зависшую комнату. */
  onTimeout: () => void;
};

export function connectWithSignalWatchdog({
  connect,
  onSignalConnected,
  deadlineMs,
  onTimeout,
}: SignalWatchdogOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => {};

    const timer = setTimeout(() => {
      settle(() => {
        try {
          onTimeout();
        } catch {}
        reject(new Error(SIGNAL_WATCHDOG_ERROR));
      });
    }, deadlineMs);

    function settle(finish: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        unsubscribe();
      } catch {}
      finish();
    }

    unsubscribe = onSignalConnected(() => clearTimeout(timer));

    let connectPromise: Promise<void>;
    try {
      connectPromise = connect();
    } catch (e) {
      settle(() => reject(e));
      return;
    }
    connectPromise.then(
      () => settle(resolve),
      (e) => settle(() => reject(e)),
    );
  });
}
