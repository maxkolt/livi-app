import {
  buildLiveKitSignalProxyUrl,
  isLikelyLiveKitSignalError,
  isLiveKitSignalProxyUrl,
  resolveInitialLiveKitSignalRoute,
} from './signalProxy';

describe('LiveKit signal proxy fallback', () => {
  it('строит WSS URL на том же доступном API-домене', () => {
    expect(buildLiveKitSignalProxyUrl('https://api.liviapp.com')).toBe(
      'wss://api.liviapp.com/livekit',
    );
    expect(buildLiveKitSignalProxyUrl('http://10.0.2.2:3000/api/')).toBe(
      'ws://10.0.2.2:3000/api/livekit',
    );
  });

  it('отбрасывает неподдерживаемые и битые адреса', () => {
    expect(buildLiveKitSignalProxyUrl('')).toBeNull();
    expect(buildLiveKitSignalProxyUrl('ftp://api.liviapp.com')).toBeNull();
  });

  it.each([
    'room connection has timed out (signal)',
    'WebSocket connection failed',
    'signaling connection closed',
    'Network request failed',
    'Unable to resolve host livekit.liviapp.com',
  ])('распознаёт ошибку signaling: %s', (message) => {
    expect(isLikelyLiveKitSignalError(message)).toBe(true);
  });

  it('распознаёт таймаут в том виде, как его отдаёт room.connect (livekit-client 2.16)', () => {
    // Room.connect оборачивает ошибку SignalClient: "<своё>: <исходное сообщение>".
    expect(
      isLikelyLiveKitSignalError(
        'could not establish signal connection: room connection has timed out (signal)',
      ),
    ).toBe(true);
  });

  it('не уходит в proxy, когда connect отменили мы сами', () => {
    expect(isLikelyLiveKitSignalError('Signal connection aborted: Abort handler called')).toBe(false);
  });

  it('не путает ошибку ICE с signaling', () => {
    expect(isLikelyLiveKitSignalError('could not establish pc connection')).toBe(false);
  });

  it('узнаёт уже применённый proxy URL', () => {
    expect(
      isLiveKitSignalProxyUrl('wss://api.liviapp.com/livekit/', 'https://api.liviapp.com'),
    ).toBe(true);
  });

  it('выбирает API-proxy первым и сохраняет прямой URL как обратный резерв', () => {
    expect(
      resolveInitialLiveKitSignalRoute(
        'wss://livekit.liviapp.com',
        'https://api.liviapp.com',
        true,
      ),
    ).toEqual({
      url: 'wss://api.liviapp.com/livekit',
      directSignalUrl: 'wss://livekit.liviapp.com',
      signalProxyTried: true,
    });
  });

  it('kill-switch оставляет прямой signaling первым', () => {
    expect(
      resolveInitialLiveKitSignalRoute(
        'wss://livekit.liviapp.com',
        'https://api.liviapp.com',
        false,
      ),
    ).toEqual({
      url: 'wss://livekit.liviapp.com',
      signalProxyTried: false,
    });
  });
});
