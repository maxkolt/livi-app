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

/** Где показывается кнопка маршрута. */
export type CallAudioRouteCycleContext = 'audio_ui' | 'in_app_pip' | 'video_ui' | 'system_pip';

/**
 * WA-like пункт 3: кнопка только earpiece ↔ speaker.
 * BT/провод подключает OS (plug events), не крутим их в цикле кнопки.
 */
export function nextSpeakerToggleRoute(current: InCallAudioRoute): InCallAudioRoute {
  if (current === 'SPEAKER_PHONE') return 'EARPIECE';
  return 'SPEAKER_PHONE';
}

/** Порядок для UI/иконок (BT может быть «доступен»), не для цикла кнопки. */
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
  _available: string[],
): InCallAudioRoute[] {
  // system PiP: только громкая (как product pin). video UI «Ещё»: ухо ↔ громкая.
  if (context === 'system_pip') {
    return ['SPEAKER_PHONE'];
  }
  return ['EARPIECE', 'SPEAKER_PHONE'];
}

/** Список маршрутов для кнопки (только built-in). */
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

export function nextRouteInCycleForContext(
  current: InCallAudioRoute,
  _available: string[],
  context: CallAudioRouteCycleContext,
  _icmDeviceList: string[] = [],
): InCallAudioRoute {
  if (context === 'system_pip') {
    // System PiP: ухо не даём; BT снимаем тапом в громкую.
    if (isExternalHeadsetRoute(current)) return 'SPEAKER_PHONE';
    return 'SPEAKER_PHONE';
  }
  // Аудио / video UI «Ещё» / in-app PiP: speaker on/off; с BT/провода — в громкую.
  if (isExternalHeadsetRoute(current)) return 'SPEAKER_PHONE';
  return nextSpeakerToggleRoute(current);
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
