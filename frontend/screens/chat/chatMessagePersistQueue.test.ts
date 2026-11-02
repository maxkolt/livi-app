import { createChatMessagePersistQueue, type ChatPersistSnapshot } from './chatMessagePersistQueue';

const snapshot = (): ChatPersistSnapshot => ({
  key: 'chat_messages_me_peer', userId: 'me', peerId: 'peer', lang: 'ru',
  messages: [{ id: 'voice-1', type: 'audio', uri: 'file:///voice.m4a' }],
});

it('does not rewrite or republish a saved large history when its screen closes', async () => {
  const write = jest.fn(async () => {});
  const publish = jest.fn();
  const enqueue = createChatMessagePersistQueue(write, publish);
  const history = snapshot();
  history.messages = Array.from({ length: 15_000 }, (_, i) => ({ id: String(i), type: 'video_note' }));
  await enqueue(history);
  await enqueue({ ...history });
  expect(write).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
});

it('shares an unfinished write with an immediate background or unmount flush', async () => {
  let finish!: () => void;
  const write = jest.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const enqueue = createChatMessagePersistQueue(write, jest.fn());
  const history = snapshot();
  const first = enqueue(history);
  expect(enqueue({ ...history })).toBe(first);
  expect(write).toHaveBeenCalledTimes(1);
  finish();
  await first;
});

it('reserves changed snapshots in storage order before another screen can write', async () => {
  const jobs: Array<() => void> = [];
  const write = jest.fn(() => new Promise<void>(resolve => jobs.push(resolve)));
  const enqueue = createChatMessagePersistQueue(write, jest.fn());
  const first = snapshot();
  const second = { ...first, messages: [...first.messages, { id: 'newer', type: 'text', text: 'newer' }] };
  const a = enqueue(first);
  const b = enqueue(second);
  expect(write.mock.calls).toHaveLength(2);
  // The second snapshot is registered now, rather than waiting behind a per-screen promise.
  jobs.forEach(finish => finish());
  await Promise.all([a, b]);
  await enqueue(second);
  expect(write).toHaveBeenCalledTimes(2);
});

it('retries an unchanged snapshot after a failed write', async () => {
  const write = jest.fn<Promise<void>, [ChatPersistSnapshot]>()
    .mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValueOnce(undefined);
  const enqueue = createChatMessagePersistQueue(write, jest.fn());
  const history = snapshot();
  await expect(enqueue(history)).rejects.toThrow('storage unavailable');
  await enqueue(history);
  expect(write).toHaveBeenCalledTimes(2);
});

it('does not skip a deliberate return to a saved snapshot while a changed write is pending', async () => {
  const write = jest.fn(async (_snapshot: ChatPersistSnapshot) => {});
  const enqueue = createChatMessagePersistQueue(write, jest.fn());
  const first = snapshot();
  await enqueue(first);
  let finish!: () => void;
  write.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const changed = enqueue({ ...first, messages: [...first.messages, { id: 'temporary' }] });
  const restored = enqueue(first);
  expect(write).toHaveBeenCalledTimes(3);
  finish();
  await Promise.all([changed, restored]);
});

it('does not deduplicate another chat that happens to use the same array', async () => {
  const write = jest.fn(async () => {});
  const enqueue = createChatMessagePersistQueue(write, jest.fn());
  const history = snapshot();
  await enqueue(history);
  await enqueue({ ...history, key: 'chat_messages_me_other', peerId: 'other' });
  expect(write).toHaveBeenCalledTimes(2);
});

it('updates translated previews without rewriting the saved history', async () => {
  const write = jest.fn(async () => {});
  const publish = jest.fn();
  const enqueue = createChatMessagePersistQueue(write, publish);
  const history = snapshot();
  await enqueue(history);
  await enqueue({ ...history, lang: 'en' });
  expect(write).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(2);
});
