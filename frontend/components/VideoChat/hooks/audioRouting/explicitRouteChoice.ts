/**
 * Что пользователь выбрал сам, а что выбрала автоматика.
 *
 * Главный вопрос всего аудио-роутинга: можно ли перебить текущий маршрут. Если
 * пользователь сам ткнул «ухо» или «громкая», подключившийся Bluetooth не должен
 * молча увести звук — иначе человек подносит телефон к уху, а говорит в комнату.
 * Но отличить «сам выбрал» от «так получилось» нельзя по одному флагу: намерение
 * приходит то из cycle-кнопки, то из lock'а, то из перехода видео→аудио, и у каждого
 * источника свои оговорки.
 *
 * Вынесено из useAudioRouting.ts: хуков здесь нет, только чтение сохранённого выбора.
 */

import type { InCallAudioRoute } from '../audioRouteTypes';
import {
  readUserLockedBuiltinCallAudioRoute,
  readUserSelectedCallAudioRoute,
} from '../../../../utils/activeCallSession';
import { readExplicitVideoCallBuiltInRoute } from '../../../../utils/callAudioRoutePersist';

/** Явный выбор разговорного/громкого — не подменять Bluetooth вне PiP-перехода. */
export function readExplicitBuiltInFromGlobal(): boolean {
  try {
    return !!(global as any).__explicitBuiltInCallAudioRouteRef?.current;
  } catch {
    return false;
  }
}

export function setExplicitBuiltInGlobal(explicit: boolean): void {
  try {
    const g = global as any;
    g.__explicitBuiltInCallAudioRouteRef =
      g.__explicitBuiltInCallAudioRouteRef || { current: false };
    g.__explicitBuiltInCallAudioRouteRef.current = explicit;
  } catch {}
}

export function readUserSelectedBuiltInRoute(): InCallAudioRoute | null {
  const userSel = readUserSelectedCallAudioRoute();
  if (userSel === 'SPEAKER_PHONE' || userSel === 'EARPIECE') return userSel;
  return null;
}

export function readExplicitUserSelectedBuiltInRoute(): InCallAudioRoute | null {
  const locked = readUserLockedBuiltinCallAudioRoute();
  if (locked) return locked;
  const userSel = readUserSelectedBuiltInRoute();
  if (!userSel) return null;
  if (readExplicitBuiltInFromGlobal()) return userSel;
  return null;
}

export function hasExplicitBuiltInIntent(route?: InCallAudioRoute | null): boolean {
  const explicit = readExplicitUserSelectedBuiltInRoute();
  if (explicit) return !route || explicit === route;
  return readExplicitBuiltInFromGlobal();
}

/** Ухо/громкая через cycle или lock — не подменять кнопку на BT, пока пользователь сам не сменит режим. */
export function userLockedBuiltinAudioOutput(): boolean {
  return !!readUserLockedBuiltinCallAudioRoute();
}

export function isManualRouteReason(reason: string): boolean {
  return (
    reason.startsWith('cycle') ||
    reason.startsWith('toggle') ||
    reason === 'in_app_pip_audio_route_toggle'
  );
}

export function readUserSelectedExternalRoute(): InCallAudioRoute | null {
  const userSel = readUserSelectedCallAudioRoute();
  if (userSel === 'BLUETOOTH' || userSel === 'WIRED_HEADSET') return userSel;
  return null;
}

export function isExplicitBuiltInRouteChoice(reason: string, route: InCallAudioRoute): boolean {
  if (route !== 'EARPIECE' && route !== 'SPEAKER_PHONE') return false;
  if (
    route === 'SPEAKER_PHONE' &&
    readExplicitVideoCallBuiltInRoute() === 'SPEAKER_PHONE'
  ) {
    return true;
  }
  const lockedBuiltin = readExplicitUserSelectedBuiltInRoute();
  if (lockedBuiltin === route) {
    return true;
  }
  if (isManualRouteReason(reason)) {
    return true;
  }
  if (reason === 'return_to_audio_ui' && readUserSelectedCallAudioRoute() === route) {
    return true;
  }
  if (
    reason === 'direct_call_accept_audio_route' ||
    reason === 'handleCallAnswered_audio_first' ||
    reason === 'applyRouting_deferred_earpiece'
  ) {
    if (route === 'EARPIECE') return true;
    if (!readUserLockedBuiltinCallAudioRoute()) return false;
    return route === 'SPEAKER_PHONE';
  }
  if (
    reason === 'applyRouting_locked_bootstrap' ||
    reason.endsWith('_native_repin')
  ) {
    return route === 'EARPIECE' || route === 'SPEAKER_PHONE';
  }
  if (readExplicitBuiltInFromGlobal()) {
    const userSel = readUserSelectedBuiltInRoute();
    if (userSel === route) {
      return true;
    }
    return reason === 'preferAudioMode' || reason === 'return_to_audio_ui';
  }
  const userSel = readUserSelectedCallAudioRoute();
  if (userSel === route && reason.startsWith('cycle')) {
    return true;
  }
  return false;
}
