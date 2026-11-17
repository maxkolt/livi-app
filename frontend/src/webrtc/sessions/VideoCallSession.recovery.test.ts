import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual session class without loading Expo/native modules in Node.
// Only its platform dependencies are substituted; recovery methods are not copied.
const compile = (file: string) => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const constantsModule = { exports: {} as Record<string, number> };
vm.runInNewContext(compile(path.join(__dirname, 'videoCall/constants.ts')), {
  module: constantsModule, exports: constantsModule.exports, process, __DEV__: false,
});
const constants = constantsModule.exports;
const heartbeat = jest.fn();
class NativeStream {
  tracks: Array<{ kind: string }> = [];
  getTracks() { return this.tracks; }
  addTrack(track: { kind: string }) { this.tracks.push(track); }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
}

function prototype(): object {
  const mod = { exports: {} as { VideoCallSession: { prototype: object } } };
  vm.runInNewContext(compile(path.join(__dirname, 'VideoCallSession.ts')), {
    module: mod, exports: mod.exports, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (name: string) => {
      if (name === './videoCall/constants') return constants;
      if (name === '@livekit/react-native-webrtc') return { MediaStream: NativeStream };
      if (name.endsWith('/SimpleEventEmitter')) return { SimpleEventEmitter: class {} };
      if (name.endsWith('/logger')) return { logger: { info: jest.fn(), warn: jest.fn() } };
      if (name.endsWith('/capacityClientMetrics')) return { sendClientMetrics: async () => {} };
      if (name.endsWith('/telemetry')) return { trackReleaseEvent: jest.fn() };
      if (name.endsWith('/socket')) return { emitCallHeartbeat: heartbeat, API_BASE: 'https://example.test' };
      return {};
    },
  });
  return mod.exports.VideoCallSession.prototype;
}

function fixture() {
  const state = {
    ended: false, endCallInProgress: false, isDisconnecting: false,
    callId: 'call-1', roomId: 'room-1', currentRoomName: 'room-1', partnerUserId: 'peer',
    config: { myUserId: 'me' }, remotePeerSeenInCall: true,
    room: { state: 'connected', remoteParticipants: new Map<string, { identity: string }>() },
    lastLiveKitUrl: 'wss://example.test', lastLiveKitToken: 'token',
    mediaReconnectInProgress: false, waitingForRemotePeerRejoin: false,
    mediaReconnectGraceTimer: null as ReturnType<typeof setTimeout> | null,
    liveKitReconnecting: false, networkLinkDown: false, mediaRejoinInFlight: false,
    callLeaseHeartbeatTimer: null as ReturnType<typeof setInterval> | null,
    ensureNetworkReachabilityMonitor: jest.fn(), emitNetworkDownToPeer: jest.fn(),
    armPeerReconnectingUi: jest.fn(), clearLiveKitSelfRecoveryTimer: jest.fn(),
    tryClearPeerReconnectingAfterMedia: jest.fn(), emit: jest.fn(),
    resubscribeRemoteMediaAfterReconnect: jest.fn(),
    recoverLocalTracksAfterReconnect: jest.fn(async () => {}), tryRestoreCameraAfterReconnect: jest.fn(),
    runMediaReconnectAttemptsLocked: jest.fn(async () => {}),
    kickMediaRejoinFromNetworkRestore: jest.fn(async () => {}),
    waitForLiveKitSelfRecovery: jest.fn(), handleCallEnded: jest.fn(),
    isSameRemoteParticipant: (participant: { identity: string }) => participant.identity === 'peer',
  };
  type Methods = {
    beginWaitingForRemotePeerRejoin: (reason: string) => void;
    onNetworkLinkLost: () => void; onNetworkLinkRestored: () => void;
    clearMediaReconnectGrace: () => void;
    stopCallLeaseHeartbeat: () => void;
    onMediaReconnectSucceeded: () => void;
    noteRemotePeerRejoined: (source: string) => void;
    runMediaReconnectAttempts: (url: string, token: string, room: string) => Promise<void>;
    onRemoteParticipantDisconnected: (room: object, participant: { identity: string }) => void;
    refreshLocalPreviewFromTracks: () => void;
  };
  return Object.assign(Object.create(prototype()) as Methods, state);
}

beforeEach(() => { jest.useFakeTimers(); heartbeat.mockClear(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

it('rebinds direct-call preview to the SDK replacement without touching camera or microphone', () => {
  const oldVideo = { kind: 'video', readyState: 'ended' };
  const video = { kind: 'video', readyState: 'live', enabled: false };
  const audio = { kind: 'audio', readyState: 'live', enabled: false };
  const oldStream = new NativeStream();oldStream.addTrack(oldVideo);oldStream.addTrack(audio);
  const notifyLocalStreamChange = jest.fn();
  const s = Object.assign(fixture(), {
    localStream: oldStream, localVideoTrack: { mediaStreamTrack: video, stop: jest.fn() },
    localAudioTrack: { mediaStreamTrack: audio, stop: jest.fn() }, notifyLocalStreamChange,
  });
  s.refreshLocalPreviewFromTracks();
  expect(s.localStream).not.toBe(oldStream);
  expect(s.localStream.getTracks()).toEqual([video, audio]);
  expect(notifyLocalStreamChange).toHaveBeenCalledTimes(1);
  expect(video.enabled).toBe(false);expect(audio.enabled).toBe(false);
  expect(s.localVideoTrack.stop).not.toHaveBeenCalled();
  expect(s.localAudioTrack.stop).not.toHaveBeenCalled();
  const current=s.localStream;s.refreshLocalPreviewFromTracks();
  expect(s.localStream).toBe(current);
  expect(notifyLocalStreamChange).toHaveBeenCalledTimes(1);
});

it('does not restore a direct-call preview after teardown starts', () => {
  const s=Object.assign(fixture(), { localVideoTrack:{mediaStreamTrack:{kind:'video',readyState:'live'}},
    localStream:null, ended:true, notifyLocalStreamChange:jest.fn() });
  s.refreshLocalPreviewFromTracks();
  expect(s.localStream).toBeNull();expect(s.notifyLocalStreamChange).not.toHaveBeenCalled();
});

it('continues answering SFU offers while the remote peer is offline and after it rejoins', async () => {
  const s = fixture();
  const client = { onOffer: jest.fn(), onAnswer: jest.fn(), onTrickle: jest.fn() };
  const room = Object.assign(s.room, { engine: { client } });
  const callbacks = { ...client };

  s.onRemoteParticipantDisconnected(room, { identity: 'peer' });
  // SFU removes the departed microphone before the peer returns. Those offers must
  // still be answered, or it forces full reconnects on the otherwise healthy survivor.
  expect(client).toEqual(callbacks);
  await jest.advanceTimersByTimeAsync(constants.REMOTE_PARTICIPANT_DISCONNECT_CONFIRM_MS);
  expect(s.waitingForRemotePeerRejoin).toBe(true);
  expect(client).toEqual(callbacks);

  room.remoteParticipants.set('peer', { identity: 'peer' });
  s.noteRemotePeerRejoined('ParticipantConnected');
  expect(s.waitingForRemotePeerRejoin).toBe(false);
  expect(client).toEqual(callbacks);
  client.onOffer();
  expect(callbacks.onOffer).toHaveBeenCalledTimes(1);
  expect(s.handleCallEnded).not.toHaveBeenCalled();
});

it('keeps the survivor waiting and renewing the server lease for a five-minute outage', async () => {
  const s = fixture();
  s.beginWaitingForRemotePeerRejoin('remote_participant_disconnected');
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  expect(s.handleCallEnded).not.toHaveBeenCalled();
  expect(s.mediaReconnectInProgress).toBe(true);
  expect(s.waitingForRemotePeerRejoin).toBe(true);
  expect(heartbeat.mock.calls.length).toBeGreaterThan(35);
  expect(heartbeat.mock.lastCall?.[0]).toMatchObject({ callId: 'call-1', phase: 'reconnecting' });
  s.room.remoteParticipants.set('peer', { identity: 'peer' });
  s.noteRemotePeerRejoined('ParticipantConnected');
  expect(s.mediaReconnectInProgress).toBe(false);
  expect(s.emit).toHaveBeenCalledWith('livekitReconnected');
  await jest.advanceTimersByTimeAsync(2 * 60_000);
  expect(s.handleCallEnded).not.toHaveBeenCalled();
  expect(heartbeat.mock.lastCall?.[0]).toMatchObject({ phase: 'active' });
});

it('still ends an abandoned peer wait after the bounded recovery window', async () => {
  const s = fixture();
  s.beginWaitingForRemotePeerRejoin('peer_lost');
  await jest.advanceTimersByTimeAsync(constants.MEDIA_RECONNECT_GRACE_MS - 1);
  expect(s.handleCallEnded).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(s.handleCallEnded).toHaveBeenCalledTimes(1);
  expect(s.callLeaseHeartbeatTimer).toBeNull();
});

it('waits for physical connectivity instead of tearing down/rejoining while offline', async () => {
  const s = fixture();
  s.onNetworkLinkLost();
  await s.runMediaReconnectAttempts('url', 'token', 'room-1');
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  expect(s.runMediaReconnectAttemptsLocked).not.toHaveBeenCalled();
  expect(s.handleCallEnded).not.toHaveBeenCalled();
  s.room.state = 'disconnected';
  s.onNetworkLinkRestored();
  expect(s.kickMediaRejoinFromNetworkRestore).toHaveBeenCalledTimes(1);
  expect(s.networkLinkDown).toBe(false);
});

it('does not declare recovery when only the local transport rejoined an empty room', () => {
  const s = fixture();
  s.onMediaReconnectSucceeded();
  expect(s.waitingForRemotePeerRejoin).toBe(true);
  expect(s.emit).not.toHaveBeenCalledWith('livekitReconnected');
  expect(s.resubscribeRemoteMediaAfterReconnect).not.toHaveBeenCalled();
  expect(heartbeat.mock.lastCall?.[0]).toMatchObject({ phase: 'reconnecting' });
});

it('ignores a different participant when the expected peer has not returned', () => {
  const s = fixture();
  s.room.remoteParticipants.set('other', { identity: 'other' });
  s.onMediaReconnectSucceeded();
  expect(s.waitingForRemotePeerRejoin).toBe(true);
  expect(s.emit).not.toHaveBeenCalledWith('livekitReconnected');
});

it('restores subscriptions and local media when the expected peer returns', () => {
  const s = fixture();
  s.beginWaitingForRemotePeerRejoin('peer_lost');
  s.room.remoteParticipants.set('peer', { identity: 'peer' });
  s.onMediaReconnectSucceeded();
  expect(s.waitingForRemotePeerRejoin).toBe(false);
  expect(s.mediaReconnectGraceTimer).toBeNull();
  expect(s.resubscribeRemoteMediaAfterReconnect).toHaveBeenCalledTimes(1);
  expect(s.recoverLocalTracksAfterReconnect).toHaveBeenCalledTimes(1);
});

it('cancels timeout and late reconnection after the call has ended', async () => {
  const s = fixture();
  s.beginWaitingForRemotePeerRejoin('peer_lost');
  s.ended = true;
  s.clearMediaReconnectGrace();
  s.stopCallLeaseHeartbeat();
  s.emit.mockClear();
  await jest.advanceTimersByTimeAsync(10 * 60_000);
  s.onNetworkLinkRestored();
  s.onMediaReconnectSucceeded();
  await s.runMediaReconnectAttempts('url', 'token', 'room-1');
  expect(s.handleCallEnded).not.toHaveBeenCalled();
  expect(s.emit).not.toHaveBeenCalled();
  expect(s.kickMediaRejoinFromNetworkRestore).not.toHaveBeenCalled();
  expect(s.runMediaReconnectAttemptsLocked).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
