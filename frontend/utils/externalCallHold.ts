/**
 * Внешний звонок (GSM/WA/TG) во время LiVi audio/video.
 *
 * Продукт (отдельно от «Слабая сеть»):
 * - Кому позвонили: mute uplink, local hold UI; при возврате в LiVi видно «Звонок на удержании».
 * - Партнёру: socket call:external-hold → freeze видео + freeze таймера + holdLine под аватаром/временем.
 * - «Слабая сеть» только при реальных провалах связи (peerReconnecting), не при hold.
 */
import {
  AppState,
  DeviceEventEmitter,
  NativeEventEmitter,
  NativeModules,
  Platform,
  type AppStateStatus,
  type EmitterSubscription,
} from 'react-native';
import { isOngoingCallSession } from './activeCallSession';
import { logger } from './logger';

/** Android AudioManager: постоянная потеря focus. */
const ANDROID_AUDIOFOCUS_LOSS = -1;
/** WA/TG и большинство VoIP поверх звонка. */
const ANDROID_AUDIOFOCUS_LOSS_TRANSIENT = -2;
/** MODE_RINGTONE / MODE_IN_CALL — GSM или системный звонок без READ_PHONE_STATE. */
const ANDROID_MODE_RINGTONE = 1;
const ANDROID_MODE_IN_CALL = 2;
/** Окно: focus-loss в foreground → сразу background (телефонный UI). */
const DEFERRED_FOCUS_HOLD_MS = 12000;
const FRESH_PENDING_MS = 8000;
/** После hold:false uplink ещё секунду без пакетов — не вспыхивать «нет сети». */
const POST_HOLD_PEER_RECONNECT_SUPPRESS_MS = 2000;

let installed = false;
let holdActive = false;
/** Когда hold только что сняли (local или partner). */
let lastExternalHoldEndedAt = 0;
let appStateSub: { remove: () => void } | null = null;
let backgroundTelephonyTimers: ReturnType<typeof setTimeout>[] = [];
let pipProbeSub: { remove: () => void } | null = null;
let inCallManagerFocusSub: EmitterSubscription | null = null;
let foregroundExitTimers: ReturnType<typeof setTimeout>[] = [];
let deferredFocusHoldTimer: ReturnType<typeof setTimeout> | null = null;
/** Когда JS видел LOSS_TRANSIENT после установленного медиа (не bootstrap). */
let lastMediaFocusLossAt = 0;
let lastMediaFocusLossHint: NativeHoldHint = {};
/**
 * После первого успешного LiveKit+remote в этом звонке.
 * GSM/WA часто рвут audio focus → LiveKit кратко не connected; без этого флага
 * tryEnter сбрасывал sticky и партнёр видел стоп-кадр без «Звонок на удержании».
 */
let callMediaEstablishedOnce = false;
/** callId, которому принадлежат local hold и bootstrap/media guards. */
let externalHoldCallId: string | null = null;

export function isExternalCallHoldActive(): boolean {
  return holdActive;
}

/** Stall/«слабая сеть» не показывать, пока чужой звонок забрал audio / hold. */
export function shouldSuppressPeerReconnectForExternalHold(): boolean {
  if (holdActive) return true;
  if (
    lastExternalHoldEndedAt > 0 &&
    Date.now() - lastExternalHoldEndedAt < POST_HOLD_PEER_RECONNECT_SUPPRESS_MS
  ) {
    return true;
  }
  if (lastMediaFocusLossAt > 0 && Date.now() - lastMediaFocusLossAt < DEFERRED_FOCUS_HOLD_MS) {
    return true;
  }
  try {
    const s = (global as any).__webrtcSessionRef?.current;
    if (s?.getLocalExternalHoldActive?.() || s?.getPartnerExternalHoldActive?.()) return true;
  } catch {}
  return false;
}

/** Partner/local hold снят — окно против вспышки peerReconnecting. */
export function noteExternalHoldEnded(): void {
  lastExternalHoldEndedAt = Date.now();
}

export function setExternalCallHoldActive(active: boolean): void {
  if (holdActive && !active) {
    lastExternalHoldEndedAt = Date.now();
  }
  holdActive = active;
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.setExternalCallAudioHoldActive?.(active);
  } catch {}
}

function clearNativeHoldSticky(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.clearExternalCallHoldInterruptSticky?.();
  } catch {}
}

type HoldSession = {
  enterExternalCallHold?: () => Promise<void>;
  exitExternalCallHold?: () => Promise<void>;
  getLocalExternalHoldActive?: () => boolean;
  clearPeerReconnectingForExternalHold?: () => void;
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

type ProbeResult = {
  telephony?: boolean;
  focusLost?: boolean;
  pending?: boolean;
  focusChange?: number;
  audioMode?: number;
  pendingAgeMs?: number;
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
  if (audioMode === ANDROID_MODE_RINGTONE) return true;
  return false;
}

function isExternalFocusLoss(focusChange?: number): boolean {
  return (
    focusChange === ANDROID_AUDIOFOCUS_LOSS ||
    focusChange === ANDROID_AUDIOFOCUS_LOSS_TRANSIENT
  );
}

function isDirectCallMediaEstablished(session: HoldSession): boolean {
  if (typeof session.isEnded === 'function' && session.isEnded()) return false;
  const roomState = session.getLiveKitRoomState?.();
  if (roomState && roomState !== 'connected') return false;
  const remote = session.getRemoteStream?.();
  if (!remote) return false;
  return true;
}

function noteCallMediaEstablishedIfNeeded(session: HoldSession): void {
  if (callMediaEstablishedOnce) return;
  if (isDirectCallMediaEstablished(session)) {
    callMediaEstablishedOnce = true;
  }
}

function clearCallMediaEstablished(): void {
  callMediaEstablishedOnce = false;
}

function resetExternalCallHoldRuntimeState(): void {
  clearBackgroundTelephonyTimers();
  clearForegroundExitTimers();
  clearDeferredFocusHoldTimer();
  holdActive = false;
  lastExternalHoldEndedAt = 0;
  clearMediaFocusLossNote();
  clearCallMediaEstablished();
  try {
    NativeModules.LiviAppModule?.setExternalCallAudioHoldActive?.(false);
  } catch {}
  clearNativeHoldSticky();
}

/**
 * Новый callId начинает чистый lifecycle hold. Повторный mount/сессия того же звонка
 * состояние не сбрасывает.
 */
export function prepareExternalCallHoldForCall(callId?: string | null): void {
  const nextCallId = String(callId ?? '').trim();
  if (!nextCallId || nextCallId === externalHoldCallId) return;
  externalHoldCallId = nextCallId;
  resetExternalCallHoldRuntimeState();
}

/** Позднее завершение старой сессии не имеет права очищать hold нового звонка. */
export function clearExternalCallHoldForCall(callId?: string | null): void {
  const endingCallId = String(callId ?? '').trim();
  if (endingCallId && externalHoldCallId && endingCallId !== externalHoldCallId) return;
  externalHoldCallId = null;
  resetExternalCallHoldRuntimeState();
}

/** Hold после первого connect: remote может ещё быть, room — reconnecting. */
function canEnterHoldForSession(session: HoldSession): boolean {
  if (typeof session.isEnded === 'function' && session.isEnded()) return false;
  if (isDirectCallMediaEstablished(session)) {
    callMediaEstablishedOnce = true;
    return true;
  }
  if (!callMediaEstablishedOnce) return false;
  // Уже был медиа-путь в звонке: не блокируем hold из‑за краткого disconnect.
  try {
    const remote = session.getRemoteStream?.();
    if (remote) return true;
  } catch {}
  return true;
}

function clearBackgroundTelephonyTimers(): void {
  for (const t of backgroundTelephonyTimers) clearTimeout(t);
  backgroundTelephonyTimers = [];
}

function clearForegroundExitTimers(): void {
  for (const t of foregroundExitTimers) clearTimeout(t);
  foregroundExitTimers = [];
}

function clearDeferredFocusHoldTimer(): void {
  if (deferredFocusHoldTimer) {
    clearTimeout(deferredFocusHoldTimer);
    deferredFocusHoldTimer = null;
  }
}

function noteMediaFocusLoss(hint: NativeHoldHint): void {
  lastMediaFocusLossAt = Date.now();
  lastMediaFocusLossHint = { ...hint };
}

function clearMediaFocusLossNote(): void {
  lastMediaFocusLossAt = 0;
  lastMediaFocusLossHint = {};
}

function tryExitExternalHold(reason: string): void {
  const session = currentSession();
  if (session && typeof session.exitExternalCallHold === 'function') {
    if (!holdActive && !session.getLocalExternalHoldActive?.()) {
      setExternalCallHoldActive(false);
      return;
    }
    logger.info('[externalCallHold] exiting hold', { reason });
    void session.exitExternalCallHold().catch((e) => {
      logger.warn('[externalCallHold] exitExternalCallHold failed', e);
    });
  } else {
    setExternalCallHoldActive(false);
  }
  clearMediaFocusLossNote();
  if (!isOngoingCallSession()) {
    clearCallMediaEstablished();
  }
}

function tryEnterExternalHold(reason: string, hint: NativeHoldHint): void {
  if (!isOngoingCallSession()) {
    logger.info('[externalCallHold] skip — no ongoing call session', { reason });
    clearNativeHoldSticky();
    clearMediaFocusLossNote();
    clearCallMediaEstablished();
    return;
  }
  if (holdActive) return;

  const session = currentSession();
  if (!session || typeof session.enterExternalCallHold !== 'function') {
    logger.info('[externalCallHold] skip — no session.enterExternalCallHold', { reason });
    return;
  }
  noteCallMediaEstablishedIfNeeded(session);
  if (!canEnterHoldForSession(session)) {
    // Только bootstrap accept/connect — не трогаем sticky, если медиа уже было
    // (иначе GSM после reconnect убивает pending focus и партнёр без hold UI).
    logger.info('[externalCallHold] ignore — call media not established yet', { reason });
    clearNativeHoldSticky();
    clearMediaFocusLossNote();
    return;
  }

  const telephony = isTelephonyAudioMode(hint.audioMode, hint.telephonyLikely);
  const focusLoss = isExternalFocusLoss(hint.focusChange);
  const recentFocus =
    lastMediaFocusLossAt > 0 && Date.now() - lastMediaFocusLossAt < DEFERRED_FOCUS_HOLD_MS;
  const inBackground =
    AppState.currentState === 'background' || AppState.currentState === 'inactive';

  // Home без чужого звонка: нет focus-loss и нет telephony.
  if (inBackground && !telephony && !focusLoss && !recentFocus) {
    logger.info('[externalCallHold] ignore — background without telephony/focus loss', {
      reason,
      focusChange: hint.focusChange,
      audioMode: hint.audioMode,
    });
    return;
  }

  // Focus в foreground без telephony: телефонный UI часто ещё «active» на 100–800мс
  // после LOSS (OEM: notification/popup call UI). Не чистим sticky на первом тике —
  // иначе background на ~30–200мс позже теряет recentFocus и hold не открывается.
  if (!inBackground && !telephony && focusLoss) {
    noteMediaFocusLoss(hint);
    logger.info('[externalCallHold] defer — foreground focus, wait background/telephony', {
      reason,
      focusChange: hint.focusChange,
      mediaOnce: callMediaEstablishedOnce,
    });
    clearDeferredFocusHoldTimer();
    const focusHint: NativeHoldHint = {
      ...hint,
      focusChange: hint.focusChange ?? ANDROID_AUDIOFOCUS_LOSS_TRANSIENT,
    };
    const armDeferred = (delayMs: number, pass: number) => {
      deferredFocusHoldTimer = setTimeout(() => {
        deferredFocusHoldTimer = null;
        if (holdActive) return;
        const state = AppState.currentState;
        const bg = state === 'background' || state === 'inactive';
        if (bg) {
          tryEnterExternalHold(
            pass === 1 ? 'deferred_focus_after_background' : 'deferred_focus_after_background_rearm',
            { ...lastMediaFocusLossHint, ...focusHint }
          );
          return;
        }
        if (pass === 1) {
          // Ещё foreground — не clear: ждём late AppState / telephony. Sticky для probe.
          logger.info('[externalCallHold] deferred focus still foreground — rearm, keep sticky', {
            delayMs,
          });
          armDeferred(1600, 2);
          return;
        }
        // Долго остались в LiVi без background — ложный InCallManager blip.
        logger.info('[externalCallHold] deferred focus expired — stayed foreground, clear');
        clearNativeHoldSticky();
        clearMediaFocusLossNote();
      }, delayMs);
    };
    armDeferred(700, 1);
    return;
  }

  logger.info('[externalCallHold] entering hold', {
    reason,
    telephony,
    focusLoss,
    recentFocus,
    mediaOnce: callMediaEstablishedOnce,
    focusChange: hint.focusChange,
    audioMode: hint.audioMode,
    appState: AppState.currentState,
  });
  try {
    session.clearPeerReconnectingForExternalHold?.();
  } catch {}
  void session.enterExternalCallHold().catch((e) => {
    logger.warn('[externalCallHold] enterExternalCallHold failed', e);
  });
}

function onInterrupted(payload?: NativeHoldHint): void {
  logger.info('[externalCallHold] native interrupted', {
    focusChange: payload?.focusChange,
    audioMode: payload?.audioMode,
    telephonyLikely: payload?.telephonyLikely,
  });
  const focusChange = payload?.focusChange;
  if (focusChange != null && !isExternalFocusLoss(focusChange)) {
    logger.info('[externalCallHold] ignore non-hold focus change', { focusChange });
    return;
  }
  const session = currentSession();
  if (session) {
    noteCallMediaEstablishedIfNeeded(session);
    // Даже если LiveKit уже reconnecting — запомнить focus для background probe.
    if (canEnterHoldForSession(session)) {
      noteMediaFocusLoss(payload ?? {});
    }
  }
  tryEnterExternalHold(
    focusChange === ANDROID_AUDIOFOCUS_LOSS_TRANSIENT
      ? 'audio_focus_loss_transient'
      : 'audio_focus_loss',
    payload ?? {}
  );
}

function onTelephonyBusy(payload?: NativeHoldHint): void {
  logger.info('[externalCallHold] native telephony busy', {
    audioMode: payload?.audioMode,
  });
  clearDeferredFocusHoldTimer();
  tryEnterExternalHold('telephony_audio_mode', {
    telephonyLikely: true,
    audioMode: payload?.audioMode,
  });
}

async function pollProbeAndMaybeHold(reason: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (!isOngoingCallSession() || holdActive) return;
  try {
    const probe: ProbeResult | null =
      (await NativeModules.LiviAppModule?.probeExternalCallHoldSignal?.()) ?? null;
    if (!probe) {
      // Даже без probe: недавний focus + background = телефонный UI.
      const recentFocus =
        lastMediaFocusLossAt > 0 && Date.now() - lastMediaFocusLossAt < DEFERRED_FOCUS_HOLD_MS;
      if (recentFocus) {
        tryEnterExternalHold(`${reason}_recent_focus`, {
          ...lastMediaFocusLossHint,
          focusChange:
            lastMediaFocusLossHint.focusChange ?? ANDROID_AUDIOFOCUS_LOSS_TRANSIENT,
        });
      }
      return;
    }
    const telephony = probe.telephony === true;
    const age = typeof probe.pendingAgeMs === 'number' ? probe.pendingAgeMs : -1;
    const freshPending =
      isExternalFocusLoss(probe.focusChange) && age >= 0 && age <= FRESH_PENDING_MS;
    const recentFocus =
      lastMediaFocusLossAt > 0 && Date.now() - lastMediaFocusLossAt < DEFERRED_FOCUS_HOLD_MS;
    if (!telephony && !freshPending && !recentFocus) {
      if (probe.focusLost === true) {
        // Во время активного звонка focus часто держит InCallManager, а не LiviAppModule.
        // Если уже background и медиа было — это внешний звонок/оверлей, не «stale bootstrap».
        const bg =
          AppState.currentState === 'background' || AppState.currentState === 'inactive';
        const session = currentSession();
        if (bg && session && canEnterHoldForSession(session)) {
          tryEnterExternalHold(`${reason}_focus_lost_background`, {
            focusChange: ANDROID_AUDIOFOCUS_LOSS_TRANSIENT,
            audioMode: probe.audioMode,
          });
          return;
        }
        logger.info('[externalCallHold] probe ignore stale focusLost', { reason, probe });
        clearNativeHoldSticky();
      }
      return;
    }
    logger.info('[externalCallHold] probe hit', {
      reason,
      probe,
      freshPending,
      recentFocus,
    });
    tryEnterExternalHold(reason, {
      telephonyLikely: telephony,
      focusChange:
        freshPending || recentFocus
          ? probe.focusChange && isExternalFocusLoss(probe.focusChange)
            ? probe.focusChange
            : lastMediaFocusLossHint.focusChange ?? ANDROID_AUDIOFOCUS_LOSS_TRANSIENT
          : telephony
            ? ANDROID_AUDIOFOCUS_LOSS_TRANSIENT
            : undefined,
      audioMode: probe.audioMode,
    });
  } catch {}
}

function scheduleBackgroundProbes(): void {
  // Немедленный вход, если focus уже был в foreground перед leaveHint.
  const recentFocus =
    lastMediaFocusLossAt > 0 && Date.now() - lastMediaFocusLossAt < DEFERRED_FOCUS_HOLD_MS;
  if (recentFocus) {
    tryEnterExternalHold('appstate_background_recent_focus', {
      ...lastMediaFocusLossHint,
      focusChange: lastMediaFocusLossHint.focusChange ?? ANDROID_AUDIOFOCUS_LOSS_TRANSIENT,
    });
  }
  void pollProbeAndMaybeHold('appstate_background_probe');
  clearBackgroundTelephonyTimers();
  for (const delay of [150, 400, 800, 1500, 2800]) {
    backgroundTelephonyTimers.push(
      setTimeout(() => {
        void pollProbeAndMaybeHold(`appstate_background_probe_${delay}`);
      }, delay)
    );
  }
}

async function tryExitHoldOnForeground(reason: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (!holdActive && !currentSession()?.getLocalExternalHoldActive?.()) return;
  try {
    const busy = await NativeModules.LiviAppModule?.isExternalTelephonyAudioModeActive?.();
    if (busy === true) {
      logger.info('[externalCallHold] stay on hold — telephony still active', { reason });
      return;
    }
  } catch {}
  clearNativeHoldSticky();
  clearDeferredFocusHoldTimer();
  tryExitExternalHold(reason);
}

function scheduleForegroundExitProbes(): void {
  clearForegroundExitTimers();
  void tryExitHoldOnForeground('appstate_active');
  for (const delay of [400, 1200, 2500]) {
    foregroundExitTimers.push(
      setTimeout(() => {
        void tryExitHoldOnForeground(`appstate_active_${delay}`);
      }, delay)
    );
  }
}

function onAppStateChange(next: AppStateStatus): void {
  if (next === 'active') {
    clearBackgroundTelephonyTimers();
    clearDeferredFocusHoldTimer();
    scheduleForegroundExitProbes();
    return;
  }
  clearForegroundExitTimers();
  if (next !== 'background' && next !== 'inactive') return;
  scheduleBackgroundProbes();
}

function onAboutToEnterSystemPiP(): void {
  void pollProbeAndMaybeHold('about_to_enter_system_pip');
  scheduleBackgroundProbes();
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
    clearNativeHoldSticky();
    clearDeferredFocusHoldTimer();
    tryExitExternalHold('audio_focus_gain');
  })();
}

/**
 * InCallManager держит voice focus после accept на всех OEM.
 * GSM/WA часто шлют LOSS только ему — LiviAppModule listener молчит.
 * Слушаем его onAudioFocusChange как основной универсальный сигнал.
 */
function onInCallManagerAudioFocusChange(data?: { eventCode?: number; eventText?: string }): void {
  const focusChange = typeof data?.eventCode === 'number' ? data.eventCode : undefined;
  if (focusChange == null) return;
  if (isExternalFocusLoss(focusChange)) {
    logger.info('[externalCallHold] InCallManager focus loss', {
      focusChange,
      eventText: data?.eventText,
    });
    onInterrupted({ focusChange });
    return;
  }
  if (
    focusChange === AudioManagerGainCodes.GAIN ||
    focusChange === AudioManagerGainCodes.GAIN_TRANSIENT ||
    focusChange === AudioManagerGainCodes.GAIN_TRANSIENT_MAY_DUCK ||
    focusChange === AudioManagerGainCodes.GAIN_TRANSIENT_EXCLUSIVE
  ) {
    if (!holdActive && !currentSession()?.getLocalExternalHoldActive?.()) return;
    logger.info('[externalCallHold] InCallManager focus gain', {
      focusChange,
      eventText: data?.eventText,
    });
    onResumed();
  }
}

/** Android AudioManager focus gain codes (mirror native). */
const AudioManagerGainCodes = {
  GAIN: 1,
  GAIN_TRANSIENT: 2,
  GAIN_TRANSIENT_MAY_DUCK: 3,
  GAIN_TRANSIENT_EXCLUSIVE: 4,
} as const;

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
  try {
    pipProbeSub?.remove?.();
  } catch {}
  pipProbeSub = emitter.addListener('AboutToEnterSystemPiP', onAboutToEnterSystemPiP);
  try {
    inCallManagerFocusSub?.remove?.();
  } catch {}
  inCallManagerFocusSub = DeviceEventEmitter.addListener(
    'onAudioFocusChange',
    onInCallManagerAudioFocusChange
  );
  try {
    appStateSub?.remove?.();
  } catch {}
  appStateSub = AppState.addEventListener('change', onAppStateChange);
  logger.info('[externalCallHold] handlers installed');
}
