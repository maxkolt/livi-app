/**
 * «Не отдавать звук обратно на телефон, пока Bluetooth ещё устаканивается».
 *
 * После того как наушники надели, InCallManager и нативный слой какое-то время
 * рапортуют EARPIECE: SCO ещё поднимается. Если применить такой отчёт буквально,
 * пользователь слышит разговор из телефона, хотя наушники уже на ушах, — а через
 * секунду звук прыгает обратно. Поэтому в этом окне встроенный маршрут не коммитим.
 *
 * Оба предиката жили двумя одинаковыми копиями внутри applySpecificRoute — в начале
 * и в конце конвейера. Разъехалась бы одна копия, и звук начал бы срываться в одном
 * из двух путей, причём воспроизводится это только на живых наушниках.
 */

import type { InCallAudioRoute } from '../audioRouteTypes';

/** Сколько после применения BT считаем, что маршрут ещё не устаканился. */
export const BT_SETTLING_WINDOW_MS = 5000;

/**
 * Можно ли вообще подменять этот маршрут.
 * Встроенный маршрут подменяем только если его не выбрал пользователь и он не
 * следствие отключения гарнитуры.
 */
export function isBuiltInRouteCoercible(
  route: InCallAudioRoute,
  reason: string,
  checks: {
    isHeadsetDisconnectFallbackReason: (reason: string) => boolean;
    isExplicitBuiltInRouteChoice: (reason: string, route: InCallAudioRoute) => boolean;
  },
): boolean {
  if (route !== 'EARPIECE' && route !== 'SPEAKER_PHONE') return false;
  if (checks.isHeadsetDisconnectFallbackReason(reason)) return false;
  if (reason.startsWith('cycle') || reason.startsWith('toggle')) return false;
  return !checks.isExplicitBuiltInRouteChoice(reason, route);
}

/** Идёт ли сейчас окно, в котором BT-маршрут нужно удерживать. */
export function isBluetoothSettlingWindow(input: {
  now?: number;
  lastBluetoothApplyAt: number;
  wearSticky: boolean;
  wearReconnectInFlight: boolean;
}): boolean {
  if (input.wearSticky) return true;
  if (input.wearReconnectInFlight) return true;
  const now = input.now ?? Date.now();
  return now - input.lastBluetoothApplyAt < BT_SETTLING_WINDOW_MS;
}
