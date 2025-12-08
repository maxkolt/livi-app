import { RTCPeerConnection } from 'react-native-webrtc';
import { AppState } from 'react-native';
import type { WebRTCSessionConfig } from '../../types';

/**
 * Менеджер состояния соединения
 * Управляет отслеживанием состояния подключения, таймерами и автоматическим переподключением
 */
export class ConnectionStateManager {
  private isConnectedRef: boolean = false;
  private reconnectTimerRef: ReturnType<typeof setTimeout> | null = null;
  private connectionCheckIntervalRef: ReturnType<typeof setInterval> | null = null;
  private restartCooldownRef: number = 0;
  private config: WebRTCSessionConfig;

  constructor(config: WebRTCSessionConfig) {
    this.config = config;
  }

  // ==================== Connection State ====================

  /**
   * Проверить, подключен ли PC
   * Проверяет connectionState или iceConnectionState
   */
  isPcConnected(pc: RTCPeerConnection | null): boolean {
    if (!pc) return false;
    const st = (pc as any).connectionState || pc.iceConnectionState;
    return st === 'connected' || st === 'completed';
  }

  /**
   * Установить состояние подключения
   * Вызывает callbacks и обработчики только при изменении состояния
   */
  setConnected(
    connected: boolean,
    pc: RTCPeerConnection | null,
    partnerId: string | null,
    onConnected: () => void,
    onDisconnected: () => void
  ): void {
    if (this.isConnectedRef === connected) {
      return;
    }
    
    this.isConnectedRef = connected;
    
    this.config.callbacks.onPcConnectedChange?.(connected);
    this.config.onPcConnectedChange?.(connected);
    
    if (connected) {
      onConnected();
    } else {
      onDisconnected();
    }
  }

  /**
   * Получить состояние подключения
   */
  isConnected(): boolean {
    return this.isConnectedRef;
  }

  // ==================== Timers ====================

  /**
   * Очистить таймер переподключения
   */
  clearReconnectTimer(): void {
    if (this.reconnectTimerRef) {
      clearTimeout(this.reconnectTimerRef);
      this.reconnectTimerRef = null;
    }
  }

  /**
   * Очистить все таймеры соединения
   */
  clearConnectionTimers(): void {
    this.clearReconnectTimer();
    if (this.connectionCheckIntervalRef) {
      clearInterval(this.connectionCheckIntervalRef);
      this.connectionCheckIntervalRef = null;
    }
  }

  /**
   * Запустить периодическую проверку состояния соединения
   * Проверяет состояние каждые 2 секунды и обновляет внутреннее состояние
   */
  startConnectionCheckInterval(
    pc: RTCPeerConnection,
    currentPcRef: RTCPeerConnection | null,
    partnerId: string | null,
    remoteStreamRef: any,
    isRandomChat: () => boolean,
    checkReceiversForRemoteStream: (pc: RTCPeerConnection) => void,
    handleConnectionState: () => void
  ): void {
    if (this.connectionCheckIntervalRef) {
      clearInterval(this.connectionCheckIntervalRef);
    }
    
    this.connectionCheckIntervalRef = setInterval(() => {
      if (!currentPcRef || currentPcRef !== pc) {
        this.clearConnectionTimers();
        return;
      }
      
      try {
        const st = (pc as any).connectionState || pc.iceConnectionState;
        if (st === 'closed') {
          this.clearConnectionTimers();
          if (this.isConnectedRef) {
            this.setConnected(false, pc, partnerId, () => {}, () => {});
          }
          return;
        }
        
        const isConnected = st === 'connected' || st === 'completed';
        
        if (isConnected && isRandomChat() && partnerId && !remoteStreamRef) {
          checkReceiversForRemoteStream(pc);
        }
        if (isConnected !== this.isConnectedRef) {
          handleConnectionState();
        }
      } catch (e) {
        this.clearConnectionTimers();
      }
    }, 2000);
  }

  // ==================== Reconnection ====================

  /**
   * Обработать сбой соединения
   * Проверяет условия и запускает автоматическое переподключение
   */
  handleConnectionFailure(
    pc: RTCPeerConnection,
    currentPcRef: RTCPeerConnection | null,
    partnerId: string | null,
    roomId: string | null,
    callId: string | null,
    getIsInactiveState: () => boolean,
    scheduleReconnection: (pc: RTCPeerConnection, toId: string) => void
  ): void {
    if (!pc || !currentPcRef || currentPcRef !== pc) {
      return;
    }
    
    const hasActiveCall = !!partnerId || !!roomId || !!callId;
    if (!hasActiveCall) {
      return;
    }
    
    if (getIsInactiveState()) {
      return;
    }
    
    if (AppState.currentState === 'background' || AppState.currentState === 'inactive') {
      return;
    }
    
    if (partnerId) {
      scheduleReconnection(pc, String(partnerId));
    }
  }

  /**
   * Запланировать переподключение
   * Учитывает cooldown для предотвращения частых переподключений
   */
  scheduleReconnection(
    pc: RTCPeerConnection,
    toId: string,
    onReconnect: () => void
  ): void {
    this.clearReconnectTimer();
    
    const now = Date.now();
    if (this.restartCooldownRef > now) {
      const delay = this.restartCooldownRef - now;
      this.reconnectTimerRef = setTimeout(() => {
        this.scheduleReconnection(pc, toId, onReconnect);
      }, delay);
      return;
    }
    
    onReconnect();
  }

  /**
   * Установить cooldown для переподключения
   * Предотвращает слишком частые попытки переподключения
   */
  setRestartCooldown(cooldown: number): void {
    this.restartCooldownRef = cooldown;
  }

  // ==================== Reset ====================

  /**
   * Сбросить состояние менеджера
   */
  reset(): void {
    this.isConnectedRef = false;
    this.clearConnectionTimers();
    this.restartCooldownRef = 0;
  }
}

