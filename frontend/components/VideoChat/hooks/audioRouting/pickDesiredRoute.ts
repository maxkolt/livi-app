/**
 * Какой маршрут звука должен быть прямо сейчас.
 *
 * Это единственное место, где сходятся все источники: что физически подключено, что
 * выбрал пользователь, что было до подключения гарнитуры, в каком режиме экран и
 * почему нас вообще позвали. Порядок проверок здесь — не стиль, а приоритет: именно
 * он решает, победит ли только что надетая гарнитура ранее нажатую кнопку «ухо».
 *
 * Вынесено из useAudioRouting.ts дословно. Ref-ы передаются целиком, а не снимками:
 * функция читает их и после собственных побочных эффектов, и снимок сломал бы
 * последовательность.
 */

import type { MutableRefObject } from 'react';
import type { InCallAudioRoute } from '../audioRouteTypes';
import { isExternalHeadsetRoute, normalizeInCallRoute } from '../audioRouteTypes';
import type { AudioRoutingOptions } from '../useAudioRouting';
import {
  isBluetoothAvailableForAutoRoute,
  readNativeProbedExternalRoute,
} from '../../../../utils/nativeCallAudioProbe';
import {
  isDirectAudioEarpieceStabilizeWindow,
  readActiveExternalCallAudioRoute,
  readConnectedExternalCallAudioRoute,
  userExplicitlyPinnedBuiltinCallAudio,
} from '../../../../utils/activeCallSession';
import { getPersistedCallAudioRoute } from '../../../../utils/callAudioRoutePersist';
import {
  isCallAudioPiPTransitionWindow,
  readCallAudioRouteUiLock,
} from '../../../../utils/callAudioRouteTransitionGuards';
import {
  rememberBuiltinCallRouteBeforeHeadset,
  resolveCallRouteAfterHeadsetDisconnect,
} from '../../../../utils/callHeadsetAudioFallback';
import {
  isExplicitBuiltInRouteChoice,
  isManualRouteReason,
  readExplicitUserSelectedBuiltInRoute,
  readUserSelectedExternalRoute,
  userLockedBuiltinAudioOutput,
} from './explicitRouteChoice';
import {
  defaultUserRoute,
  isHeadsetUnplugReason,
  isPhysicalHeadsetGainReason,
  shouldPreferBluetoothEarlyInCall,
} from './routeReasons';

/**
 * Всё, что функции нужно от хука. Ref-ы — именно ref-ы, потому что читаются лениво.
 */
export type PickDesiredRouteContext = {
  routingOptionsRef: MutableRefObject<AudioRoutingOptions | undefined>;
  deviceChangeContextRef: MutableRefObject<{ gainedWired: boolean; gainedBt: boolean }>;
  explicitBuiltInChoiceRef: MutableRefObject<boolean>;
  lastAppliedRouteRef: MutableRefObject<InCallAudioRoute | ''>;
  getUserRoute: () => InCallAudioRoute;
  setUserRoute: (route: InCallAudioRoute, writeOpts?: { persist?: boolean }) => void;
  readStickyExternalRouteForAutoRepin: (available: string[], reason: string) => InCallAudioRoute | null;
  reconcileRouteAfterHeadsetDisconnect: (available: string[]) => InCallAudioRoute | null;
};

export function pickDesiredRoute(
  available: string[],
  reason: string,
  ctx: PickDesiredRouteContext,
): InCallAudioRoute {
  const earpieceMode = !!ctx.routingOptionsRef.current?.defaultToEarpiece;
  const { gainedWired, gainedBt } = ctx.deviceChangeContextRef.current;
  const headsetGain = isPhysicalHeadsetGainReason(reason, { gainedBt, gainedWired });

  if (headsetGain && available.includes('BLUETOOTH') && (gainedBt || reason === 'headset_poll_bt')) {
    rememberBuiltinCallRouteBeforeHeadset(ctx.getUserRoute(), earpieceMode);
    return 'BLUETOOTH';
  }
  if (
    headsetGain &&
    available.includes('WIRED_HEADSET') &&
    (gainedWired || reason === 'WiredHeadset')
  ) {
    rememberBuiltinCallRouteBeforeHeadset(ctx.getUserRoute(), earpieceMode);
    return 'WIRED_HEADSET';
  }

  const uiLock = readCallAudioRouteUiLock();
  if (uiLock) {
    return uiLock;
  }
  if (isHeadsetUnplugReason(reason)) {
    const afterDisconnect = ctx.reconcileRouteAfterHeadsetDisconnect(available);
    if (afterDisconnect) {
      return afterDisconnect;
    }
    const lostAllHeadsets =
      !available.includes('BLUETOOTH') && !available.includes('WIRED_HEADSET');
    if (lostAllHeadsets) {
      const fallback = resolveCallRouteAfterHeadsetDisconnect();
      ctx.setUserRoute(fallback);
      return fallback;
    }
  }
  const stickyExt = ctx.readStickyExternalRouteForAutoRepin(available, reason);
  if (stickyExt) {
    return stickyExt;
  }
  const userSelExt = readUserSelectedExternalRoute();
  if (userSelExt && (!available.length || available.includes(userSelExt))) {
    return userSelExt;
  }
  const userSelBuiltin = readExplicitUserSelectedBuiltInRoute();
  if (userSelBuiltin) {
    return userSelBuiltin;
  }
  const userNow = ctx.getUserRoute();
  if (ctx.explicitBuiltInChoiceRef.current && (userNow === 'SPEAKER_PHONE' || userNow === 'EARPIECE')) {
    return userNow;
  }
  if (isExternalHeadsetRoute(userNow) && available.includes(userNow)) {
    return userNow;
  }
  if (
    isBluetoothAvailableForAutoRoute() &&
    shouldPreferBluetoothEarlyInCall(reason) &&
    !isExplicitBuiltInRouteChoice(reason, userNow)
  ) {
    return 'BLUETOOTH';
  }
  const extPersisted = readActiveExternalCallAudioRoute(userNow);
  if (extPersisted) {
    const keepHeadset =
      reason === 'manualSync' ||
      reason === 'applyRouting' ||
      reason === 'applyRouting_repin' ||
      reason === 'remote_stream' ||
      reason === 'remote_stream_repin' ||
      reason === 'remote_stream+1200ms' ||
      reason === 'bootstrap' ||
      reason === 'refresh' ||
      reason === 'session_re_enable' ||
      reason.startsWith('stopSpeaker') ||
      reason.startsWith('manualSync') ||
      isCallAudioPiPTransitionWindow();
    if (keepHeadset && (available.includes(extPersisted) || isExternalHeadsetRoute(extPersisted))) {
      return extPersisted;
    }
  }

  if (isDirectAudioEarpieceStabilizeWindow() && !readExplicitUserSelectedBuiltInRoute() && !ctx.explicitBuiltInChoiceRef.current) {
    const userIntentStabilize =
      reason.startsWith('cycle') ||
      reason.startsWith('toggle') ||
      reason === 'in_app_pip_audio_route_toggle';
    if (!userIntentStabilize) {
      const connected = readConnectedExternalCallAudioRoute(ctx.getUserRoute());
      if (isExternalHeadsetRoute(connected) && (!available.length || available.includes(connected))) {
        return connected;
      }
      const nativeExt = readNativeProbedExternalRoute();
      if (isExternalHeadsetRoute(nativeExt) && (!available.length || available.includes(nativeExt))) {
        return nativeExt;
      }
      const lockedExt = readUserSelectedExternalRoute();
      if (lockedExt && (!available.length || available.includes(lockedExt))) {
        return lockedExt;
      }
      if (isExternalHeadsetRoute(userNow) && available.includes(userNow)) {
        return userNow;
      }
      if (!userLockedBuiltinAudioOutput()) {
        if (available.includes('BLUETOOTH')) return 'BLUETOOTH';
        if (available.includes('WIRED_HEADSET')) return 'WIRED_HEADSET';
      }
      return 'EARPIECE';
    }
  }

  if (earpieceMode) {
    if (isHeadsetUnplugReason(reason)) {
      const nativeExt = readNativeProbedExternalRoute();
      if (nativeExt === 'BLUETOOTH' || nativeExt === 'WIRED_HEADSET') {
        return nativeExt;
      }
      if (available.includes('WIRED_HEADSET')) {
        return 'WIRED_HEADSET';
      }
      if (available.includes('BLUETOOTH')) {
        return 'BLUETOOTH';
      }
      const fallback = resolveCallRouteAfterHeadsetDisconnect();
      ctx.setUserRoute(fallback);
      return fallback;
    }

    const afterDisconnect = ctx.reconcileRouteAfterHeadsetDisconnect(available);
    if (afterDisconnect) {
      return afterDisconnect;
    }

    if (available.includes('WIRED_HEADSET')) {
      if (
        reason === 'WiredHeadset' ||
        reason === 'headset_poll' ||
        gainedWired ||
        (reason === 'onAudioDeviceChanged' && gainedWired) ||
        reason === 'remote_stream_repin'
      ) {
        rememberBuiltinCallRouteBeforeHeadset(ctx.getUserRoute(), true);
        return 'WIRED_HEADSET';
      }
    }
    if (
      available.includes('BLUETOOTH') &&
      (gainedBt || reason === 'headset_poll_bt')
    ) {
      rememberBuiltinCallRouteBeforeHeadset(ctx.getUserRoute(), true);
      return 'BLUETOOTH';
    }

    if (
      available.includes('BLUETOOTH') &&
      !ctx.explicitBuiltInChoiceRef.current &&
      !userExplicitlyPinnedBuiltinCallAudio() &&
      (reason === 'manualSync' ||
        reason === 'remote_stream' ||
        reason === 'remote_stream_repin' ||
        reason === 'remote_stream+1200ms' ||
        reason === 'preferAudioMode' ||
        reason === 'bootstrap' ||
        reason.startsWith('poll_') ||
        reason === 'native_probe' ||
        reason === 'native_probe_bootstrap' ||
        gainedBt)
    ) {
      rememberBuiltinCallRouteBeforeHeadset(ctx.getUserRoute(), true);
      return 'BLUETOOTH';
    }

    const autoReapplyReason =
      reason === 'manualSync' ||
      reason === 'preferAudioMode' ||
      reason === 'applyRouting' ||
      reason === 'applyRouting_repin' ||
      reason === 'remote_stream' ||
      reason === 'remote_stream_repin' ||
      reason === 'remote_stream+1200ms' ||
      reason === 'session_re_enable' ||
      reason === 'bootstrap' ||
      reason === 'bootstrap_done' ||
      reason.startsWith('poll_');

    if (autoReapplyReason || isManualRouteReason(reason)) {
      const user = ctx.getUserRoute();
      const last = normalizeInCallRoute(ctx.lastAppliedRouteRef.current);
      if (
        isExternalHeadsetRoute(last) &&
        available.includes(last) &&
        (user === 'EARPIECE' || user === 'SPEAKER_PHONE') &&
        !ctx.explicitBuiltInChoiceRef.current &&
        !readExplicitUserSelectedBuiltInRoute()
      ) {
        return last;
      }
      if (available.includes(user) && isExternalHeadsetRoute(user)) {
        return user;
      }
      if (user === 'SPEAKER_PHONE' || user === 'EARPIECE') {
        return userLockedBuiltinAudioOutput() || isManualRouteReason(reason)
          ? user
          : defaultUserRoute(ctx.routingOptionsRef.current);
      }
    }

    const stable = ctx.lastAppliedRouteRef.current;
    if (stable && (stable === 'EARPIECE' || stable === 'SPEAKER_PHONE' || available.includes(stable))) {
      return stable as InCallAudioRoute;
    }
    return 'EARPIECE';
  }

  if (isHeadsetUnplugReason(reason)) {
    if (available.includes('WIRED_HEADSET')) {
      return 'WIRED_HEADSET';
    }
    const fallback = resolveCallRouteAfterHeadsetDisconnect();
    ctx.setUserRoute(fallback);
    return fallback;
  }

  const user = ctx.getUserRoute();
  if (user === 'BLUETOOTH' && available.includes('BLUETOOTH')) {
    return 'BLUETOOTH';
  }
  if (user === 'WIRED_HEADSET' && available.includes('WIRED_HEADSET')) {
    return 'WIRED_HEADSET';
  }
  if (
    (user === 'SPEAKER_PHONE' || user === 'EARPIECE') &&
    userLockedBuiltinAudioOutput()
  ) {
    return user;
  }

  if (gainedBt && available.includes('BLUETOOTH')) {
    rememberBuiltinCallRouteBeforeHeadset(ctx.getUserRoute(), false);
    return 'BLUETOOTH';
  }
  if (gainedWired && available.includes('WIRED_HEADSET')) {
    rememberBuiltinCallRouteBeforeHeadset(ctx.getUserRoute(), false);
    return 'WIRED_HEADSET';
  }

  const autoReapplyReason =
    reason === 'manualSync' ||
    reason === 'preferAudioMode' ||
    reason === 'applyRouting' ||
    reason === 'applyRouting_repin' ||
    reason === 'remote_stream' ||
    reason === 'remote_stream_repin' ||
    reason === 'session_re_enable';

  if (autoReapplyReason || isManualRouteReason(reason)) {
    if (available.includes(user) && isExternalHeadsetRoute(user)) {
      return user;
    }
    if (
      (user === 'SPEAKER_PHONE' || user === 'EARPIECE') &&
      (userLockedBuiltinAudioOutput() || isManualRouteReason(reason))
    ) {
      return user;
    }
    if (
      (user === 'SPEAKER_PHONE' || user === 'EARPIECE') &&
      !userLockedBuiltinAudioOutput() &&
      !isManualRouteReason(reason)
    ) {
      return defaultUserRoute(ctx.routingOptionsRef.current);
    }
  }

  if (reason === 'applyRouting' || reason === 'bootstrap' || reason === 'refresh') {
    const persisted = getPersistedCallAudioRoute();
    if (persisted === 'BLUETOOTH' && available.includes('BLUETOOTH')) {
      rememberBuiltinCallRouteBeforeHeadset(null, false);
      return 'BLUETOOTH';
    }
    if (persisted === 'WIRED_HEADSET' && available.includes('WIRED_HEADSET')) {
      rememberBuiltinCallRouteBeforeHeadset(null, false);
      return 'WIRED_HEADSET';
    }
    if (persisted === 'EARPIECE' || persisted === 'SPEAKER_PHONE') {
      return persisted;
    }
  }

  return 'SPEAKER_PHONE';
}
