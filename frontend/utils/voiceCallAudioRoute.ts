import { NativeModules, Platform } from 'react-native';
import { logger } from './logger';

/** Android: earpiece / speaker через AudioManager (API 31+ setCommunicationDevice). */
export async function applyNativeVoiceCallSpeaker(speakerOn: boolean): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const mod = NativeModules.LiviAppModule as { setVoiceCallSpeakerOn?: (on: boolean) => Promise<boolean> };
    if (typeof mod?.setVoiceCallSpeakerOn !== 'function') return;
    const ok = await mod.setVoiceCallSpeakerOn(speakerOn);
    logger.info('[voiceCallAudioRoute] native', { speakerOn, ok });
  } catch (e) {
    logger.warn('[voiceCallAudioRoute] native failed', { speakerOn, error: String(e) });
  }
}
