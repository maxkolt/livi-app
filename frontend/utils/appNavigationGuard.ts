import { AppState, AppStateStatus } from 'react-native';
import { CommonActions } from '@react-navigation/native';
import { logger } from './logger';

let appState: AppStateStatus = AppState.currentState;
let guardInstalled = false;

export type RootNavLike = {
  isReady?: () => boolean;
  getCurrentRoute?: () => { name?: string; params?: Record<string, unknown> } | undefined;
  getState?: () => { routes?: { name?: string }[]; index?: number } | undefined;
  dispatch?: (action: any) => void;
  canGoBack?: () => boolean;
};

export function isAppForegroundForUi(): boolean {
  return appState === 'active';
}

export function isAppBackgroundOrInactive(): boolean {
  return appState === 'background' || appState === 'inactive';
}

export function installAppNavigationGuard(): void {
  if (guardInstalled) return;
  guardInstalled = true;
  appState = AppState.currentState;
  AppState.addEventListener('change', (next) => {
    appState = next;
  });
}

/** Не сбрасывать стек на Home, пока приложение не на экране (пользователь вернётся через recents). */
export function shouldSkipDestructiveNavWhileBackground(reason: string): boolean {
  if (!isAppBackgroundOrInactive()) return false;
  logger.debug('[navGuard] defer destructive nav (background)', { reason });
  return true;
}

/**
 * Бейдж «Вызов отменён» только на Home — без reset с Chat/других экранов.
 */
export function applyCallCancelledHomeNotice(nav: RootNavLike | null | undefined): void {
  if (!nav?.isReady?.()) return;
  const rn = String(nav.getCurrentRoute?.()?.name ?? '');
  if (rn === 'Home') {
    nav.dispatch?.(CommonActions.setParams({ callCancelled: true }));
  }
}

type LeaveVideoCallOpts = {
  callEndedParams?: boolean;
  emitCallEndedOnHome?: () => void;
};

/**
 * Закрыть только экран VideoCall; на Chat/Friends и т.д. стек не трогаем.
 */
export function leaveVideoCallScreenPreservingStack(
  nav: RootNavLike,
  opts?: LeaveVideoCallOpts,
): void {
  if (!nav.isReady?.()) return;
  const route = nav.getCurrentRoute?.();
  const routeName = String(route?.name ?? '');
  if (routeName === 'Home') return;
  if (routeName !== 'VideoCall') return;

  const returnTo = route?.params?.returnTo as { name?: string; params?: Record<string, unknown> } | undefined;
  const canGoBack = typeof nav.canGoBack === 'function' ? nav.canGoBack() : false;

  if (canGoBack) {
    nav.dispatch?.(CommonActions.goBack());
    try {
      opts?.emitCallEndedOnHome?.();
    } catch (_) {}
    return;
  }
  if (returnTo?.name) {
    nav.dispatch?.(
      CommonActions.reset({
        index: 0,
        routes: [
          {
            name: returnTo.name as never,
            params: {
              ...(returnTo.params || {}),
              ...(opts?.callEndedParams ? { callEnded: true } : {}),
            },
          },
        ],
      }),
    );
    return;
  }
  nav.dispatch?.(
    CommonActions.reset({
      index: 0,
      routes: [{ name: 'Home' as never, params: opts?.callEndedParams ? { callEnded: true } : {} }],
    }),
  );
}

/**
 * При возврате в приложение: убрать «мертвый» VideoCall через goBack, а не жёсткий reset на Home.
 */
export function dismissStaleVideoCallRouteIfNeeded(nav: RootNavLike): void {
  if (!nav.isReady?.()) return;
  const route = nav.getCurrentRoute?.();
  if (route?.name !== 'VideoCall') return;
  const g = global as typeof globalThis & Record<string, unknown>;
  const isInactiveCall = (g as any).__isInactiveStateRef?.current === true;
  const sessionEnded = (g as any).__webrtcSessionRef?.current?.ended === true;
  const endedFromPiP = (g as any).__lastEndCallSourceRef?.current === 'pip_close';
  if (!(isInactiveCall || sessionEnded) || endedFromPiP) return;
  leaveVideoCallScreenPreservingStack(nav);
}

/** Завершение звонка из PiP/endCall: на Home не уходим, если пользователь был на другом экране. */
export function endCallImplNavCleanup(nav: RootNavLike): void {
  if (!nav.isReady?.()) return;
  const routeName = String(nav.getCurrentRoute?.()?.name ?? '');
  if (routeName === 'VideoCall') {
    leaveVideoCallScreenPreservingStack(nav);
    return;
  }
  // Не VideoCall — сохраняем текущий экран (Chat, Home, …).
}

type PendingVideoCallNav = {
  params: Record<string, unknown>;
  at: number;
};

const PENDING_VIDEO_CALL_TTL_MS = 120_000;

/** call:accepted в фоне: не менять стек, пока пользователь не вернётся в приложение. */
export function stashPendingVideoCallNavigation(params: Record<string, unknown>): void {
  const g = global as typeof globalThis & Record<string, unknown>;
  (g as any).__pendingForegroundVideoCallNavRef = (g as any).__pendingForegroundVideoCallNavRef || {
    current: null as PendingVideoCallNav | null,
  };
  (g as any).__pendingForegroundVideoCallNavRef.current = { params, at: Date.now() };
}

export function flushPendingVideoCallNavigation(
  nav: RootNavLike & { navigate?: (name: string, params: Record<string, unknown>) => void },
): boolean {
  if (!isAppForegroundForUi()) return false;
  const g = global as typeof globalThis & Record<string, unknown>;
  const pending = (g as any).__pendingForegroundVideoCallNavRef?.current as PendingVideoCallNav | null;
  if (!pending?.params) return false;
  if (Date.now() - pending.at > PENDING_VIDEO_CALL_TTL_MS) {
    (g as any).__pendingForegroundVideoCallNavRef.current = null;
    return false;
  }
  if (!nav.isReady?.()) return false;
  if (String(nav.getCurrentRoute?.()?.name ?? '') === 'VideoCall') {
    (g as any).__pendingForegroundVideoCallNavRef.current = null;
    return false;
  }
  (g as any).__pendingForegroundVideoCallNavRef.current = null;
  try {
    nav.navigate?.('VideoCall', pending.params);
    return true;
  } catch (e) {
    logger.warn('[navGuard] flushPendingVideoCallNavigation failed', e);
    return false;
  }
}
