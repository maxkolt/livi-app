import type { MediaStream } from '@livekit/react-native-webrtc';
import { selectLiveVideoStream } from './liveVideoStream';

const stream = (state: string) => ({ getVideoTracks: () => [{ readyState: state }] }) as unknown as MediaStream;

it('never revives a disposed/ended cached video during reconnect', () => {
  const old = stream('ended');
  expect(selectLiveVideoStream(null, old, old)).toBeNull();
  const fresh = stream('live');
  expect(selectLiveVideoStream(old, fresh)).toBe(fresh);
});

it('keeps a live stream mounted while the camera is muted', () => {
  const muted = { getVideoTracks: () => [{ readyState: 'live', enabled: false, muted: true }] } as unknown as MediaStream;
  expect(selectLiveVideoStream(muted)).toBe(muted);
});

it('handles disposed native access and audio-only streams', () => {
  const disposed = { getVideoTracks: () => { throw new Error('disposed'); } } as unknown as MediaStream;
  const audioOnly = { getVideoTracks: () => [] } as unknown as MediaStream;
  expect(selectLiveVideoStream(disposed, audioOnly)).toBeNull();
});
