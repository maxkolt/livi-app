import { NativeModules, Platform } from 'react-native';

// Простой глобальный эмиттер событий без зависимостей
// Используем для мгновенного обновления счетчиков пропущенных звонков на HomeScreen

type Listener<T> = (payload: T) => void;

const missedListeners = new Set<Listener<{ userId: string; count?: number }>>();
const missedClearListeners = new Set<Listener<{ userId: string }>>();
const closeIncomingListeners = new Set<Listener<{}>>();
const closeIncomingRequestListeners = new Set<Listener<{}>>();
const closeOutgoingCallListeners = new Set<Listener<{}>>();
const callCancelledOnHomeListeners = new Set<Listener<{ fromUserId?: string }>>();
const callEndedOnHomeListeners = new Set<Listener<{}>>();
const closeHomeModalsListeners = new Set<Listener<{}>>();
type CometChatStatusKind = 'info' | 'success' | 'error';
type CometChatStatusPayload = {
  kind: CometChatStatusKind;
  title: string;
  message: string;
  userId?: string;
  source?: string;
};
const cometchatStatusListeners = new Set<Listener<CometChatStatusPayload>>();

export function onMissedIncrement(cb: Listener<{ userId: string; count?: number }>): () => void {
  missedListeners.add(cb);
  return () => {
    missedListeners.delete(cb);
  };
}

export function emitMissedIncrement(userId: string, count?: number) {
  const uid = String(userId || '').trim();
  if (!uid) return;
  const payload = typeof count === 'number' ? { userId: uid, count } : { userId: uid };
  for (const l of missedListeners) {
    try { l(payload); } catch {}
  }
}

/** Пропущенные подтянуты с сервера (после reauth) — подписчики перечитывают AsyncStorage. */
const missedFetchedFromServerListeners = new Set<() => void>();
export function onMissedFetchedFromServer(cb: () => void): () => void {
  missedFetchedFromServerListeners.add(cb);
  return () => { missedFetchedFromServerListeners.delete(cb); };
}
export function emitMissedFetchedFromServer() {
  for (const l of missedFetchedFromServerListeners) {
    try { l(); } catch {}
  }
}

/** Сбросить счётчик пропущенных для userId (при принятии вызова получателем или входе в чат/видеозвонок). */
export function onMissedClear(cb: Listener<{ userId: string }>): () => void {
  missedClearListeners.add(cb);
  return () => {
    missedClearListeners.delete(cb);
  };
}

export function emitMissedClear(userId: string) {
  if (!userId) return;
  const uid = String(userId);
  for (const l of missedClearListeners) {
    try { l({ userId: uid }); } catch {}
  }
}

export function onCloseIncoming(cb: () => void): () => void {
  const h = () => cb();
  closeIncomingListeners.add(h as any);
  return () => { closeIncomingListeners.delete(h as any); };
}

export function emitCloseIncoming() {
  for (const l of closeIncomingListeners) {
    try { (l as any)({}); } catch {}
  }
}

export function onRequestCloseIncoming(cb: () => void): () => void {
  const h = () => cb();
  closeIncomingRequestListeners.add(h as any);
  return () => { closeIncomingRequestListeners.delete(h as any); };
}

export function emitRequestCloseIncoming() {
  for (const l of closeIncomingRequestListeners) {
    try { (l as any)({}); } catch {}
  }
}

export type CloseOutgoingCallPayload = {
  /** accepted — звонок принят; native_cancel — инициатор нажал X; remote_closed — сервер/пуш сообщил decline/cancel/timeout. */
  reason?: 'external' | 'accepted' | 'native_cancel' | 'remote_closed';
  /** callId события закрытия, если известен. Нужен, чтобы старые native/push события не сбрасывали новый исходящий. */
  callId?: string | null;
};

/** Закрыть модалку исходящего вызова (когда абонент отклонил/отменил/таймаут вне приложения). */
export function onCloseOutgoingCall(cb: (payload?: CloseOutgoingCallPayload) => void): () => void {
  const h = (payload?: CloseOutgoingCallPayload) => cb(payload);
  closeOutgoingCallListeners.add(h as any);
  return () => { closeOutgoingCallListeners.delete(h as any); };
}

export function emitCloseOutgoingCall(opts?: CloseOutgoingCallPayload) {
  const payload: CloseOutgoingCallPayload = {
    reason: opts?.reason ?? 'external',
    callId: opts?.callId ?? null,
  };
  for (const l of closeOutgoingCallListeners) {
    try { (l as any)(payload); } catch {}
  }
}

/** Вызов отменён инициатором, при этом пользователь уже на Home (страница приветствия). Бейдж показываем через подписку в HomeScreen, без setParams — без лишних ре-рендеров. */
export function onCallCancelledOnHome(cb: (payload?: { fromUserId?: string }) => void): () => void {
  const h = (payload?: { fromUserId?: string }) => cb(payload);
  callCancelledOnHomeListeners.add(h as any);
  return () => { callCancelledOnHomeListeners.delete(h as any); };
}

export function emitCallCancelledOnHome(fromUserId?: string) {
  const payload = { fromUserId: String(fromUserId || '').trim() || undefined };
  for (const l of callCancelledOnHomeListeners) {
    try { (l as any)(payload); } catch {}
  }
}

/**
 * После закрытия нативного Incoming (cancel) Android шлёт несколько AppState/focus подряд.
 * Окно settle подавляет setAppIsActive / loadFriends / setRouteName — иначе Home «мерцает» несколько раз.
 */
export function armHomeUiSettleSkip(ms = 4500): void {
  const g = global as any;
  const until = Date.now() + Math.max(0, Number(ms) || 0);
  g.__skipHomeUiSettleUntilRef = g.__skipHomeUiSettleUntilRef || { current: 0 };
  g.__skipHomeUiSettleUntilRef.current = Math.max(
    Number(g.__skipHomeUiSettleUntilRef.current || 0),
    until,
  );
  // Зеркало на native: AppState(active) может прийти до этого вызова.
  if (Platform.OS === 'android') {
    try {
      NativeModules.LiviAppModule?.armHomeUiSettleSkip?.(ms);
    } catch {}
  }
}

export function shouldSkipHomeUiSettle(): boolean {
  const g = global as any;
  const until = Number(g.__skipHomeUiSettleUntilRef?.current || 0);
  if (until > Date.now()) return true;
  // Native armed на X Outgoing до returnMain — читаем sync, иначе loadFriends глотает тачи.
  if (Platform.OS === 'android') {
    try {
      if (NativeModules.LiviAppModule?.shouldSkipHomeUiSettleSync?.() === true) return true;
    } catch {}
  }
  return false;
}

export function clearHomeUiSettleSkip(): void {
  const g = global as any;
  if (g.__skipHomeUiSettleUntilRef) g.__skipHomeUiSettleUntilRef.current = 0;
  if (g.__skipAppStateActiveSetAppIsActiveRef) g.__skipAppStateActiveSetAppIsActiveRef.current = false;
  if (Platform.OS === 'android') {
    try {
      NativeModules.LiviAppModule?.clearHomeUiSettleSkipNative?.();
    } catch {}
  }
}

/** Звонок завершён (не отмена). Показываем тост «Звонок завершён» на Home при фокусе, без setParams — без лишних ре-рендеров (при закрытии экрана звонка через goBack). */
export function onCallEndedOnHome(cb: () => void): () => void {
  const h = () => cb();
  callEndedOnHomeListeners.add(h as any);
  return () => { callEndedOnHomeListeners.delete(h as any); };
}

export function emitCallEndedOnHome() {
  for (const l of callEndedOnHomeListeners) {
    try { (l as any)({}); } catch {}
  }
}

const CALL_ENDED_GLOBAL_REFS_DEDUP_MS = 3000;

/**
 * Сброс partner/active refs и вызов __onVideoCallEndedRef — один раз на волну call:ended.
 * App, PiPContext и VideoCallSession все слушают один socket; без дедупа колбэк и сброс refs срабатывали 2–3 раза подряд.
 */
export function applyCallEndedGlobalRefsOnce(
  callId?: string | null,
  roomId?: string | null
): boolean {
  const g = global as any;
  const c = String(callId ?? '').trim();
  const r = String(roomId ?? '').trim();
  const key = c && r ? `${c}|${r}` : c || r || 'unknown';
  const now = Date.now();
  g.__callEndedGlobalRefsDedupRef = g.__callEndedGlobalRefsDedupRef || { key: '', at: 0 };
  const d = g.__callEndedGlobalRefsDedupRef;
  if (d.key === key && now - d.at < CALL_ENDED_GLOBAL_REFS_DEDUP_MS) {
    return false;
  }
  d.key = key;
  d.at = now;
  try {
    g.__videoCallPartnerUserIdRef = g.__videoCallPartnerUserIdRef || { current: null };
    g.__videoCallPartnerUserIdRef.current = null;
    g.__videoCallActiveRef = g.__videoCallActiveRef || { current: false };
    g.__videoCallActiveRef.current = false;
    // Сразу снимаем флаги PiP/params, иначе один тик App оставляет hasAnyIds/sessionNotEnded в рассинхроне с реальностью.
    g.__pipVisibleRef = g.__pipVisibleRef || { current: false };
    g.__pipVisibleRef.current = false;
    g.__currentCallPiPParamsRef = g.__currentCallPiPParamsRef || { current: null };
    g.__currentCallPiPParamsRef.current = null;
    g.__pendingCallAcceptedRef = g.__pendingCallAcceptedRef || { current: null };
    g.__pendingCallAcceptedRef.current = null;
    g.__acceptCallTimeRef = g.__acceptCallTimeRef || { current: 0 };
    g.__acceptCallTimeRef.current = 0;
    g.__callTimerCallIdRef = g.__callTimerCallIdRef || { current: '' };
    g.__callTimerCallIdRef.current = '';
    g.__directAudioEarpieceStabilizeUntilRef = g.__directAudioEarpieceStabilizeUntilRef || { current: 0 };
    g.__directAudioEarpieceStabilizeUntilRef.current = 0;
    g.__callConnectedAtRef = g.__callConnectedAtRef || { current: null };
    g.__callConnectedAtRef.current = null;
    g.__directCallAudioOnlyMountKeyRef = g.__directCallAudioOnlyMountKeyRef || { current: null };
    g.__directCallAudioOnlyMountKeyRef.current = null;
    g.__onVideoCallEndedRef?.current?.();
  } catch (_) {}
  return true;
}

/** Закрыть модалки «Поддержать LiVi» и «Пригласи друга» на Home (чтобы экран видеозвонка был поверх при принятии вызова). */
export function onCloseHomeModals(cb: () => void): () => void {
  const h = () => cb();
  closeHomeModalsListeners.add(h as any);
  return () => { closeHomeModalsListeners.delete(h as any); };
}

export function emitCloseHomeModals() {
  for (const l of closeHomeModalsListeners) {
    try { (l as any)({}); } catch {}
  }
}

export type RequestDirectCallPayload = {
  peerId: string;
  peerName?: string;
  peerAvatarVer?: number;
  peerAvatarThumbB64?: string;
  peerOnline?: boolean;
  media?: 'audio' | 'video';
};

const requestDirectCallListeners = new Set<Listener<RequestDirectCallPayload>>();

export function onRequestDirectCall(cb: Listener<RequestDirectCallPayload>): () => void {
  requestDirectCallListeners.add(cb);
  return () => {
    requestDirectCallListeners.delete(cb);
  };
}

export function emitRequestDirectCall(payload: RequestDirectCallPayload) {
  const peerId = String(payload?.peerId || '').trim();
  if (!peerId) return;
  const next: RequestDirectCallPayload = {
    peerId,
    peerName: payload.peerName,
    peerAvatarVer: payload.peerAvatarVer,
    peerAvatarThumbB64: payload.peerAvatarThumbB64,
    peerOnline: payload.peerOnline,
    media: payload.media === 'audio' ? 'audio' : 'video',
  };
  for (const l of requestDirectCallListeners) {
    try {
      l(next);
    } catch {}
  }
}

export function onCometChatStatus(cb: Listener<CometChatStatusPayload>): () => void {
  cometchatStatusListeners.add(cb);
  return () => {
    cometchatStatusListeners.delete(cb);
  };
}

export function emitCometChatStatus(payload: CometChatStatusPayload) {
  for (const l of cometchatStatusListeners) {
    try { l(payload); } catch {}
  }
}

