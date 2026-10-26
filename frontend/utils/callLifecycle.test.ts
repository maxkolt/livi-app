jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import {
  __resetCallLifecycleForTests,
  callLifecycle,
  getCallLifecycle,
  isCallInProgress,
  isCallMediaLive,
  subscribeCallLifecycle,
} from './callLifecycle';

const PEER = 'b'.repeat(24);
const phase = () => getCallLifecycle().phase;

describe('call lifecycle', () => {
  beforeEach(() => __resetCallLifecycleForTests());

  it('walks an outgoing call through to idle', () => {
    callLifecycle.outgoingStarted(PEER);
    expect(phase()).toBe('outgoing');
    callLifecycle.outgoingCallIdAssigned('c1');
    expect(getCallLifecycle().callId).toBe('c1');
    callLifecycle.accepted('c1', PEER, 'caller');
    expect(phase()).toBe('connecting');
    expect(isCallMediaLive()).toBe(true);
    callLifecycle.mediaConnected('c1');
    expect(phase()).toBe('active');
    callLifecycle.endRequested('c1', 'local');
    expect(phase()).toBe('ending');
    expect(isCallInProgress()).toBe(false);
    callLifecycle.ended('c1', 'cleanup');
    expect(getCallLifecycle()).toMatchObject({ phase: 'idle', callId: null, endReason: 'local' });
  });

  it('returns to idle when an incoming call is declined', () => {
    callLifecycle.incomingPresented('c2', PEER);
    expect(getCallLifecycle()).toMatchObject({ phase: 'incoming', role: 'callee' });
    callLifecycle.ringEnded('c2', 'declined');
    expect(getCallLifecycle()).toMatchObject({ phase: 'idle', endReason: 'declined' });
  });

  it('accepts straight from idle (answer from a killed app)', () => {
    callLifecycle.accepted('c3', PEER, 'callee');
    expect(getCallLifecycle()).toMatchObject({ phase: 'connecting', callId: 'c3' });
  });

  it("ignores events that belong to another call", () => {
    callLifecycle.incomingPresented('c4', PEER);
    callLifecycle.accepted('c4', PEER, 'callee');
    callLifecycle.endRequested('old-call', 'late call:ended');
    expect(phase()).toBe('connecting');
    callLifecycle.ended('old-call', 'late cleanup');
    expect(phase()).toBe('connecting');
  });

  it('does not let an incoming call replace a call in progress', () => {
    callLifecycle.outgoingStarted(PEER);
    callLifecycle.outgoingCallIdAssigned('c5');
    callLifecycle.incomingPresented('c6', 'c'.repeat(24));
    expect(getCallLifecycle()).toMatchObject({ phase: 'outgoing', callId: 'c5' });
  });

  it('finishes a call that is still tearing down when a new one starts', () => {
    callLifecycle.accepted('c7', PEER, 'callee');
    callLifecycle.endRequested('c7', 'remote');
    callLifecycle.outgoingStarted(PEER);
    expect(getCallLifecycle()).toMatchObject({ phase: 'outgoing', callId: null, role: 'caller' });
  });

  it('rejects illegal transitions without changing state', () => {
    callLifecycle.mediaConnected('c8');
    expect(phase()).toBe('idle');
    callLifecycle.outgoingStarted(PEER);
    callLifecycle.mediaConnected(null);
    expect(phase()).toBe('outgoing');
  });

  it('notifies subscribers with the previous state', () => {
    const seen: string[] = [];
    subscribeCallLifecycle((next, prev) => seen.push(`${prev.phase}->${next.phase}`));
    callLifecycle.incomingPresented('c9', PEER);
    callLifecycle.accepted('c9', PEER, 'callee');
    callLifecycle.ended('c9', 'cleanup');
    expect(seen).toEqual(['idle->incoming', 'incoming->connecting', 'connecting->ending', 'ending->idle']);
  });
});
