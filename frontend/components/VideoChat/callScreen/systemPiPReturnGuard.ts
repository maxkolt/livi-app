/**
 * Состояние возврата из системного PiP.
 *
 * Возврат — не мгновенное событие: Android отдаёт активность обратно раньше, чем
 * восстановятся стримы и аудио-маршрут. В этом промежутке нельзя ни рвать звонок по
 * «потере» медиа, ни считать ремаунт новым звонком. Поэтому вокруг возврата живёт
 * несколько окон, а у самого возврата есть токен: он отличает текущий возврат от
 * предыдущего, чей хвост ещё догорает в глобалах.
 *
 * Вынесено из VideoCall.tsx: это чтение глобалов от переданного токена, хуков нет.
 */

/** Незавершённый restore не должен «залипнуть» навсегда — ограничиваем по возрасту токена. */
const SYSTEM_PIP_RETURN_RESTORE_MAX_MS = 8000;

/** Состояние текущего возврата, либо null, если токен не совпал или возврата нет. */
export function readSystemPiPReturnState(token: number): any {
  if (!token) return null;
  const g = global as any;
  const current = g.__systemPiPReturnStateRef?.current;
  if (!current || Number(current.token || 0) !== token) {
    return null;
  }
  return current;
}

/** Идёт ли сейчас возврат из системного PiP и какие окна ещё активны. */
export function readSystemPiPReturnGuard(token: number) {
  const g = global as any;
  const now = Date.now();
  const returningUntil = Number(g.__returningFromSystemPiPUntilRef?.current || 0);
  const disableUntil = Number(g.__disableSystemPiPUntilRef?.current || 0);
  const suppressAbortUntil = Number(g.__suppressAbortDuringSystemPiPReturnUntilRef?.current || 0);
  const currentReturnToken = token;
  const returnState = currentReturnToken ? g.__systemPiPReturnStateRef?.current : null;
  const activeReturnState =
    returnState && Number(returnState.token || 0) === currentReturnToken ? returnState : null;
  // token is Date.now() at expand — cap incomplete restore so owner/restoredAt can't stick forever.
  const SYSTEM_PIP_RETURN_RESTORE_MAX_MS = 8000;
  const returnTokenAt = Number(activeReturnState?.token || 0);
  const returnRestoreAgedOut =
    !!activeReturnState &&
    returnTokenAt > 0 &&
    now - returnTokenAt > SYSTEM_PIP_RETURN_RESTORE_MAX_MS;
  if (returnRestoreAgedOut) {
    try {
      if (g.__systemPiPReturnStateRef?.current === activeReturnState) {
        g.__systemPiPReturnStateRef.current = null;
      }
    } catch (_) {}
  }
  const returnRestoreInFlight =
    !!activeReturnState &&
    !returnRestoreAgedOut &&
    (!activeReturnState.owner ||
      !activeReturnState.restoredAt ||
      now < Number(activeReturnState.settledUntil || 0));
  return {
    now,
    returningUntil,
    disableUntil,
    suppressAbortUntil,
    currentReturnToken,
    returnRestoreInFlight,
    returnRestoreOwner: activeReturnState?.owner ?? null,
    returnSettledUntil: Number(activeReturnState?.settledUntil || 0),
    active: now < returningUntil || now < disableUntil || now < suppressAbortUntil || returnRestoreInFlight,
  };
}
