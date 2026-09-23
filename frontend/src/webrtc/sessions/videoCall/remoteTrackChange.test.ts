import { describeRemoteTrackChange } from './remoteTrackChange';

const base = { isVideoTrack: false, isAudioTrack: false };
const video = (over: Record<string, unknown> = {}) =>
  describeRemoteTrackChange({ ...base, isVideoTrack: true, ...over } as any);
const audio = (over: Record<string, unknown> = {}) =>
  describeRemoteTrackChange({ ...base, isAudioTrack: true, ...over } as any);

describe('видео', () => {
  it('первое видео — не смена трека, стрим пересобирать не нужно', () => {
    const c = video({ newTrackSid: 'v1', previousVideoSid: null });
    expect(c.wasVideoTrackChanged).toBe(false);
    expect(c.needsFreshStream).toBe(false);
  });

  it('переворот камеры (новый sid) требует нового MediaStream', () => {
    const c = video({ newTrackSid: 'v2', previousVideoSid: 'v1' });
    expect(c.wasVideoTrackChanged).toBe(true);
    expect(c.needsFreshStream).toBe(true);
    expect(c.freshStreamReason).toBe('video_replace');
  });

  it('тот же sid — ничего не меняли', () => {
    const c = video({ newTrackSid: 'v1', previousVideoSid: 'v1' });
    expect(c.wasVideoTrackChanged).toBe(false);
    expect(c.needsFreshStream).toBe(false);
  });

  it('sid, запомненный при TrackUnsubscribed, тоже считается предыдущим', () => {
    // Отписка приходит раньше подписки: remoteVideoTrack уже null, но sid сохранён.
    const c = video({ newTrackSid: 'v2', previousVideoSid: 'v1' });
    expect(c.wasVideoTrackChanged).toBe(true);
  });

  it('аудио-флаги не выставляются для видео', () => {
    const c = video({ newTrackSid: 'v2', previousVideoSid: 'v1', previousAudioSid: 'a1' });
    expect(c.wasAudioTrackChanged).toBe(false);
    expect(c.staleAudioInStream).toBe(false);
  });
});

describe('аудио', () => {
  it('первое аудио — стрим не пересобираем', () => {
    const c = audio({ newTrackSid: 'a1', previousAudioSid: null });
    expect(c.needsFreshStream).toBe(false);
  });

  it('партнёр вернулся с новым аудио-треком — нужен новый стрим', () => {
    const c = audio({ newTrackSid: 'a2', previousAudioSid: 'a1' });
    expect(c.wasAudioTrackChanged).toBe(true);
    expect(c.needsFreshStream).toBe(true);
    expect(c.freshStreamReason).toBe('audio_replace');
  });

  it('чужая аудио-дорожка в стриме — пересобираем, даже если sid тот же', () => {
    const mine = { id: 'mine' };
    const stale = { id: 'stale' };
    const c = audio({
      newTrackSid: 'a1',
      previousAudioSid: 'a1',
      incomingMediaTrack: mine,
      existingAudioMediaTracks: [stale],
    });
    expect(c.wasAudioTrackChanged).toBe(false);
    expect(c.staleAudioInStream).toBe(true);
    expect(c.needsFreshStream).toBe(true);
    expect(c.freshStreamReason).toBe('audio_replace');
  });

  it('своя же дорожка в стриме чужой не считается', () => {
    const mine = { id: 'mine' };
    const c = audio({
      newTrackSid: 'a1',
      previousAudioSid: 'a1',
      incomingMediaTrack: mine,
      existingAudioMediaTracks: [mine],
    });
    expect(c.staleAudioInStream).toBe(false);
    expect(c.needsFreshStream).toBe(false);
  });

  it('без MediaStreamTrack о «чужой дорожке» судить нельзя', () => {
    const c = audio({
      newTrackSid: 'a1',
      previousAudioSid: 'a1',
      incomingMediaTrack: undefined,
      existingAudioMediaTracks: [{ id: 'stale' }],
    });
    expect(c.staleAudioInStream).toBe(false);
  });

  it('null-дорожки в стриме игнорируются', () => {
    const mine = { id: 'mine' };
    const c = audio({
      newTrackSid: 'a1',
      previousAudioSid: 'a1',
      incomingMediaTrack: mine,
      existingAudioMediaTracks: [null, undefined],
    });
    expect(c.staleAudioInStream).toBe(false);
  });
});

describe('причина пересборки', () => {
  it('смена аудио перевешивает видео, когда совпали оба признака', () => {
    const c = describeRemoteTrackChange({
      isVideoTrack: false,
      isAudioTrack: true,
      newTrackSid: 'a2',
      previousAudioSid: 'a1',
      previousVideoSid: 'v1',
    });
    expect(c.freshStreamReason).toBe('audio_replace');
  });
});
