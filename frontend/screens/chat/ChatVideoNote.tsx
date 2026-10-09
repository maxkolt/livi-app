/**
 * Видеокружок в переписке (как в Telegram): круг с кадром-превью и длительностью; тап —
 * играет со звуком, вокруг бежит кольцо прогресса; ещё тап — пауза. Играет один кружок
 * на весь чат: запуск другого останавливает этот. Плеер создаётся только на время просмотра,
 * поэтому кружков в ленте может быть сколько угодно.
 */
import React, { memo, useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import Svg, { Circle } from 'react-native-svg';
import { create } from 'zustand';
import { MESSAGE_LONG_PRESS_MS } from '../../constants/uiTokens';
import { UI_ACCENT } from '../home/constants';

export const CHAT_VIDEO_NOTE_SIZE = 216;
const RING_W = 3;

/** Какой кружок сейчас играет (id сообщения) — во всём приложении один. */
const useActiveVideoNote = create<{ activeId: string | null; setActive: (id: string | null) => void }>((set) => ({
  activeId: null,
  setActive: (activeId) => set({ activeId }),
}));

export function stopChatVideoNotes(): void {
  useActiveVideoNote.getState().setActive(null);
}

function formatSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

type Props = {
  id: string;
  uri: string;
  thumbUri?: string;
  durationSec: number;
  size?: number;
  /** Режим выбора сообщений: касания уходят строке, кружок не играет. */
  disabled?: boolean;
  onLongPress?: () => void;
};

export const ChatVideoNote = memo(function ChatVideoNote({
  id,
  uri,
  thumbUri,
  durationSec,
  size = CHAT_VIDEO_NOTE_SIZE,
  disabled,
  onLongPress,
}: Props) {
  const active = useActiveVideoNote((s) => s.activeId === id);
  const setActive = useActiveVideoNote((s) => s.setActive);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!active) setPaused(false);
  }, [active]);
  // Кружок ушёл из ленты (чат закрыли, сообщение удалили) — не играет.
  useEffect(
    () => () => {
      if (useActiveVideoNote.getState().activeId === id) useActiveVideoNote.getState().setActive(null);
    },
    [id],
  );

  const onPress = useCallback(() => {
    if (!active) {
      setActive(id);
      return;
    }
    setPaused((p) => !p);
  }, [active, id, setActive]);
  const onEnded = useCallback(() => setActive(null), [setActive]);

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={MESSAGE_LONG_PRESS_MS}
      disabled={disabled || !uri}
      pointerEvents={disabled ? 'none' : 'auto'}
      accessibilityRole="button"
      style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}
    >
      {thumbUri ? (
        <ExpoImage source={{ uri: thumbUri }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" />
      ) : null}
      {active && uri ? (
        <ActiveVideoNote uri={uri} size={size} paused={paused} durationSec={durationSec} onEnded={onEnded} />
      ) : (
        <>
          <View style={styles.center} pointerEvents="none">
            <View style={styles.playBadge}>
              <Ionicons name="play" size={22} color="#fff" style={styles.playIcon} />
            </View>
          </View>
          <View style={styles.durationPill} pointerEvents="none">
            <Text style={styles.durationText}>{formatSec(durationSec)}</Text>
          </View>
        </>
      )}
    </Pressable>
  );
});

function ActiveVideoNote({
  uri,
  size,
  paused,
  durationSec,
  onEnded,
}: {
  uri: string;
  size: number;
  paused: boolean;
  durationSec: number;
  onEnded: () => void;
}) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.muted = false;
    p.timeUpdateEventInterval = 0.1;
    p.play();
  });
  const time = useEvent(player, 'timeUpdate', { currentTime: 0, currentLiveTimestamp: null, currentOffsetFromLive: null, bufferedPosition: 0 });
  const status = useEvent(player, 'statusChange', { status: player.status });

  useEffect(() => {
    if (paused) player.pause();
    else player.play();
  }, [paused, player]);
  useEffect(() => {
    const sub = player.addListener('playToEnd', onEnded);
    return () => sub.remove();
  }, [player, onEnded]);

  const total = player.duration > 0 ? player.duration : durationSec;
  const progress = total > 0 ? Math.min(1, Math.max(0, (time?.currentTime || 0) / total)) : 0;
  const r = size / 2 - RING_W;
  const circ = 2 * Math.PI * r;
  const loading = status?.status === 'loading';

  return (
    <>
      {/* TextureView: обычный SurfaceView скругление не режет — кружок был бы квадратом. */}
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
        surfaceType="textureView"
        allowsPictureInPicture={false}
      />
      <Svg width={size} height={size} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.18)" strokeWidth={RING_W} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={UI_ACCENT}
          strokeWidth={RING_W}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${circ} ${circ}`}
          strokeDashoffset={circ * (1 - progress)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      {paused || loading ? (
        <View style={styles.center} pointerEvents="none">
          <View style={styles.playBadge}>
            <Ionicons name={loading ? 'hourglass-outline' : 'play'} size={22} color="#fff" style={loading ? null : styles.playIcon} />
          </View>
        </View>
      ) : null}
      <View style={styles.durationPill} pointerEvents="none">
        <Text style={styles.durationText}>{formatSec(Math.max(0, total - (time?.currentTime || 0)))}</Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  circle: {
    overflow: 'hidden',
    backgroundColor: '#1B2028',
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  playBadge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20, 24, 31, 0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  playIcon: { marginLeft: 3 },
  durationPill: {
    position: 'absolute',
    bottom: 18,
    alignSelf: 'center',
    paddingHorizontal: 8,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    backgroundColor: 'rgba(20, 24, 31, 0.6)',
  },
  durationText: { color: '#fff', fontSize: 11 },
});
