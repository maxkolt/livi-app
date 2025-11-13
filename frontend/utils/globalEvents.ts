// Простой глобальный эмиттер событий без зависимостей
// Используем для мгновенного обновления счетчиков пропущенных звонков на HomeScreen

type Listener<T> = (payload: T) => void;

const missedListeners = new Set<Listener<{ userId: string }>>();
const closeIncomingListeners = new Set<Listener<{}>>();
const closeIncomingRequestListeners = new Set<Listener<{}>>();

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


