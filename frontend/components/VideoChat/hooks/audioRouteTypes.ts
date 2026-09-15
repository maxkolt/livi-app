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
 * Порядок для UI/иконок и цикла кнопки.
 * audio_ui / video_ui / in_app_pip: при BT — Bluetooth → ухо → громкая;
 * без BT — ухо ↔ громкая (на video раньше SPEAKER-only → залипание SPEAKER→SPEAKER).
 * system_pip: BT (если есть) + громкая, без уха.
 */
export function nextSpeakerToggleRoute(current: InCallAudioRoute): InCallAudioRoute {
  if (current === 'SPEAKER_PHONE') return 'EARPIECE';
  return 'SPEAKER_PHONE';
}

export function routeOrderForContext(
  context: CallAudioRouteCycleContext,
  available: string[],
): InCallAudioRoute[] {
  const hasBt = available.includes('BLUETOOTH');
  const hasWired = available.includes('WIRED_HEADSET');

  // System PiP: ухо не предлагаем (product pin на громкую).
  if (context === 'system_pip') {
    const order: InCallAudioRoute[] = [];
    if (hasBt) order.push('BLUETOOTH');
    order.push('SPEAKER_PHONE');
    if (hasWired && !hasBt) order.push('WIRED_HEADSET');
    if (order.length === 0) return ['SPEAKER_PHONE'];
    return order;
  }

  // audio_ui / video_ui / in_app_pip — полный цикл с ухом.
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
  // system PiP: только громкая (как product pin).
  if (context === 'system_pip') {
    return ['SPEAKER_PHONE'];
  }
  return routeOrderForContext(context, available);
}

/** Список маршрутов для кнопки. */
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
  available: string[],
  context: CallAudioRouteCycleContext,
  _icmDeviceList: string[] = [],
): InCallAudioRoute {
  if (context === 'system_pip') {
    // System PiP: ухо не даём; BT снимаем тапом в громкую.
    if (isExternalHeadsetRoute(current)) return 'SPEAKER_PHONE';
    return 'SPEAKER_PHONE';
  }
  const order = routeOrderForContext(context, available);
  if (order.length === 0) return nextSpeakerToggleRoute(current);
  const idx = order.indexOf(current);
  if (idx < 0) {
    // Текущий маршрут пропал из available (например BT) — следующий = первый в порядке.
    return order[0];
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
