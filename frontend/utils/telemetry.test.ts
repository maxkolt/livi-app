jest.mock('react-native', () => ({
  NativeModules: { LiviAppModule: { trackAppEvent: jest.fn(), trackAppError: jest.fn() } },
}));
jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));

import { NativeModules } from 'react-native';
import { logger } from './logger';
import { trackReleaseError, trackReleaseEvent } from './telemetry';

const bridge = NativeModules.LiviAppModule as {
  trackAppEvent: jest.Mock;
  trackAppError: jest.Mock;
};

it('redacts private fields and credentials before sending event metadata to the native bridge', () => {
  trackReleaseEvent('signal_reconnect', {
    phase: 'reconnected', count: 2, durationMs: 1200, connected: true, callId: ' c1 ',
    authorization: 'Bearer private-access-value',
    installSecret: 'private-install-value',
    feedbackText: 'private feedback body',
    mediaUri: 'content://private/photo.jpg',
    imageUrl: 'https://media.example/private-photo',
    nested: {
      password: 'private-password-value',
      details: 'Bearer private-bearer-value mongodb+srv://account:private-db-value@db.example/app',
      endpoint: 'https://account:private-url-password@api.example/request',
      preview: 'data:image/png;base64,cHJpdmF0ZQ==',
    },
  });

  expect(bridge.trackAppEvent).toHaveBeenCalledTimes(1);
  const [event, json] = bridge.trackAppEvent.mock.calls[0];
  expect(event).toBe('signal_reconnect');
  expect(JSON.parse(json)).toMatchObject({
    phase: 'reconnected', count: 2, durationMs: 1200, connected: true, callId: 'c1',
    authorization: '[REDACTED]', installSecret: '[REDACTED]', feedbackText: '[REDACTED]',
    mediaUri: '[REDACTED]', imageUrl: '[REDACTED]',
  });
  for (const value of [
    'private-access-value', 'private-install-value', 'private feedback body', 'content://private',
    'private-photo', 'private-password-value', 'private-bearer-value', 'private-db-value',
    'private-url-password', 'cHJpdmF0ZQ==',
  ]) expect(json).not.toContain(value);
});

it('keeps useful cyclic event metadata serializable without exposing its private fields', () => {
  const payload: Record<string, unknown> = { phase: 'retry', count: 3, secret: 'private-cyclic-value' };
  payload.self = payload;
  expect(() => trackReleaseEvent('signal_reconnect', payload)).not.toThrow();
  const json = bridge.trackAppEvent.mock.calls[0][1] as string;
  expect(JSON.parse(json)).toMatchObject({ phase: 'retry', count: 3 });
  expect(json).toContain('[Circular]');
  expect(json).not.toContain('private-cyclic-value');
});

it.each([
  [new TypeError('ordinary private message body without recognizable secret patterns'), 'TypeError'],
  ['private text supplied as a thrown string', 'Error'],
  [Object.assign(new Error('Bearer private-error-value'), { name: 'private custom error name' }), 'Error'],
])('reports only a known error category, with redacted metadata', (error, category) => {
  trackReleaseError('js_error', error, {
    phase: 'connecting', attempt: 2, feedbackText: 'private error feedback',
    uri: 'file:///private/image.jpg', nested: { token: 'private-error-token' },
  });

  expect(bridge.trackAppError).toHaveBeenCalledTimes(1);
  const [event, message, json] = bridge.trackAppError.mock.calls[0];
  expect(event).toBe('js_error');
  expect(message).toBe(category);
  expect(JSON.parse(json)).toMatchObject({
    phase: 'connecting', attempt: 2, errorName: category,
    feedbackText: '[REDACTED]', uri: '[REDACTED]', nested: { token: '[REDACTED]' },
  });
  const output = JSON.stringify([bridge.trackAppError.mock.calls, (logger.warn as jest.Mock).mock.calls]);
  for (const value of [
    'ordinary private message body', 'private text supplied', 'private custom error name',
    'private-error-value', 'private error feedback', 'file:///private', 'private-error-token',
  ]) expect(output).not.toContain(value);
});
