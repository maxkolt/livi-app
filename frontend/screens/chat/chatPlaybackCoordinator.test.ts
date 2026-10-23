import {
  claimChatPlayback,
  getActiveChatPlaybackKey,
  releaseChatPlayback,
  resetChatPlaybackCoordinatorForTests,
} from './chatPlaybackCoordinator';

describe('chatPlaybackCoordinator', () => {
  beforeEach(resetChatPlaybackCoordinatorForTests);

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
