/** Маршруты вывода из react-native-incall-manager (Android). */
export type InCallAudioRoute = 'EARPIECE' | 'SPEAKER_PHONE' | 'WIRED_HEADSET' | 'BLUETOOTH';

export const INCALL_ROUTE_CYCLE: InCallAudioRoute[] = [
  'EARPIECE',
  'SPEAKER_PHONE',
  'WIRED_HEADSET',
  'BLUETOOTH',
];

export function isExternalHeadsetRoute(
  route: InCallAudioRoute | null | undefined,
): route is 'BLUETOOTH' | 'WIRED_HEADSET' {
  return route === 'WIRED_HEADSET' || route === 'BLUETOOTH';
}

export function routeOrderForAvailable(available: string[]): InCallAudioRoute[] {
  return INCALL_ROUTE_CYCLE.filter(
    (r) => r === 'EARPIECE' || r === 'SPEAKER_PHONE' || available.includes(r),
  );
}

export function nextRouteInCycle(current: InCallAudioRoute, available: string[]): InCallAudioRoute {
  const order = routeOrderForAvailable(available.length ? available : ['EARPIECE', 'SPEAKER_PHONE']);
  const idx = Math.max(0, order.indexOf(current));
  return order[(idx + 1) % order.length];
}

export function iconNameForRoute(
  route: InCallAudioRoute,
): 'ear-hearing' | 'volume-up' | 'headset' | 'bluetooth' {
  switch (route) {
    case 'SPEAKER_PHONE':
      return 'volume-up';
    case 'WIRED_HEADSET':
      return 'headset';
    case 'BLUETOOTH':
      return 'bluetooth';
    case 'EARPIECE':
    default:
      return 'ear-hearing';
  }
}

export function normalizeInCallRoute(raw: string): InCallAudioRoute | null {
  const s = String(raw || '').toUpperCase();
  if (s === 'EARPIECE' || s === 'SPEAKER_PHONE' || s === 'WIRED_HEADSET' || s === 'BLUETOOTH') {
    return s;
  }
  return null;
}
