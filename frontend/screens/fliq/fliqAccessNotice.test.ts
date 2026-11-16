import { shouldSuggestYoutubeVpn } from './fliqAccessPolicy';

const online = { active: true, shown: false, connected: true, internetReachable: true };
it.each([-1, -3, undefined])('suggests VPN for a reachable network and YouTube failure %s', code => {
  expect(shouldSuggestYoutubeVpn({ ...online, code })).toBe(true);
});
it.each([-2, 2, 5, 100, 101, 150])('does not call unavailable videos or media errors regional restrictions: %s', code => {
  expect(shouldSuggestYoutubeVpn({ ...online, code })).toBe(false);
});
it.each([
  { active: false }, { shown: true }, { connected: false }, { connected: null }, { internetReachable: false },
])('does not show the notice for %j', state => {
  expect(shouldSuggestYoutubeVpn({ ...online, ...state })).toBe(false);
});
