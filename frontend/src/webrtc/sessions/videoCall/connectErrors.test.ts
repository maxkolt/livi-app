import {
  isClientDisconnectError,
  isIgnorablePublishError,
  isInvalidApiKeyError,
  isLikelyDnsResolutionError,
  isTransientPcConnectionError,
} from './connectErrors';

describe('isInvalidApiKeyError', () => {
  it.each(['invalid API key', 'HTTP 401', 'Unauthorized'])('узнаёт «%s»', (msg) => {
    expect(isInvalidApiKeyError(msg)).toBe(true);
  });

  it('не срабатывает на посторонних ошибках', () => {
    expect(isInvalidApiKeyError('connection closed')).toBe(false);
    expect(isInvalidApiKeyError('')).toBe(false);
  });
});

describe('isClientDisconnectError', () => {
  it.each(['Client initiated disconnect', 'user initiated disconnect'])('узнаёт «%s»', (msg) => {
    expect(isClientDisconnectError(msg)).toBe(true);
  });

  it('разрыв со стороны сервера сюда не попадает', () => {
    expect(isClientDisconnectError('server shutdown')).toBe(false);
  });
});

describe('isTransientPcConnectionError', () => {
  it.each([
    'could not establish pc connection',
    'PC connection failed',
    'negotiation timed out',
    'negotiation disconnected',
    'transport error',
    'ICE failed',
    'ice disconnected',
  ])('узнаёт «%s» (повод для relay-ретрая)', (msg) => {
    expect(isTransientPcConnectionError(msg)).toBe(true);
  });

  it('регистр не важен', () => {
    expect(isTransientPcConnectionError('COULD NOT ESTABLISH PC CONNECTION')).toBe(true);
  });

  it('не путает с ошибкой ключа — relay-ретрай там не поможет', () => {
    expect(isTransientPcConnectionError('invalid API key')).toBe(false);
  });
});

describe('isIgnorablePublishError', () => {
  it.each(['track already published', 'duplicate track', 'connection closed', 'room disconnected'])(
    'узнаёт «%s»',
    (msg) => {
      expect(isIgnorablePublishError(msg)).toBe(true);
    }
  );

  it('настоящая ошибка публикации не глушится', () => {
    expect(isIgnorablePublishError('publication timed out')).toBe(false);
    expect(isIgnorablePublishError('')).toBe(false);
  });
});

describe('isLikelyDnsResolutionError', () => {
  it.each(['Unable to resolve host', 'ENAME_NOT_RESOLVED', 'DNS lookup failed', 'host lookup failed'])(
    'узнаёт «%s» независимо от регистра',
    (msg) => {
      expect(isLikelyDnsResolutionError(msg)).toBe(true);
    }
  );

  it('обычный таймаут не считается DNS-проблемой', () => {
    expect(isLikelyDnsResolutionError('connection timed out')).toBe(false);
  });
});

describe('устойчивость к нестроковому входу', () => {
  it.each([
    ['isInvalidApiKeyError', isInvalidApiKeyError],
    ['isClientDisconnectError', isClientDisconnectError],
    ['isTransientPcConnectionError', isTransientPcConnectionError],
    ['isIgnorablePublishError', isIgnorablePublishError],
    ['isLikelyDnsResolutionError', isLikelyDnsResolutionError],
  ])('%s не падает на null/undefined', (_name, fn) => {
    expect(fn(null as any)).toBe(false);
    expect(fn(undefined as any)).toBe(false);
  });
});
