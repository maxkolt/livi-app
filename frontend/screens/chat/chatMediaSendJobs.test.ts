import { getChatMediaSend, trackChatMediaSend } from './chatMediaSendJobs';

it('isolates identical optimistic ids by account and peer, and releases completed work', async () => {
  let finish!: (value: boolean) => void;
  const tracked = trackChatMediaSend('user', 'peer-a', 'same-id', new Promise(resolve => { finish = resolve; }));
  expect(getChatMediaSend('user', 'peer-a', 'same-id')).toBe(tracked);
  expect(getChatMediaSend('other-user', 'peer-a', 'same-id')).toBeUndefined();
  expect(getChatMediaSend('user', 'peer-b', 'same-id')).toBeUndefined();
  finish(true);
  await expect(tracked).resolves.toBe(true);
  expect(getChatMediaSend('user', 'peer-a', 'same-id')).toBeUndefined();
});

it('releases failed work so a later retry can run', async () => {
  const failed = trackChatMediaSend('user', 'peer', 'failure', Promise.reject(new Error('network')));
  await expect(failed).rejects.toThrow('network');
  expect(getChatMediaSend('user', 'peer', 'failure')).toBeUndefined();
  const retried = trackChatMediaSend('user', 'peer', 'failure', Promise.resolve(false));
  await expect(retried).resolves.toBe(false);
  expect(getChatMediaSend('user', 'peer', 'failure')).toBeUndefined();
});
