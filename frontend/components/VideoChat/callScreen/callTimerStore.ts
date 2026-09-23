/**
 * Длительность звонка живёт в глобальных ref'ах, а не в стейте компонента.
 *
 * Причина: VideoCall размонтируется и монтируется заново при уходе в PiP, возврате на
 * Home и повороте экрана. Если хранить отсчёт в стейте, таймер после каждого ремаунта
 * начинался бы с нуля. Глобальные ref'ы переживают ремаунт, а привязка к callId
 * гарантирует, что следующий звонок не подхватит время предыдущего.
 *
 * Вынесено из VideoCall.tsx: хуков здесь нет, это просто хранилище.
 */

type TimerRefs = {
  callId: { current: string };
  accept: { current: number };
  connected: { current: number | null };
};

export function normalizeTimerCallId(callId?: string | null): string {
  return String(callId || '').trim();
}

/**
 * Ref'ы таймера для этого звонка. Смена callId обнуляет отсчёт —
 * иначе новый звонок показал бы длительность предыдущего.
 */
export function getGlobalCallTimerRefs(callId?: string | null): TimerRefs {
  const g = global as any;
  const nextCallId = normalizeTimerCallId(callId);
  g.__callTimerCallIdRef = g.__callTimerCallIdRef || { current: '' };
  if (nextCallId && g.__callTimerCallIdRef.current !== nextCallId) {
    g.__callTimerCallIdRef.current = nextCallId;
    g.__acceptCallTimeRef = { current: 0 };
    g.__callConnectedAtRef = { current: null as number | null };
  }
  g.__acceptCallTimeRef = g.__acceptCallTimeRef || { current: 0 };
  g.__callConnectedAtRef = g.__callConnectedAtRef || { current: null as number | null };
  return {
    callId: g.__callTimerCallIdRef as { current: string },
    accept: g.__acceptCallTimeRef as { current: number },
    connected: g.__callConnectedAtRef as { current: number | null },
  };
}

/** Поднять отсчёт из глобального хранилища в ref'ы компонента (после ремаунта). */
export function syncCallTimerFromGlobal(
  acceptCallTimeRef: React.MutableRefObject<number>,
  callConnectedAtRef: React.MutableRefObject<number | null>,
  callId?: string | null,
): void {
  const requestedCallId = normalizeTimerCallId(callId);
  const { callId: globalCallId, accept, connected } = getGlobalCallTimerRefs(callId);
  if (requestedCallId && globalCallId.current !== requestedCallId) return;
  if (accept.current > 0) acceptCallTimeRef.current = accept.current;
  if (connected.current != null) callConnectedAtRef.current = connected.current;
}

/** Сохранить отсчёт, чтобы он пережил размонтирование компонента. */
export function persistCallTimerToGlobal(
  acceptCallTimeRef: React.MutableRefObject<number>,
  callConnectedAtRef: React.MutableRefObject<number | null>,
  callId?: string | null,
): void {
  const { accept, connected } = getGlobalCallTimerRefs(callId);
  if (acceptCallTimeRef.current > 0) accept.current = acceptCallTimeRef.current;
  if (callConnectedAtRef.current != null) connected.current = callConnectedAtRef.current;
}

/**
 * Сбросить таймер по завершении звонка.
 * Чужой callId игнорируем: поздний teardown предыдущего звонка не должен
 * обнулять отсчёт уже начавшегося нового.
 */
export function clearGlobalCallTimer(callId?: string | null): void {
  const g = global as any;
  const requestedCallId = normalizeTimerCallId(callId);
  const currentCallId = normalizeTimerCallId(g.__callTimerCallIdRef?.current || '');
  if (requestedCallId && currentCallId && requestedCallId !== currentCallId) return;
  g.__callTimerCallIdRef = g.__callTimerCallIdRef || { current: '' };
  g.__callTimerCallIdRef.current = '';
  g.__acceptCallTimeRef = { current: 0 };
  g.__callConnectedAtRef = { current: null as number | null };
}
