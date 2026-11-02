import {
  claimChatPlayback,
  getActiveChatPlaybackKey,
  releaseChatPlayback,
  resetChatPlaybackCoordinatorForTests,
  pauseActiveChatVideoNote,
} from './chatPlaybackCoordinator';

describe('chatPlaybackCoordinator', () => {
  beforeEach(resetChatPlaybackCoordinatorForTests);

  it('pauses an active circle on outside interaction without releasing its position', () => {
    const pause = jest.fn();
    const stop = jest.fn();
    claimChatPlayback('video-note:v', stop, pause);
    pauseActiveChatVideoNote();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(getActiveChatPlaybackKey()).toBe('video-note:v');
  });

  it('outside interaction leaves voice audio alone and never pauses a released owner', () => {
    const pause = jest.fn();
    claimChatPlayback('audio:a', jest.fn(), pause);
    pauseActiveChatVideoNote();
    expect(pause).not.toHaveBeenCalled();
    claimChatPlayback('video-note:v', jest.fn(), pause);
    releaseChatPlayback('video-note:v');
    pauseActiveChatVideoNote();
    expect(pause).not.toHaveBeenCalled();
  });

  it('stops a voice message when a video note starts', () => {
    const stopVoice = jest.fn();
    claimChatPlayback('audio:a', stopVoice);
    claimChatPlayback('video-note:v', jest.fn());

    expect(stopVoice).toHaveBeenCalledTimes(1);
    expect(getActiveChatPlaybackKey()).toBe('video-note:v');
  });

  it('stops a video note when a voice message starts', () => {
    const stopVideo = jest.fn();
    claimChatPlayback('video-note:v', stopVideo);
    claimChatPlayback('audio:a', jest.fn());

    expect(stopVideo).toHaveBeenCalledTimes(1);
    expect(getActiveChatPlaybackKey()).toBe('audio:a');
  });

  it('does not let a late release clear the new owner', () => {
    claimChatPlayback('audio:a', jest.fn());
    claimChatPlayback('video-note:v', jest.fn());
    releaseChatPlayback('audio:a');

    expect(getActiveChatPlaybackKey()).toBe('video-note:v');
  });
});
