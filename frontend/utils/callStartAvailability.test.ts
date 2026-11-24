jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
import { isCallStartBlocked, useCallStartBlocked } from './callStartAvailability';
import { __resetCallLifecycleForTests, callLifecycle } from './callLifecycle';

const g = global as unknown as Record<string, { current: unknown } | undefined>;
beforeEach(() => {
  __resetCallLifecycleForTests();
  for (const key of ['__webrtcSessionRef', '__videoCallActiveRef', '__endingCallInProgressRef', '__outgoingStartInFlightRef', '__outgoingCallUiActiveRef', '__outgoingCallScreenVisibleRef']) g[key] = undefined;
});
it.each(['caller', 'callee'] as const)('blocks every stage for %s and re-enables after completion', role => {
  expect(isCallStartBlocked()).toBe(false);
  if (role === 'caller') { callLifecycle.outgoingStarted('friend'); callLifecycle.outgoingCallIdAssigned('call'); }
  else callLifecycle.incomingPresented('call', 'friend');
  expect(isCallStartBlocked()).toBe(true);
  callLifecycle.accepted('call', 'friend', role);
  expect(isCallStartBlocked()).toBe(true);
  callLifecycle.mediaConnected('call');
  expect(isCallStartBlocked()).toBe(true);
  callLifecycle.endRequested('call', 'hangup');
  expect(isCallStartBlocked()).toBe(true);
  callLifecycle.ended('call', 'hangup');
  expect(isCallStartBlocked()).toBe(false);
});
it('blocks a native/runtime start before lifecycle publication', () => {
  g.__outgoingStartInFlightRef = { current: true };
  expect(isCallStartBlocked()).toBe(true);
  g.__outgoingStartInFlightRef.current = false;
  expect(isCallStartBlocked()).toBe(false);
});
it('does not leave the button visually disabled by a cleanup ref after the idle event', () => {
  callLifecycle.outgoingStarted('friend');
  expect(useCallStartBlocked()).toBe(true);
  g.__endingCallInProgressRef = { current: true };
  callLifecycle.ended(null, 'cancel');
  expect(useCallStartBlocked()).toBe(false);
  expect(isCallStartBlocked()).toBe(true);
  g.__endingCallInProgressRef.current = false;
  expect(isCallStartBlocked()).toBe(false);
});
