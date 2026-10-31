/**
 * Жёсткая остановка треков локального превью.
 *
 * ВАЖНО, чем это отличается от `utils/streamUtils.stopStreamTracks`: тот вариант проще —
 * обходит `getTracks()` и останавливает. Здесь намеренно два отличия, и оба выстраданы
 * на устройствах:
 *
 *  1. Треки собираются ещё и из `getVideoTracks()` / `getAudioTracks()`: на части
 *     Android-сборок `getTracks()` возвращает не весь набор, и недобитый трек держит
 *     камеру занятой — следующий звонок стартует с чёрным превью.
 *  2. Повторная остановка через 100 мс: первый `stop()` не всегда доходит до нативного
 *     слоя, если он пришёл в момент смены сессии.
 *
 * Поэтому объединять эти две функции нельзя — они решают разные задачи.
 */

import type { MediaStream, MediaStreamTrack } from '@livekit/react-native-webrtc';
import { logger } from '../../../utils/logger';

export const stopStreamTracks = (stream: MediaStream | null | undefined, context: string) => {
  if (!stream) {
    return;
  }

  try {
    const baseTracks = stream.getTracks?.() || [];
    const videoTracks = (stream)?.getVideoTracks?.() || [];
    const audioTracks = (stream)?.getAudioTracks?.() || [];

    const allTracks: MediaStreamTrack[] = [...baseTracks];
    const appendUnique = (tracks: MediaStreamTrack[]) => {
      tracks.forEach((track) => {
        if (track && !allTracks.includes(track)) {
          allTracks.push(track);
        }
      });
    };

    appendUnique(videoTracks);
    appendUnique(audioTracks);

    const uniqueTracks = Array.from(new Set(allTracks));

    uniqueTracks.forEach((track) => {
      try {
        if (track && track.readyState !== 'ended' && track.readyState !== null) {
          track.enabled = false;
          track.stop();


          setTimeout(() => {
            try {
              if (track && track.readyState !== 'ended' && track.readyState !== null) {
                track.enabled = false;
                track.stop();
              }
            } catch (err) {
              logger.warn('[VideoCall] Error in delayed track stop', { context, err });
            }
          }, 100);
        }
      } catch (err) {
        logger.warn('[VideoCall] Error stopping track', { context, err });
      }
    });
  } catch (err) {
    logger.warn('[VideoCall] Error stopping stream', { context, err });
  }
};
