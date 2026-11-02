import { memo, useEffect, useRef } from 'react';
import { AppState, Keyboard, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCurrentUserId, onCurrentUserId } from '../sockets/modules/authState';
import { getCallLifecycle, subscribeCallLifecycle } from '../utils/callLifecycle';
import { isPipVisible, isVideoCallActive } from '../utils/callRuntime';
import { AppReviewPolicy } from '../utils/appReviewPolicy';
import { cancelAppReviewPreparation, launchAppReview, onManualAppReview, prepareAppReview } from '../utils/appReview';
import { hasActiveAppOverlay } from './AppOverlay';

/** Invisible owner: no state updates, polling, or work during call teardown. */
function AppReviewHost({ ready }: { ready: boolean }) {
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const policyRef = useRef<AppReviewPolicy | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const policy = new AppReviewPolicy({
      storage: AsyncStorage,
      canPresent: () => readyRef.current && AppState.currentState === 'active' &&
        getCallLifecycle().phase === 'idle' && !isVideoCallActive() && !isPipVisible() &&
        !Keyboard.isVisible() && !hasActiveAppOverlay(),
      prepare: prepareAppReview,
      launch: launchAppReview,
      cancelPreparation: cancelAppReviewPreparation,
    });
    policyRef.current = policy;
    policy.setUser(getCurrentUserId());
    const offUser = onCurrentUserId(id => policy.setUser(id));
    policy.observeCall(getCallLifecycle());
    const offCall = subscribeCallLifecycle(next => policy.observeCall(next));
    const offManual = onManualAppReview(() => policy.manualReviewOpened());
    const appState = AppState.addEventListener('change', state => {
      if (state !== 'active') policy.cancel();
    });
    const keyboard = Keyboard.addListener('keyboardDidShow', () => policy.cancel());
    return () => {
      offCall(); offUser(); offManual(); appState.remove(); keyboard.remove();
      policy.dispose();
      policyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const policy = policyRef.current;
    if (!policy) return;
    // The policy waits two seconds after Home becomes ready (stack transitions take 120 ms).
    // Do not wait on InteractionManager: a friend's looping busy indicator can keep it pending forever.
    policy.setReady(ready);
    return () => { policy.setReady(false); };
  }, [ready]);

  return null;
}

export default memo(AppReviewHost);
