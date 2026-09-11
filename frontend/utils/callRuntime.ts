/**
 * Пункт 6: call runtime как source of truth для lifecycle/policy флагов.
 *
 * Политика:
 * - Новая логика звонка читает/пишет через API этого модуля.
 * - `global.__*Ref` — только thin bridge (совместимость со старым кодом / PiP / native).
 * - Не добавлять новые «истины» в globals; если нужен флаг — сюда.
 *
 * Bridge: get всегда отдаёт живой box; set с `{ current }` — adopt (важно для
 * VideoCall, который вешает свои React.ref на __inAudioOnlyUiRef / stayOn).
 */
type RefBox<T> = { current: T };

type Holder<T> = { box: RefBox<T> };

function holder<T>(initial: T): Holder<T> {
  return { box: { current: initial } };
}

function installBridgedRef<T>(globalKey: string, h: Holder<T>): void {
  const g = global as any;
  try {
    const existing = g[globalKey];
    if (existing && typeof existing === 'object' && 'current' in existing) {
      h.box = existing as RefBox<T>;
    }
  } catch {}
  try {
    Object.defineProperty(g, globalKey, {
      configurable: true,
      enumerable: false,
      get() {
        return h.box;
      },
      set(next: unknown) {
        if (next && typeof next === 'object' && 'current' in (next as object)) {
          h.box = next as RefBox<T>;
        }
      },
    });
  } catch {
    try {
      g[globalKey] = h.box;
    } catch {}
  }
}

const H = {
  webrtcSession: holder<any>(null),
  endingCallInProgress: holder(false),
  videoCallActive: holder(false),
  callEndedFromPiPNoOpen: holder(false),
  endingFromPiPButton: holder(false),
  inCallAudioSessionStarted: holder(false),
  pipVisible: holder(false),
  pipInSystemMode: holder(false),
  pipSuspendedForSystemPiP: holder(false),
  pipForceHidden: holder(false),
  pendingSystemPiPSync: holder(false),
  inAudioOnlyUi: holder(false),
  stayOnVideoCallUi: holder(false),
  preferAudioOnlyUiOnNextVideoCall: holder(false),
  pipAudioOnlyPlaceholder: holder(false),
  outgoingCallId: holder('' as string),
};

let installed = false;

/** Вызывать один раз на старте (index.tsx), до App / push. */
export function installCallRuntimeBridges(): void {
  if (installed) return;
  installed = true;
  installBridgedRef('__webrtcSessionRef', H.webrtcSession);
  installBridgedRef('__endingCallInProgressRef', H.endingCallInProgress);
  installBridgedRef('__videoCallActiveRef', H.videoCallActive);
  installBridgedRef('__callEndedFromPiPNoOpenRef', H.callEndedFromPiPNoOpen);
  installBridgedRef('__endingFromPiPButtonRef', H.endingFromPiPButton);
  installBridgedRef('__inCallAudioSessionStartedRef', H.inCallAudioSessionStarted);
  installBridgedRef('__pipVisibleRef', H.pipVisible);
  installBridgedRef('__pipInSystemModeRef', H.pipInSystemMode);
  installBridgedRef('__pipSuspendedForSystemPiPRef', H.pipSuspendedForSystemPiP);
  installBridgedRef('__pipForceHiddenRef', H.pipForceHidden);
  installBridgedRef('__pendingSystemPiPSyncRef', H.pendingSystemPiPSync);
  installBridgedRef('__inAudioOnlyUiRef', H.inAudioOnlyUi);
  installBridgedRef('__stayOnVideoCallUiRef', H.stayOnVideoCallUi);
  installBridgedRef('__preferAudioOnlyUiOnNextVideoCallRef', H.preferAudioOnlyUiOnNextVideoCall);
  installBridgedRef('__pipAudioOnlyPlaceholderRef', H.pipAudioOnlyPlaceholder);
  installBridgedRef('__outgoingCallIdRef', H.outgoingCallId);
}

function ensureInstalled(): void {
  if (!installed) installCallRuntimeBridges();
}

// —— Session ——

export function getWebrtcSession(): any {
  ensureInstalled();
  return H.webrtcSession.box.current;
}

export function setWebrtcSession(session: any): void {
  ensureInstalled();
  H.webrtcSession.box.current = session;
}

// —— Ending / active ——

export function isEndingCallInProgress(): boolean {
  ensureInstalled();
  return H.endingCallInProgress.box.current === true;
}

export function setEndingCallInProgress(value: boolean): void {
  ensureInstalled();
  H.endingCallInProgress.box.current = !!value;
}

export function isVideoCallActive(): boolean {
  ensureInstalled();
  return H.videoCallActive.box.current === true;
}

/** `false` явно «не активен»; иначе не false (в т.ч. stale true). */
export function isVideoCallActiveExplicitlyFalse(): boolean {
  ensureInstalled();
  return H.videoCallActive.box.current === false;
}

export function setVideoCallActive(value: boolean): void {
  ensureInstalled();
  H.videoCallActive.box.current = !!value;
}

export function isCallEndedFromPiPNoOpen(): boolean {
  ensureInstalled();
  return H.callEndedFromPiPNoOpen.box.current === true;
}

export function setCallEndedFromPiPNoOpen(value: boolean): void {
  ensureInstalled();
  H.callEndedFromPiPNoOpen.box.current = !!value;
}

export function isEndingFromPiPButton(): boolean {
  ensureInstalled();
  return H.endingFromPiPButton.box.current === true;
}

export function setEndingFromPiPButton(value: boolean): void {
  ensureInstalled();
  H.endingFromPiPButton.box.current = !!value;
}

export function isInCallAudioSessionStarted(): boolean {
  ensureInstalled();
  return H.inCallAudioSessionStarted.box.current === true;
}

export function setInCallAudioSessionStarted(value: boolean): void {
  ensureInstalled();
  H.inCallAudioSessionStarted.box.current = !!value;
}

// —— PiP mutex-related ——

export function isPipVisible(): boolean {
  ensureInstalled();
  return H.pipVisible.box.current === true;
}

export function setPipVisible(value: boolean): void {
  ensureInstalled();
  H.pipVisible.box.current = !!value;
}

export function isPipInSystemMode(): boolean {
  ensureInstalled();
  return H.pipInSystemMode.box.current === true;
}

export function setPipInSystemMode(value: boolean): void {
  ensureInstalled();
  H.pipInSystemMode.box.current = !!value;
}

export function isPipSuspendedForSystem(): boolean {
  ensureInstalled();
  return H.pipSuspendedForSystemPiP.box.current === true;
}

export function setPipSuspendedForSystem(value: boolean): void {
  ensureInstalled();
  H.pipSuspendedForSystemPiP.box.current = !!value;
}

export function isPipForceHidden(): boolean {
  ensureInstalled();
  return H.pipForceHidden.box.current === true;
}

export function isPendingSystemPiPSync(): boolean {
  ensureInstalled();
  return H.pendingSystemPiPSync.box.current === true;
}

// —— Audio / video UI mode ——

export function isInAudioOnlyUi(): boolean {
  ensureInstalled();
  return H.inAudioOnlyUi.box.current === true;
}

export function setInAudioOnlyUi(value: boolean): void {
  ensureInstalled();
  H.inAudioOnlyUi.box.current = !!value;
}

export function isStayOnVideoCallUi(): boolean {
  ensureInstalled();
  return H.stayOnVideoCallUi.box.current === true;
}

export function setStayOnVideoCallUi(value: boolean): void {
  ensureInstalled();
  H.stayOnVideoCallUi.box.current = !!value;
}

export function isPreferAudioOnlyUiOnNextVideoCall(): boolean {
  ensureInstalled();
  return H.preferAudioOnlyUiOnNextVideoCall.box.current === true;
}

export function setPreferAudioOnlyUiOnNextVideoCall(value: boolean): void {
  ensureInstalled();
  H.preferAudioOnlyUiOnNextVideoCall.box.current = !!value;
}

export function isPipAudioOnlyPlaceholder(): boolean {
  ensureInstalled();
  return H.pipAudioOnlyPlaceholder.box.current === true;
}

export function setPipAudioOnlyPlaceholder(value: boolean): void {
  ensureInstalled();
  H.pipAudioOnlyPlaceholder.box.current = !!value;
}

// —— Outgoing dial ——

export function getOutgoingCallId(): string {
  ensureInstalled();
  return String(H.outgoingCallId.box.current || '').trim();
}

export function setOutgoingCallId(callId: string): void {
  ensureInstalled();
  H.outgoingCallId.box.current = String(callId || '');
}

/**
 * Сброс lifecycle-флагов после hangup (не трогает session cleanup —
 * вызывающий код по-прежнему делает endCall / hidePiP).
 */
export function resetCallRuntimeSurfacesAfterHangup(): void {
  ensureInstalled();
  setEndingCallInProgress(true);
  setCallEndedFromPiPNoOpen(false);
  setEndingFromPiPButton(false);
  setPipVisible(false);
  setPipInSystemMode(false);
  setPipSuspendedForSystem(false);
  setPreferAudioOnlyUiOnNextVideoCall(false);
}
