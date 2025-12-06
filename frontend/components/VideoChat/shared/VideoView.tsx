import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { RTCView, MediaStream } from 'react-native-webrtc';
import { isValidStream } from '../../../utils/streamUtils';
import AwayPlaceholder from '../../AwayPlaceholder';
import { t } from '../../../utils/i18n';

interface VideoViewProps {
  stream: MediaStream | null;
  showVideo: boolean;
  isLocal?: boolean;
  renderKey?: number;
  isInactive?: boolean;
  placeholder?: string;
}

/**
 * Общий компонент для отображения видео (локального или удаленного)
 */
export const VideoView: React.FC<VideoViewProps> = ({
  stream,
  showVideo,
  isLocal = false,
  renderKey = 0,
  isInactive = false,
  placeholder,
}) => {
  // После завершения звонка показываем только текст
  if (isInactive) {
    return <Text style={styles.placeholder}>{placeholder || (isLocal ? t('you') : t('partner'))}</Text>;
  }

  // Показываем видео только если камера включена
  if (showVideo) {
    if (stream && isValidStream(stream)) {
      return (
        <RTCView
          key={`${isLocal ? 'local' : 'remote'}-video-${renderKey}`}
          streamURL={stream.toURL()}
          style={styles.rtc}
          objectFit="cover"
          mirror={isLocal}
          zOrder={0}
        />
      );
    } else {
      return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
    }
  } else {
    // При выключенной камере показываем заглушку
    if (isLocal) {
      // Для локального видео всегда показываем "Вы"
      return <Text style={styles.placeholder}>{t('you')}</Text>;
    } else {
      // Для удаленного видео показываем заглушку "Отошел"
      return <AwayPlaceholder />;
    }
  }
};

const styles = StyleSheet.create({
  rtc: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'black',
  },
  placeholder: {
    color: 'rgba(237,234,234,0.6)',
    fontSize: 22,
  },
});

