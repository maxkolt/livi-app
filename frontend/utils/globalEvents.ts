// Простой глобальный эмиттер событий без зависимостей
// Используем для мгновенного обновления счетчиков пропущенных звонков на HomeScreen

type Listener<T> = (payload: T) => void;

const missedListeners = new Set<Listener<{ userId: string }>>();
const missedClearListeners = new Set<Listener<{ userId: string }>>();
const closeIncomingListeners = new Set<Listener<{}>>();
const closeIncomingRequestListeners = new Set<Listener<{}>>();
const closeOutgoingCallListeners = new Set<Listener<{}>>();

export function onMissedIncrement(cb: Listener<{ userId: string }>): () => void {
  missedListeners.add(cb);
  return () => {
    missedListeners.delete(cb);
  };
}

export function emitMissedIncrement(userId: string) {
  for (const l of missedListeners) {
    try { l({ userId }); } catch {}
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

/** Закрыть модалку исходящего вызова (когда абонент отклонил/отменил/таймаут вне приложения). */
export function onCloseOutgoingCall(cb: () => void): () => void {
  const h = () => cb();
  closeOutgoingCallListeners.add(h as any);
  return () => { closeOutgoingCallListeners.delete(h as any); };
}

export function emitCloseOutgoingCall() {
  for (const l of closeOutgoingCallListeners) {
    try { (l as any)({}); } catch {}
  }
}


