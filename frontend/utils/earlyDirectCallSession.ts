/**
 * Early LiveKit session on call:accepted — start Room.connect before VideoCall mounts.
 * VideoCall must rebind/reuse __webrtcSessionRef (no second connect).
 */
import { VideoCallSession } from '../src/webrtc/sessions/VideoCallSession';
import type { WebRTCSessionConfig } from '../src/webrtc/types';
import { getCurrentUserId } from '../sockets/socket';
import { logger } from './logger';
import { markCallPerf } from './callPerfTrace';
import { getCallMediaHint } from './directCallMediaHint';

export type EarlyDirectCallBootstrapOpts = {
  callId: string;
  peerUserId?: string | null;
  isCaller: boolean;
  partnerNick?: string | null;
};

function noopConfig(opts: {
  myUserId: string;
  callId: string;
  startWithCamOff: boolean;
  isCaller: boolean;
  partnerNick?: string | null;
}): WebRTCSessionConfig {
  const nick = String(opts.partnerNick || '').trim() || null;
  return {
    myUserId: opts.myUserId,
    initialCallId: opts.callId,
    startWithCamOff: opts.startWithCamOff,
    callbacks: {},
    getIsDirectCall: () => true,
    getIsDirectInitiator: () => opts.isCaller,
    getInDirectCall: () => true,
    setInDirectCall: () => {},
    getFriendCallAccepted: () => true,
    setFriendCallAccepted: () => {},
    getIsInactiveState: () => false,
    setIsInactiveState: () => {},
    getStarted: () => true,
    setStarted: () => {},
    getWasFriendCallEnded: () => false,
    setWasFriendCallEnded: () => {},
    getHasIncomingCall: () => !opts.isCaller,
    getPartnerDisplayName: () => nick,
  };
}

function isTeardownInProgress(): boolean {
  try {
    const g = global as any;
    return (
      g.__endingCallInProgressRef?.current === true ||
      g.__callEndedFromPiPNoOpenRef?.current === true ||
      g.__endingFromPiPButtonRef?.current === true
    );
  } catch {
    return false;
  }
}

function roomBusy(session: VideoCallSession): boolean {
  if (typeof session.isPendingAcceptConnectBusy === 'function' && session.isPendingAcceptConnectBusy()) {
    return true;
  }
  const state =
    (typeof session.getLiveKitRoomState === 'function'
      ? session.getLiveKitRoomState()
      : (session as any)?.room?.state) as string | undefined;
  return state === 'connected' || state === 'connecting' || state === 'reconnecting';
}

/**
 * Create (or reuse) VideoCallSession as soon as call:accepted + LiveKit token are stashed
 * in __pendingCallAcceptedRef. Overlaps Room.connect with navigation / first layout.
 */
export function bootstrapEarlyDirectCallSession(opts: EarlyDirectCallBootstrapOpts): VideoCallSession | null {
  const callId = String(opts.callId || '').trim();
  if (!callId) return null;

  try {
    if (isTeardownInProgress()) {
      logger.info('[earlyDirectCallSession] skip — teardown in progress', { callId });
      markCallPerf('early_session_skip_teardown', { callId });
      return null;
    }

    const g = global as any;
    const pending = g.__pendingCallAcceptedRef?.current;
    const pendingCallId = pending ? String(pending?.callId || '').trim() : '';
    const hasToken =
      !!pending &&
      pendingCallId === callId &&
      !!(pending as any)?.livekitToken &&
      !!(String((pending as any)?.livekitRoomName ?? (pending as any)?.roomId ?? '').trim());

    if (!hasToken) {
      logger.info('[earlyDirectCallSession] skip — no pending LiveKit token', {
        callId,
        pendingCallId: pendingCallId || null,
        hasPending: !!pending,
      });
      markCallPerf('early_session_skip_no_token', { callId });
      return null;
    }

    const myUserId = String(getCurrentUserId() || '').trim();
    if (!myUserId) {
      logger.warn('[earlyDirectCallSession] skip — no myUserId yet', { callId });
      markCallPerf('early_session_skip_no_user', { callId });
      return null;
    }

    const existingRaw = g.__webrtcSessionRef?.current;
    const existing =
      existingRaw instanceof VideoCallSession
        ? existingRaw
        : existingRaw && typeof existingRaw.isEnded === 'function'
          ? (existingRaw as VideoCallSession)
          : null;

    if (existing && typeof existing.isEnded === 'function' && !existing.isEnded()) {
      const existingCallId = String(existing.getCallId?.() || '').trim();
      if (existingCallId && existingCallId !== callId) {
        logger.info('[earlyDirectCallSession] skip — other live session owns UI', {
          callId,
          existingCallId,
          roomState: existing.getLiveKitRoomState?.() ?? null,
        });
        markCallPerf('early_session_skip_other_call', { callId, existingCallId });
        return null;
      }
      if (!existingCallId || existingCallId === callId) {
        if (roomBusy(existing)) {
          logger.info('[earlyDirectCallSession] reuse busy session', {
            callId,
            roomState: existing.getLiveKitRoomState?.() ?? null,
            pendingScheduled:
              typeof existing.didSchedulePendingCallAcceptedConnect === 'function'
                ? existing.didSchedulePendingCallAcceptedConnect()
                : null,
          });
          markCallPerf('early_session_reuse_busy', {
            callId,
            roomState: existing.getLiveKitRoomState?.() ?? null,
          });
          g.__earlyDirectCallBootstrapRef = g.__earlyDirectCallBootstrapRef || { current: null };
          g.__earlyDirectCallBootstrapRef.current = {
            callId,
            at: Date.now(),
            reused: true,
            isCaller: opts.isCaller,
          };
          return existing;
        }
        // Same call, idle session: apply pending via ctor path is already consumed — kick payload.
        if (typeof (existing as any).applyCallAcceptedFromPayload === 'function') {
          logger.info('[earlyDirectCallSession] kick idle session with pending payload', { callId });
          markCallPerf('early_session_kick_idle', { callId });
          void (existing as any).applyCallAcceptedFromPayload(pending, 'early-bootstrap-idle').catch((e: unknown) => {
            logger.warn('[earlyDirectCallSession] kick idle failed', {
              callId,
              error: (e as Error)?.message || String(e),
            });
          });
          g.__earlyDirectCallBootstrapRef = g.__earlyDirectCallBootstrapRef || { current: null };
          g.__earlyDirectCallBootstrapRef.current = {
            callId,
            at: Date.now(),
            reused: true,
            kicked: true,
            isCaller: opts.isCaller,
          };
          return existing;
        }
      }
    }

    const mediaHint = getCallMediaHint(callId);
    const outgoingMedia = String(g.__outgoingCallMediaRef?.current || '').trim();
    const startWithCamOff =
      opts.isCaller
        ? outgoingMedia !== 'video' && mediaHint !== 'video'
        : mediaHint !== 'video';

    const config = noopConfig({
      myUserId,
      callId,
      startWithCamOff,
      isCaller: opts.isCaller,
      partnerNick: opts.partnerNick,
    });

    const startedAt = Date.now();
    logger.info('[earlyDirectCallSession] creating session before VideoCall mount', {
      callId,
      isCaller: opts.isCaller,
      startWithCamOff,
      mediaHint,
      peerUserId: opts.peerUserId ? String(opts.peerUserId) : null,
      hasLivekitToken: true,
    });
    markCallPerf('early_session_create_start', {
      callId,
      isCaller: opts.isCaller,
      startWithCamOff,
    });

    const session = new VideoCallSession(config);
    (session as any).__earlyDirectCallBootstrap = true;
    g.__webrtcSessionRef = g.__webrtcSessionRef || { current: null };
    g.__webrtcSessionRef.current = session;
    g.__earlyDirectCallBootstrapRef = g.__earlyDirectCallBootstrapRef || { current: null };
    g.__earlyDirectCallBootstrapRef.current = {
      callId,
      at: startedAt,
      reused: false,
      isCaller: opts.isCaller,
      startWithCamOff,
    };

    const scheduled =
      typeof session.didSchedulePendingCallAcceptedConnect === 'function' &&
      session.didSchedulePendingCallAcceptedConnect();

    // Сразу flush — не ждать microtask (на Android он сдвигается до layout ~2с).
    let flushed = false;
    if (typeof session.flushPendingCallAcceptedConnect === 'function') {
      flushed = session.flushPendingCallAcceptedConnect('early-bootstrap');
    }

    logger.info('[earlyDirectCallSession] session ready (connect scheduled via pending)', {
      callId,
      scheduled,
      flushed,
      createMs: Date.now() - startedAt,
    });
    markCallPerf('early_session_create_done', {
      callId,
      scheduled,
      flushed,
      createMs: Date.now() - startedAt,
      isCaller: opts.isCaller,
    });

    if (!scheduled && !flushed && typeof (session as any).applyCallAcceptedFromPayload === 'function') {
      logger.warn('[earlyDirectCallSession] ctor did not schedule pending — applying payload explicitly', {
        callId,
      });
      markCallPerf('early_session_explicit_apply', { callId });
      void (session as any).applyCallAcceptedFromPayload(pending, 'early-bootstrap-explicit').catch((e: unknown) => {
        logger.warn('[earlyDirectCallSession] explicit apply failed', {
          callId,
          error: (e as Error)?.message || String(e),
        });
      });
    }

    return session;
  } catch (e) {
    logger.warn('[earlyDirectCallSession] bootstrap failed', {
      callId,
      error: (e as Error)?.message || String(e),
    });
    try {
      markCallPerf('early_session_error', {
        callId,
        error: (e as Error)?.message || String(e),
      });
    } catch {}
    return null;
  }
}

export function wasEarlyDirectCallBootstrap(callId?: string | null): boolean {
  try {
    const g = global as any;
    const meta = g.__earlyDirectCallBootstrapRef?.current;
    if (!meta?.callId) return false;
    const id = String(callId || '').trim();
    if (id && String(meta.callId) !== id) return false;
    return Date.now() - Number(meta.at || 0) < 120_000;
  } catch {
    return false;
  }
}
