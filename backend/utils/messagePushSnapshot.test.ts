import { messagePushSnapshotData, type MessagePushSnapshot } from './messagePushSnapshot';

const snapshot: MessagePushSnapshot = {
  type: 'message', messageId: 'm3', from: 'peer', to: 'me', fromNick: 'Alex',
  sentAt: '2026-11-04T17:00:00.000Z', unreadCount: 8, unreadFromSender: 3,
  unreadUpdatedAt: 1793811600000, messagePreview: 'newest message',
};

it('keeps the global badge and exact per-chat count separate in both push transports', () => {
  expect(messagePushSnapshotData(snapshot, true)).toEqual({
    type: 'message', messageId: 'm3', fromUserId: 'peer', to: 'me', fromNick: 'Alex',
    sentAt: snapshot.sentAt, unreadCount: '8', unreadFromSender: '3',
    unreadUpdatedAt: String(snapshot.unreadUpdatedAt), messagePreview: 'newest message',
  });
  expect(messagePushSnapshotData(snapshot)).toMatchObject({ from: 'peer', unreadFromSender: '3' });
});

it('ships the encrypted envelope without a plaintext preview', () => {
  const enc = { v: 1, n: 'nonce', c: 'ciphertext', spk: 'sender key', rpk: 'recipient key' };
  const data = messagePushSnapshotData({ ...snapshot, messagePreview: '', enc }, true);
  expect(data.messagePreview).toBe('');
  expect(JSON.parse(data.enc)).toEqual(enc);
});

it('retains notification delivery when a ciphertext exceeds the FCM payload budget', () => {
  const enc = { v: 1, n: 'nonce', c: 'a'.repeat(4000), spk: 'sender', rpk: 'recipient' };
  const data = messagePushSnapshotData({ ...snapshot, messagePreview: '', enc }, true);
  expect(data.enc).toBeUndefined();
  expect(data.messageId).toBe('m3');
  expect(data.unreadFromSender).toBe('3');
  expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(4096);
});
