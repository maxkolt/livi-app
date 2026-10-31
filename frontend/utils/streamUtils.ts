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
    } catch (streamError: unknown) {
      // Если стрим уже disposed, нативный код выбросит ошибку
      if ((streamError as Error | null | undefined)?.message?.includes('disposed') || (streamError as Error | null | undefined)?.message?.includes('MediaStream')) {
        return false;
      }
      // Пробрасываем другие ошибки
      throw streamError;
    }
    
    // Проверяем базовые свойства стрима
    return typeof (stream).toURL === 'function' && (stream).getTracks?.().length > 0;
  } catch {
    return false;
  }
};

export const stopStreamTracks = (stream: MediaStream | null | undefined): void => {
  if (!stream) return;
  try {
    const tracks = stream.getTracks?.() || [];
    tracks.forEach((t) => {
      try {
        // Проверяем, что трек еще не был disposed перед остановкой
        // Это предотвращает ошибку "MediaStreamTrack has been disposed" на Android
        if (t && t.readyState !== 'ended' && t.readyState !== null) {
          t.enabled = false;
          t.stop();
          // release вызываем только если трек еще активен
          try {
            (t).release?.();
          } catch {}
        }
      } catch {}
    });
  } catch {}
};






