/**
 * Deferred invite link: Play Install Referrer + clipboard fallback,
 * pending storage until accept/decline.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { NativeModules, Platform } from 'react-native';
import { logger } from './logger';

export const INVITE_LINK_STORAGE_KEY = 'pending_invite_code';
export const INVITE_CLIPBOARD_PREFIX = 'livi-invite:';

const OID_RE = /^[a-f\d]{24}$/i;

type SettledListener = () => void;
const settledListeners = new Set<SettledListener>();

export function onInviteFlowSettled(cb: SettledListener): () => void {
  settledListeners.add(cb);
  return () => {
    settledListeners.delete(cb);
  };
}

export function emitInviteFlowSettled() {
  for (const l of settledListeners) {
    try {
      l();
    } catch {}
  }
}

export function isInviteOid(code: string | null | undefined): code is string {
  return !!code && OID_RE.test(String(code).trim());
}

export function parseInviteCodeFromStorageValue(saved: string | null): string | null {
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved);
    const code = typeof parsed === 'string' ? parsed : parsed?.code;
    return isInviteOid(code) ? String(code) : null;
  } catch {
    return isInviteOid(saved) ? saved : null;
  }
}

export async function getPendingInviteCode(): Promise<string | null> {
  try {
    const saved = await AsyncStorage.getItem(INVITE_LINK_STORAGE_KEY);
    return parseInviteCodeFromStorageValue(saved);
  } catch {
    return null;
  }
}

export async function savePendingInviteCode(code: string): Promise<void> {
  if (!isInviteOid(code)) return;
  await AsyncStorage.setItem(INVITE_LINK_STORAGE_KEY, String(code).trim());
}

export async function clearPendingInviteCode(): Promise<void> {
  try {
    await AsyncStorage.removeItem(INVITE_LINK_STORAGE_KEY);
  } catch {}
  if (Platform.OS === 'android') {
    try {
      await NativeModules.LiviAppModule?.clearInstallInviteCode?.();
    } catch {}
  }
  emitInviteFlowSettled();
}

/** Play Install Referrer (once) → invite code. */
async function readInstallReferrerInviteCode(): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  try {
    const code = await NativeModules.LiviAppModule?.getPendingInstallInviteCode?.();
    return isInviteOid(code) ? String(code).trim() : null;
  } catch (e) {
    logger.warn('[invite] Install referrer read failed', e);
    return null;
  }
}

/** Clipboard fallback written by invite.html before Play Store redirect. */
async function readClipboardInviteCode(): Promise<string | null> {
  try {
    const text = String((await Clipboard.getStringAsync()) || '').trim();
    if (!text.startsWith(INVITE_CLIPBOARD_PREFIX)) return null;
    const code = text.slice(INVITE_CLIPBOARD_PREFIX.length).trim();
    if (!isInviteOid(code)) return null;
    try {
      await Clipboard.setStringAsync('');
    } catch {}
    return code;
  } catch {
    return null;
  }
}

/**
 * Capture deferred invite into AsyncStorage if not already pending.
 * Safe to call multiple times.
 */
export async function captureDeferredInviteCode(): Promise<string | null> {
  const existing = await getPendingInviteCode();
  if (existing) return existing;

  const fromReferrer = await readInstallReferrerInviteCode();
  if (fromReferrer) {
    await savePendingInviteCode(fromReferrer);
    logger.info('[invite] Captured invite from install referrer', { code: fromReferrer });
    return fromReferrer;
  }

  const fromClipboard = await readClipboardInviteCode();
  if (fromClipboard) {
    await savePendingInviteCode(fromClipboard);
    logger.info('[invite] Captured invite from clipboard', { code: fromClipboard });
    return fromClipboard;
  }

  return null;
}

export function buildPlayStoreInviteUrl(code: string): string {
  const referrer = encodeURIComponent(`invite=${code}`);
  return `https://play.google.com/store/apps/details?id=com.kolt12max.livi&hl=ru&referrer=${referrer}`;
}
