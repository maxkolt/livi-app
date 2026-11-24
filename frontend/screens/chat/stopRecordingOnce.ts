const stops = new WeakMap<object, Promise<unknown>>();

/** Release, timeout and unmount may race. The native recorder has one stop owner. */
export function stopRecordingOnce<T>(recording: { stopAndUnloadAsync: () => Promise<T> }): Promise<T> {
  const pending = stops.get(recording);
  if (pending) return pending as Promise<T>;
  const stop = Promise.resolve().then(() => recording.stopAndUnloadAsync());
  stops.set(recording, stop);
  return stop;
}
