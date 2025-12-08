import { RTCPeerConnection } from 'react-native-webrtc';
import { Platform } from 'react-native';
import type { WebRTCSessionConfig } from '../../types';

/**
 * Менеджер измерения уровня микрофона
 * Использует WebRTC stats API для получения уровня аудио
 */
export class MicMeter {
  private micStatsTimerRef: ReturnType<typeof setInterval> | null = null;
  private energyRef: number | null = null;
  private durRef: number | null = null;
  private lowLevelCountRef: number = 0;
  private config: WebRTCSessionConfig;

  constructor(config: WebRTCSessionConfig) {
    this.config = config;
  }

  /**
   * Запустить измерение уровня микрофона
   * Проверяет уровень каждые 180ms через WebRTC stats API
   */
  start(
    pc: RTCPeerConnection | null,
    partnerId: string | null,
    roomId: string | null,
    callId: string | null,
    isPcConnected: () => boolean,
    isMicReallyOn: () => boolean,
    getIsInactiveState: () => boolean
  ): void {
    if (!pc) {
      this.stop();
      return;
    }
    
    const hasActiveCall = !!partnerId || !!roomId || !!callId;
    const isConnected = isPcConnected();
    
    if (!hasActiveCall && !isConnected) {
      this.stop();
      return;
    }
    
    if (this.micStatsTimerRef) return;
    
    this.micStatsTimerRef = setInterval(async () => {
      try {
        if (!this.shouldContinueMeasuring(pc, partnerId, roomId, callId, isPcConnected, getIsInactiveState)) {
          this.stop();
          return;
        }
        
        if (!isMicReallyOn()) {
          this.emitMicLevel(0);
          return;
        }
        
        const level = await this.calculateMicLevel(pc);
        this.emitMicLevel(level);
      } catch {
        this.stop();
      }
    }, 180);
  }

  /**
   * Проверить, нужно ли продолжать измерение
   */
  private shouldContinueMeasuring(
    pc: RTCPeerConnection | null,
    partnerId: string | null,
    roomId: string | null,
    callId: string | null,
    isPcConnected: () => boolean,
    getIsInactiveState: () => boolean
  ): boolean {
    if (!pc || pc.signalingState === 'closed' || (pc as any).connectionState === 'closed') {
      return false;
    }
    
    if (getIsInactiveState()) {
      return false;
    }
    
    const hasActiveCall = !!partnerId || !!roomId || !!callId;
    const isConnected = isPcConnected();
    
    return isConnected || hasActiveCall;
  }

  /**
   * Вычислить уровень микрофона из WebRTC stats
   */
  private async calculateMicLevel(pc: RTCPeerConnection): Promise<number> {
    const stats: any = await pc.getStats();
    let lvl = 0;
    
    stats.forEach((r: any) => {
      const isAudio =
        r.kind === 'audio' || r.mediaType === 'audio' || r.type === 'media-source' || r.type === 'track' || r.type === 'outbound-rtp';
      
      if (!isAudio) return;
      
      if (typeof r.audioLevel === 'number') {
        const audioLvl = Platform.OS === 'ios' && r.audioLevel > 1 
          ? r.audioLevel / 127 
          : r.audioLevel;
        lvl = Math.max(lvl, audioLvl);
      }
      
      if (typeof r.totalAudioEnergy === 'number' && typeof r.totalSamplesDuration === 'number') {
        const prevE = this.energyRef;
        const prevD = this.durRef;
        if (prevE != null && prevD != null) {
          const dE = r.totalAudioEnergy - prevE;
          const dD = r.totalSamplesDuration - prevD;
          if (dD > 0) {
            const inst = Math.sqrt(Math.max(0, dE / dD));
            lvl = Math.max(lvl, inst);
          }
        }
        this.energyRef = r.totalAudioEnergy;
        this.durRef = r.totalSamplesDuration;
      }
    });
    
    let normalized = Math.max(0, Math.min(1, lvl));
    
    if (Platform.OS === 'ios') {
      normalized = this.normalizeIosLevel(normalized);
    }
    
    return normalized;
  }

  /**
   * Нормализация уровня для iOS
   * Сбрасывает очень низкие уровни до 0 после нескольких измерений
   */
  private normalizeIosLevel(level: number): number {
    if (level < 0.015) {
      this.lowLevelCountRef += 1;
      if (this.lowLevelCountRef >= 2) {
        this.energyRef = null;
        this.durRef = null;
        return 0;
      }
    } else {
      this.lowLevelCountRef = 0;
    }
    return level;
  }

  /**
   * Отправить уровень микрофона через callbacks
   */
  private emitMicLevel(level: number): void {
    this.config.callbacks.onMicLevelChange?.(level);
    this.config.onMicLevelChange?.(level);
  }

  /**
   * Остановить измерение уровня микрофона
   */
  stop(): void {
    if (this.micStatsTimerRef) {
      clearInterval(this.micStatsTimerRef);
      this.micStatsTimerRef = null;
    }
    this.energyRef = null;
    this.durRef = null;
    this.lowLevelCountRef = 0;
    this.emitMicLevel(0);
  }

  /**
   * Сбросить состояние
   */
  reset(): void {
    this.stop();
  }
}

