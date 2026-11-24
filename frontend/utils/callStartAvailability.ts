import { useSyncExternalStore } from 'react';
import { getCallLifecycle, subscribeCallLifecycle } from './callLifecycle';
import { isDirectCallSessionLive, type DirectCallSnapshot } from '../screens/home/friendHelpers';

export function isCallStartBlocked(): boolean {
  const g = global as typeof global & DirectCallSnapshot & {
    __outgoingStartInFlightRef?: { current: boolean };
    __outgoingCallUiActiveRef?: { current: boolean };
    __outgoingCallScreenVisibleRef?: { current: boolean };
    __endingCallInProgressRef?: { current: boolean };
  };
  return getCallLifecycle().phase !== 'idle' || isDirectCallSessionLive(g) ||
    g.__outgoingStartInFlightRef?.current === true || g.__outgoingCallUiActiveRef?.current === true ||
    g.__outgoingCallScreenVisibleRef?.current === true || g.__endingCallInProgressRef?.current === true;
}

export function useCallStartBlocked(): boolean {
  const lifecycle = useSyncExternalStore(subscribeCallLifecycle, getCallLifecycle, getCallLifecycle);
  // Mutable cleanup refs may change after the idle publication without another
  // React notification. Visual state follows the authoritative lifecycle;
  // the imperative guard still checks those refs at the actual tap.
  return lifecycle.phase !== 'idle';
}
