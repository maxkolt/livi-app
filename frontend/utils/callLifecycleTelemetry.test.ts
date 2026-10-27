jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./telemetry', () => ({ trackReleaseEvent: jest.fn(), trackReleaseError: jest.fn() }));

import { __resetCallLifecycleForTests, callLifecycle } from './callLifecycle';
import {
  __resetCallLifecycleTelemetryForTests,
  installCallOutcomeTelemetry,
  shadowCompareWithLifecycle,
} from './callLifecycleTelemetry';
import { trackReleaseError, trackReleaseEvent } from './telemetry';

const PEER = 'b'.repeat(24);
const trackEvent = trackReleaseEvent as jest.Mock;
const trackError = trackReleaseError as jest.Mock;

let now = 1_000;
const at = (ms: number) => {
  now = ms;
};

const outcomes = () => trackEvent.mock.calls.filter(([name]) => name === 'call_outcome').map(([, payload]) => payload);

describe('call outcome telemetry', () => {
  beforeEach(() => {
    __resetCallLifecycleForTests();
    __resetCallLifecycleTelemetryForTests();
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    installCallOutcomeTelemetry();
  });

  afterEach(() => jest.restoreAllMocks());

  it('reports a connected outgoing call with ring, connect and talk times', () => {
    at(1_000);
    callLifecycle.outgoingStarted(PEER);
    callLifecycle.outgoingCallIdAssigned('c1');
    at(4_000);
    callLifecycle.accepted('c1', PEER, 'caller');
    at(5_500);
    callLifecycle.mediaConnected('c1');
    at(65_500);
    callLifecycle.endRequested('c1', 'local');
    at(66_000);
    callLifecycle.ended('c1', 'session:endCall');
    expect(outcomes()).toEqual([
      { outcome: 'connected', reason: 'local', role: 'caller', callId: 'c1', ringMs: 3_000, connectMs: 1_500, talkMs: 60_000 },
    ]);
  });

  it('reports a call that was answered but never got media', () => {
    at(1_000);
    callLifecycle.incomingPresented('c2', PEER);
    at(2_000);
    callLifecycle.accepted('c2', PEER, 'callee');
    at(20_000);
    callLifecycle.endRequested('c2', 'local');
    callLifecycle.ended('c2', 'session:endCall');
    expect(outcomes()).toEqual([
      { outcome: 'connect_failed', reason: 'local', role: 'callee', callId: 'c2', ringMs: 1_000 },
    ]);
  });

  it('reports an unanswered ring with how long it rang', () => {
    at(1_000);
    callLifecycle.incomingPresented('c3', PEER);
    at(31_000);
    callLifecycle.ringEnded('c3', 'incoming_timeout');
    expect(outcomes()).toEqual([
      { outcome: 'not_answered', reason: 'incoming_timeout', role: 'callee', callId: 'c3', ringMs: 30_000 },
    ]);
  });

  it('has no ring time for an answer from a killed app', () => {
    at(1_000);
    callLifecycle.accepted('c4', PEER, 'callee');
    at(3_000);
    callLifecycle.mediaConnected('c4');
    at(9_000);
    callLifecycle.ended('c4', 'session:callEnded');
    expect(outcomes()).toEqual([
      { outcome: 'connected', reason: 'session:callEnded', role: 'callee', callId: 'c4', connectMs: 2_000, talkMs: 6_000 },
    ]);
  });

  it('reports the superseded call and starts the next one clean', () => {
    at(1_000);
    callLifecycle.accepted('c5', PEER, 'callee');
    callLifecycle.endRequested('c5', 'remote');
    at(2_000);
    callLifecycle.outgoingStarted(PEER);
    at(5_000);
    callLifecycle.ringEnded(null, 'outgoing_timeout');
    expect(outcomes()).toEqual([
      { outcome: 'connect_failed', reason: 'remote', role: 'callee', callId: 'c5' },
      { outcome: 'not_answered', reason: 'outgoing_timeout', role: 'caller', ringMs: 3_000 },
    ]);
  });

  it('installs once', () => {
    installCallOutcomeTelemetry();
    callLifecycle.incomingPresented('c6', PEER);
    callLifecycle.ringEnded('c6', 'incoming_declined_native');
    expect(outcomes()).toHaveLength(1);
  });
});

describe('shadow comparison telemetry', () => {
  beforeEach(() => {
    __resetCallLifecycleForTests();
    __resetCallLifecycleTelemetryForTests();
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => jest.restoreAllMocks());

  const flags = () => ({ session: 'live', endingInProgress: false });

  it('stays silent while flags and the machine agree', () => {
    shadowCompareWithLifecycle('isOngoingCallSession', false, flags);
    callLifecycle.accepted('c1', PEER, 'callee');
    shadowCompareWithLifecycle('isOngoingCallSession', true, flags);
    expect(trackError).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('reports a mismatch once with a flag snapshot, then how long it lasted', () => {
    at(1_000);
    callLifecycle.accepted('c2', PEER, 'callee');
    at(1_400);
    shadowCompareWithLifecycle('isOngoingCallSession', false, flags);
    shadowCompareWithLifecycle('isOngoingCallSession', false, flags);
    expect(trackError).toHaveBeenCalledTimes(1);
    expect(trackError).toHaveBeenCalledWith(
      'call_lifecycle_mismatch',
      'isOngoingCallSession flags=false machine=true',
      {
        reader: 'isOngoingCallSession',
        legacy: false,
        phase: 'connecting',
        role: 'callee',
        callId: 'c2',
        msInPhase: 400,
        session: 'live',
        endingInProgress: false,
      },
    );
    at(1_650);
    shadowCompareWithLifecycle('isOngoingCallSession', true, flags);
    expect(trackEvent).toHaveBeenCalledWith('call_lifecycle_mismatch_end', { reader: 'isOngoingCallSession', durationMs: 250 });
  });

  it('caps reports per app run', () => {
    callLifecycle.accepted('c3', PEER, 'callee');
    for (let i = 0; i < 15; i += 1) {
      shadowCompareWithLifecycle('isOngoingCallSession', false, flags);
      shadowCompareWithLifecycle('isOngoingCallSession', true, flags);
    }
    expect(trackError).toHaveBeenCalledTimes(10);
    expect(trackEvent.mock.calls.filter(([name]) => name === 'call_lifecycle_mismatch_end')).toHaveLength(10);
  });

  it('still reports when the flag snapshot throws', () => {
    callLifecycle.accepted('c4', PEER, 'callee');
    shadowCompareWithLifecycle('isOngoingCallSession', false, () => {
      throw new Error('boom');
    });
    expect(trackError).toHaveBeenCalledTimes(1);
  });
});
