/**
 * Единственный владелец аудиосессии звонка (InCallManager start / stop).
 *
 * Раньше start/stop звали ~12 мест — экраны, эффект keep-awake App, AppState, модалка входящего,
 * хук маршрута, — и каждое само решало «звонка уже нет» по своему набору флагов. В окнах
 * переходов (видео → in-app PiP, system PiP, навигация) эти флаги на миг врут, и stop()
 * посреди звонка выключал громкую, забывал выбранный маршрут и отдавал аудиофокус.
 *
 * Правила:
 * - open — когда у звонка появляется медиа; повторный open открытой сессии ничего не делает;
 * - reassert — повторный start для переприменения маршрута; закрытую сессию НЕ открывает
 *   (поздний реаплай после конца звонка возвращал MODE_IN_COMMUNICATION без звонка);
 * - close — только при завершении звонка; чужую сессию не закрывает (рандом ≠ звонок другу).
 */
import { NativeModules, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { isInCallAudioSessionStarted, setInCallAudioSessionStarted } from './callRuntime';
import { logger } from './logger';

export type CallAudioOwner = 'direct' | 'random';
type CallAudioMedia = 'audio' | 'video';

let owner: CallAudioOwner | null = null;
const closeListeners = new Set<() => void>();

export function isCallAudioSessionOpen(): boolean {
  return isInCallAudioSessionStarted();
}

export function getCallAudioSessionOwner(): CallAudioOwner | null {
  return isInCallAudioSessionStarted() ? owner : null;
}

/** Открыть сессию звонка. true — открыта сейчас; false — уже была открыта. */
export function openCallAudioSession(nextOwner: CallAudioOwner, media: CallAudioMedia, reason: string): boolean {
  if (isInCallAudioSessionStarted()) {
    if (!owner) owner = nextOwner;
    return false;
  }
  try {
    InCallManager.start({ media, ringback: '' });
  } catch (e) {
    logger.warn('[callAudio] start failed', { owner: nextOwner, media, reason, error: String(e) });
    return false;
  }
  owner = nextOwner;
  setInCallAudioSessionStarted(true);
  logger.info('[callAudio] open', { owner: nextOwner, media, reason });
  return true;
}

/** Повторный start открытой сессии (media по умолчанию / реаплай маршрута). */
export function reassertCallAudioSession(media: CallAudioMedia, reason: string): boolean {
  if (!isInCallAudioSessionStarted()) {
    logger.info('[callAudio] reassert skipped: no open session', { media, reason });
    return false;
  }
  try {
    InCallManager.start({ media, ringback: '' });
    (InCallManager as any).requestAudioFocus?.();
  } catch {}
  return true;
}

/** Закрыть сессию при завершении звонка. false — закрывать нечего или сессия чужая. */
export function closeCallAudioSession(closingOwner: CallAudioOwner, reason: string): boolean {
  if (!isInCallAudioSessionStarted()) return false;
  if (owner && owner !== closingOwner) {
    logger.info('[callAudio] close refused: session belongs to another call', { owner, closingOwner, reason });
    return false;
  }
  try { (InCallManager as any).setForceSpeakerphoneOn?.('auto'); } catch {}
  try { InCallManager.setSpeakerphoneOn(false); } catch {}
  try { InCallManager.stopProximitySensor(); } catch {}
  try { InCallManager.stop(); } catch {}
  try { (InCallManager as any).abandonAudioFocus?.(); } catch {}
  // Режим связи снимает натив (через 1.5 / 5 с, если не идёт новый звонок): InCallManager может
  // «восстановить» MODE_IN_COMMUNICATION, если маршрут выставил его раньше старта сессии.
  if (Platform.OS === 'android') {
    try { NativeModules.LiviAppModule?.scheduleCallAudioRelease?.(); } catch {}
  }
  setInCallAudioSessionStarted(false);
  const closedOwner = owner;
  owner = null;
  logger.info('[callAudio] close', { owner: closedOwner, reason, platform: Platform.OS });
  for (const listener of [...closeListeners]) {
    try {
      listener();
    } catch {}
  }
  return true;
}

/** Сброс состояния, привязанного к одному звонку (выбранный маршрут и т. п.), при закрытии сессии. */
export function addCallAudioSessionCloseListener(listener: () => void): () => void {
  closeListeners.add(listener);
  return () => {
    closeListeners.delete(listener);
  };
}
