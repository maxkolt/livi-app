import {
  buildLiveKitSignalProxyUrl,
  isLikelyLiveKitSignalError,
  isLiveKitSignalProxyUrl,
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

  it('не путает ошибку ICE с signaling', () => {
    expect(isLikelyLiveKitSignalError('could not establish pc connection')).toBe(false);
  });

  it('узнаёт уже применённый proxy URL', () => {
    expect(
      isLiveKitSignalProxyUrl('wss://api.liviapp.com/livekit/', 'https://api.liviapp.com'),
    ).toBe(true);
  });
});
