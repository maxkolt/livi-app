jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import {
  adoptVideoCallActiveRef,
  installCallRuntimeBridges,
  isCallEndedFromPiPNoOpen,
  isEndingCallInProgress,
  isPipInSystemMode,
  isPipVisible,
  isVideoCallActive,
  isVideoCallActiveExplicitlyFalse,
  setCallEndedFromPiPNoOpen,
  setEndingCallInProgress,
  setPipInSystemMode,
  setPipVisible,
  setVideoCallActive,
} from './callRuntime';
import { getCallLifecycle } from './callLifecycle';

beforeEach(() => {
  installCallRuntimeBridges();
  setVideoCallActive(false);
  setEndingCallInProgress(false);
  setPipVisible(false);
  setPipInSystemMode(false);
  setCallEndedFromPiPNoOpen(false);
});

it('reads the same five flags as legacy guards for every boolean combination', () => {
  for (let mask = 0; mask < 32; mask++) {
    const values = Array.from({ length: 5 }, (_, bit) => !!(mask & (1 << bit)));
    global.__videoCallActiveRef!.current = values[0];
    global.__endingCallInProgressRef!.current = values[1];
    global.__pipVisibleRef!.current = values[2];
    global.__pipInSystemModeRef!.current = values[3];
    global.__callEndedFromPiPNoOpenRef!.current = values[4];
    expect([
      isVideoCallActive(), isEndingCallInProgress(), isPipVisible(),
      isPipInSystemMode(), isCallEndedFromPiPNoOpen(),
    ]).toEqual(values);
    expect(isVideoCallActiveExplicitlyFalse()).toBe(!values[0]);
  }
});

it('keeps an adopted React ref live in both directions', () => {
  const ref = { current: false };
  global.__videoCallActiveRef = ref;
  setVideoCallActive(true);
  expect(ref.current).toBe(true);
  ref.current = false;
  expect(isVideoCallActive()).toBe(false);
  expect(global.__videoCallActiveRef).toBe(ref);
});

it('preserves legacy ref replacement without mutating the old box', () => {
  const oldRef = { current: true };
  global.__videoCallActiveRef = oldRef;
  const replacement = { current: false };
  adoptVideoCallActiveRef(replacement);
  expect(global.__videoCallActiveRef).toBe(replacement);
  expect(oldRef.current).toBe(true);
  setVideoCallActive(true);
  expect(replacement.current).toBe(true);
});

it('updates PiP and ending flags synchronously without replacing their boxes or call phase', () => {
  const boxes = [global.__pipVisibleRef, global.__pipInSystemModeRef, global.__endingCallInProgressRef, global.__callEndedFromPiPNoOpenRef];
  const phase = getCallLifecycle();
  setPipVisible(true);
  setPipInSystemMode(true);
  setEndingCallInProgress(true);
  setCallEndedFromPiPNoOpen(true);
  expect(boxes.map(box => box!.current)).toEqual([true, true, true, true]);
  expect([global.__pipVisibleRef, global.__pipInSystemModeRef, global.__endingCallInProgressRef, global.__callEndedFromPiPNoOpenRef]).toEqual(boxes);
  expect(getCallLifecycle()).toBe(phase);
});
