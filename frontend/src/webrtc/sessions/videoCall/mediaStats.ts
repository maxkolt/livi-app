/**
 * Чтение WebRTC-статистики и нормализация её в простые числа/сигнатуры.
 *
 * Всё здесь — функции от аргументов (stats, room, diagnostics), без состояния сессии:
 * формы отчётов getStats() разъезжаются между версиями SDK и платформами, поэтому
 * разбор удобнее держать в одном месте и покрывать тестами.
 */

import type { NetInfoState } from '@react-native-community/netinfo';
import type { LocalVideoTrack } from 'livekit-client';
import type { IceTransportDiagnostic } from '../../iceTransportDiagnostics';

export type VideoProgress = { frames: number; bytes: number; packets: number };

export const EMPTY_VIDEO_PROGRESS: VideoProgress = { frames: 0, bytes: 0, packets: 0 };

/**
 * Статистика нашего видео-трека: сначала ищем по sid, иначе берём первую video-запись.
 * Разные сборки кладут sid в trackSid либо в mediaTrackId.
 */
export function pickLocalVideoStat(stats: any[], track: LocalVideoTrack | null): any | null {
  if (!Array.isArray(stats) || stats.length === 0) return null;
  const sid = track?.sid;
  const isVideo = (s: any) => String(s?.kind || '').toLowerCase() === 'video';
  const matchesSid = (s: any) =>
    sid && (String(s?.trackSid || '') === String(sid) || String(s?.mediaTrackId || '') === String(sid));

  const bySid = sid ? stats.find((s) => isVideo(s) && matchesSid(s)) : null;
  if (bySid) return bySid;
  return stats.find((s) => isVideo(s)) || null;
}

/** Прогресс отправки видео; отсутствующие/нечисловые поля дают 0, чтобы дельта не «прыгала». */
export function extractVideoProgress(stat: any): VideoProgress {
  const frames = Number(stat?.framesSent ?? stat?.framesEncoded ?? stat?.frames ?? 0) || 0;
  const bytes = Number(stat?.bytesSent ?? stat?.bytes ?? stat?.bytesSentTotal ?? 0) || 0;
  const packets = Number(stat?.packetsSent ?? stat?.packets ?? 0) || 0;
  return { frames, bytes, packets };
}

/**
 * Best-effort inbound-rtp packetsReceived с subscriber PC.
 * null = статистика недоступна (не подключены / нет PC / getStats упал), это не «ноль пакетов».
 */
export async function readInboundRemotePackets(room: any, kind: 'audio' | 'video'): Promise<number | null> {
  try {
    if (!room || room.state !== 'connected') return null;
    const pc =
      room.engine?.pcManager?.subscriber?.pc ||
      room.engine?.subscriber?.pc ||
      room.engine?.pcManager?.subscriberPC ||
      null;
    if (!pc || typeof pc.getStats !== 'function') return null;
    const report = await pc.getStats();
    let packets = 0;
    let found = false;
    report.forEach((r: any) => {
      const isInbound = r?.type === 'inbound-rtp';
      const isKind = r?.kind === kind || r?.mediaType === kind;
      if (!isInbound || !isKind) return;
      const n = Number(r.packetsReceived);
      if (!Number.isFinite(n)) return;
      found = true;
      packets = Math.max(packets, n);
    });
    return found ? packets : null;
  } catch {
    return null;
  }
}

/** Стабильный отпечаток выбранного ICE-пути — чтобы не логировать одно и то же повторно. */
export function buildIceTransportSignature(diagnostics: IceTransportDiagnostic[]): string {
  return JSON.stringify(
    diagnostics.map((item) => ({
      source: item.source,
      usingRelay: item.usingRelay,
      localCandidateType: item.localCandidateType,
      localProtocol: item.localProtocol,
      localRelayProtocol: item.localRelayProtocol,
      remoteCandidateType: item.remoteCandidateType,
      remoteProtocol: item.remoteProtocol,
      selectedCandidatePairId: item.selectedCandidatePairId,
    }))
  );
}

/** isInternetReachable == null трактуем как «достижима» (ещё не проверено), как и раньше. */
export function isNetInfoReachable(state: NetInfoState): boolean {
  return (
    state.isConnected === true &&
    (state.isInternetReachable === true || state.isInternetReachable == null)
  );
}
