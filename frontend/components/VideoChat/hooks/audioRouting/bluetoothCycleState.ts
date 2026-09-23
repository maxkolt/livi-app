/**
 * Окна и флаги вокруг Bluetooth-гарнитуры во время звонка.
 *
 * Всё это существует из-за одной особенности TWS-наушников: они постоянно рвут и
 * поднимают соединение — при одевании, при снятии одного уха, при возврате в кейс.
 * Если реагировать на каждое событие буквально, звук скачет между наушниками и
 * телефоном, а кнопка выбора маршрута мигает. Поэтому вокруг каждого события стоит
 * короткое окно, в течение которого мы держим прежнее решение.
 *
 * Состояние намеренно живёт в глобальных ref'ах, а не в стейте хука: экран звонка
 * пересоздаётся при PiP и повороте, а гарнитура при этом остаётся на ушах.
 *
 * Вынесено из useAudioRouting.ts: хуков здесь нет.
 */

import { isBluetoothHeadsetActiveForCall } from '../../../../utils/nativeCallAudioProbe';

/** Окно после снятия BT, пока подавляем автоматический возврат на него. */
const BT_AUTO_SUPPRESS_MS = 12000;
/** Окно после одевания, пока UI держит BT, хотя SCO ещё поднимается. */
const BT_WEAR_STICKY_MS = 8000;
/** TWS часто шлёт disconnect прямо перед connect — столько ждём reconnect. */
const BT_EXPECT_RECONNECT_MS = 10000;
/** Игнор ACL/SCO-дребезга сразу после применения BT-маршрута. */
const BT_SCO_SETTLE_MS = 2500;

export function readBtAutoSuppressUntil(): number {
  try {
    return Number((global as any).__btAutoSuppressUntilRef?.current || 0);
  } catch {
    return 0;
  }
}

export function armBtAutoSuppress(ms = BT_AUTO_SUPPRESS_MS): void {
  const until = Date.now() + ms;
  try {
    (global as any).__btAutoSuppressUntilRef = { current: until };
  } catch {}
}

export function clearBtAutoSuppress(): void {
  try {
    (global as any).__btAutoSuppressUntilRef = { current: 0 };
  } catch {}
}

/**
 * Ручной cycle BT→ухо/громкая рвёт SCO, но buds ещё на ушах — BT оставляем в кнопке.
 * Сброс только на физический unplug / кейс.
 */
export function armBtKeepInCycleAfterManualLeave(): void {
  try {
    (global as any).__btKeepInCycleAfterManualLeaveRef = { current: true };
    (global as any).__btRemovedFromCycleByUnplugRef = { current: false };
  } catch {}
}

export function clearBtKeepInCycleAfterManualLeave(): void {
  try {
    (global as any).__btKeepInCycleAfterManualLeaveRef = { current: false };
  } catch {}
}

export function isBtKeepInCycleAfterManualLeave(): boolean {
  try {
    return !!(global as any).__btKeepInCycleAfterManualLeaveRef?.current;
  } catch {
    return false;
  }
}

export function markBtRemovedFromCycleByUnplug(): void {
  try {
    (global as any).__btRemovedFromCycleByUnplugRef = { current: true };
    (global as any).__btKeepInCycleAfterManualLeaveRef = { current: false };
  } catch {}
}

export function clearBtRemovedFromCycleByUnplug(): void {
  try {
    (global as any).__btRemovedFromCycleByUnplugRef = { current: false };
  } catch {}
}

export function isBtRemovedFromCycleByUnplug(): boolean {
  try {
    return !!(global as any).__btRemovedFromCycleByUnplugRef?.current;
  } catch {
    return false;
  }
}

/** BT в цикле кнопки: live / wear / ручной уход с BT (buds ещё надеты). Не paired-in-case после unplug. */
export function shouldShowBluetoothInCycle(opts?: {
  userRoute?: string | null;
  lastApplied?: string | null;
  wearInFlight?: boolean;
}): boolean {
  if (isBtRemovedFromCycleByUnplug()) return false;
  if (isBluetoothHeadsetActiveForCall()) return true;
  if (opts?.userRoute === 'BLUETOOTH' || opts?.lastApplied === 'BLUETOOTH') return true;
  if (opts?.wearInFlight) return true;
  if (isBtWearStickyActive() || isBtKeepInCycleAfterManualLeave()) return true;
  return false;
}

/** После wear: UI hold пока SCO поднимается (не путать с unplug). */
export function armBtWearSticky(ms = BT_WEAR_STICKY_MS): void {
  const until = Date.now() + ms;
  try {
    const prev = Number((global as any).__btWearStickyUntilRef?.current || 0);
    (global as any).__btWearStickyUntilRef = { current: Math.max(prev, until) };
  } catch {}
}

export function clearBtWearSticky(): void {
  try {
    (global as any).__btWearStickyUntilRef = { current: 0 };
  } catch {}
}

export function isBtWearStickyActive(): boolean {
  try {
    return Date.now() < Number((global as any).__btWearStickyUntilRef?.current || 0);
  } catch {
    return false;
  }
}

/** TWS: disconnect часто перед connect при одевании — ждём reconnect, не гасить SCO EAR-repin. */
export function armExpectBtReconnect(ms = BT_EXPECT_RECONNECT_MS): void {
  const until = Date.now() + ms;
  try {
    const prev = Number((global as any).__btExpectReconnectUntilRef?.current || 0);
    (global as any).__btExpectReconnectUntilRef = { current: Math.max(prev, until) };
  } catch {}
}

export function clearExpectBtReconnect(): void {
  try {
    (global as any).__btExpectReconnectUntilRef = { current: 0 };
  } catch {}
}

export function isExpectBtReconnectActive(): boolean {
  try {
    return Date.now() < Number((global as any).__btExpectReconnectUntilRef?.current || 0);
  } catch {
    return false;
  }
}

/** Короткое окно: игнор ACL/SCO flap при одевании (не блокировать реальное снятие). */
export function isBtScoSettleActive(lastBtApplyAt: number, ms = BT_SCO_SETTLE_MS): boolean {
  const last = Math.max(
    lastBtApplyAt,
    Number((global as any).__lastBluetoothRouteApplyAtRef?.current || 0),
  );
  return Date.now() - last < ms;
}

/** После снятия BT: блокировать sticky reconnect, кроме нового физического connect. */
export function shouldSuppressBluetoothAutoReconnect(reason: string): boolean {
  if (Date.now() >= readBtAutoSuppressUntil()) return false;
  // Только физический connect — не expect_* (иначе кейс → expect → снова BT).
  if (
    /acl_connected|profile_connected|device_added|a2dp_connected|_rising/.test(reason) &&
    !/expect/.test(reason)
  ) {
    clearBtAutoSuppress();
    return false;
  }
  // audio_connected / poll / expect после снятия — нет (иначе bounce обратно на BT).
  return true;
}
