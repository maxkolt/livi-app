import { shared } from "./shared";
import { socket } from "./socketCore";

export function __flushPendingRtcSignals() {
  if (!socket.connected) return;
  if (!shared.pendingRtcSignals.length) return;
  const pending = shared.pendingRtcSignals.splice(0, shared.pendingRtcSignals.length);
  for (const item of pending) {
    try {
      socket.emit(item.event, item.payload);
    } catch {
      shared.pendingRtcSignals.unshift(item);
    }
  }
}

export function socketBufferIceCandidate(from: string, candidate: any) {
  const key = String(from || "");
  if (!key || !candidate) return;
  if (!shared.candidateBuffer[key]) shared.candidateBuffer[key] = [];
  shared.candidateBuffer[key].push(candidate);
  try {} catch {}
}

export function socketFlushBufferedIceCandidates(from: string): any[] {
  const key = String(from || "");
  if (!key) return [];
  const list = shared.candidateBuffer[key] || [];
  delete shared.candidateBuffer[key];
  try {
    list.length;
  } catch {}
  return list;
}

export function sendOffer(to: string, offer: any) {
  const payload = { to, offer };
  if (!socket.connected || shared.reconnecting) {
    shared.pendingRtcSignals.push({ event: "offer", to, payload });
    return;
  }
  socket.emit("offer", payload);
}

export function sendAnswer(to: string, answer: any) {
  const payload = { to, answer };
  if (!socket.connected || shared.reconnecting) {
    shared.pendingRtcSignals.push({ event: "answer", to, payload });
    return;
  }
  socket.emit("answer", payload);
}

export function sendCandidate(to: string, candidate: any) {
  const payload = { to, candidate };
  if (!socket.connected || shared.reconnecting) {
    shared.pendingRtcSignals.push({ event: "ice-candidate", to, payload });
    return;
  }
  socket.emit("ice-candidate", payload);
}

export function onRtcOffer(
  cb: (d: { from: string; offer: any }) => void,
): () => void {
  socket.on("offer", cb as any);
  return () => socket.off("offer", cb as any);
}

export function onRtcAnswer(
  cb: (d: { from: string; answer: any }) => void,
): () => void {
  socket.on("answer", cb as any);
  return () => socket.off("answer", cb as any);
}

export function onRtcCandidate(
  cb: (d: { from: string; candidate: any }) => void,
): () => void {
  socket.on("ice-candidate", cb as any);
  return () => socket.off("ice-candidate", cb as any);
}
