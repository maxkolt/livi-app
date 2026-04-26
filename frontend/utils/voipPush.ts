import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

const moduleName = 'LiviVoipPushManager';
const nativeModule = Platform.OS === 'ios' ? (NativeModules as Record<string, any>)[moduleName] : null;
const emitter = nativeModule ? new NativeEventEmitter(nativeModule) : null;

export async function getVoipPushToken(): Promise<string | undefined> {
  if (Platform.OS !== 'ios' || !nativeModule?.getVoipPushToken) return undefined;
  try {
    const token = await nativeModule.getVoipPushToken();
    return typeof token === 'string' && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function addVoipTokenListener(listener: (token: string) => void): () => void {
  if (!emitter) return () => {};
  const sub = emitter.addListener('voipTokenUpdated', (event: { token?: string } | null) => {
    const token = typeof event?.token === 'string' ? event.token.trim() : '';
    if (token) listener(token);
  });
  return () => {
    try {
      sub.remove();
    } catch {}
  };
}
