import { NativeModules, Platform } from 'react-native';
import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { isExternalHeadsetRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { logger } from './logger';
import { readActiveExternalCallAudioRoute, readConnectedExternalCallAudioRoute } from './activeCallSession';
import { readNativeProbedExternalRoute } from './nativeCallAudioProbe';

type LiviAudioMod = {
  setVoiceCallSpeakerOn?: (on: boolean) => Promise<boolean>;
  setVoiceCallAudioRoute?: (route: string) => Promise<boolean>;
};

function liviAudioModule(): LiviAudioMod | undefined {
  return NativeModules.LiviAppModule as LiviAudioMod | undefined;
}

/** Android: BT / wired / earpiece / speaker через AudioManager.setCommunicationDevice. */
export async function applyNativeVoiceCallRoute(route: InCallAudioRoute): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    const mod = liviAudioModule();
    if (typeof mod?.setVoiceCallAudioRoute !== 'function') return false;
    const ok = await mod.setVoiceCallAudioRoute(route);
    logger.info('[voiceCallAudioRoute] native route', { route, ok });
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
    if (!speakerOn) {
      try {
        const av = (global as any).__inCallAvailableAudioRoutesRef?.current;
        if (Array.isArray(av) && av.includes('BLUETOOTH')) {
          await applyNativeVoiceCallRoute('BLUETOOTH');
          return;
        }
      } catch {}
    }
  } else {
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
