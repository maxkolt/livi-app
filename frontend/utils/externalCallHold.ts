import { AppState, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { isOngoingCallSession } from './activeCallSession';
import { logger } from './logger';

/** Android AudioManager: постоянная потеря focus. */
const ANDROID_AUDIOFOCUS_LOSS = -1;
/** MODE_RINGTONE / MODE_IN_CALL — GSM или системный звонок без READ_PHONE_STATE. */
const ANDROID_MODE_RINGTONE = 1;
const ANDROID_MODE_IN_CALL = 2;

let installed = false;
let holdActive = false;

export function isExternalCallHoldActive(): boolean {
  return holdActive;
}

export function setExternalCallHoldActive(active: boolean): void {
  holdActive = active;
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.setExternalCallAudioHoldActive?.(active);
  } catch {}
}

type HoldSession = {
  enterExternalCallHold?: () => Promise<void>;
  exitExternalCallHold?: () => Promise<void>;
  getLocalExternalHoldActive?: () => boolean;
  isEnded?: () => boolean;
  getLiveKitRoomState?: () => string | undefined;
  getRemoteStream?: () => unknown;
  applyRemoteExternalHoldState?: (hold: boolean, roomId?: string | null) => void;
};

type NativeHoldHint = {
  focusChange?: number;
  telephonyLikely?: boolean;
  audioMode?: number;
};

function currentSession(): HoldSession | null {
  try {
    return (global as any).__webrtcSessionRef?.current ?? null;
  } catch {
    return null;
  }
}

function isTelephonyAudioMode(audioMode?: number, telephonyLikely?: boolean): boolean {
  if (telephonyLikely === true) return true;
  if (audioMode === ANDROID_MODE_IN_CALL) return true;
  // RINGTONE без telephonyLikely из native — не считаем GSM (см. MainActivity foreground guard).
  return false;
}

/** Hold только когда медиа реально установлено, не на этапе accept/connect. */
function isDirectCallMediaEstablished(session: HoldSession): boolean {
  if (typeof session.isEnded === 'function' && session.isEnded()) return false;
  const roomState = session.getLiveKitRoomState?.();
  if (roomState && roomState !== 'connected') return false;
  const remote = session.getRemoteStream?.();
  if (!remote) return false;
  return true;
}

function tryEnterExternalHold(reason: string, hint: NativeHoldHint): void {
  if (!isOngoingCallSession()) return;
  if (holdActive) return;

  const session = currentSession();
  if (!session || typeof session.enterExternalCallHold !== 'function') return;
  if (!isDirectCallMediaEstablished(session)) {
    logger.debug('[externalCallHold] ignore — call media not established yet', { reason });
    return;
  }

  const telephony = isTelephonyAudioMode(hint.audioMode, hint.telephonyLikely);
  const inBackground =
    AppState.currentState === 'background' || AppState.currentState === 'inactive';

  if (inBackground && !telephony) {
    logger.debug('[externalCallHold] ignore — background without telephony hint', { reason });
    return;
  }

  logger.info('[externalCallHold] entering hold', {
    reason,
    telephony,
    audioMode: hint.audioMode,
    appState: AppState.currentState,
  });
  void session.enterExternalCallHold().catch((e) => {
    logger.warn('[externalCallHold] enterExternalCallHold failed', e);
  });
}

function onInterrupted(payload?: NativeHoldHint): void {
  const focusChange = payload?.focusChange;
  if (focusChange != null && focusChange !== ANDROID_AUDIOFOCUS_LOSS) {
    logger.debug('[externalCallHold] ignore non-permanent focus loss', { focusChange });
    return;
  }
  tryEnterExternalHold('audio_focus_loss', payload ?? {});
}

function onTelephonyBusy(payload?: NativeHoldHint): void {
  tryEnterExternalHold('telephony_audio_mode', {
    telephonyLikely: true,
    audioMode: payload?.audioMode,
  });
}

function onResumed(): void {
  void (async () => {
    if (Platform.OS === 'android') {
      try {
        const busy = await NativeModules.LiviAppModule?.isExternalTelephonyAudioModeActive?.();
        if (busy === true) {
          logger.info('[externalCallHold] ignore resume — telephony still active (reassert hold)');
          setExternalCallHoldActive(true);
          const session = currentSession();
          if (
            session &&
            typeof session.enterExternalCallHold === 'function' &&
            !session.getLocalExternalHoldActive?.()
          ) {
            void session.enterExternalCallHold().catch((e) => {
              logger.warn('[externalCallHold] re-enter after spurious resume failed', e);
            });
          }
          return;
        }
      } catch {}
    }

    const session = currentSession();
    if (session && typeof session.exitExternalCallHold === 'function') {
      logger.info('[externalCallHold] audio/telephony idle — exiting hold');
      void session.exitExternalCallHold().catch((e) => {
        logger.warn('[externalCallHold] exitExternalCallHold failed', e);
      });
    } else {
      setExternalCallHoldActive(false);
    }
  })();
}

/** Подписка на GSM/мессенджеры (audio mode + focus) во время активного LiVi-звонка. */
export function installExternalCallHoldHandlers(): void {
  if (installed) return;
  installed = true;
  if (Platform.OS !== 'android') return;
  const mod = NativeModules.LiviAppModule;
  if (!mod) return;
  const emitter = new NativeEventEmitter(mod);
  emitter.addListener('ActiveCallExternalAudioInterrupted', onInterrupted);
  emitter.addListener('ActiveCallExternalTelephonyBusy', onTelephonyBusy);
  emitter.addListener('ActiveCallExternalAudioResumed', onResumed);
}
