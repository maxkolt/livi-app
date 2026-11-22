type Listener = (callId: string) => void;
const listeners = new Set<Listener>();
const laidOutCalls = new Set<string>();

/** Keep the native layout acknowledgement even if the answer cover subscribes later. */
export function notifyIncomingAnswerUiReady(callId: string | null | undefined): void {
  const id = String(callId || '').trim();
  if (!id) return;
  laidOutCalls.add(id);
  if (laidOutCalls.size > 32) laidOutCalls.delete(laidOutCalls.values().next().value!);
  for (const listener of listeners) listener(id);
}

export function isIncomingAnswerUiReady(callId: string | null | undefined): boolean {
  return !!callId && laidOutCalls.has(callId.trim());
}

export function subscribeIncomingAnswerUiReady(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
