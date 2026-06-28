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

/** Где показывается кнопка цикла маршрута. */
export type CallAudioRouteCycleContext = 'audio_ui' | 'in_app_pip' | 'video_ui' | 'system_pip';

/** Аудио-страница и in-app PiP: 3 режима при BT; видео-экран и system PiP: только BT ↔ громкий. */
export function routeOrderForContext(
  context: CallAudioRouteCycleContext,
  available: string[],
): InCallAudioRoute[] {
  const hasBt = available.includes('BLUETOOTH');
  const hasWired = available.includes('WIRED_HEADSET');
  const twoModeVideo = context === 'video_ui' || context === 'system_pip';

  if (twoModeVideo) {
    const order: InCallAudioRoute[] = [];
    if (hasBt) order.push('BLUETOOTH');
    order.push('SPEAKER_PHONE');
    if (hasWired && !hasBt) order.push('WIRED_HEADSET');
    if (order.length === 0) return ['SPEAKER_PHONE'];
    return order;
  }

  const order: InCallAudioRoute[] = [];
  if (hasBt) {
    order.push('BLUETOOTH', 'EARPIECE', 'SPEAKER_PHONE');
  } else {
    order.push('EARPIECE', 'SPEAKER_PHONE');
  }
  if (hasWired && !hasBt) order.push('WIRED_HEADSET');
  if (order.length === 0) return ['EARPIECE', 'SPEAKER_PHONE'];
  return order;
}

/** @deprecated используй routeOrderForContext */
export function routeOrderForAvailable(available: string[]): InCallAudioRoute[] {
  return routeOrderForContext('audio_ui', available);
}

export function cycleRoutesForContext(
  context: CallAudioRouteCycleContext,
  available: string[],
): InCallAudioRoute[] {
  const order = routeOrderForContext(
    context,
    available.length ? available : ['EARPIECE', 'SPEAKER_PHONE'],
  );
  const av = new Set(available.map((s) => String(s)));
  return order.filter((r) => {
    if (r === 'EARPIECE' || r === 'SPEAKER_PHONE') return true;
    return av.has(r);
  });
}

/** Список маршрутов для кнопки цикла (только реально доступные). */
export function cycleRoutesForAvailable(available: string[]): InCallAudioRoute[] {
  return cycleRoutesForContext('audio_ui', available);
}

export function sanitizeRoutesForAudioCycle(
  candidates: string[],
  icmDeviceList: string[],
): string[] {
  const icm = icmDeviceList.map((s) => String(s));
  const cand = new Set(candidates.map((s) => String(s)));
  const out = new Set<string>(['EARPIECE', 'SPEAKER_PHONE']);
  for (const ext of ['BLUETOOTH', 'WIRED_HEADSET'] as const) {
    if (icm.length > 0) {
      if (icm.includes(ext)) out.add(ext);
    } else if (cand.has(ext)) {
      out.add(ext);
    }
  }
  return Array.from(out);
}

function resolveEffectiveCycleRoute(
  current: InCallAudioRoute,
  order: InCallAudioRoute[],
): InCallAudioRoute {
  if (order.includes(current)) return current;
  if (isExternalHeadsetRoute(current)) {
    return order.includes('EARPIECE') ? 'EARPIECE' : order[0] || 'EARPIECE';
  }
  return order[0] || 'EARPIECE';
}

export function nextRouteInCycleForContext(
  current: InCallAudioRoute,
  available: string[],
  context: CallAudioRouteCycleContext,
  icmDeviceList: string[] = [],
): InCallAudioRoute {
  const sanitized = sanitizeRoutesForAudioCycle(
    available.length ? available : ['EARPIECE', 'SPEAKER_PHONE'],
    icmDeviceList,
  );
  const order = cycleRoutesForContext(
    context,
    sanitized.length ? sanitized : ['EARPIECE', 'SPEAKER_PHONE'],
  );
  const effective = resolveEffectiveCycleRoute(current, order);
  const idx = order.indexOf(effective);
  if (idx < 0 || order.length === 0) {
    return order[0] || 'SPEAKER_PHONE';
  }
  return order[(idx + 1) % order.length];
}

export function nextRouteInCycle(current: InCallAudioRoute, available: string[]): InCallAudioRoute {
  return nextRouteInCycleForContext(current, available, 'audio_ui', []);
}

export function mapRouteForEnterVideoUi(route: InCallAudioRoute): InCallAudioRoute {
  if (route === 'EARPIECE') return 'SPEAKER_PHONE';
  if (route === 'BLUETOOTH' || route === 'WIRED_HEADSET') return route;
  return 'SPEAKER_PHONE';
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
