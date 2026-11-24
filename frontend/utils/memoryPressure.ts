import { DeviceEventEmitter } from 'react-native';
import { useSyncExternalStore } from 'react';

let revision = 0;
let installed = false;
const listeners = new Set<() => void>();
export const getMemoryPressureRevision = () => revision;
export function subscribeMemoryPressure(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyMemoryPressure(): void {
  revision++;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* One cache must not prevent other owners releasing RAM. */ }
  }
}
export function installMemoryPressure(): void {
  if (installed) return;
  installed = true;
  DeviceEventEmitter.addListener('LiviMemoryPressure', notifyMemoryPressure);
}
export function useMemoryPressureRevision(): number {
  return useSyncExternalStore(subscribeMemoryPressure, getMemoryPressureRevision, getMemoryPressureRevision);
}
