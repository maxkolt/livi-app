/**
 * «Надёжные звонки» (Android): собственное соединение с сервером LiVi параллельно FCM.
 * Нативная часть — CallKeepAliveService / LiviCallKeepAliveModule, сервер — utils/callKeepAlive.ts.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppState, DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import { logger } from './logger';

export type CallKeepAliveStatus = 'off' | 'connecting' | 'connected' | 'waiting_network' | 'no_account';

export type CallKeepAliveState = {
  enabled: boolean;
  status: CallKeepAliveStatus;
  lastConnectedAt: number;
  vpnActive: boolean;
  notificationsEnabled: boolean;
};

const EVENT = 'LiviCallKeepAliveState';

type NativeCallKeepAlive = {
  setEnabled: (enabled: boolean) => Promise<CallKeepAliveState & { startAllowed?: boolean }>;
  getState: () => Promise<CallKeepAliveState>;
  ensureRunning: () => void;
};

const native: NativeCallKeepAlive | null =
  Platform.OS === 'android' ? ((NativeModules).LiviCallKeepAlive as NativeCallKeepAlive | undefined) ?? null : null;

/** Режим есть только там, где есть нативный сервис (Android). */
export const isCallKeepAliveSupported = !!native;

export async function getCallKeepAliveState(): Promise<CallKeepAliveState | null> {
  if (!native) return null;
  try {
    return await native.getState();
  } catch (e) {
    logger.warn('[callKeepAlive] getState failed', { error: (e as Error)?.message || String(e) });
    return null;
  }
}

export async function setCallKeepAliveEnabled(enabled: boolean): Promise<CallKeepAliveState | null> {
  if (!native) return null;
  try {
    const next = await native.setEnabled(enabled);
    logger.info('[callKeepAlive] set enabled', { enabled, startAllowed: next?.startAllowed, status: next?.status });
    return next;
  } catch (e) {
    logger.warn('[callKeepAlive] setEnabled failed', { enabled, error: (e as Error)?.message || String(e) });
    return null;
  }
}

/**
 * Из фона Android может не дать поднять сервис (после «убить приложение», ограничения
 * фонового старта) — при каждом выходе на передний план проверяем, что он запущен.
 */
export function ensureCallKeepAliveRunning(): void {
  try {
    native?.ensureRunning();
  } catch {}
}

/** Живое состояние режима для экрана: событие от сервиса + перечитывание при возврате в приложение. */
export function useCallKeepAliveState(active: boolean): {
  state: CallKeepAliveState | null;
  setEnabled: (enabled: boolean) => Promise<void>;
  refresh: () => void;
} {
  const [state, setState] = useState<CallKeepAliveState | null>(null);

  const refresh = useCallback(() => {
    void getCallKeepAliveState().then((next) => {
      if (next) setState(next);
    });
  }, []);

  useEffect(() => {
    if (!native || !active) return;
    refresh();
    const sub = DeviceEventEmitter.addListener(EVENT, (next: CallKeepAliveState) => {
      if (next && typeof next === 'object') setState(next);
    });
    // VPN и разрешение на уведомления меняют в системных настройках — перечитать по возврату.
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });
    return () => {
      sub.remove();
      appSub.remove();
    };
  }, [active, refresh]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    // Переключатель отвечает сразу, сервис догоняет событием.
    setState((prev) => (prev ? { ...prev, enabled, status: enabled ? 'connecting' : 'off' } : prev));
    const next = await setCallKeepAliveEnabled(enabled);
    if (next) setState(next);
    else refresh();
  }, [refresh]);

  return { state, setEnabled, refresh };
}
