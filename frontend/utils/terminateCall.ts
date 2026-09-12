/**
 * Единый путь teardown поверхностей звонка (пункт 1 WA-like плана).
 *
 * Гасит native Incoming/Outgoing, CallKeep, ringtone/FS, active-call notification,
 * и связанные JS-флаги visible / close-события.
 *
 * Не заменяет session.endCall / VideoCall cleanup / PiP hide — только surfaces.
 * Медиа и навигацию вызывающий код оставляет как было.
 */
import { Platform } from 'react-native';
import {
  closeOutgoingCallActivity,
  notifyCallCanceled,
  reportEndCallToCallKeep,
  setCallKeepAvailable,
  stopIncomingCallForegroundService,
  stopIncomingCallRingtoneAndVibration,
  addEndedCallId,
} from './callKeep';
import { stopActiveCallNotification } from './activeCallNotification';
import {
  emitCloseIncoming,
  emitRequestCloseIncoming,
  emitCloseOutgoingCall,
  type CloseOutgoingCallPayload,
} from './globalEvents';
import {
  setOutgoingCallScreenVisible,
  setIncomingCallScreenVisible,
} from '../sockets/socket';
import { stopIncomingCallAlert } from './incomingCallAlert';
import { logger } from './logger';

/** Lazy: avoid cycle with pushNotifications ↔ terminateCall. */
function clearCallNotificationsAsync(): void {
  void import('./pushNotifications')
    .then((m) => m.clearCallRelatedNotificationsAndSyncBadge())
    .catch(() => {});
}

export type TerminateCallReason =
  /** Исходящий: peer отклонил (push) — с emitCloseOutgoing. */
  | 'outgoing_declined'
  /** Исходящий: peer отклонил (socket App) — без emitCloseOutgoing (анти-мерцание Home). */
  | 'outgoing_declined_socket'
  /** Мы отменили исходящий (native Outgoing / deep link). */
  | 'outgoing_canceled_local'
  /** Локальный safeguard / no-answer: close Outgoing + CallKeep, без emitCloseOutgoing (Home сам гасит UI). */
  | 'outgoing_timeout'
  /** Socket timeout/cancel/busy на Home: close Outgoing + visible=false, без CallKeep/emit (App часто уже закрыл). */
  | 'outgoing_ring_closed'
  /** Старт не удался / cancel до notify / abort redial: close + visible=false + skipMainReturn. */
  | 'outgoing_abort_keep_main'
  /** Только native Outgoing close (before-retry / stale launch); skipMainReturn через opts. */
  | 'outgoing_native_close'
  /** Инициатор отменил вызов — пуш пришёл через Expo. Закрыть IncomingCallActivity и снять уведомление (то же, что FCM call_canceled). */
  | 'incoming_canceled'
  /** Socket/local timeout входящего: CallKeep + Incoming FS + close events (App onCallTimeout). */
  | 'incoming_timeout'
  /** Мы отклонили входящий (Activity / CallKeep / deep link). */
  | 'incoming_declined_local'
  /** Активный звонок завершён — только surfaces (App call:ended / hangup). */
  | 'call_ended_surfaces'
  /** endCallImpl: CallKeep + close events + notifications (session/PiP отдельно). */
  | 'hangup_surfaces'
  /** call:accepted пришёл на уже ended callId. */
  | 'accepted_stale_ended';

type SurfacePlan = {
  closeOutgoing?: boolean;
  forceOutgoing?: boolean;
  skipMainReturn?: boolean;
  outgoingVisibleFalse?: boolean;
  emitCloseOutgoing?: CloseOutgoingCallPayload['reason'] | false;
  incomingVisibleFalse?: boolean;
  emitCloseIncoming?: boolean;
  callKeepEnd?: boolean;
  setCallKeepAvailableTrue?: boolean;
  incomingRingtone?: boolean;
  incomingFs?: boolean;
  incomingAlert?: boolean;
  notifyCanceled?: boolean;
  activeNotification?: boolean;
  clearCallNotifications?: boolean;
  addEndedId?: boolean;
};

const PRESETS: Record<TerminateCallReason, SurfacePlan> = {
  outgoing_declined: {
    closeOutgoing: true,
    forceOutgoing: true,
    outgoingVisibleFalse: true,
    emitCloseOutgoing: 'remote_closed',
    callKeepEnd: true,
  },
  outgoing_declined_socket: {
    closeOutgoing: true,
    forceOutgoing: true,
    skipMainReturn: true,
    outgoingVisibleFalse: true,
    emitCloseOutgoing: false,
    emitCloseIncoming: true,
    callKeepEnd: true,
    incomingRingtone: true,
    incomingAlert: true,
  },
  outgoing_canceled_local: {
    closeOutgoing: true,
    forceOutgoing: true,
    outgoingVisibleFalse: true,
    emitCloseOutgoing: 'native_cancel',
    callKeepEnd: true,
  },
  outgoing_timeout: {
    closeOutgoing: true,
    forceOutgoing: true,
    outgoingVisibleFalse: true,
    callKeepEnd: true,
  },
  outgoing_ring_closed: {
    closeOutgoing: true,
    forceOutgoing: true,
    outgoingVisibleFalse: true,
  },
  outgoing_abort_keep_main: {
    closeOutgoing: true,
    forceOutgoing: true,
    skipMainReturn: true,
    outgoingVisibleFalse: true,
  },
  outgoing_native_close: {
    closeOutgoing: true,
    forceOutgoing: true,
  },
  incoming_canceled: {
    callKeepEnd: true,
    notifyCanceled: true,
    incomingRingtone: true,
    incomingAlert: true,
    incomingVisibleFalse: true,
    incomingFs: true,
    addEndedId: true,
  },
  incoming_timeout: {
    callKeepEnd: true,
    notifyCanceled: true,
    incomingRingtone: true,
    incomingAlert: true,
    incomingVisibleFalse: true,
    incomingFs: true,
    addEndedId: true,
    emitCloseIncoming: true,
    emitCloseOutgoing: 'remote_closed',
    closeOutgoing: true,
    forceOutgoing: true,
    outgoingVisibleFalse: true,
  },
  incoming_declined_local: {
    callKeepEnd: true,
    incomingRingtone: true,
    incomingAlert: true,
    incomingVisibleFalse: true,
    incomingFs: true,
    emitCloseIncoming: true,
    clearCallNotifications: true,
    addEndedId: true,
  },
  call_ended_surfaces: {
    callKeepEnd: true,
    setCallKeepAvailableTrue: true,
    incomingRingtone: true,
    incomingAlert: true,
    incomingFs: true,
    incomingVisibleFalse: true,
    emitCloseIncoming: true,
    emitCloseOutgoing: 'remote_closed',
    closeOutgoing: true,
    forceOutgoing: true,
    outgoingVisibleFalse: true,
    activeNotification: true,
    clearCallNotifications: true,
    // addEndedId: caller uses addEndedCallIdFromSocket / own tracking
  },
  hangup_surfaces: {
    callKeepEnd: true,
    setCallKeepAvailableTrue: true,
    emitCloseOutgoing: 'remote_closed',
    emitCloseIncoming: true,
    activeNotification: true,
    clearCallNotifications: true,
    incomingFs: true,
    incomingRingtone: true,
  },
  accepted_stale_ended: {
    closeOutgoing: true,
    forceOutgoing: true,
    outgoingVisibleFalse: true,
    incomingVisibleFalse: true,
    emitCloseOutgoing: 'remote_closed',
    emitCloseIncoming: true,
    incomingAlert: true,
    clearCallNotifications: true,
    activeNotification: true,
    callKeepEnd: true,
  },
};

const DEDUP_MS = 700;
let lastKey = '';
let lastAt = 0;

export type TerminateCallOptions = {
  reason: TerminateCallReason;
  callId?: string | null;
  roomId?: string | null;
  /** Переопределить skipMainReturn при closeOutgoing. */
  skipMainReturn?: boolean;
  /** Не дедупить (редкие force-пути). */
  force?: boolean;
};

/**
 * Единая точка surface-teardown. Идемпотентна на коротком окне (callId+reason).
 */
export function terminateCall(opts: TerminateCallOptions): void {
  const reason = opts.reason;
  const callId = String(opts.callId || '').trim();
  const plan: SurfacePlan = { ...PRESETS[reason] };
  if (typeof opts.skipMainReturn === 'boolean') {
    plan.skipMainReturn = opts.skipMainReturn;
  }

  const dedupKey = `${reason}|${callId || '_'}`;
  const now = Date.now();
  if (!opts.force && lastKey === dedupKey && now - lastAt < DEDUP_MS) {
    logger.info('[terminateCall] skip duplicate', { reason, callId: callId || null });
    return;
  }
  lastKey = dedupKey;
  lastAt = now;

  logger.info('[terminateCall]', {
    reason,
    callId: callId || null,
    roomId: opts.roomId ? String(opts.roomId) : null,
  });

  if (plan.callKeepEnd && callId) {
    try {
      reportEndCallToCallKeep(callId);
    } catch {}
  }
  if (plan.setCallKeepAvailableTrue) {
    try {
      setCallKeepAvailable(true);
    } catch {}
  }
  if (plan.addEndedId && callId) {
    try {
      addEndedCallId(callId);
    } catch {}
  }
  if (plan.notifyCanceled && callId) {
    try {
      notifyCallCanceled(callId);
    } catch {}
  }
  if (plan.incomingRingtone) {
    try {
      stopIncomingCallRingtoneAndVibration();
    } catch {}
  }
  if (plan.incomingFs) {
    try {
      stopIncomingCallForegroundService();
    } catch {}
  }
  if (plan.incomingAlert) {
    try {
      stopIncomingCallAlert();
    } catch {}
  }
  if (plan.activeNotification) {
    try {
      stopActiveCallNotification();
    } catch {}
  }
  if (plan.outgoingVisibleFalse) {
    try {
      setOutgoingCallScreenVisible(false);
    } catch {}
  }
  if (plan.incomingVisibleFalse) {
    try {
      setIncomingCallScreenVisible(false);
    } catch {}
  }
  if (plan.closeOutgoing) {
    try {
      closeOutgoingCallActivity(callId || null, {
        force: plan.forceOutgoing === true,
        skipMainReturn: plan.skipMainReturn === true,
      });
    } catch {}
  }
  if (plan.emitCloseOutgoing) {
    try {
      emitCloseOutgoingCall({ reason: plan.emitCloseOutgoing, callId: callId || null });
    } catch {}
  }
  if (plan.emitCloseIncoming) {
    try {
      emitCloseIncoming();
      emitRequestCloseIncoming();
    } catch {}
  }
  if (plan.clearCallNotifications) {
    clearCallNotificationsAsync();
  }

  // iOS: CallKeep end уже выше; native Activities — Android-only внутри callKeep helpers.
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return;
  }
}
