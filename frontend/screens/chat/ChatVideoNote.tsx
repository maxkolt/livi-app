/**
 * Видеокружок в переписке (как в Telegram): круг с кадром-превью и длительностью; тап —
 * играет со звуком, вокруг бежит кольцо прогресса; тап в любой момент — пауза / дальше.
 * Кольцо можно вести пальцем по кругу — перемотка. Играет один кружок
 * на весь чат: запуск другого останавливает этот. Плеер создаётся только на время просмотра,
 * поэтому кружков в ленте может быть сколько угодно.
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import Svg, { Circle } from 'react-native-svg';
import { create } from 'zustand';
import { MESSAGE_LONG_PRESS_MS } from '../../constants/uiTokens';
import { UI_ACCENT } from '../home/constants';
import { claimChatPlayback, releaseChatPlayback } from './chatPlaybackCoordinator';

export const CHAT_VIDEO_NOTE_SIZE = 216;
const RING_W = 3;
/** Касание не дальше этого от кольца внутрь — перемотка; в середине — тап и прокрутка ленты. */
const SCRUB_BAND = 36;
/** Сдвиг пальца, после которого касание у кольца — перемотка, а не тап. */
const SCRUB_SLOP = 6;
/** Как часто показывать кадр под пальцем при перемотке. */
const SCRUB_SEEK_MS = 80;
/** Не ждать кадр с новой позиции дольше этого — кольцо вернётся к времени плеера. */
const SEEK_SETTLE_MS = 800;

/** Точка относительно центра → доля круга от 12 часов по часовой стрелке. */
function angleProgress(dx: number, dy: number): number {
  const a = Math.atan2(dx, -dy);
  return (a < 0 ? a + 2 * Math.PI : a) / (2 * Math.PI);
}

/** Какой кружок сейчас играет (id сообщения) — во всём приложении один. */
const useActiveVideoNote = create<{ activeId: string | null; setActive: (id: string | null) => void }>((set) => ({
  activeId: null,
  setActive: (activeId) => set({ activeId }),
}));

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
      const owner = `video-note:${id}`;
      releaseChatPlayback(owner);
      if (useActiveVideoNote.getState().activeId === id) useActiveVideoNote.getState().setActive(null);
    },
    [id],
  );

  const onPress = useCallback(() => {
    if (!active) {
      const owner = `video-note:${id}`;
      claimChatPlayback(owner, () => {
        if (useActiveVideoNote.getState().activeId === id) {
          useActiveVideoNote.getState().setActive(null);
        }
      });
      setActive(id);
      return;
    }
    setPaused((p) => !p);
  }, [active, id, setActive]);
  const onEnded = useCallback(() => {
    releaseChatPlayback(`video-note:${id}`);
    if (useActiveVideoNote.getState().activeId === id) setActive(null);
  }, [id, setActive]);
  const onTogglePause = useCallback(() => setPaused((p) => !p), []);

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
        <ActiveVideoNote
          uri={uri}
          size={size}
          paused={paused}
          durationSec={durationSec}
          onEnded={onEnded}
          onTogglePause={onTogglePause}
          onLongPress={onLongPress}
        />
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
  onTogglePause,
  onLongPress,
}: {
  uri: string;
  size: number;
  paused: boolean;
  durationSec: number;
  onEnded: () => void;
  onTogglePause: () => void;
  onLongPress?: () => void;
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
  const timeProgress = total > 0 ? Math.min(1, Math.max(0, (time?.currentTime || 0) / total)) : 0;
  const r = size / 2 - RING_W;
  const circ = 2 * Math.PI * r;
  const loading = status?.status === 'loading';

  // Перемотка: пока палец ведёт по кольцу — его позиция; после отпускания — цель перемотки,
  // пока плеер не догонит её (иначе кольцо на миг прыгало назад к старому времени).
  const [scrub, setScrub] = useState<number | null>(null);
  const [seekHold, setSeekHold] = useState<number | null>(null);
  useEffect(() => {
    if (seekHold == null) return;
    if (Math.abs(timeProgress - seekHold) < 0.03) {
      setSeekHold(null);
      return;
    }
    const t = setTimeout(() => setSeekHold(null), SEEK_SETTLE_MS);
    return () => clearTimeout(t);
  }, [seekHold, timeProgress]);
  const progress = scrub ?? seekHold ?? timeProgress;

  // PanResponder создаётся один раз и читает свежие значения через ref (как кнопки записи:
  // пересозданный посреди жеста считал бы сдвиг от нуля экрана).
  const live = useRef({ player, total, paused, size, r, onTogglePause, onLongPress });
  live.current = { player, total, paused, size, r, onTogglePause, onLongPress };
  const gesture = useRef({
    x0: 0,
    y0: 0,
    moved: false,
    longFired: false,
    wasPlaying: false,
    last: 0,
    lastSeekAt: 0,
    longTimer: null as ReturnType<typeof setTimeout> | null,
  });
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (e) => {
        const { size: s, r: ring } = live.current;
        const d = Math.hypot(e.nativeEvent.locationX - s / 2, e.nativeEvent.locationY - s / 2);
        return d >= ring - SCRUB_BAND && d <= s / 2;
      },
      onPanResponderGrant: (e) => {
        const g = gesture.current;
        g.x0 = e.nativeEvent.locationX;
        g.y0 = e.nativeEvent.locationY;
        g.moved = false;
        g.longFired = false;
        g.longTimer = setTimeout(() => {
          g.longTimer = null;
          if (g.moved) return;
          g.longFired = true;
          live.current.onLongPress?.();
        }, MESSAGE_LONG_PRESS_MS);
      },
      onPanResponderMove: (_e, s) => {
        const g = gesture.current;
        const { player: p, total: dur, paused: isPaused, size: sz } = live.current;
        if (g.longFired) return;
        if (!g.moved) {
          if (Math.hypot(s.dx, s.dy) < SCRUB_SLOP) return;
          g.moved = true;
          if (g.longTimer) clearTimeout(g.longTimer);
          g.longTimer = null;
          g.wasPlaying = !isPaused;
          if (g.wasPlaying) p.pause();
          g.last = angleProgress(g.x0 - sz / 2, g.y0 - sz / 2);
        }
        let next = angleProgress(g.x0 + s.dx - sz / 2, g.y0 + s.dy - sz / 2);
        // Через 12 часов не перескакивать с конца на начало и обратно — упереться в край.
        if (Math.abs(next - g.last) > 0.5) next = g.last > 0.5 ? 1 : 0;
        g.last = next;
        setScrub(next);
        const now = Date.now();
        if (dur > 0 && now - g.lastSeekAt >= SCRUB_SEEK_MS) {
          g.lastSeekAt = now;
          p.currentTime = next * dur;
        }
      },
      onPanResponderRelease: () => finishGesture(true),
      onPanResponderTerminate: () => finishGesture(false),
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;
  function finishGesture(released: boolean) {
    const g = gesture.current;
    if (g.longTimer) clearTimeout(g.longTimer);
    g.longTimer = null;
    if (g.longFired) return;
    const { player: p, total: dur } = live.current;
    if (!g.moved) {
      if (released) live.current.onTogglePause();
      return;
    }
    // До самого конца не мотаем: конец ролика — это «досмотрел», кружок закрылся бы.
    const target = Math.min(g.last, 0.995);
    if (dur > 0) p.currentTime = target * dur;
    setSeekHold(target);
    setScrub(null);
    if (g.wasPlaying) p.play();
  }

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
      {(paused || loading) && scrub == null ? (
        <View style={styles.center} pointerEvents="none">
          <View style={styles.playBadge}>
            <Ionicons name={loading ? 'hourglass-outline' : 'play'} size={22} color="#fff" style={loading ? null : styles.playIcon} />
          </View>
        </View>
      ) : null}
      <View style={styles.durationPill} pointerEvents="none">
        <Text style={styles.durationText}>{formatSec(Math.max(0, total * (1 - progress)))}</Text>
      </View>
      {/* Касание у кольца — перемотка (и тап/долгое нажатие там же); в середине касание
          уходит кружку: тап — пауза, ведение — прокрутка ленты. */}
      <View style={StyleSheet.absoluteFill} {...panResponder.panHandlers} />
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
