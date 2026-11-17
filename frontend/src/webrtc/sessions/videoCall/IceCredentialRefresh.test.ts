import { IceCredentialRefresh } from './IceCredentialRefresh';

const NOW = 1_800_000_000_000;
const config = (seconds: number): RTCConfiguration => ({ iceServers: [{
  urls: ['turn:relay.test:3478', 'turns:relay.test:443'],
  username: String(Math.floor((Date.now() + seconds * 1000) / 1000)), credential: 'temporary',
}] });
function fixture() {
  const original = { ...config(120), iceTransportPolicy: 'relay' as const, encodedInsertableStreams: true };
  Object.freeze(original);
  const updateConfiguration = jest.fn();
  const room = { state: 'connected', engine: { rtcConfig: original,
    pcManager: { publisher: { config: original }, updateConfiguration } } };
  const fetch = jest.fn(async () => config(600));
  const refresh = new IceCredentialRefresh(fetch);
  let current = true;
  refresh.start(room, () => current);
  return { room, fetch, refresh, updateConfiguration, retire: () => { current = false; } };
}
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

it('renews before expiry without an ICE restart and preserves relay/E2EE settings', async () => {
  const f = fixture();
  await jest.advanceTimersByTimeAsync(59_999);
  expect(f.fetch).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(f.updateConfiguration).toHaveBeenCalledWith(expect.objectContaining({
    iceTransportPolicy: 'relay', encodedInsertableStreams: true,
  }), false);
  expect(f.room.engine.rtcConfig.iceServers![0].username).toBe(String((NOW + 660_000) / 1000));
  expect(f.room.engine.rtcConfig).not.toBe(f.room.engine.pcManager.publisher.config);
});
it('never installs STUN-only fallback after a failed credential request', async () => {
  const f = fixture();f.fetch.mockResolvedValue({ iceServers: [{ urls: 'stun:example.test' }] });
  await jest.advanceTimersByTimeAsync(60_000);
  expect(f.updateConfiguration).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(15_000);
  expect(f.fetch).toHaveBeenCalledTimes(2);
});
it('does not renew over a disconnected/reconnecting transport', async () => {
  const f = fixture();f.room.state = 'reconnecting';
  await jest.advanceTimersByTimeAsync(60_000);
  expect(f.fetch).not.toHaveBeenCalled();
  f.room.state = 'connected';await jest.advanceTimersByTimeAsync(15_000);
  expect(f.updateConfiguration).toHaveBeenCalledTimes(1);
});
it('discards credentials that finish downloading after a call ends', async () => {
  const f = fixture();let resolve!: (value: RTCConfiguration) => void;
  f.fetch.mockImplementation(() => new Promise(r => { resolve = r; }));
  await jest.advanceTimersByTimeAsync(60_000);f.refresh.stop();resolve(config(600));
  await jest.advanceTimersByTimeAsync(0);
  expect(f.updateConfiguration).not.toHaveBeenCalled();expect(jest.getTimerCount()).toBe(0);
});
it('discards a late result after Next replaces the room', async () => {
  const f = fixture();let resolve!: (value: RTCConfiguration) => void;
  f.fetch.mockImplementation(() => new Promise(r => { resolve = r; }));
  await jest.advanceTimersByTimeAsync(60_000);f.retire();resolve(config(600));
  await jest.advanceTimersByTimeAsync(0);
  expect(f.updateConfiguration).not.toHaveBeenCalled();expect(jest.getTimerCount()).toBe(0);
});
it('retries a temporary refresh error without closing the media connection', async () => {
  const f = fixture();f.fetch.mockRejectedValueOnce(new Error('offline'));
  await jest.advanceTimersByTimeAsync(60_000);
  expect(f.updateConfiguration).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(15_000);
  expect(f.updateConfiguration).toHaveBeenCalledTimes(1);
});
