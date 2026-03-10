import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { RTCView, MediaStream } from '@livekit/react-native-webrtc';
import { MaterialIcons } from '@expo/vector-icons';
import AwayPlaceholder from '../../../components/AwayPlaceholder';
import { t, type Lang } from '../../../utils/i18n';
import { logger } from '../../../utils/logger';

interface RemoteVideoProps {
  remoteStream: MediaStream | null;
  remoteCamOn: boolean;
  remoteMuted: boolean;
  isInactiveState: boolean;
  wasFriendCallEnded: boolean;
  started: boolean;
  loading: boolean;
  remoteViewKey: number;
  showFriendBadge: boolean;
  lang: Lang;
  session?: any; // VideoCallSession
  onStreamReady?: (stream: MediaStream) => void;
  remoteStreamReceivedAt?: number | null; // Время получения remoteStream для предотвращения мерцания
  partnerInPiP?: boolean; // Партнер в режиме PiP
  forceTextureView?: boolean; // Принудительно использовать TextureView (например, для системного PiP)
  /** 'contain' — собеседник целиком в кадре (системный PiP); 'cover' — заполнение с обрезкой (по умолчанию). */
  objectFit?: 'contain' | 'cover';
}

/**
 * Упрощенный компонент отображения удаленного видео.
 * Доверяем контролю стрима/камеры сессии, не дублируем force-update циклы.
 */
export const RemoteVideo: React.FC<RemoteVideoProps> = ({
  remoteStream,
  remoteCamOn,
  remoteMuted,
  isInactiveState,
  wasFriendCallEnded,
  started,
  loading,
  remoteViewKey,
  showFriendBadge,
  lang,
  session,
  onStreamReady,
  remoteStreamReceivedAt,
  partnerInPiP = false,
  forceTextureView = false,
  objectFit: objectFitProp = 'cover',
}) => {
  const L = (key: string) => t(key, lang);
  // На Android 8.1 и старше (API <= 27) SurfaceView overlay/z-order часто ломает отображение (особенно на OPPO/ColorOS).
  // Для таких устройств отключаем zOrderMediaOverlay, чтобы Surface корректно композировался в окне.
  const isLegacyAndroidSurface = Platform.OS === 'android' && Number(Platform.Version) <= 27;
  // На старых Android используем TextureView, чтобы RN-оверлеи (кнопки) гарантированно рисовались поверх видео.
  // Также принудительно включаем TextureView для системного PiP, чтобы не оставались чёрные Surface-слои поверх лаунчера.
  const useTextureViewOnAndroid = Platform.OS === 'android' && (isLegacyAndroidSurface || forceTextureView);
  const logRenderState = useCallback(
    (reason: string, extra?: Record<string, unknown>) => {
      // Noisy render-state logs should be DEBUG-level (hidden by default LOG_LEVEL=info).
      logger.debug('[RemoteVideo] Render state', { reason, ...extra });
    },
    []
  );

  // Anti-infinite-spinner during renegotiation/re-subscribe:
  // after a short stall, prefer holding the last good frame; after a longer stall, show text.
  const lastGoodStreamRef = useRef<MediaStream | null>(null);
  const lastGoodAtRef = useRef<number>(0);
  const stallSinceRef = useRef<number | null>(null);
  const REMOTE_VIDEO_STALL_HOLD_MS = 900;
  const REMOTE_VIDEO_STALL_TEXT_MS = 6000;
  const REMOTE_VIDEO_LAST_GOOD_MAX_AGE_MS = 30000;

  // IMPORTANT: must be declared before any early returns (hooks order).
  const prevPartnerInPiPRef = useRef<boolean>(partnerInPiP);
  useEffect(() => {
    prevPartnerInPiPRef.current = partnerInPiP;
  }, [partnerInPiP]);

  // При смене remote stream (например переворот камеры) старый stream уже без видео-трека.
  // Не показывать его как "last good frame" — иначе RTCView даёт чёрный экран.
  useEffect(() => {
    lastGoodStreamRef.current = null;
  }, [remoteStream?.id]);

  const renderLastGoodFrame = useCallback(
    (reason: string, extra?: Record<string, unknown>) => {
      const s = lastGoodStreamRef.current;
      if (!s) return null;
      const now = Date.now();
      const ageMs = now - lastGoodAtRef.current;
      if (Platform.OS !== 'android') return null;
      if (ageMs > REMOTE_VIDEO_LAST_GOOD_MAX_AGE_MS) return null;

      const streamURL = s.toURL?.();
      // Keep RTCView mounted; do not remount on remoteViewKey churn.
      const rtcViewKey = `remote-lastgood-${s.id}`;
      const rtcViewProps =
        Platform.OS === 'android'
          ? {
              stream: s,
              streamURL,
              renderToHardwareTextureAndroid: !isLegacyAndroidSurface,
              zOrderMediaOverlay: false,
              useTextureView: useTextureViewOnAndroid,
            }
          : { streamURL: streamURL! };

      logRenderState(reason, {
        streamId: s.id,
        ageMs,
        ...extra,
      });

      return (
        <RTCView
          key={rtcViewKey}
          {...(rtcViewProps as any)}
          style={styles.rtc}
          objectFit={objectFitProp}
          mirror={false}
          zOrder={0}
        />
      );
    },
    [
      isLegacyAndroidSurface,
      logRenderState,
      useTextureViewOnAndroid,
      objectFitProp,
    ]
  );

  const renderHeldRemoteFrame = useCallback(
    (reason: string, extra?: Record<string, unknown>) => {
      const held = renderLastGoodFrame(reason, extra);
      if (!held) return null;
      return (
        <View style={styles.videoContainer}>
          {held}
          {showFriendBadge && (
            <View style={styles.friendBadge}>
              <MaterialIcons name="check-circle" size={16} color="#0f0" />
              <Text style={styles.friendBadgeText}>{L('friend')}</Text>
            </View>
          )}
        </View>
      );
    },
    [L, renderLastGoodFrame, showFriendBadge]
  );

  // КРИТИЧНО: Логируем значение partnerInPiP при каждом рендере для отладки
  useEffect(() => {
    logger.debug('[RemoteVideo] partnerInPiP prop changed', { 
      partnerInPiP,
      hasStream: !!remoteStream,
      remoteCamOn,
      started,
      loading,
      willShowAwayPlaceholder: partnerInPiP === true
    });
  }, [partnerInPiP, remoteStream, remoteCamOn, started, loading]);
  
  // КРИТИЧНО: Логируем каждый рендер для отладки отображения заглушки
  useEffect(() => {
    if (partnerInPiP) {
      logger.debug('[RemoteVideo] partnerInPiP=true - away placeholder should be visible', {
        partnerInPiP,
        hasStream: !!remoteStream,
        streamId: remoteStream?.id,
        remoteCamOn,
        started,
        loading,
        isInactiveState,
        wasFriendCallEnded
      });
    }
  }, [partnerInPiP, remoteStream, remoteCamOn, started, loading, isInactiveState, wasFriendCallEnded]);

  // Берём актуальный стрим только из пропсов.
  // Fallback на session часто приводит к рендеру "старого" MediaStream после next/переподключений.
  const streamToUse = useMemo(() => {
    const stream = remoteStream || null;
    if (stream) {
      const videoTrack = (stream as any)?.getVideoTracks?.()?.[0];
      logger.debug('[RemoteVideo] streamToUse обновлен', {
        platform: Platform.OS,
        streamId: stream.id,
        hasVideoTrack: !!videoTrack,
        videoTrackReady: videoTrack?.readyState === 'live',
        videoTrackEnabled: videoTrack?.enabled,
        hasStreamURL: typeof stream.toURL === 'function'
      });
    }
    return stream;
  }, [remoteStream]);

  const shouldSuppressTransientRemoteUi =
    Platform.OS === 'android' &&
    !!(session && typeof session.shouldSuppressRemoteTransientUi === 'function' && session.shouldSuppressRemoteTransientUi());

  // Синхронно сбрасываем "последний кадр" при смене stream (переворот камеры), чтобы не рендерить старый stream без трека (чёрный экран).
  if (streamToUse?.id && lastGoodStreamRef.current && lastGoodStreamRef.current.id !== streamToUse.id) {
    lastGoodStreamRef.current = null;
  }
  // Когда партнер выключил камеру (cam-toggle) — не показывать застывший последний кадр, сбрасываем last good frame.
  if (started && !wasFriendCallEnded && !isInactiveState && !remoteCamOn && !shouldSuppressTransientRemoteUi) {
    lastGoodStreamRef.current = null;
    lastGoodAtRef.current = 0;
  }


  // Сообщаем о готовности стрима
  useEffect(() => {
    if (streamToUse && onStreamReady) {
      onStreamReady(streamToUse);
    }
  }, [streamToUse, onStreamReady]);

  // КРИТИЧНО: На Android нужен force-update для RTCView при изменении стрима
  const [forceUpdateKey, setForceUpdateKey] = useState(0);
  const lastForceUpdateAtRef = useRef<number>(0);
  const lastForceUpdateIdsRef = useRef<{ streamId: string | null; trackId: string | null }>({
    streamId: null,
    trackId: null,
  });
  const streamToUseVideoTrackId = streamToUse
    ? ((streamToUse as any)?.getVideoTracks?.()?.[0]?.id ?? null)
    : null;

  // После переворота камеры приходит новый stream. В RN readyState может не быть 'live' — ре-рендер по таймауту.
  // Сбрасываем tick только при смене stream (не при первом появлении), чтобы не держать лоадер дольше нужного.
  const [trackLiveTick, setTrackLiveTick] = useState(0);
  const prevStreamIdForTickRef = useRef<string | null>(null);
  useEffect(() => {
    if (!streamToUse) return;
    const videoTrack = (streamToUse as any)?.getVideoTracks?.()?.[0] || null;
    if (!videoTrack) return;

    const streamId = streamToUse.id;
    const isNewStream = prevStreamIdForTickRef.current != null && prevStreamIdForTickRef.current !== streamId;
    prevStreamIdForTickRef.current = streamId;
    if (isNewStream) setTrackLiveTick(0);

    const TRACK_READY_DELAY_MS = 150;
    const TRACK_LIVE_POLL_MS = 80;
    const TRACK_LIVE_POLL_MAX_MS = 3500;
    const startedAt = Date.now();

    const timeoutId = setTimeout(() => setTrackLiveTick((k) => k + 1), TRACK_READY_DELAY_MS);

    if (videoTrack.readyState === 'live') {
      return () => clearTimeout(timeoutId);
    }

    const t = setInterval(() => {
      if (Date.now() - startedAt > TRACK_LIVE_POLL_MAX_MS) {
        clearInterval(t);
        return;
      }
      const vt = (streamToUse as any)?.getVideoTracks?.()?.[0];
      if (vt && vt.readyState === 'live') {
        clearInterval(t);
        setTrackLiveTick((k) => k + 1);
      }
    }, TRACK_LIVE_POLL_MS);
    return () => {
      clearTimeout(timeoutId);
      clearInterval(t);
    };
  }, [streamToUse?.id, streamToUseVideoTrackId]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!streamToUse) return;

    const videoTrack = (streamToUse as any)?.getVideoTracks?.()?.[0] || null;
    if (!videoTrack) return;
    if (videoTrack.readyState !== 'live') return;

    const streamId = streamToUse.id;
    const trackId = videoTrack.id || null;
    const prev = lastForceUpdateIdsRef.current;
    const idsChanged = prev.streamId !== streamId || prev.trackId !== trackId;
    if (!idsChanged) return;

    // Prevent rapid RTCView remount bursts (main source of black flicker on Android).
    const now = Date.now();
    if (now - lastForceUpdateAtRef.current < 250) {
      // Still update refs so the next allowed bump applies to the latest ids.
      lastForceUpdateIdsRef.current = { streamId, trackId };
      return;
    }
    lastForceUpdateAtRef.current = now;
    lastForceUpdateIdsRef.current = { streamId, trackId };

    setForceUpdateKey((prevKey) => {
      const next = prevKey + 1;
      logger.debug('[RemoteVideo] Android: force-update RTCView', {
        streamId,
        trackId,
        trackEnabled: videoTrack.enabled,
        key: next,
      });
      return next;
    });
  }, [streamToUse?.id, streamToUseVideoTrackId]);

  // Управление аудио треками под mute/unmute
  useEffect(() => {
    if (!streamToUse) return;
    const audioTracks = (streamToUse as any)?.getAudioTracks?.() || [];
    audioTracks.forEach((track: any, index: number) => {
      if (!track) return;
      if (!remoteMuted && !track.enabled) {
        track.enabled = true;
        logger.debug('[RemoteVideo] Enable remote audio track', { trackId: track.id, index, streamId: streamToUse.id });
      } else if (remoteMuted && track.enabled) {
        track.enabled = false;
        logger.debug('[RemoteVideo] Disable remote audio track (muted)', { trackId: track.id, index, streamId: streamToUse.id });
      }
    });
  }, [streamToUse, remoteMuted]);

  // Неактивное состояние звонка - показываем надпись "Собеседник" как в эталонном файле
  // КРИТИЧНО: Завершение звонка имеет приоритет над заглушкой "Отошел".
  if (wasFriendCallEnded || isInactiveState) {
    logRenderState('inactive-call', { remoteCamOn, wasFriendCallEnded, started });
    return (
      <View style={[styles.rtc, styles.placeholderContainer]}>
        <Text style={styles.placeholder}>{L('peer')}</Text>
      </View>
    );
  }

  // КРИТИЧНО: Если партнер в PiP и камера выключена — показываем заглушку "Отошел".
  // Если партнер в PiP, но камера включена — видеопоток продолжает идти (показываем видео ниже).
  if (partnerInPiP && !remoteCamOn) {
    logger.debug('[RemoteVideo] Show away placeholder (partnerInPiP=true, camera off)', {
      partnerInPiP,
      remoteCamOn,
      streamId: streamToUse?.id,
      hasStream: !!streamToUse,
      started,
      loading,
      isInactiveState,
      wasFriendCallEnded
    });
    logRenderState('partner-in-pip-away', {
      streamId: streamToUse?.id,
      partnerInPiP: true,
      remoteCamOn: false,
      hasStream: !!streamToUse,
    });
    return (
      <View style={styles.videoContainer}>
        <AwayPlaceholder />
        {showFriendBadge && (
          <View style={styles.friendBadge}>
            <MaterialIcons name="check-circle" size={16} color="#0f0" />
            <Text style={styles.friendBadgeText}>{L('friend')}</Text>
          </View>
        )}
      </View>
    );
  }

  // Звонок активен, партнер выключил камеру кнопкой в блоке «Вы» — у собеседника в блоке «Собеседник» показываем заглушку «Отошел».
  if (started && !isInactiveState && !wasFriendCallEnded && !remoteCamOn) {
    if (shouldSuppressTransientRemoteUi) {
      const held = renderHeldRemoteFrame('suppress-remote-cam-off-during-local-flip', {
        streamId: streamToUse?.id,
        remoteCamOn,
      });
      if (held) return held;
    }
    logRenderState('remote-cam-off-active-call', { remoteCamOn, started, streamId: streamToUse?.id });
    return (
      <View style={styles.videoContainer}>
        <AwayPlaceholder />
        {showFriendBadge && (
          <View style={styles.friendBadge}>
            <MaterialIcons name="check-circle" size={16} color="#0f0" />
            <Text style={styles.friendBadgeText}>{L('friend')}</Text>
          </View>
        )}
      </View>
    );
  }

  // Нет стрима — показываем лоадер при загрузке или если звонок активен (started)
  // КРИТИЧНО: При активном звонке (started=true) показываем ActivityIndicator вместо черного экрана
  // Это предотвращает черный экран при принятии звонка, когда remoteStream еще не установлен
  // КРИТИЧНО: Показываем бейдж друга даже когда нет стрима (для инициатора звонка)
  if (!streamToUse) {
    if (loading || started) {
      if (shouldSuppressTransientRemoteUi) {
        const held = renderHeldRemoteFrame('suppress-no-stream-during-local-flip', {
          loading,
          started,
        });
        if (held) return held;
      }
      const now = Date.now();
      const stallStart = stallSinceRef.current ?? now;
      stallSinceRef.current = stallStart;
      const stallMs = now - stallStart;

      const held = renderLastGoodFrame('no-stream-hold-last-frame', { stallMs });
      if (stallMs > REMOTE_VIDEO_STALL_HOLD_MS && held) {
        return (
          <View style={styles.videoContainer}>
            {held}
            {showFriendBadge && (
              <View style={styles.friendBadge}>
                <MaterialIcons name="check-circle" size={16} color="#0f0" />
                <Text style={styles.friendBadgeText}>{L('friend')}</Text>
              </View>
            )}
          </View>
        );
      }

      if (stallMs > REMOTE_VIDEO_STALL_TEXT_MS) {
        logRenderState('no-stream-text', { stallMs, loading, started });
        // Убрана заглушка "Видео восстанавливается" - показываем лоадер
        return (
          <View style={styles.videoContainer}>
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#fff" />
            </View>
            {showFriendBadge && (
              <View style={styles.friendBadge}>
                <MaterialIcons name="check-circle" size={16} color="#0f0" />
                <Text style={styles.friendBadgeText}>{L('friend')}</Text>
              </View>
            )}
          </View>
        );
      }

      logRenderState('no-stream-loading', { loading, started, stallMs });
      return (
        <View style={styles.videoContainer}>
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#fff" />
          </View>
          {showFriendBadge && (
            <View style={styles.friendBadge}>
              <MaterialIcons name="check-circle" size={16} color="#0f0" />
              <Text style={styles.friendBadgeText}>{L('friend')}</Text>
            </View>
          )}
        </View>
      );
    }
    logRenderState('no-stream-idle');
    return (
      <View style={styles.videoContainer}>
        <View style={[styles.rtc, { backgroundColor: 'black' }]} />
        {showFriendBadge && (
          <View style={styles.friendBadge}>
            <MaterialIcons name="check-circle" size={16} color="#0f0" />
            <Text style={styles.friendBadgeText}>{L('friend')}</Text>
          </View>
        )}
      </View>
    );
  }

  const videoTrack = (streamToUse as any)?.getVideoTracks?.()?.[0] || null;
  const hasVideoTrack = !!videoTrack;
  const videoTrackReady = !!videoTrack && videoTrack.readyState === 'live';
  const videoTrackEnabled = !!videoTrack && (videoTrack.enabled ?? true);
  const videoTrackMuted = !!videoTrack && (videoTrack.muted ?? false);
  // После переворота камеры в RN readyState может не быть 'live'. Если уже был ре-рендер по trackLiveTick — считаем видео готовым.
  const hasRenderableVideo =
    !!videoTrack &&
    videoTrackEnabled &&
    !videoTrackMuted &&
    (videoTrackReady || trackLiveTick > 0);

  // Detect an actual PiP transition (true -> false). Do NOT treat normal call connect
  // (partnerInPiP=false by default) as "returning from PiP" — it causes black flicker.
  const isReturningFromPiP = prevPartnerInPiPRef.current === true && partnerInPiP === false;
  
  // Логируем состояние для отладки восстановления видео
  if (isReturningFromPiP) {
    logger.debug('[RemoteVideo] Partner returned from PiP - recovery render', {
      remoteCamOn,
      partnerInPiP,
      hasVideoTrack,
      videoTrackReady,
      videoTrackEnabled,
      videoTrackMuted,
      hasRenderableVideo,
      streamId: streamToUse?.id,
    });
  }
  
  // КРИТИЧНО: Показываем видео если есть готовый трек, даже если remoteCamOn еще не обновлен
  // remoteCamOn может обновиться позже через onRemoteCamStateChange
  // Показываем видео когда: партнер не в PiP ИЛИ партнер в PiP с включенной камерой (поток продолжает идти)
  // В системном PiP (forceTextureView): показываем RTCView даже если трек ещё не "live", чтобы не крутить лоадер.
  const canRenderVideo =
    (hasRenderableVideo || (forceTextureView && !!streamToUse && hasVideoTrack)) &&
    (!partnerInPiP || remoteCamOn);
  if (canRenderVideo) {
    // Партнер выключил камеру (трек disabled) — RTCView покажет застывший кадр; показываем заглушку
    if (hasVideoTrack && !videoTrackEnabled && started && !wasFriendCallEnded && !isInactiveState) {
      stallSinceRef.current = null;
      lastGoodStreamRef.current = null;
      lastGoodAtRef.current = 0;
      return (
        <View style={styles.videoContainer}>
          <AwayPlaceholder />
          {showFriendBadge && (
            <View style={styles.friendBadge}>
              <MaterialIcons name="check-circle" size={16} color="#0f0" />
              <Text style={styles.friendBadgeText}>{L('friend')}</Text>
            </View>
          )}
        </View>
      );
    }
    // We are able to render (or intentionally render during PiP recovery) -> reset stall + remember last good
    stallSinceRef.current = null;
    lastGoodStreamRef.current = streamToUse;
    lastGoodAtRef.current = Date.now();

    // КРИТИЧНО: На Android используем prop `stream` напрямую вместо `streamURL`
    // Это более надежный способ для @livekit/react-native-webrtc на Android, но дублируем streamURL как fallback
    const streamURL = streamToUse.toURL?.();
    // Keep RTCView mounted. Use forceUpdateKey (throttled) only when track/stream truly changes.
    const rtcViewKey = Platform.OS === 'android'
      ? `remote-${streamToUse.id}-${forceUpdateKey}`
      : `remote-${streamToUse.id}`;
    
    logRenderState('render-video', {
      platform: Platform.OS,
      streamURL: streamURL ? streamURL.substring(0, 50) + '...' : 'null',
      key: rtcViewKey,
      hasVideoTrack,
      videoTrackReady,
      videoTrackEnabled,
      videoTrackMuted,
      streamId: streamToUse.id,
      usingStreamProp: Platform.OS === 'android'
    });
    
    // КРИТИЧНО: На Android используем prop `stream` напрямую, на iOS - `streamURL`
    // На iOS проверяем, что streamURL существует
    if (Platform.OS === 'ios' && (!streamURL || streamURL.length === 0)) {
      logger.warn('[RemoteVideo] ⚠️ На iOS нет streamURL или он пустой', { 
        streamId: streamToUse?.id,
        hasToURL: typeof streamToUse.toURL === 'function',
        streamURL: streamURL
      });
      return (
        <View style={styles.videoContainer}>
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#fff" />
          </View>
        </View>
      );
    }
    
    // На Android пробрасываем и stream, и streamURL (некоторые сборки webrtc требуют streamURL)
    const rtcViewProps = Platform.OS === 'android' 
      ? { 
          stream: streamToUse, 
          streamURL, 
          // На legacy Android (8.1/API27) у некоторых устройств Surface/HW-texture даёт "черный экран".
          renderToHardwareTextureAndroid: !isLegacyAndroidSurface,
          // Удаленное видео - фон. Не используем overlay, чтобы не перекрывать локальное превью.
          zOrderMediaOverlay: false,
          // prop может отсутствовать в типах, но поддерживается нативно в webrtc-view на Android.
          useTextureView: useTextureViewOnAndroid,
        }
      : { streamURL: streamURL! }; // iOS: используем streamURL (уже проверили выше)
    
    // КРИТИЧНО: На Android RTCView должен быть прямым потомком View без лишних оберток
    return (
      <View style={styles.videoContainer}>
        <RTCView
          key={rtcViewKey}
          {...(rtcViewProps as any)}
          style={styles.rtc}
          objectFit={objectFitProp}
          mirror={false}
          // Удаленное видео - базовый слой
          zOrder={0}
        />
        {showFriendBadge && (
          <View style={styles.friendBadge}>
            <MaterialIcons name="check-circle" size={16} color="#0f0" />
            <Text style={styles.friendBadgeText}>{L('friend')}</Text>
          </View>
        )}
      </View>
    );
  }

  // Камера явно выключена И нет готового трека — показываем заглушку "Отошёл"
  // КРИТИЧНО: Если камера явно выключена (remoteCamOn === false), всегда показываем заглушку "Отошел",
  // а не лоадер, даже если стрим только что получен. Это означает, что пользователь явно выключил камеру.
  // НО: НЕ показываем заглушку если партнер в PiP (это уже обработано выше)
  if (!remoteCamOn && !hasRenderableVideo && !partnerInPiP) {
    if (shouldSuppressTransientRemoteUi) {
      const held = renderHeldRemoteFrame('suppress-no-renderable-video-during-local-flip', {
        streamId: streamToUse.id,
        hasVideoTrack,
        videoTrackReady,
        videoTrackEnabled,
        videoTrackMuted,
      });
      if (held) return held;
    }
    logRenderState('remote-cam-off', {
      streamId: streamToUse.id,
      hasVideoTrack,
      videoTrackReady,
      videoTrackEnabled,
      videoTrackMuted,
      timeSinceReceived: remoteStreamReceivedAt ? Date.now() - remoteStreamReceivedAt : null,
    });
    return (
      <View style={styles.videoContainer}>
        <AwayPlaceholder />
        {showFriendBadge && (
          <View style={styles.friendBadge}>
            <MaterialIcons name="check-circle" size={16} color="#0f0" />
            <Text style={styles.friendBadgeText}>{L('friend')}</Text>
          </View>
        )}
      </View>
    );
  }

  // Стрим есть, но видеотрек не готов/замьючен — показываем лоадер (камера не "явно выключена")
  // При партнере в PiP с включенной камерой тоже показываем лоадер, пока трек не станет готов
  if (streamToUse && hasVideoTrack && (!partnerInPiP || remoteCamOn)) {
    // Трек есть, но отключён (партнер выключил камеру) — не показывать застывший кадр, показать "Отошел"
    if (!videoTrackEnabled && started && !wasFriendCallEnded && !isInactiveState) {
      if (shouldSuppressTransientRemoteUi) {
        const held = renderHeldRemoteFrame('suppress-disabled-track-during-local-flip', {
          streamId: streamToUse.id,
          videoTrackEnabled,
        });
        if (held) return held;
      }
      lastGoodStreamRef.current = null;
      lastGoodAtRef.current = 0;
      stallSinceRef.current = null;
      return (
        <View style={styles.videoContainer}>
          <AwayPlaceholder />
          {showFriendBadge && (
            <View style={styles.friendBadge}>
              <MaterialIcons name="check-circle" size={16} color="#0f0" />
              <Text style={styles.friendBadgeText}>{L('friend')}</Text>
            </View>
          )}
        </View>
      );
    }
    const now = Date.now();
    const stallStart = stallSinceRef.current ?? now;
    stallSinceRef.current = stallStart;
    const stallMs = now - stallStart;

    const held = renderLastGoodFrame('video-track-not-renderable-hold-last-frame', {
      stallMs,
      videoTrackReady,
      videoTrackEnabled,
      videoTrackMuted,
    });
    if (stallMs > REMOTE_VIDEO_STALL_HOLD_MS && held) {
      return (
        <View style={styles.videoContainer}>
          {held}
          {showFriendBadge && (
            <View style={styles.friendBadge}>
              <MaterialIcons name="check-circle" size={16} color="#0f0" />
              <Text style={styles.friendBadgeText}>{L('friend')}</Text>
            </View>
          )}
        </View>
      );
    }

    if (shouldSuppressTransientRemoteUi) {
      const heldContainer = renderHeldRemoteFrame('suppress-non-renderable-track-during-local-flip', {
        stallMs,
        videoTrackReady,
        videoTrackEnabled,
        videoTrackMuted,
      });
      if (heldContainer) return heldContainer;
    }

    // While camera is expected ON, treat muted/disabled as transient during flips/restarts.
    // Show loader/last frame instead of "Отошел" to avoid flicker.
    logRenderState('video-track-not-renderable', {
      streamId: streamToUse.id,
      videoTrackReady,
      videoTrackEnabled,
      videoTrackMuted,
      stallMs,
    });
    return (
      <View style={styles.videoContainer}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#fff" />
        </View>
        {showFriendBadge && (
          <View style={styles.friendBadge}>
            <MaterialIcons name="check-circle" size={16} color="#0f0" />
            <Text style={styles.friendBadgeText}>{L('friend')}</Text>
          </View>
        )}
      </View>
    );
  }

  // Нет видеотрека (например, только аудио) — показываем заглушку, если камера "выключена" по состоянию
  if (!remoteCamOn) {
    if (shouldSuppressTransientRemoteUi) {
      const held = renderHeldRemoteFrame('suppress-fallback-remote-cam-off-during-local-flip', {
        streamId: streamToUse?.id,
      });
      if (held) return held;
    }
    stallSinceRef.current = null;
    return (
      <View style={styles.videoContainer}>
        <AwayPlaceholder />
        {showFriendBadge && (
          <View style={styles.friendBadge}>
            <MaterialIcons name="check-circle" size={16} color="#0f0" />
            <Text style={styles.friendBadgeText}>{L('friend')}</Text>
          </View>
        )}
      </View>
    );
  }

  // Fallback (стрим есть, но видео не появилось)
  // КРИТИЧНО: Показываем бейдж друга даже когда нет стрима (для инициатора звонка)
  {
    // Видеотрек отключён (партнер выключил камеру) — не показывать последний кадр
    if (streamToUse && hasVideoTrack && !videoTrackEnabled && started && !wasFriendCallEnded && !isInactiveState) {
      if (shouldSuppressTransientRemoteUi) {
        const held = renderHeldRemoteFrame('suppress-fallback-disabled-track-during-local-flip', {
          streamId: streamToUse.id,
          videoTrackEnabled,
        });
        if (held) return held;
      }
      lastGoodStreamRef.current = null;
      lastGoodAtRef.current = 0;
      stallSinceRef.current = null;
      return (
        <View style={styles.videoContainer}>
          <AwayPlaceholder />
          {showFriendBadge && (
            <View style={styles.friendBadge}>
              <MaterialIcons name="check-circle" size={16} color="#0f0" />
              <Text style={styles.friendBadgeText}>{L('friend')}</Text>
            </View>
          )}
        </View>
      );
    }
    const now = Date.now();
    const stallStart = stallSinceRef.current ?? now;
    stallSinceRef.current = stallStart;
    const stallMs = now - stallStart;

    if (shouldSuppressTransientRemoteUi) {
      const heldContainer = renderHeldRemoteFrame('suppress-final-fallback-during-local-flip', { stallMs });
      if (heldContainer) return heldContainer;
    }

    const held = renderLastGoodFrame('fallback-hold-last-frame', { stallMs });
    if (stallMs > REMOTE_VIDEO_STALL_HOLD_MS && held) {
      return (
        <View style={styles.videoContainer}>
          {held}
          {showFriendBadge && (
            <View style={styles.friendBadge}>
              <MaterialIcons name="check-circle" size={16} color="#0f0" />
              <Text style={styles.friendBadgeText}>{L('friend')}</Text>
            </View>
          )}
        </View>
      );
    }

    if (stallMs > REMOTE_VIDEO_STALL_TEXT_MS) {
      logRenderState('fallback-text', { stallMs });
      // Убрана заглушка "Видео восстанавливается" - показываем лоадер
      return (
        <View style={styles.videoContainer}>
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#fff" />
          </View>
          {showFriendBadge && (
            <View style={styles.friendBadge}>
              <MaterialIcons name="check-circle" size={16} color="#0f0" />
              <Text style={styles.friendBadgeText}>{L('friend')}</Text>
            </View>
          )}
        </View>
      );
    }
  }

  return (
    <View style={styles.videoContainer}>
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
      {showFriendBadge && (
        <View style={styles.friendBadge}>
          <MaterialIcons name="check-circle" size={16} color="#0f0" />
          <Text style={styles.friendBadgeText}>{L('friend')}</Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  videoContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
    overflow: 'visible',
    zIndex: 0,
  },
  rtc: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
    backgroundColor: 'black',
  },
  friendBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,255,0,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,255,0,0.3)',
  },
  friendBadgeText: {
    color: '#0f0',
    fontSize: 12,
    fontWeight: '600',
  },
  placeholderContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(13,14,16,0.85)',
  },
  placeholder: {
    color: 'rgba(237,234,234,0.6)',
    fontSize: 22,
  },
  loadingContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'black',
  },
}); 
