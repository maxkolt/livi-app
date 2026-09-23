import { RemoteTrackSubscriber, type RemoteTrackSubscriberHost } from './RemoteTrackSubscriber';

type FakePublication = {
  trackSid: string;
  isSubscribed: boolean;
  track: any;
  setSubscribed: jest.Mock;
};

function makePublication(over: Partial<FakePublication> = {}): FakePublication {
  const pub: FakePublication = {
    trackSid: 'sid-1',
    isSubscribed: false,
    track: null,
    setSubscribed: jest.fn(),
    ...over,
  };
  pub.setSubscribed = pub.setSubscribed ?? jest.fn();
  return pub;
}

const makeTrack = () => ({ mediaStreamTrack: { readyState: 'live' } });

function makeParticipant(audio: FakePublication[] = [], video: FakePublication[] = []) {
  return {
    identity: 'partner',
    audioTrackPublications: new Map(audio.map((p, i) => [`a${i}`, p])),
    videoTrackPublications: new Map(video.map((p, i) => [`v${i}`, p])),
  } as any;
}

function makeRoom(participants: any[] = [], state = 'connected') {
  return {
    state,
    remoteParticipants: new Map(participants.map((p, i) => [`p${i}`, p])),
  } as any;
}

function makeHost(over: Partial<RemoteTrackSubscriberHost> = {}) {
  return {
    isCurrentRoom: jest.fn(() => true),
    shouldDeferVideo: jest.fn(() => false),
    shouldSkipRedundantDelayedApply: jest.fn(() => false),
    applyTrack: jest.fn(),
    ...over,
  } as RemoteTrackSubscriberHost & Record<string, jest.Mock>;
}

describe('RemoteTrackSubscriber', () => {
  let warnSpy: jest.SpyInstance;
  let quietSpies: jest.SpyInstance[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
    // Подписка подробно логируется — в тестах это ожидаемый шум.
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    quietSpies = [
      jest.spyOn(console, 'info').mockImplementation(() => {}),
      jest.spyOn(console, 'log').mockImplementation(() => {}),
      jest.spyOn(console, 'debug').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    jest.useRealTimers();
    warnSpy.mockRestore();
    quietSpies.forEach((spy) => spy.mockRestore());
  });

  describe('subscribeToParticipant', () => {
    it('применяет уже загруженный трек сразу, без ожидания TrackSubscribed', () => {
      const track = makeTrack();
      const pub = makePublication({ isSubscribed: true, track });
      const host = makeHost();
      const room = makeRoom();

      new RemoteTrackSubscriber(host).subscribeToParticipant(makeParticipant([pub]), room, 'ctx');

      expect(host.applyTrack).toHaveBeenCalledWith(track, pub, expect.anything());
      expect(pub.setSubscribed).not.toHaveBeenCalled();
    });

    it('подписывается явно, если публикация помечена subscribed, но трека нет', () => {
      const pub = makePublication({ isSubscribed: true, track: null });
      const host = makeHost();

      new RemoteTrackSubscriber(host).subscribeToParticipant(makeParticipant([pub]), makeRoom(), 'ctx');

      expect(pub.setSubscribed).toHaveBeenCalledWith(true);
      expect(host.applyTrack).not.toHaveBeenCalled();
    });

    it('подхватывает трек, подъехавший через 100 мс после подписки', () => {
      const pub = makePublication();
      const host = makeHost();
      const room = makeRoom();

      new RemoteTrackSubscriber(host).subscribeToParticipant(makeParticipant([pub]), room, 'ctx');
      expect(host.applyTrack).not.toHaveBeenCalled();

      pub.track = makeTrack();
      jest.advanceTimersByTime(100);

      expect(host.applyTrack).toHaveBeenCalledWith(pub.track, pub, expect.anything());
    });

    it('не применяет трек, если комната успела смениться', () => {
      const pub = makePublication();
      const host = makeHost({ isCurrentRoom: jest.fn(() => false) });

      new RemoteTrackSubscriber(host).subscribeToParticipant(makeParticipant([pub]), makeRoom(), 'ctx');
      pub.track = makeTrack();
      jest.advanceTimersByTime(100);

      expect(host.applyTrack).not.toHaveBeenCalled();
    });

    it('не применяет трек, если комната больше не connected', () => {
      const pub = makePublication();
      const host = makeHost();
      const room = makeRoom([], 'reconnecting');

      new RemoteTrackSubscriber(host).subscribeToParticipant(makeParticipant([pub]), room, 'ctx');
      pub.track = makeTrack();
      jest.advanceTimersByTime(100);

      expect(host.applyTrack).not.toHaveBeenCalled();
    });

    it('в audio-only режиме видео не трогаем вовсе', () => {
      const audio = makePublication({ track: makeTrack(), isSubscribed: true });
      const video = makePublication({ trackSid: 'sid-v', track: makeTrack(), isSubscribed: true });
      const host = makeHost({ shouldDeferVideo: jest.fn(() => true) });

      new RemoteTrackSubscriber(host).subscribeToParticipant(makeParticipant([audio], [video]), makeRoom(), 'ctx');

      expect(host.applyTrack).toHaveBeenCalledTimes(1);
      expect(host.applyTrack).toHaveBeenCalledWith(audio.track, audio, expect.anything());
      expect(video.setSubscribed).not.toHaveBeenCalled();
    });

    it('обрабатывает и аудио, и видео, когда defer выключен', () => {
      const audio = makePublication({ track: makeTrack(), isSubscribed: true });
      const video = makePublication({ trackSid: 'sid-v', track: makeTrack(), isSubscribed: true });
      const host = makeHost();

      new RemoteTrackSubscriber(host).subscribeToParticipant(makeParticipant([audio], [video]), makeRoom(), 'ctx');

      expect(host.applyTrack).toHaveBeenCalledTimes(2);
    });
  });

  describe('scheduleDelayedCheck', () => {
    const neverWarn = () => false;

    it('ничего не делает до наступления задержки', () => {
      const pub = makePublication({ track: makeTrack(), isSubscribed: true });
      const host = makeHost();
      const room = makeRoom([makeParticipant([pub])]);

      new RemoteTrackSubscriber(host).scheduleDelayedCheck(room, 'First', 500, neverWarn);
      jest.advanceTimersByTime(499);
      expect(host.applyTrack).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(host.applyTrack).toHaveBeenCalledTimes(1);
    });

    it('досоздаёт подписку, если её не случилось', () => {
      const pub = makePublication({ isSubscribed: false, track: makeTrack() });
      const host = makeHost();
      const room = makeRoom([makeParticipant([pub])]);

      new RemoteTrackSubscriber(host).scheduleDelayedCheck(room, 'Second', 1000, neverWarn);
      jest.advanceTimersByTime(1000);

      expect(pub.setSubscribed).toHaveBeenCalledWith(true);
      expect(host.applyTrack).toHaveBeenCalled();
    });

    it('не применяет трек повторно, если он уже подключён первым проходом', () => {
      const pub = makePublication({ track: makeTrack(), isSubscribed: true });
      const host = makeHost({ shouldSkipRedundantDelayedApply: jest.fn(() => true) });
      const room = makeRoom([makeParticipant([pub])]);

      new RemoteTrackSubscriber(host).scheduleDelayedCheck(room, 'First', 500, neverWarn);
      jest.advanceTimersByTime(500);

      expect(host.applyTrack).not.toHaveBeenCalled();
    });

    it('пропускает проход, если комната сменилась или отвалилась', () => {
      const pub = makePublication({ track: makeTrack(), isSubscribed: true });
      const changed = makeHost({ isCurrentRoom: jest.fn(() => false) });
      new RemoteTrackSubscriber(changed).scheduleDelayedCheck(makeRoom([makeParticipant([pub])]), 'First', 500, neverWarn);

      const disconnected = makeHost();
      new RemoteTrackSubscriber(disconnected).scheduleDelayedCheck(
        makeRoom([makeParticipant([pub])], 'disconnected'),
        'First',
        500,
        neverWarn
      );

      jest.advanceTimersByTime(500);
      expect(changed.applyTrack).not.toHaveBeenCalled();
      expect(disconnected.applyTrack).not.toHaveBeenCalled();
    });

    it('уважает audio-only defer и в отложенном проходе', () => {
      const video = makePublication({ trackSid: 'sid-v', track: makeTrack(), isSubscribed: true });
      const host = makeHost({ shouldDeferVideo: jest.fn(() => true) });
      const room = makeRoom([makeParticipant([], [video])]);

      new RemoteTrackSubscriber(host).scheduleDelayedCheck(room, 'First', 500, neverWarn);
      jest.advanceTimersByTime(500);

      expect(host.applyTrack).not.toHaveBeenCalled();
      expect(host.shouldDeferVideo).toHaveBeenCalledWith(video, 'delayed_check_500ms');
    });

    it('про отсутствующий трек шумит warn’ом только когда просят', () => {
      const pub = makePublication({ isSubscribed: true, track: null });
      const room = makeRoom([makeParticipant([pub])]);

      new RemoteTrackSubscriber(makeHost()).scheduleDelayedCheck(room, 'First', 500, () => false);
      jest.advanceTimersByTime(500);
      expect(warnSpy).not.toHaveBeenCalled();

      new RemoteTrackSubscriber(makeHost()).scheduleDelayedCheck(room, 'Second', 1000, () => true);
      jest.advanceTimersByTime(1000);
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
