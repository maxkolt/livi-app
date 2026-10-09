/**
 * Запись видеокружка (как в Telegram): пока держат кнопку записи в режиме камеры, над чатом —
 * круг с фронтальной камерой и кольцо прогресса на минуту. Композер с таймером и
 * «влево — отмена» остаётся внизу, поверх этого слоя.
 *
 * Слой сам запускает запись, когда камера готова (спросив у useChatVoiceRecord, не отпустили
 * ли уже кнопку), и отдаёт файл, когда её остановят.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useSafeAreaFrame } from 'react-native-safe-area-context';
import { CameraView } from 'expo-camera';
import Svg, { Circle } from 'react-native-svg';
import { logger } from '../../utils/logger';
import { UI_ACCENT } from '../home/constants';
import { VIDEO_NOTE_MAX_MS } from './videoNoteFiles';

export type VideoNoteRecorderHandle = {
  /** Остановить запись (или не начинать, если камера ещё не готова). */
  stop: () => void;
};

type Props = {
  /** Идёт запись кружка (или камера ещё запускается). */
  active: boolean;
  recordMs: number;
  handleRef: React.MutableRefObject<VideoNoteRecorderHandle | null>;
  /** Камера готова: можно писать? false — кнопку уже отпустили. */
  shouldStart: () => boolean;
  onStarted: () => void;
  /** Запись закончилась: файл или null (не начали / ошибка). */
  onFinished: (uri: string | null) => void;
  /** Высота композера снизу — круг стоит по центру над ним. */
  bottomReserve: number;
  topReserve: number;
};

const RING_GAP = 7;
const RING_W = 4;

export function VideoNoteRecorder({ active, ...rest }: Props) {
  if (!active) return null;
  return <VideoNoteRecorderLayer {...rest} />;
}

function VideoNoteRecorderLayer({
  recordMs,
  handleRef,
  shouldStart,
  onStarted,
  onFinished,
  bottomReserve,
  topReserve,
}: Omit<Props, 'active'>) {
  const { width, height } = useSafeAreaFrame();
  const cameraRef = useRef<CameraView>(null);
  const startedRef = useRef(false);
  const stoppedRef = useRef(false);
  const finishedRef = useRef(false);
  const cbRef = useRef({ shouldStart, onStarted, onFinished });
  cbRef.current = { shouldStart, onStarted, onFinished };

  const finish = useCallback((uri: string | null) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    cbRef.current.onFinished(uri);
  }, []);

  useEffect(() => {
    handleRef.current = {
      stop: () => {
        stoppedRef.current = true;
        if (startedRef.current) {
          try {
            cameraRef.current?.stopRecording();
          } catch {
            finish(null);
          }
        } else {
          finish(null);
        }
      },
    };
    return () => {
      handleRef.current = null;
      // Слой убрали посреди записи — камера остановится сама, файл не нужен.
      if (startedRef.current && !finishedRef.current) {
        try {
          cameraRef.current?.stopRecording();
        } catch {}
      }
    };
  }, [handleRef, finish]);

  const onCameraReady = useCallback(() => {
    if (startedRef.current || stoppedRef.current) return;
    if (!cbRef.current.shouldStart()) {
      finish(null);
      return;
    }
    const camera = cameraRef.current;
    if (!camera) {
      finish(null);
      return;
    }
    startedRef.current = true;
    camera
      .recordAsync({ maxDuration: Math.round(VIDEO_NOTE_MAX_MS / 1000) })
      .then((res) => finish(res?.uri ?? null))
      .catch((e) => {
        logger.warn('[video-note] record failed', { error: String((e as Error)?.message ?? e) });
        finish(null);
      });
    cbRef.current.onStarted();
  }, [finish]);

  const size = Math.min(width - 64, 300);
  const ring = size + RING_GAP * 2;
  const r = ring / 2 - RING_W / 2;
  const circ = 2 * Math.PI * r;
  const progress = Math.min(1, recordMs / VIDEO_NOTE_MAX_MS);
  const areaH = Math.max(0, height - bottomReserve - topReserve);
  const top = topReserve + Math.max(0, (areaH - ring) / 2);

  return (
    <View style={styles.root} pointerEvents="none">
      <View style={[styles.ringWrap, { top, width: ring, height: ring, marginLeft: -ring / 2 }]}>
        <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing="front"
            mode="video"
            mirror
            videoQuality="480p"
            videoBitrate={1_500_000}
            onCameraReady={onCameraReady}
            onMountError={(e) => {
              logger.warn('[video-note] camera mount failed', { error: String(e?.message ?? e) });
              finish(null);
            }}
          />
          {!startedRef.current ? (
            <View style={styles.center}>
              <ActivityIndicator color="rgba(255,255,255,0.8)" />
            </View>
          ) : null}
        </View>
        <Svg width={ring} height={ring} style={StyleSheet.absoluteFill}>
          <Circle cx={ring / 2} cy={ring / 2} r={r} stroke="rgba(255,255,255,0.14)" strokeWidth={RING_W} fill="none" />
          <Circle
            cx={ring / 2}
            cy={ring / 2}
            r={r}
            stroke={UI_ACCENT}
            strokeWidth={RING_W}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${circ} ${circ}`}
            strokeDashoffset={circ * (1 - progress)}
            transform={`rotate(-90 ${ring / 2} ${ring / 2})`}
          />
        </Svg>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10, 12, 17, 0.82)',
    zIndex: 19,
    elevation: 19,
  },
  ringWrap: {
    position: 'absolute',
    left: '50%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  circle: {
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
});
