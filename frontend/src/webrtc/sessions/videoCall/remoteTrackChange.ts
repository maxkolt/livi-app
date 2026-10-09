/**
 * Что именно поменялось, когда приехал удалённый трек.
 *
 * От этого зависит единственное дорогое решение в handleTrackSubscribed: пересобирать
 * ли MediaStream. Пересборка нужна, потому что переиспользование того же stream.id с
 * мёртвым треком внутри ломает воспроизведение: после переворота камеры пропадает
 * картинка, после возврата партнёра из самолётного режима — звук. Но пересобирать
 * на каждое событие нельзя — RTCView мигает.
 *
 * Логика чистая: на вход — sid'ы и ссылки на MediaStreamTrack, на выход — флаги.
 */

export type RemoteTrackChangeInput = {
  isVideoTrack: boolean;
  isAudioTrack: boolean;
  /** sid приехавшего трека. */
  newTrackSid?: string;
  /**
   * sid предыдущего видео: текущий remoteVideoTrack, либо запомненный при
   * TrackUnsubscribed — при перевороте камеры отписка приходит раньше подписки,
   * и без запомненного sid смена трека выглядела бы как «ничего не изменилось».
   */
  previousVideoSid?: string | null;
  previousAudioSid?: string | null;
  /** MediaStreamTrack приехавшего трека. */
  incomingMediaTrack?: unknown;
  /** Аудио-дорожки, которые уже лежат в текущем remoteStream. */
  existingAudioMediaTracks?: readonly unknown[];
  /** Видео-дорожки, которые уже лежат в текущем remoteStream. */
  existingVideoMediaTracks?: readonly unknown[];
};

export type RemoteTrackChange = {
  isVideoTrack: boolean;
  isAudioTrack: boolean;
  previousVideoSid?: string | null;
  previousAudioSid?: string | null;
  wasVideoTrackChanged: boolean;
  wasAudioTrackChanged: boolean;
  /** В стриме лежит чужая аудио-дорожка — она уже мертва и глушит звук. */
  staleAudioInStream: boolean;
  /**
   * Тот же sid видео, но другой MediaStreamTrack: мы перезашли в комнату (новый
   * PeerConnection), а партнёр свою публикацию не менял.
   */
  videoResubscribed: boolean;
  /** Нужен новый MediaStream (иначе UI не переподхватит дорожку). */
  needsFreshStream: boolean;
  /** Причина пересборки для логов. */
  freshStreamReason: 'audio_replace' | 'video_replace' | 'video_resubscribe';
};

export function describeRemoteTrackChange(input: RemoteTrackChangeInput): RemoteTrackChange {
  const { isVideoTrack, isAudioTrack, newTrackSid, previousVideoSid, previousAudioSid } = input;

  const wasVideoTrackChanged = isVideoTrack && !!previousVideoSid && previousVideoSid !== newTrackSid;
  const wasAudioTrackChanged = isAudioTrack && !!previousAudioSid && previousAudioSid !== newTrackSid;

  const incoming = input.incomingMediaTrack;
  const staleAudioInStream =
    isAudioTrack &&
    !!incoming &&
    (input.existingAudioMediaTracks ?? []).some((t) => !!t && t !== incoming);
  // После смены сети (VPN off) sid у партнёра прежний, а дорожка новая. Дописать её в
  // старый stream мало: экран держит этот stream с момента возврата из PiP и не
  // перерисовывается — собеседник остаётся чёрным.
  const videoResubscribed =
    isVideoTrack &&
    !!previousVideoSid &&
    previousVideoSid === newTrackSid &&
    !!incoming &&
    !(input.existingVideoMediaTracks ?? []).includes(incoming);

  return {
    isVideoTrack,
    isAudioTrack,
    previousVideoSid,
    previousAudioSid,
    wasVideoTrackChanged,
    wasAudioTrackChanged,
    staleAudioInStream,
    videoResubscribed,
    needsFreshStream:
      (isVideoTrack && (wasVideoTrackChanged || videoResubscribed)) || wasAudioTrackChanged || staleAudioInStream,
    freshStreamReason: wasAudioTrackChanged || staleAudioInStream
      ? 'audio_replace'
      : videoResubscribed
        ? 'video_resubscribe'
        : 'video_replace',
  };
}
