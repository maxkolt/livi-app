/**
 * Снятие блокировок, которыми экран звонка удерживал HomeScreen.
 *
 * Пока идёт звонок, Home держит собеседника и признак активного звонка; если не снять
 * их при выходе, список друзей останется с «занятым» собеседником до перезапуска.
 * Всё в try/catch: провал уборки не должен мешать завершению звонка.
 */

import { logger } from '../../../utils/logger';
import { setVideoCallActive } from '../../../utils/callRuntime';

export function clearVideoCallHomeScreenLocks(reason: string) {
  try {
    const g = global as any;
    if (!g.__videoCallPartnerUserIdRef) g.__videoCallPartnerUserIdRef = { current: null };
    else g.__videoCallPartnerUserIdRef.current = null;
    setVideoCallActive(false);
    g.__onVideoCallEndedRef?.current?.();
  } catch (e) {
    logger.warn('[VideoCall] clearVideoCallHomeScreenLocks failed', { reason, e });
  }
}
