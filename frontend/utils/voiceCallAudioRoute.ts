import { NativeModules, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { isExternalHeadsetRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { logger } from './logger';
import {
  isOngoingCallSession,
  readActiveExternalCallAudioRoute,
  readConnectedExternalCallAudioRoute,
  readUserSelectedCallAudioRoute,
  readUserSelectedExternalCallAudioRoute,
} from './activeCallSession';
import { readCallBuiltinRouteChoice, rememberCallBuiltinRouteChoice } from './callHeadsetAudioFallback';
import { readNativeProbedExternalRoute } from './nativeCallAudioProbe';

type LiviAudioMod = {
  setVoiceCallSpeakerOn?: (on: boolean) => Promise<boolean>;
  setVoiceCallAudioRoute?: (route: string) => Promise<boolean>;
};

function liviAudioModule(): LiviAudioMod | undefined {
  return NativeModules.LiviAppModule as LiviAudioMod | undefined;
}

/** Accept/wear: не рвать SCO ухом/громкой, пока поднимается BT. */
function shouldHoldBluetoothScoAgainstBuiltIn(): boolean {
  try {
    // Ручной EAR/SPEAKER всегда сильнее sticky/expect — иначе cycle «на разговорный» остаётся в наушниках.
    const userSel = readUserSelectedCallAudioRoute();
    if (userSel === 'EARPIECE' || userSel === 'SPEAKER_PHONE') return false;
    if (Date.now() < Number((global as any).__btWearStickyUntilRef?.current || 0)) return true;
    if (Date.now() < Number((global as any).__btExpectReconnectUntilRef?.current || 0)) return true;
    if (readUserSelectedExternalCallAudioRoute() === 'BLUETOOTH') return true;
    return userSel === 'BLUETOOTH';
  } catch {
    return false;
  }
}

/**
 * ICM для built-in EAR/SPEAKER.
 * Android: одного setForceSpeakerphoneOn достаточно —
 *   chooseAudioRoute('EARPIECE'|'SPEAKER_PHONE') гоняет тот же selectAudioDevice(),
 *   то есть второй updateAudioDeviceState на UI-потоке впустую, а setSpeakerphoneOn
 *   на API 31+ дёргает clearCommunicationDevice с native-потока и сбивает только что
 *   выставленный setCommunicationDevice — лишнее переключение устройства.
 * iOS: override порта делает именно setSpeakerphoneOn, его оставляем.
 */
export function applyInCallManagerBuiltInRoute(wantSpeaker: boolean): void {
  try {
    (InCallManager as any).setForceSpeakerphoneOn?.(wantSpeaker);
    if (Platform.OS !== 'android') {
      InCallManager.setSpeakerphoneOn(wantSpeaker);
    }
  } catch {}
}

/**
 * Режим звонка выбирается один раз: стартовый маршрут или тап. Пока пользователь не выбрал,
 * первый реально применённый built-in звонка (ухо у аудиозвонка, громкая у видео) и есть выбор.
 * Без этого переходы PiP/разворот брали «громкую по умолчанию для видео» и уводили ухо в динамик.
 * Выбор сбрасывается на каждый новый callId (markActiveCallAudioRouteCallId).
 */
function rememberFirstCallBuiltinRoute(route: InCallAudioRoute): void {
  try {
    if (route !== 'EARPIECE' && route !== 'SPEAKER_PHONE') return;
    if (readCallBuiltinRouteChoice()) return;
    if (!isOngoingCallSession()) return;
    rememberCallBuiltinRouteChoice(route);
  } catch {}
}

/** Android: BT / wired / earpiece / speaker через AudioManager.setCommunicationDevice. */
export async function applyNativeVoiceCallRoute(route: InCallAudioRoute): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    // Accept: чужой EAR/SPEAKER force убивает только что поднятый SCO → звук «не сразу».
    if (
      (route === 'EARPIECE' || route === 'SPEAKER_PHONE') &&
      shouldHoldBluetoothScoAgainstBuiltIn()
    ) {
      const mod = liviAudioModule();
      if (typeof mod?.setVoiceCallAudioRoute === 'function') {
        const ok = await mod.setVoiceCallAudioRoute('BLUETOOTH');
        logger.info('[voiceCallAudioRoute] native route redirected to BT (wear/accept hold)', {
          attempted: route,
          ok,
        });
        return !!ok;
      }
    }
    const mod = liviAudioModule();
    if (typeof mod?.setVoiceCallAudioRoute !== 'function') return false;
    const ok = await mod.setVoiceCallAudioRoute(route);
    logger.info('[voiceCallAudioRoute] native route', { route, ok });
    if (ok) rememberFirstCallBuiltinRoute(route);
    return !!ok;
  } catch (e) {
    logger.warn('[voiceCallAudioRoute] native route failed', { route, error: String(e) });
    return false;
  }
}

/** Android: earpiece / speaker через AudioManager (API 31+ setCommunicationDevice). */
export async function applyNativeVoiceCallSpeaker(
  speakerOn: boolean,
  opts?: { forceBuiltIn?: boolean },
): Promise<void> {
  if (Platform.OS !== 'android') return;
  const forceBuiltIn = !!opts?.forceBuiltIn;
  if (!forceBuiltIn) {
    const external =
      readActiveExternalCallAudioRoute() ||
      readConnectedExternalCallAudioRoute() ||
      readNativeProbedExternalRoute();
    if (isExternalHeadsetRoute(external)) {
      await applyNativeVoiceCallRoute(external);
      return;
    }
    // Не уводить в BT только из-за paired-in-case в available — нужен call-audio / user BT.
  } else {
    // forceBuiltIn: не снимать SCO во время BT accept/wear.
    if (shouldHoldBluetoothScoAgainstBuiltIn()) {
      await applyNativeVoiceCallRoute('BLUETOOTH');
      return;
    }
    await applyNativeVoiceCallRoute(speakerOn ? 'SPEAKER_PHONE' : 'EARPIECE');
    return;
  }
  try {
    const mod = liviAudioModule();
    if (typeof mod?.setVoiceCallSpeakerOn !== 'function') {
      await applyNativeVoiceCallRoute(speakerOn ? 'SPEAKER_PHONE' : 'EARPIECE');
      return;
    }
    const ok = await mod.setVoiceCallSpeakerOn(speakerOn);
    logger.info('[voiceCallAudioRoute] native', { speakerOn, ok });
  } catch (e) {
    logger.warn('[voiceCallAudioRoute] native failed', { speakerOn, error: String(e) });
  }
}
