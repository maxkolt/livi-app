import { recoverLocalAudioTrack } from './localAudioRecovery';

function makeTrack() {
  const track = {
    mediaStreamTrack: { readyState: 'live', enabled: true, muted: false },
    isUpstreamPaused: false,
    // Model LiveKit's early return when its logical mute state is already false.
    unmute: jest.fn(async () => {}),
    mute: jest.fn(async () => { track.mediaStreamTrack.enabled = false; }),
    restartTrack: jest.fn(async () => {
      track.mediaStreamTrack = { readyState: 'live', enabled: true, muted: false };
    }),
    resumeUpstream: jest.fn(async () => { track.isUpstreamPaused = false; }),
  };
  return track;
}

describe('microphone recovery after screen-off', () => {
  it('repairs native disabled capture even when LiveKit unmute is a no-op', async () => {
    const track = makeTrack();
    track.mediaStreamTrack.enabled = false;
    await recoverLocalAudioTrack(track, () => true);
    expect(track.mediaStreamTrack.enabled).toBe(true);
    expect(track.restartTrack).not.toHaveBeenCalled();
  });

  it.each(['ended', 'source-muted'])('restarts %s capture in the existing publication', async failure => {
    const track = makeTrack();
    const oldMediaTrack = track.mediaStreamTrack;
    if (failure === 'ended') oldMediaTrack.readyState = 'ended';
    else oldMediaTrack.muted = true;
    await recoverLocalAudioTrack(track, () => true);
    expect(track.restartTrack).toHaveBeenCalledTimes(1);
    expect(track.mediaStreamTrack).not.toBe(oldMediaTrack);
    expect(track.mediaStreamTrack).toEqual({ readyState: 'live', enabled: true, muted: false });
  });

  it('resumes a paused sender without restarting healthy capture', async () => {
    const track = makeTrack();
    track.isUpstreamPaused = true;
    await recoverLocalAudioTrack(track, () => true);
    expect(track.resumeUpstream).toHaveBeenCalledTimes(1);
    expect(track.isUpstreamPaused).toBe(false);
    expect(track.restartTrack).not.toHaveBeenCalled();
  });

  it('leaves healthy capture and its sender running', async () => {
    const track = makeTrack();
    const setEnabled = jest.fn();
    Object.defineProperty(track.mediaStreamTrack, 'enabled', { get: () => true, set: setEnabled });
    await recoverLocalAudioTrack(track, () => true);
    expect(track.restartTrack).not.toHaveBeenCalled();
    expect(track.resumeUpstream).not.toHaveBeenCalled();
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('does not touch an intentionally muted, held, ended, or replaced call', async () => {
    const track = makeTrack();
    track.mediaStreamTrack.enabled = false;
    await recoverLocalAudioTrack(track, () => false);
    expect(track.mediaStreamTrack.enabled).toBe(false);
    expect(track.unmute).not.toHaveBeenCalled();
    expect(track.restartTrack).not.toHaveBeenCalled();
  });

  it.each(['restart', 'unmute', 'resume'])('honors cancellation while awaiting %s', async stage => {
    const track = makeTrack();
    let allowed = true;
    if (stage === 'restart') {
      track.mediaStreamTrack.readyState = 'ended';
      track.restartTrack.mockImplementation(async () => {
        track.mediaStreamTrack = { readyState: 'live', enabled: true, muted: false };
        allowed = false;
      });
    } else if (stage === 'unmute') {
      track.unmute.mockImplementation(async () => { allowed = false; });
    } else {
      track.isUpstreamPaused = true;
      track.resumeUpstream.mockImplementation(async () => { allowed = false; });
    }
    await recoverLocalAudioTrack(track, () => allowed);
    expect(track.mediaStreamTrack.enabled).toBe(false);
    expect(track.mute).toHaveBeenCalledTimes(1);
    if (stage === 'restart') expect(track.unmute).not.toHaveBeenCalled();
  });

  it('propagates a failed restart so the next maintenance tick can retry', async () => {
    const track = makeTrack();
    track.mediaStreamTrack.readyState = 'ended';
    track.restartTrack.mockRejectedValueOnce(new Error('capture unavailable'));
    await expect(recoverLocalAudioTrack(track, () => true)).rejects.toThrow('capture unavailable');
    expect(track.unmute).not.toHaveBeenCalled();
    await recoverLocalAudioTrack(track, () => true);
    expect(track.mediaStreamTrack.readyState).toBe('live');
  });
});
