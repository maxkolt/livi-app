import {
  buildIceTransportSignature,
  extractVideoProgress,
  isNetInfoReachable,
  pickLocalVideoStat,
  readInboundRemotePackets,
} from './mediaStats';

const track = (sid?: string) => ({ sid }) as any;

describe('pickLocalVideoStat', () => {
  it('находит запись по trackSid', () => {
    const stats = [
      { kind: 'video', trackSid: 'other' },
      { kind: 'video', trackSid: 'mine' },
    ];
    expect(pickLocalVideoStat(stats, track('mine'))).toBe(stats[1]);
  });

  it('находит запись по mediaTrackId', () => {
    const stats = [{ kind: 'audio', mediaTrackId: 'mine' }, { kind: 'video', mediaTrackId: 'mine' }];
    expect(pickLocalVideoStat(stats, track('mine'))).toBe(stats[1]);
  });

  it('без совпадения по sid берёт первую video-запись', () => {
    const stats = [{ kind: 'audio' }, { kind: 'VIDEO' }, { kind: 'video' }];
    expect(pickLocalVideoStat(stats, track('missing'))).toBe(stats[1]);
  });

  it('null, когда статистики нет или video-записей нет', () => {
    expect(pickLocalVideoStat([], track('x'))).toBeNull();
    expect(pickLocalVideoStat(undefined as any, track('x'))).toBeNull();
    expect(pickLocalVideoStat([{ kind: 'audio' }], track('x'))).toBeNull();
  });
});

describe('extractVideoProgress', () => {
  it('читает основные имена полей', () => {
    expect(extractVideoProgress({ framesSent: 10, bytesSent: 200, packetsSent: 5 })).toEqual({
      frames: 10,
      bytes: 200,
      packets: 5,
    });
  });

  it('падает на альтернативные имена полей', () => {
    expect(extractVideoProgress({ framesEncoded: 7, bytes: 64, packets: 3 })).toEqual({
      frames: 7,
      bytes: 64,
      packets: 3,
    });
  });

  it('нечисловое и отсутствующее даёт нули (дельта не должна прыгать)', () => {
    expect(extractVideoProgress(null)).toEqual({ frames: 0, bytes: 0, packets: 0 });
    expect(extractVideoProgress({ framesSent: 'nope', bytesSent: NaN })).toEqual({ frames: 0, bytes: 0, packets: 0 });
  });
});

describe('readInboundRemotePackets', () => {
  const roomWith = (reports: any[], path: 'pcManager' | 'engine' = 'pcManager') => {
    const pc = { getStats: async () => ({ forEach: (cb: (r: any) => void) => reports.forEach(cb) }) };
    return {
      state: 'connected',
      engine: path === 'pcManager' ? { pcManager: { subscriber: { pc } } } : { subscriber: { pc } },
    } as any;
  };

  it('берёт максимум packetsReceived по нужному kind', async () => {
    const room = roomWith([
      { type: 'inbound-rtp', kind: 'audio', packetsReceived: 10 },
      { type: 'inbound-rtp', kind: 'audio', packetsReceived: 42 },
      { type: 'inbound-rtp', kind: 'video', packetsReceived: 999 },
    ]);
    await expect(readInboundRemotePackets(room, 'audio')).resolves.toBe(42);
  });

  it('понимает mediaType вместо kind и запасной путь к subscriber PC', async () => {
    const room = roomWith([{ type: 'inbound-rtp', mediaType: 'video', packetsReceived: 7 }], 'engine');
    await expect(readInboundRemotePackets(room, 'video')).resolves.toBe(7);
  });

  it('null, когда подходящих записей нет — это не «ноль пакетов»', async () => {
    const room = roomWith([{ type: 'outbound-rtp', kind: 'audio', packetsReceived: 5 }]);
    await expect(readInboundRemotePackets(room, 'audio')).resolves.toBeNull();
  });

  it('null для неподключённой комнаты, отсутствующего PC и упавшего getStats', async () => {
    await expect(readInboundRemotePackets(null, 'audio')).resolves.toBeNull();
    await expect(readInboundRemotePackets({ state: 'reconnecting' } as any, 'audio')).resolves.toBeNull();
    await expect(readInboundRemotePackets({ state: 'connected', engine: {} } as any, 'audio')).resolves.toBeNull();
    const failing = {
      state: 'connected',
      engine: { pcManager: { subscriber: { pc: { getStats: async () => { throw new Error('boom'); } } } } },
    } as any;
    await expect(readInboundRemotePackets(failing, 'audio')).resolves.toBeNull();
  });
});

describe('buildIceTransportSignature', () => {
  const diag = (over: Record<string, unknown> = {}) =>
    ({
      source: 'publisher',
      usingRelay: false,
      localCandidateType: 'srflx',
      localProtocol: 'udp',
      localRelayProtocol: null,
      remoteCandidateType: 'host',
      remoteProtocol: 'udp',
      selectedCandidatePairId: 'pair-1',
      ...over,
    }) as any;

  it('одинаковые пути дают одинаковую сигнатуру (дедуп логов)', () => {
    expect(buildIceTransportSignature([diag()])).toBe(buildIceTransportSignature([diag()]));
  });

  it('смена транспорта меняет сигнатуру', () => {
    expect(buildIceTransportSignature([diag()])).not.toBe(buildIceTransportSignature([diag({ usingRelay: true })]));
  });

  it('шумные поля вне списка не влияют на сигнатуру', () => {
    expect(buildIceTransportSignature([diag({ currentRoundTripTime: 0.1 })])).toBe(
      buildIceTransportSignature([diag({ currentRoundTripTime: 0.9 })])
    );
  });
});

describe('isNetInfoReachable', () => {
  it('подключены и интернет есть', () => {
    expect(isNetInfoReachable({ isConnected: true, isInternetReachable: true } as any)).toBe(true);
  });

  it('isInternetReachable === null трактуем как «достижима»', () => {
    expect(isNetInfoReachable({ isConnected: true, isInternetReachable: null } as any)).toBe(true);
  });

  it('нет подключения или интернет явно недоступен', () => {
    expect(isNetInfoReachable({ isConnected: false, isInternetReachable: true } as any)).toBe(false);
    expect(isNetInfoReachable({ isConnected: true, isInternetReachable: false } as any)).toBe(false);
  });
});
