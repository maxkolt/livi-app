import {
  getLocalVideoPublication,
  isAudioTrackPublished,
  isVideoTrackPublished,
  stopLocalAudioTrackSafely,
  stopLocalVideoTrackSafely,
} from './localTrackPublications';

const makeTrack = (sid = 'sid-1') => ({ sid }) as any;

const roomWith = (video: unknown, audio: unknown = new Map()) =>
  ({ localParticipant: { videoTrackPublications: video, audioTrackPublications: audio } }) as any;

describe('isVideoTrackPublished', () => {
  const track = makeTrack();

  it('находит трек в Map-публикациях по ссылке', () => {
    const room = roomWith(new Map([['a', { track }]]));
    expect(isVideoTrackPublished(room, track)).toBe(true);
  });

  it('находит трек в Map-публикациях по trackSid', () => {
    const room = roomWith(new Map([['a', { trackSid: 'sid-1' }]]));
    expect(isVideoTrackPublished(room, track)).toBe(true);
  });

  it('находит трек в массиве публикаций (старые сборки SDK)', () => {
    const room = roomWith([{ trackSid: 'other' }, { track }]);
    expect(isVideoTrackPublished(room, track)).toBe(true);
  });

  it('false, когда трека среди публикаций нет', () => {
    expect(isVideoTrackPublished(roomWith(new Map([['a', { trackSid: 'other' }]])), track)).toBe(false);
    expect(isVideoTrackPublished(roomWith([]), track)).toBe(false);
  });

  it('false без комнаты, без трека и без localParticipant', () => {
    expect(isVideoTrackPublished(null, track)).toBe(false);
    expect(isVideoTrackPublished(roomWith(new Map()), null)).toBe(false);
    expect(isVideoTrackPublished({} as any, track)).toBe(false);
  });

  it('падение SDK не пробрасывается наружу', () => {
    const exploding = {
      localParticipant: {
        get videoTrackPublications() {
          throw new Error('sdk boom');
        },
      },
    } as any;
    expect(isVideoTrackPublished(exploding, track)).toBe(false);
  });
});

describe('isAudioTrackPublished', () => {
  const track = makeTrack('audio-1');

  it('смотрит в audioTrackPublications, а не в видео', () => {
    const room = roomWith(new Map([['v', { track }]]), new Map());
    expect(isAudioTrackPublished(room, track)).toBe(false);
    expect(isAudioTrackPublished(roomWith(new Map(), new Map([['a', { track }]])), track)).toBe(true);
  });
});

describe('getLocalVideoPublication', () => {
  it('возвращает первую публикацию из Map', () => {
    const first = { track: makeTrack() };
    expect(getLocalVideoPublication(roomWith(new Map<string, any>([['a', first], ['b', {}]])))).toBe(first);
  });

  it('возвращает первую публикацию из массива', () => {
    const first = { track: makeTrack() };
    expect(getLocalVideoPublication(roomWith([first, {}]))).toBe(first);
  });

  it('возвращает первое значение из обычного объекта', () => {
    const first = { track: makeTrack() };
    expect(getLocalVideoPublication(roomWith({ a: first }))).toBe(first);
  });

  it('null для пустых публикаций и отсутствующей комнаты', () => {
    expect(getLocalVideoPublication(roomWith(new Map()))).toBeNull();
    expect(getLocalVideoPublication(roomWith(null))).toBeNull();
    expect(getLocalVideoPublication(null)).toBeNull();
  });
});

describe('stopLocalVideoTrackSafely', () => {
  it('сначала гасит захват кадров, потом останавливает трек', () => {
    const order: string[] = [];
    const mediaStreamTrack = {
      set enabled(v: boolean) {
        order.push(`enabled=${v}`);
      },
    };
    const track = {
      mediaStreamTrack,
      mute: () => {
        order.push('mute');
        return Promise.resolve();
      },
      stop: () => order.push('stop'),
    } as any;

    stopLocalVideoTrackSafely(track);
    expect(order).toEqual(['enabled=false', 'mute', 'stop']);
  });

  it('отклонённый mute() не мешает stop()', () => {
    const stop = jest.fn();
    const track = { mediaStreamTrack: {}, mute: () => Promise.reject(new Error('x')), stop } as any;
    expect(() => stopLocalVideoTrackSafely(track)).not.toThrow();
    expect(stop).toHaveBeenCalled();
  });

  it('падение mute() не мешает stop()', () => {
    const stop = jest.fn();
    const track = {
      mediaStreamTrack: {},
      mute: () => {
        throw new Error('sdk boom');
      },
      stop,
    } as any;
    expect(() => stopLocalVideoTrackSafely(track)).not.toThrow();
    expect(stop).toHaveBeenCalled();
  });

  it('null-трек — но-оп', () => {
    expect(() => stopLocalVideoTrackSafely(null)).not.toThrow();
  });
});

describe('stopLocalAudioTrackSafely', () => {
  it('останавливает трек и глушит ошибки SDK', () => {
    const stop = jest.fn();
    stopLocalAudioTrackSafely({ stop } as any);
    expect(stop).toHaveBeenCalled();
    expect(() =>
      stopLocalAudioTrackSafely({
        stop: () => {
          throw new Error('sdk boom');
        },
      } as any)
    ).not.toThrow();
    expect(() => stopLocalAudioTrackSafely(null)).not.toThrow();
  });
});
