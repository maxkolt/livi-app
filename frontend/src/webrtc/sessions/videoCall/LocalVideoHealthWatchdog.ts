/**
 * Сторож локального видео для проблемных Android-устройств.
 *
 * На старых Android (API ≤ 27) и на OPPO-подобных прошивках камера иногда «залипает»:
 * трек жив, публикация на месте, но кадры не идут. Ловим это по двум срезам getStats
 * с интервалом и просим сессию пересоздать трек.
 *
 * Вынесено из VideoCallSession: таймер, счётчик попыток и математика дельт — здесь;
 * сам ремонт (unpublish → recreate → publish) остаётся за сессией через host-порт.
 */

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import type { LocalVideoTrack, Room } from 'livekit-client';
import { logger } from '../../../../utils/logger';
import { EMPTY_VIDEO_PROGRESS, extractVideoProgress, pickLocalVideoStat, type VideoProgress } from './mediaStats';

/** Пауза между двумя срезами статистики. */
const HEALTH_SAMPLE_GAP_MS = 1200;
/** Задержка перед проверкой после publish / после ремонта. */
const HEALTH_CHECK_DELAY_MS = 2800;
/** Больше двух ремонтов подряд не делаем — дальше это не залипание, а что-то другое. */
const MAX_RECOVERY_ATTEMPTS = 2;
/** Рост трафика меньше этого за срез считаем отсутствием прогресса. */
const STUCK_BYTES_DELTA = 5120;

export type DeviceWatchdogEnv = {
  os: string;
  version: number;
  brand?: string | null;
  manufacturer?: string | null;
};

/** Нужен ли сторож на этом устройстве (чистая функция — тестируется без react-native). */
export function shouldRunLocalVideoWatchdog(env: DeviceWatchdogEnv): boolean {
  if (env.os !== 'android') return false;
  const api = Number(env.version);
  const isOldAndroid = Number.isFinite(api) && api <= 27; // Android 8.1 and below
  const brand = String(env.brand || '').toLowerCase();
  const manufacturer = String(env.manufacturer || '').toLowerCase();
  const isOppoLike = brand.includes('oppo') || manufacturer.includes('oppo');
  return isOldAndroid || isOppoLike;
}

/** Залипло ли видео между двумя срезами. */
export function isLocalVideoStuck(before: VideoProgress, after: VideoProgress): boolean {
  const framesDelta = after.frames - before.frames;
  const bytesDelta = after.bytes - before.bytes;
  const packetsDelta = after.packets - before.packets;
  return framesDelta <= 0 && bytesDelta <= STUCK_BYTES_DELTA && packetsDelta <= 0;
}

export function currentDeviceWatchdogEnv(): DeviceWatchdogEnv {
  return {
    os: Platform.OS,
    version: Number(Platform.Version),
    brand: (Device as any)?.brand ?? null,
    manufacturer: (Device as any)?.manufacturer ?? null,
  };
}

export type LocalVideoHealthHost = {
  isCamOn: () => boolean;
  getRoom: () => Room | null;
  getLocalVideoTrack: () => LocalVideoTrack | null;
  getCamSide: () => string;
  /** Пересоздать и переопубликовать локальное видео. */
  recoverLocalVideo: (context: string) => Promise<void>;
};

export class LocalVideoHealthWatchdog {
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;

  constructor(
    private readonly host: LocalVideoHealthHost,
    private readonly readEnv: () => DeviceWatchdogEnv = currentDeviceWatchdogEnv,
  ) {}

  clear(): void {
    if (this.timeout) {
      try { clearTimeout(this.timeout); } catch {}
      this.timeout = null;
    }
  }

  /** Камера включена, комната подключена, трек жив — иначе проверять нечего. */
  private canCheck(): boolean {
    if (!shouldRunLocalVideoWatchdog(this.readEnv())) return false;
    if (!this.host.isCamOn()) return false;
    const room = this.host.getRoom();
    if (!room || room.state !== 'connected') return false;
    const track = this.host.getLocalVideoTrack();
    if (!track || track.mediaStreamTrack?.readyState === 'ended') return false;
    return true;
  }

  schedule(context: string): void {
    if (!this.canCheck()) return;

    this.clear();
    if (this.attempts > MAX_RECOVERY_ATTEMPTS + 1) this.attempts = 0;

    this.timeout = setTimeout(() => {
      void this.runOnce(context);
    }, HEALTH_CHECK_DELAY_MS);
  }

  private async sampleProgress(): Promise<VideoProgress> {
    try {
      const room = this.host.getRoom();
      const stats = await (room?.localParticipant as any)?.getTrackStats?.();
      return extractVideoProgress(pickLocalVideoStat(stats || [], this.host.getLocalVideoTrack()));
    } catch {
      return { ...EMPTY_VIDEO_PROGRESS };
    }
  }

  async runOnce(context: string): Promise<void> {
    try {
      if (!this.canCheck()) return;
      if (this.attempts >= MAX_RECOVERY_ATTEMPTS) return;

      const before = await this.sampleProgress();
      await new Promise((r) => setTimeout(r, HEALTH_SAMPLE_GAP_MS));
      const after = await this.sampleProgress();

      if (!isLocalVideoStuck(before, after)) return;

      this.attempts += 1;
      logger.warn('[VideoCallSession] 🔧 Local video seems stuck; restarting camera', {
        context,
        attempt: this.attempts,
        framesDelta: after.frames - before.frames,
        bytesDelta: after.bytes - before.bytes,
        packetsDelta: after.packets - before.packets,
        roomState: this.host.getRoom()?.state,
        camSide: this.host.getCamSide(),
      });

      await this.host.recoverLocalVideo(context);
      this.schedule('post-recovery');
    } catch (e) {
      logger.debug('[VideoCallSession] Local video health check failed (ignored)', e);
    }
  }
}
