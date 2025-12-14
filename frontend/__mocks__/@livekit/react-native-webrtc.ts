class MockTrack {
  id: string;
  kind: 'audio' | 'video';
  enabled: boolean;
  readyState: 'live' | 'ended';

  constructor(id: string, kind: 'audio' | 'video') {
    this.id = id;
    this.kind = kind;
    this.enabled = true;
    this.readyState = 'live';
  }

  stop() {
    this.readyState = 'ended';
    this.enabled = false;
  }
}

class MediaStream {
  private _tracks: MockTrack[];
  id: string;

  constructor(tracks: MockTrack[] = []) {
    this._tracks = tracks;
    this.id = `stream-${Math.random().toString(36).slice(2, 8)}`;
  }

  getTracks() {
    return this._tracks;
  }

  getAudioTracks() {
    return this._tracks.filter((t) => t.kind === 'audio');
  }

  getVideoTracks() {
    return this._tracks.filter((t) => t.kind === 'video');
  }

  addTrack(track: MockTrack) {
    this._tracks.push(track);
  }

  toURL() {
    return `blob:mock-${this.id}`;
  }
}

class RTCPeerConnection {
  private senders: { track: MockTrack | null }[] = [];
  private ontrackHandler: ((event: any) => void) | null = null;
  private receivers: { track: MockTrack; stream: MediaStream }[] = [];
  signalingState = 'stable';
  connectionState: 'new' | 'closed' | 'connected' = 'new';
  localDescription: any = null;
  remoteDescription: any = null;

  constructor(_config?: any) {}

  set ontrack(handler: ((event: any) => void) | null) {
    this.ontrackHandler = handler;
  }

  get ontrack(): ((event: any) => void) | null {
    return this.ontrackHandler;
  }

  addTrack(track: MockTrack, stream: MediaStream) {
    this.senders.push({ track });
    return { track };
  }

  getSenders() {
    return this.senders;
  }

  getReceivers() {
    return this.receivers.map(r => ({ track: () => r.track }));
  }

  removeTrack(sender: any) {
    const index = this.senders.findIndex(s => s === sender);
    if (index !== -1) {
      this.senders.splice(index, 1);
    }
  }

  async createOffer() {
    return { type: 'offer', sdp: 'mock-offer-sdp' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'mock-answer-sdp' };
  }

  async setLocalDescription(description: any) {
    this.localDescription = description;
    this.signalingState = description?.type === 'offer' ? 'have-local-offer' : 'have-local-answer';
  }

  async setRemoteDescription(description: any) {
    this.remoteDescription = description;
    if (this.signalingState === 'have-local-offer') {
      this.signalingState = 'stable';
    } else {
      this.signalingState = 'have-remote-offer';
    }
  }

  async addIceCandidate(candidate: any) {
    // Mock implementation
  }

  // Метод для симуляции получения трека (для тестов)
  simulateTrackReceived(track: MockTrack, stream: MediaStream) {
    this.receivers.push({ track, stream });
    if (this.ontrackHandler) {
      this.ontrackHandler({
        track,
        streams: [stream],
        stream,
      });
    }
  }

  close() {
    this.signalingState = 'closed';
    this.connectionState = 'closed';
    this.ontrackHandler = null;
  }
}

export { RTCPeerConnection, MediaStream, MockTrack };
export default {
  RTCPeerConnection,
  MediaStream,
  MockTrack,
};
