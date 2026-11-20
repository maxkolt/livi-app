import { redactLogValue } from './redactLog';
it('removes secrets from nested metadata, messages, SDK errors and connection URLs', () => {
  const result = JSON.stringify(redactLogValue({
    headers: { authorization: 'Bearer test-access-token', 'x-install-secret': 'private-install-secret' },
    nested: { token: 'opaque-session-credential', text: 'private-text', feedbackText: 'private feedback', private_key: 'private-key-content' },
    mediaUri: 'content://private/image', mediaUris: ['file:///private/image'],
    imageUrls: ['https://media.example/private-image'],
    error: new Error('connect mongodb+srv://account:password@db.example/x?retryWrites=true'),
    message: 'install=inst_android_12345678 token=private-token user@example.com',
  }));
  for (const value of ['opaque-session-credential','private-text','test-access-token','private-install-secret','private feedback','private-key-content','account:password','12345678','private-token','user@example.com','content://private','file:///private','private-image']) expect(result).not.toContain(value);
});
it('bounds recursive or cyclic metadata and preserves useful error codes', () => {
  const item: { code: string; self?: unknown } = { code: 'network_unavailable' };item.self=item;
  expect(redactLogValue(item)).toEqual({ code: 'network_unavailable', self: '[Circular]' });
});
