import { NativeModules, Platform } from 'react-native';

export type IncomingShareItem = {
  kind: 'text' | 'image' | 'audio' | 'document';
  uri?: string;
  text?: string;
  mimeType?: string;
  name?: string;
  size?: number;
};

type IncomingShareListener = (items: IncomingShareItem[]) => void;
const listeners = new Set<IncomingShareListener>();

export function subscribeIncomingShare(listener: IncomingShareListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyIncomingShare(items: IncomingShareItem[]): void {
  if (!items?.length) return;
  for (const listener of listeners) {
    try {
      listener(items);
    } catch {
      // ignore subscriber errors
    }
  }
}

function parseNativeShareItems(raw: unknown): IncomingShareItem[] {
  if (!Array.isArray(raw)) return [];
  const out: IncomingShareItem[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const kind = String((row as { kind?: string }).kind || '').trim();
    if (kind !== 'text' && kind !== 'image' && kind !== 'audio' && kind !== 'document') continue;
    const item: IncomingShareItem = { kind };
    const uri = (row as { uri?: string }).uri;
    if (uri) item.uri = String(uri);
    const text = (row as { text?: string }).text;
    if (text) item.text = String(text);
    const mimeType = (row as { mimeType?: string }).mimeType;
    if (mimeType) item.mimeType = String(mimeType);
    const name = (row as { name?: string }).name;
    if (name) item.name = String(name);
    const size = (row as { size?: number }).size;
    if (typeof size === 'number' && size > 0) item.size = size;
    out.push(item);
  }
  return out;
}

export async function pullPendingShareFromNative(): Promise<IncomingShareItem[]> {
  if (Platform.OS !== 'android') return [];
  try {
    const mod = NativeModules.LiviAppModule;
    const raw = await mod?.getAndClearPendingShareItems?.();
    return parseNativeShareItems(raw);
  } catch {
    return [];
  }
}
