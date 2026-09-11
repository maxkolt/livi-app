/**
 * Пункт 4: mutex system PiP ↔ in-app PiP.
 * Одновременно активен только один режим; in-app плашка не должна
 * перетираться native leave-hint флагом во время system PiP.
 *
 * Пункт 6: читает callRuntime (не сырые globals как политику).
 */
import { Platform } from 'react-native';
import {
  isPipForceHidden,
  isPipInSystemMode,
  isPipSuspendedForSystem,
  isPipVisible,
  isPendingSystemPiPSync,
} from './callRuntime';

export function isSystemPiPActiveOrEnteringSync(): boolean {
  if (Platform.OS !== 'android') return false;
  try {
    if (isPipInSystemMode()) return true;
    if (isPendingSystemPiPSync()) return true;
    const entryUntil = Number((global as any).__systemPiPEntryInProgressUntilRef?.current || 0);
    if (entryUntil > Date.now()) return true;
    return false;
  } catch {
    return false;
  }
}

export function isInAppPiPSuspendedForSystemSync(): boolean {
  try {
    return isPipSuspendedForSystem();
  } catch {
    return false;
  }
}

/** Плашка in-app «жива» для UI (не system, не suspend). */
export function isInAppPiPOverlayActiveSync(): boolean {
  try {
    if (isPipForceHidden()) return false;
    if (!isPipVisible()) return false;
    if (isInAppPiPSuspendedForSystemSync()) return false;
    if (isSystemPiPActiveOrEnteringSync()) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Нужно ли сообщать нативу «in-app PiP visible» для leave-hint.
 * Suspend / system enter → false, иначе dual PiP / гонка.
 */
export function shouldReportInAppPiPVisibleToNative(opts: {
  visible: boolean;
  inSystemPiPMode: boolean;
  pendingSystemPiP: boolean;
}): boolean {
  if (Platform.OS !== 'android') return false;
  if (opts.inSystemPiPMode || opts.pendingSystemPiP) return false;
  if (isInAppPiPSuspendedForSystemSync()) return false;
  if (isSystemPiPActiveOrEnteringSync()) return false;
  try {
    if (isPipForceHidden()) return false;
    const inAppFromContext = opts.visible;
    const inAppFromSyncRef = isPipVisible();
    return !!(inAppFromContext || inAppFromSyncRef);
  } catch {
    return false;
  }
}
