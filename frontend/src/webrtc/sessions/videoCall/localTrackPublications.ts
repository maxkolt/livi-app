/**
 * Чтение публикаций локального участника и безопасная остановка локальных треков.
 *
 * Вынесено из VideoCallSession: это функции от (room, track), а не от состояния сессии,
 * поэтому им место рядом друг с другом и под юнит-тестами. Формы `videoTrackPublications`
 * у разных версий SDK отличаются (Map / массив / объект) — терпим все три, как и раньше.
 */

import type { LocalAudioTrack, LocalTrack, LocalVideoTrack, Room } from 'livekit-client';
import { logger } from '../../../../utils/logger';

type PublicationLike = { track?: unknown; trackSid?: string };

/** Публикация локального видео для replaceTrack-флоу (первая камера). */
export type LocalVideoPublicationLike = {
  replaceTrack?: (track: LocalVideoTrack, stopProcessor?: boolean) => Promise<void>;
  track?: LocalVideoTrack;
};

function isTrackPublishedIn(publications: unknown, track: LocalTrack): boolean {
  if (!publications) return false;
  const matches = (pub: PublicationLike) => pub.track === track || pub.trackSid === track.sid;
  if (typeof (publications as { values?: unknown }).values === 'function') {
    // Это Map - проверяем через values()
    for (const pub of (publications as Map<string, PublicationLike>).values()) {
      if (matches(pub)) return true;
    }
  } else if (Array.isArray(publications)) {
    // Это массив - используем find
    return (publications as PublicationLike[]).some(matches);
  }
  return false;
}

/** Опубликован ли видео-трек в комнате. */
export function isVideoTrackPublished(room: Room | null, track: LocalVideoTrack | null): boolean {
  if (!room || !track || !room.localParticipant) return false;
  try {
    return isTrackPublishedIn(room.localParticipant.videoTrackPublications, track);
  } catch (e) {
    logger.debug('[VideoCallSession] Error checking video track publication', e);
    return false;
  }
}

/** Опубликован ли аудио-трек в комнате. */
export function isAudioTrackPublished(room: Room | null, track: LocalAudioTrack | null): boolean {
  if (!room || !track || !room.localParticipant) return false;
  try {
    return isTrackPublishedIn(room.localParticipant.audioTrackPublications, track);
  } catch (e) {
    logger.debug('[VideoCallSession] Error checking audio track publication', e);
    return false;
  }
}

/**
 * Текущая публикация локального видео (первая камера) для replaceTrack-флоу.
 * Та же логика, что в RandomChatSession.getLocalVideoPublication.
 */
export function getLocalVideoPublication(room: Room | null): LocalVideoPublicationLike | null {
  if (!room || !room.localParticipant) return null;
  const publications = room.localParticipant.videoTrackPublications as unknown;
  if (!publications) return null;
  try {
    if (typeof (publications as { values?: unknown }).values === 'function') {
      for (const pub of (publications as Map<string, LocalVideoPublicationLike>).values()) {
        return pub || null;
      }
    } else if (Array.isArray(publications)) {
      return (publications as LocalVideoPublicationLike[])[0] || null;
    } else if (typeof publications === 'object') {
      const vals = Object.values(publications as Record<string, LocalVideoPublicationLike>);
      return vals?.[0] || null;
    }
  } catch {}
  return null;
}

/**
 * КРИТИЧНО: Сначала отключаем захват кадров, затем stop() — снижает
 * CameraDeviceClient errorCode 4/5 на Android.
 */
export function stopLocalVideoTrackSafely(track: LocalVideoTrack | null): void {
  if (!track) return;
  try {
    if (track.mediaStreamTrack) {
      track.mediaStreamTrack.enabled = false;
    }
    track.mute().catch(() => {});
  } catch {}
  try {
    track.stop();
  } catch {}
}

export function stopLocalAudioTrackSafely(track: LocalAudioTrack | null): void {
  if (!track) return;
  try {
    track.stop();
  } catch {}
}
