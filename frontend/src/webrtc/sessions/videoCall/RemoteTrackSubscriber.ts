/**
 * Подписка на медиа партнёра после connect.
 *
 * LiveKit не гарантирует, что TrackSubscribed придёт вовремя (или придёт вообще): трек
 * может подъехать асинхронно уже после setSubscribed. Поэтому мы подписываемся явно,
 * перепроверяем через 100 мс и делаем два страховочных прохода — на 500 и 1000 мс.
 *
 * Вынесено из VideoCallSession: раньше эта логика жила внутри executeConnectToLiveKit
 * шестью почти одинаковыми копиями (audio/video × три прохода). Здесь она одна,
 * параметризована видом трека и номером прохода, и зависит от сессии только через host.
 */

import type { RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room } from 'livekit-client';
import { logger } from '../../../../utils/logger';

/** Перепроверка трека, который не успел загрузиться к моменту подписки. */
const TRACK_LOAD_RECHECK_MS = 100;

export type DelayedPass = 'First' | 'Second';

export type RemoteTrackSubscriberHost = {
  /** false → комната сменилась, применять трек уже некуда. */
  isCurrentRoom: (room: Room) => boolean;
  /** Audio-only режим: видео партнёра сейчас не потребляем. */
  shouldDeferVideo: (publication: RemoteTrackPublication, context: string) => boolean;
  /** Трек уже подключён к UI первым проходом — второй раз не применяем. */
  shouldSkipRedundantDelayedApply: (track: RemoteTrack, publication: RemoteTrackPublication) => boolean;
  /** Подключить трек к сессии (тот же путь, что и событие TrackSubscribed). */
  applyTrack: (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => void;
};

export class RemoteTrackSubscriber {
  constructor(private readonly host: RemoteTrackSubscriberHost) {}

  /** Все треки участника: аудио всегда, видео — только если не в audio-only defer. */
  subscribeToParticipant(participant: RemoteParticipant, room: Room, context: string): void {
    logger.info(`[VideoCallSession] ${context} - subscribing to participant tracks`, {
      participantId: participant.identity,
      audioTracks: participant.audioTrackPublications.size,
      videoTracks: participant.videoTrackPublications.size,
    });

    participant.audioTrackPublications.forEach((publication) => {
      this.subscribeNow(publication, participant, room, context, 'audio');
    });
    participant.videoTrackPublications.forEach((publication) => {
      if (this.host.shouldDeferVideo(publication, context)) return;
      this.subscribeNow(publication, participant, room, context, 'video');
    });
  }

  /** Одна публикация сразу после connect. */
  private subscribeNow(
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
    room: Room,
    context: string,
    kind: 'audio' | 'video',
  ): void {
    // КРИТИЧНО: подписываемся явно даже если публикация уже помечена subscribed —
    // это гарантирует доставку события TrackSubscribed.
    const wasSubscribed = publication.isSubscribed;
    const hadTrack = !!publication.track;

    if (!publication.isSubscribed || !publication.track) {
      publication.setSubscribed(true);
      logger.info(`[VideoCallSession] ${context} - subscribed to ${kind} track`, {
        trackSid: publication.trackSid,
        wasSubscribed,
        hasTrack: hadTrack,
        isSubscribedAfter: publication.isSubscribed,
      });
    } else {
      logger.info(`[VideoCallSession] ${context} - ${kind} track already subscribed and loaded`, {
        trackSid: publication.trackSid,
      });
    }

    // Трек уже есть — применяем сразу. Важно при принятии звонка: инициатор
    // подключился и опубликовал треки раньше нас.
    if (publication.track) {
      logger.info(`[VideoCallSession] ${context} - processing existing ${kind} track immediately`, {
        trackSid: publication.trackSid,
        isSubscribed: publication.isSubscribed,
        trackReady: publication.track.mediaStreamTrack?.readyState,
      });
      this.host.applyTrack(publication.track, publication, participant);
      return;
    }

    // Трека ещё нет: перепроверяем — он может подъехать сразу после setSubscribed.
    setTimeout(() => {
      if (publication.track && this.host.isCurrentRoom(room) && room.state === 'connected') {
        logger.info(`[VideoCallSession] ${context} - ${kind} track loaded after subscription`, {
          trackSid: publication.trackSid,
        });
        this.host.applyTrack(publication.track, publication, participant);
      } else {
        logger.debug(`[VideoCallSession] ${context} - ${kind} track still not loaded after subscription`, {
          trackSid: publication.trackSid,
          isSubscribed: publication.isSubscribed,
          hasTrack: !!publication.track,
        });
      }
    }, TRACK_LOAD_RECHECK_MS);

    logger.debug(
      `[VideoCallSession] ${context} - ${kind} track not loaded yet, waiting for TrackSubscribed event or delayed check`,
      {
        trackSid: publication.trackSid,
        isSubscribed: publication.isSubscribed,
      },
    );
  }

  /**
   * Страховочный проход по публикациям партнёра через delayMs после connect.
   * shouldWarnAboutMissingTrack решает, шуметь ли warn'ом: в первые секунды
   * отсутствие треков — норма.
   */
  scheduleDelayedCheck(
    room: Room,
    pass: DelayedPass,
    delayMs: number,
    shouldWarnAboutMissingTrack: () => boolean,
  ): void {
    setTimeout(() => {
      if (!this.host.isCurrentRoom(room) || room.state !== 'connected') return;
      logger.info(`[VideoCallSession] ${pass} delayed check for tracks (${delayMs}ms)`, {
        participantsCount: room.remoteParticipants.size,
      });
      room.remoteParticipants.forEach((participant) => {
        participant.audioTrackPublications.forEach((publication) => {
          this.applyDelayed(publication, participant, room, pass, 'audio', shouldWarnAboutMissingTrack);
        });
        participant.videoTrackPublications.forEach((publication) => {
          if (this.host.shouldDeferVideo(publication, `delayed_check_${delayMs}ms`)) return;
          this.applyDelayed(publication, participant, room, pass, 'video', shouldWarnAboutMissingTrack);
        });
      });
    }, delayMs);
  }

  private applyDelayed(
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
    room: Room,
    pass: DelayedPass,
    kind: 'audio' | 'video',
    shouldWarnAboutMissingTrack: () => boolean,
  ): void {
    if (!publication.isSubscribed) {
      publication.setSubscribed(true);
      logger.info(`[VideoCallSession] ${pass} delayed subscription to ${kind} track`, {
        trackSid: publication.trackSid,
      });
    }
    if (publication.track) {
      if (this.host.shouldSkipRedundantDelayedApply(publication.track, publication)) {
        logger.debug(`[VideoCallSession] ${pass} delayed check skipped (${kind} already wired)`, {
          trackSid: publication.trackSid,
        });
      } else {
        logger.info(`[VideoCallSession] ${pass} delayed processing of ${kind} track`, {
          trackSid: publication.trackSid,
        });
        this.host.applyTrack(publication.track, publication, participant);
      }
      return;
    }
    const log = shouldWarnAboutMissingTrack() ? logger.warn : logger.debug;
    log(`[VideoCallSession] ${pass} delayed check - ${kind} track still not loaded`, {
      trackSid: publication.trackSid,
      isSubscribed: publication.isSubscribed,
      roomState: room.state,
    });
  }
}
