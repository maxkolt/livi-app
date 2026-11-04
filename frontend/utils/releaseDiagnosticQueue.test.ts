import { DIAGNOSTIC_QUEUE_KEY, ReleaseDiagnosticQueue, type ReleaseDiagnosticEvent } from './releaseDiagnosticQueue';
const event = (id: string, level: ReleaseDiagnosticEvent['level'] = 'info'): ReleaseDiagnosticEvent => ({ id, at: Date.now(), session: 'session', event: 'test_event', level, data: {} });
function fixture() {
  const store = new Map<string, string>();
  const storage = { getItem: jest.fn(async (key: string) => store.get(key) || null),
    setItem: jest.fn(async (key: string, value: string) => { store.set(key, value); }) };
  return { store, storage, queue: new ReleaseDiagnosticQueue(storage) };
}
it('retains events offline and retries the same IDs after process restart', async () => {
  const { queue, storage } = fixture();
  await queue.enqueue(event('a'));
  await queue.flush(async () => false);
  const restarted = new ReleaseDiagnosticQueue(storage), send = jest.fn(async (_rows: ReleaseDiagnosticEvent[]) => true);
  await restarted.flush(send);
  expect(send.mock.calls[0][0].map((row: ReleaseDiagnosticEvent) => row.id)).toEqual(['a']);
  await restarted.flush(send);
  expect(send).toHaveBeenCalledTimes(1);
});
it('does not delete events enqueued while a batch is uploading', async () => {
  const { queue } = fixture();
  await queue.enqueue(event('a'));
  let release!: (ok: boolean) => void;
  const wait = new Promise<boolean>(resolve => { release = resolve; });
  const send = jest.fn().mockImplementationOnce(() => wait).mockResolvedValue(false);
  const flush = queue.flush(send);
  while (!send.mock.calls.length) await Promise.resolve();
  await queue.enqueue(event('b'));
  release(true); await flush;
  expect(send.mock.calls[1][0].map((row: ReleaseDiagnosticEvent) => row.id)).toEqual(['b']);
});
it('never overwrites an unreadable queue with an empty one', async () => {
  const { queue, storage } = fixture();
  storage.getItem.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(queue.enqueue(event('a'))).rejects.toThrow('storage unavailable');
  expect(storage.setItem).not.toHaveBeenCalled();
  await queue.enqueue(event('b'));
  const send = jest.fn(async (_rows: ReleaseDiagnosticEvent[]) => true); await queue.flush(send);
  expect(send.mock.calls[0][0].map((row: ReleaseDiagnosticEvent) => row.id)).toEqual(['b']);
});
it('serializes concurrent writes and bounds the queue while preserving errors first', async () => {
  const { queue, store } = fixture();
  await queue.enqueue(event('error', 'error'));
  await Promise.all(Array.from({ length: 1005 }, (_, i) => queue.enqueue(event(`e${i}`))));
  const saved = JSON.parse(store.get(DIAGNOSTIC_QUEUE_KEY)!);
  expect(saved.rows).toHaveLength(1000);
  expect(saved.rows[0].id).toBe('error');
  expect(saved.dropped).toBe(6);
});
it('keeps buffers separate for different installations', async () => {
  const { storage } = fixture();
  const a = new ReleaseDiagnosticQueue(storage, 'owner-a'), b = new ReleaseDiagnosticQueue(storage, 'owner-b');
  await a.enqueue(event('private-to-a'));
  const send = jest.fn(async () => true); await b.flush(send);
  expect(send).not.toHaveBeenCalled();
});
