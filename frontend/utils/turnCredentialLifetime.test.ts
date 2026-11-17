import { hasFreshTurnCredentials, iceCacheDeadline, isTurnUrl } from './turnCredentialLifetime';

const now = 1_794_888_000_000;
const turn = (offset: number): RTCIceServer => ({ urls: 'turns:relay.test:443',
  username: String((now + offset) / 1000), credential: 'temporary-test-credential' });

it('refreshes before the absolute expiry even when the advertised TTL is longer', () => {
  expect(iceCacheDeadline([turn(60_000)], 600, now)).toBe(now + 30_000);
  expect(hasFreshTurnCredentials(turn(60_000), now + 30_000)).toBe(false);
});

it.each([0, -6000, 29_000, 30_000])('rejects credentials expiring in %i ms', offset => {
  expect(hasFreshTurnCredentials(turn(offset), now)).toBe(false);
});

it('uses the earliest expiry across relay servers and never extends a short TTL', () => {
  expect(iceCacheDeadline([turn(600_000), turn(120_000)], 600, now)).toBe(now + 90_000);
  expect(iceCacheDeadline([turn(600_000)], 10, now)).toBe(now + 9000);
});

it('keeps static TURN usernames and STUN-only fallbacks usable', () => {
  const staticTurn = { urls: 'turn:relay.test', username: 'static-user', credential: 'test' };
  expect(hasFreshTurnCredentials(staticTurn, now)).toBe(true);
  expect(iceCacheDeadline([staticTurn], '600', now)).toBe(now + 540_000);
  expect(iceCacheDeadline([{ urls: 'stun:stun.test' }], 'invalid', now)).toBe(now + 270_000);
  expect(hasFreshTurnCredentials({ urls: 'turn:relay.test' }, now)).toBe(false);
});

it('supports both TURN transports and timestamp-prefixed REST usernames', () => {
  expect(isTurnUrl('turn:relay.test')).toBe(true); expect(isTurnUrl('turns:relay.test')).toBe(true);
  expect(isTurnUrl('stun:relay.test')).toBe(false);
  expect(hasFreshTurnCredentials({ ...turn(0), username: turn(0).username + ':device' }, now)).toBe(false);
});
