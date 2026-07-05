/** callId → audio/video hint (без зависимостей от socket/callKeep — для audio-route и навигации). */
const callMediaByCallId: Record<string, 'audio' | 'video'> = {};

export type DirectCallMediaHint = 'audio' | 'video';

export function setCallMediaHint(callId: string, media: DirectCallMediaHint): void {
  const id = String(callId || '').trim();
  if (!id) return;
  callMediaByCallId[id] = media;
}

export function getCallMediaHint(callId?: string | null): DirectCallMediaHint {
  const id = String(callId || '').trim();
  if (id && callMediaByCallId[id] === 'video') return 'video';
  return 'audio';
}

/** Аудио-first UI и startWithCamOff для прямого звонка (мессенджер: по умолчанию аудио). */
export function resolveDirectCallAudioFirst(
  params?: {
    directCall?: boolean;
    directInitiator?: boolean;
    callMedia?: DirectCallMediaHint;
    startWithCamOff?: boolean;
    callId?: string | null;
  } | null,
  pendingCallId?: string | null,
): boolean {
  const p = params ?? {};
  if (!p.directCall) return false;
  if (p.callMedia === 'video') return false;
  if (p.startWithCamOff || p.callMedia === 'audio') return true;
  const cid = String(p.callId ?? pendingCallId ?? '').trim();
  if (cid && getCallMediaHint(cid) === 'audio') return true;
  if (!p.directInitiator) return true;
  return cid ? getCallMediaHint(cid) !== 'video' : true;
}

export function resolveCallHasVideo(callId?: string | null): boolean {
  return getCallMediaHint(callId) !== 'audio';
}

export function videoCallNavExtras(
  callId?: string | null,
  explicitMedia?: DirectCallMediaHint,
): { callMedia?: DirectCallMediaHint; startWithCamOff?: boolean; preferVideoCallUi?: boolean } {
  const id = String(callId || '').trim();
  const media = explicitMedia ?? (id ? callMediaByCallId[id] : undefined) ?? 'audio';
  if (media === 'video') return {};
  return { callMedia: 'audio', startWithCamOff: true, preferVideoCallUi: false };
}
