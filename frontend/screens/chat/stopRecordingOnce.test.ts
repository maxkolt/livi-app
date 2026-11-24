import { stopRecordingOnce } from './stopRecordingOnce';

it('shares one native stop across release, timeout and unmount, including later cleanup', async () => {
  let finish!: (value: string) => void;
  const recorder = { stopAndUnloadAsync: jest.fn(() => new Promise<string>(resolve => { finish = resolve; })) };
  const first = stopRecordingOnce(recorder);
  const second = stopRecordingOnce(recorder);
  await Promise.resolve();
  expect(recorder.stopAndUnloadAsync).toHaveBeenCalledTimes(1);
  finish('stopped');
  expect(await first).toBe('stopped');
  expect(await second).toBe('stopped');
  expect(await stopRecordingOnce(recorder)).toBe('stopped');
  expect(recorder.stopAndUnloadAsync).toHaveBeenCalledTimes(1);
});

it('does not repeat a failed native stop and does not block a new recording', async () => {
  const broken = { stopAndUnloadAsync: jest.fn(async () => { throw Error('no_data'); }) };
  await expect(stopRecordingOnce(broken)).rejects.toThrow('no_data');
  await expect(stopRecordingOnce(broken)).rejects.toThrow('no_data');
  const next = { stopAndUnloadAsync: jest.fn(async () => 'next') };
  await expect(stopRecordingOnce(next)).resolves.toBe('next');
  expect(broken.stopAndUnloadAsync).toHaveBeenCalledTimes(1);
});
