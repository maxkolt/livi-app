import { AppState, AppStateStatus } from 'react-native';
import { CommonActions, StackActions } from '@react-navigation/native';
import { logger } from './logger';
import { clearStaleInAppPiPAudioContextForFreshCallNav } from './callAudioRoutePersist';
import { readSafeRootNavigation } from './safeRootNavigation';

export { readRootCurrentRouteName, readRootCurrentRoute, readRootNavigationState } from './safeRootNavigation';

let appState: AppStateStatus = AppState.currentState;
let guardInstalled = false;

export type RootNavLike = {
  isReady?: () => boolean;
  getCurrentRoute?: () => { name?: string; params?: object } | undefined;
  getState?: () => { routes?: ReadonlyArray<{ name?: string; params?: object }>; index?: number } | undefined;
  dispatch?: (...args: any[]) => any;
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

  const routeParams = route?.params as Record<string, unknown> | undefined;
  const returnTo = routeParams?.returnTo as { name?: string; params?: Record<string, unknown> } | undefined;
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
  nav: RootNavLike & { navigate?: (...args: any[]) => any },
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
  return navigateToVideoCallScreen(nav, pending.params, 'flush_pending');
}

const VIDEO_CALL_NAV_DEDUP_MS = 6000;
const recentVideoCallNavAt = new Map<string, number>();

const FRESH_VIDEO_CALL_NAV_REASONS = new Set([
  'incoming_navigate',
  'call_accepted',
  'flush_pending',
]);

/** Не тащить fromPiP/resume с прошлого VideoCall при новом входящем / call:accepted. */
export function stripStalePiPReturnNavParams(
  params: Record<string, unknown>,
  reason?: string,
): Record<string, unknown> {
  if (!reason || !FRESH_VIDEO_CALL_NAV_REASONS.has(reason)) {
    return params;
  }
  const next = { ...params };
  delete next.fromPiP;
  delete next.resume;
  delete next.audioOnlyPiPReturn;
  delete next.preferVideoCallUi;
  // merge: true оставляет старые ключи — явно сбрасываем.
  return {
    ...next,
    fromPiP: undefined,
    resume: undefined,
    audioOnlyPiPReturn: undefined,
    preferVideoCallUi: undefined,
  };
}

export type VideoCallNavLike = RootNavLike & {
  navigate?: (...args: any[]) => any;
};

function readRouteCallId(route: { params?: object } | undefined): string {
  return String((route?.params as Record<string, unknown> | undefined)?.callId ?? '').trim();
}

/** Снять лишние VideoCall с тем же callId в стеке (гонка incoming_navigate + call_accepted). */
function focusExistingVideoCallInStack(
  nav: VideoCallNavLike,
  callId: string,
  params: Record<string, unknown>,
  reason?: string,
): boolean {
  if (!callId) return false;
  const state = nav.getState?.();
  const routes = state?.routes ?? [];
  if (!routes.length) return false;
  const topIdx = state?.index ?? routes.length - 1;
  const sameIdIdx = routes.findIndex(
    (r) => r.name === 'VideoCall' && readRouteCallId(r) === callId,
  );
  if (sameIdIdx < 0) return false;

  if (topIdx > sameIdIdx) {
    const popCount = topIdx - sameIdIdx;
    try {
      nav.dispatch?.(StackActions.pop(popCount));
      logger.info('[navGuard] VideoCall popped duplicate stack entries', {
        callId,
        reason,
        popCount,
        sameIdIdx,
        topIdx,
      });
    } catch (e) {
      logger.warn('[navGuard] VideoCall pop duplicate failed', { callId, reason, e });
    }
  }
  try {
    nav.dispatch?.(CommonActions.setParams({ ...params }));
  } catch (_) {}
  logger.info('[navGuard] VideoCall focused existing stack entry', { callId, reason, sameIdIdx });
  return true;
}

/** Один экран VideoCall на callId: merge params вместо второго push/mount. */
export function navigateToVideoCallScreen(
  nav: VideoCallNavLike,
  params: Record<string, unknown>,
  reason?: string,
): boolean {
  if (!nav.isReady?.()) return false;
  const safeParams = stripStalePiPReturnNavParams(params, reason);
  if (reason) {
    clearStaleInAppPiPAudioContextForFreshCallNav(reason);
  }
  const callId = String(safeParams.callId ?? '').trim();
  const current = nav.getCurrentRoute?.();
  const currentName = String(current?.name ?? '');
  const currentCallId = readRouteCallId(current);

  if (callId && focusExistingVideoCallInStack(nav, callId, safeParams, reason)) {
    return true;
  }

  if (currentName === 'VideoCall') {
    if (!callId || !currentCallId || currentCallId === callId) {
      try {
        nav.dispatch?.(CommonActions.setParams({ ...safeParams }));
      } catch (_) {}
      logger.info('[navGuard] VideoCall already active — params merged', { callId, reason });
      return true;
    }
  }

  if (callId) {
    const marked = recentVideoCallNavAt.get(callId);
    if (marked && Date.now() - marked < VIDEO_CALL_NAV_DEDUP_MS) {
      if (currentName === 'VideoCall' && (!currentCallId || currentCallId === callId)) {
        try {
          nav.dispatch?.(CommonActions.setParams({ ...safeParams }));
        } catch (_) {}
        logger.info('[navGuard] VideoCall nav deduped (recent active)', { callId, reason });
        return true;
      }
      logger.info('[navGuard] VideoCall nav deduped (recent pending)', {
        callId,
        reason,
        currentName,
        currentCallId,
      });
      return true;
    }
    recentVideoCallNavAt.set(callId, Date.now());
    setTimeout(() => recentVideoCallNavAt.delete(callId), VIDEO_CALL_NAV_DEDUP_MS);
  }

  const state = nav.getState?.();
  const routes = state?.routes ?? [];
  const topIdx = state?.index ?? routes.length - 1;
  if (callId && routes.length >= 1) {
    const existingIdx = routes.findIndex(
      (r) =>
        r.name === 'VideoCall' &&
        String((r.params as Record<string, unknown> | undefined)?.callId ?? '').trim() ===
          callId,
    );
    if (existingIdx >= 0) {
      try {
        nav.dispatch?.(
          CommonActions.navigate({
            name: 'VideoCall',
            params: safeParams,
            merge: true,
          }),
        );
        logger.info('[navGuard] VideoCall navigate — existing stack entry', {
          callId,
          reason,
          existingIdx,
          topIdx,
        });
        return true;
      } catch (e) {
        logger.warn('[navGuard] VideoCall pop-to-existing failed', { callId, reason, e });
      }
    }
  }

  try {
    nav.navigate?.('VideoCall', safeParams);
    logger.info('[navGuard] VideoCall navigate', { callId, reason });
    return true;
  } catch (e) {
    logger.warn('[navGuard] VideoCall navigate failed', { callId, reason, e });
    return false;
  }
}

export function readAppRootNavigation(): RootNavLike | null {
  return readSafeRootNavigation() as RootNavLike | null;
}

const ROOT_NAV_RETRY_FRAMES = 45;

function runWhenRootNavigationReady(run: (nav: RootNavLike) => void): boolean {
  const nav = readAppRootNavigation();
  if (nav) {
    run(nav);
    return true;
  }
  let frames = 0;
  const tick = () => {
    const n = readAppRootNavigation();
    if (n) {
      run(n);
      return;
    }
    frames += 1;
    if (frames >= ROOT_NAV_RETRY_FRAMES) {
      logger.warn('[navGuard] root navigation not ready after retries');
      return;
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(tick);
    } else {
      setTimeout(tick, 16);
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(tick);
  } else {
    setTimeout(tick, 16);
  }
  return false;
}

function mergeActiveVideoCallParamsOnNav(
  nav: RootNavLike,
  params: Record<string, unknown>,
): boolean {
  try {
    if (String(nav.getCurrentRoute?.()?.name ?? '') === 'VideoCall') {
      nav.dispatch?.(CommonActions.setParams(params));
    } else {
      nav.dispatch?.(
        CommonActions.navigate({
          name: 'VideoCall' as never,
          params,
          merge: true,
        }),
      );
    }
    return true;
  } catch (e) {
    logger.warn('[navGuard] mergeActiveVideoCallParams failed', { e });
    return false;
  }
}

/** setParams на VideoCall через root ref (не бросает, если hook navigation ещё не инициализирован). */
export function mergeActiveVideoCallParams(params: Record<string, unknown>): boolean {
  const nav = readAppRootNavigation();
  if (nav) {
    return mergeActiveVideoCallParamsOnNav(nav, params);
  }
  runWhenRootNavigationReady((n) => {
    mergeActiveVideoCallParamsOnNav(n, params);
  });
  return false;
}

function goBackFromCallScreenOrHomeOnNav(
  nav: RootNavLike,
  returnTo?: { name: string; params?: object },
): boolean {
  try {
    if (typeof nav.canGoBack === 'function' && nav.canGoBack()) {
      nav.dispatch?.(CommonActions.goBack());
      return true;
    }
    if (returnTo?.name) {
      nav.dispatch?.(
        CommonActions.reset({
          index: 0,
          routes: [{ name: returnTo.name as never, params: returnTo.params ?? {} }],
        }),
      );
      return true;
    }
    nav.dispatch?.(
      CommonActions.reset({ index: 0, routes: [{ name: 'Home' as never }] }),
    );
    return true;
  } catch (e) {
    logger.warn('[navGuard] goBackFromCallScreenOrHome failed', { e });
    return false;
  }
}

/** goBack / Home без useNavigation() — для PiP и remount VideoCall. */
export function goBackFromCallScreenOrHome(returnTo?: {
  name: string;
  params?: object;
}): boolean {
  const nav = readAppRootNavigation();
  if (nav) {
    return goBackFromCallScreenOrHomeOnNav(nav, returnTo);
  }
  runWhenRootNavigationReady((n) => {
    goBackFromCallScreenOrHomeOnNav(n, returnTo);
  });
  return false;
}

/** Сброс одноразовых params на Home через root ref (без hook navigation). */
export function clearHomeTransientRouteParams(): boolean {
  const tryClear = (nav: RootNavLike): boolean => {
    if (String(nav.getCurrentRoute?.()?.name ?? '') !== 'Home') return false;
    try {
      nav.dispatch?.(
        CommonActions.setParams({
          callEnded: undefined,
          callCancelled: undefined,
          openFriendsMenu: undefined,
          openFriendsTab: undefined,
          pushMessageFrom: undefined,
        }),
      );
      return true;
    } catch (e) {
      logger.warn('[navGuard] clearHomeTransientRouteParams failed', { e });
      return false;
    }
  };
  const nav = readAppRootNavigation();
  if (nav) {
    return tryClear(nav);
  }
  runWhenRootNavigationReady((n) => {
    tryClear(n);
  });
  return false;
}

export type LeaveVideoCallScreenOpts = {
  returnTo?: { name: string; params?: object };
  callEnded?: boolean;
};

/**
 * Закрыть экран звонка: goBack на Home/предыдущий экран (без remount — нет мерцания аватара),
 * reset только если нельзя назад или в стеке несколько VideoCall.
 */
export function dispatchLeaveVideoCallScreen(
  nav: RootNavLike,
  opts?: LeaveVideoCallScreenOpts,
): void {
  if (!nav.isReady?.()) return;
  const route = nav.getCurrentRoute?.();
  if (String(route?.name ?? '') !== 'VideoCall') return;

  const state = nav.getState?.();
  const routes = state?.routes ?? [];
  const topIdx = state?.index ?? routes.length - 1;
  const videoCallCount = routes.filter((r) => r.name === 'VideoCall').length;
  const routeParams = (route?.params ?? {}) as Record<string, unknown>;
  const returnTo =
    opts?.returnTo ??
    (routeParams.returnTo as LeaveVideoCallScreenOpts['returnTo'] | undefined);
  const callEnded = opts?.callEnded !== false;
  const endedParams = callEnded ? { callEnded: true } : {};
  const canGoBack = typeof nav.canGoBack === 'function' ? nav.canGoBack() : false;

  if (returnTo?.name) {
    nav.dispatch?.(
      CommonActions.reset({
        index: 0,
        routes: [
          {
            name: returnTo.name as never,
            params: { ...(returnTo.params || {}), ...endedParams },
          },
        ],
      }),
    );
    return;
  }

  if (videoCallCount > 1 && topIdx > 0) {
    const firstVcIdx = routes.findIndex((r) => r.name === 'VideoCall');
    if (firstVcIdx >= 0 && topIdx > firstVcIdx) {
      try {
        nav.dispatch?.(StackActions.pop(topIdx - firstVcIdx));
      } catch (e) {
        logger.warn('[navGuard] leave VideoCall — pop duplicates failed', { e, videoCallCount });
      }
    }
  }

  const canGoBackAfterPop =
    typeof nav.canGoBack === 'function' ? nav.canGoBack() : canGoBack;
  if (canGoBackAfterPop) {
    nav.dispatch?.(CommonActions.goBack());
    logger.info('[navGuard] leave VideoCall — goBack', {
      routesLength: routes.length,
      videoCallCount,
    });
    return;
  }

  nav.dispatch?.(
    CommonActions.reset({
      index: 0,
      routes: [{ name: 'Home' as never, params: {} }],
    }),
  );
  logger.info('[navGuard] leave VideoCall — reset Home', {
    routesLength: routes.length,
    videoCallCount,
  });
}
