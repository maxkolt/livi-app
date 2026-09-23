import {
  buildLiveKitConnectOptions,
  hasUsableTurnServer,
  resolveConnectRtcConfig,
} from './iceConnectOptions';

const turn = (over: Record<string, unknown> = {}) => ({
  urls: 'turn:turn.example.com:3478',
  username: '1700000000',
  credential: 'hmac',
  ...over,
});
const stun = { urls: 'stun:stun.l.google.com:19302' };

const cfg = (iceServers: unknown[], rest: Record<string, unknown> = {}) =>
  ({ iceServers, ...rest }) as RTCConfiguration;

describe('hasUsableTurnServer', () => {
  it('TURN с логином и паролем годится', () => {
    expect(hasUsableTurnServer(cfg([turn()]))).toBe(true);
  });

  it('turns: (TLS) тоже считается', () => {
    expect(hasUsableTurnServer(cfg([turn({ urls: 'turns:turn.example.com:5349' })]))).toBe(true);
  });

  it('TURN в массиве urls находится', () => {
    expect(hasUsableTurnServer(cfg([turn({ urls: [stun.urls, 'turn:turn.example.com:3478'] })]))).toBe(true);
  });

  it('TURN без кредов не годится — ICE на нём зависает', () => {
    expect(hasUsableTurnServer(cfg([turn({ username: '', credential: '' })]))).toBe(false);
    expect(hasUsableTurnServer(cfg([turn({ credential: undefined })]))).toBe(false);
  });

  it('только STUN — TURN нет', () => {
    expect(hasUsableTurnServer(cfg([stun]))).toBe(false);
  });

  it('пустой или отсутствующий конфиг', () => {
    expect(hasUsableTurnServer(cfg([]))).toBe(false);
    expect(hasUsableTurnServer(null)).toBe(false);
    expect(hasUsableTurnServer(undefined)).toBe(false);
    expect(hasUsableTurnServer({} as RTCConfiguration)).toBe(false);
  });
});

describe('resolveConnectRtcConfig', () => {
  it('свой TURN отдаём в connect — ради него всё и затевалось', () => {
    const config = cfg([turn(), stun], { iceTransportPolicy: 'relay' });
    expect(resolveConnectRtcConfig(config)).toBe(config);
  });

  it('STUN-only НЕ отдаём: иначе вытесним серверные ICE-серверы LiveKit и станет хуже', () => {
    expect(resolveConnectRtcConfig(cfg([stun]))).toBeUndefined();
  });

  it('конфиг не загрузился — не вмешиваемся', () => {
    expect(resolveConnectRtcConfig(undefined)).toBeUndefined();
  });

  it('kill-switch возвращает поведение «до фикса»', () => {
    const config = cfg([turn()]);
    expect(resolveConnectRtcConfig(config, { enabled: false })).toBeUndefined();
    expect(resolveConnectRtcConfig(config, { enabled: true })).toBe(config);
  });
});

describe('buildLiveKitConnectOptions', () => {
  it('всегда просит autoSubscribe и заданный таймаут PeerConnection', () => {
    const opts = buildLiveKitConnectOptions({ peerConnectionTimeoutMs: 30_000 });
    expect(opts.autoSubscribe).toBe(true);
    expect(opts.peerConnectionTimeout).toBe(30_000);
  });

  it('со своим TURN кладёт rtcConfig — это и есть починка relay-фоллбэка', () => {
    const rtcConfig = cfg([turn()], { iceTransportPolicy: 'relay' });
    const opts = buildLiveKitConnectOptions({ peerConnectionTimeoutMs: 30_000, rtcConfig });
    expect(opts.rtcConfig).toBe(rtcConfig);
  });

  it('без своего TURN ключа rtcConfig нет вовсе', () => {
    const opts = buildLiveKitConnectOptions({ peerConnectionTimeoutMs: 30_000, rtcConfig: cfg([stun]) });
    expect('rtcConfig' in opts).toBe(false);
  });

  it('с выключенным флагом ведёт себя как старый код', () => {
    const opts = buildLiveKitConnectOptions({
      peerConnectionTimeoutMs: 30_000,
      rtcConfig: cfg([turn()]),
      applyClientIce: false,
    });
    expect('rtcConfig' in opts).toBe(false);
    expect(opts.peerConnectionTimeout).toBe(30_000);
  });

  it('relay-only политика доезжает до connect вместе с TURN', () => {
    const opts = buildLiveKitConnectOptions({
      peerConnectionTimeoutMs: 30_000,
      rtcConfig: cfg([turn()], { iceTransportPolicy: 'relay' }),
    });
    expect(opts.rtcConfig?.iceTransportPolicy).toBe('relay');
  });
});
