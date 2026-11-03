jest.mock('../../../sockets/socket', () => ({
  __esModule: true, default: { on: jest.fn(), off: jest.fn(), emit: jest.fn() },
  getCurrentUserId: () => 'me', onConnected: () => () => {}, onDisconnected: () => () => {},
  API_BASE: 'https://api.example.test',
}));
jest.mock('../../../utils/warmConnections', () => ({ prewarmApiConnections: jest.fn() }));
jest.mock('../../../utils/iceConfig', () => ({ getIceConfiguration: jest.fn(), prefetchIceConfiguration: jest.fn() }));
jest.mock('../../utils/capacityClientMetrics', () => ({ sendClientMetrics: jest.fn(async () => {}) }));
jest.mock('../videoCaptureProfile', () => ({ getPreferredVideoCaptureOptions: () => ({ primary: {}, meta: { preset: 'high' } }) }));
jest.mock('../iceTransportDiagnostics', () => ({ getRoomIceTransportDiagnostics: async () => [] }));
jest.mock('./videoCall/constants', () => ({ LIVEKIT_APPLY_CLIENT_ICE: true }));
jest.mock('../../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@livekit/react-native-webrtc', () => {
  let sequence = 0;
  return { MediaStream: class {
    id = `stream-${++sequence}`;
    tracks: any[] = [];
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    addTrack(t: any) { this.tracks.push(t); }
    removeTrack(t: any) { this.tracks = this.tracks.filter(x => x !== t); }
  } };
});
jest.mock('livekit-client', () => ({
  Track: { Kind: { Video: 'video', Audio: 'audio' } },
  RoomEvent: Object.fromEntries(['Reconnected', 'Reconnecting', 'SignalReconnecting', 'ParticipantConnected',
    'ParticipantDisconnected', 'TrackSubscribed', 'TrackPublished', 'TrackUnsubscribed', 'Disconnected'].map(x => [x, x])),
  createLocalTracks: jest.fn(),
}));

import { RandomChatSession } from './RandomChatSession';
import { Platform } from 'react-native';
import socket from '../../../sockets/socket';

const track = (kind: string, sid: string) => ({
  sid, kind, isMuted: false,
  mediaStreamTrack: { kind, id: `${sid}-${Math.random()}`, readyState: 'live', enabled: true,
    addEventListener: jest.fn(), removeEventListener: jest.fn() },
  mute: jest.fn(async () => {}), unmute: jest.fn(async () => {}),
  stop: jest.fn(),
});
function fixture() {
  const callbacks = { onRemoteStreamChange: jest.fn(), onLocalStreamChange: jest.fn() };
  const session = new RandomChatSession({ myUserId: 'me', callbacks } as any) as any;
  const peer = { identity: 'peer', sid: 'participant', isLocal: false, trackPublications: new Map() };
  const handlers = new Map<string, (...args: any[]) => void>();
  const room: any = { state: 'connected', name: 'same-room',
    remoteParticipants: new Map([['peer', peer]]),
    on: (event: string, listener: (...args: any[]) => void) => { handlers.set(event, listener); return room; },
    once: (event: string, listener: (...args: any[]) => void) => { handlers.set(event, listener); return room; },
    localParticipant: {}, removeAllListeners: jest.fn(), disconnect: jest.fn(async () => {}),
    engine: { close: jest.fn(async () => {}) },
  };
  Object.assign(session, { room, started: true, matchPartnerUserId: 'peer', currentRemoteParticipant: peer });
  const subscribe = (t: ReturnType<typeof track>) => {
    const publication = { kind: t.kind, trackSid: t.sid, track: t };
    peer.trackPublications.set(t.sid, publication);
    session.handleTrackSubscribed(t, publication, peer);
    return publication;
  };
  return { session, peer, room, handlers, callbacks, subscribe };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

it('rebinds a new video track with the same SID while preserving audio', () => {
  const { session, subscribe } = fixture();
  const audio = track('audio', 'a');
  subscribe(audio);
  subscribe(track('video', 'v'));
  const oldStream = session.remoteStream, oldKey = session.remoteViewKey;
  const fresh = track('video', 'v');
  subscribe(fresh);
  expect(session.remoteStream.id).not.toBe(oldStream.id);
  expect(session.remoteStream.getTracks()).toEqual([audio.mediaStreamTrack, fresh.mediaStreamTrack]);
  expect(session.remoteViewKey).toBeGreaterThan(oldKey);
});

it.each(['video', 'audio'])('ignores a late unsubscribe for the old same-SID %s', (kind) => {
  const { session, subscribe, peer } = fixture();
  const old = track(kind, 'same'), fresh = track(kind, 'same');
  const publication = subscribe(old);
  subscribe(fresh);
  session.handleTrackUnsubscribed(publication, peer, old);
  expect(session.remoteStream.getTracks()).toEqual([fresh.mediaStreamTrack]);
  session.handleTrackUnsubscribed({ ...publication, track: fresh }, peer, fresh);
  expect(session.remoteStream).toBeNull();
});

it('ignores an ended track and events from a retired room', () => {
  const { session, room, handlers, subscribe, peer } = fixture();
  const ended = track('video', 'v');
  ended.mediaStreamTrack.readyState = 'ended';
  subscribe(ended);
  expect(session.remoteStream).toBeNull();
  session.registerRoomEvents(room);
  session.room = { state: 'connected' };
  const fresh = track('video', 'new');
  handlers.get('TrackSubscribed')!(fresh, { kind: 'video', trackSid: 'new' }, peer);
  expect(session.remoteStream).toBeNull();
});

it('rebuilds remote media from live publications after SDK reconnect', () => {
  const { session, room, handlers, subscribe, peer } = fixture();
  subscribe(track('video', 'same'));
  const oldStream = session.remoteStream;
  const fresh = track('video', 'same');
  peer.trackPublications.set('same', { kind: 'video', trackSid: 'same', track: fresh });
  session.roomReconnecting = true;
  session.registerRoomEvents(room);
  handlers.get('Reconnected')!();
  expect(session.remoteStream.id).not.toBe(oldStream.id);
  expect(session.remoteStream.getVideoTracks()).toEqual([fresh.mediaStreamTrack]);
  expect(session.roomReconnecting).toBe(false);
});

it('keeps recovery visible when the room returns before the remote participant', () => {
  const { session, room, handlers } = fixture();
  session.registerRoomEvents(room);
  room.remoteParticipants.clear();
  handlers.get('Reconnected')!();
  expect(session.currentRemoteParticipant).toBeNull();
  expect(session.partnerAwayLiveKit).toBe(true);
});

it('ignores a late subscription from an old PC inside the same room', () => {
  const { session, subscribe, peer } = fixture();
  const old = track('video', 'same'), fresh = track('video', 'same');
  const oldPublication = subscribe(old);
  subscribe(fresh);
  const stream = session.remoteStream;
  session.handleTrackSubscribed(old, oldPublication, peer);
  expect(session.remoteStream).toBe(stream);
  expect(session.remoteStream.getVideoTracks()).toEqual([fresh.mediaStreamTrack]);
});

it('does not restart a same-room SDK reconnect on a repeated match payload', async () => {
  const { session, room } = fixture();
  room.state = 'reconnecting';
  session.connectToLiveKit = jest.fn();
  await session.handleMatchFound({ id: 'peer-socket', userId: 'peer', roomId: 'match',
    livekitRoomName: room.name, livekitUrl: 'wss://livekit.test', livekitToken: 'token' });
  expect(session.connectToLiveKit).not.toHaveBeenCalled();
  expect(room.disconnect).not.toHaveBeenCalled();
  expect(session.roomReconnecting).toBe(true);
});

it('awaits old room shutdown and preserves a newer connection which wins during cleanup', async () => {
  const { session, room } = fixture();
  session.currentRoomName = 'old-room';
  const request = session.connectRequestId;
  let finish!: () => void;
  room.disconnect.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const work = session.connectToLiveKit('wss://livekit.test', 'token', request, 'target');
  await jest.advanceTimersByTimeAsync(0);
  expect(room.disconnect).toHaveBeenCalledTimes(1);
  const winner = { state: 'connected', name: 'winner' };
  session.room = winner;
  session.currentRoomName = 'winner';
  session.connectRequestId++;
  finish();
  await expect(work).resolves.toBe(false);
  expect(session.room).toBe(winner);
  expect(session.currentRoomName).toBe('winner');
  expect(room.engine.close).toHaveBeenCalledTimes(1);
});

it('does not enable capture when flipping a deliberately disabled camera', async () => {
  const { session } = fixture();
  session.isCamOn = false;
  session.restartLocalCamera = jest.fn();
  await session.flipCam();
  expect(session.camSide).toBe('back');
  expect(session.isCamOn).toBe(false);
  expect(session.restartLocalCamera).not.toHaveBeenCalled();
});

it('detaches remote views before room teardown can dispose their native tracks', async () => {
  const { session, room, subscribe, callbacks } = fixture();
  subscribe(track('video', 'v'));
  room.disconnect.mockImplementation(async () => {
    expect(session.remoteStream).toBeNull();
    expect(callbacks.onRemoteStreamChange).toHaveBeenLastCalledWith(null);
  });
  await session.disconnectRoom('server', 'test');
  expect(room.disconnect).toHaveBeenCalled();
});

it('honors the server reconnect grace instead of leaving the pair after 15 seconds', async () => {
  const { session } = fixture();
  session.leavePairAfterFailedReconnect = jest.fn();
  const reconnect = (socket.on as jest.Mock).mock.calls.find(([event]) => event === 'random:partnerReconnecting')![1];
  reconnect({ graceMs: 45_000 });
  await jest.advanceTimersByTimeAsync(49_999);
  expect(session.leavePairAfterFailedReconnect).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(session.leavePairAfterFailedReconnect).toHaveBeenCalledWith('partner_away_timeout');
});

it('releases the old Android camera before opening its replacement and keeps the mic', async () => {
  Object.assign(Platform, { OS: 'android' });
  const { session, callbacks } = fixture();
  const old = track('video', 'old'), fresh = track('video', 'new'), mic = track('audio', 'mic');
  Object.assign(session, { localVideoTrack: old, localAudioTrack: mic });
  session.createFreshLocalVideoTrack = jest.fn(async () => {
    expect(old.stop).toHaveBeenCalled();
    expect(callbacks.onLocalStreamChange).toHaveBeenLastCalledWith(null);
    return fresh;
  });
  session.replacePublishedVideoTrack = jest.fn(async () => {});
  const work = session.restartLocalCamera();
  await jest.advanceTimersByTimeAsync(180);
  await work;
  expect(session.localStream.getVideoTracks()).toEqual([fresh.mediaStreamTrack]);
  expect(session.localStream.getAudioTracks()).toEqual([mic.mediaStreamTrack]);
  expect(mic.stop).not.toHaveBeenCalled();
});

it('serializes camera recreation with a concurrent restart', async () => {
  Object.assign(Platform, { OS: 'android' });
  const { session } = fixture();
  const mic = track('audio', 'mic');
  Object.assign(session, { localAudioTrack: mic, localVideoTrack: track('video', 'old') });
  let finishFirst!: (value: unknown) => void;
  session.createFreshLocalVideoTrack = jest.fn()
    .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockResolvedValueOnce(track('video', 'second'));
  session.replacePublishedVideoTrack = jest.fn(async () => {});
  const first = session.restartLocalCamera();
  const second = session.recreateLocalVideoTrack('ended');
  await jest.advanceTimersByTimeAsync(180);
  expect(session.createFreshLocalVideoTrack).toHaveBeenCalledTimes(1);
  finishFirst(track('video', 'first'));
  await jest.advanceTimersByTimeAsync(180);
  await Promise.all([first, second]);
  expect(session.localVideoTrack.sid).toBe('second');
  expect(mic.stop).not.toHaveBeenCalled();
});

it('disposes a replacement that arrives after Stop instead of restarting the camera', async () => {
  const { session } = fixture();
  const fresh = track('video', 'late');
  session.createFreshLocalVideoTrack = jest.fn(async () => {
    session.started = false;
    return fresh;
  });
  await session.recreateLocalVideoTrack('ended');
  expect(fresh.stop).toHaveBeenCalledTimes(1);
  expect(session.localVideoTrack).toBeNull();
});
