// Утилиты для работы со стримами WebRTC
import { MediaStream } from '@livekit/react-native-webrtc';

export const isValidStream = (stream?: MediaStream | null): boolean => {
  if (!stream) return false;
  
  try {
    // КРИТИЧНО: На Android проверяем, что стрим не disposed перед использованием
    // Нативный код может выбросить IllegalStateException если стрим уже disposed
    try {
      const streamId = stream.id;
      if (!streamId) return false;
    } catch (streamError: any) {
      // Если стрим уже disposed, нативный код выбросит ошибку
      if (streamError?.message?.includes('disposed') || streamError?.message?.includes('MediaStream')) {
        return false;
      }
      // Пробрасываем другие ошибки
      throw streamError;
    }
    
    // Проверяем базовые свойства стрима
    return typeof (stream as any).toURL === 'function' && (stream as any).getTracks?.().length > 0;
  } catch {
    return false;
  }
};

export const stopStreamTracks = (stream: MediaStream | null | undefined): void => {
  if (!stream) return;
  try {
    const tracks = stream.getTracks?.() || [];
    tracks.forEach((t: any) => {
      try {
        // Проверяем, что трек еще не был disposed перед остановкой
        // Это предотвращает ошибку "MediaStreamTrack has been disposed" на Android
        if (t && t.readyState !== 'ended' && t.readyState !== null) {
          t.enabled = false;
          t.stop();
          // release вызываем только если трек еще активен
          try {
            (t as any).release?.();
          } catch {}
        }
      } catch {}
    });
  } catch {}
};

export const cleanupStream = async (stream: MediaStream | null | undefined): Promise<void> => {
  if (!stream) return;
  stopStreamTracks(stream);
  // Проверяем, что стрим еще не был disposed перед вызовом release
  // На Android release может вызвать ошибку если треки уже были disposed
  try {
    const tracks = stream.getTracks?.() || [];
    const allTracksDisposed = tracks.length === 0 || tracks.every((t: any) => 
      !t || t.readyState === 'ended' || t.readyState === null
    );
    // Вызываем release только если не все треки уже disposed
    if (!allTracksDisposed) {
      (stream as any).release?.();
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
};






